/**
 * NMR 1D Phase Correction Algorithms (Shared Module)
 * Supports ANN/CNN prediction models via TensorFlow.js and in-browser manual phase rotation.
 */
function permanently_apply_phase_correction() {
    if (main_plot === null) return;
    return_data = main_plot.permanently_apply_phase_correction();
    if (typeof return_data === "undefined" || return_data === null) return; //user didn't run phase correction
    let ndx = return_data.index;
    abandon_baseline_correction(ndx);//need to run before changing current spectrum

    if (typeof all_spectra[ndx].fid_process_parameters !== "undefined" && all_spectra[ndx].fid_process_parameters !== null) {
        /**
         * Also need to update fid_process_parameters.phase_correction_direct_p0 and phase_correction_direct_p1
         * return_data.phase0 and phase1 are in radians, need to convert to degrees
         */
        all_spectra[ndx].fid_process_parameters.phase_correction_direct_p0 += return_data.phase0 * 180 / Math.PI;
        all_spectra[ndx].fid_process_parameters.phase_correction_direct_p1 += (return_data.phase1 - return_data.phase0) * 180 / Math.PI;
    }

    /**
     * main_plot only change data within itself. 
     * We need to update all_spectra[main_plot.current_spectrum_index].raw_data and raw_data_i as well.
     * See apply_phase_correction in myplot_1d.js for details
     */
    let new_raw_data = new Float32Array(all_spectra[ndx].raw_data.length);
    let new_raw_data_i = new Float32Array(all_spectra[ndx].raw_data_i.length);
    let phase_correction = new Float32Array(all_spectra[ndx].raw_data.length);

    for (var i = 0; i < all_spectra[ndx].raw_data.length; i++) {
        phase_correction[i] = return_data.phase0 + (return_data.phase1 - return_data.phase0) * i / all_spectra[ndx].raw_data.length;
    }

    for (let m = 0; m < all_spectra[ndx].raw_data.length; m++) {
        new_raw_data[m] = all_spectra[ndx].raw_data[m] * Math.cos(phase_correction[m]) + all_spectra[ndx].raw_data_i[m] * Math.sin(phase_correction[m]);
        new_raw_data_i[m] = -all_spectra[ndx].raw_data[m] * Math.sin(phase_correction[m]) + all_spectra[ndx].raw_data_i[m] * Math.cos(phase_correction[m]);
    }

    all_spectra[ndx].raw_data = new_raw_data;
    all_spectra[ndx].raw_data_i = new_raw_data_i;

    /**
     * Clear shown phase correction in the main page.
     */
    document.getElementById("pc_left_end").textContent = "0.0";
    document.getElementById("pc_right_end").textContent = "0.0";
    const p1_el = document.getElementById("pc_p1");
    if (p1_el) p1_el.textContent = "0.0";
    document.getElementById("pivot").textContent = "not set";

    /**
     * If this spectrum is from fid, we need to update fid_process_parameters.phase_correction_direct_p0 and p1
     */
    if (all_spectra[ndx].spectrum_origin === -2 && typeof all_spectra[ndx].fid_process_parameters !== "undefined" && all_spectra[ndx].fid_process_parameters !== null) {
        all_spectra[ndx].fid_process_parameters.phase_correction_direct_p0 += return_data.phase0;
        all_spectra[ndx].fid_process_parameters.phase_correction_direct_p1 += (return_data.phase1 - return_data.phase0);
        /**
         * If we are in reprocessing mode,
         * Update input field phase_correction_direct_p0 and p1 to the new values
         */
        if (current_reprocess_spectrum_index === ndx) {
            document.getElementById("phase_correction_direct_p0").value = all_spectra[ndx].fid_process_parameters.phase_correction_direct_p0.toFixed(2);
            document.getElementById("phase_correction_direct_p1").value = all_spectra[ndx].fid_process_parameters.phase_correction_direct_p1.toFixed(2);
        }
    }
}


function get_data_from_phase_correction(ndx, phase_correction_left, phase_correction_right) {
    /**
     * If input size is > 131072, we need to down sample to 131072
     */
    let max_number_of_points = 65536 * 2;
    let resampled_data_r;
    let resampled_data_i;
    if (all_spectra[ndx].raw_data.length > max_number_of_points) {
        resampled_data_r = new Float32Array(max_number_of_points);
        resampled_data_i = new Float32Array(max_number_of_points);
        for (let i = 0; i < max_number_of_points; i++) {
            resampled_data_r[i] = all_spectra[ndx].raw_data[i * Math.floor(all_spectra[ndx].raw_data.length / max_number_of_points)];
            resampled_data_i[i] = all_spectra[ndx].raw_data_i[i * Math.floor(all_spectra[ndx].raw_data.length / max_number_of_points)];
        }
    }
    else {
        resampled_data_r = all_spectra[ndx].raw_data;
        resampled_data_i = all_spectra[ndx].raw_data_i;
    }

    let data = new Float32Array(resampled_data_r.length);
    let phase_correction = new Float32Array(resampled_data_r.length);

    for (var i = 0; i < resampled_data_r.length; i++) {
        phase_correction[i] = phase_correction_left + (phase_correction_right - phase_correction_left) * i / resampled_data_r.length;
        phase_correction[i] = phase_correction[i] * Math.PI / 180;
    }

    for (let m = 0; m < resampled_data_r.length; m++) {
        data[m] = resampled_data_r[m] * Math.cos(phase_correction[m]) + resampled_data_i[m] * Math.sin(phase_correction[m]);
    }
    return data;
}

