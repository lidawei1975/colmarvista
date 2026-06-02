/**
 * =========================================================================================
 * COLMARVIEW 3D FID PROCESSING WORKFLOW DOCUMENTATION
 * =========================================================================================
 * 
 * This file handles the main-thread orchestration of the 3D NMR processing pipeline.
 * It manages the coordination between the user interface, the WebAssembly C++ worker
 * (`webass_3d.js`), the SMILE worker (`webass_smile.js`), and the TensorFlow.js
 * auto-phasing models.
 * 
 * Depending on the dataset type (NUS vs. Non-NUS) and whether "Automatic Phase Correction"
 * is checked in the UI, the pipeline takes one of the four paths outlined below:
 * 
 * -----------------------------------------------------------------------------------------
 * PATH 1: Non-NUS, Automatic Phase Correction DISABLED (Manual Phasing)
 * -----------------------------------------------------------------------------------------
 *   1. User clicks "Process FID" with Auto-Phase unchecked.
 *   2. `load_fid_3d_file()` builds the configuration object `cfg` using UI values.
 *   3. It posts a `process_fid_3d` job to `web_worker_3d` (the main WASM worker).
 *   4. Inside the worker (`webass_3d.js`), since `useNusStepPipeline` is false:
 *      - It calls C++ `set_final_frq_polynorminal_order` with the UI baseline orders.
 *      - It calls C++ `full_process()` to perform a single-pass 3D Fourier Transform.
 *      - It extracts the phased/baseline-corrected spectrum and posts the result back.
 *   5. The main thread receives the final spectrum and renders it immediately.
 * 
 * -----------------------------------------------------------------------------------------
 * PATH 2: Non-NUS, Automatic Phase Correction ENABLED
 * -----------------------------------------------------------------------------------------
 *   1. User clicks "Process FID" with Auto-Phase checked.
 *   2. `load_fid_3d_file()` prepares the first-pass (Phase-Check Pass) config:
 *      - Caches the UI baseline orders in `cfg.userFrqPolyOrder`.
 *      - Overrides `cfg.frqPolyOrder` to `[-1, -1, -1]` to bypass baseline correction.
 *      - Forces imaginary data retention in the direct dimension (to allow phasing).
 *   3. It posts the `process_fid_3d` job to `web_worker_3d`.
 *   4. Inside the worker (`webass_3d.js`), since `useNusStepPipeline` is false:
 *      - It calls C++ `set_final_frq_polynorminal_order(-1, -1, -1)` (no baseline applied).
 *      - It calls C++ `full_process()` and returns the unbaselined spectrum.
 *   5. The main thread receives the result and runs TF.js on the unbaselined buffer:
 *      - Auto-phase model calculates the local direct-dimension phase angles (local p0/p1).
 *      - Extrapolates local values to global full-spectrum values (`ui_p0`, `ui_p1`).
 *      - Updates the UI manual phase boxes with the extrapolated values.
 *      - Unchecks the UI Auto-Phase checkbox.
 *   6. The main thread immediately launches a post-processing pass (`postprocess_ft3` job):
 *      - Sends the unbaselined spectrum buffer, the calculated local phase angles, and `cfg.userFrqPolyOrder`.
 *   7. Inside the worker (`webass_3d.js`) for job `postprocess_ft3`:
 *      - It loads the unbaselined extracted spectrum.
 *      - Calls C++ `set_final_frq_polynorminal_order` with the cached user baseline orders.
 *      - Applies the calculated local phase correction in C++.
 *      - Calls C++ `postprocess_loaded_ft3()` to run the final baseline correction.
 *      - Discards direct imaginary data (if required) and returns the final spectrum.
 *   8. The main thread receives the final processed spectrum and renders it.
 * 
 * -----------------------------------------------------------------------------------------
 * PATH 3: NUS, Automatic Phase Correction DISABLED (Manual Phasing)
 * -----------------------------------------------------------------------------------------
 *   1. User clicks "Process FID" with Auto-Phase unchecked.
 *   2. `load_fid_3d_file()` builds `cfg` from the UI.
 *   3. It posts a `process_fid_3d` job to `web_worker_3d`.
 *   4. Inside the worker (`webass_3d.js`), since `useNusStepPipeline` is true (isNus && no force full):
 *      - It calls C++ `set_frq_domain_polynorminal_order` with the UI baseline orders.
 *      - It calls C++ `direct_only_process()` (Step 2 of NUS pipeline).
 *      - Posts back a `process_fid_3d_nus_half_ready` job containing the direct-phased half-spectrum.
 *   5. The main thread receives the half-processed spectrum and sends it to the SMILE worker (`webass_smile.js`).
 *   6. The SMILE worker performs reconstruction on the missing data points and returns a `smile.ft3` buffer.
 *   7. The main thread receives the SMILE result and posts a `process_fid_3d_nus_step3` job to the WASM worker.
 *   8. Inside the worker (`webass_3d.js`) for job `process_fid_3d_nus_step3`:
 *      - It loads the SMILE reconstructed buffer.
 *      - Calls C++ `set_final_frq_polynorminal_order` with the UI baseline orders.
 *      - Calls C++ `indirect_only_process()`.
 *      - Finalizes and posts back the completed spectrum.
 *   9. The main thread receives the final spectrum and renders it.
 * 
 * -----------------------------------------------------------------------------------------
 * PATH 4: NUS, Automatic Phase Correction ENABLED
 * -----------------------------------------------------------------------------------------
 *   1. User clicks "Process FID" with Auto-Phase checked.
 *   2. `load_fid_3d_file()` prepares the first-pass (Phase-Check Pass) config:
 *      - Caches the UI baseline orders in `cfg.userFrqPolyOrder`.
 *      - Overrides `cfg.frqPolyOrder` to `[-1, -1, -1]` to bypass baseline correction.
 *      - Overrides `cfg.debugNusRunFullProcess = true` and `cfg.nusDirectDimAutoPhase = true`.
 *        This forces the worker to run the full-process route (skipping SMILE) so the resulting spectrum
 *        contains the expected sampling artifacts for the TF.js model to recognize.
 *   3. It posts the `process_fid_3d` job to `web_worker_3d`.
 *   4. Inside the worker (`webass_3d.js`), because `forceNusFullProcess` is true:
 *      - It calls C++ `set_final_frq_polynorminal_order(-1, -1, -1)` (no baseline applied).
 *      - It calls C++ `full_process()`, which generates a fast reconstruction with artifacts.
 *      - It finalizes and returns the unbaselined spectrum.
 *   5. The main thread receives the result and runs TF.js:
 *      - Model calculates the local direct-dimension phase angles (local p0/p1).
 *      - Extrapolates local values to global full-spectrum values (`ui_p0`, `ui_p1`).
 *      - Updates the UI manual phase boxes with the extrapolated values.
 *      - Unchecks the UI Auto-Phase checkbox.
 *   6. The main thread automatically triggers a fresh re-run of `load_fid_3d_file()` after a 100ms delay.
 *      Since Auto-Phase is now unchecked, this re-run falls back to **Path 3** (the standard multi-step NUS pipeline)
 *      and processes the spectrum from scratch using the newly calculated phase values.
 * =========================================================================================
 * 
 * IMPORTANT NOTE
 * 
 * Internally, we define:
 * X axis as     direct, F2 dimension,
 * Y axis as indirect 1, F3 dimension,
 * Z axis as indirect 2, F1 dimension
 * All the variable names and comments are based on this definition.
 * In spectral data, X is the most inner dimension, Y is intermediate dimension and Z is most out dimension.
 * 
 * In the UI, we keep X as most inner dimension (displayed as x), Y as intermediate dimension (displayed as y), and Z as outer dimension (displayed as z).
 */


/**
 * This is the mermaid diagram when we load ft3 (or raw, or group of ft2) file(s) or when we processing fid data
 
flowchart TD
    subgraph Direct Loading Route
        L1[load_ft3_file]
        L2[load_raw_3d_file]
    end
    subgraph FID Processing Route
        P1[Run WebAss 3D / SMILE Workers] --> P2[Worker returns process_fid_3d complete]
        P2 --> P3[Optional: Run TensorFlow.js Auto-Phase Pipeline]
    end
    L1 & L2 --> CONV[CONVERGENCE POINT: spectra_3d is fully populated]
    P3 & P2 --> CONV
    CONV --> S1[Update UI Slider Limits & Show Containers]
    S1 --> S2[Call init_main_plot spectra_3d 0]
    S2 --> S3[Call draw_slice 0]
    S3 --> S4[Call init_ortho_plots spectra_3d 0]
    S4 --> S5[Call update_global_noise_level]

 */


/**
 * Global variables required by myplot1_new.js and others
 */
var hsqc_spectra = []; // Defines the current slice being displayed (length 1)
var spectra_3d = [];   // Stores all loaded 3D planes (spectrum objects)
var theoretical_spectra_3d = []; // Stores theoretical 3D volume
var theoretical_spectrum_xz = null;
var theoretical_spectrum_yz = null;

var my_contour_worker = null;
var tooldiv = document.getElementById("information_bar");
var zoom_on_call_function = null;
var iso_renderer = null;
var iso_renderer_recon = null;
var ui_status_timers = {};
var trace_plot_margins_3d = { left: 52, right: 12, top: 8, bottom: 22 };
var trace_zoom_domains = {
    'trace_x_svg': null,
    'trace_y_svg': null,
    'trace_z_svg': null
};

/**
 * The 3 2D plots
 * XZ and YZ Plot Logic
 */
var main_plot = null;
var main_plot_xz = null;
var main_plot_yz = null;

/**
 * 2D spectrum objects. spectra_3d is for main_plot. 
 * spectrum_xz and spectrum_yz are for orthogonal views.
 */
var spectrum_xz = null;
var spectrum_yz = null;

// Temporary Fixed positions (Center of the cube)
// Ideally updated by crosshair interaction
var current_y_index = -1; // Set during init, For Y axis, indirect1, F3
var current_x_index = -1; // Set during init. For X axis, direct F2
var current_slice_index = -1; // Set during init, For Z axis, indirect2, F1

var current_reprocess_spectrum_index = -1; // Not used but required by global var comment in myplot1_new.js


var main_plot_proj = null;
var spectrum_proj = null;
var theoretical_spectrum_proj = null;

var main_plot_proj_y = null;
var spectrum_proj_y = null;
var theoretical_spectrum_proj_y = null;

var main_plot_proj_x = null;
var spectrum_proj_x = null;
var theoretical_spectrum_proj_x = null;

var global_3d_noise = 0.0;
var show_peak_symbols = true;

function evaluate_global_noise_redefinition() {

    let max_pos = 0;
    let max_neg_abs = 0;
    if (spectra_3d && spectra_3d.length > 0) {
        for (let s of spectra_3d) {
            if (s.spectral_max && s.spectral_max > max_pos) {
                max_pos = s.spectral_max;
            }
            if (s.spectral_min && Math.abs(s.spectral_min) > max_neg_abs) {
                max_neg_abs = Math.abs(s.spectral_min);
            }
        }
    }

    let max_val = Math.max(max_pos, max_neg_abs);
    let display_color = "#555"; // Default color

    if (global_3d_noise < 1e-6 * max_val) {
        global_3d_noise = 1e-6 * max_val;
        display_color = "red";
    }

    let display = document.getElementById('global_noise_level_display');
    if (display) {
        display.innerText = "Estimated 3D Noise: " + global_3d_noise.toExponential(3);
        display.style.color = display_color;
    }
}

function adjust_proj_noise(spec, display_id) {
    if (!spec || !spec.raw_data) return;
    let [p_max, p_min] = mathTool.find_max_min(spec.raw_data);
    let max_val = Math.max(p_max, Math.abs(p_min));
    let display_color = "#555";
    if (spec.noise_level < 1e-5 * max_val) {
        spec.noise_level = 5e-4 * max_val;
        display_color = "red";
    }
    let display = document.getElementById(display_id);
    if (display) {
        let prefix = "Proj. Noise: ";
        if (display_id === "proj_y_noise_level_display") prefix = "Proj Y Noise: ";
        if (display_id === "proj_x_noise_level_display") prefix = "Proj X Noise: ";
        display.innerText = prefix + spec.noise_level.toExponential(2);
        display.style.color = display_color;
    }
}


// Phase correction variables for Trace X
var trace_x_ph0 = 0.0;
var trace_x_ph1 = 0.0;
var trace_x_pivot = null;

var tfjs_normal_model = null;
var tfjs_large_model = null;
var current_fid_config = null;
var auto_p0_3d = null;
var auto_p1_3d = null;

/**
 * Capture spectral ranges from worker logs for phase extrapolation
 */
var last_fid_full_ppm_range = null;
var last_fid_extract_ppm_range = null;

/**
 * Capture nuclear names from worker logs for axis labeling
 * Internal Mapping: F2 -> x (Direct), F3 -> y (Indirect 1), F1 -> z (Indirect 2/Planes)
 * UI Display Names: F2 as x, F3 as y, F1 as z
 */
window.last_fid_nuclei = { x: '', y: '', z: '' };


/**
 * Resets 3D dataset state.
 *
 * @param {boolean} [keepNuclei] - Keep nuclei Default is false.
 */
function reset_3d_dataset_state(keepNuclei = false) {
    spectra_3d = [];
    hsqc_spectra = [];
    current_slice_index = -1;
    theoretical_peaks_data = [];
    theoretical_spectra_3d = [];
    let toggle_btn = document.getElementById("button_toggle_peak_symbols");
    if (toggle_btn) {
        toggle_btn.disabled = true;
        toggle_btn.innerText = "Hide Peak Symbols";
    }
    show_peak_symbols = true;

    spectrum_xz = null;
    spectrum_yz = null;
    theoretical_spectrum_xz = null;
    theoretical_spectrum_yz = null;

    auto_p0_3d = null;
    auto_p1_3d = null;

    global_3d_noise = 0.0;
    raw_3d_noise_level = 0.0;
    let display = document.getElementById('global_noise_level_display');
    if (display) {
        display.style.color = "#555";
        display.innerText = "Noise: -";
    }

    // Release large contiguous visualization buffers from previous dataset.
    current_volume_data = null;
    clear_all_1d_traces();

    spectrum_proj = null;
    spectrum_proj_y = null;
    spectrum_proj_x = null;
    theoretical_spectrum_proj = null;
    theoretical_spectrum_proj_y = null;
    theoretical_spectrum_proj_x = null;
    main_plot_proj = null;
    main_plot_proj_y = null;
    main_plot_proj_x = null;

    window.last_processed_ft3_blob = null;
    let ft3_processed_btn = document.getElementById('button_download_ft3_processed');
    if (ft3_processed_btn) {
        ft3_processed_btn.style.display = 'none';
        ft3_processed_btn.onclick = null;
    }

    if (!keepNuclei) {
        window.last_fid_nuclei = { x: '', y: '', z: '' };
        update_all_plot_axis_labels();
    }
}

/**
 * Sets status message.
 *
 * @param {any} element_id - Element id
 * @param {any} text - Text
 * @param {number} [auto_clear_ms] - Auto clear ms Default is 0.
 */
function set_status_message(element_id, text, auto_clear_ms = 0) {
    let elem = document.getElementById(element_id);
    if (!elem) return;

    if (ui_status_timers[element_id]) {
        clearTimeout(ui_status_timers[element_id]);
        ui_status_timers[element_id] = null;
    }

    elem.innerText = text || "";

    if (auto_clear_ms > 0) {
        ui_status_timers[element_id] = setTimeout(() => {
            let target = document.getElementById(element_id);
            if (target && target.innerText === text) {
                target.innerText = "";
            }
            ui_status_timers[element_id] = null;
        }, auto_clear_ms);
    }
}

/**
 * Clears status message.
 *
 * @param {any} element_id - Element id
 */
function clear_status_message(element_id) {
    set_status_message(element_id, "", 0);
}



/**
 * Function to save the current 3D spectrum as a .ft3 file.
 * This combines all planes in spectra_3d into a single NMRPipe-compatible buffer.
 */
function download_ft3() {
    const buffer = create_ft3_buffer();
    if (!buffer) return;

    const s0 = spectra_3d[0];
    const outName = (s0.filename || "spectrum").replace(/\.[^/.]+$/, "") + "_processed.ft3";
    download_binary_file(buffer, outName);
}

/**
 * Creates an NMRPipe-compliant FT3 buffer from the currently loaded spectra_3d.
 */
function create_ft3_buffer() {
    if (!spectra_3d || spectra_3d.length === 0) {
        alert("No spectra loaded.");
        return null;
    }

    const s0 = spectra_3d[0];
    const nz = spectra_3d.length;
    const ny = s0.n_indirect;
    const nx = s0.n_direct;

    const has_ri = s0.raw_data_ri && s0.raw_data_ri.length > 0;
    const has_ir = s0.raw_data_ir && s0.raw_data_ir.length > 0;
    const has_ii = s0.raw_data_ii && s0.raw_data_ii.length > 0;

    let parts_per_trace = 1;
    if (has_ri) parts_per_trace++;
    if (has_ir) parts_per_trace++;
    if (has_ii) parts_per_trace++;

    const header_byte_size = 2048;
    const plane_data_byte_size = ny * nx * parts_per_trace * 4;
    const total_byte_size = header_byte_size + nz * plane_data_byte_size;

    const buffer = new ArrayBuffer(total_byte_size);
    const floatView = new Float32Array(buffer);

    if (s0.header && s0.header.length >= 512) {
        floatView.set(s0.header.subarray(0, 512));
    } else {
        floatView.fill(0, 0, 512);
        floatView[1] = 1.0;
        floatView[2] = 2.0;
    }

    floatView[15] = nz;
    floatView[99] = nx;
    floatView[219] = ny;

    floatView[56] = has_ri ? 0 : 1;
    floatView[55] = has_ir ? 0 : 1;
    floatView[51] = (has_ir && has_ii) ? 0 : 1;

    let gMax = -Infinity;
    let gMin = Infinity;

    let floatOffset = 512;
    for (let z = 0; z < nz; z++) {
        const s = spectra_3d[z];
        const re = s.raw_data;
        const ri = s.raw_data_ri;
        const ir = s.raw_data_ir;
        const ii = s.raw_data_ii;

        for (let y = 0; y < ny; y++) {
            const row_start = y * nx;
            const row_end = (y + 1) * nx;

            floatView.set(re.subarray(row_start, row_end), floatOffset);
            for (let i = row_start; i < row_end; i++) {
                if (re[i] > gMax) gMax = re[i];
                if (re[i] < gMin) gMin = re[i];
            }
            floatOffset += nx;

            if (has_ri) {
                if (ri && ri.length >= row_end) {
                    floatView.set(ri.subarray(row_start, row_end), floatOffset);
                } else {
                    floatView.fill(0, floatOffset, floatOffset + nx);
                }
                floatOffset += nx;
            }

            if (has_ir) {
                if (ir && ir.length >= row_end) {
                    floatView.set(ir.subarray(row_start, row_end), floatOffset);
                } else {
                    floatView.fill(0, floatOffset, floatOffset + nx);
                }
                floatOffset += nx;
            }

            if (has_ii) {
                if (ii && ii.length >= row_end) {
                    floatView.set(ii.subarray(row_start, row_end), floatOffset);
                } else {
                    floatView.fill(0, floatOffset, floatOffset + nx);
                }
                floatOffset += nx;
            }
        }
    }

    floatView[247] = gMax;
    floatView[248] = gMin;

    return buffer;
}

/**
 * Runs auto phase on loaded spectrum.
 * @returns {Promise<void>}
 */
async function run_auto_phase_on_loaded_spectrum() {
    if (!spectra_3d || spectra_3d.length === 0) {
        alert("No spectra loaded.");
        return;
    }

    const has_ri = spectra_3d[0].raw_data_ri && spectra_3d[0].raw_data_ri.length > 0;
    if (!has_ri) {
        alert("Auto-phase correction requires imaginary data along the direct dimension. Please reload the spectrum with imaginary data enabled.");
        return;
    }

    append_3d_log("[tfjs] Running manual auto phase correction...");
    try {
        if (!tfjs_normal_model || !tfjs_large_model) {
            append_3d_log("[tfjs] Pre-loading models...");
            if (!tfjs_normal_model) tfjs_normal_model = await NUS3DPhasePipeline.loadModel(window.tf, 'js/model22_tfjs/model.json');
            if (!tfjs_large_model) tfjs_large_model = await NUS3DPhasePipeline.loadModel(window.tf, 'js/model22_large_tfjs/model.json');
        }

        const buffer = create_ft3_buffer();
        if (!buffer) return;

        const result = await NUS3DPhasePipeline.runFromFt3({
            tf: window.tf,
            ft3ArrayBuffer: buffer,
            model: tfjs_normal_model,
            largeModel: tfjs_large_model,
        });

        const lr = result.final_wls_phase_left_right[0];
        const leftEdge = lr[0];
        const rightEdge = lr[1];

        const s = spectra_3d[0];
        const nx = result.ft3Meta.nDirect;

        // Use local parameters for immediate application to the loaded spectrum
        const local_p0 = leftEdge;
        const local_p1 = (rightEdge - leftEdge) * (nx - 1) / nx;

        append_3d_log(`[tfjs] Auto phase result: local_p0=${local_p0.toFixed(2)}, local_p1=${local_p1.toFixed(2)}`);

        append_3d_log("[tfjs] Applying correction to all planes...");
        apply_trace_x_phase(local_p0, local_p1, s.x_ppm_start);

    } catch (err) {
        console.error(err);
        append_3d_log("[tfjs-error] Manual auto phase failed: " + err.message);
    }
}

/**
 * Runs 3D peak picking and fitting workflow on the currently loaded spectrum.
 * @returns {Promise<void>}
 */
async function run_peak_fit_3d_workflow() {
    if (!spectra_3d || spectra_3d.length === 0) {
        alert("No spectrum loaded to run peak picking/fitting.");
        return;
    }

    append_3d_log("[main] Preparing spectrum buffer for peak picking & fitting...");

    // Disable loading buttons to prevent concurrent actions
    set_loading_buttons_state(true);

    try {
        const buffer = create_ft3_buffer();
        if (!buffer) {
            throw new Error("Failed to compile currently loaded spectrum to an FT3 buffer.");
        }

        const ft3Bytes = new Uint8Array(buffer);
        append_3d_log(`[main] Posting pick_and_fit_3d job to worker with buffer size ${ft3Bytes.length} bytes...`);
        document.getElementById("webassembly_message").innerText = "Peak picking & fitting in progress (iterative fitting top-50 partitions)...";

        let s0 = spectra_3d[0];
        let noiseLevel = s0 ? (s0.noise_level || 0.0) : 0.0;
        let scale2 = 10.0;
        let multiplier_input = document.getElementById("contour_start_multiplier");
        if (multiplier_input) {
            scale2 = parseFloat(multiplier_input.value) || 10.0;
        }
        let scale1 = 1.5 * scale2;

        web_worker_3d.postMessage({
            "#sym:webassembly_job ": "pick_and_fit_3d",
            ft3Bytes: ft3Bytes,
            noiseLevel: noiseLevel,
            scale1: scale1,
            scale2: scale2
        }, [ft3Bytes.buffer]);

    } catch (err) {
        console.error(err);
        append_3d_log("[main-error] Peak picking/fitting startup failed: " + err.message);
        document.getElementById("webassembly_message").innerText = "Peak picking/fitting failed: " + err.message;
        set_loading_buttons_state(false);
    }
}


/**
 * Appends 3D log.
 *
 * @param {any} message - Message
 */
function append_3d_log(message) {
    const area = document.getElementById("log_area_3d");
    if (area && area.style.display === 'none') {
        area.style.display = 'block';
    }
    const logElem = document.getElementById("log");
    if (!logElem) {
        return;
    }
    logElem.value += String(message) + "\n";
    logElem.scrollTop = logElem.scrollHeight;
}

/**
 * Calculates global phase correction parameters (p0, p1) for the full spectrum
 * by extrapolating from local phase predictions at the edges of an extracted spectrum.
 * @param {number} leftEdge - Phase predicted at the left edge (index 0) of the extract.
 * @param {number} rightEdge - Phase predicted at the right edge (index nx) of the extract.
 * @param {number[]} fullPpmRange - [start, end] PPM of the full spectrum.
 * @param {number[]} extractPpmRange - [start, end] PPM of the extract.
 */
function get_full_spectrum_phase_correction(leftEdge, rightEdge, fullPpmRange, extractPpmRange) {
    const ppm_full_start = fullPpmRange[0];
    const ppm_full_end = fullPpmRange[1];
    const ppm_extract_start = extractPpmRange[0];
    const ppm_extract_end = extractPpmRange[1];

    // Slope in degrees per PPM
    const slope = (rightEdge - leftEdge) / (ppm_extract_end - ppm_extract_start);

    // p0 is at d=0 of the full spectrum
    const p0 = leftEdge + slope * (ppm_full_start - ppm_extract_start);

    // p1 is the total phase change across the full spectrum
    const p1 = slope * (ppm_full_end - ppm_full_start);

    return {
        p0: p0,
        p1: p1,
        ppm_full_start: ppm_full_start,
        ppm_extract_start: ppm_extract_start,
        ppm_extract_end: ppm_extract_end,
        ppm_full_end: ppm_full_end
    };
}

/**
 * Appends 3D worker stdout.
 *
 * @param {any} stdoutText - Stdout text
 */
function append_3d_worker_stdout(stdoutText) {
    const area = document.getElementById("log_area_3d");
    if (area && area.style.display === 'none') {
        area.style.display = 'block';
    }
    const logElem = document.getElementById("log");
    if (!logElem) {
        return;
    }

    const text = stdoutText == null ? "" : String(stdoutText);

    // Capture spectral metadata from direct dimension processing.
    // Targeted line example: "Direct metadata after extraction: SW ... ppm [full] -> [ext]"
    // Explicitly matches: "ppm [11.7046, -2.29145] -> [9.79016, 6.39199]"
    // Format: "ppm [full_start, full_end] -> [ext_start, ext_end]"
    const num_re = /[-+]?\d*\.?\d+(?:[eE][-+]?\d+)?/;
    const ppmRegex = new RegExp(`ppm\\s*\\[\\s*(${num_re.source})\\s*,\\s*(${num_re.source})\\s*\\]\\s*->\\s*\\[\\s*(${num_re.source})\\s*,\\s*(${num_re.source})\\s*\\]`);
    const match = text.match(ppmRegex);
    if (match) {
        window.last_fid_full_ppm_range = [parseFloat(match[1]), parseFloat(match[2])];
        window.last_fid_extract_ppm_range = [parseFloat(match[3]), parseFloat(match[4])];
        console.log('[3D] Captured spectral metadata:', window.last_fid_full_ppm_range, window.last_fid_extract_ppm_range);
    }

    // Capture nuclear names (F1, F2, F3)
    // Examples:
    // "[worker] F2: nucleus=1H, size=1024, ppm=[11.7115, -2.29145]"
    // "[worker] F1: nucleus=15N, size=30, ppm=[135.154, 100.152]"
    // "[worker] F3: nucleus=1H, size=95, ppm=[11.8452, -2.15772]"
    const nucleusRegex = /(F[123]):\s*nucleus=([^,]+)/;
    const nucMatch = text.match(nucleusRegex);
    if (nucMatch) {
        const dim = nucMatch[1];
        const nuc = nucMatch[2].trim();
        if (dim === 'F2') window.last_fid_nuclei.x = nuc;
        else if (dim === 'F3') window.last_fid_nuclei.y = nuc;
        else if (dim === 'F1') window.last_fid_nuclei.z = nuc;

        console.log(`[3D] Captured nucleus for ${dim}: ${nuc}`);
        update_all_plot_axis_labels();
    }

    logElem.value += "[worker] " + text;
    if (!text.endsWith("\n")) {
        logElem.value += "\n";
    }
    logElem.scrollTop = logElem.scrollHeight;
}

/**
 * Extract nuclei names from spectrum header.
 * @param {spectrum} s - Spectrum object
 */
function extract_nuclei_from_spectrum(s) {
    if (!s || !s.header) return;
    const header = s.header;
    const dimorder1 = header[24];
    const dimorder2 = header[25];
    const dimorder3 = header[26];

    const getLabelIndex = (dim) => {
        if (dim === 1) return 18;
        if (dim === 2) return 16;
        if (dim === 3) return 20;
        return null;
    };

    const readLabel = (dim) => {
        const idx = getLabelIndex(dim);
        if (idx === null) return "";
        try {
            const uint8 = new Uint8Array(header.buffer, s.header.byteOffset + idx * 4, 8);
            let str = "";
            for (let i = 0; i < 8; i++) {
                if (uint8[i] === 0) break;
                str += String.fromCharCode(uint8[i]);
            }
            return str.trim();
        } catch (e) {
            console.error("Error reading NMRPipe label for dimension " + dim, e);
            return "";
        }
    };

    window.last_fid_nuclei = {
        x: readLabel(dimorder1),
        y: readLabel(dimorder2),
        z: readLabel(dimorder3)
    };
    update_all_plot_axis_labels();
}

/**
 * Updates all plot axis labels.
 */
function update_all_plot_axis_labels() {
    const nx = window.last_fid_nuclei.x;
    const ny = window.last_fid_nuclei.y;
    const nz = window.last_fid_nuclei.z;

    const getLabel = (nuc, axis) => {
        const prefix = axis ? `${axis} ` : "";
        return nuc ? `${prefix}${nuc} (ppm)` : `${prefix}Chemical Shift (ppm)`;
    };

    // Update XY Plot (Main) -> now xy Plane
    if (main_plot) {
        main_plot.set_labels(getLabel(nx, "x"), getLabel(ny, "y"));
    }

    // Update XZ Plot -> now xz Plane
    if (main_plot_xz) {
        main_plot_xz.set_labels(getLabel(nx, "x"), getLabel(nz, "z"));
    }

    // Update YZ Plot -> now zy Plane
    if (main_plot_yz) {
        main_plot_yz.set_labels(getLabel(nz, "z"), getLabel(ny, "y"));
    }

    // Update Projections
    if (main_plot_proj) {
        main_plot_proj.set_labels(getLabel(nx, "x"), getLabel(ny, "y"));
    }
    if (main_plot_proj_y) {
        main_plot_proj_y.set_labels(getLabel(nx, "x"), getLabel(nz, "z"));
    }
    if (main_plot_proj_x) {
        main_plot_proj_x.set_labels(getLabel(ny, "y"), getLabel(nz, "z"));
    }

    // Update 1D trace labels based on the newly updated axes
    update_1d_traces_from_center();
}

/**
 * Clears 3D log.
 */
function clear_3d_log() {
    const logElem = document.getElementById("log");
    if (!logElem) {
        return;
    }
    logElem.value = "";
}

/**
 * Toggles log minimize.
 */
function toggle_log_minimize() {
    const log_area = document.getElementById('log_area_3d');
    const log_textarea = document.getElementById('log');
    const min_btn = document.getElementById('button_minimize_log_3d');

    if (!log_area || !log_textarea || !min_btn) return;

    if (log_textarea.style.display === 'none') {
        log_textarea.style.display = 'block';
        log_area.style.height = log_area.dataset.lastHeight || '250px';
        log_area.style.width = log_area.dataset.lastWidth || '450px';
        log_area.style.resize = 'both';
        min_btn.innerText = '—';
    } else {
        log_area.dataset.lastHeight = log_area.offsetHeight + 'px';
        log_area.dataset.lastWidth = log_area.offsetWidth + 'px';
        log_textarea.style.display = 'none';
        log_area.style.height = 'auto';
        log_area.style.width = '250px';
        log_area.style.resize = 'none';
        min_btn.innerText = '□';
    }
}

/**
 * Makes log movable.
 */
function make_log_movable() {
    const log_area = document.getElementById("log_area_3d");
    const header = document.getElementById("log_area_3d_header");
    if (!log_area || !header) return;

    let startX, startY, initialLeft, initialTop;

    header.onmousedown = function (e) {
        e = e || window.event;
        e.preventDefault();

        // Initial mouse position
        startX = e.clientX;
        startY = e.clientY;

        // Current element position
        let rect = log_area.getBoundingClientRect();
        initialLeft = rect.left;
        initialTop = rect.top;

        document.onmouseup = function () {
            document.onmouseup = null;
            document.onmousemove = null;
        };

        document.onmousemove = function (e) {
            e = e || window.event;
            e.preventDefault();

            // Calculate distance moved
            let dx = e.clientX - startX;
            let dy = e.clientY - startY;

            // Apply new position
            log_area.style.top = (initialTop + dy) + "px";
            log_area.style.left = (initialLeft + dx) + "px";
        };
    };
}

// Call this once to init
setTimeout(make_log_movable, 100);

// Helper to convert hex color to normalized RGB array
function hexToRgb(hex) {
    var result = /^#?([a-f\d]{2})([a-f\d]{2})([a-f\d]{2})$/i.exec(hex);
    return result ? [
        parseInt(result[1], 16) / 255.0,
        parseInt(result[2], 16) / 255.0,
        parseInt(result[3], 16) / 255.0,
        1.0
    ] : [0, 0, 0, 1];
}

// Define NUS variables required by some shared workers/code (though not used here)
var nuslist_as_string = "";
var apodization_direct = "";
var phase_correction_indirect_p0 = 0.0;
var phase_correction_indirect_p1 = 0.0;
var apodization_indirect = "";
var zf_indirect = 0;

var mathTool = new ldwmath();

function set_loading_buttons_state(disabled) {
    const ids = [
        'button_fid_process_3d',
        'button_ft2_process',
        'button_ft3_process',
        'button_raw_process',
        'btn_load_theoretical',
        'button_peak_fit_3d'
    ];
    ids.forEach(id => {
        let el = document.getElementById(id);
        if (el) el.disabled = disabled;
    });
}

document.addEventListener('DOMContentLoaded', function () {

    // Load navbar
    $("#navbar-placeholder").load("navbar.html");

    // Initialize Worker
    if (window.Worker) {
        my_contour_worker = new Worker('./js/contour.js');

        my_contour_worker.onmessage = function (e) {
            handle_worker_message(e);
        };
    } else {
        alert("Your browser doesn't support Web Workers. The viewer will not work.");
    }


    // Initialize Plot on window resize
    window.addEventListener('resize', function () {
        if (main_plot) {
            let cr = get_content_size("vis_parent");
            // resize logic from nmrwebview ... simplified here
            // Using manual resize for consistency if needed, but myplot1_new handles update
        }
    });

    // File Upload Handler
    document.getElementById('ft2_file_form').addEventListener('submit', function (e) {
        e.preventDefault();
        load_files();
    });

    let ft3Form = document.getElementById('ft3_file_form');
    if (ft3Form) {
        ft3Form.addEventListener('submit', function (e) {
            e.preventDefault();
            load_ft3_file();
        });
    }

    let rawForm = document.getElementById('raw_file_form');
    if (rawForm) {
        rawForm.addEventListener('submit', function (e) {
            e.preventDefault();
            load_raw_3d_file();
        });
    }

    // Slider Handler
    document.getElementById('slice_slider').addEventListener('input', function (e) {
        let index = parseInt(e.target.value);
        if (index >= 0 && index < spectra_3d.length) {
            draw_slice(index);
        }
    });

    // Previous/Next Slice Buttons
    document.getElementById('prev_slice').addEventListener('click', function () {
        let slider = document.getElementById('slice_slider');
        let val = parseInt(slider.value);
        if (val > 0) {
            slider.value = val - 1;
            slider.dispatchEvent(new Event('input'));
        }
    });

    document.getElementById('next_slice').addEventListener('click', function () {
        let slider = document.getElementById('slice_slider');
        let val = parseInt(slider.value);
        if (val < parseInt(slider.max)) {
            slider.value = val + 1;
            slider.dispatchEvent(new Event('input'));
        }
    });

    document.getElementById('prev_slice_xz').addEventListener('click', function () {
        let slider = document.getElementById('slider_xz');
        let val = parseInt(slider.value);
        if (val > 0) {
            slider.value = val - 1;
            slider.dispatchEvent(new Event('input'));
        }
    });

    document.getElementById('next_slice_xz').addEventListener('click', function () {
        let slider = document.getElementById('slider_xz');
        let val = parseInt(slider.value);
        if (val < parseInt(slider.max)) {
            slider.value = val + 1;
            slider.dispatchEvent(new Event('input'));
        }
    });

    document.getElementById('prev_slice_yz').addEventListener('click', function () {
        let slider = document.getElementById('slider_yz');
        let val = parseInt(slider.value);
        if (val > 0) {
            slider.value = val - 1;
            slider.dispatchEvent(new Event('input'));
        }
    });

    document.getElementById('next_slice_yz').addEventListener('click', function () {
        let slider = document.getElementById('slider_yz');
        let val = parseInt(slider.value);
        if (val < parseInt(slider.max)) {
            slider.value = val + 1;
            slider.dispatchEvent(new Event('input'));
        }
    });

    // Load Theoretical Peaks
    document.getElementById('btn_load_theoretical').addEventListener('click', function () {
        load_theoretical_peaks();
    });
});

var theoretical_peaks_data = []; // Store raw peak data
var partition_bounds_data = null; // Store global partition bounds
var fitted_peaks_text_data = null; // Store raw text of the peak list for download

/**
 * Parses peak text data.
 * @param {string} text - The peak list text.
 * @returns {Array} List of parsed peaks.
 */
