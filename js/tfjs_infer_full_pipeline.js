/*
Browser-first single-file pipeline for model21 tf.js inference.

This file exposes window.NUS3DPhasePipeline with functions to:

PURE JAVASCRIPT OPERATIONS:
1) Parse NMRPipe FT3 bytes (ArrayBuffer) with complex direct channel
2) Convert FT3 content to model-ready spectra [1, ni1, ni2, nd, 2]
3) Extract top-N cubes per token
4) Per-token normalize cubes to max amplitude 1.0
6) Run weighted least squares to get left/right phase

TENSORFLOW.JS OPERATIONS:
5) Run CNN + Attention model to get raw local predictions (batch, n_tokens, 2)
   - Output [..., 0] = phase
   - Output [..., 1] = weight logits (requires smoothing)

Intended use in webpage:
- Include this script after TensorFlow.js
- Call NUS3DPhasePipeline.runFromFt3({ ... })
*/

(function (globalScope) {
  "use strict";

  const HEADER_FLOAT_COUNT = 512;
  const HEADER_BYTES = HEADER_FLOAT_COUNT * 4;

  /**
   * Logs to html.
   *
   * @param {any} msg - Message
   */
  function logToHtml(msg) {
    if (globalScope.append_3d_log) {
      globalScope.append_3d_log(msg);
    }
  }

  const IDX = {
    FDF3SIZE: 15,
    FDDIMORDER1: 24,
    FDDIMORDER2: 25,
    FDDIMORDER3: 26,
    FDDIMORDER4: 27,
    FDF3QUADFLAG: 51,
    FDF4QUADFLAG: 54,
    FDF1QUADFLAG: 55,
    FDF2QUADFLAG: 56,
    FDSIZE: 99,
    FDSPECNUM: 219,
  };

  const DEFAULTS = {
    topN: 3,
    tokenWidth: 32,
    cubeSizeXY: 16,
    directExtend: 32,
    l2Reg: 1e-6,
    flipRiSign: true,
  };

  /**
   * Ensures TensorFlow.
   *
   * @param {any} tfInstance - TensorFlow instance
   */
  function ensureTf(tfInstance) {
    const tf = tfInstance || globalScope.tf;
    if (!tf) {
      throw new Error("TensorFlow.js not found. Include @tensorflow/tfjs before this script.");
    }
    return tf;
  }

  let customLayerClasses = {};
  let cachedTf = null;

  /**
   * Smooths gated weight from logits.
   *
   * @param {any} wLogits - W logits
   */
  function smoothGatedWeightFromLogits(wLogits) {
    // Helper function to convert weight logits to effective weights
    // Parameters match the Python model: gate_center=0.5, gate_sharpness=50.0, min_weight=0.25, max_weight=1.0
    const tf = globalScope.tf;
    const gateCenterVal = 0.5;
    const gateSharpnessVal = 50.0;
    const minWeightVal = 0.01;
    const maxWeightVal = 1.0;

    return tf.tidy(() => {
      const wRaw = tf.sigmoid(wLogits);
      const shifted = tf.sub(wRaw, gateCenterVal);
      const scaled = tf.mul(shifted, gateSharpnessVal);
      const num = tf.softplus(scaled);
      const denArg = tf.mul(gateSharpnessVal, gateCenterVal);
      const den = tf.softplus(denArg);
      const wEff = tf.minimum(tf.div(num, den), 1.0);
      const shifted2 = tf.sub(wEff, 1e-4);
      const scaled2 = tf.mul(shifted2, 300.0);
      const gate = tf.sigmoid(scaled2);
      const base = tf.add(minWeightVal, tf.mul(maxWeightVal - minWeightVal, wEff));
      return tf.mul(gate, base);
    });
  }

  /**
   * Gets custom objects.
   *
   * @param {any} tf - TensorFlow
   */
  function getCustomObjects(tf) {
    // Note: Model is now exported as pure CNN + Attention (no Lambda layers)
    // Just return the custom layer classes for TensorFlow.js to use
    const tfi = tf || cachedTf || ensureTf();
    if (!cachedTf) cachedTf = tfi;

    if (!customLayerClasses.TransformerBlock) {
      customLayerClasses = createCustomLayerClasses(tfi);
    }
    return {
      TransformerBlock: customLayerClasses.TransformerBlock,
      PreExtractedCubeLocalHead3D: customLayerClasses.PreExtractedCubeLocalHead3D,
    };
  }

  /**
   * Creates custom layer classes.
   *
   * @param {any} tf - TensorFlow
   */
  function createCustomLayerClasses(tf) {
    // Create TransformerBlock class
    class TransformerBlock extends tf.layers.Layer {
      /**
       * Constructor for class.
       *
       * @param {any} config - Config
       */
      constructor(config) {
        super(config);
        this.embedDim = config.embedDim || 128;
        this.numHeads = config.numHeads || 4;
        this.ffDim = config.ffDim || 256;
        this.rate = config.rate || 0.1;
      }

      /**
       * Builds.
       *
       * @param {any} inputShape - Input shape
       */
      build(inputShape) {
        const keyDim = Math.max(Math.floor(this.embedDim / this.numHeads), 1);
        this.queryDense = tf.layers.dense({ units: this.numHeads * keyDim, useBias: true, name: "query" });
        this.keyDense = tf.layers.dense({ units: this.numHeads * keyDim, useBias: true, name: "key" });
        this.valueDense = tf.layers.dense({ units: this.numHeads * keyDim, useBias: true, name: "value" });
        this.attentionOutputDense = tf.layers.dense({ units: this.embedDim, useBias: true, name: "attention_output" });
        this.ffn = tf.layers.dense({ units: this.ffDim, activation: "relu" });
        this.ffnOut = tf.layers.dense({ units: this.embedDim });
        this.layernorm1 = tf.layers.layerNormalization({ epsilon: 1e-6 });
        this.layernorm2 = tf.layers.layerNormalization({ epsilon: 1e-6 });
        this.dropout1 = tf.layers.dropout({ rate: this.rate });
        this.dropout2 = tf.layers.dropout({ rate: this.rate });
        super.build(inputShape);
      }

      /**
       * Calls.
       *
       * @param {any} inputs - Inputs
       * @param {any} kwargs - Kwargs
       */
      call(inputs, kwargs) {
        const training = kwargs && kwargs.training;
        const attnOutput = tf.tidy(() => {
          const inputShape = inputs.shape;
          const batchSize = inputShape[0];
          const sequenceLength = inputShape[1];
          const headDim = Math.max(Math.floor(this.embedDim / this.numHeads), 1);

          const query = this.queryDense.apply(inputs);
          const key = this.keyDense.apply(inputs);
          const value = this.valueDense.apply(inputs);

          const queryHeads = tf.transpose(tf.reshape(query, [batchSize, sequenceLength, this.numHeads, headDim]), [0, 2, 1, 3]);
          const keyHeads = tf.transpose(tf.reshape(key, [batchSize, sequenceLength, this.numHeads, headDim]), [0, 2, 1, 3]);
          const valueHeads = tf.transpose(tf.reshape(value, [batchSize, sequenceLength, this.numHeads, headDim]), [0, 2, 1, 3]);

          const scale = 1.0 / Math.sqrt(headDim);
          const scores = tf.mul(tf.matMul(queryHeads, keyHeads, false, true), scale);
          const weights = tf.softmax(scores);
          const context = tf.matMul(weights, valueHeads);
          const merged = tf.reshape(tf.transpose(context, [0, 2, 1, 3]), [batchSize, sequenceLength, this.numHeads * headDim]);
          return this.attentionOutputDense.apply(merged);
        });

        const dropoutOutput = this.dropout1.apply(attnOutput, { training: training });
        const out1 = this.layernorm1.apply(tf.add(inputs, dropoutOutput));
        const ffnOutput = this.ffn.apply(out1);
        const ffnOut = this.ffnOut.apply(ffnOutput);
        const dropout2Output = this.dropout2.apply(ffnOut, { training: training });
        return this.layernorm2.apply(tf.add(out1, dropout2Output));
      }

      /**
       * Computes output shape.
       *
       * @param {any} inputShape - Input shape
       */
      computeOutputShape(inputShape) {
        return inputShape;
      }

      /**
       * Gets config.
       */
      getConfig() {
        return {
          embedDim: this.embedDim,
          numHeads: this.numHeads,
          ffDim: this.ffDim,
          rate: this.rate,
        };
      }

      static get className() {
        return "TransformerBlock";
      }
    }

    // Create PreExtractedCubeLocalHead3D class
    class PreExtractedCubeLocalHead3D extends tf.layers.Layer {
      /**
       * Constructor for class.
       *
       * @param {any} config - Config
       */
      constructor(config) {
        super(config);
        this.topN = config.topN || 3;
        this.tokenWidth = config.tokenWidth || 32;
        this.cubeSizeXY = config.cubeSizeXY || 16;
        this.directExtend = config.directExtend || 32;
        this.patchFeatDim = config.patchFeatDim || 128;
        this.extWidth = this.tokenWidth + 2 * this.directExtend;
      }

      /**
       * Builds.
       *
       * @param {any} inputShape - Input shape
       */
      build(inputShape) {
        this.conv1 = tf.layers.conv3d({ filters: 16, kernelSize: [3, 3, 3], padding: "same", activation: "relu" });
        this.pool1 = tf.layers.maxPooling3d({ poolSize: [2, 2, 2] });
        this.conv2 = tf.layers.conv3d({ filters: 32, kernelSize: [3, 3, 3], padding: "same", activation: "relu" });
        this.pool2 = tf.layers.maxPooling3d({ poolSize: [2, 2, 2] });
        this.conv3 = tf.layers.conv3d({ filters: 64, kernelSize: [3, 3, 3], padding: "same", activation: "relu" });
        this.conv4 = tf.layers.conv3d({ filters: 64, kernelSize: [3, 3, 3], padding: "same", activation: "relu" });
        this.pool3 = tf.layers.maxPooling3d({ poolSize: [2, 2, 2] });
        this.flatten = tf.layers.flatten();
        this.layerNorm = tf.layers.layerNormalization();
        this.denseFeat = tf.layers.dense({ units: this.patchFeatDim, activation: "relu" });
        this.transformer = new TransformerBlock({
          embedDim: this.patchFeatDim,
          numHeads: 4,
          ffDim: this.patchFeatDim * 2,
          rate: 0.1,
        });
        this.densePatch1 = tf.layers.dense({ units: 96, activation: "relu" });
        this.densePatch2 = tf.layers.dense({ units: 2, activation: "linear" });
        super.build(inputShape);
      }

      /**
       * Calls.
       *
       * @param {any} inputs - Inputs
       */
      call(inputs) {
        const cubes = tf.cast(inputs, "float32");
        const batchSize = tf.shape(cubes)[0];
        const t = tf.shape(cubes)[1];
        let flat = tf.reshape(cubes, [-1, this.cubeSizeXY, this.cubeSizeXY, this.extWidth, 2]);
        let feat = this.conv1.apply(flat);
        feat = this.pool1.apply(feat);
        feat = this.conv2.apply(feat);
        feat = this.pool2.apply(feat);
        feat = this.conv3.apply(feat);
        feat = this.conv4.apply(feat);
        feat = this.pool3.apply(feat);
        feat = this.flatten.apply(feat);
        feat = this.layerNorm.apply(feat);
        feat = this.denseFeat.apply(feat);
        const patchLocalFlat = this.densePatch1.apply(feat);
        const patchLocal = this.densePatch2.apply(patchLocalFlat);
        const patchLocalReshaped = tf.reshape(patchLocal, [batchSize, t, this.topN, 2]);
        const featSeq = tf.reshape(feat, [batchSize, t, this.patchFeatDim]);
        let tokenFeat = this.transformer.apply(featSeq);
        tokenFeat = tf.concat([tokenFeat, tokenFeat], -1);
        return [tokenFeat, patchLocalReshaped];
      }

      /**
       * Computes output shape.
       *
       * @param {any} inputShape - Input shape
       */
      computeOutputShape(inputShape) {
        return [[inputShape[0], inputShape[1], 2 * this.patchFeatDim], [inputShape[0], inputShape[1], this.topN, 2]];
      }

      /**
       * Gets config.
       */
      getConfig() {
        return {
          topN: this.topN,
          tokenWidth: this.tokenWidth,
          cubeSizeXY: this.cubeSizeXY,
          directExtend: this.directExtend,
          patchFeatDim: this.patchFeatDim,
        };
      }

      static get className() {
        return "PreExtractedCubeLocalHead3D";
      }
    }

    return {
      TransformerBlock: TransformerBlock,
      PreExtractedCubeLocalHead3D: PreExtractedCubeLocalHead3D,
    };
  }

  /**
   * Registers custom layers.
   *
   * @param {any} tf - TensorFlow
   */
  function registerCustomLayers(tf) {
    if (!customLayerClasses.TransformerBlock) {
      customLayerClasses = createCustomLayerClasses(tf);
    }
    if (tf.serialization) {
      try {
        tf.serialization.registerClass(customLayerClasses.TransformerBlock);
        tf.serialization.registerClass(customLayerClasses.PreExtractedCubeLocalHead3D);
      } catch (e) {
        console.warn("Custom layers already registered:", e.message);
      }
    }
  }

  /**
   * Ints field.
   *
   * @param {any} header - Header
   * @param {any} index - Index
   * @param {any} name - Name
   */
  function intField(header, index, name) {
    const v = header[index];
    if (!Number.isFinite(v)) {
      throw new Error("Invalid FT3 header field " + name + ": " + String(v));
    }
    return Math.round(v);
  }


  /**
   * Parses FT3 meta from array buffer.
   *
   * @param {any} ft3ArrayBuffer - FT3 array buffer
   */
  function parseFt3MetaFromArrayBuffer(ft3ArrayBuffer) {
    if (!(ft3ArrayBuffer instanceof ArrayBuffer)) {
      throw new Error("ft3ArrayBuffer must be an ArrayBuffer");
    }
    if (ft3ArrayBuffer.byteLength < HEADER_BYTES) {
      throw new Error("FT3 bytes too small for 2048-byte header");
    }

    const header = new Float32Array(ft3ArrayBuffer, 0, HEADER_FLOAT_COUNT);

    const dimorder1 = intField(header, IDX.FDDIMORDER1, "FDDIMORDER1");
    const dimorder2 = intField(header, IDX.FDDIMORDER2, "FDDIMORDER2");
    const dimorder3 = intField(header, IDX.FDDIMORDER3, "FDDIMORDER3");
    const dimorder4 = intField(header, IDX.FDDIMORDER4, "FDDIMORDER4");

    const nDirect = intField(header, IDX.FDSIZE, "FDSIZE");
    const nIndirect = intField(header, IDX.FDSPECNUM, "FDSPECNUM");

    const dataTypes = [
      intField(header, IDX.FDF1QUADFLAG, "FDF1QUADFLAG"),
      intField(header, IDX.FDF2QUADFLAG, "FDF2QUADFLAG"),
      intField(header, IDX.FDF3QUADFLAG, "FDF3QUADFLAG"),
      intField(header, IDX.FDF4QUADFLAG, "FDF4QUADFLAG"),
    ];

    if (!(dimorder1 >= 1 && dimorder1 <= 4 && dimorder2 >= 1 && dimorder2 <= 4 && dimorder3 >= 1 && dimorder3 <= 4)) {
      throw new Error("Unexpected FT3 dim orders: " + [dimorder1, dimorder2, dimorder3, dimorder4].join(","));
    }

    const datatypeDirect = dataTypes[dimorder1 - 1];
    const datatypeIndirect = dataTypes[dimorder2 - 1];
    const datatypeIndirect2 = dataTypes[dimorder3 - 1];

    let partsPerRow = 1;
    if (datatypeDirect === 0) partsPerRow += 1;
    if (datatypeIndirect === 0) partsPerRow += 1;
    if (datatypeDirect === 0 && datatypeIndirect === 0) partsPerRow += 1;

    let nIndirectLoops = nIndirect;
    if (datatypeDirect === 0 && datatypeIndirect === 0) {
      nIndirectLoops = Math.floor(nIndirectLoops / 2);
    }

    if (nDirect <= 0 || nIndirect <= 0 || nIndirectLoops <= 0) {
      throw new Error("Invalid derived FT3 dimensions");
    }

    const planeFloatCount = nIndirectLoops * nDirect * partsPerRow;
    const planeByteSize = planeFloatCount * 4;

    const fileSize = ft3ArrayBuffer.byteLength;
    const totalDataBytes = fileSize - HEADER_BYTES;
    const headerPlaneCount = intField(header, IDX.FDF3SIZE, "FDF3SIZE");

    let nPlanes = 0;
    if (headerPlaneCount > 0) {
      nPlanes = headerPlaneCount;
    } else {
      nPlanes = Math.floor(totalDataBytes / planeByteSize);
    }

    if (nPlanes <= 0) {
      throw new Error("Unable to derive plane count from FT3 header/size");
    }

    const residual = totalDataBytes - nPlanes * planeByteSize;
    let dataStartOffset = HEADER_BYTES;
    if (residual === HEADER_BYTES) {
      dataStartOffset += HEADER_BYTES;
    }

    return {
      fileSizeBytes: fileSize,
      dimorder1,
      dimorder2,
      dimorder3,
      dimorder4,
      nDirect,
      nIndirect,
      nPlanes,
      datatypeDirect,
      datatypeIndirect,
      datatypeIndirect2,
      directIsComplex: datatypeDirect === 0,
      indirectIsComplex: datatypeIndirect === 0,
      nIndirectLoops,
      partsPerRow,
      planeFloatCount,
      planeByteSize,
      dataStartOffset,
      residualBytesAfterPlaneFit: residual,
    };
  }

  /**
   * Reads FT3 all from array buffer.
   *
   * @param {any} ft3ArrayBuffer - FT3 array buffer
   * @param {any} meta - Meta
   */
  function readFt3AllFromArrayBuffer(ft3ArrayBuffer, meta) {
    const m = meta || parseFt3MetaFromArrayBuffer(ft3ArrayBuffer);
    const fileFloat32 = new Float32Array(ft3ArrayBuffer);

    const rr = new Float32Array(m.nPlanes * m.nIndirectLoops * m.nDirect);
    const ri = m.directIsComplex ? new Float32Array(m.nPlanes * m.nIndirectLoops * m.nDirect) : null;
    const ir = m.indirectIsComplex ? new Float32Array(m.nPlanes * m.nIndirectLoops * m.nDirect) : null;
    const ii = (m.directIsComplex && m.indirectIsComplex)
      ? new Float32Array(m.nPlanes * m.nIndirectLoops * m.nDirect)
      : null;

    const rowBlock = m.nDirect * m.partsPerRow;
    const dataStartFloat = Math.floor(m.dataStartOffset / 4);

    for (let p = 0; p < m.nPlanes; p += 1) {
      const planeStart = dataStartFloat + p * m.planeFloatCount;
      for (let r = 0; r < m.nIndirectLoops; r += 1) {
        const rowStart = planeStart + r * rowBlock;
        let cursor = 0;

        const outRowBase = (p * m.nIndirectLoops + r) * m.nDirect;

        rr.set(fileFloat32.subarray(rowStart + cursor, rowStart + cursor + m.nDirect), outRowBase);
        cursor += m.nDirect;

        if (ri) {
          ri.set(fileFloat32.subarray(rowStart + cursor, rowStart + cursor + m.nDirect), outRowBase);
          cursor += m.nDirect;
        }

        if (ir) {
          ir.set(fileFloat32.subarray(rowStart + cursor, rowStart + cursor + m.nDirect), outRowBase);
          cursor += m.nDirect;
        }

        if (ii) {
          ii.set(fileFloat32.subarray(rowStart + cursor, rowStart + cursor + m.nDirect), outRowBase);
        }
      }
    }

    const out = { rr };
    if (ri) out.ri = ri;
    if (ir) out.ir = ir;
    if (ii) out.ii = ii;
    return out;
  }

  /**
   * Loads experiment from FT3 array buffer.
   *
   * @param {any} ft3ArrayBuffer - FT3 array buffer
   * @param {any} options - Options
   */
  function loadExperimentFromFt3ArrayBuffer(ft3ArrayBuffer, options) {
    const opts = options || {};
    const flipRiSign = opts.flipRiSign !== false;

    const meta = parseFt3MetaFromArrayBuffer(ft3ArrayBuffer);
    const arrays = readFt3AllFromArrayBuffer(ft3ArrayBuffer, meta);

    if (!arrays.ri) {
      throw new Error("FT3 does not contain direct imaginary channel (ri). Complex direct data is required.");
    }

    // FT3 stacked layout is [planes, indirect_loops, direct].
    // Model expects [indirect1, indirect2, direct] where indirect1=loops, indirect2=planes.
    const ni1 = meta.nIndirectLoops;
    const ni2 = meta.nPlanes;
    const nd = meta.nDirect;

    const rrIn = arrays.rr;
    const riIn = arrays.ri;

    const bsz = 1;
    const channels = 2;
    const spectra = new Float32Array(bsz * ni1 * ni2 * nd * channels);

    // Global normalization like Python load_ft3_as_rr_ri
    let maxAbs = 1e-8;
    for (let p = 0; p < ni2; p += 1) {
      for (let l = 0; l < ni1; l += 1) {
        const base = (p * ni1 + l) * nd;
        for (let d = 0; d < nd; d += 1) {
          const rr = rrIn[base + d];
          const riRaw = riIn[base + d];
          const ri = flipRiSign ? -riRaw : riRaw;
          const a = Math.abs(rr);
          const b = Math.abs(ri);
          if (a > maxAbs) maxAbs = a;
          if (b > maxAbs) maxAbs = b;
        }
      }
    }

    // Fill [b, i1(loop), i2(plane), d, ch]
    let out = 0;
    for (let i1 = 0; i1 < ni1; i1 += 1) {
      for (let i2 = 0; i2 < ni2; i2 += 1) {
        const srcBase = (i2 * ni1 + i1) * nd;
        for (let d = 0; d < nd; d += 1) {
          const rr = rrIn[srcBase + d] / maxAbs;
          const riRaw = riIn[srcBase + d];
          const ri = (flipRiSign ? -riRaw : riRaw) / maxAbs;
          spectra[out++] = rr;
          spectra[out++] = ri;
        }
      }
    }

    return {
      meta,
      spectra,
      shape: [bsz, ni1, ni2, nd, channels],
    };
  }

  /**
   * Spectras index.
   *
   * @param {any} shape - Shape
   * @param {any} b - B
   * @param {any} i1 - I1
   * @param {any} i2 - I2
   * @param {any} d - D
   * @param {any} ch - Ch
   */
  function spectraIndex(shape, b, i1, i2, d, ch) {
    const ni1 = shape[1];
    const ni2 = shape[2];
    const nd = shape[3];
    const channels = shape[4];
    return (((((b * ni1 + i1) * ni2 + i2) * nd + d) * channels) + ch);
  }

  /**
   * Cubes index.
   *
   * @param {any} shape - Shape
   * @param {any} b - B
   * @param {any} t - T
   * @param {any} k - K
   * @param {any} x - X
   * @param {any} y - Y
   * @param {any} dz - Dz
   * @param {any} ch - Ch
   */
  function cubeIndex(shape, b, t, k, x, y, dz, ch) {
    const tTotal = shape[1];
    const topN = shape[2];
    const cubeXY = shape[3];
    const extWidth = shape[5];
    const channels = shape[6];
    return (((((((((b * tTotal + t) * topN + k) * cubeXY + x) * cubeXY + y) * extWidth + dz) * channels) + ch)));
  }

  /**
   * Tokens offset.
   *
   * @param {any} shape - Shape
   * @param {any} b - B
   * @param {any} t - T
   */
  function tokenOffset(shape, b, t) {
    const tTotal = shape[1];
    const topN = shape[2];
    const cubeXY = shape[3];
    const extWidth = shape[5];
    const channels = shape[6];
    const strideToken = topN * cubeXY * cubeXY * extWidth * channels;
    return ((b * tTotal + t) * strideToken);
  }

  /**
   * Extracts top n cubes.
   *
   * @param {any} spectraObj - Spectra obj
   * @param {any} cfg - Configuration
   */
  function extractTopNCubes(spectraObj, cfg) {
    const { spectra, shape } = spectraObj;
    const bsz = shape[0];
    const ni1 = shape[1];
    const ni2 = shape[2];
    const nd = shape[3];

    const topN = cfg.topN;
    const tokenWidth = cfg.tokenWidth;
    const cubeSizeXY = cfg.cubeSizeXY;
    const directExtend = cfg.directExtend;

    const tTotal = Math.max(Math.floor(nd / tokenWidth), 1);
    const ndUse = tTotal * tokenWidth;
    const extWidth = tokenWidth + 2 * directExtend;
    const half = Math.floor(cubeSizeXY / 2);

    const cubesShape = [bsz, tTotal, topN, cubeSizeXY, cubeSizeXY, extWidth, 2];
    const cubes = new Float32Array(bsz * tTotal * topN * cubeSizeXY * cubeSizeXY * extWidth * 2);
    const i1Idx = new Int32Array(bsz * tTotal * topN);
    const i2Idx = new Int32Array(bsz * tTotal * topN);
    const cubeScore = new Float32Array(bsz * tTotal * topN);
    cubeScore.fill(-1e9);

    for (let b = 0; b < bsz; b += 1) {
      for (let t = 0; t < tTotal; t += 1) {
        const d0 = t * tokenWidth;

        const scoreMap = new Float32Array(ni1 * ni2);
        for (let r = 0; r < ni1; r += 1) {
          for (let c = 0; c < ni2; c += 1) {
            let maxPow = 0.0;
            for (let dd = 0; dd < tokenWidth; dd += 1) {
              const d = d0 + dd;
              if (d >= ndUse) break;
              const idxR = spectraIndex(shape, b, r, c, d, 0);
              const idxI = idxR + 1;
              const rr = spectra[idxR];
              const ri = spectra[idxI];
              const pw = rr * rr + ri * ri;
              if (pw > maxPow) maxPow = pw;
            }
            scoreMap[r * ni2 + c] = maxPow;
          }
        }

        const order = Array.from({ length: ni1 * ni2 }, (_, i) => i)
          .sort((a, b2) => scoreMap[b2] - scoreMap[a]);

        const selected = [];
        for (const flatIdx of order) {
          const r = Math.floor(flatIdx / ni2);
          const c = flatIdx % ni2;
          let ok = true;
          for (const pair of selected) {
            const sr = pair[0];
            const sc = pair[1];
            if (Math.max(Math.abs(r - sr), Math.abs(c - sc)) < cubeSizeXY) {
              ok = false;
              break;
            }
          }
          if (ok) selected.push([r, c]);
          if (selected.length >= topN) break;
        }

        if (selected.length < topN) {
          for (const flatIdx of order) {
            const r = Math.floor(flatIdx / ni2);
            const c = flatIdx % ni2;
            let exists = false;
            for (const pair of selected) {
              if (pair[0] === r && pair[1] === c) {
                exists = true;
                break;
              }
            }
            if (!exists) selected.push([r, c]);
            if (selected.length >= topN) break;
          }
        }

        if (selected.length === 0) {
          for (let k = 0; k < topN; k += 1) selected.push([0, 0]);
        } else if (selected.length < topN) {
          const last = selected[selected.length - 1];
          while (selected.length < topN) selected.push(last);
        }

        for (let k = 0; k < topN; k += 1) {
          const r0 = selected[k][0];
          const c0 = selected[k][1];

          i1Idx[(b * tTotal + t) * topN + k] = r0;
          i2Idx[(b * tTotal + t) * topN + k] = c0;
          cubeScore[(b * tTotal + t) * topN + k] = scoreMap[r0 * ni2 + c0];

          for (let x = 0; x < cubeSizeXY; x += 1) {
            for (let y = 0; y < cubeSizeXY; y += 1) {
              const srcI1 = r0 + (x - half);
              const srcI2 = c0 + (y - half);

              for (let dz = 0; dz < extWidth; dz += 1) {
                const srcD = d0 - directExtend + dz;

                let rr = 0.0;
                let ri = 0.0;
                if (
                  srcI1 >= 0 && srcI1 < ni1 &&
                  srcI2 >= 0 && srcI2 < ni2 &&
                  srcD >= 0 && srcD < ndUse
                ) {
                  const idxR = spectraIndex(shape, b, srcI1, srcI2, srcD, 0);
                  rr = spectra[idxR];
                  ri = spectra[idxR + 1];
                }

                const outR = cubeIndex(cubesShape, b, t, k, x, y, dz, 0);
                cubes[outR] = rr;
                cubes[outR + 1] = ri;
              }
            }
          }
        }

        // Per-token normalization (not per-cube)
        const off = tokenOffset(cubesShape, b, t);
        const strideToken = topN * cubeSizeXY * cubeSizeXY * extWidth * 2;
        let maxAbs = 0.0;
        for (let q = 0; q < strideToken; q += 1) {
          const v = Math.abs(cubes[off + q]);
          if (v > maxAbs) maxAbs = v;
        }
        if (maxAbs > 1e-9) {
          const inv = 1.0 / maxAbs;
          for (let q = 0; q < strideToken; q += 1) {
            cubes[off + q] *= inv;
          }
        }

      }
    }

    return { cubes, cubesShape, i1Idx, i2Idx, cubeScore };
  }

  /**
   * Solve2x2s.
   *
   * @param {any} a11 - A11
   * @param {any} a12 - A12
   * @param {any} a21 - A21
   * @param {any} a22 - A22
   * @param {any} b1 - B1
   * @param {any} b2 - B2
   */
  function solve2x2(a11, a12, a21, a22, b1, b2) {
    const det = a11 * a22 - a12 * a21;
    if (Math.abs(det) < 1e-20) {
      return [0.0, 0.0];
    }
    const x1 = (b1 * a22 - b2 * a12) / det;
    const x2 = (a11 * b2 - a21 * b1) / det;
    return [x1, x2];
  }

  /**
   * Wls left right from local.
   *
   * @param {any} phasePerToken - Phase per token
   * @param {any} weightPerToken - Weight per token
   * @param {any} directDim - Direct dimension
   * @param {any} tokenWidth - Token width
   * @param {any} l2Reg - L2 reg
   */
  function wlsLeftRightFromLocal(phasePerToken, weightPerToken, directDim, tokenWidth, l2Reg) {
    const bsz = phasePerToken.length;
    const t = phasePerToken[0].length;
    const out = new Array(bsz);

    const x = new Float32Array(t);
    const directDimVal = Math.max(Number(directDim), 1);
    const tokenWidthVal = Number(tokenWidth);
    for (let i = 0; i < t; i += 1) {
      x[i] = ((i * tokenWidthVal) + (0.5 * tokenWidthVal)) / directDimVal;
    }

    for (let b = 0; b < bsz; b += 1) {
      let s11 = 0.0;
      let s12 = 0.0;
      let s22 = 0.0;
      let v1 = 0.0;
      let v2 = 0.0;

      for (let i = 0; i < t; i += 1) {
        const wi = Number(weightPerToken[b][i]);
        const yi = Number(phasePerToken[b][i]);
        const a = 1.0 - x[i];
        const c = x[i];

        s11 += wi * a * a;
        s12 += wi * a * c;
        s22 += wi * c * c;
        v1 += wi * a * yi;
        v2 += wi * c * yi;
      }

      s11 += l2Reg;
      s22 += l2Reg;

      const beta = solve2x2(s11, s12, s12, s22, v1, v2);
      out[b] = [beta[0], beta[1]];
    }

    return out;
  }

  /**
   * Applies left right to cubes.
   *
   * @param {any} ext - Ext
   * @param {any} leftRight - Left right
   * @param {any} directDim - Direct dimension
   * @param {any} tokenWidth - Token width
   */
  function applyLeftRightToCubes(ext, leftRight, directDim, tokenWidth) {
    // ext: { cubes, cubesShape }
    const cubes = ext.cubes;
    const shape = ext.cubesShape;
    const bsz = shape[0];
    const tTotal = shape[1];
    const topN = shape[2];
    const cubeXY = shape[3];
    const extWidth = shape[5];

    const directDimVal = Math.max(Number(directDim), 1);
    const tokenWidthVal = Number(tokenWidth);

    for (let b = 0; b < bsz; b += 1) {
      for (let t = 0; t < tTotal; t += 1) {
        const xToken = ((t * tokenWidthVal) + (0.5 * tokenWidthVal)) / directDimVal;
        const lr = leftRight[b];
        const left = lr[0];
        const right = lr[1];
        const phaseDeg = left * (1.0 - xToken) + right * xToken;
        const phi = phaseDeg * Math.PI / 180.0;
        const c = Math.cos(phi);
        const s = Math.sin(phi);

        for (let k = 0; k < topN; k += 1) {
          for (let xx = 0; xx < cubeXY; xx += 1) {
            for (let yy = 0; yy < cubeXY; yy += 1) {
              for (let dz = 0; dz < extWidth; dz += 1) {
                const idx = cubeIndex(shape, b, t, k, xx, yy, dz, 0);
                const rr = cubes[idx];
                const ri = cubes[idx + 1];
                const nr = rr * c - ri * s;
                const ni = rr * s + ri * c;
                cubes[idx] = nr;
                cubes[idx + 1] = ni;
              }
            }
          }
        }
      }
    }
  }

  /**
   * Applies left right to spectra.
   *
   * @param {any} spectraObj - Spectra obj
   * @param {any} leftRight - Left right
   */
  function applyLeftRightToSpectra(spectraObj, leftRight) {
    // spectraObj: { spectra, shape } with shape [batch, ni1, ni2, nd, 2]
    const spectra = spectraObj.spectra;
    const shape = spectraObj.shape;
    const bsz = shape[0];
    const ni1 = shape[1];
    const ni2 = shape[2];
    const nd = shape[3];

    const denom = Math.max(nd - 1, 1);

    for (let b = 0; b < bsz; b += 1) {
      const lr = leftRight[b];
      const left = lr[0];
      const right = lr[1];
      for (let i1 = 0; i1 < ni1; i1 += 1) {
        for (let i2 = 0; i2 < ni2; i2 += 1) {
          for (let d = 0; d < nd; d += 1) {
            const x = d / denom;
            const phaseDeg = left * (1.0 - x) + right * x;
            const phi = phaseDeg * Math.PI / 180.0;
            const c = Math.cos(phi);
            const s = Math.sin(phi);
            const idx = spectraIndex(shape, b, i1, i2, d, 0);
            const rr = spectra[idx];
            const ri = spectra[idx + 1];
            spectra[idx] = rr * c - ri * s;
            spectra[idx + 1] = rr * s + ri * c;
          }
        }
      }
    }
  }

  /**
   * Adds left right arrays.
   *
   * @param {any} a - A
   * @param {any} b - B
   */
  function addLeftRightArrays(a, b) {
    // a and b are arrays of shape [batch][2] where each element is [left, right]
    if (!a) return b;
    if (!b) return a;
    const B = a.length;
    const out = new Array(B);
    for (let i = 0; i < B; i += 1) {
      const aa = a[i] || [0, 0];
      const bb = b[i] || [0, 0];
      out[i] = [aa[0] + bb[0], aa[1] + bb[1]];
    }
    return out;
  }

  /**
   * Runs model on cubes.
   *
   * @param {any} tf - TensorFlow
   * @param {any} model - Model
   * @param {any} ext - Ext
   * @param {any} cfg - Configuration
   * @param {any} stageName - Stage name
   * @returns {Promise<void>}
   */
  async function runModelOnCubes(tf, model, ext, cfg, stageName) {
    // stageName: optional identifier for debug output (e.g., 'large_model', 'normal_1', 'normal_2')
    const debugStage = stageName || null;
    const cubesTensor = tf.tensor(ext.cubes, ext.cubesShape, "float32");

    // If the model exposes `execute` assume a GraphModel exported with n_tokens=1
    // and run it in batches along the token axis to avoid per-token JS overhead.
    if (typeof model.execute === "function") {
      const bsz = ext.cubesShape[0];
      const tTotal = ext.cubesShape[1];
      const topN = ext.cubesShape[2];
      const cubeXY = ext.cubesShape[3];
      const extWidth = ext.cubesShape[5];

      const tokenBatchSize = (cfg && cfg.tokenBatchSize) || 8;

      const phasePerToken = Array.from({ length: bsz }, () => []);
      const weightPerToken = Array.from({ length: bsz }, () => []);

      for (let start = 0; start < tTotal; start += tokenBatchSize) {
        const nb = Math.min(tokenBatchSize, tTotal - start);

        const slice = tf.tidy(() =>
          tf.slice(cubesTensor, [0, start, 0, 0, 0, 0, 0], [-1, nb, -1, -1, -1, -1, -1])
        );

        // Reshape [B, nb, topN, x, y, extW, 2] -> [B*nb, 1, topN, x, y, extW, 2]
        const reshaped = tf.tidy(() =>
          tf.reshape(slice, [bsz * nb, 1, topN, cubeXY, cubeXY, extWidth, 2])
        );

        const raw = model.execute(reshaped);

        // raw is an array: [phase_output, local_preds_output, patch_local_output]
        // We want local_preds_output which has shape [bsz*nb, 1, 2]
        const rawLocal = Array.isArray(raw) ? raw[1] : raw;
        if (Array.isArray(raw)) {
          // Dispose the unused outputs
          raw[0].dispose();
          if (raw[2]) raw[2].dispose();
        }

        // rawLocal expected shape: [bsz*nb, 1, 2] -> convert to [bsz, nb, 2]
        const rawSqueezed = tf.tidy(() => tf.squeeze(rawLocal, [1]));
        const rawReshaped = tf.tidy(() => tf.reshape(rawSqueezed, [bsz, nb, 2]));

        const phaseChunk = tf.tidy(() => tf.slice(rawReshaped, [0, 0, 0], [-1, -1, 1]).squeeze([2]));
        const weightChunk = tf.tidy(() => tf.slice(rawReshaped, [0, 0, 1], [-1, -1, 1]).squeeze([2]));

        const phaseArr = await phaseChunk.array();
        const weightArr = await weightChunk.array();

        for (let b = 0; b < bsz; b += 1) {
          phasePerToken[b].push(...phaseArr[b]);
          weightPerToken[b].push(...weightArr[b]);
        }

        // dispose temporaries
        slice.dispose();
        reshaped.dispose();
        rawLocal.dispose();
        rawSqueezed.dispose();
        rawReshaped.dispose();
        phaseChunk.dispose();
        weightChunk.dispose();
      }

      // Apply weight smoothing on the assembled logits per token
      const weightTensor = smoothGatedWeightFromLogits(tf.tensor(weightPerToken));
      const weightPerTokenFinal = await weightTensor.array();

      const leftRight = wlsLeftRightFromLocal(phasePerToken, weightPerTokenFinal, cfg.directDim, cfg.tokenWidth, cfg.l2Reg);

      // Log per-token predictions for the first batch (usually only 1 batch)
      if (phasePerToken.length > 0) {
        const stageLabel = debugStage || "unnamed_stage";
        const pStr = phasePerToken[0].map(v => v.toFixed(3)).join(", ");
        const wLogitStr = weightPerToken[0].map(v => v.toFixed(3)).join(", ");
        const wlsStr = leftRight[0].map(v => v.toFixed(2)).join(", ");

        const logMsg = `[tfjs][${stageLabel}] \n  Local Phases: ${pStr}\n  Raw Logits:   ${wLogitStr}\n  WLS (L/R):    ${wlsStr}`;
        console.log(logMsg);
        logToHtml(logMsg);
      }

      // cleanup
      cubesTensor.dispose();
      weightTensor.dispose();

      return {
        pred_local_phase: phasePerToken,
        pred_local_w: weightPerTokenFinal,
        wls_phase_left_right: leftRight,
      };
    }

    // Fallback: layers model path (predict whole tensor at once)
    const rawOutput = model.predict(cubesTensor);

    // rawOutput is an array: [phase_output, local_preds_output, patch_local_output]
    // We want local_preds_output which has shape [batch, n_tokens, 2]
    const localPredsOutput = Array.isArray(rawOutput) ? rawOutput[1] : rawOutput;

    // Dispose outputs we don't need
    if (Array.isArray(rawOutput)) {
      rawOutput[0].dispose();
      if (rawOutput[2]) rawOutput[2].dispose();
    }

    // Extract phase and weight logits from localPredsOutput
    const phaseTensor = tf.tidy(() => {
      return tf.slice(localPredsOutput, [0, 0, 0], [-1, -1, 1]).squeeze([2]);
    });

    const wLogitsTensor = tf.tidy(() => {
      return tf.slice(localPredsOutput, [0, 0, 1], [-1, -1, 1]).squeeze([2]);
    });

    const weightTensor = smoothGatedWeightFromLogits(wLogitsTensor);

    const phasePerToken = await phaseTensor.array();
    const weightPerToken = await weightTensor.array();
    const leftRight = wlsLeftRightFromLocal(phasePerToken, weightPerToken, cfg.directDim, cfg.tokenWidth, cfg.l2Reg);

    // Clean up tensors
    cubesTensor.dispose();
    localPredsOutput.dispose();
    phaseTensor.dispose();
    wLogitsTensor.dispose();
    weightTensor.dispose();

    return {
      pred_local_phase: phasePerToken,
      pred_local_w: weightPerToken,
      wls_phase_left_right: leftRight,
    };
  }

  /**
   * Infers from spectra.
   *
   * @param {any} params - Params
   * @returns {Promise<void>}
   */
  async function inferFromSpectra(params) {
    const tf = ensureTf(params.tf);
    const model = params.model;
    if (!model) {
      throw new Error("inferFromSpectra requires a loaded tf.js model instance");
    }

    const cfg = {
      topN: params.topN != null ? params.topN : DEFAULTS.topN,
      tokenWidth: params.tokenWidth != null ? params.tokenWidth : DEFAULTS.tokenWidth,
      cubeSizeXY: params.cubeSizeXY != null ? params.cubeSizeXY : DEFAULTS.cubeSizeXY,
      directExtend: params.directExtend != null ? params.directExtend : DEFAULTS.directExtend,
      l2Reg: params.l2Reg != null ? params.l2Reg : DEFAULTS.l2Reg,
      directDim: params.shape[3],
    };

    const spectraObj = {
      spectra: params.spectra,
      shape: params.shape,
    };

    const ext = extractTopNCubes(spectraObj, cfg);
    const cubesTensor = tf.tensor(ext.cubes, ext.cubesShape, "float32");

    // Model outputs an array: [phase_output, local_preds_output, patch_local_output]
    // We want local_preds_output which has shape [batch, n_tokens, 2]
    const rawOutput = model.predict(cubesTensor);

    // Extract the local predictions output (output 1)
    const localPredsOutput = Array.isArray(rawOutput) ? rawOutput[1] : rawOutput;

    // Dispose of unused outputs
    if (Array.isArray(rawOutput)) {
      rawOutput[0].dispose();
      if (rawOutput[2]) rawOutput[2].dispose();
    }

    // Extract phase and weight logits from local predictions
    const phaseTensor = tf.tidy(() => {
      return tf.slice(localPredsOutput, [0, 0, 0], [-1, -1, 1]).squeeze([2]);
    });

    const wLogitsTensor = tf.tidy(() => {
      return tf.slice(localPredsOutput, [0, 0, 1], [-1, -1, 1]).squeeze([2]);
    });

    // Apply weight smoothing
    const weightTensor = smoothGatedWeightFromLogits(wLogitsTensor);

    const phasePerToken = await phaseTensor.array();
    const weightPerToken = await weightTensor.array();
    const leftRight = wlsLeftRightFromLocal(phasePerToken, weightPerToken, cfg.directDim, cfg.tokenWidth, cfg.l2Reg);

    // Log per-token predictions for the first batch
    if (phasePerToken.length > 0) {
      console.log("[tfjs] Per-token local phase:", phasePerToken[0].map(v => v.toFixed(2)));
      console.log("[tfjs] Per-token weights:", weightPerToken.map(v => v.toFixed(3)));
      console.log("[tfjs] Stage WLS Left/Right:", leftRight[0].map(v => v.toFixed(2)));
    }

    // Clean up tensors
    cubesTensor.dispose();
    localPredsOutput.dispose();
    phaseTensor.dispose();
    wLogitsTensor.dispose();
    weightTensor.dispose();

    return {
      config: cfg,
      shapes: {
        spectra: spectraObj.shape,
        cubes: ext.cubesShape,
        localPhase: [phasePerToken.length, phasePerToken[0].length],
        localWeight: [weightPerToken.length, weightPerToken[0].length],
      },
      cubeMeta: {
        i1Idx: ext.i1Idx,
        i2Idx: ext.i2Idx,
        cubeScore: ext.cubeScore,
      },
      pred_local_phase: phasePerToken,
      pred_local_w: weightPerToken,
      wls_phase_left_right: leftRight,
    };
  }

  /**
   * Runs from FT3.
   *
   * @param {any} params - Params
   * @returns {Promise<void>}
   */
  async function runFromFt3(params) {
    const tf = ensureTf(params.tf);
    const ft3ArrayBuffer = params.ft3ArrayBuffer;
    if (!(ft3ArrayBuffer instanceof ArrayBuffer)) {
      throw new Error("runFromFt3 requires ft3ArrayBuffer");
    }

    // Register custom layers and get custom objects
    registerCustomLayers(tf);
    const customObjects = getCustomObjects(tf);

    // Load models - accept either pre-loaded models or URLs
    let normalModel = params.model;
    if (!normalModel) {
      if (!params.modelUrl) {
        throw new Error("Provide either model or modelUrl for the normal model");
      }
      normalModel = await tf.loadGraphModel(params.modelUrl);
    }

    let largeModel = params.largeModel;
    if (!largeModel) {
      if (!params.largeModelUrl) {
        throw new Error("Provide either largeModel or largeModelUrl for the initial large model");
      }
      largeModel = await tf.loadGraphModel(params.largeModelUrl);
    }

    // PURE JAVASCRIPT PART 1: Parse FT3 and extract cubes
    const exp = loadExperimentFromFt3ArrayBuffer(ft3ArrayBuffer, {
      flipRiSign: params.flipRiSign != null ? params.flipRiSign : DEFAULTS.flipRiSign,
    });

    const spectraOriginal = {
      spectra: exp.spectra.slice(0),
      shape: exp.shape,
    };

    const cfg = {
      topN: params.topN != null ? params.topN : DEFAULTS.topN,
      tokenWidth: params.tokenWidth != null ? params.tokenWidth : DEFAULTS.tokenWidth,
      cubeSizeXY: params.cubeSizeXY != null ? params.cubeSizeXY : DEFAULTS.cubeSizeXY,
      directExtend: params.directExtend != null ? params.directExtend : DEFAULTS.directExtend,
      l2Reg: params.l2Reg != null ? params.l2Reg : DEFAULTS.l2Reg,
      directDim: exp.shape[3],
    };

    const spectraWorking1 = {
      spectra: spectraOriginal.spectra,
      shape: spectraOriginal.shape,
    };
    const ext1 = extractTopNCubes(spectraWorking1, cfg);

    // DEBUG: Inspect model architecture before inference
    console.log("[tfjs-debug] === Large Model Architecture ===");
    console.log("[tfjs-debug] Large model layer count:", largeModel.layers ? largeModel.layers.length : "N/A");
    if (largeModel.weights && largeModel.weights.length > 0) {
      console.log("[tfjs-debug] Large model weights count:", largeModel.weights.length);
      // Show first few layer weights
      largeModel.weights.slice(0, Math.min(3, largeModel.weights.length)).forEach((w, i) => {
        const data = w.dataSync();
        const stats = {
          shape: w.shape,
          min: Math.min(...data),
          max: Math.max(...data),
          mean: data.reduce((a, b) => a + b) / data.length
        };
        console.log(`[tfjs-debug]   Weight ${i}:`, stats);
      });
    }

    // Test inference on a small sample to verify output structure
    console.log("[tfjs-debug] === Testing Large Model on First Batch ===");
    const testBatch = tf.tidy(() => {
      return tf.slice(tf.tensor(ext1.cubes, ext1.cubesShape), [0, 0, 0, 0, 0, 0, 0], [1, 1, -1, -1, -1, -1, -1]);
    });
    const testOutput = largeModel.predict(testBatch);

    if (Array.isArray(testOutput)) {
      console.log("[tfjs-debug] Model output is array with", testOutput.length, "tensors");
      testOutput.forEach((output, i) => {
        console.log(`[tfjs-debug]   Output[${i}] shape:`, output.shape.toString(), "dtype:", output.dtype);
        const dataSlice = output.dataSync().slice(0, Math.min(10, output.size));
        console.log(`[tfjs-debug]   Output[${i}] first 10 values:`, Array.from(dataSlice).map(v => v.toFixed(4)).join(', '));
      });
      testOutput.forEach(o => o.dispose());
    } else {
      console.log("[tfjs-debug] Model output is single tensor:");
      console.log("[tfjs-debug]   Shape:", testOutput.shape.toString());
      const dataSlice = testOutput.dataSync().slice(0, Math.min(10, testOutput.size));
      console.log("[tfjs-debug]   First 10 values:", Array.from(dataSlice).map(v => v.toFixed(4)).join(', '));
      testOutput.dispose();
    }
    testBatch.dispose();

    // TENSORFLOW.JS PART: Five-stage inference pipeline
    // Stage 1: run the large model and apply its left/right phase to the full spectrum
    console.log("[tfjs] Starting Stage 1: Large Model");
    const largeOut = await runModelOnCubes(tf, largeModel, ext1, cfg, 'large_model');
    applyLeftRightToSpectra(spectraWorking1, largeOut.wls_phase_left_right.map(lr => [-lr[0], -lr[1]]));

    const ext2 = extractTopNCubes(spectraWorking1, cfg);

    // Stage 2: run the normal model, apply its left/right to the full spectrum again
    console.log("[tfjs] Starting Stage 2: Normal Model (Iteration 1)");
    const normalOut1 = await runModelOnCubes(tf, normalModel, ext2, cfg, 'normal_1');
    applyLeftRightToSpectra(spectraWorking1, normalOut1.wls_phase_left_right.map(lr => [-lr[0], -lr[1]]));

    const ext3 = extractTopNCubes(spectraWorking1, cfg);

    // Stage 3: run the normal model again
    console.log("[tfjs] Starting Stage 3: Normal Model (Iteration 2)");
    const normalOut2 = await runModelOnCubes(tf, normalModel, ext3, cfg, 'normal_2');
    applyLeftRightToSpectra(spectraWorking1, normalOut2.wls_phase_left_right.map(lr => [-lr[0], -lr[1]]));

    const ext4 = extractTopNCubes(spectraWorking1, cfg);

    // Stage 4: run the normal model again
    console.log("[tfjs] Starting Stage 4: Normal Model (Iteration 3)");
    const normalOut3 = await runModelOnCubes(tf, normalModel, ext4, cfg, 'normal_3');
    applyLeftRightToSpectra(spectraWorking1, normalOut3.wls_phase_left_right.map(lr => [-lr[0], -lr[1]]));

    const ext5 = extractTopNCubes(spectraWorking1, cfg);

    // Stage 5: run the normal model for the final time
    console.log("[tfjs] Starting Stage 5: Normal Model (Iteration 4)");
    const normalOut4 = await runModelOnCubes(tf, normalModel, ext5, cfg, 'normal_4');

    // PURE JAVASCRIPT PART 2: Combine phase predictions from all stages via WLS fitting
    // Sum left/right from each stage to get final left/right
    let finalLeftRight = largeOut.wls_phase_left_right;
    finalLeftRight = addLeftRightArrays(finalLeftRight, normalOut1.wls_phase_left_right);
    finalLeftRight = addLeftRightArrays(finalLeftRight, normalOut2.wls_phase_left_right);
    finalLeftRight = addLeftRightArrays(finalLeftRight, normalOut3.wls_phase_left_right);
    finalLeftRight = addLeftRightArrays(finalLeftRight, normalOut4.wls_phase_left_right);

    console.log("[tfjs] Final combined WLS Left/Right:", finalLeftRight[0].map(v => v.toFixed(2)));
    logToHtml(`[tfjs][Final] Combined WLS: [${finalLeftRight[0].map(v => v.toFixed(2)).join(", ")}]`);

    return {
      ft3Meta: exp.meta,
      config: cfg,
      shapes: {
        spectra: exp.shape,
        cubes: ext1.cubesShape,
      },
      cubeMeta: {
        i1Idx: ext1.i1Idx,
        i2Idx: ext1.i2Idx,
        cubeScore: ext1.cubeScore,
      },
      stage_large: largeOut,
      stage_normal_1: normalOut1,
      stage_normal_2: normalOut2,
      stage_normal_3: normalOut3,
      stage_normal_4: normalOut4,
      final_wls_phase_left_right: finalLeftRight,
    };
  }

  const api = {
    defaults: Object.assign({}, DEFAULTS),
    parseFt3MetaFromArrayBuffer,
    readFt3AllFromArrayBuffer,
    loadExperimentFromFt3ArrayBuffer,
    extractTopNCubes,
    wlsLeftRightFromLocal,
    inferFromSpectra,
    runFromFt3,
    registerCustomLayers,
    getCustomObjects,
    loadModel: async function (tf, modelUrl) {
      const tfi = ensureTf(tf);
      return await tfi.loadGraphModel(modelUrl);
    },
  };

  globalScope.NUS3DPhasePipeline = api;
})(typeof window !== "undefined" ? window : globalThis);