/**
 * ONCLICK event for auto phase correction button
 * @returns: none
 */
async function run_auto_pc() {

    abandon_baseline_correction(main_plot.current_spectrum_index);//need to run before changing current spectrum
    if (main_plot.current_spectrum_index < 0 || main_plot.current_spectrum_index >= all_spectra.length) {
        alert("No spectrum selected for phase correction.");
        return;
    }
    /**
     * If current spectrum is not complex, alert user and return
     */
    if (typeof all_spectra[main_plot.current_spectrum_index].raw_data_i === "undefined"
        || all_spectra[main_plot.current_spectrum_index].raw_data_i === null
        || all_spectra[main_plot.current_spectrum_index].raw_data_i.length !== all_spectra[main_plot.current_spectrum_index].raw_data.length) {
        alert("Current spectrum is not complex or imaginary part is invalid (which will happen after baseline correction).");
        return;
    }
    /**
     * Run ANN phase correction
     */
    run_ann_phase_correction(main_plot.current_spectrum_index);
}


/**
 * Walk on 2D surface (phase correction at left end and right end) to get a line
 * on which the predicted probabilities of being "good without p0 error" is the highest
 * if no such data point, get the cross point from negative to positive phase error.
 * @param {*} ndx 
 */
async function run_ann_phase_correction_p0_only(ndx) {
    if (all_spectra[ndx].raw_data.length < 32768) {
        alert("Data length is too short for phase correction using ANN model. Performance may be affected. Minimum length is 32768 points.");
    }

    disable_enable_phase_baseline_buttons(false);

    let oOutput = document.getElementById("infor");
    oOutput.innerHTML = "Running automatic phase correction (P0 only for benchtop) using ANN model. Please wait...";

    if (typeof document.getElementById("log") !== "undefined" && document.getElementById("log") !== null) {
        document.getElementById("log").value += "Starting automatic P0 phase correction (benchtop)...\n";
        document.getElementById("log").scrollTop = document.getElementById("log").scrollHeight;
    }

    let result = await get_best_location_diagonal(ndx, 0, 0);

    console.log("Final P0 phase correction (benchtop): left end = " + result[0] + ", right end = " + result[1]);
    if (typeof document.getElementById("log") !== "undefined" && document.getElementById("log") !== null) {
        document.getElementById("log").value += "Final P0 phase correction: left end = " + result[0] + ", right end = " + result[1] + "\n";
        document.getElementById("log").scrollTop = document.getElementById("log").scrollHeight;
    }

    let phase_array = new Float32Array(all_spectra[ndx].raw_data.length);
    for (var i = 0; i < all_spectra[ndx].raw_data.length; i++) {
        phase_array[i] = result[0] + (result[1] - result[0]) * i / all_spectra[ndx].raw_data.length;
        phase_array[i] = phase_array[i] * Math.PI / 180;
    }
    for (let m = 0; m < all_spectra[ndx].raw_data.length; m++) {
        all_spectra[ndx].raw_data[m] = all_spectra[ndx].raw_data[m] * Math.cos(phase_array[m]) + all_spectra[ndx].raw_data_i[m] * Math.sin(phase_array[m]);
        all_spectra[ndx].raw_data_i[m] = -all_spectra[ndx].raw_data[m] * Math.sin(phase_array[m]) + all_spectra[ndx].raw_data_i[m] * Math.cos(phase_array[m]);
    }

    let return_data = {
        "phase0": result[0] * Math.PI / 180,
        "phase1": result[1] * Math.PI / 180,
    };

    oOutput.innerHTML = "Done auto phase correction. Applying phase correction on the server, please wait...";

    let csrfName = document.getElementsByName("csrf_test_name")[0].name;
    let csrfHash = document.getElementsByName("csrf_test_name")[0].value;

    $.ajax({
        url: baseUrl + "/index.php/" + server_name + "/apply_phase_correction",
        type: "post",
        dataType: "text",
        data: { "phase_correction_at_min_ppm": return_data.phase0, "phase_correction_at_max_ppm": return_data.phase1, "user_job_id": user_job_id, [csrfName]: csrfHash },
        error: function (res) {
            oOutput.innerHTML = "";
            oOutput.appendChild(process_error(res.responseText, res.status));
        },
        success: function () {
            enable_disable_buttons('ENABLE_BASELINE');
            enable_disable_buttons('ENABLE_DECONVOLUTION');
            oOutput.innerHTML = "Phase correction applied successfully on the server";
            main_plot.current_spectrum_index = 0;
            document.getElementById("pc_left_end").textContent = "0";
            document.getElementById("pc_right_end").textContent = "0";
            let p1Elem2 = document.getElementById("pc_p1");
            if (p1Elem2) p1Elem2.textContent = "0";
            document.getElementById("pivot").textContent = "not set";
            disable_enable_phase_baseline_buttons(true);
        }
    });
}

