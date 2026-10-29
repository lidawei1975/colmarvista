/*
 * Browser-first single-file pipeline for 2D Model 17 TensorFlow.js inference.
 *
 * Model 17: Phase-Equivariant 2D Complex Phase Predictor with Uncertainty Head.
 * Accepts input patches of shape [batch, 16, 128, 2] (Real, Imag channels)
 * and directly outputs [phi_pred_deg, std_pred_deg] in degrees.
 *
 * Pipeline Workflow (consistent with phase_2d/equivariance/model17/application_negative.py):
 * 1) Parse NMRPipe FT2 ArrayBuffer with complex direct channel (z = rr - 1j * ri).
 * 2) Estimate 2D noise level via 15th-percentile RMSD over 16x64 blocks.
 * 3) Segment direct dimension into 64-point tokens (skipping first & last boundary tokens),
 *    extracting up to Top 2 16x128 signal patches per token (20x / 8x noise cutoffs,
 *    |r - r1| >= 8 separation, excluding middle 3 water carrier tokens by default).
 * 4) Normalize each 16x128 patch individually by max(|z|) + 1e-8.
 * 5) Run Model 17 TF.js GraphModel forward pass with sub-batching and automatic
 *    WebGL-to-CPU fallback for integrated GPUs.
 * 6) Fit P0 and P1 linear phase using Revised Weighted RANSAC (W-RANSAC) with discrete
 *    n*pi (n*180 deg) adjustments for negative peaks and wrapped phase gradients.
 * 7) Run iteratively (default: 2 rounds in web environment) and accumulate total
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
    FDPLANE: 221,       // tp (transpose flag)
    FDSPECNUM: 219,     // n1 (indirect row count; 2*n_ind when hypercomplex)
    FDSIZE: 99,         // n2 (direct point count)
    FDF1QUADFLAG: 55,   // quad_flag_1 (0 = complex, 1 = real)
    FDF2QUADFLAG: 56,   // quad_flag_2 (0 = complex, 1 = real)
  };

  const DEFAULTS = {
    tokenWidth: 64,
    windowSize: 128,
    patchHeight: 16,
    topK: 2,
    peakSnrHigh: 20.0,
    peakSnrLow: 8.0,
    excludeWater: true,
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
  // 1. NMRPipe FT2 Header & Binary Parser
  // =========================================================================

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
      rr = new Float32Array(n1 * n2);
      let cursor = dataStartFloat;
      for (let i = 0; i < n1; i += 1) {
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

    return {
      meta: Object.assign({}, meta, { nIndirect: ny, nDirect: nx }),
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
  // 2. 2D Noise Estimation & Token/Patch Extraction (Model 17)
  // =========================================================================

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
   * extract_tokens_from_nmrpipe + water exclusion & candidate selection in application_negative.py.
   */
  function extractTokensModel17(spectraObj, cfg) {
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
    const peakSnrHigh = cfg.peakSnrHigh != null ? cfg.peakSnrHigh : DEFAULTS.peakSnrHigh;
    const peakSnrLow = cfg.peakSnrLow != null ? cfg.peakSnrLow : DEFAULTS.peakSnrLow;
    const excludeWater = cfg.excludeWater != null ? !!cfg.excludeWater : DEFAULTS.excludeWater;
    const useAll = cfg.useAll != null ? !!cfg.useAll : DEFAULTS.useAll;
    const isolatePeak = cfg.isolatePeak != null ? !!cfg.isolatePeak : DEFAULTS.isolatePeak;
    const peakThresholdFactor = cfg.peakThresholdFactor != null ? cfg.peakThresholdFactor : DEFAULTS.peakThresholdFactor;
    const feather = cfg.feather != null ? !!cfg.feather : DEFAULTS.feather;

    const numTotalTokens = Math.floor(nx / 64);
    const midTokenIdx = Math.floor(numTotalTokens / 2);

    function scanTokens(highSnr, lowSnr, applyWaterExclusion, includeBaselinePatches) {
      const peakCutoff = highSnr * noiseLevel;
      const peakCutoffLow = lowSnr * noiseLevel;

      const excludedSet = new Set();
      if (applyWaterExclusion && numTotalTokens >= 3) {
        excludedSet.add(midTokenIdx - 1);
        excludedSet.add(midTokenIdx);
        excludedSet.add(midTokenIdx + 1);
      }

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

      for (const tSpec of tokenSpecs) {
        const { tokenIdx, colStartF2, colEndF2, startF2, endF2 } = tSpec;
        if (excludedSet.has(tokenIdx)) {
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

      return { patchesList, detailsList };
    }

    let scan = scanTokens(peakSnrHigh, peakSnrLow, excludeWater, useAll);

    // Graceful fallbacks if < 2 candidate patches were found (e.g., narrow extracted region or very low SNR)
    if (scan.patchesList.length < 2 && excludeWater) {
      console.log(`[tfjs] Found ${scan.patchesList.length} signal patch(es) with water exclusion. Retrying including middle tokens...`);
      scan = scanTokens(peakSnrHigh, peakSnrLow, false, useAll);
    }
    if (scan.patchesList.length < 2) {
      console.log(`[tfjs] Found ${scan.patchesList.length} signal patch(es) at SNR ${peakSnrLow}. Relaxing cutoff to SNR 3.0...`);
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
      midTokenIdx: midTokenIdx,
    };
  }

  // =========================================================================
  // 3. Revised Weighted RANSAC (W-RANSAC) with n*pi Phase Adjustment
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
  // 4. Spectrum Phase Application & Combination
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
  // 5. Model 17 Forward Pass & Iterative Pipeline (Default: 2 Rounds)
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
    };

    const nx = exp.shape[2];
    const xRef = nx / 2.0;
    const xScale = nx / 2.0;
    const numRounds = params.numRounds != null ? Math.max(1, Math.round(params.numRounds)) : DEFAULTS.numRounds;

    const cfg = {
      peakSnrHigh: params.peakSnrHigh != null ? params.peakSnrHigh : DEFAULTS.peakSnrHigh,
      peakSnrLow: params.peakSnrLow != null ? params.peakSnrLow : DEFAULTS.peakSnrLow,
      excludeWater: params.excludeWater != null ? !!params.excludeWater : DEFAULTS.excludeWater,
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

    let totalLeft = 0.0;
    let totalRight = 0.0;
    const rounds = [];
    let firstPatchesShape = null;

    for (let r = 1; r <= numRounds; r += 1) {
      const ext = extractTokensModel17(spectraWorking, cfg);
      if (!firstPatchesShape) {
        firstPatchesShape = ext.patchesShape;
      }

      const extMsg = `[tfjs][Round ${r}] Extracted ${ext.numPatches} candidate patch(es) (Estimated Noise: ${ext.noiseLevel.toExponential(2)})`;
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
  // 6. Public API Export
  // =========================================================================

  const api = {
    defaults: Object.assign({}, DEFAULTS),
    configureTfEnvironment,
    parseFt2MetaFromArrayBuffer,
    readFt2AllFromArrayBuffer,
    loadExperimentFromFt2ArrayBuffer,
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
