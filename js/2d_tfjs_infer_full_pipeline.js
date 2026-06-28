/*
Browser-first single-file pipeline for 2D model30 tf.js inference.

This file exposes window.NUS2DPhasePipeline with functions to:

PURE JAVASCRIPT OPERATIONS:
1) Parse NMRPipe FT2 bytes (ArrayBuffer)
2) Convert FT2 content to model-ready spectra [1, ny, nx, 2]
3) Extract top-N patches per token along direct dimension
4) Per-token normalize patches to max amplitude 1.0
5) Run weighted least squares (WLS) regression to get left/right phase correction

TENSORFLOW.JS OPERATIONS:
6) Run CNN + Attention model to get raw local predictions (batch, n_tokens, 2)
   - Output [..., 0] = predicted phase per token
   - Output [..., 1] = uncertainty log-variance (s_uncertainty)

Intended use in webpage:
- Include this script after TensorFlow.js
- Call NUS2DPhasePipeline.runFromFt2({ ... })
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
    if (globalScope.append_2d_log) {
      globalScope.append_2d_log(msg);
    }
  }

  const IDX = {
    FDPLANE: 221,       // tp
    FDSPECNUM: 219,     // n1
    FDSIZE: 99,         // n2
    FDF1QUADFLAG: 55,   // quad_flag_1
    FDF2QUADFLAG: 56,   // quad_flag_2
  };

  const DEFAULTS = {
    topN: 5,
    tokenWidth: 32,
    patchHeight: 32,
    directExtend: 32,
    l2Reg: 1e-6,
    flipRiSign: true,
    useTokenNorms: false,
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
   * Computes softmax weights from uncertainty s-values.
   * Numerically stable softmax over negative log-variance (-s), excluding first and last tokens.
   * Optionally scales by token norms.
   *
   * @param {Array<Array<number>>} sUncertainty - Uncertainty logits per token [batch, tokens]
   * @param {Array<Array<number>>} tokenNorms - Token norm factors [batch, tokens]
   * @param {boolean} useTokenNorms - Flag to scale by token norms
   */
  function computeSoftmaxWeights(sUncertainty, tokenNorms, useTokenNorms) {
    const bsz = sUncertainty.length;
    const t = sUncertainty[0].length;
    const out = new Array(bsz);

    for (let b = 0; b < bsz; b += 1) {
      const s = sUncertainty[b];
      const w = new Float32Array(t); // initially all zeros, excluding first & last automatically

      if (t > 2) {
        // Extract middle tokens
        const sMid = s.slice(1, t - 1);
        let maxNegS = -sMid[0];
        for (let i = 1; i < sMid.length; i += 1) {
          if (-sMid[i] > maxNegS) {
            maxNegS = -sMid[i];
          }
        }

        let sumExp = 0.0;
        const expMid = new Float32Array(sMid.length);
        for (let i = 0; i < sMid.length; i += 1) {
          expMid[i] = Math.exp(-sMid[i] - maxNegS);
          sumExp += expMid[i];
        }

        const invSum = sumExp > 1e-9 ? 1.0 / sumExp : 0.0;
        for (let i = 0; i < sMid.length; i += 1) {
          w[1 + i] = expMid[i] * invSum;
        }
      } else {
        // Fallback: uniform weights if too few tokens
        for (let i = 0; i < t; i += 1) {
          w[i] = 1.0 / t;
        }
      }

      if (useTokenNorms && tokenNorms) {
        const tn = tokenNorms[b];
        for (let i = 0; i < t; i += 1) {
          w[i] = w[i] * tn[i];
        }
      }

      out[b] = w;
    }
    return out;
  }

  /**
   * Gets custom objects.
   *
   * @param {any} tf - TensorFlow
   */
  function getCustomObjects(tf) {
    const tfi = tf || cachedTf || ensureTf();
    if (!cachedTf) cachedTf = tfi;

    if (!customLayerClasses.TransformerBlock) {
      customLayerClasses = createCustomLayerClasses(tfi);
    }
    return {
      TransformerBlock: customLayerClasses.TransformerBlock,
      PreExtractedPatchLocalHead2D: customLayerClasses.PreExtractedPatchLocalHead2D,
    };
  }

  /**
   * Creates custom layer classes for Keras LayersModel compatibility.
   *
   * @param {any} tf - TensorFlow
   */
  function createCustomLayerClasses(tf) {
    // Create TransformerBlock class
    class TransformerBlock extends tf.layers.Layer {
      constructor(config) {
        super(config);
        this.embedDim = config.embedDim || 128;
        this.numHeads = config.numHeads || 4;
        this.ffDim = config.ffDim || 256;
        this.rate = config.rate || 0.1;
      }

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

      computeOutputShape(inputShape) {
        return inputShape;
      }

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

    // Create PreExtractedPatchLocalHead2D class
    class PreExtractedPatchLocalHead2D extends tf.layers.Layer {
      constructor(config) {
        super(config);
        this.topN = config.topN || 5;
        this.tokenWidth = config.tokenWidth || 32;
        this.patchHeight = config.patchHeight || 32;
        this.directExtend = config.directExtend || 32;
        this.patchFeatDim = config.patchFeatDim || 128;
        this.extWidth = this.tokenWidth + 2 * this.directExtend;
      }

      build(inputShape) {
        this.conv1 = tf.layers.conv2d({ filters: 16, kernelSize: [3, 3], padding: "same", activation: "relu" });
        this.pool1 = tf.layers.maxPooling2d({ poolSize: [2, 2] });
        this.conv2 = tf.layers.conv2d({ filters: 32, kernelSize: [3, 3], padding: "same", activation: "relu" });
        this.pool2 = tf.layers.maxPooling2d({ poolSize: [2, 2] });
        this.conv3 = tf.layers.conv2d({ filters: 64, kernelSize: [3, 3], padding: "same", activation: "relu" });
        this.conv4 = tf.layers.conv2d({ filters: 64, kernelSize: [3, 3], padding: "same", activation: "relu" });
        this.pool3 = tf.layers.maxPooling2d({ poolSize: [2, 2] });

        this.patchNorm = tf.layers.layerNormalization();
        this.patchDense = tf.layers.dense({ units: this.patchFeatDim, activation: "relu" });

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

      call(inputs) {
        const patches = tf.cast(inputs, "float32");
        const batchSize = tf.shape(patches)[0];
        const t = tf.shape(patches)[1];
        const channels = patches.shape[5] || 1;

        let flat = tf.reshape(patches, [-1, this.patchHeight, this.extWidth, channels]);
        let featMap = this.conv1.apply(flat);
        featMap = this.pool1.apply(featMap);
        featMap = this.conv2.apply(featMap);
        featMap = this.pool2.apply(featMap);
        featMap = this.conv3.apply(featMap);
        featMap = this.conv4.apply(featMap);
        featMap = this.pool3.apply(featMap);

        const featAvg = tf.reduceMean(featMap, [1, 2]);
        const featMax = tf.reduceMax(featMap, [1, 2]);
        let feat = tf.concat([featAvg, featMax], -1);
        feat = this.patchNorm.apply(feat);
        feat = this.patchDense.apply(feat);

        const patchLocalFlat = this.densePatch1.apply(feat);
        const patchLocal = this.densePatch2.apply(patchLocalFlat);
        const patchLocalReshaped = tf.reshape(patchLocal, [batchSize, t, this.topN, 2]);

        const featSeq = tf.reshape(feat, [tf.mul(batchSize, t), this.topN, this.patchFeatDim]);
        let featTransformed = this.transformer.apply(featSeq);
        const transAvg = tf.reduceMean(featTransformed, 1);
        const transMax = tf.reduceMax(featTransformed, 1);
        let tokenFeat = tf.concat([transAvg, transMax], -1);
        tokenFeat = tf.reshape(tokenFeat, [batchSize, t, 2 * this.patchFeatDim]);

        return [tokenFeat, patchLocalReshaped];
      }

      computeOutputShape(inputShape) {
        return [[inputShape[0], inputShape[1], 2 * this.patchFeatDim], [inputShape[0], inputShape[1], this.topN, 2]];
      }

      getConfig() {
        return {
          topN: this.topN,
          tokenWidth: this.tokenWidth,
          patchHeight: this.patchHeight,
          directExtend: this.directExtend,
          patchFeatDim: this.patchFeatDim,
        };
      }

      static get className() {
        return "PreExtractedPatchLocalHead2D";
      }
    }

    return {
      TransformerBlock: TransformerBlock,
      PreExtractedPatchLocalHead2D: PreExtractedPatchLocalHead2D,
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
        tf.serialization.registerClass(customLayerClasses.PreExtractedPatchLocalHead2D);
      } catch (e) {
        console.warn("Custom layers already registered:", e.message);
      }
    }
  }

  /**
   * Parses FT2 header meta.
   *
   * @param {any} ft2ArrayBuffer - FT2 array buffer
   */
  function parseFt2MetaFromArrayBuffer(ft2ArrayBuffer) {
    if (!(ft2ArrayBuffer instanceof ArrayBuffer)) {
      throw new Error("ft2ArrayBuffer must be an ArrayBuffer");
    }
    if (ft2ArrayBuffer.byteLength < HEADER_BYTES) {
      throw new Error("FT2 bytes too small for 2048-byte header");
    }

    const header = new Float32Array(ft2ArrayBuffer, 0, HEADER_FLOAT_COUNT);

    const tp = Math.round(header[IDX.FDPLANE]);
    const n1 = Math.round(header[IDX.FDSPECNUM]);
    const n2 = Math.round(header[IDX.FDSIZE]);
    const quadFlag1 = header[IDX.FDF1QUADFLAG];
    const quadFlag2 = header[IDX.FDF2QUADFLAG];

    return {
      fileSizeBytes: ft2ArrayBuffer.byteLength,
      tp,
      n1,
      n2,
      quadFlag1,
      quadFlag2,
    };
  }

  /**
   * Reads FT2 all from array buffer.
   *
   * @param {any} ft2ArrayBuffer - FT2 array buffer
   * @param {any} meta - Meta
   */
  function readFt2AllFromArrayBuffer(ft2ArrayBuffer, meta) {
    const m = meta || parseFt2MetaFromArrayBuffer(ft2ArrayBuffer);
    const fileFloat32 = new Float32Array(ft2ArrayBuffer);

    const n1 = m.n1;
    const n2 = m.n2;
    const quadFlag1 = m.quadFlag1;
    const quadFlag2 = m.quadFlag2;

    let n1Use = n1;
    let rr, ri;
    const dataStartFloat = 512;

    if (quadFlag1 === 0.0 && quadFlag2 === 0.0) {
      // both are complex
      n1Use = Math.floor(n1 / 2);
      rr = new Float32Array(n1Use * n2);
      ri = new Float32Array(n1Use * n2);
      let cursor = dataStartFloat;
      for (let i = 0; i < n1Use; i += 1) {
        // Read n2 for rr
        for (let j = 0; j < n2; j += 1) {
          rr[i * n2 + j] = fileFloat32[cursor++];
        }
        // Read n2 for ri
        for (let j = 0; j < n2; j += 1) {
          ri[i * n2 + j] = fileFloat32[cursor++];
        }
        // skip ir and ii (2 * n2 floats)
        cursor += 2 * n2;
      }
    } else if (quadFlag1 === 1.0 && quadFlag2 === 0.0) {
      // indirect is real, direct is complex
      rr = new Float32Array(n1 * n2);
      ri = new Float32Array(n1 * n2);
      let cursor = dataStartFloat;
      for (let i = 0; i < n1; i += 1) {
        for (let j = 0; j < n2; j += 1) {
          rr[i * n2 + j] = fileFloat32[cursor++];
        }
        for (let j = 0; j < n2; j += 1) {
          ri[i * n2 + j] = fileFloat32[cursor++];
        }
      }
    } else if (quadFlag1 === 0.0 && quadFlag2 === 1.0) {
      // indirect is complex, direct is real
      rr = new Float32Array(n1 * n2);
      ri = new Float32Array(n1 * n2); // remains zero
      let cursor = dataStartFloat;
      for (let i = 0; i < n1; i += 1) {
        for (let j = 0; j < n2; j += 1) {
          rr[i * n2 + j] = fileFloat32[cursor++];
        }
        cursor += n2; // skip ir
      }
    } else {
      // both are real
      rr = new Float32Array(n1 * n2);
      ri = new Float32Array(n1 * n2); // remains zero
      let cursor = dataStartFloat;
      for (let i = 0; i < n1; i += 1) {
        for (let j = 0; j < n2; j += 1) {
          rr[i * n2 + j] = fileFloat32[cursor++];
        }
      }
    }

    // Transpose if tp == 1
    let finalNy = n1Use;
    let finalNx = n2;
    let finalRr = rr;
    let finalRi = ri;

    if (m.tp === 1) {
      finalNy = n2;
      finalNx = n1Use;
      finalRr = new Float32Array(finalNy * finalNx);
      finalRi = new Float32Array(finalNy * finalNx);
      for (let i = 0; i < n1Use; i += 1) {
        for (let j = 0; j < n2; j += 1) {
          finalRr[j * finalNx + i] = rr[i * n2 + j];
          finalRi[j * finalNx + i] = ri[i * n2 + j];
        }
      }
    }

    return {
      rr: finalRr,
      ri: finalRi,
      ny: finalNy,
      nx: finalNx,
    };
  }

  /**
   * Loads experiment from FT2 array buffer.
   *
   * @param {any} ft2ArrayBuffer - FT2 array buffer
   * @param {any} options - Options
   */
  function loadExperimentFromFt2ArrayBuffer(ft2ArrayBuffer, options) {
    const opts = options || {};
    const flipRiSign = opts.flipRiSign !== false;

    const meta = parseFt2MetaFromArrayBuffer(ft2ArrayBuffer);
    const arrays = readFt2AllFromArrayBuffer(ft2ArrayBuffer, meta);

    const ny = arrays.ny;
    const nx = arrays.nx;

    const bsz = 1;
    const channels = 2;
    const spectra = new Float32Array(bsz * ny * nx * channels);

    // Find global normalization factor
    let maxAbs = 1e-8;
    for (let i = 0; i < arrays.rr.length; i += 1) {
      const rr = arrays.rr[i];
      const riRaw = arrays.ri ? arrays.ri[i] : 0.0;
      const ri = flipRiSign ? -riRaw : riRaw;
      const a = Math.abs(rr);
      const b = Math.abs(ri);
      if (a > maxAbs) maxAbs = a;
      if (b > maxAbs) maxAbs = b;
    }

    // Fill output spectra [1, ny, nx, 2]
    let out = 0;
    for (let y = 0; y < ny; y += 1) {
      for (let x = 0; x < nx; x += 1) {
        const srcIdx = y * nx + x;
        const rr = arrays.rr[srcIdx] / maxAbs;
        const riRaw = arrays.ri ? arrays.ri[srcIdx] : 0.0;
        const ri = (flipRiSign ? -riRaw : riRaw) / maxAbs;
        spectra[out++] = rr;
        spectra[out++] = ri;
      }
    }

    return {
      meta,
      spectra,
      shape: [bsz, ny, nx, channels],
    };
  }

  /**
   * Spectras index.
   *
   * @param {any} shape - Shape [batch, ny, nx, channels]
   * @param {any} b - B
   * @param {any} y - Y
   * @param {any} x - X
   * @param {any} ch - Ch
   */
  function spectraIndex(shape, b, y, x, ch) {
    const ny = shape[1];
    const nx = shape[2];
    const channels = shape[3];
    return (((b * ny + y) * nx + x) * channels + ch);
  }

  /**
   * Extracts top n patches.
   *
   * @param {any} spectraObj - Spectra obj
   * @param {any} cfg - Configuration
   * @param {number} [numChannels] - Number of channels (1 or 2)
   */
  function extractTopNPatches(spectraObj, cfg, numChannels) {
    const { spectra, shape } = spectraObj;
    const bsz = shape[0];
    const ny = shape[1];
    const nx = shape[2];

    const topN = cfg.topN;
    const tokenWidth = cfg.tokenWidth;
    const patchHeight = cfg.patchHeight;
    const directExtend = cfg.directExtend;
    const channels = numChannels !== undefined ? numChannels : (cfg.channels || 2);

    const tTotal = Math.max(Math.floor(nx / tokenWidth), 1);
    const nxUse = tTotal * tokenWidth;
    const extWidth = tokenWidth + 2 * directExtend;
    const half = Math.floor(patchHeight / 2);

    const patchesShape = [bsz, tTotal, topN, patchHeight, extWidth, channels];
    const patches = new Float32Array(bsz * tTotal * topN * patchHeight * extWidth * channels);
    const rowIdx = new Int32Array(bsz * tTotal * topN);
    const rowScore = new Float32Array(bsz * tTotal * topN);
    const tokenNorms = new Float32Array(bsz * tTotal);
    rowScore.fill(-1e9);

    const getPaddedSpectraVal = (b, y, xPadded, ch) => {
      const origX = xPadded - directExtend;
      if (origX >= 0 && origX < nxUse && y >= 0 && y < ny) {
        const idx = spectraIndex(shape, b, y, origX, ch);
        return spectra[idx];
      }
      return 0.0;
    };

    for (let b = 0; b < bsz; b += 1) {
      for (let t = 0; t < tTotal; t += 1) {
        const x0 = t * tokenWidth;

        // Compute power for each row along the token direct dimension
        const scorePerRow = new Float32Array(ny);
        for (let r = 0; r < ny; r += 1) {
          let maxPow = 0.0;
          for (let dd = 0; dd < tokenWidth; dd += 1) {
            const x = x0 + dd;
            if (x >= nxUse) break;
            const idxReal = spectraIndex(shape, b, r, x, 0);
            const rr = spectra[idxReal];
            const ri = spectra[idxReal + 1];
            const pw = rr * rr + ri * ri;
            if (pw > maxPow) maxPow = pw;
          }
          scorePerRow[r] = maxPow;
        }

        // Sort rows by score descending
        const order = Array.from({ length: ny }, (_, i) => i)
          .sort((a, b2) => scorePerRow[b2] - scorePerRow[a]);

        const selected = [];
        const excludeBorder = true;

        for (const idx of order) {
          if (excludeBorder && (idx < half || idx >= ny - half)) {
            continue;
          }
          let ok = true;
          for (const s of selected) {
            if (Math.abs(idx - s) < patchHeight) {
              ok = false;
              break;
            }
          }
          if (ok) selected.push(idx);
          if (selected.length >= topN) break;
        }

        if (selected.length < topN) {
          for (const idx of order) {
            if (excludeBorder && (idx < half || idx >= ny - half)) {
              continue;
            }
            if (!selected.includes(idx)) {
              selected.push(idx);
            }
            if (selected.length >= topN) break;
          }
        }

        if (selected.length === 0) {
          const fallbackIdx = (excludeBorder && ny > patchHeight) ? half : 0;
          for (let k = 0; k < topN; k += 1) {
            selected.push(fallbackIdx);
          }
        } else if (selected.length < topN) {
          const last = selected[selected.length - 1];
          while (selected.length < topN) {
            selected.push(last);
          }
        }

        // Extract patches using padded coordinates
        for (let k = 0; k < topN; k += 1) {
          const cy = selected[k];
          rowIdx[(b * tTotal + t) * topN + k] = cy;
          rowScore[(b * tTotal + t) * topN + k] = scorePerRow[cy];

          for (let py = 0; py < patchHeight; py += 1) {
            const origY = cy + (py - half);

            for (let px = 0; px < extWidth; px += 1) {
              const paddedX = x0 + px;

              for (let ch = 0; ch < channels; ch += 1) {
                let val = 0.0;
                if (origY >= 0 && origY < ny) {
                  val = getPaddedSpectraVal(b, origY, paddedX, ch);
                }

                const outIdx = ((((b * tTotal + t) * topN + k) * patchHeight + py) * extWidth + px) * channels + ch;
                patches[outIdx] = val;
              }
            }
          }
        }

        // Normalize patches for this token to max absolute amplitude 1.0
        const strideToken = topN * patchHeight * extWidth * channels;
        const off = (b * tTotal + t) * strideToken;
        let maxAbs = 0.0;
        for (let q = 0; q < strideToken; q += 1) {
          const v = Math.abs(patches[off + q]);
          if (v > maxAbs) maxAbs = v;
        }
        tokenNorms[b * tTotal + t] = maxAbs;

        if (maxAbs > 1e-9) {
          const inv = 1.0 / maxAbs;
          for (let q = 0; q < strideToken; q += 1) {
            patches[off + q] *= inv;
          }
        }
      }
    }

    return { patches, patchesShape, rowIdx, rowScore, tokenNorms };
  }

  /**
   * Solve 2x2 linear equation.
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
   * Applies left right to patches.
   *
   * @param {any} ext - Ext
   * @param {any} leftRight - Left right
   * @param {any} directDim - Direct dimension
   * @param {any} tokenWidth - Token width
   */
  function applyLeftRightToPatches(ext, leftRight, directDim, tokenWidth) {
    const patches = ext.patches;
    const shape = ext.patchesShape;
    const bsz = shape[0];
    const tTotal = shape[1];
    const topN = shape[2];
    const patchHeight = shape[3];
    const extWidth = shape[4];

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
          for (let py = 0; py < patchHeight; py += 1) {
            for (let px = 0; px < extWidth; px += 1) {
              const idx = ((((b * tTotal + t) * topN + k) * patchHeight + py) * extWidth + px) * 2;
              const rr = patches[idx];
              const ri = patches[idx + 1];
              patches[idx] = rr * c - ri * s;
              patches[idx + 1] = rr * s + ri * c;
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
    const spectra = spectraObj.spectra;
    const shape = spectraObj.shape;
    const bsz = shape[0];
    const ny = shape[1];
    const nx = shape[2];

    const denom = Math.max(nx - 1, 1);

    for (let b = 0; b < bsz; b += 1) {
      const lr = leftRight[b];
      const left = lr[0];
      const right = lr[1];
      for (let y = 0; y < ny; y += 1) {
        for (let x = 0; x < nx; x += 1) {
          const xVal = x / denom;
          const phaseDeg = left * (1.0 - xVal) + right * xVal;
          const phi = phaseDeg * Math.PI / 180.0;
          const c = Math.cos(phi);
          const s = Math.sin(phi);
          const idx = spectraIndex(shape, b, y, x, 0);
          const rr = spectra[idx];
          const ri = spectra[idx + 1];
          spectra[idx] = rr * c - ri * s;
          spectra[idx + 1] = rr * s + ri * c;
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
   * Runs model on patches.
   *
   * @param {any} tf - TensorFlow
   * @param {any} model - Model
   * @param {any} ext - Ext
   * @param {any} cfg - Configuration
   * @param {any} stageName - Stage name
   * @returns {Promise<void>}
   */
  async function runModelOnPatches(tf, model, ext, cfg, stageName) {
    const debugStage = stageName || null;
    const patchesTensor = tf.tensor(ext.patches, ext.patchesShape, "float32");

    // If the model exposes `execute` assume a GraphModel exported with n_tokens=1
    // and run it in batches along the token axis to avoid per-token JS overhead.
    if (typeof model.execute === "function") {
      const bsz = ext.patchesShape[0];
      const tTotal = ext.patchesShape[1];
      const topN = ext.patchesShape[2];
      const patchHeight = ext.patchesShape[3];
      const extWidth = ext.patchesShape[4];

      const tokenBatchSize = (cfg && cfg.tokenBatchSize) || 8;

      const phasePerToken = Array.from({ length: bsz }, () => []);
      const sUncertaintyPerToken = Array.from({ length: bsz }, () => []);

      for (let start = 0; start < tTotal; start += tokenBatchSize) {
        const nb = Math.min(tokenBatchSize, tTotal - start);

        const slice = tf.tidy(() =>
          tf.slice(patchesTensor, [0, start, 0, 0, 0, 0], [-1, nb, -1, -1, -1, -1])
        );

        // Reshape [B, nb, topN, py, px, ch] -> [B*nb, 1, topN, py, px, ch]
        const reshaped = tf.tidy(() =>
          tf.reshape(slice, [bsz * nb, 1, topN, patchHeight, extWidth, ext.patchesShape[5]])
        );

        const raw = model.execute(reshaped);

        // raw is an array: [phase_output, local_preds_output, patch_local_output]
        // We want local_preds_output which has shape [bsz*nb, 1, 2]
        const rawLocal = Array.isArray(raw) ? raw[1] : raw;
        if (Array.isArray(raw)) {
          raw[0].dispose();
          if (raw[2]) raw[2].dispose();
        }

        // rawLocal expected shape: [bsz*nb, 1, 2] -> convert to [bsz, nb, 2]
        const rawSqueezed = tf.tidy(() => tf.squeeze(rawLocal, [1]));
        const rawReshaped = tf.tidy(() => tf.reshape(rawSqueezed, [bsz, nb, 2]));

        const phaseChunk = tf.tidy(() => tf.slice(rawReshaped, [0, 0, 0], [-1, -1, 1]).squeeze([2]));
        const sChunk = tf.tidy(() => tf.slice(rawReshaped, [0, 0, 1], [-1, -1, 1]).squeeze([2]));

        const phaseArr = await phaseChunk.array();
        const sArr = await sChunk.array();

        for (let b = 0; b < bsz; b += 1) {
          phasePerToken[b].push(...phaseArr[b]);
          sUncertaintyPerToken[b].push(...sArr[b]);
        }

        // dispose temporaries
        slice.dispose();
        reshaped.dispose();
        rawLocal.dispose();
        rawSqueezed.dispose();
        rawReshaped.dispose();
        phaseChunk.dispose();
        sChunk.dispose();
      }

      // Format token norms into batch-wise array
      const tokenNormsArr = new Array(bsz);
      for (let b = 0; b < bsz; b += 1) {
        tokenNormsArr[b] = Array.from(ext.tokenNorms.subarray(b * tTotal, (b + 1) * tTotal));
      }

      // Calculate softmax weights from predicted log-variance (s)
      const weightPerTokenFinal = computeSoftmaxWeights(sUncertaintyPerToken, tokenNormsArr, cfg.useTokenNorms);

      const leftRight = wlsLeftRightFromLocal(phasePerToken, weightPerTokenFinal, cfg.directDim, cfg.tokenWidth, cfg.l2Reg);

      if (phasePerToken.length > 0) {
        const stageLabel = debugStage || "unnamed_stage";
        const pStr = phasePerToken[0].map(v => v.toFixed(3)).join(", ");
        const sStr = sUncertaintyPerToken[0].map(v => v.toFixed(3)).join(", ");
        const wStr = weightPerTokenFinal[0].map(v => v.toFixed(3)).join(", ");
        const wlsStr = leftRight[0].map(v => v.toFixed(2)).join(", ");

        const logMsg = `[tfjs][${stageLabel}] \n  Local Phases: ${pStr}\n  Logits (s):   ${sStr}\n  Weights (w):  ${wStr}\n  WLS (L/R):    ${wlsStr}`;
        console.log(logMsg);
        logToHtml(logMsg);
      }

      patchesTensor.dispose();

      return {
        pred_local_phase: phasePerToken,
        pred_local_w: weightPerTokenFinal,
        pred_local_s: sUncertaintyPerToken,
        wls_phase_left_right: leftRight,
      };
    }

    // Fallback: layers model
    const rawOutput = model.predict(patchesTensor);
    const localPredsOutput = Array.isArray(rawOutput) ? rawOutput[1] : rawOutput;
    if (Array.isArray(rawOutput)) {
      rawOutput[0].dispose();
      if (rawOutput[2]) rawOutput[2].dispose();
    }

    const phaseTensor = tf.tidy(() => tf.slice(localPredsOutput, [0, 0, 0], [-1, -1, 1]).squeeze([2]));
    const sTensor = tf.tidy(() => tf.slice(localPredsOutput, [0, 0, 1], [-1, -1, 1]).squeeze([2]));

    const phasePerToken = await phaseTensor.array();
    const sUncertaintyPerToken = await sTensor.array();

    const bsz = phasePerToken.length;
    const tTotal = phasePerToken[0].length;
    const tokenNormsArr = new Array(bsz);
    for (let b = 0; b < bsz; b += 1) {
      tokenNormsArr[b] = Array.from(ext.tokenNorms.subarray(b * tTotal, (b + 1) * tTotal));
    }

    const weightPerToken = computeSoftmaxWeights(sUncertaintyPerToken, tokenNormsArr, cfg.useTokenNorms);
    const leftRight = wlsLeftRightFromLocal(phasePerToken, weightPerToken, cfg.directDim, cfg.tokenWidth, cfg.l2Reg);

    patchesTensor.dispose();
    localPredsOutput.dispose();
    phaseTensor.dispose();
    sTensor.dispose();

    return {
      pred_local_phase: phasePerToken,
      pred_local_w: weightPerToken,
      pred_local_s: sUncertaintyPerToken,
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
      patchHeight: params.patchHeight != null ? params.patchHeight : DEFAULTS.patchHeight,
      directExtend: params.directExtend != null ? params.directExtend : DEFAULTS.directExtend,
      l2Reg: params.l2Reg != null ? params.l2Reg : DEFAULTS.l2Reg,
      useTokenNorms: params.useTokenNorms != null ? params.useTokenNorms : DEFAULTS.useTokenNorms,
      directDim: params.shape[2], // nx
    };

    const spectraObj = {
      spectra: params.spectra,
      shape: params.shape,
    };

    let modelChannels = params.channels;
    if (modelChannels === undefined && model) {
      if (model.inputs && model.inputs[0] && model.inputs[0].shape) {
        const shp = model.inputs[0].shape;
        const lastDim = shp[shp.length - 1];
        if (lastDim === 1 || lastDim === 2) {
          modelChannels = lastDim;
        }
      }
    }
    if (modelChannels === undefined) {
      modelChannels = 1;
    }

    const ext = extractTopNPatches(spectraObj, cfg, modelChannels);
    const res = await runModelOnPatches(tf, model, ext, cfg, "single_inference");

    return {
      config: cfg,
      shapes: {
        spectra: spectraObj.shape,
        patches: ext.patchesShape,
        localPhase: [res.pred_local_phase.length, res.pred_local_phase[0].length],
        localWeight: [res.pred_local_w.length, res.pred_local_w[0].length],
      },
      cubeMeta: { // matching 3D output names
        rowIdx: ext.rowIdx,
        rowScore: ext.rowScore,
      },
      pred_local_phase: res.pred_local_phase,
      pred_local_w: res.pred_local_w,
      pred_local_s: res.pred_local_s,
      wls_phase_left_right: res.wls_phase_left_right,
    };
  }

  /**
   * Runs the 4-stage inference pipeline from FT2.
   * Calls normal model (4 rounds).
   *
   * @param {any} params - Params
   * @returns {Promise<void>}
   */
  async function runFromFt2(params) {
    const tf = ensureTf(params.tf);
    const ft2ArrayBuffer = params.ft2ArrayBuffer;
    if (!(ft2ArrayBuffer instanceof ArrayBuffer)) {
      throw new Error("runFromFt2 requires ft2ArrayBuffer");
    }

    registerCustomLayers(tf);

    let normalModel = params.model;
    if (!normalModel) {
      if (!params.modelUrl) {
        throw new Error("Provide either model or modelUrl for the normal model");
      }
      normalModel = await tf.loadGraphModel(params.modelUrl);
    }

    const exp = loadExperimentFromFt2ArrayBuffer(ft2ArrayBuffer, {
      flipRiSign: params.flipRiSign != null ? params.flipRiSign : DEFAULTS.flipRiSign,
    });

    const spectraOriginal = {
      spectra: exp.spectra.slice(0),
      shape: exp.shape,
    };

    const cfg = {
      topN: params.topN != null ? params.topN : DEFAULTS.topN,
      tokenWidth: params.tokenWidth != null ? params.tokenWidth : DEFAULTS.tokenWidth,
      patchHeight: params.patchHeight != null ? params.patchHeight : DEFAULTS.patchHeight,
      directExtend: params.directExtend != null ? params.directExtend : DEFAULTS.directExtend,
      l2Reg: params.l2Reg != null ? params.l2Reg : DEFAULTS.l2Reg,
      useTokenNorms: params.useTokenNorms != null ? params.useTokenNorms : DEFAULTS.useTokenNorms,
      directDim: exp.shape[2], // nx
    };

    const spectraWorking = {
      spectra: spectraOriginal.spectra,
      shape: spectraOriginal.shape,
    };

    // Stage 1: run normal model (round 1)
    console.log("[tfjs] Starting Stage 1: Normal Model (Round 1)");
    const ext1 = extractTopNPatches(spectraWorking, cfg, 1);
    const normalOut1 = await runModelOnPatches(tf, normalModel, ext1, cfg, 'normal_1');
    applyLeftRightToSpectra(spectraWorking, normalOut1.wls_phase_left_right.map(lr => [-lr[0], -lr[1]]));

    // Stage 2: run normal model (round 2)
    console.log("[tfjs] Starting Stage 2: Normal Model (Round 2)");
    const ext2 = extractTopNPatches(spectraWorking, cfg, 1);
    const normalOut2 = await runModelOnPatches(tf, normalModel, ext2, cfg, 'normal_2');
    applyLeftRightToSpectra(spectraWorking, normalOut2.wls_phase_left_right.map(lr => [-lr[0], -lr[1]]));

    // Stage 3: run normal model (round 3)
    console.log("[tfjs] Starting Stage 3: Normal Model (Round 3)");
    const ext3 = extractTopNPatches(spectraWorking, cfg, 1);
    const normalOut3 = await runModelOnPatches(tf, normalModel, ext3, cfg, 'normal_3');
    applyLeftRightToSpectra(spectraWorking, normalOut3.wls_phase_left_right.map(lr => [-lr[0], -lr[1]]));

    // Stage 4: run normal model (round 4)
    console.log("[tfjs] Starting Stage 4: Normal Model (Round 4)");
    const ext4 = extractTopNPatches(spectraWorking, cfg, 1);
    const normalOut4 = await runModelOnPatches(tf, normalModel, ext4, cfg, 'normal_4');

    // Combine all predicted phases from all stages
    let finalLeftRight = normalOut1.wls_phase_left_right;
    finalLeftRight = addLeftRightArrays(finalLeftRight, normalOut2.wls_phase_left_right);
    finalLeftRight = addLeftRightArrays(finalLeftRight, normalOut3.wls_phase_left_right);
    finalLeftRight = addLeftRightArrays(finalLeftRight, normalOut4.wls_phase_left_right);

    console.log("[tfjs] Final combined WLS Left/Right:", finalLeftRight[0].map(v => v.toFixed(2)));
    logToHtml(`[tfjs][Final] Combined WLS: [${finalLeftRight[0].map(v => v.toFixed(2)).join(", ")}]`);

    return {
      ft2Meta: exp.meta,
      config: cfg,
      shapes: {
        spectra: exp.shape,
        patches: ext1.patchesShape,
      },
      cubeMeta: { // matching 3D output names
        rowIdx: ext1.rowIdx,
        rowScore: ext1.rowScore,
      },
      stage_normal_1: normalOut1,
      stage_normal_2: normalOut2,
      stage_normal_3: normalOut3,
      stage_normal_4: normalOut4,
      final_wls_phase_left_right: finalLeftRight,
    };
  }

  const api = {
    defaults: Object.assign({}, DEFAULTS),
    parseFt2MetaFromArrayBuffer,
    readFt2AllFromArrayBuffer,
    loadExperimentFromFt2ArrayBuffer,
    extractTopNPatches,
    wlsLeftRightFromLocal,
    inferFromSpectra,
    runFromFt2,
    registerCustomLayers,
    getCustomObjects,
    loadModel: async function (tf, modelUrl) {
      const tfi = ensureTf(tf);
      return await tfi.loadGraphModel(modelUrl);
    },
  };

  globalScope.NUS2DPhasePipeline = api;
})(typeof window !== "undefined" ? window : (typeof global !== "undefined" ? global : this));