function parse_peaks_text(text) {
    let lines = text.split('\n');
    let peaks = [];
    let header_map = null;
    partition_bounds_data = null; // Reset bounds

    for (let line of lines) {
        line = line.trim();

        if (line.startsWith("# Partition Bounds")) {
            let match = line.match(/X\[\s*(\d+)\s*,\s*(\d+)\s*\],\s*Y\[\s*(\d+)\s*,\s*(\d+)\s*\],\s*Z\[\s*(\d+)\s*,\s*(\d+)\s*\]/i);
            if (match) {
                partition_bounds_data = {
                    x: [parseInt(match[1], 10), parseInt(match[2], 10)],
                    y: [parseInt(match[3], 10), parseInt(match[4], 10)],
                    z: [parseInt(match[5], 10), parseInt(match[6], 10)]
                };
                console.log("Parsed partition bounds:", partition_bounds_data);
            }
        }

        if (!line || line.startsWith("#")) continue;

        let parts = line.split(/\s+/);

        // Check for header line
        if (!header_map) {
            let is_format1 = parts.includes("Partition") && parts.includes("Peak") && parts.includes("Amplitude") && parts.includes("X_Center") && parts.includes("X_FWHH");
            let is_format2 = parts.includes("X_Center") && parts.includes("Y_Center") && parts.includes("Z_Center") && parts.includes("X_Center_ppm") && parts.includes("Height");

            if (is_format1 || is_format2) {
                header_map = {};
                parts.forEach((col, idx) => {
                    header_map[col] = idx;
                });
            }
            continue;
        }

        // Skip separator lines or other header-like lines
        if (line.startsWith("=") || line.startsWith("-")) continue;
        if (line.startsWith("Rank") || line.startsWith("Peak")) continue;

        if (header_map) {
            let get_val = (key, default_val = undefined) => {
                let idx = header_map[key];
                if (idx !== undefined && idx < parts.length) {
                    let val = parseFloat(parts[idx]);
                    return isNaN(val) ? default_val : val;
                }
                return default_val;
            };

            let amp = get_val("Amplitude", undefined);
            if (amp === undefined) amp = get_val("Height", undefined);
            if (amp === undefined) continue;

            let x_ppm = get_val("X_Center_ppm", undefined);
            let y_ppm = get_val("Y_Center_ppm", undefined);
            let z_ppm = get_val("Z_Center_ppm", undefined);

            let x_val = get_val("X_Center", undefined);
            let y_val = get_val("Y_Center", undefined);
            let z_val = get_val("Z_Center", undefined);

            let fwhh_x = get_val("X_FWHH", undefined);
            let fwhh_y = get_val("Y_FWHH", undefined);
            let fwhh_z = get_val("Z_FWHH", undefined);

            let lx = get_val("Lx", undefined);
            let ly = get_val("Ly", undefined);
            let lz = get_val("Lz", undefined);

            let has_shape = (fwhh_x !== undefined && fwhh_y !== undefined && fwhh_z !== undefined);

            if (!has_shape) {
                fwhh_x = 2.0;
                fwhh_y = 2.0;
                fwhh_z = 2.0;
                lx = 0.0;
                ly = 0.0;
                lz = 0.0;
            }

            let s0 = spectra_3d[0];
            let p_x = x_val !== undefined ? x_val : 0;
            let p_y = y_val !== undefined ? y_val : 0;
            let p_z = z_val !== undefined ? z_val : 0;

            if (x_ppm !== undefined && s0) {
                p_x = (x_ppm - s0.x_ppm_start) / s0.x_ppm_step;
            }
            if (y_ppm !== undefined && s0) {
                p_y = (y_ppm - s0.y_ppm_start) / s0.y_ppm_step;
            }
            if (z_ppm !== undefined && s0) {
                p_z = (z_ppm - s0.z_ppm_start) / s0.z_ppm_step;
            }

            peaks.push({
                amp: amp,
                x: p_x,
                y: p_y,
                z: p_z,
                x_ppm: x_ppm,
                y_ppm: y_ppm,
                z_ppm: z_ppm,
                fwhh_x: fwhh_x,
                fwhh_y: fwhh_y,
                fwhh_z: fwhh_z,
                lx: lx,
                ly: ly,
                lz: lz,
                has_shape: has_shape
            });
        }
    }
    return peaks;
}

/**
 * Loads theoretical peaks.
 * @returns {Promise<void>}
 */
async function load_theoretical_peaks() {
    let fileInput = document.getElementById('theoretical_peaks_file');
    if (fileInput.files.length === 0) {
        alert("Please select a .txt file first.");
        return;
    }

    if (!spectra_3d || spectra_3d.length === 0) {
        alert("Please load experimental 3D spectrum first to define dimensions.");
        return;
    }

    set_loading_buttons_state(true);
    try {
        let file = fileInput.files[0];
        let text = await file.text();
        let peaks = parse_peaks_text(text);

        if (peaks.length === 0) {
            alert("No valid peaks found in file.");
            return;
        }

        console.log("Loaded " + peaks.length + " theoretical peaks.");
        theoretical_peaks_data = peaks;
        fitted_peaks_text_data = text;
        let dl_btn = document.getElementById("button_download_peaks_list");
        if (dl_btn) dl_btn.disabled = false;
        let toggle_btn = document.getElementById("button_toggle_peak_symbols");
        if (toggle_btn) toggle_btn.disabled = false;

        let has_any_shape = peaks.some(p => p.has_shape);
        if (has_any_shape) {
            console.log("Shape parameters found. Generating theoretical volume.");
            generate_theoretical_volume(peaks);
            generate_projection_spectrum();
        } else {
            console.log("No shape parameters found. Showing peak symbols only.");
            theoretical_spectra_3d = [];
            theoretical_spectrum_xz = null;
            theoretical_spectrum_yz = null;
            theoretical_spectrum_proj = null;
            theoretical_spectrum_proj_y = null;
            theoretical_spectrum_proj_x = null;
        }

        // Refresh views to show overlay
        if (current_slice_index >= 0) {
            draw_slice(current_slice_index);
            refresh_xz_view();
            refresh_yz_view();
            update_3d_crosshairs();
        }

        // Refresh the 3D viewer to show the new peak spheres
        update_3d_view();

        // Clear input to allow re-selecting the same file if needed (triggers change event if used, but also good for UI feedback)
        fileInput.value = '';
    } finally {
        set_loading_buttons_state(false);
    }
}

/**
 * Generates theoretical volume.
 *
 * @param {any} peaks - Peaks
 */
function generate_theoretical_volume(peaks) {
    if (!spectra_3d || spectra_3d.length === 0) return;

    if (current_volume_data) {
        current_volume_data.recon_data = null;
    }

    let s0 = spectra_3d[0];
    let nz = spectra_3d.length;
    let ny = s0.n_indirect;
    let nx = s0.n_direct;

    // Initialize empty volume
    theoretical_spectra_3d = [];
    for (let z = 0; z < nz; z++) {
        let s = new spectrum();
        // Copy params from experimental
        s.n_direct = nx;
        s.n_indirect = ny;
        s.x_ppm_start = s0.x_ppm_start;
        s.x_ppm_step = s0.x_ppm_step;
        s.y_ppm_start = s0.y_ppm_start;
        s.y_ppm_step = s0.y_ppm_step;
        s.z_ppm_start = s0.z_ppm_start;
        s.z_ppm_step = s0.z_ppm_step;

        s.raw_data = new Float32Array(nx * ny);
        s.spectrum_color = document.getElementById('color_theo_pos') ? document.getElementById('color_theo_pos').value : "#ff0000";
        s.spectrum_color_negative = document.getElementById('color_theo_neg') ? document.getElementById('color_theo_neg').value : "#000000";
        s.levels = calculate_levels(s0.noise_level, 1.5, 30);
        s.negative_levels = [];

        theoretical_spectra_3d.push(s);
    }

    // Constants
    const S2L2 = 2.0 * Math.sqrt(2.0 * Math.log(2.0));

    // Helper for 1D Pseudo-Voigt
    function get_pv_val(delta, fwhh, eta) {
        let sig = fwhh / S2L2;
        let gam = fwhh / 2.0;

        let d2 = delta * delta;

        let G = Math.exp(-d2 / (2.0 * sig * sig));
        let L = (gam * gam) / (d2 + (gam * gam));

        return (1.0 - eta) * G + eta * L;
    }

    for (let p of peaks) {
        // Bounding box
        // Use FWHH to determine bounds. 3 * FWHH covers significant area
        let bound_mult = 3.0;

        let wx = p.fwhh_x;
        let wy = p.fwhh_y;
        let wz = p.fwhh_z;

        let z_start = Math.max(0, Math.floor(p.z - bound_mult * wz));
        let z_end = Math.min(nz - 1, Math.ceil(p.z + bound_mult * wz));

        let y_start = Math.max(0, Math.floor(p.y - bound_mult * wy));
        let y_end = Math.min(ny - 1, Math.ceil(p.y + bound_mult * wy));

        let x_start = Math.max(0, Math.floor(p.x - bound_mult * wx));
        let x_end = Math.min(nx - 1, Math.ceil(p.x + bound_mult * wx));

        for (let z = z_start; z <= z_end; z++) {
            let dz = z - p.z;
            let val_z = get_pv_val(dz, wz, p.lz);
            if (val_z < 0.001) continue; // Optimization

            let s_data = theoretical_spectra_3d[z].raw_data;

            for (let y = y_start; y <= y_end; y++) {
                let dy = y - p.y;
                let val_y = get_pv_val(dy, wy, p.ly);
                if (val_y < 0.001) continue;

                let row_offset = y * nx;
                let combined_zy = p.amp * val_z * val_y;

                for (let x = x_start; x <= x_end; x++) {
                    let dx = x - p.x;
                    let val_x = get_pv_val(dx, wx, p.lx);

                    s_data[row_offset + x] += combined_zy * val_x;
                }
            }
        }
    }
}


/**
 * Handle messages from the contour worker
 */
function handle_worker_message(e) {
    if (e.data.message) {
        let statusType = e.data.spectrum_type || "full";
        // Ignore transient worker status from orthogonal/XZ/YZ recalculations triggered by zoom/pan.
        if (statusType === "xz" || statusType === "yz" || statusType === "xz_theo" || statusType === "yz_theo") {
            return;
        }

        // Guard against stale worker status text that may otherwise remain indefinitely.
        set_status_message("contour_message", e.data.message, 10000);
        return;
    }

    // Receive contour data
    if (e.data.points) {

        // Check spectrum_type for Orthogonal Plots
        if (e.data.spectrum_type === "xz") {
            handle_ortho_response(e.data, "xz");
            return;
        }
        if (e.data.spectrum_type === "yz") {
            handle_ortho_response(e.data, "yz");
            return;
        }

        // Ortho Theoretical
        if (e.data.spectrum_type === "xz_theo") {
            handle_ortho_response(e.data, "xz_theo");
            return;
        }
        if (e.data.spectrum_type === "yz_theo") {
            handle_ortho_response(e.data, "yz_theo");
            return;
        }

        if (e.data.spectrum_type === "proj") {
            handle_proj_response(e.data, "proj");
            return;
        }

        if (e.data.spectrum_type === "proj_theo") {
            handle_proj_response(e.data, "proj_theo");
            return;
        }

        if (e.data.spectrum_type === "proj_y") {
            handle_proj_y_response(e.data, "proj_y");
            return;
        }

        if (e.data.spectrum_type === "proj_y_theo") {
            handle_proj_y_response(e.data, "proj_y_theo");
            return;
        }

        if (e.data.spectrum_type === "proj_x") {
            handle_proj_x_response(e.data, "proj_x");
            return;
        }

        if (e.data.spectrum_type === "proj_x_theo") {
            handle_proj_x_response(e.data, "proj_x_theo");
            return;
        }

        let slice_idx = e.data.spectrum_index; // We passed slice index as spectrum_index

        let spec = null;
        if (e.data.spectrum_type === "theoretical") {
            if (slice_idx < 0 || slice_idx >= theoretical_spectra_3d.length) return;
            spec = theoretical_spectra_3d[slice_idx];
        } else {
            if (slice_idx < 0 || slice_idx >= spectra_3d.length) return;
            spec = spectra_3d[slice_idx];
        }

        if (!spec) return;

        // Cache the contour data in the spectrum object
        spec.cached_contour = {
            points: e.data.points,
            polygon_length: e.data.polygon_length,
            levels_length: e.data.levels_length,
            contour_lbs: 0, // default start at level 0
            points_start: 0 // single spectrum start at 0
        };

        if (e.data.contour_sign === 0) {
            spec.cached_contour_pos = e.data;
        } else {
            spec.cached_contour_neg = e.data;
        }

        // Check if this is the currently displayed slice
        if (slice_idx === current_slice_index) {
            // For theoretical, we just refresh the view which pulls from both
            // If experimental, same thing.
            refresh_current_view(spectra_3d[current_slice_index]);
        }

        clear_status_message("contour_message");
    }
}

/**
 * Draws slice.
 *
 * @param {any} index - Index
 * @param {boolean} [update_ortho_views] - Update orthogonal views Default is true.
 */
function draw_slice(index, update_ortho_views = true) {
    current_slice_index = index;
    let s = spectra_3d[index];

    // Update the global hsqc_spectra for the main plot
    hsqc_spectra = [s];
    s.visible = true; // Ensure visibility for WebGL renderer
    s.spectrum_index = 0; // It's always the 0-th element in this view

    if (main_plot) {
        main_plot.local_spectra = hsqc_spectra;
    }

    // Update slice info display
    let ppm_z = s.z_ppm_start + (index * s.z_ppm_step);
    document.getElementById('slice_info').innerText = `${index + 1}/${spectra_3d.length} (${ppm_z.toFixed(3)} ppm)`;

    // Draw contour if we have it
    if (s.cached_contour_pos && s.cached_contour_neg) { // Check for both positive and negative
        refresh_current_view(s);
        update_3d_crosshairs();
        clear_status_message("contour_message");
    } else {
        // Request it
        set_status_message("contour_message", "Loading contour...", 10000);
        request_contour_calculation(s, index, 0); // Positive levels
        request_contour_calculation(s, index, 1); // Negative levels

        // Also update crosshairs immediately even if contour is loading
        update_3d_crosshairs();
    }

    // Request Theoretical Contour if available
    if (theoretical_spectra_3d && theoretical_spectra_3d.length > index) {
        let st = theoretical_spectra_3d[index];
        if (st) {
            // We use a special origin ID or just rely on index/object identity?
            // worker returns spectrum_index. We need to distinguish exp vs theo.
            // modify request_contour_calculation to accept 'type' or similar?
            // Or better, attach a flag to the spectrum object and check it in handle_worker_message?
            // The worker message passes 'spectrum_index'.
            // Let's rely on a custom property in the request.
            request_contour_calculation(st, index, 0, "theoretical");
        }
    }

    // Pan orthogonal plots to center on Z slice ONLY if requested (to avoid loops)
    // This must happen REGARDLESS of whether the slice was cached or newly requested
    if (update_ortho_views === true && s.z_ppm_start !== undefined && s.z_ppm_step !== undefined) {
        let z_ppm = s.z_ppm_start + (index * s.z_ppm_step);

        // XZ Plot: Z is Y-axis
        if (main_plot_xz) {
            main_plot_xz.pan_to_center_ppm('y', z_ppm);
        }

        // YZ Plot: Z is X-axis
        if (main_plot_yz) {
            main_plot_yz.pan_to_center_ppm('x', z_ppm);
        }
    }

    // Visualize Theoretical Peaks on 2D Plot
    if (main_plot) {
        if (show_peak_symbols && typeof theoretical_peaks_data !== 'undefined' && theoretical_peaks_data.length > 0) {
            let visible_peaks = [];
            // Z-Index is 'index'. 
            // Peak.z is in index units (if parsed as such? No, it seemed to be index/ppm mixed in user's file...)
            // In the parsing logic: 'z' was parsed from 'Z_Center'. 
            // User file: "Z_Center" = 24.047615. "Partition_Index" = 7. 
            // Wait, is Z_Center index or ppm? 
            // In `generate_theoretical_volume`: `let z_start = Math.max(0, Math.floor(p.z - bound_mult * wz));`
            // This implies p.z is treated as index coordinate for the volume generation loop `for (let z = 0; z < nz; z++)`.
            // So p.z IS index-based coordinate (or at least used directly against slice index).
            // Let's assume p.z explains the slice index.

            // Also note: we need Z Width for the condition.
            // User said: "show filled circle if peak Z < current Z but within Z_width"
            // "show square if Z within +-1 of current Z"
            // "show cross if peak Z > current Z but within Z_width"

            let current_z = index;

            for (let p of theoretical_peaks_data) {
                let diff = p.z - current_z;
                let abs_diff = Math.abs(diff);

                // Width. Using FWHH_Z (in index units?)
                // If z is index, fwhh_z should be too.
                let width = p.fwhh_z; // Z_FWHH
                // Define a range of visibility. Maybe 2 * width? Or just width?
                // User said "within Z_width". Let's assume "distance <= width".

                let symbol_color = document.getElementById('color_peak_symbol') ? document.getElementById('color_peak_symbol').value : 'cyan';
                if (abs_diff <= 1.0) {
                    // Square
                    visible_peaks.push({
                        x: p.x_ppm !== undefined ? p.x_ppm : (s.x_ppm_start + p.x * s.x_ppm_step),
                        y: p.y_ppm !== undefined ? p.y_ppm : (s.y_ppm_start + p.y * s.y_ppm_step),
                        symbol: 'square',
                        color: symbol_color,
                        size: 6,
                        fill: false
                    });
                } else if (Math.abs(diff) <= width) {
                    if (diff < 0) {
                        // Peak Z < Current Z -> Filled Circle
                        visible_peaks.push({
                            x: p.x_ppm !== undefined ? p.x_ppm : (s.x_ppm_start + p.x * s.x_ppm_step),
                            y: p.y_ppm !== undefined ? p.y_ppm : (s.y_ppm_start + p.y * s.y_ppm_step),
                            symbol: 'circle',
                            color: symbol_color,
                            size: 5,
                            fill: true
                        });
                    } else {
                        // Peak Z > Current Z -> Cross
                        visible_peaks.push({
                            x: p.x_ppm !== undefined ? p.x_ppm : (s.x_ppm_start + p.x * s.x_ppm_step),
                            y: p.y_ppm !== undefined ? p.y_ppm : (s.y_ppm_start + p.y * s.y_ppm_step),
                            symbol: 'cross',
                            color: symbol_color,
                            size: 5,
                            fill: false
                        });
                    }
                }
            }
            main_plot.add_extra_peaks(visible_peaks);
        } else {
            main_plot.add_extra_peaks([]);
        }
    }

    if (typeof partition_bounds_data !== "undefined" && partition_bounds_data !== null) {
        let x0 = s.x_ppm_start + partition_bounds_data.x[0] * s.x_ppm_step;
        let x1 = s.x_ppm_start + partition_bounds_data.x[1] * s.x_ppm_step;
        let y0 = s.y_ppm_start + partition_bounds_data.y[0] * s.y_ppm_step;
        let y1 = s.y_ppm_start + partition_bounds_data.y[1] * s.y_ppm_step;

        if (current_z >= partition_bounds_data.z[0] && current_z <= partition_bounds_data.z[1]) {
            main_plot.draw_bounding_box(x0, x1, y0, y1, 'red');
        } else {
            main_plot.draw_bounding_box(); // Clear
        }
    } else {
        if (main_plot.draw_bounding_box) main_plot.draw_bounding_box();
    }
}


/**
 * Handles orthogonal response.
 *
 * @param {any} data - Data
 * @param {any} type - Type
 */
function handle_ortho_response(data, type) {
    let spec = (type === "xz") ? spectrum_xz :
        (type === "yz") ? spectrum_yz :
            (type === "xz_theo") ? theoretical_spectrum_xz : theoretical_spectrum_yz;

    if (!spec) return;

    if (data.contour_sign === 0) {
        spec.cached_contour_pos = data;
    } else {
        spec.cached_contour_neg = data;
    }

    // Refresh the ortho view if we have data
    // We can do it immediately or wait for both? 
    // refresh_ortho_plot can handle partial data
    if (type === "xz_theo") refresh_ortho_plot("xz");
    else if (type === "yz_theo") refresh_ortho_plot("yz");
    else refresh_ortho_plot(type);
}

/**
 * Refreshes orthogonal plot for xz and yz slices.
 * Function draw_slice  draw xy slice of the 3D spectrum
 *
 * @param {any} type - Type
 */
function refresh_ortho_plot(type) {
    let plot = (type === "xz") ? main_plot_xz : main_plot_yz;
    let spec = (type === "xz") ? spectrum_xz : spectrum_yz;

    if (!plot || !spec) return;

    // Similar logic to refresh_current_view

    let points_pos = spec.cached_contour_pos ? spec.cached_contour_pos.points : new Float32Array([]);
    if (!(points_pos instanceof Float32Array)) points_pos = new Float32Array(points_pos);

    let len_pos = spec.cached_contour_pos ? [spec.cached_contour_pos.levels_length] : [[]];
    let poly_pos = spec.cached_contour_pos ? [spec.cached_contour_pos.polygon_length] : [[]];

    let points_neg = spec.cached_contour_neg ? spec.cached_contour_neg.points : new Float32Array([]);
    if (!(points_neg instanceof Float32Array)) points_neg = new Float32Array(points_neg);

    let len_neg = spec.cached_contour_neg ? [spec.cached_contour_neg.levels_length] : [[]];
    let poly_neg = spec.cached_contour_neg ? [spec.cached_contour_neg.polygon_length] : [[]];

    let color_pos = [hexToRgb(spec.spectrum_color)];
    let color_neg = [hexToRgb(spec.spectrum_color_negative)];
    let lbs_pos = [0];
    let lbs_neg = [0];
    let start_pos = [0];
    let combined_points = Float32Concat(points_pos, points_neg);
    let start_neg = [points_pos.length];

    let spectral_info = [{
        x_ppm_start: spec.x_ppm_start,
        x_ppm_step: spec.x_ppm_step,
        y_ppm_start: spec.y_ppm_start,
        y_ppm_step: spec.y_ppm_step,
        x_ppm_ref: 0,
        y_ppm_ref: 0
    }];

    plot.contour_plot.spectral_order = [0];

    plot.contour_plot.set_data(
        spectral_info,
        combined_points,
        start_pos,
        poly_pos,
        len_pos,
        color_pos,
        lbs_pos,
        start_neg,
        poly_neg,
        len_neg,
        color_neg,
        lbs_neg
    );

    // Sync Camera for initial view if needed (or if zoomed)
    // Maybe checking if domain is set?
    let x_dom = plot.xRange.domain();
    let y_dom = plot.yRange.domain();

    // If domain is wildly off (default [0,1]), enable auto-zoom
    // plotit initializes heavily. 
    // We should call plot.reset_axis() somewhere too.

    plot.contour_plot.setCamera_ppm(x_dom[0], x_dom[1], y_dom[0], y_dom[1]);
    plot.contour_plot.drawScene();

    // Ensure axis is drawn/updated
    // plot.reset_axis() requires valid scales. 
    // plotit usually sets scales in set_data or zoom?
    // We might need to call plot.zoom(x_range, y_range) first?
    // plotit class is complex.
    // Let's assume user manually zooms or we force full view.
    // Spec ranges:
    if (spec.raw_data && spec.raw_data.length > 0) { // First time setup?
        // We might want to force zoom to full range
        // X range: x_ppm_start .. x_ppm_start + n*step
        // Y range: y_ppm_start .. y_ppm_start + n*step

        let x_end = spec.x_ppm_start + spec.n_direct * spec.x_ppm_step;
        let y_end = spec.y_ppm_start + spec.n_indirect * spec.y_ppm_step;

        // Check if current ranges are default/empty
        // Actually, let's just update the contour. If user zooms, plotit handles it.
        // But we need to ensure plotit *knows* the range.

        // plotit usually relies on hsqc_spectra... but we are bypassing it partially.
        // Wait, plotit.draw() sets scales from hsqc_spectra?
        // If so, we are in trouble.

        // Let's check myplot1_new.js lines 622-630.
        // this.xRange.domain(this.xscale);
        // this.xscale is initialized?

        // If plotit usage is problematic, we might need a dummy hsqc_spectra for each plot?
        // That's too complex.

    }
}

/**
 * Loads FT3 file.
 * @returns {Promise<void>}
 */
async function load_ft3_file() {
    let fileInput = document.getElementById('userfile_ft3');
    let files = Array.from(fileInput.files);

    if (files.length === 0) {
        alert("Please select a .ft3 file.");
        return;
    }

    set_loading_buttons_state(true);
    try {
        let file = files[0];
        document.getElementById("webassembly_message").innerText = "Loading " + file.name + "...";

        // Reset state
        reset_3d_dataset_state();

        let headerBlob = file.slice(0, 2048);
        let headerBuffer;
        try {
            headerBuffer = await read_file_as_buffer(headerBlob);
        } catch (err) {
            console.error("Error reading file header " + file.name, err);
            return;
        }

        if (headerBuffer.byteLength < 2048) {
            alert("File is too small to be a valid .ft3 file.");
            return;
        }

        // Parse header to understand plane sizes
        let header = new Float32Array(headerBuffer, 0, 512);
        let n_direct = header[99];
        let n_indirect = header[219];
        let data_types = [header[55], header[56], header[51], header[54]];
        let dimorder1 = header[24];
        let dimorder2 = header[25];
        let datatype_direct = data_types[dimorder1 - 1];
        let datatype_indirect = data_types[dimorder2 - 1];

        let parts = 1;
        if (datatype_direct === 0) parts++;
        if (datatype_indirect === 0) parts++;
        if (datatype_direct === 0 && datatype_indirect === 0) parts++;

        let n_indirect_loops = n_indirect;
        if (datatype_direct === 0 && datatype_indirect === 0) n_indirect_loops /= 2;

        let plane_float_count = n_indirect_loops * n_direct * parts;
        let plane_byte_size = plane_float_count * 4;

        if (plane_byte_size <= 0) {
            alert("Could not derive plane size from .ft3 header.");
            return;
        }

        let total_data_bytes = file.size - 2048;

        // Prefer header-declared plane count when valid; fall back to payload-derived count.
        let header_plane_count = Math.round(header[15]); // FDF3SIZE
        let num_planes = (Number.isFinite(header_plane_count) && header_plane_count > 0)
            ? header_plane_count
            : Math.floor(total_data_bytes / plane_byte_size);

        if (!Number.isFinite(num_planes) || num_planes <= 0) {
            alert("Could not determine the number of planes from .ft3 file.");
            return;
        }

        // Some generated .ft3 files include an extra 2048-byte block before the first plane payload.
        // If detected, shift the data start so plane 0 maps to the real first XY slice.
        let data_start_offset = 2048;
        let residual_bytes = total_data_bytes - num_planes * plane_byte_size;
        if (residual_bytes === 2048) {
            data_start_offset += 2048;
            console.warn("Detected extra 2048-byte block before FT3 plane data; adjusting data start offset.");
        }

        document.getElementById("webassembly_message").innerText = "Processing " + num_planes + " planes from .ft3 file...";

        let headerUint8 = new Uint8Array(headerBuffer);

        for (let i = 0; i < num_planes; i++) {
            try {
                let start_offset = data_start_offset + i * plane_byte_size;
                let planeBlob = file.slice(start_offset, start_offset + plane_byte_size);
                let planeDataBuffer = await read_file_as_buffer(planeBlob);

                if (planeDataBuffer.byteLength < plane_byte_size) {
                    console.warn("Skipping incomplete FT3 plane " + i + ": expected " + plane_byte_size + " bytes, got " + planeDataBuffer.byteLength + ".");
                    continue;
                }

                let plane_buffer = new ArrayBuffer(2048 + plane_byte_size);
                let dst = new Uint8Array(plane_buffer);

                // Header
                dst.set(headerUint8, 0);

                // Data
                dst.set(new Uint8Array(planeDataBuffer), 2048);

                let s = new spectrum();
                let plane_name = "plane_" + String(i + 1).padStart(3, '0');
                s.process_ft_file(plane_buffer, plane_name, -1);

                s.levels = calculate_levels(s.noise_level, 1.5, 30);
                s.negative_levels = calculate_negative_levels(s.noise_level, 1.5, 30);
                s.spectrum_color = document.getElementById('color_exp_pos') ? document.getElementById('color_exp_pos').value : "#0000ff";
                s.spectrum_color_negative = document.getElementById('color_exp_neg') ? document.getElementById('color_exp_neg').value : "#00ff00";
                s.visible = true;

                spectra_3d.push(s);
            } catch (err) {
                console.error("Error creating plane " + i, err);
            }
        }

        if (spectra_3d.length > 0) {
            let slider = document.getElementById('slice_slider');
            slider.max = spectra_3d.length - 1;
            slider.value = 0;
            document.getElementById('slice_control_area').style.display = 'block';
            document.getElementById('aux_buttons').style.display = 'block'; // Or hide if not needed
            document.getElementById('main_plot_area').style.display = 'flex';

            // Clear projection state for new dataset
            spectrum_proj = null; spectrum_proj_y = null; spectrum_proj_x = null;
            main_plot_proj = null; main_plot_proj_y = null; main_plot_proj_x = null;

            extract_nuclei_from_spectrum(spectra_3d[0]);
            // Initialize the main plot now that we have data dimensions from the first slice
            init_main_plot(spectra_3d[0]);

            update_global_noise_level();
            // Draw first slice
            draw_slice(0);

            if (document.getElementById('normal_direct_dim_auto_phase_3d') && document.getElementById('normal_direct_dim_auto_phase_3d').checked) {
                run_auto_phase_on_loaded_spectrum();
            }

            // Sync projection view if checked
            const projChecked = !!(document.getElementById('check_visualize_proj') && document.getElementById('check_visualize_proj').checked);
            if (projChecked) {
                toggle_visualize_proj(true);
            }
        }

        document.getElementById("webassembly_message").innerText = "";
    } finally {
        set_loading_buttons_state(false);
    }
}

/**
 * Loads raw 3D file.
 * @returns {Promise<void>}
 */
async function load_raw_3d_file() {
    let fileInput = document.getElementById('userfile_raw');
    if (fileInput.files.length === 0) {
        alert("Please select a raw binary 3D file.");
        return;
    }

    set_loading_buttons_state(true);
    try {
        let file = fileInput.files[0];
        document.getElementById("webassembly_message").innerText = "Loading raw " + file.name + "...";

        // Reset state
        reset_3d_dataset_state();

        let buffer = await read_file_as_buffer(file);
        let floatData = new Float32Array(buffer);

        if (floatData.length < 3) {
            alert("File is too small to be a valid raw 3D file.");
            return;
        }

        // Parse header
        let n_direct = Math.round(floatData[0]);
        let n_indirect1 = Math.round(floatData[1]);
        let n_indirect2 = Math.round(floatData[2]);

        console.log(`Raw 3D dimensions: ${n_direct} x ${n_indirect1} x ${n_indirect2}`);

        // Payload starts after the 3-value header
        let payload = floatData.subarray(3);

        // Figure out if we have imaginary data (along direct dimension) by checking file size
        let n_total_real = n_indirect2 * n_indirect1 * n_direct;
        let n_total_real_imag = n_indirect2 * n_indirect1 * (2 * n_direct);

        let has_imaginary = (payload.length >= n_total_real_imag);
        let stride = has_imaginary ? 2 * n_direct : n_direct;

        console.log(`Payload length: ${payload.length}. Has imaginary: ${has_imaginary}`);

        for (let p = 0; p < n_indirect2; p++) {
            try {
                let s = new spectrum();
                s.n_direct = n_direct;
                s.n_indirect = n_indirect1;
                s.filename = `plane_${String(p).padStart(3, '0')}`;

                // Extract data for this plane
                // Payload layout: Plane-major, then Trace-major. 
                // Each trace: n_direct real values, followed by n_direct imaginary values (if present).
                let plane_raw_data = new Float32Array(n_indirect1 * n_direct);
                let plane_raw_data_ri = has_imaginary ? new Float32Array(n_indirect1 * n_direct) : null;
                let plane_offset = p * n_indirect1 * stride;

                for (let t = 0; t < n_indirect1; t++) {
                    let trace_offset = plane_offset + t * stride;
                    if (trace_offset + n_direct <= payload.length) {
                        let real_block = payload.subarray(trace_offset, trace_offset + n_direct);
                        plane_raw_data.set(real_block, t * n_direct);
                    }
                    if (has_imaginary && (trace_offset + 2 * n_direct <= payload.length)) {
                        let imag_block = payload.subarray(trace_offset + n_direct, trace_offset + 2 * n_direct);
                        plane_raw_data_ri.set(imag_block, t * n_direct);
                    }
                }

                s.raw_data = plane_raw_data;
                if (has_imaginary) {
                    s.raw_data_ri = plane_raw_data_ri;
                }

                // Use indices as PPM values
                s.x_ppm_start = 0;
                s.x_ppm_step = 1;
                s.y_ppm_start = 0;
                s.y_ppm_step = 1;
                s.z_ppm_start = 0;
                s.z_ppm_step = 1;

                // Fill placeholder header values
                s.header = new Float32Array(512);
                s.header[99] = n_direct;   // FDSIZE
                s.header[219] = n_indirect1; // FDSPECNUM
                s.header[15] = n_indirect2; // FDF3SIZE

                // Set data type: 0 for complex, 1 for real
                // header[56] is FDF2QUADFLAG (direct dimension)
                // header[55] is FDF1QUADFLAG (indirect dimension)
                s.header[56] = has_imaginary ? 0 : 1;
                s.header[55] = 1; // Assume real for indirect for now in raw format

                // Dimension orders
                s.header[24] = 2; // direct
                s.header[25] = 1; // indirect 1
                s.header[26] = 3; // indirect 2

                // Common spectrum processing (noise estimation, max/min, projections)
                s.process_spectrum_common_task();

                // Set visual defaults
                s.levels = calculate_levels(s.noise_level, 1.4, 30);
                s.negative_levels = calculate_negative_levels(s.noise_level, 1.4, 30);
                s.spectrum_color = document.getElementById('color_exp_pos') ? document.getElementById('color_exp_pos').value : "#0000ff";
                s.spectrum_color_negative = document.getElementById('color_exp_neg') ? document.getElementById('color_exp_neg').value : "#00ff00";
                s.visible = true;

                spectra_3d.push(s);
            } catch (err) {
                console.error("Error processing raw plane " + p, err);
            }
        }

        if (spectra_3d.length > 0) {
            let slider = document.getElementById('slice_slider');
            slider.max = spectra_3d.length - 1;
            slider.value = 0;
            document.getElementById('slice_control_area').style.display = 'block';
            document.getElementById('aux_buttons').style.display = 'block';
            document.getElementById('main_plot_area').style.display = 'flex';

            // Initialize the main plot with dimensions from the first slice
            init_main_plot(spectra_3d[0]);

            update_global_noise_level();
            // Draw first slice
            draw_slice(0);

            if (document.getElementById('normal_direct_dim_auto_phase_3d') && document.getElementById('normal_direct_dim_auto_phase_3d').checked) {
                run_auto_phase_on_loaded_spectrum();
            }

            // Sync projection view if checked
            const projChecked = !!(document.getElementById('check_visualize_proj') && document.getElementById('check_visualize_proj').checked);
            if (projChecked) {
                toggle_visualize_proj(true);
            }
        }

        document.getElementById("webassembly_message").innerText = "";
    } finally {
        set_loading_buttons_state(false);
    }
}

/**
 * Loads files.
 * @returns {Promise<void>}
 */
async function load_files() {
    let fileInput = document.getElementById('userfile');
    let files = Array.from(fileInput.files);

    if (files.length === 0) {
        alert("Please select at least one .ft2 file.");
        return;
    }

    set_loading_buttons_state(true);
    try {
        document.getElementById("webassembly_message").innerText = "Loading and sorting " + files.length + " files...";

        // Reset state
        reset_3d_dataset_state();

        // Sort files alphabetically by name to ensure correct Z ordering
        files.sort((a, b) => a.name.localeCompare(b.name));

        // Process each file
        for (let i = 0; i < files.length; i++) {
            let file = files[i];
            try {
                let buffer = await read_file_as_buffer(file);
                let s = new spectrum();
                // process_ft_file(buffer, filename, origin)
                // origin usually -1 for experimental. We use i to track it temporarily or just arbitrary ID.
                s.process_ft_file(buffer, file.name, -1);

                // Set some defaults
                s.levels = calculate_levels(s.noise_level, 1.5, 30);
                s.negative_levels = calculate_negative_levels(s.noise_level, 1.5, 30);
                s.spectrum_color = document.getElementById('color_exp_pos') ? document.getElementById('color_exp_pos').value : "#0000ff";
                s.spectrum_color_negative = document.getElementById('color_exp_neg') ? document.getElementById('color_exp_neg').value : "#00ff00";
                s.visible = true;

                spectra_3d.push(s);
            } catch (err) {
                console.error("Error reading file " + file.name, err);
            }
        }

        if (spectra_3d.length > 0) {
            // Setup slider
            let slider = document.getElementById('slice_slider');
            slider.max = spectra_3d.length - 1;
            slider.value = 0;
            document.getElementById('slice_control_area').style.display = 'block';
            document.getElementById('aux_buttons').style.display = 'block'; // Or hide if not needed
            document.getElementById('main_plot_area').style.display = 'flex';

            extract_nuclei_from_spectrum(spectra_3d[0]);
            // Initialize the main plot now that we have data dimensions from the first slice
            init_main_plot(spectra_3d[0]);

            update_global_noise_level();
            // Draw first slice
            draw_slice(0);

            // Trigger auto-phase if requested
            if (document.getElementById('normal_direct_dim_auto_phase_3d') && document.getElementById('normal_direct_dim_auto_phase_3d').checked) {
                run_auto_phase_on_loaded_spectrum();
            }

            // Sync projection view if checked
            const projChecked = !!(document.getElementById('check_visualize_proj') && document.getElementById('check_visualize_proj').checked);
            if (projChecked) {
                toggle_visualize_proj(true);
            }
        }

        document.getElementById("webassembly_message").innerText = "";
    } finally {
        set_loading_buttons_state(false);
    }
}

