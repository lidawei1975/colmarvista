/*
 * Browser-first single-file pipeline for 2D Model 17 TensorFlow.js inference.
 *
 * Model 17: Phase-Equivariant 2D Complex Phase Predictor with Uncertainty Head.
 * Accepts input patches of shape [batch, 16, 128, 2] (Real, Imag channels)
 * and directly outputs [phi_pred_deg, std_pred_deg] in degrees.
 *
 * Pipeline Workflow (consistent with phase_2d/equivariance/model17/application_negative.py
 * and phase_2d/water_belt/test_water_belt_with_robust_noise.py):
 * 1) Parse NMRPipe FT2 ArrayBuffer with complex direct channel (z = rr - 1j * ri)
 *    and direct-dimension chemical shift scale (ppm).
 * 2) Detect residual water belt along direct 1H axis (4.60 - 4.85 ppm) using
 *    2D Planar-detrended Patch-MAD Distribution Quantile (PPDQ) robust noise floor.
 * 3) Estimate 2D noise level via 15th-percentile RMSD over 16x64 blocks.
 * 4) Segment direct dimension into 64-point tokens (skipping first & last boundary tokens),
 *    extracting up to Top 2 16x128 signal patches per token (20x / 8x noise cutoffs,
 *    |r - r1| >= 8 separation). If a water belt exists, dynamically exclude any patch
 *    whose edge is within 32 data points of the detected water belt center.
 * 5) Normalize each 16x128 patch individually by max(|z|) + 1e-8.
 * 6) Run Model 17 TF.js GraphModel forward pass with sub-batching and automatic
 *    WebGL-to-CPU fallback for integrated GPUs.
 * 7) Fit P0 and P1 linear phase using Revised Weighted RANSAC (W-RANSAC) with discrete
 *    n*pi (n*180 deg) adjustments for negative peaks and wrapped phase gradients.
 * 8) Run iteratively (default: 2 rounds in web environment) and accumulate total
 *    [left, right] phase correction.
 */