function get_current_b0(ndx) {
    let val = 0;
    if (typeof b0 !== "undefined" && b0 !== null && !isNaN(b0) && Number(b0) > 0) {
        val = Number(b0);
    }
    if (val === 0 && all_spectra && all_spectra[ndx]) {
        if (all_spectra[ndx].b0 && Number(all_spectra[ndx].b0) > 0) {
            val = Number(all_spectra[ndx].b0);
        } else if (all_spectra[ndx].fid_information && Number(all_spectra[ndx].fid_information.observed_frequency) > 0) {
            val = Number(all_spectra[ndx].fid_information.observed_frequency);
        }
    }
    return val;
}

/**
 * Walk on 2D surface (phase correction at left end and right end) to get a line
 * on which the predicted probabilities of being "good without p0 error" is the highest
 * if no such data point, get the cross point from negative to positive phase error.
 * @param {*} ndx 
 */

async function run_ann_phase_correction(ndx) {
    const original_console_log = console.log;
    const log_div = document.getElementById("log");

    // Redirect console.log to the log div during processing
    console.log = function (...args) {
        original_console_log.apply(console, args);
        if (log_div) {
            log_div.value += args.map(arg => typeof arg === 'object' ? JSON.stringify(arg) : arg).join(' ') + "\n";
            log_div.scrollTop = log_div.scrollHeight;
        }
    };

    try {
        if (all_spectra[ndx].raw_data.length < 32768) {
            alert("Data length is too short for phase correction using ANN model. Performance may be affected. Minimum length is 32768 points.");
        }
        const wasmMsgStart = document.getElementById("webassembly_message"); if (wasmMsgStart) wasmMsgStart.innerText = "Running Automatic Phase Correction...";
        /**
         * Disable manual phase correction and myself button during auto phase correction
         */
        disable_enable_phase_baseline_buttons(false);

        console.log("Starting automatic phase correction using ANN model...");

        let result = await get_best_location_diagonal(ndx, 0, 0);

        let current_phase_left = result[0];
        let current_phase_right = result[1];

        let data = get_data_from_phase_correction(ndx, current_phase_left, current_phase_right);

        /**
         * Now run p1 prediction on the new data to make sure we are at the maximum
         */
        const prediction_all = await runPrediction(data, data.length, 1 /** flag=1 means p1 prediction */);
        let prediction = prediction_all[0];

        /**
         * If prediction[1] is the maximum, we are almost done, but still need to do a small grid search to find maximum
        */
        if (prediction[1] > prediction[0] && prediction[1] > prediction[2]) {
            result = await get_maximum_pre1_location_p1(ndx, current_phase_left, current_phase_right, prediction[1]);
        }
        else {
            /**
             * If prediction[0] is the maximum, need to add positive phase correction to reach a point where prediction[2] is the maximum
             * then we can run section search to find the cross point from negative to positive phase error
             * If prediction[2] is the maximum, need to add negative phase correction to reach a point where prediction[0] is the maximum
             * then we can run section search to find the cross point from negative to positive phase error
             */
            let b_cross = false;
            let advance_direction_left = 1;
            let advance_direction_right = -1;
            let current_additional_phase = prediction[0] < prediction[2] ? 5.0 : -5.0;
            while (!b_cross) {
                // Perform a small phase correction along anti-diagonal direction
                let current_additional_phase_left = current_additional_phase * advance_direction_left
                let current_additional_phase_right = current_additional_phase * advance_direction_right;
                let phase_correction_left = current_phase_left + current_additional_phase_left;
                let phase_correction_right = current_phase_right + current_additional_phase_right;

                // move phase correction along diagonal line to reach optimal point
                let p0_result = await get_best_location_diagonal(ndx, phase_correction_left, phase_correction_right);
                phase_correction_left = p0_result[0];
                phase_correction_right = p0_result[1];
                /**
                 * Also use current data to update advance_direction_left and advance_direction_right
                 */
                advance_direction_left = (phase_correction_left - current_phase_left) / current_additional_phase;
                advance_direction_right = (phase_correction_right - current_phase_right) / current_additional_phase;

                let data = get_data_from_phase_correction(ndx, phase_correction_left, phase_correction_right);

                const new_prediction_all = await runPrediction(data, data.length, 1 /** flag=1 means p1 prediction */);
                let new_prediction = new_prediction_all[0];

                console.log("Current phase correction: left end = " + phase_correction_left + ", right end = " + phase_correction_right);
                console.log("Current P1 prediction: " + new_prediction);

                if (new_prediction[1] > new_prediction[0] && new_prediction[1] > new_prediction[2]) {
                    b_cross = true;
                    result = await get_maximum_pre1_location_p1(ndx, phase_correction_left, phase_correction_right, new_prediction[1]);
                }
                //check if we cross the boundary, no need to advance further
                else if (prediction[0] > prediction[2] && new_prediction[2] > new_prediction[0]) {
                    b_cross = true;
                    result = await get_cross_point_p1(ndx, phase_correction_left - current_additional_phase_left, phase_correction_right - current_additional_phase_right, current_additional_phase_left, current_additional_phase_right);

                }
                else if (prediction[2] > prediction[0] && new_prediction[0] > new_prediction[2]) {
                    b_cross = true;
                    result = await get_cross_point_p1(ndx, phase_correction_left, phase_correction_right, -current_additional_phase_left, -current_additional_phase_right);

                }
                /**
                 * We haven't crossed yet, continue
                 */
                prediction = new_prediction;
                current_phase_left = phase_correction_left;
                current_phase_right = phase_correction_right;
            }
        }

        console.log("Final phase correction: left end = " + result[0] + ", right end = " + result[1]);

        /**
         * result is the best location (phase correction at left end and right end)
         * Apply the phase correction to raw_data and raw_data_i
         */
        let phase_array = new Float32Array(all_spectra[ndx].raw_data.length);
        for (var i = 0; i < all_spectra[ndx].raw_data.length; i++) {
            phase_array[i] = result[0] + (result[1] - result[0]) * i / all_spectra[ndx].raw_data.length;
            phase_array[i] = phase_array[i] * Math.PI / 180;
        }
        for (let m = 0; m < all_spectra[ndx].raw_data.length; m++) {
            all_spectra[ndx].raw_data[m] = all_spectra[ndx].raw_data[m] * Math.cos(phase_array[m]) + all_spectra[ndx].raw_data_i[m] * Math.sin(phase_array[m]);
            all_spectra[ndx].raw_data_i[m] = -all_spectra[ndx].raw_data[m] * Math.sin(phase_array[m]) + all_spectra[ndx].raw_data_i[m] * Math.cos(phase_array[m]);
        }

        /**
         * If this spectrum is from fid, we need to update fid_process_parameters.phase_correction_direct_p0 and p1
         */
        if (all_spectra[ndx].spectrum_origin === -2 && typeof all_spectra[ndx].fid_process_parameters !== "undefined" && all_spectra[ndx].fid_process_parameters !== null) {
            all_spectra[ndx].fid_process_parameters.phase_correction_direct_p0 += result[0];
            all_spectra[ndx].fid_process_parameters.phase_correction_direct_p1 += (result[1] - result[0]);
            /**
             * If we are in reprocessing mode,
             * Update input field phase_correction_direct_p0 and p1 to the new valu
             */
            if (current_reprocess_spectrum_index === ndx) {
                document.getElementById("phase_correction_direct_p0").value = all_spectra[ndx].fid_process_parameters.phase_correction_direct_p0.toFixed(2);
                document.getElementById("phase_correction_direct_p1").value = all_spectra[ndx].fid_process_parameters.phase_correction_direct_p1.toFixed(2);
            }
        }

        /**
         * Need to update the plot as well
         */
        if (main_plot !== null) {
            /**
             * When ndx is already in the plot, function add_data will update the data, instead of adding a new spectrum, and ignore the color parameter
             */
            let data = [];
            if (all_spectra[ndx].raw_data_i.length === all_spectra[ndx].raw_data.length) {
                for (let i = 0; i < all_spectra[ndx].n_direct; i++) {
                    data.push([all_spectra[ndx].x_ppm_start + all_spectra[ndx].x_ppm_step * i, all_spectra[ndx].raw_data[i], all_spectra[ndx].raw_data_i[i]]);
                }
            }
            else {
                for (let i = 0; i < all_spectra[ndx].n_direct; i++) {
                    data.push([all_spectra[ndx].x_ppm_start + all_spectra[ndx].x_ppm_step * i, all_spectra[ndx].raw_data[i]]);
                }
            }
            main_plot.add_data(data, ndx);
        }
        /**
         * Enable manual phase correction and myself button after auto phase correction
         */
        disable_enable_phase_baseline_buttons(true);

        // Notify completion of TFJS phase correction
        // Dispatch on the button so the tutorial listener which is attached to the button can catch it
        const btn = document.getElementById("button_fid_process");
        if (btn) {
            btn.dispatchEvent(new Event('colmar:processing_finished', { bubbles: true }));
        }
    } finally {
        console.log = original_console_log;
        const wasmMsgEnd = document.getElementById("webassembly_message"); if (wasmMsgEnd) wasmMsgEnd.innerText = "";
    }
}