/**
 * Reads file as buffer.
 *
 * @param {any} file - File
 */
function read_file_as_buffer(file) {
    return new Promise((resolve, reject) => {
        let reader = new FileReader();
        reader.onload = (e) => resolve(e.target.result);
        reader.onerror = (e) => reject(e);
        reader.readAsArrayBuffer(file);
    });
}

/**
 * Calculates levels.
 *
 * @param {any} noise - Noise
 * @param {any} scale - Scale
 * @param {any} count - Count
 * @param {any} [multiplier_val] - Multiplier value Default is null.
 * @param {any} [scale_val] - Scale value Default is null.
 */
function calculate_levels(noise, scale, count, multiplier_val = null, scale_val = null) {
    let levels = [];
    let multiplier = 10.0;
    if (multiplier_val !== null) {
        multiplier = multiplier_val;
    } else {
        let multiplier_input = document.getElementById('contour_start_multiplier');
        if (multiplier_input) {
            multiplier = parseFloat(multiplier_input.value);
        }
    }
    let user_scale = scale;
    if (scale_val !== null) {
        user_scale = scale_val;
    } else {
        let scale_input = document.getElementById('contour_scale_factor');
        if (scale_input) {
            user_scale = parseFloat(scale_input.value);
        }
    }

    let current = noise * multiplier;
    for (let i = 0; i < count; i++) {
        levels.push(current);
        current *= user_scale;
    }
    return levels;
}

/**
 * Calculates negative levels.
 *
 * @param {any} noise - Noise
 * @param {any} scale - Scale
 * @param {any} count - Count
 * @param {any} [multiplier_val] - Multiplier value Default is null.
 * @param {any} [scale_val] - Scale value Default is null.
 */
function calculate_negative_levels(noise, scale, count, multiplier_val = null, scale_val = null) {
    let levels = calculate_levels(noise, scale, count, multiplier_val, scale_val);
    for (let i = 0; i < levels.length; i++) {
        levels[i] = -levels[i];
    }
    return levels;
}

/**
 * Updates global noise level.
 */
function update_global_noise_level() {
    if (!spectra_3d || spectra_3d.length === 0) return;
    let noise_levels = [];
    for (let s of spectra_3d) {
        if (s.noise_level) {
            noise_levels.push(s.noise_level);
        }
    }
    if (noise_levels.length === 0) return;
    const sorted = [...noise_levels].sort((a, b) => a - b);
    const mid = Math.floor(sorted.length / 2);
    global_3d_noise = sorted.length % 2 !== 0 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
    evaluate_global_noise_redefinition();
    update_contour_levels();
}

/**
 * Updates contour levels.
 */
function update_contour_levels() {
    let multiplier = parseFloat(document.getElementById('contour_start_multiplier').value);
    let scale = parseFloat(document.getElementById('contour_scale_factor').value);

    if (isNaN(multiplier) || isNaN(scale)) {
        alert("Please enter valid numbers for contour levels.");
        return;
    }

    let color_exp_pos = document.getElementById('color_exp_pos') ? document.getElementById('color_exp_pos').value : "#0000ff";
    let color_exp_neg = document.getElementById('color_exp_neg') ? document.getElementById('color_exp_neg').value : "#00ff00";
    let color_theo_pos = document.getElementById('color_theo_pos') ? document.getElementById('color_theo_pos').value : "#ff0000";
    let color_theo_neg = document.getElementById('color_theo_neg') ? document.getElementById('color_theo_neg').value : "#000000";

    // Update all slices
    for (let s of spectra_3d) {
        s.spectrum_color = color_exp_pos;
        s.spectrum_color_negative = color_exp_neg;
        s.levels = calculate_levels(global_3d_noise, scale, 30);
        s.negative_levels = calculate_negative_levels(global_3d_noise, scale, 30);
        // Invalidate cache to force recalculation
        s.cached_contour_pos = null;
        s.cached_contour_neg = null;
    }

    if (theoretical_spectra_3d) {
        for (let s of theoretical_spectra_3d) {
            s.spectrum_color = color_theo_pos;
            s.spectrum_color_negative = color_theo_neg;
            s.levels = calculate_levels(global_3d_noise, scale, 30);
            s.negative_levels = calculate_negative_levels(global_3d_noise, scale, 30);
            s.cached_contour_pos = null;
            s.cached_contour_neg = null;
        }
    }

    // Also update orthogonal spectra
    if (spectrum_xz) {
        spectrum_xz.spectrum_color = color_exp_pos;
        spectrum_xz.spectrum_color_negative = color_exp_neg;
        spectrum_xz.levels = calculate_levels(global_3d_noise, scale, 30);
        spectrum_xz.negative_levels = calculate_negative_levels(global_3d_noise, scale, 30);
        spectrum_xz.cached_contour_pos = null;
        spectrum_xz.cached_contour_neg = null;
    }
    if (spectrum_yz) {
        spectrum_yz.spectrum_color = color_exp_pos;
        spectrum_yz.spectrum_color_negative = color_exp_neg;
        spectrum_yz.levels = calculate_levels(global_3d_noise, scale, 30);
        spectrum_yz.negative_levels = calculate_negative_levels(global_3d_noise, scale, 30);
        spectrum_yz.cached_contour_pos = null;
        spectrum_yz.cached_contour_neg = null;
    }
    if (theoretical_spectrum_xz) {
        theoretical_spectrum_xz.spectrum_color = color_theo_pos;
        theoretical_spectrum_xz.spectrum_color_negative = color_theo_neg;
        theoretical_spectrum_xz.levels = calculate_levels(global_3d_noise, scale, 30);
        theoretical_spectrum_xz.negative_levels = calculate_negative_levels(global_3d_noise, scale, 30);
        theoretical_spectrum_xz.cached_contour_pos = null;
        theoretical_spectrum_xz.cached_contour_neg = null;
    }
    if (theoretical_spectrum_yz) {
        theoretical_spectrum_yz.spectrum_color = color_theo_pos;
        theoretical_spectrum_yz.spectrum_color_negative = color_theo_neg;
        theoretical_spectrum_yz.levels = calculate_levels(global_3d_noise, scale, 30);
        theoretical_spectrum_yz.negative_levels = calculate_negative_levels(global_3d_noise, scale, 30);
        theoretical_spectrum_yz.cached_contour_pos = null;
        theoretical_spectrum_yz.cached_contour_neg = null;
    }

    if (spectrum_proj) {
        let p_multiplier = parseFloat(document.getElementById("proj_contour_start_multiplier").value) || 10.0;
        let p_scale = parseFloat(document.getElementById("proj_contour_scale_factor").value) || 1.4;
        spectrum_proj.spectrum_color = "#0000ff";
        spectrum_proj.spectrum_color_negative = "#0000ff";
        spectrum_proj.levels = calculate_levels(spectrum_proj.noise_level, p_scale, 30, p_multiplier, p_scale);
        spectrum_proj.negative_levels = calculate_negative_levels(spectrum_proj.noise_level, p_scale, 30, p_multiplier, p_scale);
        spectrum_proj.cached_contour_pos = null;
        spectrum_proj.cached_contour_neg = null;
        request_contour_calculation(spectrum_proj, 0, 0, "proj");
        request_contour_calculation(spectrum_proj, 0, 1, "proj");
    }

    if (spectrum_proj_y) {
        let p_multiplier = parseFloat(document.getElementById("proj_y_contour_start_multiplier").value) || 10.0;
        let p_scale = parseFloat(document.getElementById("proj_y_contour_scale_factor").value) || 1.4;
        spectrum_proj_y.spectrum_color = "#0000ff";
        spectrum_proj_y.spectrum_color_negative = "#0000ff";
        spectrum_proj_y.levels = calculate_levels(spectrum_proj_y.noise_level, p_scale, 30, p_multiplier, p_scale);
        spectrum_proj_y.negative_levels = calculate_negative_levels(spectrum_proj_y.noise_level, p_scale, 30, p_multiplier, p_scale);
        spectrum_proj_y.cached_contour_pos = null;
        spectrum_proj_y.cached_contour_neg = null;
        request_contour_calculation(spectrum_proj_y, 0, 0, "proj_y");
        request_contour_calculation(spectrum_proj_y, 0, 1, "proj_y");
    }

    if (spectrum_proj_x) {
        let p_multiplier = parseFloat(document.getElementById("proj_x_contour_start_multiplier").value) || 10.0;
        let p_scale = parseFloat(document.getElementById("proj_x_contour_scale_factor").value) || 1.4;
        spectrum_proj_x.spectrum_color = "#0000ff";
        spectrum_proj_x.spectrum_color_negative = "#0000ff";
        spectrum_proj_x.levels = calculate_levels(spectrum_proj_x.noise_level, p_scale, 30, p_multiplier, p_scale);
        spectrum_proj_x.negative_levels = calculate_negative_levels(spectrum_proj_x.noise_level, p_scale, 30, p_multiplier, p_scale);
        spectrum_proj_x.cached_contour_pos = null;
        spectrum_proj_x.cached_contour_neg = null;
        request_contour_calculation(spectrum_proj_x, 0, 0, "proj_x");
        request_contour_calculation(spectrum_proj_x, 0, 1, "proj_x");
    }

    if (theoretical_spectrum_proj) {
        let p_multiplier = parseFloat(document.getElementById("proj_contour_start_multiplier").value) || 10.0;
        let p_scale = parseFloat(document.getElementById("proj_contour_scale_factor").value) || 1.4;
        theoretical_spectrum_proj.spectrum_color = "#ff0000";
        theoretical_spectrum_proj.spectrum_color_negative = "#ff0000";
        theoretical_spectrum_proj.noise_level = spectrum_proj.noise_level;
        theoretical_spectrum_proj.levels = calculate_levels(theoretical_spectrum_proj.noise_level, p_scale, 30, p_multiplier, p_scale);
        theoretical_spectrum_proj.negative_levels = calculate_negative_levels(theoretical_spectrum_proj.noise_level, p_scale, 30, p_multiplier, p_scale);
        theoretical_spectrum_proj.cached_contour_pos = null;
        theoretical_spectrum_proj.cached_contour_neg = null;
        request_contour_calculation(theoretical_spectrum_proj, 0, 0, "proj_theo");
        request_contour_calculation(theoretical_spectrum_proj, 0, 1, "proj_theo");
    }

    if (theoretical_spectrum_proj_y) {
        let p_multiplier = parseFloat(document.getElementById("proj_y_contour_start_multiplier").value) || 10.0;
        let p_scale = parseFloat(document.getElementById("proj_y_contour_scale_factor").value) || 1.4;
        theoretical_spectrum_proj_y.spectrum_color = "#ff0000";
        theoretical_spectrum_proj_y.spectrum_color_negative = "#ff0000";
        theoretical_spectrum_proj_y.noise_level = spectrum_proj_y.noise_level;
        theoretical_spectrum_proj_y.levels = calculate_levels(theoretical_spectrum_proj_y.noise_level, p_scale, 30, p_multiplier, p_scale);
        theoretical_spectrum_proj_y.negative_levels = calculate_negative_levels(theoretical_spectrum_proj_y.noise_level, p_scale, 30, p_multiplier, p_scale);
        theoretical_spectrum_proj_y.cached_contour_pos = null;
        theoretical_spectrum_proj_y.cached_contour_neg = null;
        request_contour_calculation(theoretical_spectrum_proj_y, 0, 0, "proj_y_theo");
        request_contour_calculation(theoretical_spectrum_proj_y, 0, 1, "proj_y_theo");
    }

    if (theoretical_spectrum_proj_x) {
        let p_multiplier = parseFloat(document.getElementById("proj_x_contour_start_multiplier").value) || 10.0;
        let p_scale = parseFloat(document.getElementById("proj_x_contour_scale_factor").value) || 1.4;
        theoretical_spectrum_proj_x.spectrum_color = "#ff0000";
        theoretical_spectrum_proj_x.spectrum_color_negative = "#ff0000";
        theoretical_spectrum_proj_x.noise_level = spectrum_proj_x.noise_level;
        theoretical_spectrum_proj_x.levels = calculate_levels(theoretical_spectrum_proj_x.noise_level, p_scale, 30, p_multiplier, p_scale);
        theoretical_spectrum_proj_x.negative_levels = calculate_negative_levels(theoretical_spectrum_proj_x.noise_level, p_scale, 30, p_multiplier, p_scale);
        theoretical_spectrum_proj_x.cached_contour_pos = null;
        theoretical_spectrum_proj_x.cached_contour_neg = null;
        request_contour_calculation(theoretical_spectrum_proj_x, 0, 0, "proj_x_theo");
        request_contour_calculation(theoretical_spectrum_proj_x, 0, 1, "proj_x_theo");
    }

    // Refresh views
    if (current_slice_index >= 0) {
        draw_slice(current_slice_index);
    }
    refresh_xz_view();
    refresh_yz_view();
}

function redraw_peak_symbols() {
    if (current_slice_index >= 0) {
        draw_slice(current_slice_index);
    }
    refresh_xz_view();
    refresh_yz_view();
}


// Helper to get element size
function get_content_size(id) {
    let cs = document.getElementById(id);
    let width = cs.clientWidth;
    let height = cs.clientHeight;
    return { width: width, height: height };
}

// Global Zoom Functions
function resetzoom() {
    if (main_plot && main_plot.xscale_orig && main_plot.yscale_orig) {
        main_plot.resetzoom(main_plot.xscale_orig, main_plot.yscale_orig);
    }
}

/**
 * Pops zoom.
 */
function popzoom() {
    if (main_plot) {
        main_plot.popzoom();
    }
}

/**
 * Initializes main plot.
 *
 * @param {any} first_spectrum - First spectrum
 */
function init_main_plot(first_spectrum) {
    let cr = get_content_size("vis_parent");

    // Ensure SVG and Canvas are sized correctly in the DOM
    document.getElementById("visualization").setAttribute("width", cr.width);
    document.getElementById("visualization").setAttribute("height", cr.height);

    // We will resize canvas1 later after calculating margins
    // document.getElementById("canvas1").setAttribute("width", cr.width);
    // document.getElementById("canvas1").setAttribute("height", cr.height);

    let plot_font_size = 24;
    let plot_margin_left = 30 + plot_font_size * 5;
    let plot_margin_bottom = 30 + plot_font_size * 3;
    let plot_margin_top = 30;
    let plot_margin_right = 30;

    // Correctly size and position the WebGL canvas to align with the SVG plot area (inner margins)
    let plot_width = Math.max(0, cr.width - plot_margin_left - plot_margin_right);
    let plot_height = Math.max(0, cr.height - plot_margin_top - plot_margin_bottom);

    let canvas_el = document.getElementById("canvas1");
    canvas_el.style.position = "absolute";
    canvas_el.style.left = plot_margin_left + "px";
    canvas_el.style.top = plot_margin_top + "px";
    canvas_el.setAttribute("width", plot_width);
    canvas_el.setAttribute("height", plot_height);

    // Prepare Plot Parameters
    // Check Y-Axis direction. Standard NMR Y-axis (F1) is often High->Low (Top->Bottom).
    // plotit maps domain[0] -> range[0] (Bottom), domain[1] -> range[1] (Top).
    // If y_step is negative, yscale is [High, Low]. 
    // High -> Bottom. Low -> Top. This is inverted for standard NMR.
    // We want High->Top. So we need yscale to be [Low, High].



    let y_start = first_spectrum.y_ppm_start;
    let y_step = first_spectrum.y_ppm_step;

    let input = {
        WIDTH: cr.width,
        HEIGHT: cr.height,
        MARGINS: {
            left: plot_margin_left,
            top: plot_margin_top,
            right: plot_margin_right,
            bottom: plot_margin_bottom
        },
        fontsize: plot_font_size,

        // X-Axis: High->Left is standard.
        // If step < 0, xscale is [High, Low].
        // range is [Left, Right].
        // High->Left. This is CORRECT. Keep X as is.
        x_ppm_start: first_spectrum.x_ppm_start,
        x_ppm_step: first_spectrum.x_ppm_step,
        n_direct: first_spectrum.n_direct,

        // Y-Axis: Adjusted
        y_ppm_start: y_start,
        y_ppm_step: y_step,
        n_indirect: first_spectrum.n_indirect,

        drawto: "#visualization",
        drawto_legend: "none",
        drawto_peak: "#visualization",
        drawto_contour: "canvas1",
        drawto_infor: "infor",
        size: [cr.width, cr.height],
        PointData: [],
        inter_window_channel: null
    };

    main_plot = new plotit(input);

    // Store original scales for resetzoom
    main_plot.xscale_orig = main_plot.xscale;
    main_plot.yscale_orig = main_plot.yscale;

    // Initial draw to setup SVG axes
    main_plot.draw();

    // Draw fixed center crosshairs
    if (typeof main_plot.draw_center_lines === 'function') {
        main_plot.draw_center_lines();
    }

    // Disable interactive behaviors for 3D view
    main_plot.cross_line_pause_flag = false;
    if (typeof main_plot.allow_right_click === 'function') {
        main_plot.allow_right_click(false);
    }

    // Initialize Orthogonal Plots
    init_ortho_plots(first_spectrum);

    update_all_plot_axis_labels();
}




/**
 * Requests contour calculation.
 *
 * @param {any} spectrum - Spectrum
 * @param {any} index - Index
 * @param {any} sign - Sign
 * @param {string} [spectrum_type] - Spectrum type Default is "full".
 */
function request_contour_calculation(spectrum, index, sign, spectrum_type = "full") {
    // Mimic the message structure expected by contour.js
    // contour.js reads: e.data.spectrum.levels, etc.

    let spec_data = {
        levels: (sign === 0) ? spectrum.levels : spectrum.negative_levels,
        n_direct: spectrum.n_direct,
        n_indirect: spectrum.n_indirect,
        contour_sign: sign,
        spectrum_type: spectrum_type,
        spectrum_index: index, // Use actual slice index
        spectrum_origin: -1
    };

    // Needs response_value (raw data)
    // contour.js expects: e.data.response_value

    my_contour_worker.postMessage({
        response_value: spectrum.raw_data,
        spectrum: spec_data
    });
}


/**
 * Float32s concat.
 *
 * @param {any} first - First
 * @param {any} second - Second
 */
function Float32Concat(first, second) {
    var firstLength = first.length,
        result = new Float32Array(firstLength + second.length);
    result.set(first);
    result.set(second, firstLength);
    return result;
}

/**
 * Refreshes current view.
 *
 * @param {any} spectrum_in - Spectrum in
 */
function refresh_current_view(spectrum_in) {
    if (!main_plot) return;

    let s = spectrum_in || hsqc_spectra[0];
    if (!s) return;

    // console.log("refresh_current_view drawing slice:", current_slice_index, "filename:", s.filename);
    // console.log("Has cached pos?", !!s.cached_contour_pos);

    // Prepare arrays for set_data
    // We construct arrays of length 1 (experimental) or 2 (experimental + theoretical)

    let spectra_list = [s];

    // Check for theoretical
    if (theoretical_spectra_3d && theoretical_spectra_3d.length > current_slice_index) {
        let st = theoretical_spectra_3d[current_slice_index];
        if (st && st.cached_contour_pos) {
            spectra_list.push(st);
        }
    }

    let points_pos_list = [];
    let len_pos_list = [];
    let poly_pos_list = [];
    let points_neg_list = [];
    let len_neg_list = [];
    let poly_neg_list = [];
    let color_pos_list = [];
    let color_neg_list = [];
    let lbs_pos_list = [];
    let lbs_neg_list = [];
    let start_pos_list = [];
    let start_neg_list = [];
    let spectral_info_list = [];
    let spectral_order_list = [];

    let total_points = 0;

    for (let i = 0; i < spectra_list.length; i++) {
        let spec = spectra_list[i];

        let p_pos = spec.cached_contour_pos ? spec.cached_contour_pos.points : new Float32Array([]);
        if (!(p_pos instanceof Float32Array)) p_pos = new Float32Array(p_pos);

        let p_neg = spec.cached_contour_neg ? spec.cached_contour_neg.points : new Float32Array([]);
        if (!(p_neg instanceof Float32Array)) p_neg = new Float32Array(p_neg);

        points_pos_list.push(p_pos);
        points_neg_list.push(p_neg);

        len_pos_list.push(spec.cached_contour_pos ? spec.cached_contour_pos.levels_length : []);
        poly_pos_list.push(spec.cached_contour_pos ? spec.cached_contour_pos.polygon_length : []);

        len_neg_list.push(spec.cached_contour_neg ? spec.cached_contour_neg.levels_length : []);
        poly_neg_list.push(spec.cached_contour_neg ? spec.cached_contour_neg.polygon_length : []);

        color_pos_list.push(hexToRgb(spec.spectrum_color));
        color_neg_list.push(spec.spectrum_color_negative ? hexToRgb(spec.spectrum_color_negative) : [0, 0, 0, 1]);

        lbs_pos_list.push(0);
        lbs_neg_list.push(0);

        start_pos_list.push(total_points);
        total_points += p_pos.length;
        start_neg_list.push(total_points);
        total_points += p_neg.length;

        spectral_info_list.push({
            x_ppm_start: spec.x_ppm_start,
            x_ppm_step: spec.x_ppm_step,
            y_ppm_start: spec.y_ppm_start,
            y_ppm_step: spec.y_ppm_step,
            x_ppm_ref: 0,
            y_ppm_ref: 0
        });

        spectral_order_list.push(i);
    }

    // Concatenate all points
    let combined_points = new Float32Array(total_points);
    let offset = 0;
    for (let i = 0; i < spectra_list.length; i++) {
        combined_points.set(points_pos_list[i], offset);
        offset += points_pos_list[i].length;
        combined_points.set(points_neg_list[i], offset);
        offset += points_neg_list[i].length;
    }

    // Set the data
    main_plot.contour_plot.spectral_order = spectral_order_list;

    main_plot.contour_plot.set_data(
        spectral_info_list,
        combined_points,
        start_pos_list,
        poly_pos_list,
        len_pos_list,
        color_pos_list,
        lbs_pos_list,
        start_neg_list,
        poly_neg_list,
        len_neg_list,
        color_neg_list,
        lbs_neg_list
    );

    // Explicitly sync camera to ensuring initial view is correct (Fixes "Zoom Once" issue)
    let x_dom = main_plot.xRange.domain();
    let y_dom = main_plot.yRange.domain();
    main_plot.contour_plot.setCamera_ppm(x_dom[0], x_dom[1], y_dom[0], y_dom[1]);

    // Redraw only the WebGL scene
    if (main_plot.contour_plot.gl) {
        main_plot.contour_plot.gl.clear(main_plot.contour_plot.gl.COLOR_BUFFER_BIT);
    }
    main_plot.contour_plot.drawScene();
}

/**
 * Sync XZ and YZ sliders AND axes to the main XY plot
 */
function sync_sliders_to_center(is_end = true) {
    console.log("sync_sliders_to_center called");
    if (!main_plot || !spectra_3d || spectra_3d.length === 0) return;

    let s = spectra_3d[0]; // Reference spectrum for PPM calculations

    // Get current view domain (what's visible after zoom/pan)
    let x_domain = main_plot.xRange.domain();
    let y_domain = main_plot.yRange.domain();

    // Calculate center PPM coordinates
    let center_x_ppm = (x_domain[0] + x_domain[1]) / 2;
    let center_y_ppm = (y_domain[0] + y_domain[1]) / 2;

    // Convert PPM to indices
    let new_x_index = Math.round((center_x_ppm - s.x_ppm_start) / s.x_ppm_step);
    let new_y_index = Math.round((center_y_ppm - s.y_ppm_start) / s.y_ppm_step);

    // Clamp to valid range
    new_x_index = Math.max(0, Math.min(s.n_direct - 1, new_x_index));
    new_y_index = Math.max(0, Math.min(s.n_indirect - 1, new_y_index));

    // Update sliders and labels if indices changed
    let sl_xz = document.getElementById("slider_xz");
    let val_xz = document.getElementById("val_xz");
    if (sl_xz && new_y_index !== current_y_index) {
        if (is_end) {
            current_y_index = new_y_index;
            sl_xz.value = current_y_index;
            let ppm_y = s.y_ppm_start + (current_y_index * s.y_ppm_step);
            val_xz.innerText = (current_y_index + 1) + "/" + s.n_indirect + " (" + ppm_y.toFixed(3) + " ppm)";
            refresh_xz_view();
        } else {
            sl_xz.value = new_y_index;
            let ppm_y = s.y_ppm_start + (new_y_index * s.y_ppm_step);
            val_xz.innerText = (new_y_index + 1) + "/" + s.n_indirect + " (" + ppm_y.toFixed(3) + " ppm)";
        }
    }

    let sl_yz = document.getElementById("slider_yz");
    let val_yz = document.getElementById("val_yz");
    if (sl_yz && new_x_index !== current_x_index) {
        if (is_end) {
            current_x_index = new_x_index;
            sl_yz.value = current_x_index;
            let ppm_x = s.x_ppm_start + (current_x_index * s.x_ppm_step);
            val_yz.innerText = (current_x_index + 1) + "/" + s.n_direct + " (" + ppm_x.toFixed(3) + " ppm)";
            refresh_yz_view();
        } else {
            sl_yz.value = new_x_index;
            let ppm_x = s.x_ppm_start + (new_x_index * s.x_ppm_step);
            val_yz.innerText = (new_x_index + 1) + "/" + s.n_direct + " (" + ppm_x.toFixed(3) + " ppm)";
        }
    }

    // Sync axes: XZ plot X-axis matches XY plot X-axis (Direct)
    if (main_plot_xz) {
        main_plot_xz.xscale = [x_domain[0], x_domain[1]];
        main_plot_xz.xRange.domain(main_plot_xz.xscale);
        main_plot_xz.reset_axis();

        // Force axis redraw by explicitly calling axis generator
        if (main_plot_xz.$xAxis_svg) {
            main_plot_xz.$xAxis_svg.call(main_plot_xz.xAxis);
        }

        // Update WebGL camera if contour plot exists
        if (main_plot_xz.contour_plot) {
            let y_dom_xz = main_plot_xz.yRange.domain();
            main_plot_xz.contour_plot.setCamera_ppm(
                main_plot_xz.xscale[0], main_plot_xz.xscale[1],
                y_dom_xz[0], y_dom_xz[1]
            );
            main_plot_xz.contour_plot.drawScene();
        }
    }

    // Sync axes: YZ plot Y-axis matches XY plot Y-axis (Indirect)
    if (main_plot_yz) {
        main_plot_yz.yscale = [y_domain[0], y_domain[1]];
        main_plot_yz.yRange.domain(main_plot_yz.yscale);
        main_plot_yz.reset_axis();

        // Update WebGL camera if contour plot exists
        if (main_plot_yz.contour_plot) {
            let x_dom_yz = main_plot_yz.xRange.domain();
            main_plot_yz.contour_plot.setCamera_ppm(
                x_dom_yz[0], x_dom_yz[1],
                main_plot_yz.yscale[0], main_plot_yz.yscale[1]
            );
            main_plot_yz.contour_plot.drawScene();
        }
    }

    update_3d_crosshairs();
}

/**
 * Sync main XY and YZ plots when XZ plot is zoomed/panned
 */
function sync_from_xz_plot(is_end = true) {
    if (!main_plot_xz || !main_plot || !main_plot_yz || !spectra_3d || spectra_3d.length === 0) return;

    let x_domain = main_plot_xz.xRange.domain(); // X-axis (Direct)
    let y_domain = main_plot_xz.yRange.domain(); // Y-axis (Z)

    // Sync main plot X-axis (Direct)
    main_plot.xscale = [x_domain[0], x_domain[1]];
    main_plot.xRange.domain(main_plot.xscale);
    main_plot.reset_axis();

    if (main_plot.contour_plot) {
        let y_dom = main_plot.yRange.domain();
        main_plot.contour_plot.setCamera_ppm(main_plot.xscale[0], main_plot.xscale[1], y_dom[0], y_dom[1]);
        main_plot.contour_plot.drawScene();
    }
    if (main_plot.x_cross_section_plot) {
        main_plot.x_cross_section_plot.zoom_x(main_plot.xscale);
    }

    // Sync YZ plot X-axis (Z) - Matches XZ plot Y-axis (Z)
    main_plot_yz.xscale = [y_domain[0], y_domain[1]];
    main_plot_yz.xRange.domain(main_plot_yz.xscale);
    main_plot_yz.reset_axis();

    // YZ Y-axis (Indirect) remains unchanged as XZ doesn't show Indirect dimension

    if (main_plot_yz.contour_plot) {
        main_plot_yz.contour_plot.setCamera_ppm(
            main_plot_yz.xscale[0], main_plot_yz.xscale[1],
            main_plot_yz.yscale[0], main_plot_yz.yscale[1]
        );
        main_plot_yz.contour_plot.drawScene();
    }

    let s = spectra_3d[0];

    // Update Z slider based on center of Z range (which is Y-axis of XZ plot)
    let center_z_ppm = (y_domain[0] + y_domain[1]) / 2;
    let new_z_index = Math.round((center_z_ppm - s.z_ppm_start) / s.z_ppm_step);
    new_z_index = Math.max(0, Math.min(spectra_3d.length - 1, new_z_index));

    if (new_z_index !== current_slice_index) {
        if (is_end) {
            draw_slice(new_z_index, false); // false prevents zoom snapping loop
        } else {
            let sl_xy = document.getElementById("slice_slider");
            let val_xy = document.getElementById("slice_info");
            if (sl_xy) sl_xy.value = new_z_index;
            if (val_xy) {
                let ppm_z = s.z_ppm_start + (new_z_index * s.z_ppm_step);
                val_xy.innerText = (new_z_index + 1) + "/" + spectra_3d.length + " (" + ppm_z.toFixed(3) + " ppm)";
            }
        }
    }

    // Update X slider (which syncs to Main Plot's X)
    let center_x_ppm = (x_domain[0] + x_domain[1]) / 2;
    let new_x_index = Math.round((center_x_ppm - s.x_ppm_start) / s.x_ppm_step);
    new_x_index = Math.max(0, Math.min(s.n_direct - 1, new_x_index));

    let sl_yz = document.getElementById("slider_yz");
    let val_yz = document.getElementById("val_yz");
    if (sl_yz && new_x_index !== current_x_index) {
        if (is_end) {
            current_x_index = new_x_index;
            sl_yz.value = current_x_index;
            let ppm_x = s.x_ppm_start + (current_x_index * s.x_ppm_step);
            val_yz.innerText = (current_x_index + 1) + "/" + s.n_direct + " (" + ppm_x.toFixed(3) + " ppm)";
            refresh_yz_view();
        } else {
            sl_yz.value = new_x_index;
            let ppm_x = s.x_ppm_start + (new_x_index * s.x_ppm_step);
            val_yz.innerText = (new_x_index + 1) + "/" + s.n_direct + " (" + ppm_x.toFixed(3) + " ppm)";
        }
    }

    update_3d_crosshairs();
}

/**
 * Sync main XY and XZ plots when YZ plot is zoomed/panned
 */
function sync_from_yz_plot(is_end = true) {
    if (!main_plot_yz || !main_plot || !main_plot_xz || !spectra_3d || spectra_3d.length === 0) return;

    let x_domain = main_plot_yz.xRange.domain(); // X-axis (Z)
    let y_domain = main_plot_yz.yRange.domain(); // Y-axis (Indirect)

    // Sync main plot Y-axis (Indirect)
    main_plot.yscale = [y_domain[0], y_domain[1]];
    main_plot.yRange.domain(main_plot.yscale);
    main_plot.reset_axis();

    if (main_plot.contour_plot) {
        let x_dom = main_plot.xRange.domain();
        main_plot.contour_plot.setCamera_ppm(x_dom[0], x_dom[1], main_plot.yscale[0], main_plot.yscale[1]);
        main_plot.contour_plot.drawScene();
    }
    if (main_plot.y_cross_section_plot) {
        main_plot.y_cross_section_plot.zoom_y(main_plot.yscale);
    }

    // Sync XZ plot Y-axis (Z) - Matches YZ plot X-axis (Z)
    main_plot_xz.yscale = [x_domain[0], x_domain[1]];
    main_plot_xz.yRange.domain(main_plot_xz.yscale);

    // XZ X-axis (Direct) remains unchanged as YZ doesn't show Direct dimension

    main_plot_xz.reset_axis();

    if (main_plot_xz.contour_plot) {
        main_plot_xz.contour_plot.setCamera_ppm(
            main_plot_xz.xscale[0], main_plot_xz.xscale[1],
            main_plot_xz.yscale[0], main_plot_xz.yscale[1]
        );
        main_plot_xz.contour_plot.drawScene();
    }

    let s = spectra_3d[0];

    // Update Z slider based on center of Z range (which is X-axis of YZ plot)
    let center_z_ppm = (x_domain[0] + x_domain[1]) / 2;
    let new_z_index = Math.round((center_z_ppm - s.z_ppm_start) / s.z_ppm_step);
    new_z_index = Math.max(0, Math.min(spectra_3d.length - 1, new_z_index));

    if (new_z_index !== current_slice_index) {
        if (is_end) {
            draw_slice(new_z_index, false); // false prevents zoom snapping loop
        } else {
            let sl_xy = document.getElementById("slice_slider");
            let val_xy = document.getElementById("slice_info");
            if (sl_xy) sl_xy.value = new_z_index;
            if (val_xy) {
                let ppm_z = s.z_ppm_start + (new_z_index * s.z_ppm_step);
                val_xy.innerText = (new_z_index + 1) + "/" + spectra_3d.length + " (" + ppm_z.toFixed(3) + " ppm)";
            }
        }
    }

    // Update Y slider (which syncs to Main Plot's Y)
    let center_y_ppm = (y_domain[0] + y_domain[1]) / 2;
    let new_y_index = Math.round((center_y_ppm - s.y_ppm_start) / s.y_ppm_step);
    new_y_index = Math.max(0, Math.min(s.n_indirect - 1, new_y_index));

    let sl_xz = document.getElementById("slider_xz");
    let val_xz = document.getElementById("val_xz");
    if (sl_xz && new_y_index !== current_y_index) {
        if (is_end) {
            current_y_index = new_y_index;
            sl_xz.value = current_y_index;
            let ppm_y = s.y_ppm_start + (current_y_index * s.y_ppm_step);
            val_xz.innerText = (current_y_index + 1) + "/" + s.n_indirect + " (" + ppm_y.toFixed(3) + " ppm)";
            refresh_xz_view();
        } else {
            sl_xz.value = new_y_index;
            let ppm_y = s.y_ppm_start + (new_y_index * s.y_ppm_step);
            val_xz.innerText = (new_y_index + 1) + "/" + s.n_indirect + " (" + ppm_y.toFixed(3) + " ppm)";
        }
    }

    update_3d_crosshairs();
}

/**
 * Initializes orthogonal plots.
 *
 * @param {any} s - S
 */
