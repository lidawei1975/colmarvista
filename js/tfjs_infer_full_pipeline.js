/*
 * Browser-first single-file pipeline for 3D Model 04 TensorFlow.js inference.
 *
 * Model 04: Phase-Equivariant 3D Complex Phase Predictor with Shape/SNR Feature Fusion.
 * Accepts input cubes of shape [batch, 16, 16, 128, 2] (Real, Imag channels)
 * and directly outputs [phi_pred_deg, std_pred_deg] in degrees.
 *
 * Pipeline Workflow:
 * 1) Parse NMRPipe FT3 ArrayBuffer with complex direct channel (rr, ri) and direct PPM scale.
 * 2) Detect 3D residual water belt / water wall along direct 1H axis (4.60 - 4.85 ppm)
 *    using 3D Planar-detrended Patch-MAD Distribution Quantile (3D PPDQ) robust noise floor
 *    (matching phase_2d/water_belt/detect_water_belt_3d.py & test_water_belt_3d.py).
 * 3) Extract 16x16x128 signal cubes using core-direct SNR peak picking (Signal-Only),
 *    dynamically excluding direct windows whose edge is within 32 data points of the
 *    detected water belt center when a water belt exists.
 * 4) Execute Model 04 TF.js GraphModel forward pass to get phase and uncertainty sigma.
 * 5) Fit optimal P0 and P1 linear phase using revised Weighted RANSAC (W-RANSAC),
 *    accommodating negative peaks and phase wrapping via discrete n*pi adjustments.
 * 6) Execute in 2 iterative rounds and accumulate total [left, right] phase correction.
 */