/**
 * Run section search to find the maximum point near current phase correction.
 * IMPORTANT: this is a recursive function
 * @param {*} ndx: index of the spectrum in all_spectra to be corrected
 * @param {*} current_phase_left: current additional phase correction at left end (on top of current data in all_spectra[ndx])
 * @param {*} current_phase_right: current additional phase correction at right end (on top of current data in all_spectra[ndx])
 * @param {*} initial_additional_phase_left: initial additional phase correction to be applied at left end
 * @param {*} initial_additional_phase_right: initial additional phase correction to be applied at right end
 * @returns: best location (additional phase correction at left and right, same value)
 */
async function get_cross_point_p1(ndx, current_phase_left, current_phase_right, initial_additional_phase_left, initial_additional_phase_right) {
    let mid_phase_left = current_phase_left + initial_additional_phase_left / 2.0;
    let mid_phase_right = current_phase_right + initial_additional_phase_right / 2.0;
    let tolerance = 0.1; //0.1 degree
    if (initial_additional_phase_left < tolerance && initial_additional_phase_right < tolerance) {
        return [mid_phase_left, mid_phase_right];
    }

    /**
     * Move along diagonal line until reach optimal point
     */
    let result = await get_best_location_diagonal(ndx, mid_phase_left, mid_phase_right);
    mid_phase_left = result[0];
    mid_phase_right = result[1];

    let data = get_data_from_phase_correction(ndx, mid_phase_left, mid_phase_right);

    const new_prediction_all = await runPrediction(data, data.length, 1 /** flag=1 means p1 prediction */);
    let new_prediction = new_prediction_all[0];

    console.log("in get_cross_point_p1: phase left = " + mid_phase_left + ", phase right = " + mid_phase_right);
    console.log("in get_cross_point_p1: P1 prediction = " + new_prediction);
    document.getElementById("log").value += "in get_cross_point_p1: phase left = " + mid_phase_left + ", phase right = " + mid_phase_right + "\n";
    document.getElementById("log").value += "in get_cross_point_p1: P1 prediction = " + new_prediction + "\n";
    document.getElementById("log").scrollTop = document.getElementById("log").scrollHeight;

    if (new_prediction[1] > new_prediction[0] && new_prediction[1] > new_prediction[2]) {
        //switch to method solely searching for maximum of prediction[1]
        return await get_maximum_pre1_location_p1(ndx, mid_phase_left, mid_phase_right, new_prediction[1]);
    }
    else if (new_prediction[0] > new_prediction[2]) {
        //crossed from negative to positive 
        return await get_cross_point_p1(ndx, mid_phase_left, mid_phase_right, initial_additional_phase_left / 2.0, initial_additional_phase_right / 2.0);
    }
    else {
        //crossed from positive to negative
        return await get_cross_point_p1(ndx, current_phase_left, current_phase_right, initial_additional_phase_left / 2.0, initial_additional_phase_right / 2.0);
    }
}