function init_ortho_plots(s) {
    if (!s) return;

    // Initialize current Slice indices to center if not set
    if (current_y_index === -1) current_y_index = Math.floor(s.n_indirect / 2);
    if (current_x_index === -1) current_x_index = Math.floor(s.n_direct / 2);

    // XZ Slider (Controls Y-slice, Indirect Dimension)
    let sl_xz = document.getElementById("slider_xz");
    let val_xz = document.getElementById("val_xz");
    if (sl_xz) {
        sl_xz.min = 0;
        sl_xz.max = s.n_indirect - 1;
        sl_xz.step = 1;
        sl_xz.value = current_y_index;

        // Initial Label
        let ppm_y = s.y_ppm_start + (current_y_index * s.y_ppm_step);
        val_xz.innerText = (current_y_index + 1) + "/" + s.n_indirect + " (" + ppm_y.toFixed(3) + " ppm)";

        sl_xz.oninput = function () {
            current_y_index = parseInt(this.value);
            let ppm = s.y_ppm_start + (current_y_index * s.y_ppm_step);
            val_xz.innerText = (current_y_index + 1) + "/" + s.n_indirect + " (" + ppm.toFixed(3) + " ppm)";
            update_3d_crosshairs();
            refresh_xz_view();

            // Pan connected views to center on Y slice
            if (main_plot) main_plot.pan_to_center_ppm('y', ppm);
            if (main_plot_yz) main_plot_yz.pan_to_center_ppm('y', ppm);
        };
    }

    // YZ Slider (Controls X-slice, Direct Dimension)
    let sl_yz = document.getElementById("slider_yz");
    let val_yz = document.getElementById("val_yz");
    if (sl_yz) {
        sl_yz.min = 0;
        sl_yz.max = s.n_direct - 1;
        sl_yz.step = 1;
        sl_yz.value = current_x_index;

        // Initial Label
        let ppm_x = s.x_ppm_start + (current_x_index * s.x_ppm_step);
        val_yz.innerText = (current_x_index + 1) + "/" + s.n_direct + " (" + ppm_x.toFixed(3) + " ppm)";

        sl_yz.oninput = function () {
            current_x_index = parseInt(this.value);
            let ppm = s.x_ppm_start + (current_x_index * s.x_ppm_step);
            val_yz.innerText = (current_x_index + 1) + "/" + s.n_direct + " (" + ppm.toFixed(3) + " ppm)";
            update_3d_crosshairs();
            refresh_yz_view();

            // Pan connected views to center on X slice
            if (main_plot) main_plot.pan_to_center_ppm('x', ppm);
            if (main_plot_xz) main_plot_xz.pan_to_center_ppm('x', ppm);
        };
    }


    let plot_font_size = 24;
    let plot_margin_left = 30 + plot_font_size * 5;
    let plot_margin_bottom = 30 + plot_font_size * 3;
    let plot_margin_top = 30;
    let plot_margin_right = 30;

    let margins = {
        left: plot_margin_left,
        top: plot_margin_top,
        right: plot_margin_right,
        bottom: plot_margin_bottom
    };

    // Create Plot objects if not exist
    if (!main_plot_xz) {
        let parent = document.getElementById("vis_parent_xz");
        let cr = parent.getBoundingClientRect();

        let plot_width = Math.max(0, cr.width - plot_margin_left - plot_margin_right);
        let plot_height = Math.max(0, cr.height - plot_margin_top - plot_margin_bottom);

        let cvs = document.getElementById("canvas_xz");
        let svg = document.getElementById("visualization_xz");

        // Correctly position canvas
        if (cvs) {
            cvs.style.position = "absolute";
            cvs.style.left = plot_margin_left + "px";
            cvs.style.top = plot_margin_top + "px";
            cvs.setAttribute("width", plot_width);
            cvs.setAttribute("height", plot_height);
        }

        if (svg) { svg.setAttribute("width", cr.width); svg.setAttribute("height", cr.height); }

        let input_xz = {
            WIDTH: cr.width,
            HEIGHT: cr.height,
            MARGINS: margins,
            fontsize: plot_font_size,
            x_ppm_start: s.x_ppm_start,      // Placeholder, updated in refresh
            x_ppm_step: s.x_ppm_step,
            y_ppm_start: s.z_ppm_start,
            y_ppm_step: s.z_ppm_step,
            n_direct: s.n_direct,
            n_indirect: spectra_3d.length,
            drawto: "#visualization_xz",
            drawto_contour: "canvas_xz",
            drawto_infor: "infor_xz",
            size: [cr.width, cr.height]
        };
        main_plot_xz = new plotit(input_xz);
        main_plot_xz.draw();

        // Draw fixed center crosshairs
        if (typeof main_plot_xz.draw_center_lines === 'function') {
            main_plot_xz.draw_center_lines();
        }

        // Disable interactive behaviors
        main_plot_xz.cross_line_pause_flag = false;
        if (typeof main_plot_xz.allow_right_click === 'function') {
            main_plot_xz.allow_right_click(false);
        }
    }

    if (!main_plot_yz) {
        let parent = document.getElementById("vis_parent_yz");
        let cr = parent.getBoundingClientRect();

        let plot_width = Math.max(0, cr.width - plot_margin_left - plot_margin_right);
        let plot_height = Math.max(0, cr.height - plot_margin_top - plot_margin_bottom);

        let cvs = document.getElementById("canvas_yz");
        let svg = document.getElementById("visualization_yz");

        // Correctly position canvas
        if (cvs) {
            cvs.style.position = "absolute";
            cvs.style.left = plot_margin_left + "px";
            cvs.style.top = plot_margin_top + "px";
            cvs.setAttribute("width", plot_width);
            cvs.setAttribute("height", plot_height);
        }

        if (svg) { svg.setAttribute("width", cr.width); svg.setAttribute("height", cr.height); }

        let input_yz = {
            WIDTH: cr.width,
            HEIGHT: cr.height,
            MARGINS: margins,
            fontsize: plot_font_size,
            x_ppm_start: s.z_ppm_start,
            x_ppm_step: s.z_ppm_step,
            y_ppm_start: s.y_ppm_start,
            y_ppm_step: s.y_ppm_step,
            n_direct: spectra_3d.length,
            n_indirect: s.n_indirect,
            drawto: "#visualization_yz",
            drawto_contour: "canvas_yz",
            drawto_infor: "infor_yz",
            size: [cr.width, cr.height]
        };
        main_plot_yz = new plotit(input_yz);
        main_plot_yz.draw();

        // Draw fixed center crosshairs
        if (typeof main_plot_yz.draw_center_lines === 'function') {
            main_plot_yz.draw_center_lines();
        }

        // Disable interactive behaviors
        main_plot_yz.cross_line_pause_flag = false;
        if (typeof main_plot_yz.allow_right_click === 'function') {
            main_plot_yz.allow_right_click(false);
        }
    }

    // Sync axes from main plot to orthogonal plots
    if (main_plot && main_plot_xz && main_plot_yz) {
        // Sync X-axis: XY → XZ
        let x_domain = main_plot.xRange.domain();
        main_plot_xz.xscale = [x_domain[0], x_domain[1]];
        main_plot_xz.xRange.domain(main_plot_xz.xscale);
        main_plot_xz.reset_axis();

        // Sync Y-axis: XY → YZ
        let y_domain = main_plot.yRange.domain();
        main_plot_yz.yscale = [y_domain[0], y_domain[1]];
        main_plot_yz.yRange.domain(main_plot_yz.yscale);
        main_plot_yz.reset_axis();
    }

    refresh_xz_view();
    refresh_yz_view();
}

/**
 * Refreshes XZ view.
 * This function also construct spectrum_xz from spectra_3d if it is null.
 */
function refresh_xz_view() {
    if (!main_plot_xz || spectra_3d.length === 0) return;

    // Generate XZ Spectrum at current_y_index
    // Direct Dim: Original X (0 to n_direct)
    // Indirect Dim: Z slices (0 to spectra_3d.length) -- Treating Z as Indirect ("Y" of this plot)

    let base_spec = spectra_3d[0]; // Assume all have same params for X

    // Create/reuse a synthetic spectrum object to reduce allocation churn.
    let spec = spectrum_xz || new spectrum();
    spec.n_direct = base_spec.n_direct;
    spec.n_indirect = spectra_3d.length;
    spec.x_ppm_start = base_spec.x_ppm_start;
    spec.x_ppm_step = base_spec.x_ppm_step;
    // For Z axis (Y of this plot), use Z PPM params
    spec.y_ppm_start = base_spec.z_ppm_start;
    spec.y_ppm_step = base_spec.z_ppm_step;

    spec.levels = base_spec.levels;
    spec.negative_levels = base_spec.negative_levels;
    spec.noise_level = base_spec.noise_level;
    spec.spectrum_color = base_spec.spectrum_color;
    spec.spectrum_color_negative = base_spec.spectrum_color_negative;

    // Extract Data
    // We need row 'current_y_index' from each slice
    let sz = spectra_3d.length;
    let nx = base_spec.n_direct;
    let raw = (spec.raw_data && spec.raw_data.length === (sz * nx))
        ? spec.raw_data
        : new Float32Array(sz * nx);

    for (let z = 0; z < sz; z++) {
        let slice = spectra_3d[z];
        // Valid check
        if (slice.raw_data && slice.raw_data.length > 0) {
            let start = current_y_index * nx;
            let end = start + nx;
            let row = slice.raw_data.subarray(start, end);
            raw.set(row, z * nx);
        }
    }
    spec.raw_data = raw;

    request_orthogonal_contour(spec, 0, "xz");
    request_orthogonal_contour(spec, 1, "xz");

    spectrum_xz = spec;

    // Handle Theoretical
    if (theoretical_spectra_3d && theoretical_spectra_3d.length > 0) {
        let base_spec_theo = theoretical_spectra_3d[0];
        let spec_theo = theoretical_spectrum_xz || new spectrum();
        spec_theo.n_direct = base_spec_theo.n_direct;
        spec_theo.n_indirect = theoretical_spectra_3d.length;
        spec_theo.x_ppm_start = base_spec_theo.x_ppm_start;
        spec_theo.x_ppm_step = base_spec_theo.x_ppm_step;
        spec_theo.y_ppm_start = base_spec_theo.z_ppm_start;
        spec_theo.y_ppm_step = base_spec_theo.z_ppm_step;

        spec_theo.levels = base_spec_theo.levels;
        spec_theo.negative_levels = base_spec_theo.negative_levels;
        spec_theo.noise_level = base_spec_theo.noise_level;
        spec_theo.spectrum_color = base_spec_theo.spectrum_color;
        spec_theo.spectrum_color_negative = base_spec_theo.spectrum_color_negative;

        let sz = theoretical_spectra_3d.length;
        let nx = base_spec_theo.n_direct;
        let raw_theo = (spec_theo.raw_data && spec_theo.raw_data.length === (sz * nx))
            ? spec_theo.raw_data
            : new Float32Array(sz * nx);

        for (let z = 0; z < sz; z++) {
            let slice = theoretical_spectra_3d[z];
            if (slice.raw_data && slice.raw_data.length > 0) {
                let start = current_y_index * nx;
                let end = start + nx;
                let row = slice.raw_data.subarray(start, end);
                raw_theo.set(row, z * nx);
            }
        }
        spec_theo.raw_data = raw_theo;
        theoretical_spectrum_xz = spec_theo;

        request_orthogonal_contour(spec_theo, 0, "xz_theo");
        request_orthogonal_contour(spec_theo, 1, "xz_theo");
    }

    if (main_plot_xz) {
        main_plot_xz.local_spectra = [spec];
        if (theoretical_spectrum_xz) main_plot_xz.local_spectra.push(theoretical_spectrum_xz);

        // Visualize Theoretical Peaks on XZ Plot
        // XZ Plot:
        // Horizontal (X-axis): Direct Dimension (X)
        // Vertical (Y-axis): Z Dimension
        // Slice Dimension: Indirect Dimension (Y) -> current_y_index
        if (show_peak_symbols && typeof theoretical_peaks_data !== 'undefined' && theoretical_peaks_data.length > 0) {
            let visible_peaks_xz = [];
            let current_slice_y = current_y_index;
            let s = spectra_3d[0];

            for (let p of theoretical_peaks_data) {
                // Depth check (Y dimension)
                let diff = p.y - current_slice_y;
                let abs_diff = Math.abs(diff);
                let width = p.fwhh_y; // Y_FWHH

                if (abs_diff <= width) {
                    let symbol_type = 'circle';
                    let fill_flag = true;

                    if (abs_diff <= 1.0) {
                        symbol_type = 'square';
                        fill_flag = false;
                    } else if (diff < 0) {
                        // Behind slice
                        symbol_type = 'circle';
                        fill_flag = true;
                    } else {
                        // In front of slice (diff > 0)
                        symbol_type = 'cross';
                        fill_flag = false;
                    }

                    let symbol_color = document.getElementById('color_peak_symbol') ? document.getElementById('color_peak_symbol').value : 'cyan';
                    // Map coordinates for XZ plot
                    // X-axis: X PPM
                    // Y-axis: Z PPM
                    visible_peaks_xz.push({
                        x: p.x_ppm !== undefined ? p.x_ppm : (s.x_ppm_start + p.x * s.x_ppm_step),
                        y: p.z_ppm !== undefined ? p.z_ppm : (s.z_ppm_start + p.z * s.z_ppm_step),
                        symbol: symbol_type,
                        color: symbol_color,
                        size: (symbol_type === 'square') ? 6 : 5,
                        fill: fill_flag
                    });
                }
            }
            main_plot_xz.add_extra_peaks(visible_peaks_xz);
        } else {
            if (main_plot_xz) {
                main_plot_xz.add_extra_peaks([]);
            }
        }

        if (typeof partition_bounds_data !== "undefined" && partition_bounds_data !== null) {
            let x0 = s.x_ppm_start + partition_bounds_data.x[0] * s.x_ppm_step;
            let x1 = s.x_ppm_start + partition_bounds_data.x[1] * s.x_ppm_step;
            let z0 = s.z_ppm_start + partition_bounds_data.z[0] * s.z_ppm_step;
            let z1 = s.z_ppm_start + partition_bounds_data.z[1] * s.z_ppm_step;

            if (current_slice_y >= partition_bounds_data.y[0] && current_slice_y <= partition_bounds_data.y[1]) {
                // X-axis is X PPM, Y-axis is Z PPM
                main_plot_xz.draw_bounding_box(x0, x1, z0, z1, 'red');
            } else {
                main_plot_xz.draw_bounding_box();
            }
        } else {
            if (main_plot_xz.draw_bounding_box) main_plot_xz.draw_bounding_box();
        }
    }
}

/**
 * Refreshes YZ view.
 * This function also construct spectrum_yz from spectra_3d if it is null.
 */
function refresh_yz_view() {
    if (!main_plot_yz || spectra_3d.length === 0) return;

    // Generate YZ Spectrum at current_x_index
    // Direct Dim: Z slices (0 to spectra_3d.length) -- Treating Z as Direct ("X" of this plot?)
    // Indirect Dim: Original Y (0 to n_indirect)

    let base_spec = spectra_3d[0];

    // Create/reuse a synthetic spectrum object to reduce allocation churn.
    let spec = spectrum_yz || new spectrum();
    spec.n_direct = spectra_3d.length; // Z is X axis
    spec.n_indirect = base_spec.n_indirect;

    // For Z axis (X of this plot), use Z PPM params
    spec.x_ppm_start = base_spec.z_ppm_start;
    spec.x_ppm_step = base_spec.z_ppm_step;

    spec.y_ppm_start = base_spec.y_ppm_start;
    spec.y_ppm_step = base_spec.y_ppm_step;

    spec.levels = base_spec.levels;
    spec.negative_levels = base_spec.negative_levels;
    spec.spectrum_color = base_spec.spectrum_color;
    spec.spectrum_color_negative = base_spec.spectrum_color_negative;

    let sz = spectra_3d.length;
    let nx = base_spec.n_direct; // Original X dim size
    let ny = base_spec.n_indirect;

    let raw = (spec.raw_data && spec.raw_data.length === (sz * ny))
        ? spec.raw_data
        : new Float32Array(sz * ny); // Width=sz, Height=ny

    // For each row Y (0..ny)
    //   For each col Z (0..sz)
    //      val = spectra_3d[z].raw_data[y*nx + current_x_index]

    for (let y = 0; y < ny; y++) {
        for (let z = 0; z < sz; z++) {
            let slice = spectra_3d[z];
            let val = 0;
            if (slice.raw_data && slice.raw_data.length > 0) {
                val = slice.raw_data[y * nx + current_x_index];
            }
            raw[y * sz + z] = val;
        }
    }
    spec.raw_data = raw;

    request_orthogonal_contour(spec, 0, "yz");
    request_orthogonal_contour(spec, 1, "yz");

    spectrum_yz = spec;

    // Handle Theoretical
    if (theoretical_spectra_3d && theoretical_spectra_3d.length > 0) {
        let base_spec_theo = theoretical_spectra_3d[0];

        let spec_theo = theoretical_spectrum_yz || new spectrum();
        spec_theo.n_direct = theoretical_spectra_3d.length;
        spec_theo.n_indirect = base_spec_theo.n_indirect;
        spec_theo.x_ppm_start = base_spec_theo.z_ppm_start;
        spec_theo.x_ppm_step = base_spec_theo.z_ppm_step;
        spec_theo.y_ppm_start = base_spec_theo.y_ppm_start;
        spec_theo.y_ppm_step = base_spec_theo.y_ppm_step;

        spec_theo.levels = base_spec_theo.levels;
        spec_theo.negative_levels = base_spec_theo.negative_levels;
        spec_theo.spectrum_color = base_spec_theo.spectrum_color;
        spec_theo.spectrum_color_negative = base_spec_theo.spectrum_color_negative;

        let sz = theoretical_spectra_3d.length;
        let nx = base_spec_theo.n_direct;
        let ny = base_spec_theo.n_indirect;

        let raw_theo = (spec_theo.raw_data && spec_theo.raw_data.length === (sz * ny))
            ? spec_theo.raw_data
            : new Float32Array(sz * ny);

        for (let y = 0; y < ny; y++) {
            for (let z = 0; z < sz; z++) {
                let slice = theoretical_spectra_3d[z];
                let val = 0;
                if (slice.raw_data && slice.raw_data.length > 0) {
                    val = slice.raw_data[y * nx + current_x_index];
                }
                raw_theo[y * sz + z] = val;
            }
        }
        spec_theo.raw_data = raw_theo;
        theoretical_spectrum_yz = spec_theo;

        request_orthogonal_contour(spec_theo, 0, "yz_theo");
        request_orthogonal_contour(spec_theo, 1, "yz_theo");
    }

    if (main_plot_yz) {
        main_plot_yz.local_spectra = [spec];
        if (theoretical_spectrum_yz) main_plot_yz.local_spectra.push(theoretical_spectrum_yz);

        // Visualize Theoretical Peaks on YZ Plot
        // YZ Plot:
        // Horizontal (X-axis): Z Dimension
        // Vertical (Y-axis): Indirect Dimension (Y)
        // Slice Dimension: Direct Dimension (X) -> current_x_index
        if (show_peak_symbols && typeof theoretical_peaks_data !== 'undefined' && theoretical_peaks_data.length > 0) {
            let visible_peaks_yz = [];
            let current_slice_x = current_x_index;
            let s = spectra_3d[0];

            for (let p of theoretical_peaks_data) {
                // Depth check (X dimension)
                let diff = p.x - current_slice_x;
                let abs_diff = Math.abs(diff);
                let width = p.fwhh_x; // X_FWHH

                if (abs_diff <= width) {
                    let symbol_type = 'circle';
                    let fill_flag = true;

                    if (abs_diff <= 1.0) {
                        symbol_type = 'square';
                        fill_flag = false;
                    } else if (diff < 0) {
                        // Behind slice
                        symbol_type = 'circle';
                        fill_flag = true;
                    } else {
                        // In front of slice
                        symbol_type = 'cross';
                        fill_flag = false;
                    }

                    let symbol_color = document.getElementById('color_peak_symbol') ? document.getElementById('color_peak_symbol').value : 'cyan';
                    // Map coordinates for YZ plot
                    // X-axis: Z PPM
                    // Y-axis: Y PPM
                    visible_peaks_yz.push({
                        x: p.z_ppm !== undefined ? p.z_ppm : (s.z_ppm_start + p.z * s.z_ppm_step),
                        y: p.y_ppm !== undefined ? p.y_ppm : (s.y_ppm_start + p.y * s.y_ppm_step),
                        symbol: symbol_type,
                        color: symbol_color,
                        size: (symbol_type === 'square') ? 6 : 5,
                        fill: fill_flag
                    });
                }
            }
            main_plot_yz.add_extra_peaks(visible_peaks_yz);
        } else {
            if (main_plot_yz) {
                main_plot_yz.add_extra_peaks([]);
            }
        }

        if (typeof partition_bounds_data !== "undefined" && partition_bounds_data !== null) {
            let z0 = s.z_ppm_start + partition_bounds_data.z[0] * s.z_ppm_step;
            let z1 = s.z_ppm_start + partition_bounds_data.z[1] * s.z_ppm_step;
            let y0 = s.y_ppm_start + partition_bounds_data.y[0] * s.y_ppm_step;
            let y1 = s.y_ppm_start + partition_bounds_data.y[1] * s.y_ppm_step;

            if (current_slice_x >= partition_bounds_data.x[0] && current_slice_x <= partition_bounds_data.x[1]) {
                // X-axis is Z PPM, Y-axis is Y PPM
                main_plot_yz.draw_bounding_box(z0, z1, y0, y1, 'red');
            } else {
                main_plot_yz.draw_bounding_box();
            }
        } else {
            if (main_plot_yz.draw_bounding_box) main_plot_yz.draw_bounding_box();
        }
    }
}

/**
 * Refreshes orthogonal plot.
 *
 * @param {any} type - Type
 */
function refresh_ortho_plot(type) {
    let plot = (type === "xz") ? main_plot_xz : main_plot_yz;
    let spec = (type === "xz") ? spectrum_xz : spectrum_yz;

    if (!plot || !spec) return;

    // Enable Interactions if not already
    if (!plot.has_ortho_interactions) {
        plot.setup_axis_pan();
        plot.setup_axis_wheel();
        plot.has_ortho_interactions = true;
    }

    // Update Scales and Axes
    let x_end = spec.x_ppm_start + spec.n_direct * spec.x_ppm_step;
    let y_end = spec.y_ppm_start + spec.n_indirect * spec.y_ppm_step;

    // Only reset to full range if plot is being initialized for the first time
    // Otherwise preserve the current zoom/pan state
    if (!plot.contour_plot) {
        plot.xscale = [spec.x_ppm_start, x_end];
        plot.yscale = [spec.y_ppm_start, y_end];
    }

    // Initialize Draw to setup scales and axes if needed
    if (!plot.contour_plot) {
        let canvas_id = (type === "xz") ? "canvas_xz" : "canvas_yz";
        plot.contour_plot = new webgl_contour_plot(canvas_id);

        // Ensure domains are set on the d3 scales before drawing axes
        plot.xRange.domain(plot.xscale);
        plot.yRange.domain(plot.yscale);

        plot.draw(); // Draws axes
    } else {
        // Plot already exists - preserve current zoom/pan state
        // Don't reset xscale/yscale here
    }

    let points_pos_list = [];
    let len_pos_list = [];
    let poly_pos_list = [];
    let points_neg_list = [];
    let len_neg_list = [];
    let poly_neg_list = [];
    let color_pos_list = [];
    let color_neg_list = [];
    let lbs_pos_list = [];
    let lbs_neg_list = [];
    let start_pos_list = [];
    let start_neg_list = [];
    let spectral_info_list = [];
    let spectral_order_list = [];

    let spectra_list = [spec];
    if (type === "xz" && theoretical_spectrum_xz) spectra_list.push(theoretical_spectrum_xz);
    if (type === "yz" && theoretical_spectrum_yz) spectra_list.push(theoretical_spectrum_yz);

    let total_points = 0;

    for (let i = 0; i < spectra_list.length; i++) {
        let s = spectra_list[i];

        // Ensure cached contours exist (might be loading)
        // If loading, just render empty for now on this refreshed cycle?
        // Or if base experimental is missing, we return earlier.

        let p_pos = s.cached_contour_pos ? s.cached_contour_pos.points : new Float32Array([]);
        if (!(p_pos instanceof Float32Array)) p_pos = new Float32Array(p_pos);

        let p_neg = s.cached_contour_neg ? s.cached_contour_neg.points : new Float32Array([]);
        if (!(p_neg instanceof Float32Array)) p_neg = new Float32Array(p_neg);

        points_pos_list.push(p_pos);
        points_neg_list.push(p_neg);

        len_pos_list.push(s.cached_contour_pos ? s.cached_contour_pos.levels_length : []);
        poly_pos_list.push(s.cached_contour_pos ? s.cached_contour_pos.polygon_length : []);

        len_neg_list.push(s.cached_contour_neg ? s.cached_contour_neg.levels_length : []);
        poly_neg_list.push(s.cached_contour_neg ? s.cached_contour_neg.polygon_length : []);

        color_pos_list.push(hexToRgb(s.spectrum_color));
        color_neg_list.push(s.spectrum_color_negative ? hexToRgb(s.spectrum_color_negative) : [0, 0, 0, 1]);

        lbs_pos_list.push(0);
        lbs_neg_list.push(0);

        start_pos_list.push(total_points);
        total_points += p_pos.length;
        start_neg_list.push(total_points);
        total_points += p_neg.length;

        spectral_info_list.push({
            x_ppm_start: s.x_ppm_start,
            x_ppm_step: s.x_ppm_step,
            y_ppm_start: s.y_ppm_start,
            y_ppm_step: s.y_ppm_step,
            x_ppm_ref: 0,
            y_ppm_ref: 0
        });

        spectral_order_list.push(i);
    }

    // Concatenate all points
    let combined_points = new Float32Array(total_points);
    let offset = 0;
    for (let i = 0; i < spectra_list.length; i++) {
        combined_points.set(points_pos_list[i], offset);
        offset += points_pos_list[i].length;
        combined_points.set(points_neg_list[i], offset);
        offset += points_neg_list[i].length;
    }

    plot.contour_plot.spectral_order = spectral_order_list;

    plot.contour_plot.set_data(
        spectral_info_list,
        combined_points,
        start_pos_list,
        poly_pos_list,
        len_pos_list,
        color_pos_list,
        lbs_pos_list,
        start_neg_list,
        poly_neg_list,
        len_neg_list,
        color_neg_list,
        lbs_neg_list
    );

    // Sync Camera
    let x_dom = plot.xRange.domain();
    let y_dom = plot.yRange.domain();
    plot.contour_plot.setCamera_ppm(x_dom[0], x_dom[1], y_dom[0], y_dom[1]);
    plot.contour_plot.drawScene();
}

/**
 * Clamps index 3D.
 *
 * @param {any} value - Value
 * @param {any} maxExclusive - Max exclusive
 */
function clamp_index_3d(value, maxExclusive) {
    if (!Number.isFinite(value) || maxExclusive <= 0) {
        return 0;
    }
    return Math.max(0, Math.min(maxExclusive - 1, Math.round(value)));
}

/**
 * Gets crosshair center PPM 3D.
 */
function get_crosshair_center_ppm_3d() {
    if (!spectra_3d || spectra_3d.length === 0) {
        return null;
    }

    let s = spectra_3d[0];
    let ppm_x;
    let ppm_y;
    let ppm_z;

    if (main_plot && main_plot.xRange && main_plot.yRange) {
        let x_domain = main_plot.xRange.domain();
        let y_domain = main_plot.yRange.domain();
        ppm_x = (x_domain[0] + x_domain[1]) / 2;
        ppm_y = (y_domain[0] + y_domain[1]) / 2;
    } else {
        ppm_x = s.x_ppm_start + (current_x_index * s.x_ppm_step);
        ppm_y = s.y_ppm_start + (current_y_index * s.y_ppm_step);
    }

    if (main_plot_xz && main_plot_xz.yRange) {
        let z_domain = main_plot_xz.yRange.domain();
        ppm_z = (z_domain[0] + z_domain[1]) / 2;
    } else if (main_plot_yz && main_plot_yz.xRange) {
        let z_domain = main_plot_yz.xRange.domain();
        ppm_z = (z_domain[0] + z_domain[1]) / 2;
    } else {
        ppm_z = s.z_ppm_start + (current_slice_index * s.z_ppm_step);
    }

    return {
        ppm_x: ppm_x,
        ppm_y: ppm_y,
        ppm_z: ppm_z
    };
}

/**
 * Gets trace domain 3D.
 *
 * @param {any} dim - Dimension
 * @param {any} s0 - S0
 */
function get_trace_domain_3d(dim, s0) {
    if (!s0) {
        return [0, 1];
    }

    if (dim === 'x') {
        return [s0.x_ppm_start, s0.x_ppm_start + (s0.n_direct - 1) * s0.x_ppm_step];
    }
    if (dim === 'y') {
        return [s0.y_ppm_start, s0.y_ppm_start + (s0.n_indirect - 1) * s0.y_ppm_step];
    }
    return [s0.z_ppm_start, s0.z_ppm_start + (spectra_3d.length - 1) * s0.z_ppm_step];
}


/**
 * Extracts trace 3D.
 *
 * @param {any} dim - Dimension
 * @param {any} xIndex - X index
 * @param {any} yIndex - Y index
 * @param {any} zIndex - Z index
 * @param {any} s0 - S0
 */
function extract_trace_3d(dim, xIndex, yIndex, zIndex, s0, spectra_source_list) {
    let source_list = spectra_source_list || spectra_3d;
    let points = [];
    if (!s0 || !source_list || source_list.length === 0) {
        return points;
    }

    const nx = s0.n_direct;
    const ny = s0.n_indirect;
    const nz = source_list.length;

    if (dim === 'z') {
        for (let z = 0; z < nz; z++) {
            let slice = source_list[z];
            let val = 0;
            if (slice && slice.raw_data) {
                val = slice.raw_data[yIndex * nx + xIndex] || 0;
            }
            points.push({ ppm: s0.z_ppm_start + z * s0.z_ppm_step, value: val });
        }
        return points;
    }

    let slice = source_list[zIndex];
    if (!slice || !slice.raw_data) {
        return points;
    }

    if (dim === 'y') {
        for (let y = 0; y < ny; y++) {
            points.push({
                ppm: s0.y_ppm_start + y * s0.y_ppm_step,
                value: slice.raw_data[y * nx + xIndex] || 0
            });
        }
        return points;
    }

    if (dim === 'x') {
        let has_ri = source_list.every(s => s.raw_data_ri && s.raw_data_ri.length > 0);
        let p0_rad = trace_x_ph0 * Math.PI / 180.0;
        let p1_rad = trace_x_ph1 * Math.PI / 180.0;
        let pivot_idx = trace_x_pivot !== null ? Math.round((trace_x_pivot - s0.x_ppm_start) / s0.x_ppm_step) : 0;

        for (let x = 0; x < nx; x++) {
            let re = slice.raw_data[yIndex * nx + x] || 0;
            let val = re;

            if (has_ri) {
                let im = slice.raw_data_ri[yIndex * nx + x] || 0;
                let phase_rad;
                if (trace_x_pivot === null) {
                    phase_rad = p0_rad;
                } else {
                    phase_rad = p0_rad + p1_rad * (x - pivot_idx) / nx;
                }
                val = re * Math.cos(phase_rad) - im * Math.sin(phase_rad);
            }

            points.push({
                ppm: s0.x_ppm_start + x * s0.x_ppm_step,
                value: val
            });
        }
    }
    return points;
}

/**
 * Clears 1d trace SVG.
 *
 * @param {any} svgId - SVG id
 */
function clear_1d_trace_svg(svgId) {
    const svgEl = document.getElementById(svgId);
    if (!svgEl) {
        return;
    }
    d3.select(svgEl).selectAll('*').remove();
}

/**
 * Clears all 1d traces.
 */
function clear_all_1d_traces() {
    clear_1d_trace_svg('trace_z_svg');
    clear_1d_trace_svg('trace_y_svg');
    clear_1d_trace_svg('trace_x_svg');
    clear_1d_trace_svg('trace_proj_x_svg');
    clear_1d_trace_svg('trace_proj_y_x_svg');
    clear_1d_trace_svg('trace_proj_z_svg');
}

/**
 * Renders trace 3D.
 *
 * @param {any} svgId - SVG id
 * @param {any} points - Points
 * @param {any} xDomain - X domain
 * @param {any} lineColor - Line color
 */
function render_trace_3d(svgId, points, xDomain, lineColor, points_recon = null) {
    const svgEl = document.getElementById(svgId);
    if (!svgEl) {
        return;
    }

    const svg = d3.select(svgEl);
    svg.selectAll('*').remove();

    if (!points || points.length === 0) {
        return;
    }

    const width = parseFloat(svg.attr('width')) || svgEl.clientWidth || 600;
    const height = parseFloat(svg.attr('height')) || svgEl.clientHeight || 120;
    const m = trace_plot_margins_3d;
    const plotWidth = Math.max(10, width - m.left - m.right);
    const plotHeight = Math.max(10, height - m.top - m.bottom);

    const xScale = d3.scaleLinear()
        .domain(xDomain)
        .range([m.left, m.left + plotWidth]);

    const xMin = Math.min(xDomain[0], xDomain[1]);
    const xMax = Math.max(xDomain[0], xDomain[1]);
    const visiblePoints = points.filter(function (p) {
        return p.ppm >= xMin && p.ppm <= xMax;
    });
    const ySource = visiblePoints.length > 0 ? visiblePoints : points;

    let visiblePointsRecon = [];
    if (points_recon && points_recon.length > 0) {
        visiblePointsRecon = points_recon.filter(function (p) {
            return p.ppm >= xMin && p.ppm <= xMax;
        });
    }

    let yMin = d3.min(ySource, function (d) { return d.value; });
    let yMax = d3.max(ySource, function (d) { return d.value; });

    if (points_recon && points_recon.length > 0) {
        let ySourceRecon = visiblePointsRecon.length > 0 ? visiblePointsRecon : points_recon;
        let yMinRecon = d3.min(ySourceRecon, function (d) { return d.value; });
        let yMaxRecon = d3.max(ySourceRecon, function (d) { return d.value; });
        if (Number.isFinite(yMinRecon)) {
            yMin = Math.min(yMin, yMinRecon);
        }
        if (Number.isFinite(yMaxRecon)) {
            yMax = Math.max(yMax, yMaxRecon);
        }
    }

    if (!Number.isFinite(yMin) || !Number.isFinite(yMax)) {
        yMin = -1;
        yMax = 1;
    }
    if (yMin === yMax) {
        const padEq = Math.max(Math.abs(yMin) * 0.2, 1e-6);
        yMin -= padEq;
        yMax += padEq;
    }
    const pad = (yMax - yMin) * 0.08;
    yMin -= pad;
    yMax += pad;

    const yScale = d3.scaleLinear()
        .domain([yMin, yMax])
        .range([m.top + plotHeight, m.top]);

    const line = d3.line()
        .x(function (d) { return xScale(d.ppm); })
        .y(function (d) { return yScale(d.value); })
        .defined(function (d) {
            return Number.isFinite(d.ppm) && Number.isFinite(d.value);
        });

    // Clipping Path
    const clipId = 'clip-' + svgId;
    svg.append('defs').append('clipPath')
        .attr('id', clipId)
        .append('rect')
        .attr('x', m.left)
        .attr('y', m.top)
        .attr('width', plotWidth)
        .attr('height', plotHeight);

    // Axes
    svg.append('g')
        .attr('transform', 'translate(0,' + (m.top + plotHeight) + ')')
        .call(d3.axisBottom(xScale).ticks(6));

    svg.append('g')
        .attr('transform', 'translate(' + m.left + ',0)')
        .call(d3.axisLeft(yScale).ticks(4));

    // Plot Content Group (clipped)
    const plotGroup = svg.append('g')
        .attr('clip-path', 'url(#' + clipId + ')');

    if (yMin < 0 && yMax > 0) {
        plotGroup.append('line')
            .attr('x1', m.left)
            .attr('x2', m.left + plotWidth)
            .attr('y1', yScale(0))
            .attr('y2', yScale(0))
            .attr('stroke', '#b0b0b0')
            .attr('stroke-width', 1)
            .attr('stroke-dasharray', '3,2');
    }

    // Experimental Line (Blue)
    plotGroup.append('path')
        .datum(points)
        .attr('fill', 'none')
        .attr('stroke', '#0000ff')
        .attr('stroke-width', 1.5)
        .attr('d', line);

    // Reconstructed Line (Red)
    if (points_recon && points_recon.length > 0) {
        plotGroup.append('path')
            .datum(points_recon)
            .attr('fill', 'none')
            .attr('stroke', '#ff0000')
            .attr('stroke-width', 1.5)
            .attr('d', line);
    }

    // Circles for Experimental
    if (visiblePoints.length < 64) {
        plotGroup.selectAll('.trace-circle-exp')
            .data(visiblePoints.filter(function (d) {
                return Number.isFinite(d.ppm) && Number.isFinite(d.value);
            }))
            .enter()
            .append('circle')
            .attr('class', 'trace-circle-exp')
            .attr('cx', function (d) { return xScale(d.ppm); })
            .attr('cy', function (d) { return yScale(d.value); })
            .attr('r', 3)
            .attr('fill', '#0000ff')
            .attr('stroke', '#fff')
            .attr('stroke-width', 1)
            .style('pointer-events', 'none');
    }

    // Circles for Reconstructed
    if (points_recon && points_recon.length > 0 && visiblePointsRecon.length < 64) {
        plotGroup.selectAll('.trace-circle-recon')
            .data(visiblePointsRecon.filter(function (d) {
                return Number.isFinite(d.ppm) && Number.isFinite(d.value);
            }))
            .enter()
            .append('circle')
            .attr('class', 'trace-circle-recon')
            .attr('cx', function (d) { return xScale(d.ppm); })
            .attr('cy', function (d) { return yScale(d.value); })
            .attr('r', 3)
            .attr('fill', '#ff0000')
            .attr('stroke', '#fff')
            .attr('stroke-width', 1)
            .style('pointer-events', 'none');
    }

    // Pivot Line and Phase Labels Overlay
    if (svgId === 'trace_x_svg' || svgId === 'trace_proj_x_svg' || svgId === 'trace_proj_y_x_svg') {
        // Pivot Line
        if (trace_x_pivot !== null) {
            plotGroup.append('line')
                .attr('x1', xScale(trace_x_pivot))
                .attr('x2', xScale(trace_x_pivot))
                .attr('y1', m.top)
                .attr('y2', m.top + plotHeight)
                .attr('stroke', 'magenta')
                .attr('stroke-width', 1.5)
                .attr('stroke-dasharray', '4,2');

            plotGroup.append('text')
                .attr('x', xScale(trace_x_pivot) + 4)
                .attr('y', m.top + 12)
                .attr('fill', 'magenta')
                .attr('font-size', '10px')
                .attr('font-weight', 'bold')
                .text('Pivot');
        }

        // Phase Labels Overlay
        const infoGroup = svg.append('g')
            .attr('transform', `translate(${m.left + plotWidth - 10}, ${m.top + 10})`)
            .attr('text-anchor', 'end')
            .style('pointer-events', 'none');

        infoGroup.append('text')
            .attr('y', 10)
            .attr('font-size', '12px')
            .attr('font-weight', 'bold')
            .attr('fill', '#333')
            .text(`P0: ${trace_x_ph0.toFixed(1)}°`);

        infoGroup.append('text')
            .attr('y', 25)
            .attr('font-size', '12px')
            .attr('font-weight', 'bold')
            .attr('fill', '#333')
            .text(`P1: ${trace_x_ph1.toFixed(1)}°`);
    }

    // Brush for Zooming
    const brush = d3.brushX()
        .extent([[m.left, m.top], [m.left + plotWidth, m.top + plotHeight]])
        .on('end', function (event) {
            if (!event.selection) return;
            const [x0, x1] = event.selection.map(xScale.invert);
            trace_zoom_domains[svgId] = [x0, x1];
            update_1d_traces_from_center();
        });

    svg.append('g')
        .attr('class', 'brush')
        .call(brush);

    // Double click to reset zoom
    svg.on('dblclick', function () {
        trace_zoom_domains[svgId] = null;
        update_1d_traces_from_center();
    });

    if (svgId === 'trace_x_svg' || svgId === 'trace_proj_x_svg' || svgId === 'trace_proj_y_x_svg') {
        const set_pivot = function (event) {
            if (!spectra_3d || spectra_3d.length === 0) return;
            if (!spectra_3d.every(s => s.raw_data_ri && s.raw_data_ri.length > 0)) return;

            let rect = svgEl.getBoundingClientRect();
            let mouseX = event.clientX - rect.left;
            // Only set pivot if clicked within plot area
            if (mouseX >= m.left && mouseX <= m.left + plotWidth) {
                trace_x_pivot = xScale.invert(mouseX);
            } else {
                trace_x_pivot = null;
            }

            let IDs = ['trace_x_pivot_val', 'trace_proj_x_pivot_val', 'trace_proj_y_x_pivot_val'];
            IDs.forEach(id => {
                let el = document.getElementById(id);
                if (el) el.innerText = trace_x_pivot !== null ? trace_x_pivot.toFixed(2) + ' ppm' : 'not set';
            });
            update_1d_traces_from_center();
        };

        svg.on('contextmenu', function (event) {
            event.preventDefault();
            set_pivot(event);
        });

        // Also allow regular click to set pivot, but check if it was a drag
        let mouseDownPos = null;
        svg.on('mousedown', function (event) {
            mouseDownPos = [event.clientX, event.clientY];
        });
        svg.on('mouseup', function (event) {
            if (!mouseDownPos) return;
            let dist = Math.sqrt(Math.pow(event.clientX - mouseDownPos[0], 2) + Math.pow(event.clientY - mouseDownPos[1], 2));
            if (dist < 3) {
                // It's a click
                set_pivot(event);
            }
            mouseDownPos = null;
        });

        svg.on('wheel', function (event) {
            if (!spectra_3d || spectra_3d.length === 0) return;
            if (!spectra_3d.every(s => s.raw_data_ri && s.raw_data_ri.length > 0)) return;

            event.preventDefault();
            let delta = event.deltaY;
            let step = 1.0;
            if (event.shiftKey) step = 1.0;
            else if (event.ctrlKey) step = 0.1;

            let direction = delta > 0 ? -1 : 1;
            if (trace_x_pivot === null) {
                trace_x_ph0 += direction * step;
                let valSpan = document.getElementById('trace_x_ph0_val');
                if (valSpan) valSpan.innerText = trace_x_ph0.toFixed(1);
                let valProjSpan = document.getElementById('trace_proj_x_ph0_val');
                if (valProjSpan) valProjSpan.innerText = trace_x_ph0.toFixed(1);
                let valProjYSpan = document.getElementById('trace_proj_y_x_ph0_val');
                if (valProjYSpan) valProjYSpan.innerText = trace_x_ph0.toFixed(1);
            } else {
                trace_x_ph1 += direction * step;
                let valSpan = document.getElementById('trace_x_ph1_val');
                if (valSpan) valSpan.innerText = trace_x_ph1.toFixed(1);
                let valProjSpan = document.getElementById('trace_proj_x_ph1_val');
                if (valProjSpan) valProjSpan.innerText = trace_x_ph1.toFixed(1);
                let valProjYSpan = document.getElementById('trace_proj_y_x_ph1_val');
                if (valProjYSpan) valProjYSpan.innerText = trace_x_ph1.toFixed(1);
            }
            update_1d_traces_from_center();
        });
    }
}