(function (globalScope) {
  "use strict";

  const HEADER_FLOAT_COUNT = 512;
  const HEADER_BYTES = HEADER_FLOAT_COUNT * 4;

  /**
   * Logs messages to HTML log helper if available.
   * @param {string} msg
   */
  function logToHtml(msg) {
    if (globalScope.append_2d_log) {
      globalScope.append_2d_log(msg);
    }
  }

  const IDX = {
    FDDIMORDER1: 24,    // 1-based dimension code stored in fast/direct file axis
    FDDIMORDER2: 25,    // 1-based dimension code stored in second file axis
    FDDIMORDER3: 26,
    FDDIMORDER4: 27,
    FDPLANE: 221,       // tp (transpose flag)
    FDSPECNUM: 219,     // n1 (indirect row count; 2*n_ind when hypercomplex)
    FDSIZE: 99,         // n2 (direct point count)
    FDF1QUADFLAG: 55,   // quad_flag_1 (0 = complex, 1 = real)
    FDF2QUADFLAG: 56,   // quad_flag_2 (0 = complex, 1 = real)
  };

  // Per-dimension NMRPipe header indices for FDF1, FDF2, FDF3, FDF4 (1-based dimCode -> index dimCode - 1)
  const DIM_SW_IDX = [229, 100, 11, 29];
  const DIM_ORIG_IDX = [249, 101, 12, 30];
  const DIM_OBS_IDX = [218, 119, 10, 28];
  const DIM_CAR_IDX = [67, 66, 68, 69];
  const DIM_LABEL_WORD = [18, 16, 20, 22];

  const DEFAULTS = {
    tokenWidth: 64,
    windowSize: 128,
    patchHeight: 16,
    topK: 2,
    peakSnrHigh: 20.0,
    peakSnrLow: 8.0,
    excludeWater: true,
    minWaterEdgeDist: 32,
    waterWindowPpm: [4.60, 4.85],
    useAll: false,
    isolatePeak: false,
    peakThresholdFactor: 5.5,
    feather: true,
    flipRiSign: true,
    numRounds: 2,
    ransacCutoffDeg: 5.0,
    ransacIter: 2000,
    ransacNPiMax: 4,
    ransacMaxP1: 1440.0,
    modelUrl: "js/model17_tfjs/model.json",
  };

  /**
   * Configures TensorFlow.js environment for reliable execution on integrated GPUs.
   * Disables WebGL texture packing and forced F16 textures so simpler unpacked GLSL
   * shaders are generated, avoiding fragment shader compilation failures on Intel UHD /
   * Iris Xe / AMD integrated GPUs.
   */
  function configureTfEnvironment(tfInstance) {
    const tf = tfInstance || globalScope.tf;
    if (!tf || !tf.env) return;
    try {
      tf.env().set("WEBGL_PACK", false);
      tf.env().set("WEBGL_FORCE_F16_TEXTURES", false);
    } catch (e) {
      console.warn("[tfjs] Could not configure WebGL flags:", e);
    }
  }

  // Pre-configure immediately if TensorFlow.js is already present
  if (globalScope.tf) {
    configureTfEnvironment(globalScope.tf);
  }

  /**
   * Ensures TensorFlow.js is available and configured.
   */
  function ensureTf(tfInstance) {
    const tf = tfInstance || globalScope.tf;
    if (!tf) {
      throw new Error("TensorFlow.js not found. Include @tensorflow/tfjs before this script.");
    }
    configureTfEnvironment(tf);
    return tf;
  }

  // =========================================================================
  // 1. NMRPipe FT2 Header, Direct PPM Scale & Binary Parser
  // =========================================================================

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
   * Extracts direct-dimension NMRPipe metadata and chemical shift scale (ppm),
   * matching nmrglue.pipe.make_uc(dic, data, dim=1).ppm_scale().
   */
  function extractDirectAxisInfoFt2(ft2ArrayBuffer, meta, nDirectArg) {
    if (!(ft2ArrayBuffer instanceof ArrayBuffer) || ft2ArrayBuffer.byteLength < HEADER_BYTES) {
      return null;
    }
    const header = new Float32Array(ft2ArrayBuffer, 0, HEADER_FLOAT_COUNT);
    const rawD1 = Math.round(header[IDX.FDDIMORDER1]);
    const rawD2 = Math.round(header[IDX.FDDIMORDER2]);
    const d1 = (rawD1 >= 1 && rawD1 <= 4) ? rawD1 : 2;
    const d2 = (rawD2 >= 1 && rawD2 <= 4) ? rawD2 : 1;
    const tp = meta && meta.tp != null ? meta.tp : Math.round(header[IDX.FDPLANE]);
    const directDimCode = tp === 1 ? d2 : d1;
    let nDirect = nDirectArg;
    if (!(nDirect > 0)) {
      if (tp === 1) {
        const rawN1 = meta && meta.n1 != null ? meta.n1 : Math.round(header[IDX.FDSPECNUM]);
        const q1 = meta && meta.quadFlag1 != null ? meta.quadFlag1 : header[IDX.FDF1QUADFLAG];
        const q2 = meta && meta.quadFlag2 != null ? meta.quadFlag2 : header[IDX.FDF2QUADFLAG];
        nDirect = (q1 === 0.0 && q2 === 0.0) ? Math.floor(rawN1 / 2) : rawN1;
      } else {
        nDirect = meta && meta.n2 != null ? meta.n2 : Math.round(header[IDX.FDSIZE]);
      }
    }
    const idx = directDimCode - 1;

    const sw = header[DIM_SW_IDX[idx]];
    const orig = header[DIM_ORIG_IDX[idx]];
    const obs = header[DIM_OBS_IDX[idx]];
    const car = header[DIM_CAR_IDX[idx]];
    const label = readAsciiLabel(ft2ArrayBuffer, DIM_LABEL_WORD[idx]);

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

  function parseFt2MetaFromArrayBuffer(ft2ArrayBuffer) {
    if (!(ft2ArrayBuffer instanceof ArrayBuffer)) {
      throw new Error("ft2ArrayBuffer must be an ArrayBuffer");
    }
    if (ft2ArrayBuffer.byteLength < HEADER_BYTES) {
      throw new Error("FT2 bytes too small for 2048-byte header: " + ft2ArrayBuffer.byteLength);
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
      directIsComplex: quadFlag2 === 0.0,
      indirectIsComplex: quadFlag1 === 0.0,
    };
  }

  function readFt2AllFromArrayBuffer(ft2ArrayBuffer, meta) {
    const m = meta || parseFt2MetaFromArrayBuffer(ft2ArrayBuffer);
    const fileFloat32 = new Float32Array(ft2ArrayBuffer);

    const n1 = m.n1;
    const n2 = m.n2;
    const quadFlag1 = m.quadFlag1;
    const quadFlag2 = m.quadFlag2;

    if (n1 <= 0 || n2 <= 0) {
      throw new Error(`Invalid FT2 dimensions: n1=${n1}, n2=${n2}`);
    }

    let n1Use = n1;
    let rr;
    let ri = null;
    const dataStartFloat = HEADER_FLOAT_COUNT;

    if (quadFlag1 === 0.0 && quadFlag2 === 0.0) {
      // Hypercomplex 2D spectrum: RR, RI, IR, II interleaved per row
      n1Use = Math.floor(n1 / 2);
      rr = new Float32Array(n1Use * n2);
      ri = new Float32Array(n1Use * n2);
      let cursor = dataStartFloat;
      for (let i = 0; i < n1Use; i += 1) {
        const dstOffset = i * n2;
        rr.set(fileFloat32.subarray(cursor, cursor + n2), dstOffset);
        cursor += n2;
        ri.set(fileFloat32.subarray(cursor, cursor + n2), dstOffset);
        cursor += n2;
        // Skip IR and II (2 * n2 floats)
        cursor += 2 * n2;
      }
    } else if (quadFlag1 === 1.0 && quadFlag2 === 0.0) {
      // Indirect is real, direct is complex: RR, RI per row
      rr = new Float32Array(n1 * n2);
      ri = new Float32Array(n1 * n2);
      let cursor = dataStartFloat;
      for (let i = 0; i < n1; i += 1) {
        const dstOffset = i * n2;
        rr.set(fileFloat32.subarray(cursor, cursor + n2), dstOffset);
        cursor += n2;
        ri.set(fileFloat32.subarray(cursor, cursor + n2), dstOffset);
        cursor += n2;
      }
    } else if (quadFlag1 === 0.0 && quadFlag2 === 1.0) {
      // Indirect is complex, direct is real (unless transposed with tp === 1)
      n1Use = m.tp === 1 ? n1 : Math.floor(n1 / 2);
      rr = new Float32Array(n1Use * n2);
      let cursor = dataStartFloat;
      for (let i = 0; i < n1Use; i += 1) {
        rr.set(fileFloat32.subarray(cursor, cursor + n2), i * n2);
        cursor += 2 * n2; // Skip IR
      }
    } else {
      // Both real
      rr = new Float32Array(n1 * n2);
      rr.set(fileFloat32.subarray(dataStartFloat, dataStartFloat + n1 * n2), 0);
    }

    let finalNy = n1Use;
    let finalNx = n2;
    let finalRr = rr;
    let finalRi = ri;

    if (m.tp === 1) {
      finalNy = n2;
      finalNx = n1Use;
      finalRr = new Float32Array(finalNy * finalNx);
      finalRi = ri ? new Float32Array(finalNy * finalNx) : null;
      for (let i = 0; i < n1Use; i += 1) {
        for (let j = 0; j < n2; j += 1) {
          finalRr[j * finalNx + i] = rr[i * n2 + j];
          if (finalRi) {
            finalRi[j * finalNx + i] = ri[i * n2 + j];
          }
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
   * Loads 2D NMRPipe FT2 buffer into [1, ny, nx, 2] float32 complex array.
   * Consistent with application_negative.py: data_2d = real_data - 1j * imag_data
   * (flipRiSign = true by default, preserving raw NMRPipe intensities so noise estimation
   * and per-patch max_mag + 1e-8 normalization match Python exactly).
   */
  function loadExperimentFromFt2ArrayBuffer(ft2ArrayBuffer, options) {
    const opts = options || {};
    const flipRiSign = opts.flipRiSign !== false;

    const meta = parseFt2MetaFromArrayBuffer(ft2ArrayBuffer);
    const arrays = readFt2AllFromArrayBuffer(ft2ArrayBuffer, meta);

    if (!arrays.ri) {
      throw new Error("FT2 does not contain direct imaginary channel (ri). Model 17 strictly requires complex direct data.");
    }

    const ny = arrays.ny;
    const nx = arrays.nx;
    const directAxis = extractDirectAxisInfoFt2(ft2ArrayBuffer, meta, nx);
    const bsz = 1;
    const channels = 2;
    const spectra = new Float32Array(bsz * ny * nx * channels);

    const rrIn = arrays.rr;
    const riIn = arrays.ri;
    const totalPts = ny * nx;
    let out = 0;
    for (let i = 0; i < totalPts; i += 1) {
      spectra[out++] = rrIn[i];
      spectra[out++] = flipRiSign ? -riIn[i] : riIn[i];
    }

    const fullMeta = Object.assign({}, meta, {
      nIndirect: ny,
      nDirect: nx,
      directAxis: directAxis,
    });

    return {
      meta: fullMeta,
      spectra,
      shape: [bsz, ny, nx, channels],
    };
  }

  function spectraIndex(shape, b, y, x, ch) {
    const ny = shape[1];
    const nx = shape[2];
    return (((b * ny + y) * nx + x) * 2) + ch;
  }

  // =========================================================================
  // 2. Water Belt Detection (2D PPDQ Robust Noise) & Patch Filter
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
   * Computes exact linear-interpolated percentile matching numpy.percentile(..., q).
   */
  function percentileLinear(sortedArr, q) {
    const n = sortedArr.length;
    if (n === 0) return 1.0;
    if (n === 1) return sortedArr[0];
    const pos = (q / 100.0) * (n - 1);
    const lo = Math.floor(pos);
    const hi = Math.ceil(pos);
    const frac = pos - lo;
    return sortedArr[lo] * (1.0 - frac) + sortedArr[hi] * frac;
  }

  /**
   * Robust 2D Noise Floor Estimator (PPDQ) matching estimate_noise_robust in
   * phase_2d/water_belt/test_water_belt_with_robust_noise.py:
   * - Grids real 2D spectrum into 16x32 tiles.
   * - Fits and subtracts a 2D linear plane I(r, c) ~ a*r + b*c + d per tile.
   * - Computes local tile MAD = 1.4826 * median(|res - median(res)|).
   * - Returns targetPercentile (default 15th) across all tile MADs.
   */
  function estimateNoiseRobust2D(spectraObj, patchH, patchW, targetPercentile) {
    const { spectra, shape } = spectraObj;
    const H = shape[1];
    const W = shape[2];
    const ph = Math.min(patchH || 16, H);
    const pw = Math.min(patchW || 32, W);
    const pct = targetPercentile != null ? targetPercentile : 15.0;
    const numPts = ph * pw;
    if (numPts <= 0) return 1.0;

    // Centered grid coordinates are mutually orthogonal: A^T A = diag(sumR2, sumC2, numPts)
    const rMean = (ph - 1) / 2.0;
    const cMean = (pw - 1) / 2.0;
    const rFlat = new Float64Array(numPts);
    const cFlat = new Float64Array(numPts);
    let sumR2 = 0.0;
    let sumC2 = 0.0;
    let ptr = 0;
    for (let r = 0; r < ph; r += 1) {
      const rv = r - rMean;
      for (let c = 0; c < pw; c += 1) {
        const cv = c - cMean;
        rFlat[ptr] = rv;
        cFlat[ptr] = cv;
        sumR2 += rv * rv;
        sumC2 += cv * cv;
        ptr += 1;
      }
    }

    const tileSigmas = [];
    const tile = new Float64Array(numPts);
    const residuals = new Float64Array(numPts);
    const scratch = new Float64Array(numPts);

    for (let r0 = 0; r0 <= H - ph; r0 += ph) {
      for (let c0 = 0; c0 <= W - pw; c0 += pw) {
        let k = 0;
        let sumV = 0.0;
        let dotR = 0.0;
        let dotC = 0.0;
        for (let dr = 0; dr < ph; dr += 1) {
          const rowBase = ((r0 + dr) * W + c0) * 2;
          for (let dc = 0; dc < pw; dc += 1) {
            const v = spectra[rowBase + dc * 2]; // Real channel
            tile[k] = v;
            sumV += v;
            dotR += rFlat[k] * v;
            dotC += cFlat[k] * v;
            k += 1;
          }
        }

        const a = sumR2 > 0.0 ? (dotR / sumR2) : 0.0;
        const b = sumC2 > 0.0 ? (dotC / sumC2) : 0.0;
        const d = sumV / numPts;

        for (let i = 0; i < numPts; i += 1) {
          const res = tile[i] - (a * rFlat[i] + b * cFlat[i] + d);
          residuals[i] = res;
          scratch[i] = res;
        }
        const med = medianInPlace(scratch, numPts);
        for (let i = 0; i < numPts; i += 1) {
          scratch[i] = Math.abs(residuals[i] - med);
        }
        tileSigmas.push(1.4826 * medianInPlace(scratch, numPts));
      }
    }

    if (tileSigmas.length === 0) return 1.0;
    const sorted = Float64Array.from(tileSigmas);
    sorted.sort();
    return percentileLinear(sorted, pct) || 1.0;
  }

  /**
   * Detects and classifies residual water belt along the direct 1H dimension,
   * matching phase_2d/water_belt/test_water_belt_with_robust_noise.py.
   */
  function detectWaterBelt2D(spectraObj, directAxisOrPpm, options) {
    const opts = options || {};
    const { spectra, shape } = spectraObj;
    const H = shape[1];
    const W = shape[2];
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

    if (!ppmScale || ppmScale.length !== W) {
      return {
        status: "no_ppm",
        hasWaterBelt: false,
        classification: "No PPM Scale",
        waterIndex: null,
        waterPpm: null,
      };
    }

    const ppmRange = [ppmScale[0], ppmScale[W - 1]];

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
    for (let c = 0; c < W; c += 1) {
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

    const sigmaRobust = estimateNoiseRobust2D(spectraObj, 16, 32, targetPct);
    const baselineMedian = 0.6745 * sigmaRobust;

    // Locate direct index inside [4.60, 4.85] ppm with maximum column std across F1
    let bestW = wIndices[0];
    let bestStd = -1.0;
    for (let idx = 0; idx < wIndices.length; idx += 1) {
      const c = wIndices[idx];
      let mean = 0.0;
      for (let r = 0; r < H; r += 1) {
        mean += spectra[(r * W + c) * 2];
      }
      mean /= H;
      let varSum = 0.0;
      for (let r = 0; r < H; r += 1) {
        const diff = spectra[(r * W + c) * 2] - mean;
        varSum += diff * diff;
      }
      const std = Math.sqrt(varSum / H);
      if (std > bestStd) {
        bestStd = std;
        bestW = c;
      }
    }

    const colTrace = new Float64Array(H);
    const scratch = new Float64Array(H);
    for (let r = 0; r < H; r += 1) {
      const v = spectra[(r * W + bestW) * 2];
      colTrace[r] = v;
      scratch[r] = v;
    }
    const colMedRaw = medianInPlace(scratch, H);

    let count5s = 0;
    const thresh5s = 5.0 * sigmaRobust;
    for (let r = 0; r < H; r += 1) {
      const det = Math.abs(colTrace[r] - colMedRaw);
      scratch[r] = det;
      if (det > thresh5s) count5s += 1;
    }

    const colMed = medianInPlace(scratch, H);
    const medRatio = baselineMedian > 0.0 ? (colMed / baselineMedian) : 0.0;
    const occ5s = (count5s / H) * 100.0;

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
      baselineMedian,
      medRatio,
      occ5s,
      ppmRange,
    };
  }

  /**
   * Computes distance in data points from nearest edge of patch [patchStart, patchStart + patchLen)
   * to waterCenterIdx (0 if waterCenterIdx lies inside the patch).
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
  // 3. 2D Noise Estimation & Token/Patch Extraction (Model 17)
  // =========================================================================

  /**
   * Estimates 2D noise level using non-overlapping 16x64 blocks (15th percentile RMSD),
   * matching extract_tokens_from_nmrpipe in application_negative.py.
   */
  function estimate2DNoiseLevel(specMag, ny, nx) {
    const rmsdList = [];
    const blockCount = 16 * 64;

    for (let rIdx = 0; rIdx <= ny - 16; rIdx += 16) {
      for (let cIdx = 0; cIdx <= nx - 64; cIdx += 64) {
        let sumSq = 0.0;
        for (let dr = 0; dr < 16; dr += 1) {
          const rowBase = (rIdx + dr) * nx + cIdx;
          for (let dc = 0; dc < 64; dc += 1) {
            const m = specMag[rowBase + dc];
            sumSq += m * m;
          }
        }
        rmsdList.push(Math.sqrt(sumSq / blockCount));
      }
    }

    if (rmsdList.length === 0) {
      let totalSq = 0.0;
      const totalPts = ny * nx;
      for (let i = 0; i < totalPts; i += 1) {
        totalSq += specMag[i] * specMag[i];
      }
      return totalPts > 0 ? (Math.sqrt(totalSq / totalPts) || 1.0) : 1.0;
    }

    rmsdList.sort((a, b) => a - b);
    return percentileLinear(rmsdList, 15.0) || 1.0;
  }

  /**
   * Separable 2D Gaussian blur with 'reflect' boundary handling matching
   * scipy.ndimage.gaussian_filter(..., sigma, mode='reflect'), used only when isolatePeak=true.
   */
  function gaussianFilter2D(src, H, W, sigma) {
    const radius = Math.max(1, Math.round(4.0 * sigma));
    const kernel = new Float32Array(2 * radius + 1);
    let kSum = 0.0;
    const inv2Sig2 = 1.0 / (2.0 * sigma * sigma);
    for (let d = -radius; d <= radius; d += 1) {
      const w = Math.exp(-(d * d) * inv2Sig2);
      kernel[d + radius] = w;
      kSum += w;
    }
    for (let i = 0; i < kernel.length; i += 1) {
      kernel[i] /= kSum;
    }

    function reflectIndex(idx, len) {
      let i = idx;
      if (len <= 1) return 0;
      while (i < 0 || i >= len) {
        if (i < 0) i = -i - 1;
        if (i >= len) i = 2 * len - i - 1;
      }
      return i;
    }

    const tmp = new Float32Array(H * W);
    const dst = new Float32Array(H * W);

    for (let r = 0; r < H; r += 1) {
      const rowBase = r * W;
      for (let c = 0; c < W; c += 1) {
        let acc = 0.0;
        for (let d = -radius; d <= radius; d += 1) {
          const cc = reflectIndex(c + d, W);
          acc += src[rowBase + cc] * kernel[d + radius];
        }
        tmp[rowBase + c] = acc;
      }
    }

    for (let r = 0; r < H; r += 1) {
      for (let c = 0; c < W; c += 1) {
        let acc = 0.0;
        for (let d = -radius; d <= radius; d += 1) {
          const rr = reflectIndex(r + d, H);
          acc += tmp[rr * W + c] * kernel[d + radius];
        }
        dst[r * W + c] = acc;
      }
    }
    return dst;
  }

  function randNormal(sigma) {
    let u1 = Math.random();
    if (u1 < 1e-12) u1 = 1e-12;
    const u2 = Math.random();
    return sigma * Math.sqrt(-2.0 * Math.log(u1)) * Math.cos(2.0 * Math.PI * u2);
  }

  /**
   * Optional main-peak isolation matching cut_main_peak in application_negative.py.
   */
  function cutMainPeak(patchComplex, H, W, rPeak, cPeak, threshold, noiseSigma, feather) {
    const patchMag = new Float32Array(H * W);
    for (let i = 0; i < H * W; i += 1) {
      patchMag[i] = Math.hypot(patchComplex[2 * i], patchComplex[2 * i + 1]);
    }
    const smoothed = gaussianFilter2D(patchMag, H, W, 0.8);
    const out = new Float32Array(H * W * 2);

    if (smoothed[rPeak * W + cPeak] < threshold) {
      for (let i = 0; i < H * W * 2; i += 1) {
        out[i] = randNormal(noiseSigma);
      }
      return out;
    }

    const mask = new Float32Array(H * W);
    mask[rPeak * W + cPeak] = 1.0;
    const queueR = [rPeak];
    const queueC = [cPeak];
    let head = 0;
    const drs = [-1, 1, 0, 0, -1, -1, 1, 1];
    const dcs = [0, 0, -1, 1, -1, 1, -1, 1];

    while (head < queueR.length) {
      const r = queueR[head];
      const c = queueC[head];
      head += 1;
      const currVal = smoothed[r * W + c];
      for (let nb = 0; nb < 8; nb += 1) {
        const nr = r + drs[nb];
        const nc = c + dcs[nb];
        if (nr >= 0 && nr < H && nc >= 0 && nc < W) {
          const nIdx = nr * W + nc;
          if (mask[nIdx] === 0.0) {
            const nextVal = smoothed[nIdx];
            if (nextVal >= threshold && nextVal <= currVal * 1.02) {
              mask[nIdx] = 1.0;
              queueR.push(nr);
              queueC.push(nc);
            }
          }
        }
      }
    }

    let weights = mask;
    if (feather) {
      const blurredMask = gaussianFilter2D(mask, H, W, 1.0);
      weights = new Float32Array(H * W);
      for (let i = 0; i < H * W; i += 1) {
        weights[i] = Math.min(1.0, Math.max(0.0, blurredMask[i] * 1.5));
      }
    }

    for (let i = 0; i < H * W; i += 1) {
      const w = weights[i];
      const nr = randNormal(noiseSigma);
      const ni = randNormal(noiseSigma);
      out[2 * i] = w * patchComplex[2 * i] + (1.0 - w) * nr;
      out[2 * i + 1] = w * patchComplex[2 * i + 1] + (1.0 - w) * ni;
    }
    return out;
  }

  /**
   * Extracts 16x128 patches per 64-point direct token for Model 17, matching
   * extract_tokens_from_nmrpipe in application_negative.py with dynamic water belt
   * detection and 32-point edge clearance filtering.
   */
  function extractTokensModel17(spectraObj, cfg) {
    const opts = cfg || {};
    const { spectra, shape } = spectraObj;
    const ny = shape[1]; // n_ind
    const nx = shape[2]; // n_dir

    const patchH = 16;
    const winW = 128;

    if (nx < winW) {
      throw new Error(`Direct dimension size (${nx}) is smaller than Model 17 window size (${winW}).`);
    }
    if (ny < patchH) {
      throw new Error(`Indirect dimension size (${ny}) is smaller than Model 17 patch height (${patchH}).`);
    }

    const totalPts = ny * nx;
    const specMag = new Float32Array(totalPts);
    for (let i = 0; i < totalPts; i += 1) {
      specMag[i] = Math.hypot(spectra[2 * i], spectra[2 * i + 1]);
    }

    const noiseLevel = estimate2DNoiseLevel(specMag, ny, nx);
    const noiseSigma = noiseLevel / Math.SQRT2;
    const peakSnrHigh = opts.peakSnrHigh != null ? opts.peakSnrHigh : DEFAULTS.peakSnrHigh;
    const peakSnrLow = opts.peakSnrLow != null ? opts.peakSnrLow : DEFAULTS.peakSnrLow;
    const excludeWater = opts.excludeWater != null ? !!opts.excludeWater : DEFAULTS.excludeWater;
    const minWaterEdgeDist = opts.minWaterEdgeDist != null ? opts.minWaterEdgeDist : DEFAULTS.minWaterEdgeDist;
    const useAll = opts.useAll != null ? !!opts.useAll : DEFAULTS.useAll;
    const isolatePeak = opts.isolatePeak != null ? !!opts.isolatePeak : DEFAULTS.isolatePeak;
    const peakThresholdFactor = opts.peakThresholdFactor != null ? opts.peakThresholdFactor : DEFAULTS.peakThresholdFactor;
    const feather = opts.feather != null ? !!opts.feather : DEFAULTS.feather;

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
        waterBelt = detectWaterBelt2D(
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

    const numTotalTokens = Math.floor(nx / 64);

    function scanTokens(highSnr, lowSnr, applyWaterExclusion, includeBaselinePatches) {
      const peakCutoff = highSnr * noiseLevel;
      const peakCutoffLow = lowSnr * noiseLevel;

      const tokenSpecs = [];
      if (numTotalTokens >= 3) {
        for (let k = 1; k < numTotalTokens - 1; k += 1) {
          tokenSpecs.push({
            tokenIdx: k + 1, // 1-based, matching application_negative.py
            colStartF2: k * 64,
            colEndF2: (k + 1) * 64,
            startF2: k * 64 - 32,
            endF2: (k + 1) * 64 + 32,
          });
        }
      } else {
        // Fallback when 128 <= nx < 192 (only 2 64-pt tokens fit)
        const startF2 = Math.floor((nx - winW) / 2);
        tokenSpecs.push({
          tokenIdx: 1,
          colStartF2: startF2 + 32,
          colEndF2: startF2 + 96,
          startF2: startF2,
          endF2: startF2 + winW,
        });
      }

      const patchesList = [];
      const detailsList = [];
      const excludedTokenIndices = [];

      for (const tSpec of tokenSpecs) {
        const { tokenIdx, colStartF2, colEndF2, startF2, endF2 } = tSpec;
        if (
          applyWaterExclusion &&
          patchTouchesWaterEdge(startF2, endF2 - startF2, waterBelt.waterIndex, minWaterEdgeDist)
        ) {
          excludedTokenIndices.push(tokenIdx);
          continue;
        }

        const candidatePeaks = [];
        for (let r = 1; r < ny - 1; r += 1) {
          const rowBase = r * nx;
          const prevBase = (r - 1) * nx;
          const nextBase = (r + 1) * nx;
          for (let c = colStartF2; c < colEndF2; c += 1) {
            if (c < 0 || c >= nx) continue;
            const val = specMag[rowBase + c];
            if (val < peakCutoffLow) continue;
            if (val > specMag[prevBase + c] && val > specMag[nextBase + c]) {
              candidatePeaks.push({ val, r, c });
            }
          }
        }

        candidatePeaks.sort((a, b) => b.val - a.val);

        // --- Top 1 (Rank 1) Selection ---
        let selectedF1_1 = null;
        for (const cand of candidatePeaks) {
          if (cand.val >= peakCutoff) {
            selectedF1_1 = cand.r;
            break;
          } else if (selectedF1_1 === null && cand.val >= peakCutoffLow) {
            selectedF1_1 = cand.r;
          }
        }

        let startF1_1 = 0;
        let isSig1 = 0;
        let statusStr1 = "";
        if (selectedF1_1 !== null) {
          startF1_1 = Math.max(0, Math.min(ny - patchH, selectedF1_1 - 8));
          isSig1 = 1;
          statusStr1 = "SIGNAL PEAK PATCH (Top 1)";
        } else if (includeBaselinePatches) {
          startF1_1 = Math.floor(Math.random() * (ny - patchH + 1));
          isSig1 = 0;
          statusStr1 = "EMPTY BASELINE PATCH (Top 1)";
        }

        // --- Top 2 (Rank 2) Selection ---
        let selectedF1_2 = null;
        if (selectedF1_1 !== null) {
          for (const cand of candidatePeaks) {
            if (Math.abs(cand.r - selectedF1_1) >= 8) {
              if (cand.val >= peakCutoff) {
                selectedF1_2 = cand.r;
                break;
              } else if (selectedF1_2 === null && cand.val >= peakCutoffLow) {
                selectedF1_2 = cand.r;
              }
            }
          }
        }

        let startF1_2 = 0;
        let isSig2 = 0;
        let statusStr2 = "";
        if (selectedF1_2 !== null) {
          startF1_2 = Math.max(0, Math.min(ny - patchH, selectedF1_2 - 8));
          isSig2 = 1;
          statusStr2 = "SIGNAL PEAK PATCH (Top 2)";
        } else if (includeBaselinePatches) {
          let rRand2 = 0;
          for (let attempt = 0; attempt < 50; attempt += 1) {
            rRand2 = Math.floor(Math.random() * (ny - patchH + 1));
            if (Math.abs(rRand2 - startF1_1) >= patchH) break;
          }
          startF1_2 = rRand2;
          isSig2 = 0;
          statusStr2 = "EMPTY BASELINE PATCH (Top 2)";
        }

        const candidateInfos = [];
        if (isSig1 === 1 || includeBaselinePatches) {
          candidateInfos.push({ rank: 1, startF1: startF1_1, isSig: isSig1, status: statusStr1 });
        }
        if (isSig2 === 1 || includeBaselinePatches) {
          candidateInfos.push({ rank: 2, startF1: startF1_2, isSig: isSig2, status: statusStr2 });
        }

        for (const info of candidateInfos) {
          const endF1 = info.startF1 + patchH;
          const rawPatch = new Float32Array(patchH * winW * 2);
          let maxMagMetric = 0.0;
          const metricStartC = info.isSig === 1 ? colStartF2 : startF2;
          const metricEndC = info.isSig === 1 ? colEndF2 : endF2;

          let ptr = 0;
          for (let r = info.startF1; r < endF1; r += 1) {
            const rowBase = r * nx;
            for (let c = startF2; c < endF2; c += 1) {
              const sIdx = 2 * (rowBase + c);
              rawPatch[ptr++] = spectra[sIdx];
              rawPatch[ptr++] = spectra[sIdx + 1];
              if (c >= metricStartC && c < metricEndC) {
                const m = specMag[rowBase + c];
                if (m > maxMagMetric) maxMagMetric = m;
              }
            }
          }

          let usedPatch = rawPatch;
          if (isolatePeak && info.isSig === 1) {
            let bestCoreMag = -1.0;
            let bestR = 0;
            let bestCoreC = 32;
            for (let dr = 0; dr < patchH; dr += 1) {
              for (let dc = 32; dc < 96; dc += 1) {
                const pIdx = 2 * (dr * winW + dc);
                const m = Math.hypot(rawPatch[pIdx], rawPatch[pIdx + 1]);
                if (m > bestCoreMag) {
                  bestCoreMag = m;
                  bestR = dr;
                  bestCoreC = dc;
                }
              }
            }
            usedPatch = cutMainPeak(
              rawPatch,
              patchH,
              winW,
              bestR,
              bestCoreC,
              peakThresholdFactor * noiseLevel,
              noiseSigma,
              feather
            );
          } else if (isolatePeak && info.isSig === 0) {
            usedPatch = new Float32Array(patchH * winW * 2);
            for (let i = 0; i < usedPatch.length; i += 1) {
              usedPatch[i] = randNormal(noiseSigma);
            }
          }

          let maxPatchMag = 0.0;
          for (let i = 0; i < patchH * winW; i += 1) {
            const m = Math.hypot(usedPatch[2 * i], usedPatch[2 * i + 1]);
            if (m > maxPatchMag) maxPatchMag = m;
          }
          const invNorm = 1.0 / (maxPatchMag + 1e-8);
          const normPatch = new Float32Array(patchH * winW * 2);
          for (let i = 0; i < usedPatch.length; i += 1) {
            normPatch[i] = usedPatch[i] * invNorm;
          }

          patchesList.push(normPatch);
          detailsList.push({
            tokenIdx: tokenIdx,
            patchRank: info.rank,
            isSignal: info.isSig,
            status: info.status,
            directRange: `${startF2}..${endF2 - 1}`,
            indirectRange: `${info.startF1}..${endF1 - 1}`,
            directCenterF2: (startF2 + (endF2 - 1)) / 2.0,
            maxMag: maxMagMetric,
          });
        }
      }

      return { patchesList, detailsList, excludedTokenIndices };
    }

    let scan = scanTokens(peakSnrHigh, peakSnrLow, shouldExcludeWater, useAll);

    // Graceful fallbacks if < 2 candidate patches were found:
    // First relax SNR cutoff while keeping water belt exclusion active so dilute solute peaks are preferred over water artifacts.
    if (scan.patchesList.length < 2) {
      console.log(`[tfjs] Found ${scan.patchesList.length} signal patch(es) at SNR ${peakSnrLow}. Relaxing cutoff to SNR 3.0...`);
      scan = scanTokens(8.0, 3.0, shouldExcludeWater, useAll);
    }
    if (scan.patchesList.length < 2 && shouldExcludeWater) {
      console.log(`[tfjs] Found ${scan.patchesList.length} signal patch(es) outside water guard band. Retrying without water exclusion...`);
      scan = scanTokens(8.0, 3.0, false, useAll);
    }
    if (scan.patchesList.length < 2) {
      console.log(`[tfjs] Relaxed search yielded ${scan.patchesList.length} patch(es). Extracting global peak fallback...`);
      scan = scanTokens(3.0, 0.0, false, true);
    }

    const numPatches = scan.patchesList.length;
    const singlePatchFloats = patchH * winW * 2;
    const flatPatches = new Float32Array(numPatches * singlePatchFloats);
    for (let k = 0; k < numPatches; k += 1) {
      flatPatches.set(scan.patchesList[k], k * singlePatchFloats);
    }

    return {
      patches: flatPatches,
      patchesShape: [numPatches, patchH, winW, 2],
      tokenDetails: scan.detailsList,
      noiseLevel: noiseLevel,
      numPatches: numPatches,
      numTotalTokens: numTotalTokens,
      waterBelt: waterBelt,
      excludedTokenIndices: scan.excludedTokenIndices,
    };
  }

  // =========================================================================
  // 4. Revised Weighted RANSAC (W-RANSAC) with n*pi Phase Adjustment
  // =========================================================================

  /**
   * Revised Weighted Random Sample Consensus (W-RANSAC) linear phase fitting
   * with discrete n*pi (n*180 deg) adjustments, matching weighted_ransac_fit
   * in application_negative.py.
   *
   * Fits: phi(x_norm) = p0 + p1 * x_norm, where x_norm in [-1, +1].
   */
  function weightedRansacFit(xCoords, yPhasesDeg, weights, options) {
    const opts = options || {};
    const cutoffDeg = opts.cutoffDeg != null ? opts.cutoffDeg : DEFAULTS.ransacCutoffDeg;
    const nIter = opts.nIter != null ? opts.nIter : DEFAULTS.ransacIter;
    const nPiMax = opts.nPiMax != null ? opts.nPiMax : DEFAULTS.ransacNPiMax;
    const maxP1 = opts.maxP1 != null ? opts.maxP1 : DEFAULTS.ransacMaxP1;

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
        yAdj: Float64Array.from(yPhasesDeg),
      };
    }

    let totalWeightAll = 0.0;
    for (let i = 0; i < N; i += 1) {
      totalWeightAll += weights[i];
    }

    const effWeights = new Float64Array(N);
    let effTotal = 0.0;
    for (let i = 0; i < N; i += 1) {
      const w = totalWeightAll > 0 ? weights[i] : 1.0;
      effWeights[i] = w;
      effTotal += w;
    }

    // Weighted pair sampling without replacement (exact match to np.random.choice(..., size=2, replace=False, p=...))
    function sampleDistinctPair() {
      let r1 = Math.random() * effTotal;
      let i = N - 1;
      for (let k = 0; k < N; k += 1) {
        r1 -= effWeights[k];
        if (r1 <= 0.0) {
          i = k;
          break;
        }
      }

      const remTotal = effTotal - effWeights[i];
      if (remTotal <= 0.0) {
        return [i, (i + 1) % N];
      }

      let r2 = Math.random() * remTotal;
      let j = i === N - 1 ? N - 2 : N - 1;
      for (let k = 0; k < N; k += 1) {
        if (k === i) continue;
        r2 -= effWeights[k];
        if (r2 <= 0.0) {
          j = k;
          break;
        }
      }
      return [i, j];
    }

    const numNChoices = 2 * nPiMax + 1;
    const nChoices = new Int32Array(numNChoices);
    const nOffsets = new Float64Array(numNChoices);
    for (let k = 0; k < numNChoices; k += 1) {
      const n = k - nPiMax;
      nChoices[k] = n;
      nOffsets[k] = n * 180.0;
    }
    const maxDeltaN = 2 * nPiMax;

    let bestScore = -1.0;
    let bestInlierMask = new Array(N).fill(false);
    let bestCandP0 = 0.0;
    let bestCandP1 = 0.0;
    const bestNPerToken = new Int32Array(N);

    for (let iter = 0; iter < nIter; iter += 1) {
      const [i, j] = sampleDistinctPair();
      const dx = xCoords[j] - xCoords[i];
      if (Math.abs(dx) < 1e-5) continue;

      const diffRad = (yPhasesDeg[j] - yPhasesDeg[i]) * Math.PI / 180.0;
      const dphiBase = Math.atan2(Math.sin(diffRad), Math.cos(diffRad)) * 180.0 / Math.PI;

      for (let deltaN = -maxDeltaN; deltaN <= maxDeltaN; deltaN += 1) {
        const candP1 = (dphiBase + deltaN * 180.0) / dx;
        if (Math.abs(candP1) > maxP1) continue;

        const rawP0 = yPhasesDeg[i] - candP1 * xCoords[i];
        let candP0 = (rawP0 + 180.0) % 360.0;
        if (candP0 < 0.0) candP0 += 360.0;
        candP0 -= 180.0;

        let candScore = 0.0;
        const curInliers = new Array(N).fill(false);
        const curNPerToken = new Int32Array(N);

        for (let t = 0; t < N; t += 1) {
          const yCand = candP0 + candP1 * xCoords[t];
          let minRes = 1e9;
          let bestNForT = 0;
          for (let k = 0; k < numNChoices; k += 1) {
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

    // Resolve global parity so weighted majority of inliers correspond to positive absorptive peaks (even n)
    const inlierIndices = [];
    for (let i = 0; i < N; i += 1) {
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
        const p0Shift = bestCandP0 > 0.0 ? -180.0 : 180.0;
        bestCandP0 += p0Shift;
        const deltaNShift = p0Shift < 0.0 ? -1 : 1;
        for (let i = 0; i < N; i += 1) {
          bestNPerToken[i] += deltaNShift;
        }
      }
    }

    // Refine P0 and P1 via Weighted Least Squares (WLS) on unwrapped consensus inliers
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
        p0Fit = sumW > 0.0 ? (sumWy / sumW) : 0.0;
        p1Fit = 0.0;
      }
    } else if (numInliers === 1) {
      const idx = inlierIndices[0];
      p0Fit = yPhasesDeg[idx] + bestNPerToken[idx] * 180.0;
      p1Fit = 0.0;
    }

    // Wrap P0 into [-180, 180] and adjust bestNPerToken accordingly
    let p0FitWrapped = (p0Fit + 180.0) % 360.0;
    if (p0FitWrapped < 0.0) p0FitWrapped += 360.0;
    p0FitWrapped -= 180.0;

    const p0Diff = p0FitWrapped - p0Fit;
    if (Math.abs(p0Diff) > 1e-4) {
      const shiftN = Math.round(p0Diff / 180.0);
      for (let i = 0; i < N; i += 1) {
        bestNPerToken[i] += shiftN;
      }
      p0Fit = p0FitWrapped;
    }

    const weightRatio = totalWeightAll > 0.0 ? (bestScore / totalWeightAll) : 0.0;
    const yAdj = new Float64Array(N);
    for (let i = 0; i < N; i += 1) {
      yAdj[i] = yPhasesDeg[i] + bestNPerToken[i] * 180.0;
    }

    return {
      p0: p0Fit,
      p1: p1Fit,
      inliersMask: bestInlierMask,
      weightRatio: weightRatio,
      numInliers: numInliers,
      bestN: bestNPerToken,
      yAdj: yAdj,
    };
  }

  // =========================================================================
  // 5. Spectrum Phase Application & Combination
  // =========================================================================

  /**
   * Applies linear phase rotation [left, right] (defined at c = 0 and c = nx,
   * matching c_norm = (c - nx/2) / (nx/2) in application_negative.py) to
   * working spectra [bsz, ny, nx, 2].
   */
  function applyLeftRightToSpectra(spectraObj, leftRight) {
    const spectra = spectraObj.spectra;
    const shape = spectraObj.shape;
    const bsz = shape[0];
    const ny = shape[1];
    const nx = shape[2];
    const denom = Math.max(nx, 1);

    for (let b = 0; b < bsz; b += 1) {
      const lr = leftRight[b];
      const left = lr[0];
      const right = lr[1];
      const delta = right - left;

      for (let d = 0; d < nx; d += 1) {
        const phaseDeg = left + delta * (d / denom);
        const phi = phaseDeg * Math.PI / 180.0;
        const cosP = Math.cos(phi);
        const sinP = Math.sin(phi);

        for (let y = 0; y < ny; y += 1) {
          const idx = spectraIndex(shape, b, y, d, 0);
          const re = spectra[idx];
          const im = spectra[idx + 1];
          spectra[idx] = re * cosP - im * sinP;
          spectra[idx + 1] = re * sinP + im * cosP;
        }
      }
    }
  }

  function addLeftRightArrays(a, b) {
    if (!a) return b.map(lr => [lr[0], lr[1]]);
    const bsz = a.length;
    const out = new Array(bsz);
    for (let i = 0; i < bsz; i += 1) {
      out[i] = [a[i][0] + b[i][0], a[i][1] + b[i][1]];
    }
    return out;
  }

  // =========================================================================
  // 6. Model 17 Forward Pass & Iterative Pipeline (Default: 2 Rounds)
  // =========================================================================

  /**
   * Executes Model 17 on extracted 16x128x2 patches with sub-batching and
   * automatic WebGL-to-CPU fallback for integrated GPUs.
   */
  async function runModel17OnPatches(tf, model, ext) {
    const numPatches = ext.numPatches;
    if (numPatches === 0) {
      return {
        phiPredDeg: new Float64Array(0),
        stdPredDeg: new Float64Array(0),
        weights: new Float64Array(0),
      };
    }

    const singlePatchFloats = 16 * 128 * 2;
    const BATCH_SIZE = 8; // Sub-batching keeps WebGL texture and shader register pressure low

    async function executeBatch(patchSlice, batchCount) {
      const tensor = tf.tensor(patchSlice, [batchCount, 16, 128, 2], "float32");
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
      for (let i = 0; i < numPatches; i += BATCH_SIZE) {
        const batchCount = Math.min(BATCH_SIZE, numPatches - i);
        const slice = ext.patches.subarray(i * singlePatchFloats, (i + batchCount) * singlePatchFloats);
        const batchPreds = await executeBatch(slice, batchCount);
        for (let b = 0; b < batchCount; b += 1) {
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
        console.warn(`[tfjs] WebGL execution failed (${errMsg}). Falling back to CPU backend for Model 17...`);
        logToHtml(`[tfjs] WebGL shader compilation failed on GPU. Switching to CPU backend for Model 17 auto-phasing...`);
        await tf.setBackend("cpu");
        if (typeof tf.ready === "function") {
          await tf.ready();
        }
        preds = await runInference();
      } else {
        throw err;
      }
    }

    const phiPredDeg = new Float64Array(numPatches);
    const stdPredDeg = new Float64Array(numPatches);
    const weights = new Float64Array(numPatches);

    for (let k = 0; k < numPatches; k += 1) {
      phiPredDeg[k] = preds[k][0];
      stdPredDeg[k] = preds[k][1];
      weights[k] = 1.0 / (stdPredDeg[k] * stdPredDeg[k] + 1e-8);
    }

    return { phiPredDeg, stdPredDeg, weights };
  }

  /**
   * Loads Model 17 TF.js GraphModel with automatic CPU fallback if WebGL backend initialization fails.
   */
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

  function formatWaterBeltLog2D(waterBelt, minWaterEdgeDist) {
    if (!waterBelt) return null;
    if (waterBelt.status === "out_of_range" && waterBelt.ppmRange) {
      return `[tfjs][Water Belt] Water window (4.60–4.85 ppm) outside direct spectrum (${waterBelt.ppmRange[0].toFixed(2)} to ${waterBelt.ppmRange[1].toFixed(2)} ppm) — keeping all patches`;
    }
    if (waterBelt.status === "not_1h") {
      return `[tfjs][Water Belt] Direct axis is not 1H — keeping all patches`;
    }
    if (waterBelt.status === "no_ppm") {
      return `[tfjs][Water Belt] No direct chemical shift scale in header — keeping all patches`;
    }
    if (waterBelt.hasWaterBelt) {
      const ppmStr = waterBelt.waterPpm != null ? `${waterBelt.waterPpm.toFixed(3)} ppm, ` : "";
      const metricStr = waterBelt.medRatio != null
        ? ` | medRatio=${waterBelt.medRatio.toFixed(2)}x, occ5s=${waterBelt.occ5s.toFixed(1)}%`
        : "";
      return `[tfjs][Water Belt] ${waterBelt.classification} detected at index ${waterBelt.waterIndex} (${ppmStr}min edge clearance=${minWaterEdgeDist} pts${metricStr})`;
    }
    const ppmInfoStr = waterBelt.waterPpm != null
      ? ` (${waterBelt.waterPpm.toFixed(3)} ppm | medRatio=${waterBelt.medRatio.toFixed(2)}x, occ5s=${waterBelt.occ5s.toFixed(1)}%)`
      : "";
    return `[tfjs][Water Belt] No Water Belt detected${ppmInfoStr} — keeping all patches`;
  }

  /**
   * Single-round inference helper on an already-loaded [1, ny, nx, 2] spectra object.
   */
  async function inferFromSpectra(params) {
    const tf = ensureTf(params.tf);
    const model = params.model;
    if (!model) {
      throw new Error("inferFromSpectra requires a loaded tf.js model instance.");
    }

    const spectraObj = {
      spectra: params.spectra,
      shape: params.shape,
      meta: params.meta || null,
    };
    const nx = params.shape[2];
    const xRef = nx / 2.0;
    const xScale = nx / 2.0;

    const ext = extractTokensModel17(spectraObj, params);
    const out = await runModel17OnPatches(tf, model, ext);

    const xCoords = new Float64Array(ext.numPatches);
    for (let k = 0; k < ext.numPatches; k += 1) {
      xCoords[k] = (ext.tokenDetails[k].directCenterF2 - xRef) / xScale;
    }

    const fit = weightedRansacFit(xCoords, out.phiPredDeg, out.weights, {
      cutoffDeg: params.ransacCutoffDeg != null ? params.ransacCutoffDeg : DEFAULTS.ransacCutoffDeg,
      nIter: params.ransacIter != null ? params.ransacIter : DEFAULTS.ransacIter,
      nPiMax: params.ransacNPiMax != null ? params.ransacNPiMax : DEFAULTS.ransacNPiMax,
      maxP1: params.ransacMaxP1 != null ? params.ransacMaxP1 : DEFAULTS.ransacMaxP1,
    });

    const left = fit.p0 - fit.p1;
    const right = fit.p0 + fit.p1;

    return {
      tokens: ext.tokenDetails,
      waterBelt: ext.waterBelt,
      excludedTokenIndices: ext.excludedTokenIndices,
      noiseLevel: ext.noiseLevel,
      phiPredDeg: out.phiPredDeg,
      stdPredDeg: out.stdPredDeg,
      weights: out.weights,
      fit: fit,
      left: left,
      right: right,
      wls_phase_left_right: [[left, right]],
    };
  }

  /**
   * Main 2D Model 17 Auto-Phase Pipeline from FT2 ArrayBuffer (default: 2 rounds).
   */
  async function runFromFt2(params) {
    const tf = ensureTf(params.tf);
    const ft2ArrayBuffer = params.ft2ArrayBuffer;
    if (!(ft2ArrayBuffer instanceof ArrayBuffer)) {
      throw new Error("runFromFt2 requires ft2ArrayBuffer as ArrayBuffer.");
    }

    let model = params.model;
    if (!model) {
      const url = params.modelUrl || DEFAULTS.modelUrl;
      console.log(`[tfjs] Loading 2D Model 17 from ${url}...`);
      model = await loadModel(tf, url);
    }

    const exp = loadExperimentFromFt2ArrayBuffer(ft2ArrayBuffer, {
      flipRiSign: params.flipRiSign != null ? params.flipRiSign : DEFAULTS.flipRiSign,
    });

    const spectraWorking = {
      spectra: exp.spectra.slice(0),
      shape: exp.shape,
      meta: exp.meta,
    };

    const nx = exp.shape[2];
    const xRef = nx / 2.0;
    const xScale = nx / 2.0;
    const numRounds = params.numRounds != null ? Math.max(1, Math.round(params.numRounds)) : DEFAULTS.numRounds;

    const cfg = {
      peakSnrHigh: params.peakSnrHigh != null ? params.peakSnrHigh : DEFAULTS.peakSnrHigh,
      peakSnrLow: params.peakSnrLow != null ? params.peakSnrLow : DEFAULTS.peakSnrLow,
      excludeWater: params.excludeWater != null ? !!params.excludeWater : DEFAULTS.excludeWater,
      minWaterEdgeDist: params.minWaterEdgeDist != null ? params.minWaterEdgeDist : DEFAULTS.minWaterEdgeDist,
      waterWindowPpm: params.waterWindowPpm || DEFAULTS.waterWindowPpm,
      useAll: params.useAll != null ? !!params.useAll : DEFAULTS.useAll,
      isolatePeak: params.isolatePeak != null ? !!params.isolatePeak : DEFAULTS.isolatePeak,
      peakThresholdFactor: params.peakThresholdFactor != null ? params.peakThresholdFactor : DEFAULTS.peakThresholdFactor,
      feather: params.feather != null ? !!params.feather : DEFAULTS.feather,
      ransacCutoffDeg: params.ransacCutoffDeg != null ? params.ransacCutoffDeg : DEFAULTS.ransacCutoffDeg,
      ransacIter: params.ransacIter != null ? params.ransacIter : DEFAULTS.ransacIter,
      ransacNPiMax: params.ransacNPiMax != null ? params.ransacNPiMax : DEFAULTS.ransacNPiMax,
      ransacMaxP1: params.ransacMaxP1 != null ? params.ransacMaxP1 : DEFAULTS.ransacMaxP1,
      numRounds: numRounds,
    };

    const startMsg = `[tfjs] Starting 2D Model 17 Auto-Phase (${cfg.useAll ? "All-Tokens" : "Signal-Only"}, ${numRounds} Round${numRounds > 1 ? "s" : ""})...`;
    console.log(startMsg);
    logToHtml(startMsg);

    // Detect water belt once on the spectrum so water exclusion is dynamic and consistent across rounds
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
        waterBelt = detectWaterBelt2D(
          spectraWorking,
          params.ppmScale || exp.meta.directAxis,
          cfg
        );
      }
      cfg.waterBelt = waterBelt;
      const wbMsg = formatWaterBeltLog2D(waterBelt, cfg.minWaterEdgeDist);
      if (wbMsg) {
        console.log(wbMsg);
        logToHtml(wbMsg);
      }
    }

    let totalLeft = 0.0;
    let totalRight = 0.0;
    const rounds = [];
    let firstPatchesShape = null;

    for (let r = 1; r <= numRounds; r += 1) {
      const ext = extractTokensModel17(spectraWorking, cfg);
      if (!firstPatchesShape) {
        firstPatchesShape = ext.patchesShape;
      }

      const exclNote = (ext.excludedTokenIndices && ext.excludedTokenIndices.length > 0)
        ? `, Excluded water tokens: [${ext.excludedTokenIndices.join(", ")}]`
        : "";
      const extMsg = `[tfjs][Round ${r}] Extracted ${ext.numPatches} candidate patch(es) (Estimated Noise: ${ext.noiseLevel.toExponential(2)}${exclNote})`;
      console.log(extMsg);
      logToHtml(extMsg);

      const out = await runModel17OnPatches(tf, model, ext);

      const xCoords = new Float64Array(ext.numPatches);
      for (let k = 0; k < ext.numPatches; k += 1) {
        xCoords[k] = (ext.tokenDetails[k].directCenterF2 - xRef) / xScale;
      }

      const fit = weightedRansacFit(xCoords, out.phiPredDeg, out.weights, {
        cutoffDeg: cfg.ransacCutoffDeg,
        nIter: cfg.ransacIter,
        nPiMax: cfg.ransacNPiMax,
        maxP1: cfg.ransacMaxP1,
      });

      const left = fit.p0 - fit.p1;
      const right = fit.p0 + fit.p1;
      const nmrpipeP0 = left;
      const nmrpipeP1 = right - left;

      const roundMsg = `[ANN Phase] Round ${r} (Model 17) | Inliers: ${fit.numInliers}/${ext.numPatches} (${(fit.weightRatio * 100.0).toFixed(1)}% wt) | Center P0: ${fit.p0.toFixed(2)}°, Half-Span P1: ${fit.p1.toFixed(2)}° | NMRPipe P0: ${nmrpipeP0.toFixed(2)}°, P1: ${nmrpipeP1.toFixed(2)}°`;
      console.log(roundMsg);
      logToHtml(roundMsg);

      // Apply current round phase correction (-left, -right on conjugated working spectrum z = rr - 1j*ri)
      if (r < numRounds) {
        applyLeftRightToSpectra(spectraWorking, [[-left, -right]]);
      }

      totalLeft += left;
      totalRight += right;

      rounds.push({
        round: r,
        tokens: ext.tokenDetails,
        excludedTokenIndices: ext.excludedTokenIndices,
        noiseLevel: ext.noiseLevel,
        phiPredDeg: out.phiPredDeg,
        stdPredDeg: out.stdPredDeg,
        weights: out.weights,
        fit: fit,
        left: left,
        right: right,
      });
    }

    const finalLeftRight = [[totalLeft, totalRight]];
    const combinedMsg = `[ANN Phase] Total Combined (${numRounds} round${numRounds > 1 ? "s" : ""}) | NMRPipe P0 (left edge): ${totalLeft.toFixed(2)}°, P1 (total change): ${(totalRight - totalLeft).toFixed(2)}°`;
    console.log(combinedMsg);
    logToHtml(combinedMsg);

    return {
      ft2Meta: exp.meta,
      waterBelt: waterBelt,
      config: cfg,
      shapes: {
        spectra: exp.shape,
        patches: firstPatchesShape,
      },
      rounds: rounds,
      round1: rounds[0] || null,
      round2: rounds[1] || null,
      final_wls_phase_left_right: finalLeftRight,
    };
  }

  // =========================================================================
  // 7. Public API Export
  // =========================================================================

  const api = {
    defaults: Object.assign({}, DEFAULTS),
    configureTfEnvironment,
    parseFt2MetaFromArrayBuffer,
    extractDirectAxisInfoFt2,
    readFt2AllFromArrayBuffer,
    loadExperimentFromFt2ArrayBuffer,
    estimateNoiseRobust2D,
    detectWaterBelt2D,
    getPatchWaterEdgeDistance,
    patchTouchesWaterEdge,
    extractTokensModel17,
    weightedRansacFit,
    applyLeftRightToSpectra,
    addLeftRightArrays,
    inferFromSpectra,
    runFromFt2,
    loadModel,
    // Backward compatibility stubs
    registerCustomLayers: function () {},
    getCustomObjects: function () { return {}; },
    extractTopNPatches: extractTokensModel17,
    wlsLeftRightFromLocal: function () { return [[0.0, 0.0]]; },
  };

  globalScope.NUS2DPhasePipeline = api;
})(typeof window !== "undefined" ? window : globalThis);