async function get_maximum_pre1_location_p1(ndx, current_phase_left, current_phase_right, current_prediction1) {
    const phase_step = 0.7071 / 4; //0.7071 degree step
    const phase_direction = -Math.PI / 4; //-45 degree direction

    /**
     * Test two new prediction points at current_phase_left +/- phase_step, current_phase_right +/- phase_step
     */
    let test_phase_left_1 = current_phase_left - phase_step * Math.cos(phase_direction);
    let test_phase_right_1 = current_phase_right - phase_step * Math.sin(phase_direction);
    let result_1 = await get_best_location_diagonal(ndx, test_phase_left_1, test_phase_right_1);
    let test_phase_left_2 = current_phase_left + phase_step * Math.cos(phase_direction);
    let test_phase_right_2 = current_phase_right + phase_step * Math.sin(phase_direction);
    let result_2 = await get_best_location_diagonal(ndx, test_phase_left_2, test_phase_right_2);

    let data_1 = get_data_from_phase_correction(ndx, result_1[0], result_1[1]);
    const prediction_all_1 = await runPrediction(data_1, data_1.length, 1 /** flag=1 means p1 prediction */);
    let prediction_1 = prediction_all_1[0];
    let data_2 = get_data_from_phase_correction(ndx, result_2[0], result_2[1]);
    const prediction_all_2 = await runPrediction(data_2, data_2.length, 1 /** flag=1 means p1 prediction */);
    let prediction_2 = prediction_all_2[0];

    /**
     * If current_prediction1 is the maximum, return current location
     * If prediction_1[1] is the maximum, continue search in that direction
     * If prediction_2[1] is the maximum, continue search in that direction
     */
    if (current_prediction1 > prediction_1[1] && current_prediction1 > prediction_2[1]) {
        //current location is the best
        return [current_phase_left, current_phase_right];
    }
    else if (prediction_1[1] > prediction_2[1]) {
        //search in direction of prediction_1
        return await get_maximum_pre1_location_2_p1(ndx, result_1[0], result_1[1], prediction_1[1], current_prediction1, -1);
    }
    else {
        //search in direction of prediction_2
        return await get_maximum_pre1_location_2_p1(ndx, result_2[0], result_2[1], prediction_2[1], current_prediction1, 1);
    }
}