/**
 * Updates 1d traces from center.
 */
function update_1d_traces_from_center() {
    if (!spectra_3d || spectra_3d.length === 0) {
        clear_all_1d_traces();
        return;
    }

    const s0 = spectra_3d[0];
    if (!s0) {
        clear_all_1d_traces();
        return;
    }

    const center = get_crosshair_center_ppm_3d();
    if (!center) {
        clear_all_1d_traces();
        return;
    }

    const xIndex = clamp_index_3d((center.ppm_x - s0.x_ppm_start) / s0.x_ppm_step, s0.n_direct);
    const yIndex = clamp_index_3d((center.ppm_y - s0.y_ppm_start) / s0.y_ppm_step, s0.n_indirect);
    const zIndex = clamp_index_3d((center.ppm_z - s0.z_ppm_start) / s0.z_ppm_step, spectra_3d.length);

    const traceZ = extract_trace_3d('z', xIndex, yIndex, zIndex, s0);
    const traceY = extract_trace_3d('y', xIndex, yIndex, zIndex, s0);
    const traceX = extract_trace_3d('x', xIndex, yIndex, zIndex, s0);

    let traceZ_recon = null;
    let traceY_recon = null;
    let traceX_recon = null;

    if (theoretical_spectra_3d && theoretical_spectra_3d.length > 0) {
        traceZ_recon = extract_trace_3d('z', xIndex, yIndex, zIndex, s0, theoretical_spectra_3d);
        traceY_recon = extract_trace_3d('y', xIndex, yIndex, zIndex, s0, theoretical_spectra_3d);
        traceX_recon = extract_trace_3d('x', xIndex, yIndex, zIndex, s0, theoretical_spectra_3d);
    }

    const domainZ = trace_zoom_domains['trace_z_svg'] || get_trace_domain_3d('z', s0);
    const domainY = trace_zoom_domains['trace_y_svg'] || get_trace_domain_3d('y', s0);
    const domainX = trace_zoom_domains['trace_x_svg'] || get_trace_domain_3d('x', s0);

    render_trace_3d('trace_z_svg', traceZ, domainZ, '#0000ff', traceZ_recon);
    render_trace_3d('trace_y_svg', traceY, domainY, '#0000ff', traceY_recon);
    render_trace_3d('trace_x_svg', traceX, domainX, '#0000ff', traceX_recon);

    // Get dynamic labels for axes using window.last_fid_nuclei
    const nx = window.last_fid_nuclei.x;
    const ny = window.last_fid_nuclei.y;
    const nz = window.last_fid_nuclei.z;

    const getAxisName = (axis, nuc) => {
        return nuc ? `${axis} (${nuc})` : axis;
    };

    const labelX = getAxisName("x", nx); // direct dim, internal x
    const labelY = getAxisName("y", ny); // indirect 1, internal y
    const labelZ = getAxisName("z", nz); // indirect 2, internal z

    // Update Trace Z label (internal z -> UI z)
    const labelZ_elem = document.getElementById('trace_z_label');
    if (labelZ_elem) {
        const span = labelZ_elem.querySelector('span');
        if (span) {
            span.innerText = `1D Trace Along ${labelZ} (at ${labelX}=${center.ppm_x.toFixed(3)} ppm, ${labelY}=${center.ppm_y.toFixed(3)} ppm)`;
        }
    }

    // Update Trace Y label (internal y -> UI y)
    const labelY_elem = document.getElementById('trace_y_label');
    if (labelY_elem) {
        const span = labelY_elem.querySelector('span');
        if (span) {
            span.innerText = `1D Trace Along ${labelY} (at ${labelX}=${center.ppm_x.toFixed(3)} ppm, ${labelZ}=${center.ppm_z.toFixed(3)} ppm)`;
        }
    }

    // Update Trace X label (internal x -> UI x)
    const labelX_elem = document.getElementById('trace_x_label');
    if (labelX_elem) {
        const span = labelX_elem.querySelector('span');
        if (span) {
            span.innerText = `1D Trace Along ${labelX} (at ${labelY}=${center.ppm_y.toFixed(3)} ppm, ${labelZ}=${center.ppm_z.toFixed(3)} ppm)`;
        }
    }

    // Update Projection 1D Trace
    if (spectrum_proj && spectrum_proj.raw_data) {
        const traceProjX = [];
        const nx_proj = spectrum_proj.n_direct;
        const ny_proj = spectrum_proj.n_indirect;

        // Use projection view center for the projection 1D trace
        let target_y_ppm;
        if (main_plot_proj && main_plot_proj.yRange) {
            let y_domain = main_plot_proj.yRange.domain();
            target_y_ppm = (y_domain[0] + y_domain[1]) / 2;
        } else {
            target_y_ppm = center.ppm_y;
        }

        const pyIndex = clamp_index_3d((target_y_ppm - spectrum_proj.y_ppm_start) / spectrum_proj.y_ppm_step, ny_proj);

        let p0_rad = trace_x_ph0 * Math.PI / 180.0;
        let p1_rad = trace_x_ph1 * Math.PI / 180.0;
        let pivot_idx = trace_x_pivot !== null ? Math.round((trace_x_pivot - spectrum_proj.x_ppm_start) / spectrum_proj.x_ppm_step) : 0;
        let has_ri = spectrum_proj.raw_data_ri && spectrum_proj.raw_data_ri.length > 0;

        for (let x = 0; x < nx_proj; x++) {
            let re = spectrum_proj.raw_data[pyIndex * nx_proj + x] || 0;
            let val = re;
            if (has_ri) {
                let im = spectrum_proj.raw_data_ri[pyIndex * nx_proj + x] || 0;
                let phase_rad;
                if (trace_x_pivot === null) {
                    phase_rad = p0_rad;
                } else {
                    phase_rad = p0_rad + p1_rad * (x - pivot_idx) / nx_proj;
                }
                val = re * Math.cos(phase_rad) - im * Math.sin(phase_rad);
            }
            traceProjX.push({
                ppm: spectrum_proj.x_ppm_start + x * spectrum_proj.x_ppm_step,
                value: val
            });
        }

        // Extract Reconstruction Projection Trace if available
        let traceProjX_recon = null;
        if (theoretical_spectrum_proj && theoretical_spectrum_proj.raw_data) {
            traceProjX_recon = [];
            let nx_theo = theoretical_spectrum_proj.n_direct;
            let ny_theo = theoretical_spectrum_proj.n_indirect;
            let pyIndex_theo = clamp_index_3d((target_y_ppm - theoretical_spectrum_proj.y_ppm_start) / theoretical_spectrum_proj.y_ppm_step, ny_theo);
            let has_ri_theo = theoretical_spectrum_proj.raw_data_ri && theoretical_spectrum_proj.raw_data_ri.length > 0;

            for (let x = 0; x < nx_theo; x++) {
                let re = theoretical_spectrum_proj.raw_data[pyIndex_theo * nx_theo + x] || 0;
                let val = re;
                if (has_ri_theo) {
                    let im = theoretical_spectrum_proj.raw_data_ri[pyIndex_theo * nx_theo + x] || 0;
                    let phase_rad;
                    if (trace_x_pivot === null) {
                        phase_rad = p0_rad;
                    } else {
                        phase_rad = p0_rad + p1_rad * (x - pivot_idx) / nx_theo;
                    }
                    val = re * Math.cos(phase_rad) - im * Math.sin(phase_rad);
                }
                traceProjX_recon.push({
                    ppm: theoretical_spectrum_proj.x_ppm_start + x * theoretical_spectrum_proj.x_ppm_step,
                    value: val
                });
            }
        }

        // Always show independent range for 1D trace (can be zoomed by its own brush)
        const domainProjX = trace_zoom_domains['trace_proj_x_svg'] || [spectrum_proj.x_ppm_start, spectrum_proj.x_ppm_start + (nx_proj - 1) * spectrum_proj.x_ppm_step];
        render_trace_3d('trace_proj_x_svg', traceProjX, domainProjX, '#0000ff', traceProjX_recon);

        // Update label to indicate if it's a cross-section or center
        const label = document.getElementById('trace_proj_x_label');
        if (label) {
            const span = label.querySelector('span');
            if (span) {
                const ppm_str = target_y_ppm.toFixed(3);
                span.innerText = `1D Trace Along ${labelX} (at ${labelY}=${ppm_str} ppm)`;
            }
        }
    }

    // Update Y-Projection 1D Trace (Trace along Z at some Y)
    if (spectrum_proj_y && spectrum_proj_y.raw_data) {
        const traceProjYX = [];
        const nx_proj = spectrum_proj_y.n_direct;
        const nz_proj = spectrum_proj_y.n_indirect;

        let target_z_ppm;
        if (main_plot_proj_y && main_plot_proj_y.yRange) {
            let z_domain = main_plot_proj_y.yRange.domain();
            target_z_ppm = (z_domain[0] + z_domain[1]) / 2;
        } else {
            target_z_ppm = center.ppm_z;
        }

        const pzIndex = clamp_index_3d((target_z_ppm - spectrum_proj_y.y_ppm_start) / spectrum_proj_y.y_ppm_step, nz_proj);

        // Use same phase as other X-traces
        let p0_rad = trace_x_ph0 * Math.PI / 180.0;
        let p1_rad = trace_x_ph1 * Math.PI / 180.0;
        let pivot_idx = trace_x_pivot !== null ? Math.round((trace_x_pivot - spectrum_proj_y.x_ppm_start) / spectrum_proj_y.x_ppm_step) : 0;
        let has_ri = spectrum_proj_y.raw_data_ri && spectrum_proj_y.raw_data_ri.length > 0;

        for (let x = 0; x < nx_proj; x++) {
            let re = spectrum_proj_y.raw_data[pzIndex * nx_proj + x] || 0;
            let val = re;
            if (has_ri) {
                let im = spectrum_proj_y.raw_data_ri[pzIndex * nx_proj + x] || 0;
                let phase_rad;
                if (trace_x_pivot === null) {
                    phase_rad = p0_rad;
                } else {
                    phase_rad = p0_rad + p1_rad * (x - pivot_idx) / nx_proj;
                }
                val = re * Math.cos(phase_rad) - im * Math.sin(phase_rad);
            }
            traceProjYX.push({
                ppm: spectrum_proj_y.x_ppm_start + x * spectrum_proj_y.x_ppm_step,
                value: val
            });
        }

        // Extract Reconstruction Projection Trace if available
        let traceProjYX_recon = null;
        if (theoretical_spectrum_proj_y && theoretical_spectrum_proj_y.raw_data) {
            traceProjYX_recon = [];
            let nx_theo = theoretical_spectrum_proj_y.n_direct;
            let nz_theo = theoretical_spectrum_proj_y.n_indirect;
            let pzIndex_theo = clamp_index_3d((target_z_ppm - theoretical_spectrum_proj_y.y_ppm_start) / theoretical_spectrum_proj_y.y_ppm_step, nz_theo);
            let has_ri_theo = theoretical_spectrum_proj_y.raw_data_ri && theoretical_spectrum_proj_y.raw_data_ri.length > 0;

            for (let x = 0; x < nx_theo; x++) {
                let re = theoretical_spectrum_proj_y.raw_data[pzIndex_theo * nx_theo + x] || 0;
                let val = re;
                if (has_ri_theo) {
                    let im = theoretical_spectrum_proj_y.raw_data_ri[pzIndex_theo * nx_theo + x] || 0;
                    let phase_rad;
                    if (trace_x_pivot === null) {
                        phase_rad = p0_rad;
                    } else {
                        phase_rad = p0_rad + p1_rad * (x - pivot_idx) / nx_theo;
                    }
                    val = re * Math.cos(phase_rad) - im * Math.sin(phase_rad);
                }
                traceProjYX_recon.push({
                    ppm: theoretical_spectrum_proj_y.x_ppm_start + x * theoretical_spectrum_proj_y.x_ppm_step,
                    value: val
                });
            }
        }

        const domainProjYX = trace_zoom_domains['trace_proj_y_x_svg'] || [spectrum_proj_y.x_ppm_start, spectrum_proj_y.x_ppm_start + (nx_proj - 1) * spectrum_proj_y.x_ppm_step];
        render_trace_3d('trace_proj_y_x_svg', traceProjYX, domainProjYX, '#0000ff', traceProjYX_recon);

        const label = document.getElementById('trace_proj_y_x_label');
        if (label) {
            const span = label.querySelector('span');
            if (span) {
                span.innerText = `1D Trace Along ${labelX} (at ${labelZ}=${target_z_ppm.toFixed(3)} ppm)`;
            }
        }
    }

    // Update X-Projection 1D Trace (Trace along X at some Y)
    if (spectrum_proj_x && spectrum_proj_x.raw_data) {
        const traceProjZX = [];
        const n_direct = spectrum_proj_x.n_direct;
        const n_indirect = spectrum_proj_x.n_indirect;

        let target_y_ppm;
        if (main_plot_proj_x && main_plot_proj_x.yRange) {
            let y_domain = main_plot_proj_x.yRange.domain();
            target_y_ppm = (y_domain[0] + y_domain[1]) / 2;
        } else {
            target_y_ppm = center.ppm_y;
        }

        const pyIndex = clamp_index_3d((target_y_ppm - spectrum_proj_x.y_ppm_start) / spectrum_proj_x.y_ppm_step, n_indirect);

        for (let x = 0; x < n_direct; x++) {
            let val = spectrum_proj_x.raw_data[pyIndex * n_direct + x] || 0;
            traceProjZX.push({
                ppm: spectrum_proj_x.x_ppm_start + x * spectrum_proj_x.x_ppm_step,
                value: val
            });
        }

        // Extract Reconstruction Projection Trace if available
        let traceProjZX_recon = null;
        if (theoretical_spectrum_proj_x && theoretical_spectrum_proj_x.raw_data) {
            traceProjZX_recon = [];
            let n_direct_theo = theoretical_spectrum_proj_x.n_direct;
            let n_indirect_theo = theoretical_spectrum_proj_x.n_indirect;
            let pyIndex_theo = clamp_index_3d((target_y_ppm - theoretical_spectrum_proj_x.y_ppm_start) / theoretical_spectrum_proj_x.y_ppm_step, n_indirect_theo);

            for (let x = 0; x < n_direct_theo; x++) {
                let val = theoretical_spectrum_proj_x.raw_data[pyIndex_theo * n_direct_theo + x] || 0;
                traceProjZX_recon.push({
                    ppm: theoretical_spectrum_proj_x.x_ppm_start + x * theoretical_spectrum_proj_x.x_ppm_step,
                    value: val
                });
            }
        }

        const domainProjZX = trace_zoom_domains['trace_proj_z_svg'] || [spectrum_proj_x.x_ppm_start, spectrum_proj_x.x_ppm_start + (n_direct - 1) * spectrum_proj_x.x_ppm_step];
        render_trace_3d('trace_proj_z_svg', traceProjZX, domainProjZX, '#0000ff', traceProjZX_recon);

        const label = document.getElementById('trace_proj_z_label');
        if (label) {
            const span = label.querySelector('span');
            if (span) {
                span.innerText = `1D Trace Along ${labelY} (at ${labelZ}=${target_y_ppm.toFixed(3)} ppm)`;
            }
        }
    }
}


/**
 * Updates 3D crosshairs.
 */
function update_3d_crosshairs() {
    if (!spectra_3d || spectra_3d.length === 0) return;

    let s = spectra_3d[0]; // Reference for PPM calculation

    let ppm_x, ppm_y, ppm_z;

    // Use view centers to keep cyan lines visually centered on screen during zoom/pan
    if (main_plot && main_plot.xRange && main_plot.yRange) {
        let x_domain = main_plot.xRange.domain();
        let y_domain = main_plot.yRange.domain();
        ppm_x = (x_domain[0] + x_domain[1]) / 2;
        ppm_y = (y_domain[0] + y_domain[1]) / 2;
    } else {
        ppm_x = s.x_ppm_start + (current_x_index * s.x_ppm_step);
        ppm_y = s.y_ppm_start + (current_y_index * s.y_ppm_step);
    }

    if (main_plot_xz && main_plot_xz.yRange) {
        let z_domain = main_plot_xz.yRange.domain();
        ppm_z = (z_domain[0] + z_domain[1]) / 2;
    } else if (main_plot_yz && main_plot_yz.xRange) {
        let z_domain = main_plot_yz.xRange.domain();
        ppm_z = (z_domain[0] + z_domain[1]) / 2;
    } else {
        ppm_z = s.z_ppm_start + (current_slice_index * s.z_ppm_step);
    }
    // Update Main Plot (XY)
    if (main_plot && typeof main_plot.draw_center_lines === 'function') {
        main_plot.draw_center_lines(ppm_x, ppm_y);
    }

    // Update XZ Plot (Direct vs Z) - arguments: (X_PPM, Z_PPM)
    if (main_plot_xz && typeof main_plot_xz.draw_center_lines === 'function') {
        main_plot_xz.draw_center_lines(ppm_x, ppm_z);
    }

    // Update YZ Plot (Z vs Indirect) - arguments: (Z_PPM, Y_PPM)
    if (main_plot_yz && typeof main_plot_yz.draw_center_lines === 'function') {
        main_plot_yz.draw_center_lines(ppm_z, ppm_y);
    }

    // Update Projection Plot (XY Projection) - center crosshair
    if (main_plot_proj && main_plot_proj.xRange && main_plot_proj.yRange && typeof main_plot_proj.draw_center_lines === 'function') {
        let x_domain = main_plot_proj.xRange.domain();
        let y_domain = main_plot_proj.yRange.domain();
        let proj_ppm_x = (x_domain[0] + x_domain[1]) / 2;
        let proj_ppm_y = (y_domain[0] + y_domain[1]) / 2;
        main_plot_proj.draw_center_lines(proj_ppm_x, proj_ppm_y);
    }

    // Update Y-Projection Plot (XZ Projection) - center crosshair
    if (main_plot_proj_y && main_plot_proj_y.xRange && main_plot_proj_y.yRange && typeof main_plot_proj_y.draw_center_lines === 'function') {
        let x_domain = main_plot_proj_y.xRange.domain();
        let y_domain = main_plot_proj_y.yRange.domain();
        let proj_ppm_x = (x_domain[0] + x_domain[1]) / 2;
        let proj_ppm_z = (y_domain[0] + y_domain[1]) / 2;
        main_plot_proj_y.draw_center_lines(proj_ppm_x, proj_ppm_z);
    }

    // Update X-Projection Plot (XY Projection) - center crosshair
    if (main_plot_proj_x && main_plot_proj_x.xRange && main_plot_proj_x.yRange && typeof main_plot_proj_x.draw_center_lines === 'function') {
        let x_domain = main_plot_proj_x.xRange.domain();
        let y_domain = main_plot_proj_x.yRange.domain();
        let proj_ppm_x = (x_domain[0] + x_domain[1]) / 2;
        let proj_ppm_y = (y_domain[0] + y_domain[1]) / 2;
        main_plot_proj_x.draw_center_lines(proj_ppm_x, proj_ppm_y);
    }

    // Update Info Div using precise matching index strings based on view
    let info_div = document.getElementById("center_info");
    if (info_div) {
        let dx = Math.round((ppm_x - s.x_ppm_start) / s.x_ppm_step);
        let dy = Math.round((ppm_y - s.y_ppm_start) / s.y_ppm_step);
        let dz = Math.round((ppm_z - s.z_ppm_start) / s.z_ppm_step);
        info_div.innerHTML = `
            X: ${ppm_x.toFixed(3)} ppm (${dx})<br>
            Y: ${ppm_y.toFixed(3)} ppm (${dy})<br>
            Z: ${ppm_z.toFixed(3)} ppm (${dz})
        `;
    }

    update_1d_traces_from_center();
}

/**
 * Requests orthogonal contour.
 *
 * @param {any} spectrum - Spectrum
 * @param {any} sign - Sign
 * @param {any} type - Type
 */
function request_orthogonal_contour(spectrum, sign, type) {
    let spec_data = {
        levels: (sign === 0) ? spectrum.levels : spectrum.negative_levels,
        n_direct: spectrum.n_direct,
        n_indirect: spectrum.n_indirect,
        contour_sign: sign,
        spectrum_type: type, // Custom tag to identify response
        spectrum_index: 0,
        spectrum_origin: -1
    };

    my_contour_worker.postMessage({
        response_value: spectrum.raw_data,
        spectrum: spec_data
    });
}

/**
 * Shows cross section.
 */
function show_cross_section() { }
/**
 * Shows peak table.
 */
function show_peak_table() { }
/**
 * Removes peak table.
 */
function remove_peak_table() { }
/**
 * Draws spectrum.
 */
function draw_spectrum() { }

// -- 3D Visualization Integration --

var iso_renderer = null;

var current_volume_data = null; // Stores { data, dims, min, max, noise }

/**
 * Builds reconstructed volume data.
 *
 * @param {any} dims - Dims
 */
function build_reconstructed_volume_data(dims) {
    if (!theoretical_spectra_3d || theoretical_spectra_3d.length === 0) {
        return null;
    }

    const totalSize = dims.x * dims.y * dims.z;
    const recon = new Float32Array(totalSize);

    for (let z = 0; z < dims.z; z++) {
        const slice = theoretical_spectra_3d[z];
        if (!slice || !slice.raw_data) {
            continue;
        }
        const offset = z * dims.x * dims.y;
        const count = Math.min(slice.raw_data.length, dims.x * dims.y);
        recon.set(slice.raw_data.subarray(0, count), offset);
    }

    return recon;
}

/**
 * Toggles visibility of peak symbols in the 3 2D plots.
 */
function toggle_peak_symbols() {
    show_peak_symbols = !show_peak_symbols;

    let btn = document.getElementById("button_toggle_peak_symbols");
    if (btn) {
        btn.innerText = show_peak_symbols ? "Hide Peak Symbols" : "Show Peak Symbols";
    }

    // Redraw slice to update main plot peaks
    if (current_slice_index >= 0) {
        draw_slice(current_slice_index, false); // Do not center/pan ortho plots
    }

    // Redraw orthogonal views to update their peaks
    if (main_plot_xz) {
        refresh_xz_view();
    }
    if (main_plot_yz) {
        refresh_yz_view();
    }
}

/**
 * Toggles visualize 3D.
 *
 * @param {any} show - Show
 */
function toggle_visualize_3d(show) {
    let container = document.getElementById('container_3d_view');
    if (!container) return;
    if (show) {
        container.style.display = 'block';
        if (!current_volume_data) {
            extract_3d_data();
        } else {
            update_3d_view();
        }
    } else {
        container.style.display = 'none';
    }
}

/**
 * Toggles visualize projection.
 *
 * @param {any} show - Show
 */
function toggle_visualize_proj(show) {
    let c1 = document.getElementById('container_projection_view');
    let c2 = document.getElementById('container_projection_y_view');
    let c3 = document.getElementById('container_projection_x_view');
    if (show) {
        if (c1) c1.style.display = 'block';
        if (c2) c2.style.display = 'block';
        if (c3) c3.style.display = 'block';

        // Re-initialize plots if they were created while hidden (width=0)
        if (spectra_3d.length > 0) {
            let s = spectra_3d[0];
            if (!main_plot_proj || main_plot_proj.WIDTH === 0) init_proj_plot(s);
            if (!main_plot_proj_y || main_plot_proj_y.WIDTH === 0) init_proj_y_plot(s);
            if (!main_plot_proj_x || main_plot_proj_x.WIDTH === 0) init_proj_x_plot(s);
            update_all_plot_axis_labels();
        }

        if (!spectrum_proj) {
            generate_projection_spectrum();
        } else {
            refresh_proj_plot();
            refresh_proj_y_plot();
            refresh_proj_x_plot();
        }
    } else {
        if (c1) c1.style.display = 'none';
        if (c2) c2.style.display = 'none';
        if (c3) c3.style.display = 'none';
    }
}

/**
 * Visualizes 3D.
 */
function visualize_3d() {
    let cb = document.getElementById('check_visualize_3d');
    if (cb && cb.checked) {
        toggle_visualize_3d(true);
    } else if (!cb) {
        let container = document.getElementById('container_3d_view');
        if (container && container.style.display !== 'none') {
            extract_3d_data();
        }
    }
}

/**
 * Visualizes projection.
 */
function visualize_proj() {
    let cb = document.getElementById('check_visualize_proj');
    if (cb && cb.checked) {
        toggle_visualize_proj(true);
    } else if (!cb) {
        let c1 = document.getElementById('container_projection_view');
        let c2 = document.getElementById('container_projection_y_view');
        let c3 = document.getElementById('container_projection_x_view');
        if ((c1 && c1.style.display !== 'none') || (c2 && c2.style.display !== 'none') || (c3 && c3.style.display !== 'none')) {
            generate_projection_spectrum();
        }
    }
}

/**
 * Extracts 3D data.
 */
function extract_3d_data() {
    if (!spectra_3d || spectra_3d.length === 0) {
        console.warn("visualize_3d called but no spectra loaded.");
        return;
    }

    let s0 = spectra_3d[0];

    // Use FULL dataset ranges
    let ix_min = 0;
    let ix_max = s0.n_direct - 1;
    let iy_min = 0;
    let iy_max = s0.n_indirect - 1;
    let iz_min = 0;
    let iz_max = spectra_3d.length - 1;

    console.log("3D Viz Full Range:", ix_min, ix_max, iy_min, iy_max, iz_min, iz_max);

    // Check size
    const dx = ix_max - ix_min + 1;
    const dy = iy_max - iy_min + 1;
    const dz = iz_max - iz_min + 1;

    if (dx < 2 || dy < 2 || dz < 2) {
        console.error("Dataset is too small for 3D visualization.");
        return;
    }

    // Show Loading Indicator
    let loadingEl = document.getElementById('loading_3d');
    if (loadingEl) loadingEl.style.display = 'block';

    // Delay to allow UI to update
    setTimeout(() => {
        // Double check canvas visibility/size
        const canvas = document.getElementById("canvas_3d");
        if (canvas) {
            if (canvas.width === 0) canvas.width = canvas.parentElement.clientWidth;
            if (canvas.height === 0) canvas.height = canvas.parentElement.clientHeight;
        }

        // 2. Extract Real Data
        console.log(`Extracting 3D Region: ${dx}x${dy}x${dz} (Vol: ${dx * dy * dz})`);

        const size = dx * dy * dz;
        const volumeData = new Float32Array(size);

        let ptr = 0;
        // Loop Order: Z, Y, X
        for (let z = 0; z < dz; z++) {
            let slice_idx = iz_min + z;
            let s = spectra_3d[slice_idx];

            if (s && s.raw_data) {
                for (let y = 0; y < dy; y++) {
                    let gy = iy_min + y;
                    let row_offset = gy * s.n_direct;
                    for (let x = 0; x < dx; x++) {
                        let gx = ix_min + x;
                        if (gx >= 0 && gx < s.n_direct && gy >= 0 && gy < s.n_indirect) {
                            volumeData[ptr++] = s.raw_data[row_offset + gx];
                        } else {
                            volumeData[ptr++] = 0;
                        }
                    }
                }
            } else {
                for (let i = 0; i < dx * dy; i++) volumeData[ptr++] = 0;
            }
        }

        // Stats
        let minVal = Infinity, maxVal = -Infinity;
        for (let i = 0; i < volumeData.length; i++) {
            const v = volumeData[i];
            if (isFinite(v)) {
                if (v < minVal) minVal = v;
                if (v > maxVal) maxVal = v;
            }
        }

        const noise = s0.noise_level || (maxVal / 100);

        current_volume_data = {
            data: volumeData,
            dims: { x: dx, y: dy, z: dz },
            min: minVal,
            max: maxVal,
            noise: noise,
            recon_data: build_reconstructed_volume_data({ x: dx, y: dy, z: dz })
        };

        setup_sliders();
        update_3d_view();

    }, 50);
}

/**
 * Setups sliders.
 */
function setup_sliders() {
    if (!current_volume_data) return;

    const data = current_volume_data;
    const noise = data.noise;
    const maxVal = data.max;

    // Range: 3.0 * noise to 20.0 * noise
    // Expand range to accommodate literal values if needed
    const minRange = Math.min(1.0, 3.0 * noise);
    const maxRange = Math.max(100.0, 20.0 * noise);

    // Step size
    const step = (maxRange - minRange) / 200;

    const inputSolid = document.getElementById("iso_solid_level");
    const inputWire = document.getElementById("iso_wire_level");

    if (inputSolid && inputWire) {
        inputSolid.min = minRange;
        inputSolid.max = maxRange;
        inputSolid.step = step;
        inputSolid.value = (20.0 * noise).toExponential(4);

        inputWire.min = minRange;
        inputWire.max = maxRange;
        inputWire.step = step;
        inputWire.value = (10.0 * noise).toExponential(4);

        inputSolid.onchange = function () {
            let val = parseFloat(this.value);
            let wireVal = parseFloat(inputWire.value);
            if (val <= wireVal) {
                inputWire.value = (val - step).toFixed(1);
            }
            update_3d_view();
        };

        inputWire.onchange = function () {
            let val = parseFloat(this.value);
            let solidVal = parseFloat(inputSolid.value);
            if (val >= solidVal) {
                this.value = (solidVal - step).toFixed(1);
            }
            update_3d_view();
        }
    }

    const sliderPeak = document.getElementById("iso_peak_slider");
    const inputPeak = document.getElementById("iso_peak_input");

    if (sliderPeak && inputPeak) {
        sliderPeak.oninput = function () {
            inputPeak.value = this.value;
        };
        sliderPeak.onchange = function () {
            inputPeak.value = this.value;
            update_3d_view();
        };

        inputPeak.oninput = function () {
            sliderPeak.value = this.value;
        };
        inputPeak.onchange = function () {
            sliderPeak.value = this.value;
            update_3d_view();
        };
    }
}

/**
 * Updates 3D view.
 */
