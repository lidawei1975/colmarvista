/**
 * Simple 2D peak picking using local maxima algorithm
 * A point is considered a peak if:
 * 1. It's larger than all 4 neighbors (up, down, left, right)
 * 2. It's higher than the noise/contour threshold
 */

/**
 * Pick peaks from 2D spectrum data with simple local maxima algorithm
 * @param {Float32Array} spectrumData - full spectrum including header and data
 * @param {Float32Array} header - NMRPipe file header (512 floats)
 * @param {number} noiseLevel - absolute noise level threshold
 * @param {number} scale - scale factor (optional, overrides noiseLevel)
 * @param {Object} spectrumInfo - optional spectrum object fields (n_direct, n_indirect, x_ppm_start, x_ppm_step, y_ppm_start, y_ppm_step)
 * @returns {Array} array of picked peaks with properties: {x_ppm, y_ppm, x_axis, y_axis, intensity}
 */
function simpleLocalMaximaPeakPicking(spectrumData, header, noiseLevel, scale, spectrumInfo) {
    // Extract spectrum dimensions from NMRPipe header
    // NMRPipe header format (key indices):
    // header[0] = FDFN (real size of direct dimension in points)
    // header[2] = FDF_FTFLAG (is data in frequency domain? 1=yes)
    // header[10] = FDSIZE (actual size of data points in direct dimension)
    // header[99] = NDIM (number of dimensions)
    // For indirect dimension in 2D:
    // header[219] = NDSIZE (size of indirect dimension)
    
    const HEADER_SIZE = 512;
    
    // Match spectrum.js: raw_data is row-major [n_indirect rows, n_direct cols].
    const spectrum_n_direct = spectrumInfo && Number.isFinite(Number(spectrumInfo.n_direct)) ? parseInt(spectrumInfo.n_direct) : 0;
    const spectrum_n_indirect = spectrumInfo && Number.isFinite(Number(spectrumInfo.n_indirect)) ? parseInt(spectrumInfo.n_indirect) : 0;
    const ndim1 = spectrum_n_direct || parseInt(header[99]) || parseInt(header[10]) || 0;   // n_direct (F2, columns)
    const ndim2 = spectrum_n_indirect || parseInt(header[219]) || parseInt(header[0]) || 0; // n_indirect (F1, rows)
    
    if (ndim1 <= 0 || ndim2 <= 0) {
        console.warn('Invalid spectrum dimensions - header[10]:', header[10], 'header[219]:', header[219], 'parsed ndim1:', ndim1, 'ndim2:', ndim2);
        return [];
    }
    
    let x_ppm_start;
    let x_ppm_step;
    let y_ppm_start;
    let y_ppm_step;

    const hasSpectrumAxes = spectrumInfo
        && Number.isFinite(Number(spectrumInfo.x_ppm_start))
        && Number.isFinite(Number(spectrumInfo.x_ppm_step))
        && Number.isFinite(Number(spectrumInfo.y_ppm_start))
        && Number.isFinite(Number(spectrumInfo.y_ppm_step));

    if (hasSpectrumAxes) {
        // Prefer spectrum object values directly (requested behavior).
        x_ppm_start = Number(spectrumInfo.x_ppm_start);
        x_ppm_step = Number(spectrumInfo.x_ppm_step);
        y_ppm_start = Number(spectrumInfo.y_ppm_start);
        y_ppm_step = Number(spectrumInfo.y_ppm_step);
    } else {
        // Fallback to header-based conversion if spectrumInfo is unavailable.
        const direct_ndx = parseInt(header[24]) || 2;
        const indirect_ndx = parseInt(header[25]) || 1;

        const sw = [];
        const frq = [];
        const ref = [];
        sw[0] = header[229] || 0.0;
        sw[1] = header[100] || 0.0;
        sw[2] = header[11] || 0.0;
        sw[3] = header[29] || 0.0;
        frq[0] = header[218] || 0.0;
        frq[1] = header[119] || 0.0;
        frq[2] = header[10] || 0.0;
        frq[3] = header[28] || 0.0;
        ref[0] = header[249] || 0.0;
        ref[1] = header[101] || 0.0;
        ref[2] = header[12] || 0.0;
        ref[3] = header[30] || 0.0;

        const sw1 = sw[direct_ndx - 1] || 1.0;
        const sw2 = sw[indirect_ndx - 1] || 1.0;
        const frq1 = frq[direct_ndx - 1] || 1.0;
        const frq2 = frq[indirect_ndx - 1] || 1.0;
        const ref1 = ref[direct_ndx - 1] || 0.0;
        const ref2 = ref[indirect_ndx - 1] || 0.0;

        const x_ppm_width = sw1 / frq1;
        const y_ppm_width = sw2 / frq2;
        x_ppm_step = -x_ppm_width / ndim1;
        y_ppm_step = -y_ppm_width / ndim2;
        x_ppm_start = (ref1 + sw1) / frq1 - x_ppm_width / ndim1 / 2.0;
        y_ppm_start = (ref2 + sw2) / frq2 - y_ppm_width / ndim2 / 2.0;
    }
    
    // Calculate threshold: scale * noiseLevel
    const threshold = (scale || 3.0) * noiseLevel;
    
    console.log('[simpleLocalMaximaPeakPicking] ndim1:', ndim1, 'ndim2:', ndim2, 'threshold:', threshold);
    console.log('[simpleLocalMaximaPeakPicking] using spectrum axes:', hasSpectrumAxes);
    console.log('[simpleLocalMaximaPeakPicking] x_ppm_start:', x_ppm_start, 'x_ppm_step:', x_ppm_step);
    console.log('[simpleLocalMaximaPeakPicking] y_ppm_start:', y_ppm_start, 'y_ppm_step:', y_ppm_step);
    
    // Reshape spectrum data into 2D array
    // Data is stored as [direct_0, direct_1, ..., direct_n, direct_0, ...]
    const data = new Float32Array(spectrumData.buffer, 
        spectrumData.byteOffset + HEADER_SIZE * 4, 
        ndim1 * ndim2);
    
    const peaks = [];
    
    // Scan interior points only (skip edges)
    for (let j = 1; j < ndim2 - 1; j++) {
        for (let i = 1; i < ndim1 - 1; i++) {
            const idx = j * ndim1 + i;
            const value = data[idx];
            
            // Check if above threshold
            if (Math.abs(value) < threshold) {
                continue;
            }
            
            // Check if local maximum (larger than 4 neighbors)
            const up = data[(j - 1) * ndim1 + i];
            const down = data[(j + 1) * ndim1 + i];
            const left = data[j * ndim1 + (i - 1)];
            const right = data[j * ndim1 + (i + 1)];
            
            // Only positive peaks for now (can extend to negative later)
            if (value > 0) {
                if (value > up && value > down && value > left && value > right) {
                    // Found a peak! Convert to ppm
                    const x_ppm = x_ppm_start + i * x_ppm_step;
                    const y_ppm = y_ppm_start + j * y_ppm_step;
                    
                    peaks.push({
                        x_axis: i,
                        y_axis: j,
                        x_ppm: x_ppm,
                        y_ppm: y_ppm,
                        intensity: value
                    });
                }
            }
            // Also check negative peaks
            else if (value < 0) {
                if (value < up && value < down && value < left && value < right) {
                    const x_ppm = x_ppm_start + i * x_ppm_step;
                    const y_ppm = y_ppm_start + j * y_ppm_step;
                    
                    peaks.push({
                        x_axis: i,
                        y_axis: j,
                        x_ppm: x_ppm,
                        y_ppm: y_ppm,
                        intensity: value
                    });
                }
            }
        }
    }
    
    console.log('[simpleLocalMaximaPeakPicking] Scanning interior points from j=1 to', ndim2-1, 'i=1 to', ndim1-1);
    
    console.log('[simpleLocalMaximaPeakPicking] Found', peaks.length, 'peaks after scanning', (ndim2 - 2) * (ndim1 - 2), 'interior points');
    
    return peaks;
}