async function get_maximum_pre1_location_2_p1(ndx, current_phase_left, current_phase_right, current_prediction1, current_prediction2, direction) {
    const phase_direction = -Math.PI / 4; //-45 degree direction
    const phase_step = 0.7071 / 4;
    let result = await get_best_location_diagonal(ndx, current_phase_left + direction * phase_step * Math.cos(phase_direction), current_phase_right + direction * phase_step * Math.sin(phase_direction));

    let data = get_data_from_phase_correction(ndx, result[0], result[1]);
    const new_prediction_all = await runPrediction(data, data.length, 1 /** flag=1 means p1 prediction */);
    let new_prediction = new_prediction_all[0];

    if (current_prediction1 > new_prediction[1]) {
        //current location is the best
        return [current_phase_left, current_phase_right];
    }
    else {
        //continue search in the same direction
        return await get_maximum_pre1_location_2_p1(ndx, result[0], result[1], new_prediction[1], current_prediction1, direction);
    }
}


/**
 * Move along the diagonal line (additional phase correction at left end and right end are the same)
 * to find a point where the predicted probability of being "good without p0 error" is the highest
 * If no such point, find the cross point from negative to positive phase error
 * @param {*} ndx: index of the spectrum in all_spectra to be corrected
 * @param {*} current_phase_left: current additional phase correction at left end (on top of current data in all_spectra[ndx])
 * @param {*} current_phase_right: current additional phase correction at right end (on top of current data in all_spectra[ndx])
 * @returns: best location (additional phase correction at left and right, same value)
 */
async function get_best_location_diagonal(ndx, current_phase_left, current_phase_right) {
    let result = [];
    /**
     * Step 1, run prediction at current phase correction
     * prediction array of size 3, from logistic regression
     * index 0: score of being "negative phase error"
     * index 1: score of being "good (no phase error)"
     * index 2: score of being "positive phase error"
     */
    let data = get_data_from_phase_correction(ndx, current_phase_left, current_phase_right);
    const prediction_all = await runPrediction(data, data.length, 0 /** flag=0 means p0 prediction */);
    let prediction = prediction_all[0];

    /**
     * If prediction[1] is the maximum, we are almost done, but still need to do a small grid search to find maximum
     */
    if (prediction[1] > prediction[0] && prediction[1] > prediction[2]) {
        result = await get_maximum_pre1_location(ndx, current_phase_left, current_phase_right, prediction[1]);
    }
    else {
        /**
         * If prediction[0] is the maximum, need to add positive phase correction to reach a point where prediction[2] is the maximum
         * then we can run section search to find the cross point from negative to positive phase error
         * If prediction[2] is the maximum, need to add negative phase correction to reach a point where prediction[0] is the maximum
         * then we can run section search to find the cross point from negative to positive phase error
         */

        let b_cross = false;
        let current_additional_phase = prediction[0] > prediction[2] ? 5.0 : -5.0; //start with 5 degrees additional phase correction
        while (!b_cross) {
            // Perform a small phase correction
            let phase_correction_left = current_phase_left + current_additional_phase;
            let phase_correction_right = current_phase_right + current_additional_phase;

            let new_raw_data = get_data_from_phase_correction(ndx, phase_correction_left, phase_correction_right);

            // Rerun prediction
            const new_prediction_all = await runPrediction(new_raw_data, new_raw_data.length, 0 /** flag=0 means p0 prediction */);
            const new_prediction = new_prediction_all[0];

            if (new_prediction[1] > new_prediction[0] && new_prediction[1] > new_prediction[2]) {
                // switch to method solely searching for maximum of prediction[1]
                b_cross = true;
                result = await get_maximum_pre1_location(ndx, phase_correction_left, phase_correction_right, new_prediction[1]);
            }
            // Check if we have crossed over
            else if (prediction[0] > prediction[2] && new_prediction[2] > new_prediction[0]) {
                // Crossed from negative to positive
                result = await get_cross_point(ndx, current_phase_left, current_phase_right, current_additional_phase);
                b_cross = true;
            }
            else if (prediction[2] > prediction[0] && new_prediction[0] > new_prediction[2]) {
                // Crossed from positive to negative, so we exchange start and end points (keep in mind current_additional_phase is negative here)
                result = await get_cross_point(ndx, current_phase_left + current_additional_phase, current_phase_right + current_additional_phase, -current_additional_phase);
                b_cross = true;
            }
            /**
             * We don't cross yet, update prediction and current phase correction
             */
            prediction = new_prediction;
            current_phase_left = phase_correction_left;
            current_phase_right = phase_correction_right;
        }
    }

    console.log("P0 predictor moved to: left end = " + result[0] + ", right end = " + result[1]);
    document.getElementById("log").value += "P0 predictor moved to: left end = " + result[0] + ", right end = " + result[1] + "\n";
    document.getElementById("log").scrollTop = document.getElementById("log").scrollHeight;

    return result;
}