function update_3d_view() {
    if (!current_volume_data) return;

    let loadingEl = document.getElementById('loading_3d');
    if (loadingEl) loadingEl.style.display = 'block';

    // Allow UI update
    setTimeout(() => {
        const data = current_volume_data;

        const inputSolid = document.getElementById("iso_solid_level");
        const inputWire = document.getElementById("iso_wire_level");
        const sliderPeak = document.getElementById("iso_peak_slider");

        const isoSolid = parseFloat(inputSolid.value);
        const isoWire = parseFloat(inputWire.value);

        console.log(`Generating Meshes. Solid: ${isoSolid}, Wire: ${isoWire}`);

        let meshSolid, meshWire;
        let meshSolid_recon = null, meshWire_recon = null;

        try {
            meshSolid = MarchingCubes.compute(data.data, data.dims, isoSolid);
            meshWire = MarchingCubes.compute(data.data, data.dims, isoWire);

            // Reconstructed processing
            if (theoretical_spectra_3d && theoretical_spectra_3d.length > 0) {
                if (!data.recon_data || data.recon_data.length !== (data.dims.x * data.dims.y * data.dims.z)) {
                    data.recon_data = build_reconstructed_volume_data(data.dims);
                }
                if (data.recon_data) {
                    meshSolid_recon = MarchingCubes.compute(data.recon_data, data.dims, isoSolid);
                    meshWire_recon = MarchingCubes.compute(data.recon_data, data.dims, isoWire);
                }
            }
        } catch (err) {
            console.error(err);
            if (loadingEl) loadingEl.style.display = 'none';
            return;
        }

        // Center Meshes
        function centerMesh(mesh, d) {
            const cx = d.x / 2;
            const cy = d.y / 2;
            const cz = d.z / 2;
            const maxDim = Math.max(d.x, d.y, d.z);
            const scale = 2.0 / maxDim;

            for (let i = 0; i < mesh.vertices.length; i += 3) {
                mesh.vertices[i] = (mesh.vertices[i] - cx) * scale;
                mesh.vertices[i + 1] = (mesh.vertices[i + 1] - cy) * scale;
                mesh.vertices[i + 2] = (mesh.vertices[i + 2] - cz) * scale;
            }
        }
        centerMesh(meshSolid, data.dims);
        centerMesh(meshWire, data.dims);

        if (meshSolid_recon) centerMesh(meshSolid_recon, data.dims);
        if (meshWire_recon) centerMesh(meshWire_recon, data.dims);

        // Generate Axes
        const dx = data.dims.x;
        const dy = data.dims.y;
        const dz = data.dims.z;
        const maxDim = Math.max(dx, dy, dz);
        const cylinderRadius = maxDim * 0.01;

        let meshAxisX = createCylinder({ x: 0, y: 0, z: 0 }, { x: dx, y: 0, z: 0 }, cylinderRadius);
        let meshAxisY = createCylinder({ x: 0, y: 0, z: 0 }, { x: 0, y: dy, z: 0 }, cylinderRadius);
        let meshAxisZ = createCylinder({ x: 0, y: 0, z: 0 }, { x: 0, y: 0, z: dz }, cylinderRadius);

        centerMesh(meshAxisX, data.dims);
        centerMesh(meshAxisY, data.dims);
        centerMesh(meshAxisZ, data.dims);

        // Generate Peak Spheres
        let meshPeaks = { vertices: new Float32Array(0), normals: new Float32Array(0), color: [0.0, 1.0, 0.0, 1.0], mode: 'TRIANGLES' }; // Green opaque spheres
        if (typeof theoretical_peaks_data !== 'undefined' && theoretical_peaks_data.length > 0 && spectra_3d.length > 0) {
            let s0 = spectra_3d[0];
            let z_start = s0.z_ppm_start || 0;
            let z_step = s0.z_ppm_step || 1;

            const cx = dx / 2;
            const cy = dy / 2;
            const cz = dz / 2;
            const scale = 2.0 / maxDim;
            const peakSize = sliderPeak ? parseFloat(sliderPeak.value) : 0.03;

            let allVerts = [];
            let allNorms = [];

            // A single sphere template
            let templatePeak = createSphere(peakSize, 10, 10);

            let s0_z_start = s0.z_ppm_start !== undefined ? s0.z_ppm_start : 0;
            let s0_z_step = s0.z_ppm_step !== undefined ? s0.z_ppm_step : 1;

            for (let i = 0; i < theoretical_peaks_data.length; i++) {
                let p = theoretical_peaks_data[i];

                // If ppm values are provided, use them to calculate the exact index for mesh rendering
                // Otherwise fallback to subtracting 1 from the 1-based index
                let idx_x = p.x_ppm !== undefined ? (p.x_ppm - s0.x_ppm_start) / s0.x_ppm_step : p.x - 1;
                let idx_y = p.y_ppm !== undefined ? (p.y_ppm - s0.y_ppm_start) / s0.y_ppm_step : p.y - 1;
                let idx_z = p.z_ppm !== undefined ? (p.z_ppm - s0_z_start) / s0_z_step : p.z - 1;

                // Mesh space coords
                let meshX = (idx_x - cx) * scale;
                let meshY = (idx_y - cy) * scale;
                let meshZ = (idx_z - cz) * scale;

                if (i === 0) {
                    console.log(`Peak 0: DataCoord(${p.x.toFixed(2)},${p.y.toFixed(2)},${p.z.toFixed(2)}) -> Idx(${idx_x.toFixed(1)},${idx_y.toFixed(1)},${idx_z.toFixed(1)}) -> Mesh(${meshX.toFixed(2)},${meshY.toFixed(2)},${meshZ.toFixed(2)})`);
                }

                // Stamp template peak at this location
                for (let i = 0; i < templatePeak.vertices.length; i += 3) {
                    allVerts.push(templatePeak.vertices[i] + meshX);
                    allVerts.push(templatePeak.vertices[i + 1] + meshY);
                    allVerts.push(templatePeak.vertices[i + 2] + meshZ);
                    // Normals are the same for translations
                    allNorms.push(templatePeak.normals[i], templatePeak.normals[i + 1], templatePeak.normals[i + 2]);
                }
            }
            meshPeaks.vertices = new Float32Array(allVerts);
            meshPeaks.normals = new Float32Array(allNorms);
        }

        // Generate Partition Bounds Prism
        let meshBoundsCylinders = [];
        if (typeof partition_bounds_data !== 'undefined' && partition_bounds_data !== null) {
            let x0 = partition_bounds_data.x[0];
            let x1 = partition_bounds_data.x[1];
            let y0 = partition_bounds_data.y[0];
            let y1 = partition_bounds_data.y[1];
            let z0 = partition_bounds_data.z[0];
            let z1 = partition_bounds_data.z[1];

            // Edges of the box
            let edges = [
                // Bottom Z0
                [{ x: x0, y: y0, z: z0 }, { x: x1, y: y0, z: z0 }],
                [{ x: x1, y: y0, z: z0 }, { x: x1, y: y1, z: z0 }],
                [{ x: x1, y: y1, z: z0 }, { x: x0, y: y1, z: z0 }],
                [{ x: x0, y: y1, z: z0 }, { x: x0, y: y0, z: z0 }],
                // Top Z1
                [{ x: x0, y: y0, z: z1 }, { x: x1, y: y0, z: z1 }],
                [{ x: x1, y: y0, z: z1 }, { x: x1, y: y1, z: z1 }],
                [{ x: x1, y: y1, z: z1 }, { x: x0, y: y1, z: z1 }],
                [{ x: x0, y: y1, z: z1 }, { x: x0, y: y0, z: z1 }],
                // Vertical Z edges
                [{ x: x0, y: y0, z: z0 }, { x: x0, y: y0, z: z1 }],
                [{ x: x1, y: y0, z: z0 }, { x: x1, y: y0, z: z1 }],
                [{ x: x1, y: y1, z: z0 }, { x: x1, y: y1, z: z1 }],
                [{ x: x0, y: y1, z: z0 }, { x: x0, y: y1, z: z1 }]
            ];

            for (let edge of edges) {
                // Use a much thinner cylinder for the bounds (e.g., 20% of max cylinder radius)
                let m = createCylinder(edge[0], edge[1], cylinderRadius * 0.2);
                centerMesh(m, data.dims);
                meshBoundsCylinders.push(m);
            }
        }        // Render
        if (!iso_renderer) {
            iso_renderer = new IsoSurfaceRenderer("canvas_3d");
            iso_renderer.onCameraChange = function (cam) {
                if (iso_renderer_recon) iso_renderer_recon.setCameraState(cam);
            };
            iso_renderer.onPeakPicked = function (intersectionPoint) {
                handle3DPeakPicked(intersectionPoint, "Experimental");
            };
        }
        if (!iso_renderer_recon) {
            iso_renderer_recon = new IsoSurfaceRenderer("canvas_3d_recon");
            iso_renderer_recon.onCameraChange = function (cam) {
                if (iso_renderer) iso_renderer.setCameraState(cam);
            };
            iso_renderer_recon.onPeakPicked = function (intersectionPoint) {
                handle3DPeakPicked(intersectionPoint, "Reconstructed");
            };
        }

        if (iso_renderer && iso_renderer.gl) {
            let meshes = [];

            // Add peaks (Opaque green spheres) - Render Opaque first!
            if (meshPeaks && meshPeaks.vertices && meshPeaks.vertices.length > 0) {
                meshes.push(meshPeaks);
            }

            // Axes (Opaque) - Render Opaque first!
            meshes.push(
                { vertices: meshAxisX.vertices, normals: meshAxisX.normals, color: [1.0, 0.0, 0.0, 1.0], mode: 'TRIANGLES' },
                { vertices: meshAxisY.vertices, normals: meshAxisY.normals, color: [0.0, 1.0, 0.0, 1.0], mode: 'TRIANGLES' },
                { vertices: meshAxisZ.vertices, normals: meshAxisZ.normals, color: [0.0, 0.0, 1.0, 1.0], mode: 'TRIANGLES' }
            );

            // Add Bounds Prism (Opaque)
            if (meshBoundsCylinders.length > 0) {
                for (let m of meshBoundsCylinders) {
                    meshes.push({
                        vertices: m.vertices,
                        normals: m.normals,
                        color: [1.0, 0.0, 0.0, 1.0], // Red
                        mode: 'TRIANGLES'
                    });
                }
            }

            // Transparent Surfaces - Render Last!
            meshes.push(
                {
                    vertices: meshSolid.vertices,
                    normals: meshSolid.normals,
                    color: [1.0, 0.0, 0.0, 0.1], // Red Solid (50% transparent)
                    mode: 'TRIANGLES',
                    name: 'solid_red'
                },
                {
                    vertices: meshWire.vertices,
                    normals: meshWire.normals,
                    color: [0.0, 0.0, 1.0, 0.3], // Blue Wireframe (Requested)
                    mode: 'LINES'
                }
            );

            iso_renderer.updateGeometry(meshes);
            iso_renderer.render();
        }

        if (iso_renderer_recon && iso_renderer_recon.gl) {
            let meshes_recon = [];

            // Axes (Opaque)
            meshes_recon.push(
                { vertices: meshAxisX.vertices, normals: meshAxisX.normals, color: [1.0, 0.0, 0.0, 1.0], mode: 'TRIANGLES' },
                { vertices: meshAxisY.vertices, normals: meshAxisY.normals, color: [0.0, 1.0, 0.0, 1.0], mode: 'TRIANGLES' },
                { vertices: meshAxisZ.vertices, normals: meshAxisZ.normals, color: [0.0, 0.0, 1.0, 1.0], mode: 'TRIANGLES' }
            );

            // Add Bounds Prism (Opaque)
            if (meshBoundsCylinders.length > 0) {
                for (let m of meshBoundsCylinders) {
                    meshes_recon.push({
                        vertices: m.vertices,
                        normals: m.normals,
                        color: [1.0, 0.0, 0.0, 1.0],
                        mode: 'TRIANGLES'
                    });
                }
            }

            // Transparent Surfaces - Render Last!
            if (meshSolid_recon && meshWire_recon) {
                meshes_recon.push(
                    {
                        vertices: meshSolid_recon.vertices,
                        normals: meshSolid_recon.normals,
                        color: [1.0, 0.0, 0.0, 0.1], // Red Solid (50% transparent)
                        mode: 'TRIANGLES',
                        name: 'solid_red'
                    },
                    {
                        vertices: meshWire_recon.vertices,
                        normals: meshWire_recon.normals,
                        color: [0.0, 0.0, 1.0, 0.3], // Blue Wireframe (Requested)
                        mode: 'LINES'
                    }
                );
            }

            iso_renderer_recon.updateGeometry(meshes_recon);
            iso_renderer_recon.render();
        }

        if (loadingEl) loadingEl.style.display = 'none';

    }, 20);
}


/**
 * Resets 3D view.
 */
function reset_3d_view() {
    if (iso_renderer) {
        iso_renderer.resetView();
    }
    if (iso_renderer_recon) {
        iso_renderer_recon.resetView();
    }
}

/**
 * Handles mouse peak picking on the 3D surface.
 */
function handle3DPeakPicked(pt, type = "Experimental") {
    if (!current_volume_data || !spectra_3d || spectra_3d.length === 0) return;
    let s0 = spectra_3d[0];
    let d = current_volume_data.dims;

    let cx = d.x / 2;
    let cy = d.y / 2;
    let cz = d.z / 2;
    let maxDim = Math.max(d.x, d.y, d.z);
    let scale = 2.0 / maxDim;

    // Convert from mesh space back to grid index coordinates
    let x_grid = pt[0] / scale + cx;
    let y_grid = pt[1] / scale + cy;
    let z_grid = pt[2] / scale + cz;

    // Calculate PPM values
    let ppm_x = s0.x_ppm_start + x_grid * s0.x_ppm_step;
    let ppm_y = s0.y_ppm_start + y_grid * s0.y_ppm_step;
    let ppm_z = s0.z_ppm_start + z_grid * s0.z_ppm_step;

    // Update UI on index_3d.html
    let peakInfoContainer = document.getElementById("picked_peak_container");
    let peakInfoSpan = document.getElementById("picked_peak_info");
    if (peakInfoSpan) {
        peakInfoSpan.innerHTML = `
            [${type}] X: ${ppm_x.toFixed(3)} ppm (${x_grid.toFixed(1)}), 
            Y: ${ppm_y.toFixed(3)} ppm (${y_grid.toFixed(1)}), 
            Z: ${ppm_z.toFixed(3)} ppm (${z_grid.toFixed(1)})
        `;
        if (peakInfoContainer) {
            peakInfoContainer.style.display = "flex";
        }
    }

    // Update active slice indices (clamped)
    let new_z = Math.max(0, Math.min(spectra_3d.length - 1, Math.round(z_grid)));
    let new_y = Math.max(0, Math.min(s0.n_indirect - 1, Math.round(y_grid)));
    let new_x = Math.max(0, Math.min(s0.n_direct - 1, Math.round(x_grid)));

    current_slice_index = new_z;
    current_y_index = new_y;
    current_x_index = new_x;

    // 1. Update XY slice
    draw_slice(current_slice_index, false);

    // 2. Update XZ slice slider & label, then refresh
    let slider_xz = document.getElementById("slider_xz");
    let val_xz = document.getElementById("val_xz");
    if (slider_xz) {
        slider_xz.value = current_y_index;
    }
    if (val_xz) {
        let ppm_y_slice = s0.y_ppm_start + (current_y_index * s0.y_ppm_step);
        val_xz.innerText = (current_y_index + 1) + "/" + s0.n_indirect + " (" + ppm_y_slice.toFixed(3) + " ppm)";
    }
    refresh_xz_view();

    // 3. Update YZ slice slider & label, then refresh
    let slider_yz = document.getElementById("slider_yz");
    let val_yz = document.getElementById("val_yz");
    if (slider_yz) {
        slider_yz.value = current_x_index;
    }
    if (val_yz) {
        let ppm_x_slice = s0.x_ppm_start + (current_x_index * s0.x_ppm_step);
        val_yz.innerText = (current_x_index + 1) + "/" + s0.n_direct + " (" + ppm_x_slice.toFixed(3) + " ppm)";
    }
    refresh_yz_view();

    // 4. Pan all three 2D plots to center on the picked coordinate
    if (main_plot) {
        main_plot.pan_to_center_ppm('x', ppm_x);
        main_plot.pan_to_center_ppm('y', ppm_y);
    }
    if (main_plot_xz) {
        main_plot_xz.pan_to_center_ppm('x', ppm_x);
        main_plot_xz.pan_to_center_ppm('y', ppm_z);
    }
    if (main_plot_yz) {
        main_plot_yz.pan_to_center_ppm('x', ppm_z);
        main_plot_yz.pan_to_center_ppm('y', ppm_y);
    }

    // 5. Sync crosshairs across views
    update_3d_crosshairs();
}

/**
 * Downloads the current peak list as a .txt file.
 */
function download_fitted_peaks_list() {
    if (!fitted_peaks_text_data) {
        alert("No peak list available to download.");
        return;
    }

    let blob = new Blob([fitted_peaks_text_data], { type: "text/plain;charset=utf-8" });
    let a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = "peaks_list.txt";
    a.click();
}

/**
 * Centers 3D on crosshair.
 */
function center_3d_on_crosshair() {
    if (!iso_renderer || !current_volume_data) return;

    // Get Plots
    // Assumes global variables main_plot (XY) and main_plot_xz (XZ)
    if (!main_plot || !main_plot_xz) {
        alert("2D plots are not initialized.");
        return;
    }

    // Get View Center (PPM) from 2D Plots
    // XY Plot
    let x_domain = main_plot.xRange.domain();
    let y_domain = main_plot.yRange.domain();
    let x_ppm = (x_domain[0] + x_domain[1]) / 2.0;
    let y_ppm = (y_domain[0] + y_domain[1]) / 2.0;

    // XZ Plot (Z is Y-axis of XZ)
    let z_domain = main_plot_xz.yRange.domain();
    let z_ppm = (z_domain[0] + z_domain[1]) / 2.0;

    // Convert to Data Indices
    // Indices are 0-based.
    // x_ppm = start + index * step
    // index = (x_ppm - start) / step
    const data = current_volume_data;

    if (!spectra_3d || spectra_3d.length === 0) return;
    const s0 = spectra_3d[0]; // Reference spectrum for X/Y dims

    // X Index (Direct)
    let idx_x = (x_ppm - s0.x_ppm_start) / s0.x_ppm_step;
    // Y Index (Indirect)
    let idx_y = (y_ppm - s0.y_ppm_start) / s0.y_ppm_step;
    // Z Index
    let z_start = s0.z_ppm_start || 0;
    let z_step = s0.z_ppm_step || 1;
    let idx_z = (z_ppm - z_start) / z_step;

    // Convert to Mesh Coordinates
    // centerMesh logic:
    // cx = dx / 2, cy = dy / 2, cz = dz / 2
    // val = (val - cx) * scale

    const dx = data.dims.x;
    const dy = data.dims.y;
    const dz = data.dims.z;

    const cx = dx / 2;
    const cy = dy / 2;
    const cz = dz / 2;

    const maxDim = Math.max(dx, dy, dz);
    const scale = 2.0 / maxDim;

    let meshX = (idx_x - cx) * scale;
    let meshY = (idx_y - cy) * scale;
    let meshZ = (idx_z - cz) * scale;

    console.log(`Centering on View Center: PPM(${x_ppm.toFixed(2)}, ${y_ppm.toFixed(2)}, ${z_ppm.toFixed(2)}) -> Idx(${idx_x.toFixed(1)}, ${idx_y.toFixed(1)}, ${idx_z.toFixed(1)}) -> Mesh(${meshX.toFixed(2)}, ${meshY.toFixed(2)}, ${meshZ.toFixed(2)})`);

    if (iso_renderer) iso_renderer.centerView(meshX, meshY, meshZ);
    if (iso_renderer_recon) iso_renderer_recon.centerView(meshX, meshY, meshZ);
}

/**
 * Centers 3D on slices.
 */
function center_3d_on_slices() {
    if (!iso_renderer || !current_volume_data) return;

    // Use current slice indices directly
    let idx_x = current_x_index;
    let idx_y = current_y_index;
    let idx_z = current_slice_index;

    const data = current_volume_data;
    const dx = data.dims.x;
    const dy = data.dims.y;
    const dz = data.dims.z;

    const cx = dx / 2;
    const cy = dy / 2;
    const cz = dz / 2;

    const maxDim = Math.max(dx, dy, dz);
    const scale = 2.0 / maxDim;

    let meshX = (idx_x - cx) * scale;
    let meshY = (idx_y - cy) * scale;
    let meshZ = (idx_z - cz) * scale;

    console.log(`Centering on Slices: Idx(${idx_x}, ${idx_y}, ${idx_z}) -> Mesh(${meshX.toFixed(2)}, ${meshY.toFixed(2)}, ${meshZ.toFixed(2)})`);

    if (iso_renderer) iso_renderer.centerView(meshX, meshY, meshZ);
    if (iso_renderer_recon) iso_renderer_recon.centerView(meshX, meshY, meshZ);
}



/**
 * Create a simple cylinder mesh
 */
function createCylinder(start, end, radius) {
    let vertices = [];
    let normals = [];

    // Vector along cylinder axis
    let dx = end.x - start.x;
    let dy = end.y - start.y;
    let dz = end.z - start.z;
    let len = Math.sqrt(dx * dx + dy * dy + dz * dz);

    // Normalize axis
    if (len < 0.0001) return { vertices: new Float32Array(0), normals: new Float32Array(0) };

    // Basis vectors for circle (plane perpendicular to axis)
    // Arbitrary vector not parallel to axis
    let ax = Math.abs(dx), ay = Math.abs(dy), az = Math.abs(dz);
    let p = { x: 0, y: 0, z: 0 };
    if (ax <= ay && ax <= az) p.x = 1;
    else if (ay <= ax && ay <= az) p.y = 1;
    else p.z = 1;

    // u = cross(axis, p)
    let ux = dy * p.z - dz * p.y;
    let uy = dz * p.x - dx * p.z;
    let uz = dx * p.y - dy * p.x;
    // normalize u
    let ulen = Math.sqrt(ux * ux + uy * uy + uz * uz);
    ux /= ulen; uy /= ulen; uz /= ulen;

    // v = cross(axis, u)
    // axis is (dx, dy, dz) but not normalized? Cross product should use normalized axis for orthogonal consistency,
    // NO, we want orthogonal to axis vector.
    // Let's normalize axis first for basis calc
    let ndx = dx / len, ndy = dy / len, ndz = dz / len;
    let vx = ndy * uz - ndz * uy;
    let vy = ndz * ux - ndx * uz;
    let vz = ndx * uy - ndy * ux;

    // Generate segments
    let segments = 32; // smoothness
    for (let i = 0; i < segments; i++) {
        let theta = (i / segments) * 2 * Math.PI;
        let theta2 = ((i + 1) / segments) * 2 * Math.PI;

        let c1 = Math.cos(theta), s1 = Math.sin(theta);
        let c2 = Math.cos(theta2), s2 = Math.sin(theta2);

        // Points on circle at Start
        let p1x_s = start.x + radius * (c1 * ux + s1 * vx);
        let p1y_s = start.y + radius * (c1 * uy + s1 * vy);
        let p1z_s = start.z + radius * (c1 * uz + s1 * vz);

        let p2x_s = start.x + radius * (c2 * ux + s2 * vx);
        let p2y_s = start.y + radius * (c2 * uy + s2 * vy);
        let p2z_s = start.z + radius * (c2 * uz + s2 * vz);

        // Points on circle at End
        let p1x_e = end.x + radius * (c1 * ux + s1 * vx);
        let p1y_e = end.y + radius * (c1 * uy + s1 * vy);
        let p1z_e = end.z + radius * (c1 * uz + s1 * vz);

        let p2x_e = end.x + radius * (c2 * ux + s2 * vx);
        let p2y_e = end.y + radius * (c2 * uy + s2 * vy);
        let p2z_e = end.z + radius * (c2 * uz + s2 * vz);

        // Normals (radial outward)
        // Same for start/end
        let n1x = c1 * ux + s1 * vx;
        let n1y = c1 * uy + s1 * vy;
        let n1z = c1 * uz + s1 * vz;

        let n2x = c2 * ux + s2 * vx;
        let n2y = c2 * uy + s2 * vy;
        let n2z = c2 * uz + s2 * vz;

        // Quad 1: p1_s, p2_s, p1_e
        vertices.push(p1x_s, p1y_s, p1z_s); normals.push(n1x, n1y, n1z);
        vertices.push(p2x_s, p2y_s, p2z_s); normals.push(n2x, n2y, n2z);
        vertices.push(p1x_e, p1y_e, p1z_e); normals.push(n1x, n1y, n1z);

        // Quad 2: p2_s, p2_e, p1_e
        vertices.push(p2x_s, p2y_s, p2z_s); normals.push(n2x, n2y, n2z);
        vertices.push(p2x_e, p2y_e, p2z_e); normals.push(n2x, n2y, n2z);
        vertices.push(p1x_e, p1y_e, p1z_e); normals.push(n1x, n1y, n1z);
    }

    return {
        vertices: new Float32Array(vertices),
        normals: new Float32Array(normals)
    };
}

/**
 * Create a simple sphere mesh
 * @param {number} radius Radius of the sphere
 * @param {number} latBands Number of latitude bands
 * @param {number} longBands Number of longitude bands
 * @returns { vertices: Float32Array, normals: Float32Array }
 */
function createSphere(radius, latBands = 10, longBands = 10) {
    let vertices = [];
    let normals = [];

    for (let latNumber = 0; latNumber <= latBands; latNumber++) {
        let theta = latNumber * Math.PI / latBands;
        let sinTheta = Math.sin(theta);
        let cosTheta = Math.cos(theta);

        for (let longNumber = 0; longNumber <= longBands; longNumber++) {
            let phi = longNumber * 2 * Math.PI / longBands;
            let sinPhi = Math.sin(phi);
            let cosPhi = Math.cos(phi);

            let x = cosPhi * sinTheta;
            let y = cosTheta;
            let z = sinPhi * sinTheta;

            normals.push(x, y, z);
            vertices.push(radius * x, radius * y, radius * z);
        }
    }

    let indexData = [];
    for (let latNumber = 0; latNumber < latBands; latNumber++) {
        for (let longNumber = 0; longNumber < longBands; longNumber++) {
            let first = (latNumber * (longBands + 1)) + longNumber;
            let second = first + longBands + 1;

            // Reverse winding order to CCW (first, first+1, second) instead of (first, second, first+1)
            indexData.push(first, first + 1, second);
            indexData.push(second, first + 1, second + 1);
        }
    }

    // Convert from indexed to flat unindexed for WebGL renderer which expects TRIANGLES mode
    let flatVertices = [];
    let flatNormals = [];

    for (let i = 0; i < indexData.length; i++) {
        let idx = indexData[i];
        flatVertices.push(
            vertices[idx * 3],
            vertices[idx * 3 + 1],
            vertices[idx * 3 + 2]
        );
        flatNormals.push(
            normals[idx * 3],
            normals[idx * 3 + 1],
            normals[idx * 3 + 2]
        );
    }

    return {
        vertices: new Float32Array(flatVertices),
        normals: new Float32Array(flatNormals)
    };
}

/**
 * Create a simple pyramid mesh (4 sides + square base = 6 triangles)
 * @param {number} size Size of the pyramid
 * @returns { vertices: Float32Array, normals: Float32Array }
 */
function createPyramid(size) {
    let s = size / 2;
    let vertices = [
        // Front face (CCW)
        s, -s, s,
        -s, -s, s,
        0, s, 0,
        // Right face
        s, -s, -s,
        s, -s, s,
        0, s, 0,
        // Back face
        -s, -s, -s,
        s, -s, -s,
        0, s, 0,
        // Left face
        -s, -s, s,
        -s, -s, -s,
        0, s, 0,
        // Base Triangle 1
        -s, -s, -s,
        -s, -s, s,
        s, -s, s,
        // Base Triangle 2
        -s, -s, -s,
        s, -s, s,
        s, -s, -s
    ];

    let normals = [];
    for (let i = 0; i < vertices.length; i += 9) {
        let ax = vertices[i + 3] - vertices[i];
        let ay = vertices[i + 4] - vertices[i + 1];
        let az = vertices[i + 5] - vertices[i + 2];

        let bx = vertices[i + 6] - vertices[i];
        let by = vertices[i + 7] - vertices[i + 1];
        let bz = vertices[i + 8] - vertices[i + 2];

        // Normal = A x B
        let nx = ay * bz - az * by;
        let ny = az * bx - ax * bz;
        let nz = ax * by - ay * bx;

        let len = Math.sqrt(nx * nx + ny * ny + nz * nz);
        if (len === 0) len = 1;
        nx /= len; ny /= len; nz /= len;

        normals.push(nx, ny, nz);
        normals.push(nx, ny, nz);
        normals.push(nx, ny, nz);
    }

    return {
        vertices: new Float32Array(vertices),
        normals: new Float32Array(normals)
    };
}

// Appended 3D Processing logic

var web_worker_3d = null;
var web_worker_smile_3d = null;
var fid_drop_process_3d = null;
var pending_nus_cfg_3d = null;
// Debug-only mode flag kept for future use.
var debug2_smile_only_3d = false;

/**
 * Downloads binary file.
 *
 * @param {any} dataBytes - Data bytes
 * @param {any} filename - Filename
 */
