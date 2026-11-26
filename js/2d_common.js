(function (global) {
    const WEBASSEMBLY_JOB_KEY = "#sym:webassembly_job ";
    const state = {
        my_contour_worker: null,
        webassembly_worker: null,
        webassembly_worker2: null,
        wasm_2d_runner: null,
        worker_initialization_error: null,
        mathTool: new ldwmath(),
        plot_margin_top: 20,
        plot_margin_bottom: 100,
        plot_margin_left: 150,
        plot_margin_right: 20,
        plot_font_size: 24,
        plot_padding: 20,
        main_plot: null,
        b_plot_initialized: false,
        tfjs_2d_normal_model: null,
        tooldiv: undefined,
        current_spectrum_index_of_peaks: -1,
        current_flag_of_peaks: "picked",
        total_number_of_experimental_spectra: 0,
        pseudo3d_fitted_peaks_object: null,
        pseudo3d_fitted_peaks_error: [],
        pending_pseudo3d_uncalculated_spectra: [],
        last_calculated_spectrum_index: -1,
        baseline_correction_batch_total: 0,
        baseline_correction_batch_completed: 0,
        cest_multi_peak_indices: [],
        cest_filter_multi_peaks_only: false,
        fid_process_parameters: undefined,
        has_processed_fid: false,
        current_reprocess_spectrum_index: -1,
        nuslist_as_string: "",
        current_process_fid_files_fn: undefined,
        color_map_list: ["HEIGHT"],
        color_map_limit: [[0, 1]],
        inter_window_channel: undefined,
        ft2_file_drop_processor: undefined,
        fid_drop_process: undefined,
        oOutput: undefined,
        current_phase_correction: [0, 0, 0, 0],
        hsqc_spectra: [],
        color_list: [
            [0, 0, 1, 1.0],
            [1, 0, 0, 1.0],
            [0, 1, 0, 1.0],
            [1, 1, 0, 1.0],
            [0, 1, 1, 1.0],
            [1, 0, 1, 1.0],
            [0, 0, 0, 1.0],
            [0.5, 0.5, 0.5, 1.0],
            [1, 0.5, 0.5, 1.0],
            [0.5, 1, 0.5, 1.0],
            [0.5, 0.5, 1, 1.0],
            [1, 0.5, 1, 1.0],
            [1, 1, 0.5, 1.0],
            [0.5, 1, 1, 1.0],
            [0.5, 0.5, 0.5, 1.0]
        ]
    };

    for (const [name, value] of Object.entries(state)) {
        Object.defineProperty(global, name, {
            configurable: false,
            enumerable: true,
            get: () => state[name],
            set: nextValue => { state[name] = nextValue; }
        });
    }

    function getWebAssemblyJobFlag(data) {
        if (!data) return undefined;
        return data[WEBASSEMBLY_JOB_KEY] || data.webassembly_job;
    }

    try {
        state.my_contour_worker = new Worker("js/shared/contour_worker_2d.js");
        state.wasm_2d_runner = new EphemeralWasmRunner({
            label: "webdp1d_cpp",
            workerUrl: "./js/webass_2d.js",
            wasmUrl: "./js/webdp1d_cpp.wasm",
            maxConcurrent: 1,
            isIntermediate: data => !!data && (
                typeof data.stdout !== "undefined"
                || getWebAssemblyJobFlag(data) === "pseudo3d_progress"
            )
        });
        state.webassembly_worker = state.wasm_2d_runner.createWorkerFacade();
        state.wasm_2d_runner.preload();
    } catch (error) {
        state.worker_initialization_error = error;
        console.error("Failed to initialize 2D processing workers.", error);
    }

    async function runTfjsPhaseCorrection(ft2ArrayBuffer, numRounds) {
        const pipeline = global.NUS2DPhasePipeline;
        const tf = global.tf;
        if (!pipeline || !tf) {
            throw new Error("TensorFlow.js or NUS2DPhasePipeline not loaded.");
        }

        const modelUrl = "js/model17_tfjs/model.json";
        if (!state.tfjs_2d_normal_model) {
            state.tfjs_2d_normal_model = await pipeline.loadModel(tf, modelUrl);
        }

        const result = await pipeline.runFromFt2({
            tf,
            ft2ArrayBuffer,
            model: state.tfjs_2d_normal_model,
            modelUrl,
            numRounds
        });
        const phases = result.final_wls_phase_left_right
            ? result.final_wls_phase_left_right[0]
            : null;
        const valid = !!phases && Number.isFinite(phases[0]) && Number.isFinite(phases[1]);
        if (!valid) {
            return { result, p0: 0, p1: 0, valid: false };
        }
        return { result, p0: phases[0], p1: phases[1] - phases[0], valid: true };
    }

    global.Colmar2D = Object.freeze({
        state,
        WEBASSEMBLY_JOB_KEY,
        getWebAssemblyJobFlag,
        runTfjsPhaseCorrection
    });
})(window);