/**
 * Run section search to find the cross point from negative to positive phase error (or from positive to negative phase error)
 * IMPORTANT: this is a recursive function !!
 * @param {*} ndx: index of the spectrum in all_spectra to be corrected
 * @param {*} current_phase_left:  current phase correction at left end
 * @param {*} current_phase_right: current phase correction at right end
 * @param {*} initial_additional_phase: initial additional phase (same for left and right) that defines the search range (initial_additional_phase>0)
 * @returns: cross point (additional phase correction at left and right, same value)
 */
async function get_cross_point(ndx, current_phase_left, current_phase_right, initial_additional_phase) {
    let mid_phase_left = current_phase_left + initial_additional_phase / 2.0;
    let mid_phase_right = current_phase_right + initial_additional_phase / 2.0;
    /**
     * If the search range is very small, return the current mid points
     */
    if (initial_additional_phase < 0.1) {
        return [mid_phase_left, mid_phase_right];
    }

    /**
     * Make new data at mid phase correction
     */
    let data = get_data_from_phase_correction(ndx, mid_phase_left, mid_phase_right);

    const new_prediction_all = await runPrediction(data, data.length, 0 /** flag=0 means p0 prediction */);
    const new_prediction = new_prediction_all[0];

    if (new_prediction[1] > new_prediction[0] && new_prediction[1] > new_prediction[2]) {
        // switch to method solely searching for maximum of prediction[1]
        return await get_maximum_pre1_location(ndx, mid_phase_left, mid_phase_right, new_prediction[1]);
    }
    else if (new_prediction[0] > new_prediction[2]) {
        // Crossed from negative to positive
        return await get_cross_point(ndx, mid_phase_left, mid_phase_right, initial_additional_phase / 2.0);
    } else {
        // Crossed from positive to negative
        return await get_cross_point(ndx, current_phase_left, current_phase_right, initial_additional_phase / 2.0);
    }
}

async function get_maximum_pre1_location(ndx, current_phase_left, current_phase_right, current_prediction1) {
    const phase_step = 0.1; //0.1 degree step
    /**
     * Test two new prediction at current phase correction +- 1 degrees (0.0175 radians)
     */

    let data1 = get_data_from_phase_correction(ndx, current_phase_left - phase_step, current_phase_right + phase_step);
    let data2 = get_data_from_phase_correction(ndx, current_phase_left + phase_step, current_phase_right - phase_step);
    let data = new Float32Array(data1.length * 2);
    data.set(data1, 0);
    data.set(data2, data1.length);

    /**
     * Run prediction on the two new data points
     */
    const new_predictions = await runPrediction(data, data.length / 2, 0 /** flag=0 means p0 prediction */);
    /**
     * if current prediction[1] is the maximum, we are done
     */
    if (current_prediction1 > new_predictions[0][1] && current_prediction1 > new_predictions[1][1]) {
        return [current_phase_left, current_phase_right];
    }
    else if (new_predictions[0][1] > current_prediction1 && new_predictions[0][1] > new_predictions[1][1]) {
        // the first new prediction is the maximum, move to that point and continue searching
        return await get_maximum_pre1_location_2(ndx, current_phase_left - phase_step, current_phase_right - phase_step, new_predictions[0][1], current_prediction1, -1);
    }
    else {
        // the second new prediction is the maximum, move to that point and continue searching
        return await get_maximum_pre1_location_2(ndx, current_phase_left + phase_step, current_phase_right + phase_step, new_predictions[1][1], current_prediction1, 1);
    }
}

/**
 * 
 * @param {*} ndx: index of the spectrum in all_spectra to be corrected 
 * @param {*} current_phase_left: current phase correction at left end 
 * @param {*} current_phase_right: current phase correction at right end
 * @param {*} current_prediction1: current highest score
 * @param {*} current_prediction2: current second highest score
 * @param {*} direction: direction to search (-1 for left (reduce), 1 for right(increase))
 */