function download_binary_file(dataBytes, filename) {
    const bytes = dataBytes instanceof Uint8Array ? dataBytes : new Uint8Array(dataBytes);
    const blob = new Blob([bytes], { type: 'application/octet-stream' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(url);
}

document.addEventListener('DOMContentLoaded', function () {
    if (window.Worker) {
        web_worker_3d = new Worker('./js/webass_3d.js');
        web_worker_3d.onmessage = handle_webass_3d_message;
        web_worker_3d.onerror = function (err) {
            console.error('[3D][worker] error', err);
            append_3d_log('[worker-error] ' + (err && err.message ? err.message : String(err)));
            set_loading_buttons_state(false);
        };

        web_worker_smile_3d = new Worker('./js/webass_smile.js');
        web_worker_smile_3d.onmessage = handle_webass_smile_3d_message;
        web_worker_smile_3d.onerror = function (err) {
            console.error('[3D][smile-worker] error', err);
            append_3d_log('[smile-worker-error] ' + (err && err.message ? err.message : String(err)));
            document.getElementById("webassembly_message").innerText = 'SMILE worker error: ' + (err && err.message ? err.message : String(err));
            set_loading_buttons_state(false);
        };
    }

    const clearLogBtn = document.getElementById('button_clear_log_3d');
    if (clearLogBtn) {
        clearLogBtn.addEventListener('click', function () {
            clear_3d_log();
        });
    }

    if (typeof file_drop_processor !== 'undefined') {
        fid_drop_process_3d = new file_drop_processor()
            .drop_area('input_files')
            .files_name(["acqu2s", "acqu3s", "acqus", "ser", "fid", "nuslist"])
            .files_id(["acquisition_file2", "acquisition_file3", "acquisition_file", "fid_file", "fid_file", "nuslist_file"])
            .file_extension([])
            .required_files([0, 2, 3])
            .click_to_select_folder()
            .init();
    }

    const fid_area = document.getElementById("fid_file_area");
    if (fid_area) {
        fid_area.addEventListener("dragenter", (e) => {
            e.preventDefault();
            const btn = document.getElementById("button_minimize_fid_area");
            if (btn && btn.innerText === "+") {
                minimize_fid_area(btn);
            }
        });
        fid_area.addEventListener("dragover", (e) => {
            e.preventDefault();
        });
    }

    let fid3dForm = document.getElementById('fid_file_form');
    if (fid3dForm) {
        fid3dForm.addEventListener('submit', function (e) {
            e.preventDefault();
            load_fid_3d_file();
        });
    }
});

function minimize_fid_area(self) {
    let button_text = self.innerText;
    if (button_text === "-") {
        self.innerText = "+";
        document.getElementById("fid_file_area").style.height = "3rem";
        document.getElementById("fid_file_area").style.padding = "5px 10px";
        document.getElementById("fid_file_area").style.overflow = "clip";
    }
    else {
        self.innerText = "-";
        document.getElementById("fid_file_area").style.height = "auto";
        document.getElementById("fid_file_area").style.padding = "10px";
        document.getElementById("fid_file_area").style.overflow = "visible";
    }
}

const read_file_as_array_buffer = (file) => {
    return new Promise((resolve, reject) => {
        var reader = new FileReader();
        reader.onload = function () {
            resolve(reader.result);
        };
        reader.onerror = function (e) {
            reject("Error reading file");
        };
        reader.readAsArrayBuffer(file);
    });
};

/**
 * Builds 3D worker configuration from UI.
 */
function build_3d_worker_cfg_from_ui() {
    const parseTdPolynomialOrder = function () {
        const raw = document.getElementById('td_polynomial_order_3d').value || '';
        const parts = raw.trim().split(/[\s,]+/).filter(Boolean).map(function (v) {
            const n = parseInt(v, 10);
            return Number.isFinite(n) ? n : NaN;
        });
        if (parts.length >= 3 && Number.isFinite(parts[0]) && Number.isFinite(parts[1]) && Number.isFinite(parts[2])) {
            return [parts[0], parts[1], parts[2]];
        }
        return [4, -1, -1];
    };

    const parseFrqPolynomialOrder = function () {
        const raw = document.getElementById('frq_polynomial_order_3d').value || '';
        const parts = raw.trim().split(/[\s,]+/).filter(Boolean).map(function (v) {
            const n = parseInt(v, 10);
            return Number.isFinite(n) ? n : NaN;
        });
        if (parts.length >= 3 && Number.isFinite(parts[0]) && Number.isFinite(parts[1]) && Number.isFinite(parts[2])) {
            return [parts[0], parts[1], parts[2]];
        }
        return [-1, -1, -1];
    };

    return {
        zfDirect: parseInt(document.getElementById('zf_direct').value) || 1,
        zfIndirect1: parseInt(document.getElementById('zf_indirect1').value) || 1,
        zfIndirect2: parseInt(document.getElementById('zf_indirect2').value) || 1,
        apodDirect: document.getElementById('apodization_direct').value,
        apodIndirect1: document.getElementById('apodization_indirect1').value,
        apodIndirect2: document.getElementById('apodization_indirect2').value,
        phaseText: (function () {
            const auto = document.getElementById('normal_direct_dim_auto_phase_3d');
            const p0 = (auto && auto.checked) ? "0.0" : document.getElementById('phase_correction_direct_p0').value;
            const p1 = (auto && auto.checked) ? "0.0" : document.getElementById('phase_correction_direct_p1').value;
            return p0 + " " + p1 + " " +
                document.getElementById('phase_correction_indirect1_p0').value + " " +
                document.getElementById('phase_correction_indirect1_p1').value + " " +
                document.getElementById('phase_correction_indirect2_p0').value + " " +
                document.getElementById('phase_correction_indirect2_p1').value;
        })(),
        tdPolyOrder: parseTdPolynomialOrder(),
        frqPolyOrder: parseFrqPolynomialOrder(),
        inverse: [0, 0, 0],
        deleteImage: [
            (document.getElementById('keep_direct_imag_data_3d') && document.getElementById('keep_direct_imag_data_3d').checked) ? 0 : 1,
            1,
            1
        ],
        nusSerInflated: false,
        normalDirectDimAutoPhase: !!(document.getElementById('normal_direct_dim_auto_phase_3d') && document.getElementById('normal_direct_dim_auto_phase_3d').checked),
        extPpm: [
            parseFloat(document.getElementById('extract_direct_from').value),
            parseFloat(document.getElementById('extract_direct_to').value)
        ]
    };
}

/**
 * Parses indirect phase from configuration.
 *
 * @param {any} cfg - Configuration
 */
function parse_indirect_phase_from_cfg(cfg) {
    const parts = String((cfg && cfg.phaseText) || '').trim().split(/\s+/).map(function (v) {
        const n = parseFloat(v);
        return Number.isFinite(n) ? n : 0.0;
    });
    return {
        i1p0: parts.length > 2 ? parts[2] : 0.0,
        i1p1: parts.length > 3 ? parts[3] : 0.0,
        i2p0: parts.length > 4 ? parts[4] : 0.0,
        i2p1: parts.length > 5 ? parts[5] : 0.0
    };
}

/**
 * Parses apod string to smile axis args.
 *
 * @param {any} apodText - Apod text
 * @param {any} axisPrefix - Axis prefix
 */
function parse_apod_string_to_smile_axis_args(apodText, axisPrefix) {
    const tokens = String(apodText || '').trim().split(/\s+/).filter(Boolean);
    const fallback = {
        apod: 'SP',
        q1: '0.50',
        q2: '0.896',
        q3: '3.684',
        elb: '0.0',
        glb: '0.0'
    };

    if (tokens.length === 0 || tokens[0].toLowerCase() === 'none') {
        return '-' + axisPrefix + 'Apod ' + fallback.apod +
            ' -' + axisPrefix + 'Q1 ' + fallback.q1 +
            ' -' + axisPrefix + 'Q2 ' + fallback.q2 +
            ' -' + axisPrefix + 'Q3 ' + fallback.q3 +
            ' -' + axisPrefix + 'ELB ' + fallback.elb +
            ' -' + axisPrefix + 'GLB ' + fallback.glb;
    }

    const apodType = (tokens[0] || fallback.apod).toUpperCase();
    let q1 = fallback.q1;
    let q2 = fallback.q2;
    let q3 = fallback.q3;
    let elb = fallback.elb;
    let glb = fallback.glb;

    for (let i = 1; i < tokens.length - 1; i++) {
        const key = tokens[i].toLowerCase();
        const val = tokens[i + 1];
        if (key === 'off' || key === 'begin' || key === 'q1') {
            q1 = val;
        } else if (key === 'end' || key === 'q2') {
            q2 = val;
        } else if (key === 'pow' || key === 'q3') {
            q3 = val;
        } else if (key === 'elb') {
            elb = val;
        } else if (key === 'glb') {
            glb = val;
        }
    }

    return '-' + axisPrefix + 'Apod ' + apodType +
        ' -' + axisPrefix + 'Q1 ' + q1 +
        ' -' + axisPrefix + 'Q2 ' + q2 +
        ' -' + axisPrefix + 'Q3 ' + q3 +
        ' -' + axisPrefix + 'ELB ' + elb +
        ' -' + axisPrefix + 'GLB ' + glb;
}

/**
 * Reads FT3 FN modes from header.
 *
 * @param {any} ft3Bytes - FT3 bytes
 */
function read_ft3_fnmodes_from_header(ft3Bytes) {
    try {
        const bytes = ft3Bytes instanceof Uint8Array ? ft3Bytes : new Uint8Array(ft3Bytes || []);
        if (bytes.byteLength < 2048) {
            return { indirect1Fnmode: null, indirect2Fnmode: null };
        }
        const dv = new DataView(bytes.buffer, bytes.byteOffset, 2048);
        const f1 = Math.round(dv.getFloat32(70 * 4, true));
        const f2 = Math.round(dv.getFloat32(71 * 4, true));
        return { indirect1Fnmode: f1, indirect2Fnmode: f2 };
    } catch (e) {
        return { indirect1Fnmode: null, indirect2Fnmode: null };
    }
}

/**
 * Builds NUS 3D smile command.
 *
 * @param {any} cfg - Configuration
 * @param {any} options - Options
 */
function build_nus_3d_smile_command(cfg, options) {
    const opt = options || {};
    const xT = Number.isFinite(opt.ndataIndirect1) ? opt.ndataIndirect1 : 100;
    const yT = Number.isFinite(opt.ndataIndirect2) ? opt.ndataIndirect2 : 90;
    const fn = read_ft3_fnmodes_from_header(opt.ft3Bytes);
    const phases = parse_indirect_phase_from_cfg(cfg || {});
    const xApodArgs = parse_apod_string_to_smile_axis_args((cfg && cfg.apodIndirect1) || 'none', 'x');
    const yApodArgs = parse_apod_string_to_smile_axis_args((cfg && cfg.apodIndirect2) || 'none', 'y');
    const altParts = [];

    if (fn.indirect1Fnmode === 5) {
        altParts.push('-xAlt');
    }
    if (fn.indirect2Fnmode === 5) {
        altParts.push('-yAlt');
    }

    return [
        '-in half.ft3 -fn SMILE -nDim 3 -sample nuslist -report 2 -nThread 1 -maxMem 2.0',
        xApodArgs,
        yApodArgs,
        '-xT ' + xT,
        '-xP0 ' + phases.i1p0,
        '-xP1 ' + phases.i1p1,
        '-yT ' + yT,
        '-yP0 ' + phases.i2p0,
        '-yP1 ' + phases.i2p1,
        altParts.join(' '),
        '-out smile.ft3 -ov'
    ].filter(Boolean).join(' ');
}

/**
 * Loads FID 3D file.
 * @returns {Promise<void>}
 */
async function load_fid_3d_file() {
    // Debug UI is removed; keep debug code path commented for future use.
    // const debug2Only = !!(document.getElementById('debug_load_intermediate_webass2_3d') && document.getElementById('debug_load_intermediate_webass2_3d').checked);
    // const debugStep3Direct = !!(document.getElementById('debug_run_step3_direct_3d') && document.getElementById('debug_run_step3_direct_3d').checked);
    const debug2Only = false;
    const debugStep3Direct = false;
    let acquisition_file = document.getElementById('acquisition_file').files[0];
    let acquisition_file2 = document.getElementById('acquisition_file2').files[0];
    let acquisition_file3 = document.getElementById('acquisition_file3').files[0];
    let fid_file = document.getElementById('fid_file').files[0];
    let nuslist_file = document.getElementById('nuslist_file').files[0];
    // let debug_intermediate_file = document.getElementById('debug_intermediate_file_3d').files[0];
    // let debug_smile_processed_file = document.getElementById('debug_smile_processed_file_3d').files[0];

    // if (debug2Only && debugStep3Direct) {
    //     alert('Please enable only one debug mode at a time (Debug 2 or Debug 3).');
    //     return;
    // }

    // if (debug2Only) {
    //     if (!debug_intermediate_file) {
    //         alert('Debug 2 is enabled. Please provide an intermediate .ft3 file.');
    //         return;
    //     }
    //     if (!nuslist_file) {
    //         alert('Debug 2 is enabled. Please provide nuslist file.');
    //         return;
    //     }
    //     try {
    //         document.getElementById("webassembly_message").innerText = "Debug 2: reading intermediate file and running SMILE...";
    //         const debugBuffers = await Promise.all([
    //             read_file_as_array_buffer(debug_intermediate_file),
    //             read_file_as_array_buffer(nuslist_file)
    //         ]);
    //         const intermediateBytes = new Uint8Array(debugBuffers[0]);
    //         const nuslistText = new TextDecoder().decode(debugBuffers[1]);
    //         const cfg = build_3d_worker_cfg_from_ui();
    //         const smileCommand = build_nus_3d_smile_command(cfg, { ft3Bytes: intermediateBytes });

    //         append_3d_log('[main][debug2] Sending uploaded intermediate .ft3 to SMILE worker, bytes=' + intermediateBytes.length);
    //         append_3d_log('[main][debug2] SMILE command: ' + smileCommand);
    //         debug2_smile_only_3d = true;
    //         web_worker_smile_3d.postMessage({
    //             smile_mode: 'nus_3d',
    //             spectrum_data: intermediateBytes,
    //             nuslist_as_string: nuslistText,
    //             smile_command: smileCommand
    //         }, [intermediateBytes.buffer]);
    //     } catch (err) {
    //         debug2_smile_only_3d = false;
    //         append_3d_log('[main-error][debug2] ' + (err && err.toString ? err.toString() : String(err)));
    //         document.getElementById("webassembly_message").innerText = 'Debug 2 failed: ' + err.toString();
    //     }
    //     return;
    // }

    // if (debugStep3Direct) {
    //     if (!debug_smile_processed_file) {
    //         alert('Debug 3 is enabled. Please provide a smile-processed .ft3 file.');
    //         return;
    //     }

    //     try {
    //         document.getElementById("webassembly_message").innerText = 'Debug 3: reading smile-processed spectrum...';
    //         const smileBuffer = await read_file_as_array_buffer(debug_smile_processed_file);
    //         const smileBytes = new Uint8Array(smileBuffer);
    //         const cfg = build_3d_worker_cfg_from_ui();

    //         append_3d_log('[main][debug3] Running step3 directly from uploaded smile .ft3, bytes=' + smileBytes.length);
    //         document.getElementById("webassembly_message").innerText = 'Debug 3: running indirect-only processing from uploaded smile.ft3...';
    //         web_worker_3d.postMessage({
    //             "#sym:webassembly_job ": 'process_fid_3d_nus_step3',
    //             cfg: cfg,
    //             smileFt3Bytes: smileBytes
    //         }, [smileBytes.buffer]);
    //     } catch (err) {
    //         append_3d_log('[main-error][debug3] ' + (err && err.toString ? err.toString() : String(err)));
    //         document.getElementById("webassembly_message").innerText = 'Debug 3 failed: ' + err.toString();
    //     }
    //     return;
    // }

    if (!fid_file || !acquisition_file || !acquisition_file2 || !acquisition_file3) {
        alert('Please provide fid/ser, acqus, acqu2s, and acqu3s files.');
        return;
    }

    set_loading_buttons_state(true);
    console.log('[3D][fid] Starting 3D FID processing request');
    append_3d_log('[main] Starting 3D FID processing request');

    // Reset spectral metadata and UI phase for the new experiment
    window.last_fid_full_ppm_range = null;
    window.last_fid_extract_ppm_range = null;
    window.last_fid_nuclei = { x: '', y: '', z: '' };
    update_all_plot_axis_labels();

    // Reset UI phase boxes ONLY if auto-phase is checked. 
    // If not checked, we keep the user's manual input for the FID processing.
    const autoPhaseChecked = !!(document.getElementById('normal_direct_dim_auto_phase_3d') && document.getElementById('normal_direct_dim_auto_phase_3d').checked);
    if (autoPhaseChecked) {
        const box0 = document.getElementById('phase_correction_direct_p0');
        const box1 = document.getElementById('phase_correction_direct_p1');
        if (box0) box0.value = "0.00";
        if (box1) box1.value = "0.00";
    }

    append_3d_log('[main] Files: fid=' + fid_file.name + ', acqus=' + acquisition_file.name + ', acqu2s=' + acquisition_file2.name + ', acqu3s=' + acquisition_file3.name + ', nuslist=' + (nuslist_file ? nuslist_file.name : 'none'));

    document.getElementById("webassembly_message").innerText = "Reading files...";

    let promises = [
        read_file_as_array_buffer(fid_file),
        read_file_as_array_buffer(acquisition_file),
        read_file_as_array_buffer(acquisition_file2),
        read_file_as_array_buffer(acquisition_file3),
        nuslist_file ? read_file_as_array_buffer(nuslist_file) : Promise.resolve(null)
    ];

    try {
        console.log('[3D][fid] Reading input files');
        let buffers = await Promise.all(promises);
        const fidBytes = buffers[0];
        append_3d_log('[main] Input buffers loaded. fidBytes=' + (fidBytes ? fidBytes.byteLength : 0) + ' bytes');
        const cfg = build_3d_worker_cfg_from_ui();
        current_fid_config = cfg;

        console.log('[3D][fid] cfg prepared', cfg);
        append_3d_log('[main] cfg: zf=(' + cfg.zfDirect + ',' + cfg.zfIndirect1 + ',' + cfg.zfIndirect2 + ')');

        const textInputs = {
            pulse: "",
            acqus: buffers[1] ? new TextDecoder().decode(buffers[1]) : "",
            acqu2s: buffers[2] ? new TextDecoder().decode(buffers[2]) : "",
            acqu3s: buffers[3] ? new TextDecoder().decode(buffers[3]) : "",
            nuslist: buffers[4] ? new TextDecoder().decode(buffers[4]) : ""
        };
        append_3d_log('[main] textInputs length: acqus=' + textInputs.acqus.length + ', acqu2s=' + textInputs.acqu2s.length + ', acqu3s=' + textInputs.acqu3s.length + ', nuslist=' + textInputs.nuslist.length);

        const isNus = !!(textInputs.nuslist && textInputs.nuslist.trim().length > 0);
        cfg.isNus = isNus;

        // Consolidate auto-phase logic
        const autoPhaseChecked = !!cfg.normalDirectDimAutoPhase;
        const nusDirectDimAutoPhase = isNus && autoPhaseChecked;

        const showArtifactChecked = !!(document.getElementById('show_spectrum_artifact_3d') && document.getElementById('show_spectrum_artifact_3d').checked);
        cfg.showArtifact = showArtifactChecked;

        // Per requirement: If auto-phasing NUS, we MUST run the full process route (skip SMILE) 
        // to get a spectrum the model can phase correctly.
        if (isNus && autoPhaseChecked) {
            cfg.debugNusRunFullProcess = true;
            cfg.nusDirectDimAutoPhase = true;
            cfg.userFrqPolyOrder = [...cfg.frqPolyOrder];
            cfg.frqPolyOrder = [-1, -1, -1];
            append_3d_log('[main] NUS AutoPhase: setting frqPolyOrder to -1 -1 -1 for first-pass, caching user frqPolyOrder: ' + cfg.userFrqPolyOrder);
        } else if (!isNus && autoPhaseChecked) {
            // For non-NUS automatic phase correction, bypass baseline correction on the first pass
            cfg.userFrqPolyOrder = [...cfg.frqPolyOrder];
            cfg.frqPolyOrder = [-1, -1, -1];
            append_3d_log('[main] Non-NUS AutoPhase: setting frqPolyOrder to -1 -1 -1 for first-pass, caching user frqPolyOrder: ' + cfg.userFrqPolyOrder);
        }

        console.log('[3D][fid] Sending worker message. NUS mode=', isNus, 'AutoPhase=', nusDirectDimAutoPhase);
        append_3d_log(`[main] Posting process_fid_3d to worker (NUS=${isNus}, AutoPhase=${nusDirectDimAutoPhase}, FullProcess=${!!cfg.debugNusRunFullProcess})`);

        document.getElementById("webassembly_message").innerText = isNus
            ? (cfg.debugNusRunFullProcess
                ? "Processing 3D NUS: Full reconstruction (required for auto-phase)..."
                : "Processing 3D NUS: direct-only -> SMILE -> indirect-only...")
            : "Processing 3D FID using WebAssembly...";

        web_worker_3d.postMessage({
            "#sym:webassembly_job ": "process_fid_3d",
            cfg: cfg,
            textInputs: textInputs,
            fidBytes: fidBytes
        }, [fidBytes]);
    } catch (err) {
        console.error('[3D][fid] Error while reading/posting input', err);
        append_3d_log('[main-error] ' + (err && err.toString ? err.toString() : String(err)));
        document.getElementById("webassembly_message").innerText = "Error reading files: " + err.toString();
        set_loading_buttons_state(false);
    }
}

/**
 * Handles webass 3D message.
 *
 * @param {any} e - E
 * @returns {Promise<void>}
 */
async function handle_webass_3d_message(e) {
    console.log('[3D][worker->main] message keys:', Object.keys(e.data || {}));
    if (e.data.error) {
        append_3d_log('[worker-error] ' + e.data.error);
        document.getElementById("webassembly_message").innerText = "Error: " + e.data.error;
        set_loading_buttons_state(false);
        return;
    }
    if (Object.prototype.hasOwnProperty.call(e.data, 'stdout')) {
        append_3d_worker_stdout(e.data.stdout);
        return;
    }
    if (e.data["#sym:webassembly_job "] === 'process_fid_3d_nus_half_ready') {
        let halfBytes = e.data.halfFt3Bytes instanceof Uint8Array
            ? e.data.halfFt3Bytes
            : new Uint8Array(e.data.halfFt3Bytes);
        pending_nus_cfg_3d = e.data.cfg || null;

        append_3d_log('[main] Received half.ft3 from direct-only step, bytes=' + halfBytes.length);

        const smileCommand = build_nus_3d_smile_command(pending_nus_cfg_3d || {}, {
            ft3Bytes: halfBytes,
            ndataIndirect1: Number(e.data.ndataIndirect1),
            ndataIndirect2: Number(e.data.ndataIndirect2)
        });

        // If NUS auto-phase is enabled, bypass SMILE and go straight to step 3 (indirect processing)
        if (current_fid_config && current_fid_config.nusDirectDimAutoPhase) {
            append_3d_log("[tfjs] NUS Auto-phase enabled: Bypassing SMILE for fast phase verification...");
            append_3d_log("[tfjs] Running indirect-only processing on NUS data (treating as fully sampled)...");
            document.getElementById("webassembly_message").innerText = 'Bypassing SMILE: Running indirect processing...';
            web_worker_3d.postMessage({
                "#sym:webassembly_job ": 'process_fid_3d_nus_step3',
                cfg: pending_nus_cfg_3d,
                smileFt3Bytes: halfBytes
            }, [halfBytes.buffer]);
            halfBytes = null;
            e.data.halfFt3Bytes = null;
            return;
        }

        append_3d_log('[main] Sending half.ft3 to SMILE worker');
        append_3d_log('[main] SMILE command: ' + smileCommand);
        document.getElementById("webassembly_message").innerText = 'Running SMILE on half.ft3...';
        web_worker_smile_3d.postMessage({
            smile_mode: 'nus_3d',
            spectrum_data: halfBytes,
            nuslist_as_string: e.data.nuslistText || '',
            smile_command: smileCommand
        }, [halfBytes.buffer]);
        halfBytes = null;
        e.data.halfFt3Bytes = null;
        return;
    }
    if (e.data["#sym:webassembly_job "] === 'pick_and_fit_3d') {
        append_3d_log('[main] Received pick_and_fit_3d result');
        document.getElementById("webassembly_message").innerText = "Peak picking & fitting complete.";
        setTimeout(() => {
            if (document.getElementById("webassembly_message").innerText === "Peak picking & fitting complete.") {
                document.getElementById("webassembly_message").innerText = "";
            }
        }, 5000);
        set_loading_buttons_state(false);

        if (e.data.success && e.data.resultString) {
            let resultString = e.data.resultString;
            fitted_peaks_text_data = resultString;
            let dl_btn = document.getElementById("button_download_peaks_list");
            if (dl_btn) dl_btn.disabled = false;
            let toggle_btn = document.getElementById("button_toggle_peak_symbols");
            if (toggle_btn) toggle_btn.disabled = false;
            console.log("Fitted Peaks Output:\n", resultString);

            try {
                let peaks = parse_peaks_text(resultString);
                if (peaks.length === 0) {
                    alert("No valid peaks found in peak pick & fit output.");
                    return;
                }

                console.log("Loaded " + peaks.length + " fitted peaks.");
                theoretical_peaks_data = peaks;

                let has_any_shape = peaks.some(p => p.has_shape);
                if (has_any_shape) {
                    console.log("Shape parameters found. Generating theoretical volume.");
                    generate_theoretical_volume(peaks);
                    generate_projection_spectrum();
                } else {
                    console.log("No shape parameters found. Showing peak symbols only.");
                    theoretical_spectra_3d = [];
                    theoretical_spectrum_xz = null;
                    theoretical_spectrum_yz = null;
                    theoretical_spectrum_proj = null;
                    theoretical_spectrum_proj_y = null;
                    theoretical_spectrum_proj_x = null;
                }

                // Refresh views to show overlay
                if (current_slice_index >= 0) {
                    draw_slice(current_slice_index);
                    refresh_xz_view();
                    refresh_yz_view();
                    update_3d_crosshairs();
                }

                // Refresh the 3D viewer to show the new peak spheres
                update_3d_view();

                append_3d_log(`[main] Successfully merged ${peaks.length} fitted peaks to 3D visualization workflow.`);
            } catch (err) {
                console.error("Error processing fitted peaks:", err);
                append_3d_log("[main-error] Failed to process fitted peaks: " + err.message);
                alert("Failed to process fitted peaks: " + err.message);
            }
        } else {
            alert("Peak picking & fitting failed: " + (e.data.error || "Unknown error"));
        }
        return;
    }
    if (e.data["#sym:webassembly_job "] === "process_fid_3d" || e.data["#sym:webassembly_job "] === "postprocess_ft3") {
        const jobType = e.data["#sym:webassembly_job "];
        append_3d_log('[main] Received ' + jobType + ' result');
        document.getElementById("webassembly_message").innerText = jobType === "postprocess_ft3"
            ? "3D post-processing complete. Rendering planes..."
            : "3D processing complete. Rendering planes...";
        const dims = e.data.dims;

        if (e.data.ft3Bytes) {
            window.last_processed_ft3_blob = new Blob([e.data.ft3Bytes], { type: 'application/octet-stream' });
            let btn = document.getElementById('button_download_ft3_processed');
            if (btn) {
                btn.style.display = 'inline-block';
                btn.onclick = function () {
                    if (window.last_processed_ft3_blob) {
                        const url = URL.createObjectURL(window.last_processed_ft3_blob);
                        const a = document.createElement('a');
                        a.href = url;
                        a.download = 'processed.ft3';
                        document.body.appendChild(a);
                        a.click();
                        a.remove();
                        URL.revokeObjectURL(url);
                    }
                };
            }
        }

        const nx = dims.nx;
        const ny = dims.ny;
        const nz = dims.nz;
        append_3d_log('[main] dims: nx=' + nx + ', ny=' + ny + ', nz=' + nz);
        console.log('[3D][fid] Received dims', dims);

        // Preserve nuclei captured during processing logs
        reset_3d_dataset_state(true);

        if (e.data.ft3Bytes) {
            let ft3Data = e.data.ft3Bytes;

            // Auto phase correction for normal workflow (or NUS phase check mode)
            if (e.data["#sym:webassembly_job "] !== "postprocess_ft3" && current_fid_config && (current_fid_config.normalDirectDimAutoPhase || current_fid_config.nusDirectDimAutoPhase)) {
                append_3d_log("[tfjs] Starting auto phase correction on direct dimension...");
                try {
                    const result = await NUS3DPhasePipeline.runFromFt3({
                        tf: window.tf,
                        ft3ArrayBuffer: ft3Data.buffer,
                        model: tfjs_normal_model,
                        largeModel: tfjs_large_model,
                        modelUrl: 'js/model22_tfjs/model.json',
                        largeModelUrl: 'js/model22_large_tfjs/model.json'
                    });

                    // Cache models if they were loaded inside the pipeline
                    if (!tfjs_normal_model && result.stage_normal_1 && result.stage_normal_1.model) {
                        // Wait, looking at tfjs_infer_full_pipeline.js, it doesn't return the model in stage_normal_1.
                        // I'll have to load them manually if I want to cache them easily, or modify the pipeline.
                        // But let's check if they are returned. Stage_normal_1 is the result of runModelOnCubes.
                        // runModelOnCubes returns { pred_local_phase, pred_local_w, wls_phase_left_right }. No model.
                    }

                    const lr = result.final_wls_phase_left_right[0]; // Batch 0
                    const leftEdge = lr[0];
                    const rightEdge = lr[1];

                    // Read header to get spectral parameters for local scaling (construct Float32Array directly from offset)
                    const h = new Float32Array(ft3Data.buffer, ft3Data.byteOffset, 512);
                    const sw = h[100];
                    const frq = h[119];
                    const ref = h[101];
                    const x_ppm_width = sw / frq;
                    const x_ppm_start_val = (ref + sw) / frq - x_ppm_width / nx / 2;

                    // Local parameters for immediate application to the current extracted spectrum
                    const local_p0 = leftEdge;
                    const local_p1 = (rightEdge - leftEdge) * (nx - 1) / nx;
                    const local_pivot = x_ppm_start_val;

                    // Extrapolate to global parameters ONLY for UI box display
                    let ui_p0 = local_p0;
                    let ui_p1 = local_p1;

                    if (window.last_fid_full_ppm_range && window.last_fid_extract_ppm_range) {
                        const phaseMeta = get_full_spectrum_phase_correction(leftEdge, rightEdge, window.last_fid_full_ppm_range, window.last_fid_extract_ppm_range);
                        ui_p0 = phaseMeta.p0;
                        ui_p1 = phaseMeta.p1;
                        append_3d_log(`[tfjs] Extrapolated phase for UI display: p0=${ui_p0.toFixed(2)}, p1=${ui_p1.toFixed(2)}`);
                    } else {
                        append_3d_log(`[tfjs] Auto phase result (local): p0=${local_p0.toFixed(2)}, local_p1=${local_p1.toFixed(2)}`);
                        console.warn('[3D] Missing spectral metadata for extrapolation. Falling back to local values.', window.last_fid_full_ppm_range, window.last_fid_extract_ppm_range);
                    }

                    append_3d_log(`[tfjs] Auto phase calculated. UI update will follow application.`);

                    // Internally, ALWAYS use the local parameters for the current extraction
                    trace_x_ph0 = local_p0;
                    trace_x_ph1 = local_p1;
                    trace_x_pivot = local_pivot;

                    // Set auto_p0_3d/auto_p1_3d to non-null to trigger the application later
                    auto_p0_3d = local_p0;
                    auto_p1_3d = local_p1;

                    if (current_fid_config && !current_fid_config.isNus && current_fid_config.normalDirectDimAutoPhase) {
                        append_3d_log("[main] Automatically running final baseline correction and phase correction in C++ post-processing...");

                        const box0 = document.getElementById('phase_correction_direct_p0');
                        const box1 = document.getElementById('phase_correction_direct_p1');
                        if (box0) box0.value = (parseFloat(box0.value || 0) + ui_p0).toFixed(2);
                        if (box1) box1.value = (parseFloat(box1.value || 0) + ui_p1).toFixed(2);

                        const autoCheckbox = document.getElementById('normal_direct_dim_auto_phase_3d');
                        if (autoCheckbox) {
                            autoCheckbox.checked = false;
                            autoCheckbox.dispatchEvent(new Event('change'));
                        }

                        // Reset JS phase variables so that the phase isn't double-applied on rendering/drawing
                        auto_p0_3d = null;
                        auto_p1_3d = null;
                        trace_x_ph0 = 0.0;
                        trace_x_ph1 = 0.0;
                        trace_x_pivot = null;

                        // Phase text to send: construct using calculated local_p0, local_p1 and current UI values for indirect dimensions
                        const ind1_p0 = document.getElementById('phase_correction_indirect1_p0').value || "0.0";
                        const ind1_p1 = document.getElementById('phase_correction_indirect1_p1').value || "0.0";
                        const ind2_p0 = document.getElementById('phase_correction_indirect2_p0').value || "0.0";
                        const ind2_p1 = document.getElementById('phase_correction_indirect2_p1').value || "0.0";
                        const phaseTextToUse = `${local_p0} ${local_p1} ${ind1_p0} ${ind1_p1} ${ind2_p0} ${ind2_p1}`;

                        append_3d_log(`[main] Posting postprocess_ft3 to worker with direct phases local_p0=${local_p0.toFixed(2)}, local_p1=${local_p1.toFixed(2)}`);

                        document.getElementById("webassembly_message").innerText = "Running final baseline correction and phase application in C++...";

                        // Disable auto phase in config so it isn't run on final response
                        current_fid_config.normalDirectDimAutoPhase = false;

                        web_worker_3d.postMessage({
                            "#sym:webassembly_job ": "postprocess_ft3",
                            cfg: current_fid_config,
                            phaseTextToUse: phaseTextToUse,
                            ft3Bytes: ft3Data
                        }, [ft3Data.buffer]);

                        ft3Data = null;
                        e.data.ft3Bytes = null;
                        return;
                    }

                    if (current_fid_config && current_fid_config.nusDirectDimAutoPhase && !current_fid_config.showArtifact) {
                        append_3d_log("[main] Automatically re-running NUS processing with calculated phase values...");

                        const box0 = document.getElementById('phase_correction_direct_p0');
                        const box1 = document.getElementById('phase_correction_direct_p1');
                        if (box0) box0.value = (parseFloat(box0.value || 0) + ui_p0).toFixed(2);
                        if (box1) box1.value = (parseFloat(box1.value || 0) + ui_p1).toFixed(2);

                        const autoCheckbox = document.getElementById('normal_direct_dim_auto_phase_3d');
                        if (autoCheckbox) {
                            autoCheckbox.checked = false;
                            autoCheckbox.dispatchEvent(new Event('change'));
                        }

                        auto_p0_3d = null;
                        auto_p1_3d = null;
                        trace_x_ph0 = 0.0;
                        trace_x_ph1 = 0.0;
                        trace_x_pivot = null;

                        setTimeout(() => {
                            load_fid_3d_file();
                        }, 100);

                        ft3Data = null;
                        e.data.ft3Bytes = null;
                        return;
                    }

                } catch (err) {
                    append_3d_log("[tfjs-error] " + err.message);
                    console.error(err);
                }
            }

            let header = new Float32Array(ft3Data.buffer, ft3Data.byteOffset, 512);

            let n_direct = header[99];
            let n_indirect = header[219];
            let data_types = [header[55], header[56], header[51], header[54]];
            let dimorder1 = header[24];
            let dimorder2 = header[25];
            let datatype_direct = data_types[dimorder1 - 1];
            let datatype_indirect = data_types[dimorder2 - 1];

            let parts = 1;
            if (datatype_direct === 0) parts++;
            if (datatype_indirect === 0) parts++;
            if (datatype_direct === 0 && datatype_indirect === 0) parts++;

            let n_indirect_loops = n_indirect;
            if (datatype_direct === 0 && datatype_indirect === 0) n_indirect_loops /= 2;

            let plane_float_count = n_indirect_loops * n_direct * parts;
            let plane_byte_size = plane_float_count * 4;

            let total_data_bytes = ft3Data.byteLength - 2048;

            let header_plane_count = Math.round(header[15]); // FDF3SIZE
            let num_planes = (Number.isFinite(header_plane_count) && header_plane_count > 0)
                ? header_plane_count
                : Math.floor(total_data_bytes / plane_byte_size);

            let data_start_offset = 2048;
            let residual_bytes = total_data_bytes - num_planes * plane_byte_size;
            if (residual_bytes === 2048) {
                data_start_offset += 2048;
            }

            let headerUint8 = new Uint8Array(ft3Data.buffer, ft3Data.byteOffset, 2048);

            for (let i = 0; i < num_planes; i++) {
                try {
                    let start_offset = data_start_offset + i * plane_byte_size;
                    let planeDataArray = ft3Data.subarray(start_offset, start_offset + plane_byte_size);

                    let plane_buffer = new ArrayBuffer(2048 + plane_byte_size);
                    let dst = new Uint8Array(plane_buffer);

                    // Copy header
                    dst.set(headerUint8, 0);

                    // Copy data
                    dst.set(planeDataArray, 2048);

                    let s = new spectrum();
                    let plane_name = "plane_" + String(i + 1).padStart(3, '0');
                    s.process_ft_file(plane_buffer, plane_name, -1);

                    s.spectrum_color = document.getElementById('color_exp_pos') ? document.getElementById('color_exp_pos').value : "#0000ff";
                    s.spectrum_color_negative = document.getElementById('color_exp_neg') ? document.getElementById('color_exp_neg').value : "#00ff00";
                    s.levels = calculate_levels(s.noise_level, 1.5, 30);
                    s.negative_levels = calculate_negative_levels(s.noise_level, 1.5, 30);
                    s.visible = true;

                    spectra_3d.push(s);
                } catch (err) {
                    console.error("Error creating plane " + i, err);
                    append_3d_log('[main-error] plane ' + i + ' creation failed: ' + (err && err.message ? err.message : String(err)));
                }
            }
            ft3Data = null;
            e.data.ft3Bytes = null;
        } else {
            console.error("Missing ft3Bytes in process_fid_3d result.");
        }

        append_3d_log('[main] planes created: ' + spectra_3d.length);

        if (spectra_3d.length > 0) {
            let slider = document.getElementById('slice_slider');
            slider.max = spectra_3d.length - 1;
            slider.value = 0;
            document.getElementById('slice_control_area').style.display = 'block';
            document.getElementById('aux_buttons').style.display = 'block';
            document.getElementById('main_plot_area').style.display = 'flex';

            // Keep initialization behavior consistent with .ft2/.ft3 file loaders.
            init_main_plot(spectra_3d[0]);

            update_global_noise_level();

            // Auto-apply direct phase correction if it was calculated (Normal or NUS)
            if (auto_p0_3d !== null && auto_p1_3d !== null) {
                append_3d_log("[tfjs] Applying auto phase correction to all planes...");
                // Note: trace_x_ph0, trace_x_ph1, and trace_x_pivot were already set to local values above
                apply_trace_x_phase(trace_x_ph0, trace_x_ph1, trace_x_pivot);
            }

            draw_slice(0);
            append_3d_log('[main] 3D render initialized successfully');
            set_status_message("webassembly_message", "3D FID processing and rendering finished successfully.", 5000);

            // Sync projection view if checked
            const projChecked = !!(document.getElementById('check_visualize_proj') && document.getElementById('check_visualize_proj').checked);
            if (projChecked) {
                toggle_visualize_proj(true);
            }
        } else {
            append_3d_log('[main] no planes generated from worker output');
            document.getElementById("webassembly_message").innerText = "No planes were generated.";
        }
        set_loading_buttons_state(false);
    }
}

/**
 * Handles webass smile 3D message.
 *
 * @param {any} e - E
 */
function handle_webass_smile_3d_message(e) {
    if (e.data && e.data.stdout) {
        append_3d_worker_stdout('[smile] ' + e.data.stdout);
        return;
    }

    if (e.data && e.data.spectrum_data && e.data.file_type === 'smile_3d') {
        const smileBytes = e.data.spectrum_data instanceof Uint8Array
            ? e.data.spectrum_data
            : new Uint8Array(e.data.spectrum_data);
        append_3d_log('[main] Received smile.ft3 from SMILE worker, bytes=' + smileBytes.length);

        // Debug 2 disabled in UI (kept for future use).
        // if (debug2_smile_only_3d) {
        //     debug2_smile_only_3d = false;
        //     download_binary_file(smileBytes, 'smile_debug.ft3');
        //     document.getElementById("webassembly_message").innerText = 'Debug 2 finished. SMILE output saved as smile_debug.ft3.';
        //     return;
        // }

        document.getElementById("webassembly_message").innerText = 'Running indirect-only processing from smile.ft3...';
        web_worker_3d.postMessage({
            "#sym:webassembly_job ": 'process_fid_3d_nus_step3',
            cfg: pending_nus_cfg_3d,
            smileFt3Bytes: smileBytes
        }, [smileBytes.buffer]);
        return;
    }

    if (e.data && e.data.error) {
        // Debug 2 disabled in UI (kept for future use).
        // debug2_smile_only_3d = false;
        append_3d_log('[smile-worker-error] ' + e.data.error);
        document.getElementById("webassembly_message").innerText = 'SMILE error: ' + e.data.error;
        set_loading_buttons_state(false);
    }
}

/**
 * Applies trace X phase.
 *
 * @param {any} p0 - P0
 * @param {any} p1 - P1
 * @param {any} pivot - Pivot
 */
function apply_trace_x_phase(p0, p1, pivot) {
    if (!spectra_3d || spectra_3d.length === 0) return;
    if (!spectra_3d.every(s => s.raw_data_ri && s.raw_data_ri.length > 0)) {
        alert("Imaginary data (raw_data_ri) not available for phase correction.");
        return;
    }

    // Determine the 'delta' phase to be applied.
    // If called from the UI button, p0/p1 are undefined, so we use the slider values (trace_x_ph0/ph1).
    let add_p0 = p0 !== undefined ? p0 : trace_x_ph0;
    let add_p1 = p1 !== undefined ? p1 : trace_x_ph1;
    let apply_pivot = pivot !== undefined ? pivot : trace_x_pivot;

    if (add_p0 === 0 && add_p1 === 0) return;

    // 1. Calculate global extrapolation of this 'delta' phase and add to the total boxes
    const s0 = spectra_3d[0];
    const h = s0.header;
    if (h && h.length >= 512 && typeof get_full_spectrum_phase_correction === 'function') {
        let full_ppm_range, extract_ppm_range;

        // Prefer worker-captured ranges for FID route (especially important for NUS)
        if (window.last_fid_full_ppm_range && window.last_fid_extract_ppm_range) {
            full_ppm_range = window.last_fid_full_ppm_range;
            extract_ppm_range = window.last_fid_extract_ppm_range;
        } else {
            const swDirect = h[100];
            const obsDirect = h[119];
            const originDirect = h[257];
            const full_ppm_width = swDirect / obsDirect;
            full_ppm_range = [originDirect, originDirect - full_ppm_width];
            extract_ppm_range = [s0.x_ppm_start, s0.x_ppm_start + (s0.n_direct - 1) * s0.x_ppm_step];
        }

        // We assume add_p1 is for the current extracted width (local)
        const phaseMeta = get_full_spectrum_phase_correction(add_p0, add_p0 + add_p1, full_ppm_range, extract_ppm_range);

        const box0 = document.getElementById('phase_correction_direct_p0');
        const box1 = document.getElementById('phase_correction_direct_p1');
        if (box0) box0.value = (parseFloat(box0.value || 0) + phaseMeta.p0).toFixed(2);
        if (box1) box1.value = (parseFloat(box1.value || 0) + phaseMeta.p1).toFixed(2);

        append_3d_log(`[phase] Applied delta: local_p0=${add_p0.toFixed(2)}, local_p1=${add_p1.toFixed(2)}`);
    }

    let p0_rad = add_p0 * Math.PI / 180.0;
    let p1_rad = add_p1 * Math.PI / 180.0;

    for (let z = 0; z < spectra_3d.length; z++) {
        let s = spectra_3d[z];
        let nx = s.n_direct;
        let ny = s.n_indirect;

        let new_raw_data = new Float32Array(s.raw_data.length);
        let has_ri = s.raw_data_ri && s.raw_data_ri.length > 0;
        let new_raw_data_ri = has_ri ? new Float32Array(s.raw_data_ri.length) : null;

        for (let y = 0; y < ny; y++) {
            for (let x = 0; x < nx; x++) {
                let re = s.raw_data[y * nx + x];
                let im = has_ri ? s.raw_data_ri[y * nx + x] : 0;

                const nx_full = Math.max(s.header[96], nx);
                const x1 = s.header[257] || 0;

                let phase_rad;
                if (apply_pivot === null || Math.abs(apply_pivot - s.x_ppm_start) < 1e-6) {
                    phase_rad = p0_rad + p1_rad * x / (nx - 1);
                } else {
                    const global_x = x + x1;
                    const global_pivot = Math.round((apply_pivot - s.x_ppm_start) / s.x_ppm_step) + x1;
                    phase_rad = p0_rad + p1_rad * (global_x - global_pivot) / (nx_full - 1);
                }

                new_raw_data[y * nx + x] = re * Math.cos(phase_rad) - im * Math.sin(phase_rad);
                if (has_ri) {
                    new_raw_data_ri[y * nx + x] = re * Math.sin(phase_rad) + im * Math.cos(phase_rad);
                }
            }
        }

        s.raw_data = new_raw_data;
        if (has_ri) {
            s.raw_data_ri = new_raw_data_ri;
        }

        // Update header to reflect that data is now phased
        if (s.header && s.header.length >= 512) {
            s.header[109] = 0.0; // FDF2P0
            s.header[110] = 0.0; // FDF2P1
        }

        s.cached_contour_pos = null;
        s.cached_contour_neg = null;
    }

    trace_x_ph0 = 0.0;
    trace_x_ph1 = 0.0;
    trace_x_pivot = null;

    // Reset slider labels
    ['trace_x_ph0_val', 'trace_proj_x_ph0_val', 'trace_proj_y_x_ph0_val',
        'trace_x_ph1_val', 'trace_proj_x_ph1_val', 'trace_proj_y_x_ph1_val'].forEach(id => {
            let el = document.getElementById(id);
            if (el) el.innerText = '0.0';
        });
    ['trace_x_pivot_val', 'trace_proj_x_pivot_val', 'trace_proj_y_x_pivot_val'].forEach(id => {
        let el = document.getElementById(id);
        if (el) el.innerText = 'not set';
    });

    update_contour_levels();

    // Update 2D projections after phase application
    generate_projection_spectrum();

    visualize_3d();
    draw_slice(current_slice_index >= 0 ? current_slice_index : 0);

    // Update 2D orthogonal views with new phased contours
    if (main_plot_xz) refresh_xz_view();
    if (main_plot_yz) refresh_yz_view();
}
window.addEventListener('DOMContentLoaded', () => {
    let btn = document.getElementById('btn_apply_trace_x_phase');
    if (btn) {
        btn.addEventListener('click', apply_trace_x_phase);
    }

    if (typeof ResizeObserver !== 'undefined') {
        const ro = new ResizeObserver(() => {
            if (spectra_3d && spectra_3d.length > 0) {
                update_1d_traces_from_center();
            }
        });
        ['trace_z_svg', 'trace_y_svg', 'trace_x_svg', 'trace_proj_x_svg', 'trace_proj_y_x_svg', 'trace_proj_z_svg'].forEach(id => {
            const el = document.getElementById(id);
            if (el && el.parentElement) {
                ro.observe(el.parentElement);
            }
        });
    }

    setup_2d_plot_resizing();

    // Auto phase correction (Normal) checkbox pre-load
    const autoDirectNormal = document.getElementById('normal_direct_dim_auto_phase_3d');
    if (autoDirectNormal) {
        autoDirectNormal.addEventListener('change', async function () {
            if (this.checked && typeof NUS3DPhasePipeline !== 'undefined' && window.tf) {
                if (!tfjs_normal_model || !tfjs_large_model) {
                    append_3d_log("[tfjs] Pre-loading models...");
                    try {
                        if (!tfjs_normal_model) tfjs_normal_model = await NUS3DPhasePipeline.loadModel(window.tf, 'js/model22_tfjs/model.json');
                        if (!tfjs_large_model) tfjs_large_model = await NUS3DPhasePipeline.loadModel(window.tf, 'js/model22_large_tfjs/model.json');
                        append_3d_log("[tfjs] Models loaded successfully.");
                    } catch (err) {
                        append_3d_log("[tfjs-error] Failed to pre-load models: " + err.message);
                    }
                }
            }
        });

        // Handle grey out for "show spectrum with artifact" based on auto phase correction
        autoDirectNormal.addEventListener('change', function () {
            const artifactCheckbox = document.getElementById('show_spectrum_artifact_3d');
            const artifactLabel = document.getElementById('label_show_spectrum_artifact_3d');
            if (artifactCheckbox && artifactLabel) {
                if (this.checked) {
                    artifactCheckbox.disabled = false;
                    artifactLabel.style.color = '';
                } else {
                    artifactCheckbox.disabled = true;
                    artifactCheckbox.checked = false; // Reset to unchecked when disabled
                    artifactLabel.style.color = 'gray';
                }
            }
        });

        // Trigger initial state
        autoDirectNormal.dispatchEvent(new Event('change'));
    }

});

/**
 * Setups 2D plot resizing.
 */
function setup_2d_plot_resizing() {
    if (typeof ResizeObserver === 'undefined') return;

    const plots = [
        { parent: "vis_parent", svg: "visualization", canvas: "canvas1", get_plot: () => typeof main_plot !== 'undefined' ? main_plot : null },
        { parent: "vis_parent_xz", svg: "visualization_xz", canvas: "canvas_xz", get_plot: () => typeof main_plot_xz !== 'undefined' ? main_plot_xz : null },
        { parent: "vis_parent_yz", svg: "visualization_yz", canvas: "canvas_yz", get_plot: () => typeof main_plot_yz !== 'undefined' ? main_plot_yz : null },
        { parent: "vis_parent_proj", svg: "visualization_proj", canvas: "canvas_proj", get_plot: () => typeof main_plot_proj !== 'undefined' ? main_plot_proj : null },
        { parent: "vis_parent_proj_y", svg: "visualization_proj_y", canvas: "canvas_proj_y", get_plot: () => typeof main_plot_proj_y !== 'undefined' ? main_plot_proj_y : null },
        { parent: "vis_parent_proj_x", svg: "visualization_proj_x", canvas: "canvas_proj_x", get_plot: () => typeof main_plot_proj_x !== 'undefined' ? main_plot_proj_x : null }
    ];

    const ro = new ResizeObserver((entries) => {
        for (let entry of entries) {
            let el = entry.target;
            let plot_info = plots.find(p => p.parent === el.id);
            if (!plot_info) continue;

            let plot_instance = plot_info.get_plot();
            if (!plot_instance) continue;

            let cr = get_content_size(plot_info.parent);
            if (!cr || cr.width <= 0 || cr.height <= 0) continue;

            let svg_el = document.getElementById(plot_info.svg);
            if (svg_el) {
                svg_el.setAttribute("width", cr.width);
                svg_el.setAttribute("height", cr.height);
            }

            let plot_font_size = 24;
            let plot_margin_left = 30 + plot_font_size * 5;
            let plot_margin_bottom = 30 + plot_font_size * 3;
            let plot_margin_top = 30;
            let plot_margin_right = 30;

            let plot_width = cr.width - plot_margin_left - plot_margin_right;
            let plot_height = cr.height - plot_margin_top - plot_margin_bottom;

            if (plot_width > 0 && plot_height > 0) {
                let canvas_el = document.getElementById(plot_info.canvas);
                if (canvas_el) {
                    canvas_el.style.left = plot_margin_left + "px";
                    canvas_el.style.top = plot_margin_top + "px";
                    canvas_el.setAttribute("width", Math.max(0, plot_width));
                    canvas_el.setAttribute("height", Math.max(0, plot_height));
                }
            }

            // Important: update the plot scales and visuals
            plot_instance.update({ WIDTH: cr.width, HEIGHT: cr.height });

            // Redraw/move all crosshairs with updated scales
            update_3d_crosshairs();
        }
    });

    plots.forEach(p => {
        let el = document.getElementById(p.parent);
        if (el) ro.observe(el);
    });

    const ro_1d = new ResizeObserver(() => {
        if (spectra_3d && spectra_3d.length > 0) {
            update_1d_traces_from_center();
        }
    });
    ['trace_z_svg', 'trace_y_svg', 'trace_x_svg', 'trace_proj_x_svg', 'trace_proj_y_x_svg', 'trace_proj_z_svg'].forEach(id => {
        const el = document.getElementById(id);
        if (el && el.parentElement) {
            ro_1d.observe(el.parentElement);
        }
    });
}


/**
 * XY Projection Plot Logic
 */
function init_proj_plot(s) {
    if (!s) return;

    let parent = document.getElementById("vis_parent_proj");
    if (!parent) return;
    let cr = parent.getBoundingClientRect();

    let plot_font_size = 24;
    let plot_margin_left = 30 + plot_font_size * 5;
    let plot_margin_bottom = 30 + plot_font_size * 3;
    let plot_margin_top = 30;
    let plot_margin_right = 30;

    let margins = {
        left: plot_margin_left,
        top: plot_margin_top,
        right: plot_margin_right,
        bottom: plot_margin_bottom
    };

    let plot_width = Math.max(0, cr.width - plot_margin_left - plot_margin_right);
    let plot_height = Math.max(0, cr.height - plot_margin_top - plot_margin_bottom);

    let cvs = document.getElementById("canvas_proj");
    let svg = document.getElementById("visualization_proj");

    if (cvs) {
        cvs.style.position = "absolute";
        cvs.style.left = plot_margin_left + "px";
        cvs.style.top = plot_margin_top + "px";
        cvs.setAttribute("width", plot_width);
        cvs.setAttribute("height", plot_height);
    }

    if (svg) { svg.setAttribute("width", cr.width); svg.setAttribute("height", cr.height); }

    let input_proj = {
        WIDTH: cr.width,
        HEIGHT: cr.height,
        MARGINS: margins,
        fontsize: plot_font_size,
        x_ppm_start: s.x_ppm_start,
        x_ppm_step: s.x_ppm_step,
        y_ppm_start: s.y_ppm_start,
        y_ppm_step: s.y_ppm_step,
        n_direct: s.n_direct,
        n_indirect: s.n_indirect,
        drawto: "#visualization_proj",
        drawto_contour: "canvas_proj",
        drawto_infor: "infor_proj",
        size: [cr.width, cr.height]
    };
    main_plot_proj = new plotit(input_proj);
    main_plot_proj.draw();

    // Disable interactive behaviors
    main_plot_proj.cross_line_pause_flag = false;
    if (typeof main_plot_proj.allow_right_click === 'function') {
        main_plot_proj.allow_right_click(false);
    }

    update_all_plot_axis_labels();
}

/**
 * Handles projection response.
 *
 * @param {any} data - Data
 * @param {any} type - Type
 */
function handle_proj_response(data, type) {
    let spec = (type === "proj") ? spectrum_proj : theoretical_spectrum_proj;
    if (!spec) return;

    if (data.contour_sign === 0) spec.cached_contour_pos = data;
    else spec.cached_contour_neg = data;

    refresh_proj_plot();
}

/**
 * Refreshes projection plot.
 */
function refresh_proj_plot() {
    if (!main_plot_proj || !spectrum_proj) return;

    let spectra_list = [spectrum_proj];
    if (theoretical_spectrum_proj) spectra_list.push(theoretical_spectrum_proj);

    render_to_plot(main_plot_proj, spectra_list);
}

/**
 * Renders to plot.
 *
 * @param {any} plot - Plot
 * @param {any} spectra_list - Spectra list
 */
function render_to_plot(plot, spectra_list) {
    if (!plot) return;

    plot.local_spectra = spectra_list;

    let points_pos_list = [];
    let len_pos_list = [];
    let poly_pos_list = [];
    let points_neg_list = [];
    let len_neg_list = [];
    let poly_neg_list = [];
    let color_pos_list = [];
    let color_neg_list = [];
    let lbs_pos_list = [];
    let lbs_neg_list = [];
    let start_pos_list = [];
    let start_neg_list = [];
    let spectral_info_list = [];
    let spectral_order_list = [];

    let total_points = 0;

    for (let i = 0; i < spectra_list.length; i++) {
        let spec = spectra_list[i];
        if (!spec.cached_contour_pos) continue;

        let p_pos = spec.cached_contour_pos.points;
        if (!(p_pos instanceof Float32Array)) p_pos = new Float32Array(p_pos);

        let p_neg = spec.cached_contour_neg ? spec.cached_contour_neg.points : new Float32Array([]);
        if (!(p_neg instanceof Float32Array)) p_neg = new Float32Array(p_neg);

        points_pos_list.push(p_pos);
        points_neg_list.push(p_neg);

        len_pos_list.push(spec.cached_contour_pos.levels_length);
        poly_pos_list.push(spec.cached_contour_pos.polygon_length);
        len_neg_list.push(spec.cached_contour_neg ? spec.cached_contour_neg.levels_length : []);
        poly_neg_list.push(spec.cached_contour_neg ? spec.cached_contour_neg.polygon_length : []);

        color_pos_list.push(hexToRgb(spec.spectrum_color));
        color_neg_list.push(spec.spectrum_color_negative ? hexToRgb(spec.spectrum_color_negative) : [0, 0, 0, 1]);

        lbs_pos_list.push(0);
        lbs_neg_list.push(0);

        start_pos_list.push(total_points);
        total_points += p_pos.length;
        start_neg_list.push(total_points);
        total_points += p_neg.length;

        spectral_info_list.push({
            x_ppm_start: spec.x_ppm_start,
            x_ppm_step: spec.x_ppm_step,
            y_ppm_start: spec.y_ppm_start,
            y_ppm_step: spec.y_ppm_step,
            x_ppm_ref: 0,
            y_ppm_ref: 0
        });
        spectral_order_list.push(i);
    }

    if (spectral_order_list.length === 0) return;

    let combined_points = new Float32Array(total_points);
    let offset = 0;
    for (let i = 0; i < points_pos_list.length; i++) {
        combined_points.set(points_pos_list[i], offset);
        offset += points_pos_list[i].length;
        combined_points.set(points_neg_list[i], offset);
        offset += points_neg_list[i].length;
    }

    plot.contour_plot.spectral_order = spectral_order_list;
    plot.contour_plot.set_data(
        spectral_info_list,
        combined_points,
        start_pos_list,
        poly_pos_list,
        len_pos_list,
        color_pos_list,
        lbs_pos_list,
        start_neg_list,
        poly_neg_list,
        len_neg_list,
        color_neg_list,
        lbs_neg_list
    );

    let x_dom = plot.xRange.domain();
    let y_dom = plot.yRange.domain();
    plot.contour_plot.setCamera_ppm(x_dom[0], x_dom[1], y_dom[0], y_dom[1]);
    plot.contour_plot.drawScene();
}

/**
 * Generates projection spectrum.
 */
function generate_projection_spectrum() {
    if (!spectra_3d || spectra_3d.length === 0) return;

    let s0 = spectra_3d[0];
    let nx = s0.n_direct;
    let ny = s0.n_indirect;
    let nz = spectra_3d.length;

    let spec = new spectrum();
    spec.n_direct = nx;
    spec.n_indirect = ny;
    spec.x_ppm_start = s0.x_ppm_start;
    spec.x_ppm_step = s0.x_ppm_step;
    spec.y_ppm_start = s0.y_ppm_start;
    spec.y_ppm_step = s0.y_ppm_step;

    let raw = new Float32Array(nx * ny);
    let has_ri = spectra_3d.every(s => s.raw_data_ri && s.raw_data_ri.length > 0);
    let raw_ri = has_ri ? new Float32Array(nx * ny) : null;

    for (let z = 0; z < nz; z++) {
        let slice = spectra_3d[z];
        let slice_data = slice.raw_data;
        if (slice_data && slice_data.length === nx * ny) {
            for (let i = 0; i < nx * ny; i++) {
                raw[i] += slice_data[i];
            }
        }
        if (has_ri) {
            let slice_ri = slice.raw_data_ri;
            for (let i = 0; i < nx * ny; i++) {
                raw_ri[i] += slice_ri[i];
            }
        }
    }
    for (let i = 0; i < nx * ny; i++) {
        raw[i] /= nz;
        if (has_ri) raw_ri[i] /= nz;
    }
    spec.raw_data = raw;
    if (has_ri) spec.raw_data_ri = raw_ri;

    // Estimate noise level for the projected 2D spectrum separately
    spec.noise_level = mathTool.estimate_noise_level(nx, ny, raw);
    adjust_proj_noise(spec, "proj_noise_level_display");

    let multiplier = parseFloat(document.getElementById("proj_contour_start_multiplier").value) || 10.0;
    let scale = parseFloat(document.getElementById("proj_contour_scale_factor").value) || 1.4;

    spec.levels = calculate_levels(spec.noise_level, scale, 30, multiplier, scale);
    spec.negative_levels = calculate_negative_levels(spec.noise_level, scale, 30, multiplier, scale);
    spec.spectrum_color = "#0000ff";
    spec.spectrum_color_negative = "#0000ff";

    spectrum_proj = spec;
    request_contour_calculation(spec, 0, 0, "proj");
    request_contour_calculation(spec, 0, 1, "proj");

    // Y-Projection (XZ Plane)
    let specY = new spectrum();
    specY.n_direct = nx;
    specY.n_indirect = nz;
    specY.x_ppm_start = s0.x_ppm_start;
    specY.x_ppm_step = s0.x_ppm_step;
    specY.y_ppm_start = s0.z_ppm_start;
    specY.y_ppm_step = s0.z_ppm_step;

    let rawY = new Float32Array(nx * nz);
    let rawY_ri = has_ri ? new Float32Array(nx * nz) : null;

    for (let z = 0; z < nz; z++) {
        let slice = spectra_3d[z];
        let slice_data = slice.raw_data;
        let slice_ri = has_ri ? slice.raw_data_ri : null;
        for (let y = 0; y < ny; y++) {
            for (let x = 0; x < nx; x++) {
                rawY[z * nx + x] += slice_data[y * nx + x];
                if (has_ri) rawY_ri[z * nx + x] += slice_ri[y * nx + x];
            }
        }
    }
    for (let i = 0; i < nx * nz; i++) {
        rawY[i] /= ny;
        if (has_ri) rawY_ri[i] /= ny;
    }
    specY.raw_data = rawY;
    if (has_ri) specY.raw_data_ri = rawY_ri;

    specY.noise_level = mathTool.estimate_noise_level(nx, nz, rawY);
    adjust_proj_noise(specY, "proj_y_noise_level_display");

    let multiplierY = parseFloat(document.getElementById("proj_y_contour_start_multiplier").value) || 10.0;
    let scaleY = parseFloat(document.getElementById("proj_y_contour_scale_factor").value) || 1.4;

    specY.levels = calculate_levels(specY.noise_level, scaleY, 30, multiplierY, scaleY);
    specY.negative_levels = calculate_negative_levels(specY.noise_level, scaleY, 30, multiplierY, scaleY);
    specY.spectrum_color = "#0000ff";
    specY.spectrum_color_negative = "#0000ff";

    spectrum_proj_y = specY;
    request_contour_calculation(specY, 0, 0, "proj_y");
    request_contour_calculation(specY, 0, 1, "proj_y");

    // X-Projection (Along Direct dimension F2/z, showing F3/x vs F1/y)
    let specX = new spectrum();
    specX.n_direct = ny;
    specX.n_indirect = nz;
    specX.x_ppm_start = s0.y_ppm_start;
    specX.x_ppm_step = s0.y_ppm_step;
    specX.y_ppm_start = s0.z_ppm_start;
    specX.y_ppm_step = s0.z_ppm_step;

    let rawX = new Float32Array(ny * nz);
    for (let z = 0; z < nz; z++) {
        let slice = spectra_3d[z];
        let slice_data = slice.raw_data;
        if (slice_data && slice_data.length === nx * ny) {
            for (let y = 0; y < ny; y++) {
                let sum = 0;
                for (let x = 0; x < nx; x++) {
                    sum += slice_data[y * nx + x];
                }
                rawX[z * ny + y] = sum / nx;
            }
        }
    }
    specX.raw_data = rawX;
    specX.noise_level = mathTool.estimate_noise_level(ny, nz, rawX);
    adjust_proj_noise(specX, "proj_x_noise_level_display");

    let multiplierX = parseFloat(document.getElementById("proj_x_contour_start_multiplier").value) || 10.0;
    let scaleX = parseFloat(document.getElementById("proj_x_contour_scale_factor").value) || 1.4;

    specX.levels = calculate_levels(specX.noise_level, scaleX, 30, multiplierX, scaleX);
    specX.negative_levels = calculate_negative_levels(specX.noise_level, scaleX, 30, multiplierX, scaleX);
    specX.spectrum_color = "#0000ff";
    specX.spectrum_color_negative = "#0000ff";

    spectrum_proj_x = specX;
    request_contour_calculation(specX, 0, 0, "proj_x");
    request_contour_calculation(specX, 0, 1, "proj_x");

    // Theoretical projection
    if (theoretical_spectra_3d && theoretical_spectra_3d.length > 0) {
        let st0 = theoretical_spectra_3d[0];
        let spec_theo = new spectrum();
        spec_theo.n_direct = nx;
        spec_theo.n_indirect = ny;
        spec_theo.x_ppm_start = st0.x_ppm_start;
        spec_theo.x_ppm_step = st0.x_ppm_step;
        spec_theo.y_ppm_start = st0.y_ppm_start;
        spec_theo.y_ppm_step = st0.y_ppm_step;

        let raw_theo = new Float32Array(nx * ny);
        for (let z = 0; z < theoretical_spectra_3d.length; z++) {
            let slice_data = theoretical_spectra_3d[z].raw_data;
            if (slice_data && slice_data.length === nx * ny) {
                for (let i = 0; i < nx * ny; i++) {
                    raw_theo[i] += slice_data[i];
                }
            }
        }
        for (let i = 0; i < nx * ny; i++) {
            raw_theo[i] /= theoretical_spectra_3d.length;
        }
        spec_theo.raw_data = raw_theo;
        spec_theo.noise_level = spec.noise_level;
        spec_theo.levels = spec.levels;
        spec_theo.negative_levels = spec.negative_levels;
        spec_theo.spectrum_color = "#ff0000";
        spec_theo.spectrum_color_negative = "#ff0000";

        theoretical_spectrum_proj = spec_theo;
        request_contour_calculation(spec_theo, 0, 0, "proj_theo");
        request_contour_calculation(spec_theo, 0, 1, "proj_theo");

        // Theoretical Y-Projection
        let spec_theo_y = new spectrum();
        spec_theo_y.n_direct = nx;
        spec_theo_y.n_indirect = nz;
        spec_theo_y.x_ppm_start = st0.x_ppm_start;
        spec_theo_y.x_ppm_step = st0.x_ppm_step;
        spec_theo_y.y_ppm_start = st0.z_ppm_start;
        spec_theo_y.y_ppm_step = st0.z_ppm_step;

        let raw_theo_y = new Float32Array(nx * nz);
        for (let z = 0; z < theoretical_spectra_3d.length; z++) {
            let slice_data = theoretical_spectra_3d[z].raw_data;
            for (let y = 0; y < ny; y++) {
                for (let x = 0; x < nx; x++) {
                    raw_theo_y[z * nx + x] += slice_data[y * nx + x];
                }
            }
        }
        for (let i = 0; i < nx * nz; i++) {
            raw_theo_y[i] /= ny;
        }
        spec_theo_y.raw_data = raw_theo_y;
        spec_theo_y.noise_level = specY.noise_level;
        spec_theo_y.levels = specY.levels;
        spec_theo_y.negative_levels = specY.negative_levels;
        spec_theo_y.spectrum_color = "#ff0000";
        spec_theo_y.spectrum_color_negative = "#ff0000";

        theoretical_spectrum_proj_y = spec_theo_y;
        request_contour_calculation(spec_theo_y, 0, 0, "proj_y_theo");
        request_contour_calculation(spec_theo_y, 0, 1, "proj_y_theo");

        // Theoretical X-Projection
        let spec_theo_x = new spectrum();
        spec_theo_x.n_direct = ny;
        spec_theo_x.n_indirect = nz;
        spec_theo_x.x_ppm_start = st0.y_ppm_start;
        spec_theo_x.x_ppm_step = st0.y_ppm_step;
        spec_theo_x.y_ppm_start = st0.z_ppm_start;
        spec_theo_x.y_ppm_step = st0.z_ppm_step;

        let raw_theo_x = new Float32Array(ny * nz);
        for (let z = 0; z < theoretical_spectra_3d.length; z++) {
            let slice_data = theoretical_spectra_3d[z].raw_data;
            for (let y = 0; y < ny; y++) {
                let sum = 0;
                for (let x = 0; x < nx; x++) {
                    sum += slice_data[y * nx + x];
                }
                raw_theo_x[z * ny + y] = sum / nx;
            }
        }
        spec_theo_x.raw_data = raw_theo_x;
        spec_theo_x.noise_level = specX.noise_level;
        spec_theo_x.levels = specX.levels;
        spec_theo_x.negative_levels = specX.negative_levels;
        spec_theo_x.spectrum_color = "#ff0000";
        spec_theo_x.spectrum_color_negative = "#ff0000";

        theoretical_spectrum_proj_x = spec_theo_x;
        request_contour_calculation(spec_theo_x, 0, 0, "proj_x_theo");
        request_contour_calculation(spec_theo_x, 0, 1, "proj_x_theo");
    }
    update_1d_traces_from_center();
}

/**
 * Estimates projection noise.
 */
function estimate_proj_noise() {
    if (!spectrum_proj) return;
    let raw = spectrum_proj.raw_data;
    let nx = spectrum_proj.n_direct;
    let ny = spectrum_proj.n_indirect;

    spectrum_proj.noise_level = mathTool.estimate_noise_level(nx, ny, raw);
    adjust_proj_noise(spectrum_proj, "proj_noise_level_display");

    update_proj_contour_levels();
}

/**
 * Updates projection contour levels.
 */
function update_proj_contour_levels() {
    if (!spectrum_proj) return;

    let multiplier = parseFloat(document.getElementById("proj_contour_start_multiplier").value) || 10.0;
    let scale = parseFloat(document.getElementById("proj_contour_scale_factor").value) || 1.4;

    spectrum_proj.spectrum_color = "#0000ff";
    spectrum_proj.spectrum_color_negative = "#0000ff";
    spectrum_proj.levels = calculate_levels(spectrum_proj.noise_level, scale, 30, multiplier, scale);
    spectrum_proj.negative_levels = calculate_negative_levels(spectrum_proj.noise_level, scale, 30, multiplier, scale);
    spectrum_proj.cached_contour_pos = null;
    spectrum_proj.cached_contour_neg = null;

    request_contour_calculation(spectrum_proj, 0, 0, "proj");
    request_contour_calculation(spectrum_proj, 0, 1, "proj");

    if (theoretical_spectrum_proj) {
        theoretical_spectrum_proj.spectrum_color = "#ff0000";
        theoretical_spectrum_proj.spectrum_color_negative = "#ff0000";
        theoretical_spectrum_proj.levels = spectrum_proj.levels;
        theoretical_spectrum_proj.negative_levels = spectrum_proj.negative_levels;
        theoretical_spectrum_proj.cached_contour_pos = null;
        theoretical_spectrum_proj.cached_contour_neg = null;
        request_contour_calculation(theoretical_spectrum_proj, 0, 0, "proj_theo");
        request_contour_calculation(theoretical_spectrum_proj, 0, 1, "proj_theo");
    }
}

/**
 * Resets projection zoom.
 */
function reset_proj_zoom() {
    if (!main_plot_proj || !spectrum_proj) return;
    let s = spectrum_proj;
    let x_dom = [s.x_ppm_start, s.x_ppm_start + s.x_ppm_step * s.n_direct];
    let y_dom = [s.y_ppm_start, s.y_ppm_start + s.y_ppm_step * s.n_indirect];
    main_plot_proj.resetzoom(x_dom, y_dom);
}

/**
 * Y-Projection (XZ) Plot Logic
 */
function init_proj_y_plot(s) {
    if (!s) return;

    let parent = document.getElementById("vis_parent_proj_y");
    if (!parent) return;
    let cr = parent.getBoundingClientRect();

    let plot_font_size = 24;
    let plot_margin_left = 30 + plot_font_size * 5;
    let plot_margin_bottom = 30 + plot_font_size * 3;
    let plot_margin_top = 30;
    let plot_margin_right = 30;

    let margins = {
        left: plot_margin_left,
        top: plot_margin_top,
        right: plot_margin_right,
        bottom: plot_margin_bottom
    };

    let plot_width = Math.max(0, cr.width - plot_margin_left - plot_margin_right);
    let plot_height = Math.max(0, cr.height - plot_margin_top - plot_margin_bottom);

    let cvs = document.getElementById("canvas_proj_y");
    let svg = document.getElementById("visualization_proj_y");

    if (cvs) {
        cvs.style.position = "absolute";
        cvs.style.left = plot_margin_left + "px";
        cvs.style.top = plot_margin_top + "px";
        cvs.setAttribute("width", plot_width);
        cvs.setAttribute("height", plot_height);
    }

    if (svg) { svg.setAttribute("width", cr.width); svg.setAttribute("height", cr.height); }

    let input_proj = {
        WIDTH: cr.width,
        HEIGHT: cr.height,
        MARGINS: margins,
        fontsize: plot_font_size,
        x_ppm_start: s.x_ppm_start,
        x_ppm_step: s.x_ppm_step,
        y_ppm_start: s.z_ppm_start, // Corrected: use Z-axis for vertical
        y_ppm_step: s.z_ppm_step,   // Corrected
        n_direct: s.n_direct,
        n_indirect: spectra_3d.length, // Corrected: number of planes
        drawto: "#visualization_proj_y",
        drawto_contour: "canvas_proj_y",
        drawto_infor: "infor_proj_y",
        size: [cr.width, cr.height]
    };
    main_plot_proj_y = new plotit(input_proj);
    main_plot_proj_y.draw();

    // Disable interactive behaviors
    main_plot_proj_y.cross_line_pause_flag = false;
    if (typeof main_plot_proj_y.allow_right_click === 'function') {
        main_plot_proj_y.allow_right_click(false);
    }

    update_all_plot_axis_labels();
}

/**
 * Handles projection Y response.
 *
 * @param {any} data - Data
 * @param {any} type - Type
 */
function handle_proj_y_response(data, type) {
    let spec = (type === "proj_y") ? spectrum_proj_y : theoretical_spectrum_proj_y;
    if (!spec) return;

    if (data.contour_sign === 0) spec.cached_contour_pos = data;
    else spec.cached_contour_neg = data;

    refresh_proj_y_plot();
}

/**
 * Refreshes projection Y plot.
 */
function refresh_proj_y_plot() {
    if (!main_plot_proj_y || !spectrum_proj_y) return;

    let spectra_list = [spectrum_proj_y];
    if (theoretical_spectrum_proj_y) spectra_list.push(theoretical_spectrum_proj_y);

    render_to_plot(main_plot_proj_y, spectra_list);
}

/**
 * Estimates projection Y noise.
 */
function estimate_proj_y_noise() {
    if (!spectrum_proj_y) return;
    let raw = spectrum_proj_y.raw_data;
    let nx = spectrum_proj_y.n_direct;
    let nz = spectrum_proj_y.n_indirect;

    spectrum_proj_y.noise_level = mathTool.estimate_noise_level(nx, nz, raw);
    adjust_proj_noise(spectrum_proj_y, "proj_y_noise_level_display");

    update_proj_y_contour_levels();
}

/**
 * Updates projection Y contour levels.
 */
function update_proj_y_contour_levels() {
    if (!spectrum_proj_y) return;

    let multiplier = parseFloat(document.getElementById("proj_y_contour_start_multiplier").value) || 10.0;
    let scale = parseFloat(document.getElementById("proj_y_contour_scale_factor").value) || 1.4;

    spectrum_proj_y.spectrum_color = "#0000ff";
    spectrum_proj_y.spectrum_color_negative = "#0000ff";
    spectrum_proj_y.levels = calculate_levels(spectrum_proj_y.noise_level, scale, 30, multiplier, scale);
    spectrum_proj_y.negative_levels = calculate_negative_levels(spectrum_proj_y.noise_level, scale, 30, multiplier, scale);
    spectrum_proj_y.cached_contour_pos = null;
    spectrum_proj_y.cached_contour_neg = null;

    request_contour_calculation(spectrum_proj_y, 0, 0, "proj_y");
    request_contour_calculation(spectrum_proj_y, 0, 1, "proj_y");

    if (theoretical_spectrum_proj_y) {
        theoretical_spectrum_proj_y.spectrum_color = "#ff0000";
        theoretical_spectrum_proj_y.spectrum_color_negative = "#ff0000";
        theoretical_spectrum_proj_y.levels = spectrum_proj_y.levels;
        theoretical_spectrum_proj_y.negative_levels = spectrum_proj_y.negative_levels;
        theoretical_spectrum_proj_y.cached_contour_pos = null;
        theoretical_spectrum_proj_y.cached_contour_neg = null;
        request_contour_calculation(theoretical_spectrum_proj_y, 0, 0, "proj_y_theo");
        request_contour_calculation(theoretical_spectrum_proj_y, 0, 1, "proj_y_theo");
    }
}

/**
 * Resets projection Y zoom.
 */
function reset_proj_y_zoom() {
    if (!main_plot_proj_y || !spectrum_proj_y) return;
    let s = spectrum_proj_y;
    let x_dom = [s.x_ppm_start, s.x_ppm_start + s.x_ppm_step * s.n_direct];
    let y_dom = [s.y_ppm_start, s.y_ppm_start + s.y_ppm_step * s.n_indirect];
    main_plot_proj_y.resetzoom(x_dom, y_dom);
}

/**
 * X-Projection (Collapse Direct) Plot Logic
 */
function init_proj_x_plot(s) {
    if (!s) return;

    let parent = document.getElementById("vis_parent_proj_x");
    if (!parent) return;
    let cr = parent.getBoundingClientRect();

    let plot_font_size = 24;
    let plot_margin_left = 30 + plot_font_size * 5;
    let plot_margin_bottom = 30 + plot_font_size * 3;
    let plot_margin_top = 30;
    let plot_margin_right = 30;

    let margins = {
        left: plot_margin_left,
        top: plot_margin_top,
        right: plot_margin_right,
        bottom: plot_margin_bottom
    };

    let plot_width = Math.max(0, cr.width - plot_margin_left - plot_margin_right);
    let plot_height = Math.max(0, cr.height - plot_margin_top - plot_margin_bottom);

    let cvs = document.getElementById("canvas_proj_x");
    let svg = document.getElementById("visualization_proj_x");

    if (cvs) {
        cvs.style.position = "absolute";
        cvs.style.left = plot_margin_left + "px";
        cvs.style.top = plot_margin_top + "px";
        cvs.setAttribute("width", plot_width);
        cvs.setAttribute("height", plot_height);
    }

    if (svg) { svg.setAttribute("width", cr.width); svg.setAttribute("height", cr.height); }

    let input_proj = {
        WIDTH: cr.width,
        HEIGHT: cr.height,
        MARGINS: margins,
        fontsize: plot_font_size,
        x_ppm_start: s.y_ppm_start,
        x_ppm_step: s.y_ppm_step,
        y_ppm_start: s.z_ppm_start,
        y_ppm_step: s.z_ppm_step,
        n_direct: s.n_indirect, // In X-proj, Indirect 1 is direct
        n_indirect: spectra_3d.length, // Indirect 2 is indirect
        drawto: "#visualization_proj_x",
        drawto_contour: "canvas_proj_x",
        drawto_infor: "infor_proj_x",
        size: [cr.width, cr.height]
    };
    main_plot_proj_x = new plotit(input_proj);
    main_plot_proj_x.draw();

    // Disable interactive behaviors
    main_plot_proj_x.cross_line_pause_flag = false;
    if (typeof main_plot_proj_x.allow_right_click === 'function') {
        main_plot_proj_x.allow_right_click(false);
    }

    update_all_plot_axis_labels();
}

/**
 * Handles projection X response.
 *
 * @param {any} data - Data
 * @param {any} type - Type
 */
function handle_proj_x_response(data, type) {
    let spec = (type === "proj_x") ? spectrum_proj_x : theoretical_spectrum_proj_x;
    if (!spec) return;

    if (data.contour_sign === 0) spec.cached_contour_pos = data;
    else spec.cached_contour_neg = data;

    refresh_proj_x_plot();
}

/**
 * Refreshes projection X plot.
 */
function refresh_proj_x_plot() {
    if (!main_plot_proj_x || !spectrum_proj_x) return;

    let spectra_list = [spectrum_proj_x];
    if (theoretical_spectrum_proj_x) spectra_list.push(theoretical_spectrum_proj_x);

    render_to_plot(main_plot_proj_x, spectra_list);
}

/**
 * Estimates projection X noise.
 */
function estimate_proj_x_noise() {
    if (!spectrum_proj_x) return;
    let raw = spectrum_proj_x.raw_data;
    let nx = spectrum_proj_x.n_direct;
    let ny = spectrum_proj_x.n_indirect;

    spectrum_proj_x.noise_level = mathTool.estimate_noise_level(nx, ny, raw);
    adjust_proj_noise(spectrum_proj_x, "proj_x_noise_level_display");

    update_proj_x_contour_levels();
}

/**
 * Updates projection X contour levels.
 */
function update_proj_x_contour_levels() {
    if (!spectrum_proj_x) return;

    let multiplier = parseFloat(document.getElementById("proj_x_contour_start_multiplier").value) || 10.0;
    let scale = parseFloat(document.getElementById("proj_x_contour_scale_factor").value) || 1.4;

    spectrum_proj_x.spectrum_color = "#0000ff";
    spectrum_proj_x.spectrum_color_negative = "#0000ff";
    spectrum_proj_x.levels = calculate_levels(spectrum_proj_x.noise_level, scale, 30, multiplier, scale);
    spectrum_proj_x.negative_levels = calculate_negative_levels(spectrum_proj_x.noise_level, scale, 30, multiplier, scale);
    spectrum_proj_x.cached_contour_pos = null;
    spectrum_proj_x.cached_contour_neg = null;

    request_contour_calculation(spectrum_proj_x, 0, 0, "proj_x");
    request_contour_calculation(spectrum_proj_x, 0, 1, "proj_x");

    if (theoretical_spectrum_proj_x) {
        theoretical_spectrum_proj_x.spectrum_color = "#ff0000";
        theoretical_spectrum_proj_x.spectrum_color_negative = "#ff0000";
        theoretical_spectrum_proj_x.levels = spectrum_proj_x.levels;
        theoretical_spectrum_proj_x.negative_levels = spectrum_proj_x.negative_levels;
        theoretical_spectrum_proj_x.cached_contour_pos = null;
        theoretical_spectrum_proj_x.cached_contour_neg = null;
        request_contour_calculation(theoretical_spectrum_proj_x, 0, 0, "proj_x_theo");
        request_contour_calculation(theoretical_spectrum_proj_x, 0, 1, "proj_x_theo");
    }
}

/**
 * Resets projection X zoom.
 */
function reset_proj_x_zoom() {
    if (!main_plot_proj_x || !spectrum_proj_x) return;
    let s = spectrum_proj_x;
    let x_dom = [s.x_ppm_start, s.x_ppm_start + s.x_ppm_step * s.n_direct];
    let y_dom = [s.y_ppm_start, s.y_ppm_start + s.y_ppm_step * s.n_indirect];
    main_plot_proj_x.resetzoom(x_dom, y_dom);
}

/**
 * Synchronizes from projection X plot.
 *
 * @param {boolean} [is_end] - Is end Default is true.
 */
function sync_from_proj_x_plot(is_end = true) {
    update_1d_traces_from_center();
    update_3d_crosshairs();
}

/**
 * Synchronizes from projection plot.
 *
 * @param {boolean} [is_end] - Is end Default is true.
 */
function sync_from_proj_plot(is_end = true) {
    update_1d_traces_from_center();
    update_3d_crosshairs();
}

/**
 * Synchronizes from projection Y plot.
 *
 * @param {boolean} [is_end] - Is end Default is true.
 */
function sync_from_proj_y_plot(is_end = true) {
    update_1d_traces_from_center();
    update_3d_crosshairs();
}

/**
 * Global synchronization function called by plotit instances
 * @param {object} plot_instance The plot instance that triggered the sync
 * @param {boolean} is_end True if the interaction (drag/zoom) has ended
 */
function sync_3d_views(plot_instance, is_end) {
    if (plot_instance === main_plot_proj) {
        sync_from_proj_plot(is_end);
    } else if (plot_instance === main_plot_proj_y) {
        sync_from_proj_y_plot(is_end);
    } else if (plot_instance === main_plot_proj_x) {
        sync_from_proj_x_plot(is_end);
    } else if (plot_instance === main_plot) {
        sync_sliders_to_center(is_end);
    } else if (plot_instance === main_plot_xz) {
        sync_from_xz_plot(is_end);
    } else if (plot_instance === main_plot_yz) {
        sync_from_yz_plot(is_end);
    }
}
/**
 * Applies trace phase.
 */
function apply_trace_phase() {
    if (!spectra_3d || spectra_3d.length === 0) return;
    if (!spectra_3d.every(s => s.raw_data_ri && s.raw_data_ri.length > 0)) {
        alert("RI data not available for all slices. Phase correction cannot be applied.");
        return;
    }

    let p0_rad = trace_x_ph0 * Math.PI / 180.0;
    let p1_rad = trace_x_ph1 * Math.PI / 180.0;
    let s0 = spectra_3d[0];
    let nx = s0.n_direct;
    let pivot_idx = trace_x_pivot !== null ? Math.round((trace_x_pivot - s0.x_ppm_start) / s0.x_ppm_step) : 0;

    console.log("Applying phase correction to 3D dataset...");
    for (let z = 0; z < spectra_3d.length; z++) {
        let slice = spectra_3d[z];
        let re_data = slice.raw_data;
        let im_data = slice.raw_data_ri;
        for (let i = 0; i < re_data.length; i++) {
            let x = i % nx;
            let phase_rad;
            if (trace_x_pivot === null) {
                phase_rad = p0_rad;
            } else {
                phase_rad = p0_rad + p1_rad * (x - pivot_idx) / nx;
            }
            let re = re_data[i];
            let im = im_data[i];
            re_data[i] = re * Math.cos(phase_rad) - im * Math.sin(phase_rad);
            im_data[i] = re * Math.sin(phase_rad) + im * Math.cos(phase_rad);
        }
    }

    // Reset phase parameters
    trace_x_ph0 = 0.0;
    trace_x_ph1 = 0.0;
    trace_x_pivot = null;

    // Update UI labels
    let IDs = ['trace_x_ph0_val', 'trace_proj_x_ph0_val', 'trace_proj_y_x_ph0_val', 'trace_x_ph1_val', 'trace_proj_x_ph1_val', 'trace_proj_y_x_ph1_val'];
    IDs.forEach(id => {
        let el = document.getElementById(id);
        if (el) el.innerText = "0.0";
    });
    let pivotIDs = ['trace_x_pivot_val', 'trace_proj_x_pivot_val', 'trace_proj_y_x_pivot_val'];
    pivotIDs.forEach(id => {
        let el = document.getElementById(id);
        if (el) el.innerText = "not set";
    });

    // Recalculate everything
    generate_projection_spectrum();

    // Recalculate 2D contours for all slices
    for (let z = 0; z < spectra_3d.length; z++) {
        spectra_3d[z].cached_contour_pos = null;
        spectra_3d[z].cached_contour_neg = null;
    }

    // Refresh current views
    if (main_plot) draw_slice(current_slice_index);
    if (main_plot_xz) refresh_xz_view();
    if (main_plot_yz) refresh_yz_view();

    // Update 3D visualization if it's active
    if (current_volume_data) {
        visualize_3d();
    }

    update_1d_traces_from_center();
    console.log("Phase correction applied.");
}