/**
 * Convert simple peaks array to NMRPipe tab format string
 * @param {Array} peaks - array of peak objects from simpleLocalMaximaPeakPicking
 * @returns {string} NMRPipe .tab format string
 */
function peaksToNmrPipeTab(peaks) {
    // NMRPipe format: INDEX X_AXIS Y_AXIS X_PPM Y_PPM XW YW HEIGHT ASS CONFIDENCE
    // X_AXIS, Y_AXIS are pixel coordinates (needed for peak fitting)
    // XW, YW are line widths
    let tab = 'VARS INDEX X_AXIS Y_AXIS X_PPM Y_PPM XW YW HEIGHT ASS CONFIDENCE\n';
    tab += 'FORMAT %5d %9.3f %9.3f %10.6f %10.6f %6.3f %6.3f %+e %s %6.2f\n';
    
    for (let i = 0; i < peaks.length; i++) {
        const p = peaks[i];
        const assigned = 'peak'; // Simple picker marks all as "peak"
        const confidence = 1.00; // 100% confidence for local maxima
        const xw = 3.0; // Width in X direction (pixels or Hz)
        const yw = 3.0; // Width in Y direction (pixels or Hz)
        
        // Format the intensity with explicit + sign for consistency with %+e format
        let intensity_str;
        if (p.intensity >= 0) {
            intensity_str = '+' + p.intensity.toExponential(1);
        } else {
            intensity_str = p.intensity.toExponential(1);
        }
        
        const line = [
            (i + 1).toString().padStart(5),
            p.x_axis.toFixed(3).padStart(9),
            p.y_axis.toFixed(3).padStart(9),
            p.x_ppm.toFixed(6).padStart(10),
            p.y_ppm.toFixed(6).padStart(10),
            xw.toFixed(3).padStart(6),
            yw.toFixed(3).padStart(6),
            intensity_str.padStart(11),
            assigned.padStart(1),
            confidence.toFixed(2).padStart(6)
        ].join(' ') + '\n';
        
        tab += line;
    }
    
    return tab;
}

/**
 * Worker-friendly wrapper for peak picking
 * Called from webass_2d.js peak_picker_2d handler
 * @param {Uint8Array} spectrumDataUint8 - full spectrum as bytes (header + data)
 * @param {number} noiseLevel - noise level threshold
 * @param {number} scale - scale factor to multiply with noise level
 * @param {Object} spectrumInfo - optional spectrum axis metadata
 * @returns {string} NMRPipe tab format string of picked peaks
 */
function simplePeakPickingWorker(spectrumDataUint8, noiseLevel, scale, spectrumInfo) {
    // Convert bytes to Float32Array
    const float32View = new Float32Array(spectrumDataUint8.buffer);
    
    // Extract header (first 512 floats)
    const header = float32View.slice(0, 512);
    
    // Full spectrum data
    const peaks = simpleLocalMaximaPeakPicking(float32View, header, noiseLevel, scale, spectrumInfo);
    
    console.log('[SimplePeaker] Detected', peaks.length, 'peaks. noise_level:', noiseLevel, 'scale:', scale);
    console.log('[SimplePeaker] Threshold:', (scale || 3.0) * noiseLevel);
    
    // Convert to NMRPipe tab format
    const tab = peaksToNmrPipeTab(peaks);
    console.log('[SimplePeaker] Tab output length:', tab.length, 'first 200 chars:', tab.substring(0, 200));
    return tab;
}