async function get_maximum_pre1_location_2(ndx, current_phase_left, current_phase_right, current_prediction1, current_prediction2, direction) {
    let add_phase = direction * 0.1; //move 0.1 degree in the given direction

    let data = get_data_from_phase_correction(ndx, current_phase_left + add_phase, current_phase_right + add_phase);


    const new_prediction_all = await runPrediction(data, data.length, 0 /** flag=0 means p0 prediction */);
    const new_prediction = new_prediction_all[0];

    if (current_prediction1 > new_prediction[1]) {
        /**
         * Begin to decrease, we are done.
         */
        console.log("Current phase correction: left end = " + current_phase_left + ", right end = " + current_phase_right);
        console.log("previous P0 prediction: " + current_prediction1);
        console.log("Current P0 prediction: " + new_prediction[1]);
        return [current_phase_left, current_phase_right];
    }
    else {
        /** 
         * continue to move in the given direction
         */
        return await get_maximum_pre1_location_2(ndx, current_phase_left + add_phase, current_phase_right + add_phase, new_prediction[1], current_prediction1, direction);
    }
};

// Wrap the logic in an async function to use 'await'
/**
 * Run prediction using TensorFlow.js
 * @param {Float32Array} data This is many 1D spectrum data
 * @param {int} data_length Length of each 1D spectrum, e.g., 131072, 65536, or 32768
 * @param {int} flag 0 for p0 model, 1 for p1 model
 * @returns {Array} reshapedProbabilities_p0 An array of probabilities for each spectrum
 */
async function runPrediction(data, data_length, flag = 0) {
    // 1. Load the model
    const modelBase = (typeof baseUrl !== 'undefined' && baseUrl) ? baseUrl : '.';
    const model = await (flag === 0 ? tf.loadGraphModel(modelBase + '/saved_model_p0/model.json') : tf.loadGraphModel(modelBase + '/saved_model_p1/model.json'));
    console.log('Model loaded successfully!');

    // 2. Preprocess Input Data (Example). n_data is batch size in our prediction
    // Because of limited resources in browser, we only process one or two spectrum at a time.
    const n_data = data.length / data_length; //number of spectra

    /**
     * Normalize data to range [0,1], for each spectrum separately
     */
    for (let i = 0; i < n_data; i++) {
        let offset = i * data_length;
        let max_val = -Infinity;

        for (let j = 0; j < data_length; j++) {
            if (data[offset + j] > max_val) max_val = data[offset + j];
        }

        // Normalize the data to [0,1]
        for (let j = 0; j < data_length; j++) {
            data[offset + j] = data[offset + j] / max_val;
        }
    }

    const mainTensor = tf.tensor(data).reshape([n_data, data_length, 1]);

    // --- 2. Generate the Mask Input ---
    // This creates a tensor of shape [1, 512] filled with the value 1.0.
    const mask_length = data_length / 128; // Example length, replace with actual if different
    const maskTensor = tf.ones([n_data, mask_length], 'bool');


    const inputs = {
        'main_input': mainTensor,
        'mask_input': maskTensor
    };

    // 3. Run the prediction with the input object
    const prediction = model.predict(inputs);
    // The output 'prediction' is a tensor.

    // 4. Process Output
    console.log('Processing output...');
    const outputData = prediction.dataSync();

    const probabilities = Array.from(outputData);

    console.log(`Prediction finished.`);
    console.log("outputData: ", outputData);
    console.log('Output Probabilities:', probabilities);

    /**
     * Convert probabilities_p0 from 1*27 to 9*3
     */
    const reshapedProbabilities = [];
    for (let i = 0; i < n_data; i++) {
        reshapedProbabilities.push(probabilities.slice(i * 3, (i + 1) * 3));
    }
    console.log('Reshaped Probabilities (n_data x 3):', reshapedProbabilities);

    // Clean up memory by disposing of the tensors
    mainTensor.dispose();
    maskTensor.dispose();
    prediction.dispose();
    // prediction_p1.dispose();

    return reshapedProbabilities;
}


/**
 * User click button to run baseline estimation
 */


function disable_enable_phase_baseline_buttons(enable = true) {
    const auto_pc = document.getElementById("button_auto_pc");
    if (auto_pc) auto_pc.disabled = !enable;
    const apply_pc = document.getElementById("button_apply_pc");
    if (apply_pc) apply_pc.disabled = !enable;
    const base_corr = document.getElementById("button_baseline_correction");
    if (base_corr) base_corr.disabled = !enable;
    const apply_base = document.getElementById("button_apply_baseline_correction");
    if (apply_base) apply_base.disabled = !enable;
    const button_urea = document.getElementById("button_urea");
    if (button_urea) button_urea.disabled = !enable;
    const apply_urea = document.getElementById("button_apply_urea");
    if (apply_urea) apply_urea.disabled = !enable;
    if (typeof b_allow_manual_phase_correction !== "undefined") {
        b_allow_manual_phase_correction = enable;
    }
    if (typeof b_allow_dragging_spectrum !== "undefined") {
        b_allow_dragging_spectrum = enable;
    }
}