(function (globalScope) {
  "use strict";

  const HEADER_FLOAT_COUNT = 512;
  const HEADER_BYTES = HEADER_FLOAT_COUNT * 4;

  /**
   * Logs messages to HTML log element if available.
   * @param {string} msg
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

  // Per-dimension NMRPipe header indices for FDF1, FDF2, FDF3, FDF4 (1-based dimCode -> index dimCode - 1)
  const DIM_SW_IDX = [229, 100, 11, 29];
  const DIM_ORIG_IDX = [249, 101, 12, 30];
  const DIM_OBS_IDX = [218, 119, 10, 28];
  const DIM_CAR_IDX = [67, 66, 68, 69];
  const DIM_LABEL_WORD = [18, 16, 20, 22];

  const DEFAULTS = {
    stride: 32,
    windowSize: 128,
    coreWidth: 64,
    cubeXY: 16,
    peakSnrCutoff: 8.0,
    topK: 1,
    excludeWater: true,
    minWaterEdgeDist: 32,
    waterWindowPpm: [4.60, 4.85],
    spilloverCheck: false,
    spilloverCutoff: 0.75,
    flipRiSign: true,
    numRounds: 2,
    ransacCutoffDeg: 5.0,
    ransacIter: 2000,
    ransacNPiMax: 4,
    modelUrl: "js/model04_tfjs/model.json"
  };

  /**
   * Configures TensorFlow.js environment for 3D volumetric convolutions.
   * Disables WebGL texture packing so that simpler unpacked GLSL shaders are generated,
   * preventing shader compilation failures on integrated GPUs (Intel UHD / Iris Xe / AMD APUs).
   */
  function configureTfEnvironment(tfInstance) {
    const tf = tfInstance || globalScope.tf;
    if (!tf || !tf.env) return;
    try {
      tf.env().set('WEBGL_PACK', false);
      tf.env().set('WEBGL_FORCE_F16_TEXTURES', false);
    } catch (e) {
      console.warn('[tfjs] Could not configure WebGL flags:', e);
    }
  }

  // Pre-configure if TensorFlow.js is already loaded
  if (globalScope.tf) {
    configureTfEnvironment(globalScope.tf);
  }

  /**
   * Ensures TensorFlow.js is loaded in the global scope.
   */
  function ensureTf(tfInstance) {
    const tf = tfInstance || globalScope.tf;
    if (!tf) {
      throw new Error("TensorFlow.js not found. Please include @tensorflow/tfjs before this script.");
    }
    configureTfEnvironment(tf);
    return tf;
  }

  // =========================================================================
  // 1. NMRPipe FT3 Header, Direct PPM Scale & Binary Parser
  // =========================================================================

  function intField(header, index, name) {
    const v = header[index];
    if (!Number.isFinite(v)) {
      throw new Error("Invalid FT3 header field " + name + ": " + String(v));
    }
    return Math.round(v);
  }

  function readAsciiLabel(arrayBuffer, wordIdx) {
    const byteOffset = wordIdx * 4;
    if (!arrayBuffer || byteOffset + 8 > arrayBuffer.byteLength) return "";
    const bytes = new Uint8Array(arrayBuffer, byteOffset, 8);
    let str = "";
    for (let i = 0; i < 8; i += 1) {
      if (bytes[i] === 0) break;
      str += String.fromCharCode(bytes[i]);
    }
    return str.trim();
  }

  function isDirectAxisProton(label, obs, maxObs, ppmScale) {
    const clean = (label || "").replace(/[\x00-\x1F\x7F-\x9F<>]/g, "").trim();
    if (/^(13C|C13|C|CA|CB|CO|15N|N15|N|31P|P31|P|19F|F19|F|2H|H2)$/i.test(clean)) {
      return false;
    }
    if (Number.isFinite(maxObs) && maxObs > 0 && Number.isFinite(obs) && obs > 0) {
      if ((obs / maxObs) < 0.96) {
        return false;
      }
    }
    if (ppmScale && ppmScale.length > 0) {
      const p0 = ppmScale[0];
      const pEnd = ppmScale[ppmScale.length - 1];
      const ppmMin = Math.min(p0, pEnd);
      const ppmMax = Math.max(p0, pEnd);
      const swPpm = Math.abs(p0 - pEnd);
      if (swPpm > 50.0 || ppmMax > 40.0 || ppmMin < -25.0) {
        return false;
      }
    }
    return true;
  }

  /**
   * Extracts direct-dimension NMRPipe metadata and chemical shift scale (ppm)
   * matching nmrglue.pipe.make_uc(dic, data, dim=2).ppm_scale().
   */
  function extractDirectAxisInfoFt3(ft3ArrayBuffer, meta) {
    if (!(ft3ArrayBuffer instanceof ArrayBuffer) || ft3ArrayBuffer.byteLength < HEADER_BYTES) {
      return null;
    }
    const header = new Float32Array(ft3ArrayBuffer, 0, HEADER_FLOAT_COUNT);
    const rawD1 = meta && meta.dimorder1 != null ? meta.dimorder1 : Math.round(header[IDX.FDDIMORDER1]);
    const directDimCode = (rawD1 >= 1 && rawD1 <= 4) ? rawD1 : 2;
    const nDirect = meta && meta.nDirect != null ? meta.nDirect : Math.round(header[IDX.FDSIZE]);
    const idx = directDimCode - 1;

    const sw = header[DIM_SW_IDX[idx]];
    const orig = header[DIM_ORIG_IDX[idx]];
    const obs = header[DIM_OBS_IDX[idx]];
    const car = header[DIM_CAR_IDX[idx]];
    const label = readAsciiLabel(ft3ArrayBuffer, DIM_LABEL_WORD[idx]);

    let maxObs = 0.0;
    for (let k = 0; k < 4; k += 1) {
      const o = header[DIM_OBS_IDX[k]];
      const s = header[DIM_SW_IDX[k]];
      if (Number.isFinite(o) && o > maxObs && Number.isFinite(s) && s > 0) {
        maxObs = o;
      }
    }
    if (Number.isFinite(obs) && obs > maxObs) {
      maxObs = obs;
    }

    let ppmScale = null;
    if (nDirect > 0 && Number.isFinite(sw) && sw > 0 && Number.isFinite(obs) && obs > 0 && Number.isFinite(orig)) {
      ppmScale = new Float64Array(nDirect);
      for (let c = 0; c < nDirect; c += 1) {
        ppmScale[c] = (orig + sw * ((nDirect - 1 - c) / nDirect)) / obs;
      }
    }

    const isProton = ppmScale ? isDirectAxisProton(label, obs, maxObs, ppmScale) : false;

    return {
      dimCode: directDimCode,
      size: nDirect,
      label,
      sw,
      orig,
      obs,
      car,
      maxObs,
      isProton,
      ppmScale,
      ppmRange: ppmScale && ppmScale.length > 0 ? [ppmScale[0], ppmScale[ppmScale.length - 1]] : null,
    };
  }

  function parseFt3MetaFromArrayBuffer(ft3ArrayBuffer) {
    if (!(ft3ArrayBuffer instanceof ArrayBuffer)) {
      throw new Error("ft3ArrayBuffer must be an ArrayBuffer");
    }
    if (ft3ArrayBuffer.byteLength < HEADER_BYTES) {
      throw new Error("FT3 bytes too small for 2048-byte header: " + ft3ArrayBuffer.byteLength);
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
      throw new Error("Invalid derived FT3 dimensions: nDirect=" + nDirect + ", nIndirect=" + nIndirect);
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

  function loadExperimentFromFt3ArrayBuffer(ft3ArrayBuffer, options) {
    const opts = options || {};
    const flipRiSign = opts.flipRiSign !== false;

    const meta = parseFt3MetaFromArrayBuffer(ft3ArrayBuffer);
    const arrays = readFt3AllFromArrayBuffer(ft3ArrayBuffer, meta);

    if (!arrays.ri) {
      throw new Error("FT3 does not contain direct imaginary channel (ri). Model 04 strictly requires complex direct data.");
    }

    const directAxis = extractDirectAxisInfoFt3(ft3ArrayBuffer, meta);

    // FT3 stacked layout is [planes, indirect_loops, direct].
    // Transpose to [indirect1, indirect2, direct] where indirect1=loops, indirect2=planes.
    const ni1 = meta.nIndirectLoops;
    const ni2 = meta.nPlanes;
    const nd = meta.nDirect;

    const rrIn = arrays.rr;
    const riIn = arrays.ri;

    const bsz = 1;
    const channels = 2;
    const spectra = new Float32Array(bsz * ni1 * ni2 * nd * channels);

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

    const fullMeta = Object.assign({}, meta, {
      directAxis: directAxis,
      maxAbs: maxAbs,
    });

    return {
      meta: fullMeta,
      maxAbs: maxAbs,
      spectra,
      shape: [bsz, ni1, ni2, nd, channels],
    };
  }

  function spectraIndex(shape, b, i1, i2, d, ch) {
    const ni1 = shape[1];
    const ni2 = shape[2];
    const nd = shape[3];
    return ((((b * ni1 + i1) * ni2 + i2) * nd + d) * 2) + ch;
  }

  // =========================================================================
  // 2. 3D Water Belt / Water Wall Detection (3D PPDQ) & Window Filter
  // =========================================================================

  /**
   * O(N) in-place Quickselect returning the k-th smallest value in arr[0..n-1].
   */
  function quickselectInPlace(arr, k, n) {
    let left = 0;
    let right = n - 1;
    while (left < right) {
      const mid = (left + right) >> 1;
      if (arr[mid] < arr[left]) {
        const t = arr[left]; arr[left] = arr[mid]; arr[mid] = t;
      }
      if (arr[right] < arr[left]) {
        const t = arr[left]; arr[left] = arr[right]; arr[right] = t;
      }
      if (arr[right] < arr[mid]) {
        const t = arr[mid]; arr[mid] = arr[right]; arr[right] = t;
      }
      const pivot = arr[mid];

      let i = left;
      let j = right;
      while (i <= j) {
        while (arr[i] < pivot) i += 1;
        while (arr[j] > pivot) j -= 1;
        if (i <= j) {
          const tmp = arr[i];
          arr[i] = arr[j];
          arr[j] = tmp;
          i += 1;
          j -= 1;
        }
      }
      if (k <= j) right = j;
      else if (k >= i) left = i;
      else return arr[k];
    }
    return arr[k];
  }

  /**
   * Exact median of buf[0..n-1] matching numpy.median (mutates buf[0..n-1]).
   */
  function medianInPlace(buf, n) {
    if (n <= 0) return 0.0;
    const mid = n >> 1;
    if ((n & 1) === 1) {
      return quickselectInPlace(buf, mid, n);
    }
    const hi = quickselectInPlace(buf, mid, n);
    let lo = buf[0];
    for (let i = 1; i < mid; i += 1) {
      if (buf[i] > lo) lo = buf[i];
    }
    return 0.5 * (lo + hi);
  }

  /**
   * Exact linear-interpolated percentile matching numpy.percentile(..., q).
   */
  function percentileLinear(sortedArr, q) {
    const n = sortedArr.length;
    if (n === 0) return 1e-4;
    if (n === 1) return sortedArr[0];
    const pos = (q / 100.0) * (n - 1);
    const lo = Math.floor(pos);
    const hi = Math.ceil(pos);
    const frac = pos - lo;
    return sortedArr[lo] * (1.0 - frac) + sortedArr[hi] * frac;
  }

  /**
   * Robust 3D Noise Floor Estimator (3D PPDQ) matching estimate_noise_robust_3d
   * in phase_2d/water_belt/detect_water_belt_3d.py:
   * - Grids 3D volume into 16x16x32 cuboid tiles (subsampled uniformly up to maxPatches=4096).
   * - Fits and subtracts a 3D linear hyperplane I(z, y, x) ~ c0*z + c1*y + c2*x + c3 per tile.
   * - Computes local tile MAD = 1.4826 * median(|res - median(res)|).
   * - Returns targetPercentile (default 15th) across all tile MADs.
   */
  function estimateNoiseRobust3D(spectraObj, patchShape, targetPercentile, maxPatches) {
    const { spectra, shape } = spectraObj;
    const ni1 = shape[1]; // loops (y in file layout)
    const ni2 = shape[2]; // planes (z in file layout)
    const nd = shape[3];  // direct (x in file layout)
    const channels = shape[4] || 2;

    const pShape = patchShape || [16, 16, 32];
    const pct = targetPercentile != null ? targetPercentile : 15.0;
    const maxP = maxPatches != null ? maxPatches : 4096;

    const pz = Math.min(pShape[0], ni2);
    const py = Math.min(pShape[1], ni1);
    const px = Math.min(pShape[2], nd);
    const numPts = pz * py * px;
    if (numPts <= 0) return 1e-4;

    // Orthogonal centered grid coordinates: A^T A = diag(sumZ2, sumY2, sumX2, numPts)
    const zMean = (pz - 1) / 2.0;
    const yMean = (py - 1) / 2.0;
    const xMean = (px - 1) / 2.0;
    const zFlat = new Float64Array(numPts);
    const yFlat = new Float64Array(numPts);
    const xFlat = new Float64Array(numPts);
    let sumZ2 = 0.0;
    let sumY2 = 0.0;
    let sumX2 = 0.0;
    let ptr = 0;

    for (let dz = 0; dz < pz; dz += 1) {
      const zv = dz - zMean;
      for (let dy = 0; dy < py; dy += 1) {
        const yv = dy - yMean;
        for (let dx = 0; dx < px; dx += 1) {
          const xv = dx - xMean;
          zFlat[ptr] = zv;
          yFlat[ptr] = yv;
          xFlat[ptr] = xv;
          sumZ2 += zv * zv;
          sumY2 += yv * yv;
          sumX2 += xv * xv;
          ptr += 1;
        }
      }
    }

    const nzTiles = Math.max(1, Math.floor((ni2 - pz) / pz) + 1);
    const nyTiles = Math.max(1, Math.floor((ni1 - py) / py) + 1);
    const nxTiles = Math.max(1, Math.floor((nd - px) / px) + 1);
    const totalAvail = nzTiles * nyTiles * nxTiles;

    let stepFactor = 1;
    if (totalAvail > maxP) {
      stepFactor = Math.ceil(Math.pow(totalAvail / maxP, 1.0 / 3.0));
    }

    const strideZ = Math.max(pz, pz * stepFactor);
    const strideY = Math.max(py, py * stepFactor);
    const strideX = Math.max(px, px * stepFactor);

    const mads = [];
    const tile = new Float64Array(numPts);
    const residuals = new Float64Array(numPts);
    const scratch = new Float64Array(numPts);

    for (let z0 = 0; z0 <= ni2 - pz; z0 += strideZ) {
      for (let y0 = 0; y0 <= ni1 - py; y0 += strideY) {
        for (let x0 = 0; x0 <= nd - px; x0 += strideX) {
          let k = 0;
          let sumV = 0.0;
          let dotZ = 0.0;
          let dotY = 0.0;
          let dotX = 0.0;

          for (let dz = 0; dz < pz; dz += 1) {
            const i2 = z0 + dz;
            for (let dy = 0; dy < py; dy += 1) {
              const i1 = y0 + dy;
              const rowBase = ((i1 * ni2 + i2) * nd + x0) * channels;
              for (let dx = 0; dx < px; dx += 1) {
                const v = spectra[rowBase + dx * channels]; // Real channel
                tile[k] = v;
                sumV += v;
                dotZ += zFlat[k] * v;
                dotY += yFlat[k] * v;
                dotX += xFlat[k] * v;
                k += 1;
              }
            }
          }

          const c0 = sumZ2 > 0.0 ? (dotZ / sumZ2) : 0.0;
          const c1 = sumY2 > 0.0 ? (dotY / sumY2) : 0.0;
          const c2 = sumX2 > 0.0 ? (dotX / sumX2) : 0.0;
          const c3 = sumV / numPts;

          for (let i = 0; i < numPts; i += 1) {
            const res = tile[i] - (c0 * zFlat[i] + c1 * yFlat[i] + c2 * xFlat[i] + c3);
            residuals[i] = res;
            scratch[i] = res;
          }
          const med = medianInPlace(scratch, numPts);
          for (let i = 0; i < numPts; i += 1) {
            scratch[i] = Math.abs(residuals[i] - med);
          }
          mads.push(1.4826 * medianInPlace(scratch, numPts));
        }
      }
    }

    if (mads.length === 0) return 1e-4;
    const sorted = Float64Array.from(mads);
    sorted.sort();
    return percentileLinear(sorted, pct) || 1e-4;
  }

  /**
   * Detects, quantifies, and classifies 3D water belt / water wall artifacts along
   * the direct 1H axis, matching phase_2d/water_belt/detect_water_belt_3d.py and test_water_belt_3d.py.
   */
  function detectWaterBelt3D(spectraObj, directAxisOrPpm, options) {
    const opts = options || {};
    const { spectra, shape } = spectraObj;
    const ni1 = shape[1];
    const ni2 = shape[2];
    const nd = shape[3];
    const channels = shape[4] || 2;
    const planePts = ni1 * ni2;

    const waterWin = opts.waterWindowPpm || DEFAULTS.waterWindowPpm;
    const wMin = Math.min(waterWin[0], waterWin[1]);
    const wMax = Math.max(waterWin[0], waterWin[1]);
    const targetPct = opts.waterNoisePercentile != null ? opts.waterNoisePercentile : 15.0;

    let ppmScale = null;
    let isProton = true;
    const axisSource = directAxisOrPpm || (spectraObj.meta && spectraObj.meta.directAxis) || null;
    if (axisSource) {
      if (ArrayBuffer.isView(axisSource) || Array.isArray(axisSource)) {
        ppmScale = axisSource;
      } else if (axisSource.ppmScale) {
        ppmScale = axisSource.ppmScale;
        if (axisSource.isProton === false) {
          isProton = false;
        }
      }
    }

    if (!ppmScale || ppmScale.length !== nd) {
      return {
        status: "no_ppm",
        hasWaterBelt: false,
        classification: "No PPM Scale",
        waterIndex: null,
        waterPpm: null,
      };
    }

    const ppmRange = [ppmScale[0], ppmScale[nd - 1]];

    if (!isProton) {
      return {
        status: "not_1h",
        hasWaterBelt: false,
        classification: "Not 1H Direct Axis",
        waterIndex: null,
        waterPpm: null,
        ppmRange,
      };
    }

    const wIndices = [];
    for (let c = 0; c < nd; c += 1) {
      const p = ppmScale[c];
      if (p >= wMin && p <= wMax) {
        wIndices.push(c);
      }
    }

    if (wIndices.length === 0) {
      return {
        status: "out_of_range",
        hasWaterBelt: false,
        classification: "Window Not In Spectrum",
        waterIndex: null,
        waterPpm: null,
        ppmRange,
      };
    }

    const sigmaRobust = estimateNoiseRobust3D(spectraObj, [16, 16, 32], targetPct, 4096);
    const baselineMedian = 0.6745 * sigmaRobust;
    const maxAbsScale = (spectraObj.maxAbs || (spectraObj.meta && spectraObj.meta.maxAbs) || 1.0);

    // Find candidate 2D water plane with maximum standard deviation within [4.60, 4.85] ppm
    let bestW = wIndices[0];
    let bestStd = -1.0;
    for (let idx = 0; idx < wIndices.length; idx += 1) {
      const c = wIndices[idx];
      let mean = 0.0;
      for (let i1 = 0; i1 < ni1; i1 += 1) {
        const base1 = i1 * ni2;
        for (let i2 = 0; i2 < ni2; i2 += 1) {
          mean += spectra[((base1 + i2) * nd + c) * channels];
        }
      }
      mean /= planePts;

      let varSum = 0.0;
      for (let i1 = 0; i1 < ni1; i1 += 1) {
        const base1 = i1 * ni2;
        for (let i2 = 0; i2 < ni2; i2 += 1) {
          const diff = spectra[((base1 + i2) * nd + c) * channels] - mean;
          varSum += diff * diff;
        }
      }
      const std = Math.sqrt(varSum / planePts);
      if (std > bestStd) {
        bestStd = std;
        bestW = c;
      }
    }

    const waterPlane = new Float64Array(planePts);
    const scratch = new Float64Array(planePts);
    let ptr = 0;
    for (let i1 = 0; i1 < ni1; i1 += 1) {
      const base1 = i1 * ni2;
      for (let i2 = 0; i2 < ni2; i2 += 1) {
        const v = spectra[((base1 + i2) * nd + bestW) * channels];
        waterPlane[ptr] = v;
        scratch[ptr] = v;
        ptr += 1;
      }
    }

    const planeMedRaw = medianInPlace(scratch, planePts);
    let count3s = 0;
    let count5s = 0;
    const thresh3s = 3.0 * sigmaRobust;
    const thresh5s = 5.0 * sigmaRobust;
    let maxDetrended = 0.0;

    for (let i = 0; i < planePts; i += 1) {
      const det = Math.abs(waterPlane[i] - planeMedRaw);
      scratch[i] = det;
      if (det > maxDetrended) maxDetrended = det;
      if (det > thresh3s) count3s += 1;
      if (det > thresh5s) count5s += 1;
    }

    const planeMed = medianInPlace(scratch, planePts);
    const medRatio = baselineMedian > 0.0 ? (planeMed / baselineMedian) : 0.0;
    const occ3s = (count3s / planePts) * 100.0;
    const occ5s = (count5s / planePts) * 100.0;
    const planeStdRatio = sigmaRobust > 0.0 ? (bestStd / sigmaRobust) : 0.0;
    const planeMaxRatio = sigmaRobust > 0.0 ? (maxDetrended / sigmaRobust) : 0.0;

    let classification = "No Water Belt";
    let hasWaterBelt = false;
    if (medRatio >= 10.0 && occ5s >= 80.0) {
      classification = "Strong Water Belt";
      hasWaterBelt = true;
    } else if (medRatio >= 3.0 && occ5s >= 25.0) {
      classification = "Moderate Water Belt";
      hasWaterBelt = true;
    }

    return {
      status: "success",
      hasWaterBelt,
      classification,
      waterIndex: bestW,
      waterPpm: ppmScale[bestW],
      sigmaRobust,
      sigmaRobustRaw: sigmaRobust * maxAbsScale,
      baselineMedian,
      planeMedian: planeMed,
      medRatio,
      planeStdRatio,
      planeMaxRatio,
      occ3s,
      occ5s,
      ppmRange,
    };
  }

  /**
   * Computes distance in data points from nearest edge of direct window [patchStart, patchStart + patchLen)
   * to waterCenterIdx (0 if waterCenterIdx lies inside the window).
   * Matches patch_touches_water(..., mode='edge_distance') in phase_2d/water_belt/patch_water_filter.py.
   */
  function getPatchWaterEdgeDistance(patchStart, patchLen, waterCenterIdx) {
    const patchEnd = patchStart + patchLen;
    if (patchStart <= waterCenterIdx && waterCenterIdx < patchEnd) {
      return 0;
    }
    if (patchStart > waterCenterIdx) {
      return patchStart - waterCenterIdx;
    }
    return waterCenterIdx - (patchEnd - 1);
  }

  function patchTouchesWaterEdge(patchStart, patchLen, waterCenterIdx, minEdgeDistance) {
    const minDist = minEdgeDistance != null ? minEdgeDistance : DEFAULTS.minWaterEdgeDist;
    return getPatchWaterEdgeDistance(patchStart, patchLen, waterCenterIdx) < minDist;
  }

  // =========================================================================
  // 3. 3D Noise Estimation & Signal-Only Cube Extraction (Model 04)
  // =========================================================================

  /**
   * Estimates 3D noise level using 16x16x64 subcubes (15th percentile RMSD).
   */
  function estimate3DNoiseLevel(spectraObj) {
    const { spectra, shape } = spectraObj;
    const ni1 = shape[1];
    const ni2 = shape[2];
    const nd = shape[3];

    const rmsdList = [];
    const stepR1 = Math.max(16, Math.floor(ni1 / 8));
    const stepR2 = Math.max(16, Math.floor(ni2 / 8));

    for (let r1 = 0; r1 <= ni1 - 16; r1 += stepR1) {
      for (let r2 = 0; r2 <= ni2 - 16; r2 += stepR2) {
        for (let c = 0; c <= nd - 64; c += 64) {
          let sumSq = 0.0;
          const count = 16 * 16 * 64;
          for (let dr1 = 0; dr1 < 16; dr1++) {
            for (let dr2 = 0; dr2 < 16; dr2++) {
              for (let dc = 0; dc < 64; dc++) {
                const idx = spectraIndex(shape, 0, r1 + dr1, r2 + dr2, c + dc, 0);
                const rr = spectra[idx];
                const ri = spectra[idx + 1];
                sumSq += rr * rr + ri * ri;
              }
            }
          }
          rmsdList.push(Math.sqrt(sumSq / count));
        }
      }
    }

    if (rmsdList.length === 0) {
      // Fallback: overall RMSD across whole volume
      let totalSq = 0.0;
      const totalCount = ni1 * ni2 * nd;
      for (let i = 0; i < spectra.length; i += 2) {
        const rr = spectra[i];
        const ri = spectra[i + 1];
        totalSq += rr * rr + ri * ri;
      }
      return Math.sqrt(totalSq / Math.max(totalCount, 1));
    }

    rmsdList.sort((a, b) => a - b);
    const p15Idx = Math.floor(0.15 * (rmsdList.length - 1));
    return rmsdList[p15Idx] || 1e-4;
  }

  /**
   * Extracts Signal-Only 16x16x128 cubes for Model 04.
   * Slides a 128-pt direct window advancing by `stride` points (default: 32).
   * Dynamically skips direct windows whose edge is within `minWaterEdgeDist` (default: 32)
   * data points of the detected water belt center when a water belt exists.
   * Identifies candidate signal peaks on the central 64-point core projection score map.
   * If total signal tokens < 2, gracefully relaxes cutoff to capture top spectral features.
   */
  function extractSignalTokensModel04(spectraObj, cfg) {
    const opts = cfg || {};
    const { spectra, shape } = spectraObj;
    const ni1 = shape[1];
    const ni2 = shape[2];
    const nd = shape[3];

    const stride = opts.stride || DEFAULTS.stride;
    const windowSize = opts.windowSize || DEFAULTS.windowSize;
    const topK = opts.topK || DEFAULTS.topK;
    const excludeWater = opts.excludeWater != null ? !!opts.excludeWater : DEFAULTS.excludeWater;
    const minWaterEdgeDist = opts.minWaterEdgeDist != null ? opts.minWaterEdgeDist : DEFAULTS.minWaterEdgeDist;
    const spilloverCheck = !!opts.spilloverCheck;
    const spilloverCutoff = opts.spilloverCutoff || DEFAULTS.spilloverCutoff;

    if (nd < windowSize) {
      throw new Error(`Direct dimension size (${nd}) is smaller than Model 04 window size (${windowSize}).`);
    }

    let waterBelt = opts.waterBelt || null;
    if (!waterBelt && excludeWater) {
      if (Number.isInteger(opts.waterCenterIdx)) {
        waterBelt = {
          status: "explicit",
          hasWaterBelt: true,
          classification: "Explicit Water Center",
          waterIndex: opts.waterCenterIdx,
          waterPpm: null,
        };
      } else {
        waterBelt = detectWaterBelt3D(
          spectraObj,
          opts.ppmScale || opts.directAxis || (spectraObj.meta && spectraObj.meta.directAxis),
          opts
        );
      }
    }

    const shouldExcludeWater = !!(
      excludeWater &&
      waterBelt &&
      waterBelt.hasWaterBelt &&
      Number.isInteger(waterBelt.waterIndex)
    );

    const noiseLevel = estimate3DNoiseLevel(spectraObj);
    let peakSnrCutoff = opts.peakSnrCutoff || DEFAULTS.peakSnrCutoff;
    let peakCutoff = peakSnrCutoff * noiseLevel;

    const windowStarts = [];
    for (let s = 0; s <= nd - windowSize; s += stride) {
      windowStarts.push(s);
    }
    if (windowStarts.length === 0) {
      windowStarts.push(0);
    }

    function scanTokensWithCutoff(currentCutoff, applyWaterExclusion) {
      const tokens = [];
      const details = [];
      const excludedWindows = [];

      for (let wIdx = 0; wIdx < windowStarts.length; wIdx++) {
        const startF3 = windowStarts[wIdx];
        const endF3 = startF3 + windowSize;

        if (
          applyWaterExclusion &&
          patchTouchesWaterEdge(startF3, windowSize, waterBelt.waterIndex, minWaterEdgeDist)
        ) {
          excludedWindows.push(wIdx + 1);
          continue;
        }

        const coreStartF3 = startF3 + 32;
        const coreEndF3 = startF3 + 96;

        // 2D projection score map across core direct points
        const scoreMap2D = new Float32Array(ni1 * ni2);
        for (let r1 = 0; r1 < ni1; r1++) {
          for (let r2 = 0; r2 < ni2; r2++) {
            let maxMag = 0.0;
            for (let c = coreStartF3; c < coreEndF3; c++) {
              const idx = spectraIndex(shape, 0, r1, r2, c, 0);
              const rr = spectra[idx];
              const ri = spectra[idx + 1];
              const mag = Math.hypot(rr, ri);
              if (mag > maxMag) maxMag = mag;
            }
            scoreMap2D[r1 * ni2 + r2] = maxMag;
          }
        }

        // Local maxima above currentCutoff
        const candidatePeaks = [];
        for (let r1 = 1; r1 < ni1 - 1; r1++) {
          for (let r2 = 1; r2 < ni2 - 1; r2++) {
            const v = scoreMap2D[r1 * ni2 + r2];
            if (v < currentCutoff) continue;
            if (
              v >= scoreMap2D[(r1 - 1) * ni2 + r2] &&
              v >= scoreMap2D[(r1 + 1) * ni2 + r2] &&
              v >= scoreMap2D[r1 * ni2 + (r2 - 1)] &&
              v >= scoreMap2D[r1 * ni2 + (r2 + 1)]
            ) {
              candidatePeaks.push({ val: v, r1, r2 });
            }
          }
        }

        candidatePeaks.sort((a, b) => b.val - a.val);

        const selectedCandidates = [];
        for (const cand of candidatePeaks) {
          const candS1 = Math.max(0, Math.min(ni1 - 16, cand.r1 - 8));
          const candE1 = candS1 + 16;
          const candS2 = Math.max(0, Math.min(ni2 - 16, cand.r2 - 8));
          const candE2 = candS2 + 16;

          // Non-overlapping check in (F1, F2) for this direct window
          let overlaps = false;
          for (const sel of selectedCandidates) {
            const ovF1 = Math.max(candS1, sel.s1) < Math.min(candE1, sel.e1);
            const ovF2 = Math.max(candS2, sel.s2) < Math.min(candE2, sel.e2);
            if (ovF1 && ovF2) {
              overlaps = true;
              break;
            }
          }
          if (overlaps) continue;

          // Optional margin spillover exclusion
          if (spilloverCheck) {
            let maxCentral = 0.0;
            let maxMargin = 0.0;
            for (let dr1 = 0; dr1 < 16; dr1++) {
              for (let dr2 = 0; dr2 < 16; dr2++) {
                const isCore = (dr1 >= 4 && dr1 < 12 && dr2 >= 4 && dr2 < 12);
                for (let c = startF3; c < endF3; c++) {
                  const idx = spectraIndex(shape, 0, candS1 + dr1, candS2 + dr2, c, 0);
                  const mag = Math.hypot(spectra[idx], spectra[idx + 1]);
                  const isCentralCore = isCore && (c >= coreStartF3 && c < coreEndF3);
                  if (isCentralCore) {
                    if (mag > maxCentral) maxCentral = mag;
                  } else {
                    if (mag > maxMargin) maxMargin = mag;
                  }
                }
              }
            }
            if (maxMargin > spilloverCutoff * maxCentral) {
              continue;
            }
          }

          const rankIdx = selectedCandidates.length + 1;
          selectedCandidates.push({
            val: cand.val,
            r1: cand.r1,
            r2: cand.r2,
            rankIdx,
            s1: candS1,
            e1: candE1,
            s2: candS2,
            e2: candE2
          });
          if (selectedCandidates.length >= topK) break;
        }

        // SIGNAL ONLY: Only extract cubes when candidate peaks exist
        for (const sel of selectedCandidates) {
          const cube = new Float32Array(16 * 16 * 128 * 2);
          let cubeMax = 1e-8;
          let cubePtr = 0;

          for (let dr1 = 0; dr1 < 16; dr1++) {
            for (let dr2 = 0; dr2 < 16; dr2++) {
              for (let c = startF3; c < endF3; c++) {
                const idx = spectraIndex(shape, 0, sel.s1 + dr1, sel.s2 + dr2, c, 0);
                const rr = spectra[idx];
                const ri = spectra[idx + 1];
                cube[cubePtr++] = rr;
                cube[cubePtr++] = ri;
                const mag = Math.hypot(rr, ri);
                if (mag > cubeMax) cubeMax = mag;
              }
            }
          }

          // Individual cube max-magnitude normalization
          const normFactor = 1.0 / cubeMax;
          for (let i = 0; i < cube.length; i++) {
            cube[i] *= normFactor;
          }

          tokens.push(cube);
          details.push({
            tokenIdx: tokens.length,
            windowIdx: wIdx + 1,
            cubeRank: sel.rankIdx,
            isSignal: 1,
            directRange: `${startF3}..${endF3 - 1}`,
            directCenterF3: (startF3 + endF3) / 2.0,
            s1: sel.s1,
            s2: sel.s2,
            maxMag: sel.val,
            peakVal: sel.val,
          });
        }
      }
      return { tokens, details, excludedWindows };
    }

    let scanResult = scanTokensWithCutoff(peakCutoff, shouldExcludeWater);

    // Safety fallback: first relax SNR cutoff while keeping water exclusion active
    if (scanResult.tokens.length < 2) {
      const relaxedCutoff = 3.0 * noiseLevel;
      console.log(`[tfjs] Found ${scanResult.tokens.length} signal tokens at SNR ${peakSnrCutoff}. Relaxing cutoff to SNR 3.0...`);
      scanResult = scanTokensWithCutoff(relaxedCutoff, shouldExcludeWater);
    }

    // Only if < 2 tokens exist outside water guard band, retry without water exclusion
    if (scanResult.tokens.length < 2 && shouldExcludeWater) {
      const relaxedCutoff = 3.0 * noiseLevel;
      console.log(`[tfjs] Found ${scanResult.tokens.length} signal tokens outside water guard band. Retrying without water exclusion...`);
      scanResult = scanTokensWithCutoff(relaxedCutoff, false);
    }

    // Absolute fallback: take global top 2 peaks across direct spectrum if still < 2
    if (scanResult.tokens.length < 2) {
      console.log(`[tfjs] Relaxed search yielded ${scanResult.tokens.length} tokens. Extracting global peak fallback...`);
      scanResult = scanTokensWithCutoff(0.0, false);
      if (scanResult.tokens.length > 2) {
        scanResult.tokens = scanResult.tokens.slice(0, 2);
        scanResult.details = scanResult.details.slice(0, 2);
      }
    }

    const numTokens = scanResult.tokens.length;
    const flatCubes = new Float32Array(numTokens * 16 * 16 * 128 * 2);
    for (let k = 0; k < numTokens; k++) {
      flatCubes.set(scanResult.tokens[k], k * 16 * 16 * 128 * 2);
    }

    return {
      cubes: flatCubes,
      cubesShape: [numTokens, 16, 16, 128, 2],
      tokenDetails: scanResult.details,
      noiseLevel: noiseLevel,
      numTokens: numTokens,
      waterBelt: waterBelt,
      excludedWindows: scanResult.excludedWindows,
    };
  }

  // =========================================================================
  // 4. Revised Weighted RANSAC (W-RANSAC) with n*pi Phase Adjustment
  // =========================================================================

  /**
   * Revised Weighted RANSAC linear phase fitting accommodating negative peaks
   * (odd n*pi phase flip) and phase gradient wrapping (|P1| > 2*pi).
   * Fits phase line: phi(x_norm) = p0 + p1 * x_norm
   * where x_norm in [-1, +1] is normalized direct coordinate.
   */
  function weightedRansacFit(xCoords, yPhasesDeg, weights, options) {
    const opts = options || {};
    const cutoffDeg = opts.cutoffDeg != null ? opts.cutoffDeg : DEFAULTS.ransacCutoffDeg;
    const nIter = opts.nIter != null ? opts.nIter : DEFAULTS.ransacIter;
    const nPiMax = opts.nPiMax != null ? opts.nPiMax : DEFAULTS.ransacNPiMax;
    const maxP1 = opts.maxP1 != null ? opts.maxP1 : 1440.0;

    const N = xCoords.length;
    if (N < 2) {
      const p0 = N === 1 ? yPhasesDeg[0] : 0.0;
      return {
        p0: p0,
        p1: 0.0,
        inliersMask: new Array(N).fill(true),
        weightRatio: 1.0,
        numInliers: N,
        bestN: new Int32Array(N),
        yAdj: yPhasesDeg.slice(0),
      };
    }

    let totalWeightAll = 0.0;
    for (let i = 0; i < N; i++) totalWeightAll += weights[i];
    const samplingProbs = new Float64Array(N);
    for (let i = 0; i < N; i++) {
      samplingProbs[i] = totalWeightAll > 0 ? (weights[i] / totalWeightAll) : (1.0 / N);
    }

    const cumProbs = new Float64Array(N);
    let cum = 0.0;
    for (let i = 0; i < N; i++) {
      cum += samplingProbs[i];
      cumProbs[i] = cum;
    }
    cumProbs[N - 1] = 1.0;

    function sampleIndex() {
      const r = Math.random();
      for (let i = 0; i < N; i++) {
        if (r <= cumProbs[i]) return i;
      }
      return N - 1;
    }

    const numNChoices = 2 * nPiMax + 1;
    const nChoices = new Int32Array(numNChoices);
    const nOffsets = new Float64Array(numNChoices);
    for (let k = 0; k < numNChoices; k++) {
      const n = k - nPiMax;
      nChoices[k] = n;
      nOffsets[k] = n * 180.0;
    }
    const maxDeltaN = 2 * nPiMax;

    let bestScore = -1.0;
    let bestInlierMask = new Array(N).fill(false);
    let bestCandP0 = 0.0;
    let bestCandP1 = 0.0;
    let bestNPerToken = new Int32Array(N);

    for (let iter = 0; iter < nIter; iter++) {
      const i = sampleIndex();
      let j = sampleIndex();
      let attempts = 0;
      while (i === j && attempts < 10) {
        j = sampleIndex();
        attempts++;
      }
      if (i === j) continue;

      const dx = xCoords[j] - xCoords[i];
      if (Math.abs(dx) < 1e-5) continue;

      const diffRad = (yPhasesDeg[j] - yPhasesDeg[i]) * Math.PI / 180.0;
      const dphiBase = Math.atan2(Math.sin(diffRad), Math.cos(diffRad)) * 180.0 / Math.PI;

      for (let deltaN = -maxDeltaN; deltaN <= maxDeltaN; deltaN++) {
        const candP1 = (dphiBase + deltaN * 180.0) / dx;
        if (Math.abs(candP1) > maxP1) continue;

        let rawP0 = yPhasesDeg[i] - candP1 * xCoords[i];
        let candP0 = ((rawP0 + 180.0) % 360.0);
        if (candP0 < 0) candP0 += 360.0;
        candP0 -= 180.0;

        let candScore = 0.0;
        const curInliers = new Array(N).fill(false);
        const curNPerToken = new Int32Array(N);

        for (let t = 0; t < N; t++) {
          const yCand = candP0 + candP1 * xCoords[t];
          let minRes = 1e9;
          let bestNForT = 0;
          for (let k = 0; k < numNChoices; k++) {
            const res = Math.abs((yPhasesDeg[t] + nOffsets[k]) - yCand);
            if (res < minRes) {
              minRes = res;
              bestNForT = nChoices[k];
            }
          }
          if (minRes <= cutoffDeg) {
            curInliers[t] = true;
            candScore += weights[t];
          }
          curNPerToken[t] = bestNForT;
        }

        if (candScore > bestScore) {
          bestScore = candScore;
          bestInlierMask = curInliers;
          bestCandP0 = candP0;
          bestCandP1 = candP1;
          bestNPerToken.set(curNPerToken);
        }
      }
    }

    // Resolve global parity: orient phase so the weighted majority of inliers are positive absorptive peaks
    const inlierIndices = [];
    for (let i = 0; i < N; i++) {
      if (bestInlierMask[i]) inlierIndices.push(i);
    }
    const numInliers = inlierIndices.length;

    if (numInliers >= 1) {
      let wOdd = 0.0;
      let wEven = 0.0;
      for (const idx of inlierIndices) {
        const n = bestNPerToken[idx];
        const w = weights[idx];
        if (Math.abs(n) % 2 !== 0) wOdd += w;
        else wEven += w;
      }

      if (wOdd > wEven) {
        const p0Shift = bestCandP0 > 0 ? -180.0 : 180.0;
        bestCandP0 += p0Shift;
        const deltaNShift = p0Shift < 0 ? -1 : 1;
        for (let i = 0; i < N; i++) {
          bestNPerToken[i] += deltaNShift;
        }
      }
    }

    // Refine P0 and P1 using Weighted Least Squares (WLS) on consensus inliers
    let p0Fit = 0.0;
    let p1Fit = 0.0;

    if (numInliers >= 2) {
      let sumW = 0.0;
      let sumWx = 0.0;
      let sumWy = 0.0;
      let sumWxx = 0.0;
      let sumWxy = 0.0;

      for (const idx of inlierIndices) {
        const w = weights[idx];
        const x = xCoords[idx];
        const yUnwrapped = yPhasesDeg[idx] + bestNPerToken[idx] * 180.0;
        sumW += w;
        sumWx += w * x;
        sumWy += w * yUnwrapped;
        sumWxx += w * x * x;
        sumWxy += w * x * yUnwrapped;
      }

      const denom = sumW * sumWxx - sumWx * sumWx;
      if (Math.abs(denom) > 1e-12) {
        p1Fit = (sumW * sumWxy - sumWx * sumWy) / denom;
        p0Fit = (sumWy - p1Fit * sumWx) / sumW;
      } else {
        p0Fit = sumWy / sumW;
        p1Fit = 0.0;
      }
    } else if (numInliers === 1) {
      const idx = inlierIndices[0];
      p0Fit = yPhasesDeg[idx] + bestNPerToken[idx] * 180.0;
      p1Fit = 0.0;
    } else {
      p0Fit = 0.0;
      p1Fit = 0.0;
    }

    let finalP0 = ((p0Fit + 180.0) % 360.0);
    if (finalP0 < 0) finalP0 += 360.0;
    finalP0 -= 180.0;

    const weightRatio = totalWeightAll > 0 ? (bestScore / totalWeightAll) : 0.0;
    const yAdj = new Float64Array(N);
    for (let i = 0; i < N; i++) {
      yAdj[i] = yPhasesDeg[i] + bestNPerToken[i] * 180.0;
    }

    return {
      p0: finalP0,
      p1: p1Fit,
      inliersMask: bestInlierMask,
      weightRatio: weightRatio,
      numInliers: numInliers,
      bestN: bestNPerToken,
      yAdj: yAdj
    };
  }

  // =========================================================================
  // 5. Spectrum Phase Application & Combination
  // =========================================================================

  /**
   * Applies left/right linear phase correction to spectra volume [bsz, ni1, ni2, nd, 2].
   */
  function applyLeftRightToSpectra(spectraObj, leftRight) {
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

  function addLeftRightArrays(a, b) {
    const bsz = a.length;
    const out = new Array(bsz);
    for (let i = 0; i < bsz; i += 1) {
      out[i] = [a[i][0] + b[i][0], a[i][1] + b[i][1]];
    }
    return out;
  }

  // =========================================================================
  // 6. Model 04 Forward Execution & 2-Round Pipeline
  // =========================================================================

  async function loadModel(tf, modelUrl) {
    const tfi = ensureTf(tf);
    const url = modelUrl || DEFAULTS.modelUrl;
    try {
      return await tfi.loadGraphModel(url);
    } catch (err) {
      const errMsg = (err && err.message) ? err.message : String(err);
      if (/shader|compile|link|webgl|out of memory|context lost|gl/i.test(errMsg) && tfi.getBackend && tfi.getBackend() !== "cpu") {
        console.warn(`[tfjs] Failed to load model on WebGL (${errMsg}). Switching to CPU backend...`);
        logToHtml(`[tfjs] WebGL initialization failed. Switching to CPU backend...`);
        await tfi.setBackend("cpu");
        if (typeof tfi.ready === "function") {
          await tfi.ready();
        }
        return await tfi.loadGraphModel(url);
      }
      throw err;
    }
  }

  /**
   * Runs Model 04 forward pass on extracted cubes with sub-batching and automatic CPU fallback.
   * Input: [numTokens, 16, 16, 128, 2]
   * Output: [numTokens, 2] -> [phi_pred_deg, std_pred_deg]
   */
  async function runModel04OnCubes(tf, model, ext) {
    const numTokens = ext.numTokens;
    if (numTokens === 0) {
      return { phiPredDeg: [], stdPredDeg: [], weights: [] };
    }

    const singleCubeFloats = 16 * 16 * 128 * 2;
    const BATCH_SIZE = 4; // Sub-batching reduces peak WebGL texture allocations and register pressure

    async function executeBatch(cubesSlice, batchCount) {
      const tensor = tf.tensor(cubesSlice, [batchCount, 16, 16, 128, 2], "float32");
      let pred;
      try {
        if (typeof model.execute === "function") {
          pred = model.execute(tensor);
        } else {
          pred = model.predict(tensor);
        }
        if (Array.isArray(pred)) {
          pred = pred[0];
        }
        return await pred.array();
      } finally {
        tensor.dispose();
        if (pred && typeof pred.dispose === "function") {
          pred.dispose();
        }
      }
    }

    async function runInference() {
      const allPreds = [];
      for (let i = 0; i < numTokens; i += BATCH_SIZE) {
        const batchCount = Math.min(BATCH_SIZE, numTokens - i);
        const slice = ext.cubes.subarray(i * singleCubeFloats, (i + batchCount) * singleCubeFloats);
        const batchPreds = await executeBatch(slice, batchCount);
        for (let b = 0; b < batchCount; b++) {
          allPreds.push(batchPreds[b]);
        }
      }
      return allPreds;
    }

    let preds;
    try {
      preds = await runInference();
    } catch (err) {
      const errMsg = (err && err.message) ? err.message : String(err);
      const isShaderOrGpuError = /shader|compile|link|webgl|out of memory|context lost|gl/i.test(errMsg);
      if (isShaderOrGpuError && tf.getBackend && tf.getBackend() !== "cpu") {
        console.warn(`[tfjs] WebGL execution failed (${errMsg}). Falling back to CPU backend for Model 04...`);
        logToHtml(`[tfjs] WebGL shader compilation failed on GPU. Switching to CPU backend for Model 04 auto-phasing...`);
        await tf.setBackend("cpu");
        if (typeof tf.ready === "function") {
          await tf.ready();
        }
        preds = await runInference();
      } else {
        throw err;
      }
    }

    const phiPredDeg = new Float64Array(numTokens);
    const stdPredDeg = new Float64Array(numTokens);
    const weights = new Float64Array(numTokens);

    for (let k = 0; k < numTokens; k++) {
      phiPredDeg[k] = preds[k][0];
      stdPredDeg[k] = Math.max(preds[k][1], 0.1);
      weights[k] = 1.0 / (stdPredDeg[k] * stdPredDeg[k] + 1e-8);
    }

    return { phiPredDeg, stdPredDeg, weights };
  }

  function formatWaterBeltLog3D(waterBelt, minWaterEdgeDist) {
    if (!waterBelt) return null;
    if (waterBelt.status === "out_of_range" && waterBelt.ppmRange) {
      return `[tfjs][Water Belt] Water window (4.60–4.85 ppm) outside direct spectrum (${waterBelt.ppmRange[0].toFixed(2)} to ${waterBelt.ppmRange[1].toFixed(2)} ppm) — keeping all direct windows`;
    }
    if (waterBelt.status === "not_1h") {
      return `[tfjs][Water Belt] Direct axis is not 1H — keeping all direct windows`;
    }
    if (waterBelt.status === "no_ppm") {
      return `[tfjs][Water Belt] No direct chemical shift scale in header — keeping all direct windows`;
    }
    if (waterBelt.hasWaterBelt) {
      const ppmStr = waterBelt.waterPpm != null ? `${waterBelt.waterPpm.toFixed(3)} ppm, ` : "";
      const metricStr = waterBelt.medRatio != null
        ? ` | medRatio=${waterBelt.medRatio.toFixed(2)}x, occ5s=${waterBelt.occ5s.toFixed(1)}%`
        : "";
      return `[tfjs][Water Belt] ${waterBelt.classification} detected at plane index ${waterBelt.waterIndex} (${ppmStr}min edge clearance=${minWaterEdgeDist} pts${metricStr})`;
    }
    const ppmInfoStr = waterBelt.waterPpm != null
      ? ` (${waterBelt.waterPpm.toFixed(3)} ppm | medRatio=${waterBelt.medRatio.toFixed(2)}x, occ5s=${waterBelt.occ5s.toFixed(1)}%)`
      : "";
    return `[tfjs][Water Belt] No Water Belt detected${ppmInfoStr} — keeping all direct windows`;
  }

  /**
   * Main 2-Round 3D Model 04 Auto-Phase Execution.
   */
  async function runFromFt3(params) {
    const tf = ensureTf(params.tf);
    const ft3ArrayBuffer = params.ft3ArrayBuffer;
    if (!(ft3ArrayBuffer instanceof ArrayBuffer)) {
      throw new Error("runFromFt3 requires ft3ArrayBuffer as ArrayBuffer.");
    }

    let model = params.model;
    if (!model) {
      const url = params.modelUrl || DEFAULTS.modelUrl;
      console.log(`[tfjs] Loading 3D Model 04 from ${url}...`);
      model = await loadModel(tf, url);
    }

    const exp = loadExperimentFromFt3ArrayBuffer(ft3ArrayBuffer, {
      flipRiSign: params.flipRiSign != null ? params.flipRiSign : DEFAULTS.flipRiSign,
    });

    const spectraWorking = {
      spectra: exp.spectra.slice(0),
      shape: exp.shape,
      meta: exp.meta,
      maxAbs: exp.maxAbs,
    };

    const nd = exp.shape[3];
    const xRef = nd / 2.0;
    const xScale = nd / 2.0;

    const cfg = {
      stride: params.stride || DEFAULTS.stride,
      windowSize: params.windowSize || DEFAULTS.windowSize,
      topK: params.topK || DEFAULTS.topK,
      peakSnrCutoff: params.peakSnrCutoff || DEFAULTS.peakSnrCutoff,
      excludeWater: params.excludeWater != null ? !!params.excludeWater : DEFAULTS.excludeWater,
      minWaterEdgeDist: params.minWaterEdgeDist != null ? params.minWaterEdgeDist : DEFAULTS.minWaterEdgeDist,
      waterWindowPpm: params.waterWindowPpm || DEFAULTS.waterWindowPpm,
      spilloverCheck: !!params.spilloverCheck,
      spilloverCutoff: params.spilloverCutoff || DEFAULTS.spilloverCutoff,
      ransacCutoffDeg: params.ransacCutoffDeg || DEFAULTS.ransacCutoffDeg,
      ransacIter: params.ransacIter || DEFAULTS.ransacIter,
      ransacNPiMax: params.ransacNPiMax || DEFAULTS.ransacNPiMax,
    };

    console.log(`[tfjs] Starting Model 04 3D Auto-Phase (Signal-Only, 2 Rounds)...`);
    logToHtml(`[tfjs] Starting Model 04 Auto-Phase (Signal-Only, 2 Rounds)...`);

    // Detect 3D water belt / water wall once on the loaded volume so window exclusion is consistent across rounds
    let waterBelt = null;
    if (cfg.excludeWater) {
      if (Number.isInteger(params.waterCenterIdx)) {
        waterBelt = {
          status: "explicit",
          hasWaterBelt: true,
          classification: "Explicit Water Center",
          waterIndex: params.waterCenterIdx,
          waterPpm: null,
        };
      } else {
        waterBelt = detectWaterBelt3D(
          spectraWorking,
          params.ppmScale || exp.meta.directAxis,
          cfg
        );
      }
      cfg.waterBelt = waterBelt;
      const wbMsg = formatWaterBeltLog3D(waterBelt, cfg.minWaterEdgeDist);
      if (wbMsg) {
        console.log(wbMsg);
        logToHtml(wbMsg);
      }
    }

    // =========================================================================
    // ROUND 1: Initial Spectrum Phasing
    // =========================================================================
    const ext1 = extractSignalTokensModel04(spectraWorking, cfg);
    const exclNote1 = (ext1.excludedWindows && ext1.excludedWindows.length > 0)
      ? `, Excluded ${ext1.excludedWindows.length} water-adjacent direct window(s)`
      : "";
    logToHtml(`[tfjs][Round 1] Extracted ${ext1.numTokens} signal cubes (Estimated Noise: ${ext1.noiseLevel.toExponential(2)}${exclNote1})`);

    const out1 = await runModel04OnCubes(tf, model, ext1);

    const xCoords1 = new Float64Array(ext1.numTokens);
    for (let k = 0; k < ext1.numTokens; k++) {
      xCoords1[k] = (ext1.tokenDetails[k].directCenterF3 - xRef) / xScale;
    }

    const fit1 = weightedRansacFit(xCoords1, out1.phiPredDeg, out1.weights, {
      cutoffDeg: cfg.ransacCutoffDeg,
      nIter: cfg.ransacIter,
      nPiMax: cfg.ransacNPiMax,
    });

    const left1 = fit1.p0 - fit1.p1;
    const right1 = fit1.p0 + fit1.p1;

    const round1Log = `[ANN Phase] Round 1 (Model 04) | Inliers: ${fit1.numInliers}/${ext1.numTokens} (${(fit1.weightRatio * 100).toFixed(1)}% wt) | P0: ${fit1.p0.toFixed(2)}°, P1: ${fit1.p1.toFixed(2)}° | Left: ${left1.toFixed(2)}°, Right: ${right1.toFixed(2)}°`;
    console.log(round1Log);
    logToHtml(round1Log);

    // Apply Round 1 phase correction (-left, -right) to working spectra
    applyLeftRightToSpectra(spectraWorking, [[-left1, -right1]]);

    // =========================================================================
    // ROUND 2: Residual Phase Fine-Tuning
    // =========================================================================
    const ext2 = extractSignalTokensModel04(spectraWorking, cfg);
    const exclNote2 = (ext2.excludedWindows && ext2.excludedWindows.length > 0)
      ? `, Excluded ${ext2.excludedWindows.length} water-adjacent direct window(s)`
      : "";
    logToHtml(`[tfjs][Round 2] Re-extracted ${ext2.numTokens} signal cubes for residual correction${exclNote2}`);

    const out2 = await runModel04OnCubes(tf, model, ext2);

    const xCoords2 = new Float64Array(ext2.numTokens);
    for (let k = 0; k < ext2.numTokens; k++) {
      xCoords2[k] = (ext2.tokenDetails[k].directCenterF3 - xRef) / xScale;
    }

    const fit2 = weightedRansacFit(xCoords2, out2.phiPredDeg, out2.weights, {
      cutoffDeg: cfg.ransacCutoffDeg,
      nIter: cfg.ransacIter,
      nPiMax: cfg.ransacNPiMax,
    });

    const left2 = fit2.p0 - fit2.p1;
    const right2 = fit2.p0 + fit2.p1;

    const round2Log = `[ANN Phase] Round 2 (Model 04) | Inliers: ${fit2.numInliers}/${ext2.numTokens} (${(fit2.weightRatio * 100).toFixed(1)}% wt) | Residual P0: ${fit2.p0.toFixed(2)}°, P1: ${fit2.p1.toFixed(2)}° | Left: ${left2.toFixed(2)}°, Right: ${right2.toFixed(2)}°`;
    console.log(round2Log);
    logToHtml(round2Log);

    // =========================================================================
    // TOTAL COMBINED (2 ROUNDS)
    // =========================================================================
    const finalLeft = left1 + left2;
    const finalRight = right1 + right2;
    const finalLeftRight = [[finalLeft, finalRight]];

    const combinedLog = `[ANN Phase] Total Combined (2 rounds) | Left: ${finalLeft.toFixed(2)}°, Right: ${finalRight.toFixed(2)}°`;
    console.log(combinedLog);
    logToHtml(combinedLog);

    return {
      ft3Meta: exp.meta,
      waterBelt: waterBelt,
      config: cfg,
      round1: {
        tokens: ext1.tokenDetails,
        excludedWindows: ext1.excludedWindows,
        fit: fit1,
        left: left1,
        right: right1,
      },
      round2: {
        tokens: ext2.tokenDetails,
        excludedWindows: ext2.excludedWindows,
        fit: fit2,
        left: left2,
        right: right2,
      },
      final_wls_phase_left_right: finalLeftRight,
    };
  }

  // =========================================================================
  // 7. Public API Export
  // =========================================================================

  const api = {
    defaults: Object.assign({}, DEFAULTS),
    configureTfEnvironment,
    parseFt3MetaFromArrayBuffer,
    extractDirectAxisInfoFt3,
    readFt3AllFromArrayBuffer,
    loadExperimentFromFt3ArrayBuffer,
    estimateNoiseRobust3D,
    detectWaterBelt3D,
    getPatchWaterEdgeDistance,
    patchTouchesWaterEdge,
    extractSignalTokensModel04,
    weightedRansacFit,
    runFromFt3,
    applyLeftRightToSpectra,
    addLeftRightArrays,
    loadModel,
    // Backward compatibility stubs
    registerCustomLayers: function () {},
    getCustomObjects: function () { return {}; },
    wlsLeftRightFromLocal: function () { return [[0.0, 0.0]]; },
  };

  globalScope.NUS3DPhasePipeline = api;
})(typeof window !== "undefined" ? window : globalThis);
