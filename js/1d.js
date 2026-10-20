/**
 * Workflows:
 * 1. Read ft2 or read fid files. If FID, run webassembly_1d_worker to process the FID (webassembly_worker2 for NUS) 
 * 2. Once ft2 files are read or generated from FID, call functions pair: process_ft_file and draw_spectrum
 * 3. Draw_spectrum will push the new spectrum_1d object to all_spectra array. Order in the array depends on who is generated first (ft2 may jump before fid even if fid is read first)
 * 4. Draw_spectrum will call contour_worker to generate contour plot from the spectrum object
 * 5. When all contour (pos and neg) are generated, contour_worker will send the data back to the main thread to show call and add_to_list()
 */


/**
 * Make sure we can load WebWorker
*/

var webassembly_1d_worker_2;
var webdp1d_module = null;
var webdp1d_module_promise = null;

if (typeof webdp1d_cpp === "function") {
    webdp1d_module_promise = webdp1d_cpp().then((mod) => {
        webdp1d_module = mod;
        return mod;
    });
}

const WEBASSEMBLY_JOB_KEY = "#sym:webassembly_job ";

function get_webassembly_job_flag(data) {
    if (!data) {
        return undefined;
    }
    return data[WEBASSEMBLY_JOB_KEY] || data.webassembly_job;
}
try {
    webassembly_1d_worker_2 = new Worker('./js/webass_1d.js');
}
catch (err) {
    console.log(err);
    if (typeof (webassembly_1d_worker_2) === "undefined") {
        alert("Failed to load WebWorker for NUS, probably due to browser incompatibility. Please use a modern browser, if you run this program locally, please read the instructions titled 'How to run COLMAR Viewer locally'");
    }
}

var nmr_pipeline = null;
if (typeof NMRPipeline1D !== 'undefined') {
    nmr_pipeline = new NMRPipeline1D({
        mode: 'webass',
        worker: webassembly_1d_worker_2,
        onStatus: function (msg) {
            let el = document.getElementById("webassembly_message");
            if (el) el.innerText = msg;
        }
    });
}



var plot_font_size = 24; //default plot font size
var main_plot = null; //hsqc plot object
var b_plot_initialized = false; //flag to indicate if the plot is initialized
var $tooldiv; //tooltip div (used by myplot1_new.js, this is not a good practice, but it is a quick fix)
var current_spectrum_index_of_peaks = -1; //index of the spectrum that is currently showing peaks, -1 means none, -2 means pseudo 2D fitted peaks
var current_flag_of_peaks = 'picked'; //flag of the peaks that is currently showing, 'picked' or 'fitted
var total_number_of_experimental_spectra = 0; //total number of experimental spectra
var pseudo3d_fitted_peaks_object = null; //pseudo 3D fitted peaks object
var pseudo2d_fitted_peaks_error = []; //pseudo 3D fitted peaks with error estimation array, each element is a Cpeaks object
var b_allow_manual_phase_correction = true; //flag to allow manual phase correction using mouse wheel and shift(control) key on the main plot
var b_allow_dragging_spectrum = false; //flag to allow dragging spectrum to reorder them

/**
 * For FID re-processing. Saved file data
 */
var fid_process_parameters;
var current_reprocess_spectrum_index = -1;
var last_processed_fid_size = 0; // Store the last reduced FID size for re-use

/**
 * Default var in peaks to color-map the peaks symbols
 */
var color_map_list = ['HEIGHT'];
/**
 * Corresponding color map limits for the color_map_list
 * Save length of color_map_list.
 */
var color_map_limit = [[0, 1]];

var inter_window_channel;

/**
 * ft2 file drop processor
 */
var ft1_file_drop_processor;

/**
* fid file drop processor for the time domain spectra
*/
var fid_drop_process;

/**
 * DOM div for the processing message
 */
var $oOutput;

/**
 * Current phase correction values:
 * direct_p0, direct_p1
 */
var current_phase_correction = [0, 0];



var all_spectra = []; //array of hsqc spectra

let draggedItem = null;


/**
 * Default color list for the contour plot (15 colors, repeat if more than 15 spectra)
 */
var color_list = [
    [0, 0, 1, 1.0], //blue
    [1, 0, 0, 1.0], //red
    [0, 1, 0, 1.0], //green
    [1, 1, 0, 1.0], //yellow
    [0, 1, 1, 1.0], //cyan
    [1, 0, 1, 1.0], //magenta
    [0, 0, 0, 1.0], //black
    [0.5, 0.5, 0.5, 1.0], //gray
    [1, 0.5, 0.5, 1.0], //pink
    [0.5, 1, 0.5, 1.0], //light green
    [0.5, 0.5, 1, 1.0], //light blue
    [1, 0.5, 1, 1.0], //light magenta
    [1, 1, 0.5, 1.0], //light yellow
    [0.5, 1, 1, 1.0], //light cyan
    [0.5, 0.5, 0.5, 1.0], //light gray
];


// read_file and read_file_text are provided by shared fid_tools_1d.js



$(document).ready(function () {

    b_allow_manual_phase_correction = true; //This is default. 
    b_allow_dragging_spectrum = true; //This is default.

    fetch('navbar.html')
        .then(response => response.text())
        .then(data => {
            document.getElementById('navbar-placeholder').innerHTML = data;
        });

    /**
     * This is the main information output area
     */
    $oOutput = document.getElementById("infor");

    /**
     * Tooltip div. Set the opacity to 0
     */
    $tooldiv = d3.select("body")
        .append("div")
        .attr("class", "tooltip2")
        .style("opacity", 0);

    /**
     * clear all_spectra array
     */
    all_spectra = [];

    pseudo2d_fitted_peaks_error = [];

    /**
    * INitialize the file drop processor for the time domain spectra
    */
    fid_drop_process = new file_drop_processor()
        .drop_area('input_files') /** id of dropzone */
        .files_name(["acqus", "ser", "fid", "acqu.par", "data.1d"])  /** file names to be searched from upload */
        .files_id(["acquisition_file", "fid_file", "fid_file", "acquisition_file", "fid_file"]) /** Corresponding file element IDs */
        .file_extension(["jdx", "dx"])  /** file extensions to be searched from upload */
        .extension_files_id(["acquisition_file", "acquisition_file"])
        .required_files([0])
        .click_to_select_folder() /** Enable click on drop zone background to open a folder picker (for ChromeOS) */
        .init();


    /**
     * Make div (id="fid_file_area") also accept drag and drop. 
     * Once it detected a dragged folder moved over, it should expand itself, so that its child can accept the drop.
     */
    const fid_area = document.getElementById("fid_file_area");
    fid_area.addEventListener("dragenter", (e) => {
        e.preventDefault();
        const btn = document.getElementById("button_minimize_fid_area");
        if (btn.innerText === "+") {
            minimize_fid_area(btn);
        }
    });
    fid_area.addEventListener("dragover", (e) => {
        e.preventDefault();
    });


    /**
     * ft2 file drop processor
     */
    ft1_file_drop_processor = new file_drop_processor()
        .drop_area('file_area') /** id of dropzone */
        .files_name([]) /** file names to be searched from upload. It is empty because we will use file_extension*/
        .file_extension(["ft1", "txt"])  /** file extensions to be searched from upload */
        .files_id(["userfile", "userfile"]) /** Corresponding file element IDs */
        .init();


    /**
     * When use selected a file, read the file and process it
     */
    document.getElementById('ft1_file_form').addEventListener('submit', function (e) {
        e.preventDefault();

        /**
         * Clear file_drop_processor container
         * clearData() does not work ???
         */
        ft1_file_drop_processor.container = new DataTransfer();

        /**
         * Collect all file names
         */
        let file_names = [];
        for (let i = 0; i < this.querySelector('input[type="file"]').files.length; i++) {
            file_names.push(this.querySelector('input[type="file"]').files[i].name);
        }
        /**
         * Sort the file names, keep the index
         */
        let index_array = Array.from(Array(file_names.length).keys());
        index_array.sort(function (a, b) {
            return file_names[a].localeCompare(file_names[b]);
        });

        console.log(index_array);

        /**
         * To keep order, we will read the files one by one using a chain of promises
         */
        let chain = Promise.resolve();
        for (let i = 0; i < this.querySelector('input[type="file"]').files.length; i++) {
            let ii = index_array[i];

            chain = chain.then(() => {
                console.log("read file", this.querySelector('input[type="file"]').files[ii].name);
                /**
                 * If not a .ft2 file or .ft3 file, resolve the promise
                 */
                if (this.querySelector('input[type="file"]').files[ii].name.endsWith(".ft1") || this.querySelector('input[type="file"]').files[ii].name.endsWith(".ucsf")) {
                    return read_file(this.querySelector('input[type="file"]').files[ii]);
                }
                else if (this.querySelector('input[type="file"]').files[ii].name.endsWith(".txt")) {
                    return read_file_text(this.querySelector('input[type="file"]').files[ii]);
                }
                else {
                    return Promise.resolve(null);
                }
            }).then((file_data) => {
                /**
                 * If the file is a ft2 file (file_data is a array buffer), process it
                 */
                if (file_data !== null && file_data !== undefined) {
                    /**
                     * If read as text file, 
                     */
                    if (typeof file_data === "string") {
                        /**
                         * Get field strength from the html input field with id "field_strength" if it exists
                         */
                        let field_strength = 850.0; //default field strength
                        if (document.getElementById("field_strength") !== null) {
                            field_strength = parseFloat(document.getElementById("field_strength").value);
                        }
                        let result_spectrum = new spectrum_1d();
                        result_spectrum.process_topspin_file(file_data, this.querySelector('input[type="file"]').files[ii].name, field_strength);
                        draw_spectrum([result_spectrum], false/**from fid */, false/** re-process of fid or ft2 */);
                    }
                    else {
                        /**
                         * Get first float32 number of the file_data. 
                         * If it is "0.0", it is a nmrPipe file, otherwise consider it as Sparky .ucsf file 
                         */
                        let first_float32 = new Float32Array(file_data, 0, 1)[0];
                        let result_spectrum;
                        if (first_float32 === 0.0) {
                            result_spectrum = new spectrum_1d();
                            result_spectrum.process_ft_file(file_data, this.querySelector('input[type="file"]').files[ii].name, -1);
                        }
                        else {
                            result_spectrum = new spectrum_1d();
                            result_spectrum.process_sparky_file(file_data, this.querySelector('input[type="file"]').files[ii].name, -1);
                        }
                        draw_spectrum([result_spectrum], false/**from fid */, false/** re-process of fid or ft2 */);
                    }
                }
                /**
                 * If it is the last file, clear the file input
                 */
                if (i === this.querySelector('input[type="file"]').files.length - 1) {
                    document.getElementById('userfile').value = "";
                }
            }).catch((err) => {
                console.log(err);
            });
        }
    });

    /**
     * Event listener for file input "load_file"
     */
    document.getElementById('load_file').addEventListener('change', function (e) {
        let file = document.getElementById('load_file').files[0];
        if (file) {
            var reader = new FileReader();
            reader.onload = function () {
                /**
                 * Read as array buffer
                 */
                loadBinaryAndJsonWithLength(reader.result);
            };
            reader.onerror = function (e) {
                console.log("Error reading file");
            };
            /**
             * Read as binary file
             */
            reader.readAsArrayBuffer(file);
        }
    });

    /**
     * Event listener for fid file input "fid_file"
     */
    document.getElementById('fid_file_form').addEventListener('submit', async function (e) {
        e.preventDefault();

        /**
         * The default button text is "Upload experimental files and process" 
         * When we are in re-process mode, it will be changed to "Reprocess" by JS code
         */
        let button_text = document.getElementById("button_fid_process").value;


        if (button_text === "Reprocess") {
            /**
             * Copy fid_process_parameters from the current spectrum to the worker then
             * update fid_process_parameters with the current values from the input fields
             * all fields associated with fid and acqus files are already set in fid_process_parameters, not from form 
             * because we are re-processing the same set of fid file
             */
            fid_process_parameters = all_spectra[current_reprocess_spectrum_index].fid_process_parameters;
            fid_process_parameters.apodization_string = document.getElementById("apodization_direct").value;
            fid_process_parameters.zf_direct = parseInt(document.getElementById("zf_direct").value);
            fid_process_parameters.phase_correction_direct_p0 = parseFloat(document.getElementById("phase_correction_direct_p0").value);
            fid_process_parameters.phase_correction_direct_p1 = parseFloat(document.getElementById("phase_correction_direct_p1").value);
            fid_process_parameters.auto_direct = document.getElementById("auto_direct").checked;
            fid_process_parameters.auto_direct_2 = document.getElementById("auto_direct_2").checked;
            fid_process_parameters.auto_direct_3 = document.getElementById("auto_direct_3").checked;
            fid_process_parameters.delete_imaginary = document.getElementById("delete_imaginary").checked;
            fid_process_parameters.pseudo_2d_process = document.querySelector('input[name="Pseudo-2D-process"]:checked').id;

            /**
             * Rerun Logic for FID Size in Reprocess Mode
             */
            let fid_reduction_mode = document.querySelector('input[name="fid_reduction_mode"]:checked').value;
            // Get raw data on demand
            let fid_data_preview = await get_fid_data_from_buffer(fid_process_parameters.fid_buffer, fid_process_parameters.acquisition_string);

            if (fid_reduction_mode === "auto" || fid_reduction_mode === "auto_confirm") {
                if (fid_data_preview) {
                    const detected_idx = detect_signal_end(fid_data_preview);
                    let cutoff = Math.floor(detected_idx / 2) * 2;
                    fid_process_parameters.reduced_fid_size = cutoff;
                } else {
                    // Fallback if data missing
                    // We can't auto-detect without data. Assume full or keep previous?
                    // Safe to keep previous if available, or 0.
                    // But user EXPECTS auto. 
                    // Assuming fid_data is available for normal flow.
                }
            } else if (fid_reduction_mode === "prev") {
                // Use last processed size if > 0, else keep existing or full
                let cutoff = last_processed_fid_size > 0 ? last_processed_fid_size : (fid_process_parameters.reduced_fid_size || 0);
                fid_process_parameters.reduced_fid_size = cutoff;
            } else {
                // Full
                fid_process_parameters.reduced_fid_size = 0;
            }

            /**
             * Send to webassembly worker or Pause for Confirm
             */
            if (fid_reduction_mode === "auto_confirm" && fid_data_preview) {
                show_fid_window(fid_data_preview, fid_process_parameters.reduced_fid_size, (newCutoff) => {
                    fid_process_parameters.reduced_fid_size = newCutoff;
                    webassembly_1d_worker_2.postMessage(fid_process_parameters);
                    document.getElementById("button_fid_process").disabled = true;
                });
            } else {
                if (fid_data_preview) show_fid_window(fid_data_preview, fid_process_parameters.reduced_fid_size);
                webassembly_1d_worker_2.postMessage(fid_process_parameters);
            }
            document.getElementById("button_fid_process").disabled = true;
        }
        else //button_text == "Upload experimental files and process"
        {
            /**
             * UN-highlight the input_options div
             */
            document.getElementById("input_options").style.backgroundColor = "white";

            let acquisition_file = document.getElementById('acquisition_file').files[0];
            let fid_file = document.getElementById('fid_file').files[0];

            if (acquisition_file || fid_file) {
                let acquisition_string = acquisition_file ? await read_file_text(acquisition_file) : "";
                let fid_buffer = fid_file ? await read_file(fid_file) : new ArrayBuffer(0);
                /**
                 * Convert fid_buffer to Float32Array
                 */
                let reduced_fid_size = 0;
                let apodization_string = document.getElementById("apodization_direct").value;
                let zf_direct = parseInt(document.getElementById("zf_direct").value);
                let phase_correction_direct_p0 = parseFloat(document.getElementById("phase_correction_direct_p0").value);
                let phase_correction_direct_p1 = parseFloat(document.getElementById("phase_correction_direct_p1").value);
                let auto_direct = document.getElementById("auto_direct").checked;
                let auto_direct_2 = document.getElementById("auto_direct_2").checked;
                let auto_direct_3 = document.getElementById("auto_direct_3").checked;
                let delete_imaginary = document.getElementById("delete_imaginary").checked;
                let fid_reduction_mode = document.querySelector('input[name="fid_reduction_mode"]:checked').value;
                /**
                 * Get radio group name "Pseudo-2D-process", id "first_only" or "all_traces"
                 */
                let pseudo_2d_process = document.querySelector('input[name="Pseudo-2D-process"]:checked').id;

                /**
                 * fid_process_parameters is a GLOBAL object that will be sent to the webassembly worker
                 * It will be saved here, in case we need to re-process the fid file
                 */
                fid_process_parameters = {
                    [WEBASSEMBLY_JOB_KEY]: "fid_processor_1d",
                    reduced_fid_size: reduced_fid_size,
                    acquisition_string: acquisition_string,
                    fid_buffer: fid_buffer,
                    apodization_string: apodization_string,
                    zf_direct: zf_direct,
                    phase_correction_direct_p0: phase_correction_direct_p0,
                    phase_correction_direct_p1: phase_correction_direct_p1,
                    auto_direct: auto_direct,
                    auto_direct_2: auto_direct_2,
                    auto_direct_3: auto_direct_3,
                    delete_imaginary: delete_imaginary,
                    pseudo_2d_process: pseudo_2d_process,
                    reprocess: false, // this is not a re-process, it is a new fid file processing
                    spectrum_index: -1, // -1 is a flag, means to be decided later.
                };

                /**
                 * Clear file input
                 */
                document.getElementById('acquisition_file').value = "";
                document.getElementById('fid_file').value = "";

                // --- PREVIEW FID PLOT ---
                try {
                    let fid_data_preview = await get_fid_data_from_buffer(fid_buffer, acquisition_string);

                    if (fid_data_preview) {
                        let cutoff = fid_data_preview.length; // Default to full

                        if (fid_reduction_mode === "auto" || fid_reduction_mode === "auto_confirm") {
                            const detected_idx = detect_signal_end(fid_data_preview);
                            // Ensure even number
                            cutoff = Math.floor(detected_idx / 2) * 2;

                            // Update params for worker: Explicit reduced size
                            fid_process_parameters.reduced_fid_size = cutoff;
                        } else if (fid_reduction_mode === "prev") {
                            // Use previous size if available, otherwise full
                            cutoff = last_processed_fid_size > 0 ? last_processed_fid_size : fid_data_preview.length;
                            fid_process_parameters.reduced_fid_size = cutoff;
                        } else {
                            // Full mode
                            fid_process_parameters.reduced_fid_size = 0;
                        }

                        if (fid_reduction_mode === "auto_confirm") {
                            // Pause for confirmation
                            show_fid_window(fid_data_preview, cutoff, (newCutoff) => {
                                fid_process_parameters.reduced_fid_size = newCutoff;
                                document.getElementById("webassembly_message").innerText = "Processing FID...";
                                webassembly_1d_worker_2.postMessage(fid_process_parameters);
                                document.getElementById("button_fid_process").disabled = true;
                            });
                        } else {
                            // Proceed immediately
                            show_fid_window(fid_data_preview, cutoff);
                            document.getElementById("webassembly_message").innerText = "Processing FID...";
                            webassembly_1d_worker_2.postMessage(fid_process_parameters);
                            document.getElementById("button_fid_process").disabled = true;
                        }
                    } else {
                        // Fallback if preview data not available
                        document.getElementById("webassembly_message").innerText = "Processing FID...";
                        webassembly_1d_worker_2.postMessage(fid_process_parameters);
                        document.getElementById("button_fid_process").disabled = true;
                    }
                } catch (err) {
                    console.error("Error generating FID preview:", err);
                    // Fallback on error
                    document.getElementById("webassembly_message").innerText = "Processing FID...";
                    webassembly_1d_worker_2.postMessage(fid_process_parameters);
                    document.getElementById("button_fid_process").disabled = true;
                }
            }
            else {
                alert("Please select both acquisition and fid files.");
            }
        }
    });

    /**
     * Event listener for peak_size, peak_thickness, filled_peaks and peak_color
     */
    const peakSizeHandler = function (e) {
        main_plot.peak_size = parseFloat(this.value);
        main_plot.redraw_peaks(1);
    };
    document.getElementById('peak_size').addEventListener('input', peakSizeHandler);
    document.getElementById('peak_size').addEventListener('change', peakSizeHandler);

    const peakThicknessHandler = function (e) {
        main_plot.peak_thickness = parseFloat(this.value);
        main_plot.redraw_peaks(2);
    };
    document.getElementById('peak_thickness').addEventListener('input', peakThicknessHandler);
    document.getElementById('peak_thickness').addEventListener('change', peakThicknessHandler);

    document.getElementById('filled_peaks').addEventListener('change', function (e) {
        main_plot.filled_peaks = this.checked;
        main_plot.redraw_peaks(3);
    });

    const peakColorHandler = function (e) {
        main_plot.peak_color = this.value;
        main_plot.redraw_peaks(4);
    };
    document.getElementById('peak_color').addEventListener('input', peakColorHandler);
    document.getElementById('peak_color').addEventListener('change', peakColorHandler);
});

webassembly_1d_worker_2.onmessage = function (e) {
    const webassembly_job = get_webassembly_job_flag(e.data);

    if (webassembly_job === "fid_processor_1d") {
        /**
         * Received fid processing result:
         *  webassembly_job: event.data.webassembly_job,
            fid_json: fid_json,
            spectrum_header : header_data,
            real_spectrum_data: real_spectrum_data,
         */
        try {
            /**
             * Combined existing logic
             */
            result_spectrum = new spectrum_1d();

            /**
             * Combine header and fid_json to create a new float32 array and convert to arrayBuffer
             */
            const combined = new Float32Array(e.data.spectrum_header.length + e.data.real_spectrum_data.length * 2);
            combined.set(e.data.spectrum_header);
            combined.set(e.data.real_spectrum_data, e.data.spectrum_header.length);
            combined.set(e.data.image_spectrum_data, e.data.spectrum_header.length + e.data.real_spectrum_data.length);
            const buffer = combined.buffer;
            result_spectrum.process_ft_file(buffer, 'from_fid.ft1', -2);
            result_spectrum.spectrum_index = e.data.spectrum_index; //spectrum_index is set to what is in reprocess_spectrum_index

            /**
             * Save the phase correction values to fid_process_parameters
             */
            fid_process_parameters.phase_correction_direct_p0 = e.data.p0;
            fid_process_parameters.phase_correction_direct_p1 = e.data.p1;
            /**
             * Save auto determined cutoff data size as well
             */
            fid_process_parameters.reduced_fid_size = e.data.reduced_fid_size;

            // Update global last size and enable option
            if (e.data.reduced_fid_size > 0) {
                last_processed_fid_size = e.data.reduced_fid_size;
                document.getElementById("fid_mode_prev").disabled = false;
            }

            /**
             * Update fid processing box parameters
             */
            document.getElementById("phase_correction_direct_p0").value = e.data.p0.toFixed(2);
            document.getElementById("phase_correction_direct_p1").value = e.data.p1.toFixed(2);

            draw_spectrum(
                [result_spectrum],
                true,/**from fid */
                e.data.reprocess,/** re-process of fid or ft2 */
                e.data.auto_direct_2, /** whether auto direct_2 was used. If so, need to run tfjs */
            );

            /**
             * Re-enable the button to process fid file
             */
            document.getElementById("button_fid_process").disabled = false;

            // Notify tutorial
            if (!e.data.auto_direct_2) {
                const btn = document.getElementById("button_fid_process");
                if (btn) {
                    btn.dispatchEvent(new Event('colmar:processing_finished', { bubbles: true }));
                }

                // Auto-Exit processing mode
                if (current_reprocess_spectrum_index !== -1) {
                    exit_reprocessing_ui(current_reprocess_spectrum_index);
                }
            }

        } finally {
            document.getElementById("webassembly_message").innerText = "";
        }
    }


    else if (webassembly_job === "peak_picker_1d") {
        let peaks = new cpeaks();
        peaks.process_peaks_tab(e.data.picked_peaks_tab);
        all_spectra[e.data.spectrum_index].picked_peaks_object = peaks;


        /**
         * when picked peaks are received, fitted peaks need to be reset
         */
        all_spectra[e.data.spectrum_index].fitted_peaks_object = null;

        /**
         * Disable the download fitted peaks button. Uncheck the show fitted peaks checkbox, disable it too
         */
        disable_enable_fitted_peak_buttons(e.data.spectrum_index, 0);

        /**
         * Need to save its scale and scale2 used to run deep picker
         * because we will need them to run peak fitting
         */
        all_spectra[e.data.spectrum_index].scale = e.data.scale;
        all_spectra[e.data.spectrum_index].scale2 = e.data.scale2;

        disable_enable_peak_buttons(e.data.spectrum_index, 1);

        /**
         * Clear the processing message
         */
        document.getElementById("webassembly_message").innerText = "";
    }
    /**
     * If result is fitted_peaks and recon_spectrum
     */
    else if (webassembly_job === "peak_fitter_1d") {
        console.log("Fitted peaks and recon_spectrum received");

        /**
         * Define a new class peaks object, process e.data.fitted_peaks_tab
         */
        let peaks = new cpeaks();
        peaks.process_peaks_tab(e.data.fitted_peaks_tab);
        all_spectra[e.data.spectrum_origin].fitted_peaks_object = peaks;

        /**
         * Enable the download fitted peaks button and show the fitted peaks button
         */
        disable_enable_fitted_peak_buttons(e.data.spectrum_origin, 1);

        /**
         * Process the frequency domain spectrum, spectrum name is "recon-".spectrum_origin.".ft2"
         */
        let result_spectrum_name = "recon-".concat(e.data.spectrum_origin.toString(), ".ft1");
        let result_spectrum = new spectrum_1d();
        result_spectrum.process_ft_file_type2(all_spectra[e.data.spectrum_origin].header, e.data.recon_spectrum, result_spectrum_name, e.data.spectrum_origin);

        /**
         * Replace its header with the header of the original spectrum
         * and noise_level, levels, negative_levels, spectral_max and spectral_min with the original spectrum
         */
        result_spectrum.header = all_spectra[e.data.spectrum_origin].header;
        result_spectrum.noise_level = all_spectra[e.data.spectrum_origin].noise_level;
        result_spectrum.levels = all_spectra[e.data.spectrum_origin].levels;
        result_spectrum.negative_levels = all_spectra[e.data.spectrum_origin].negative_levels;
        result_spectrum.spectral_max = all_spectra[e.data.spectrum_origin].spectral_max;
        result_spectrum.spectral_min = all_spectra[e.data.spectrum_origin].spectral_min;
        result_spectrum.x_ppm_ref = all_spectra[e.data.spectrum_origin].x_ppm_ref;
        result_spectrum.spectral_scale = all_spectra[e.data.spectrum_origin].spectral_scale;

        /**
        * Copy picked_peaks_object and fitted_peaks_object from the original spectrum
        */
        result_spectrum.picked_peaks_object = all_spectra[e.data.spectrum_origin].picked_peaks_object;
        result_spectrum.fitted_peaks_object = all_spectra[e.data.spectrum_origin].fitted_peaks_object;

        const recon_peaks = JSON.parse(e.data.recon_json);
        const peaks_center = get_center(recon_peaks.peaks_recon);

        result_spectrum.recon_peaks = recon_peaks.peaks_recon;
        result_spectrum.recon_peaks_center = peaks_center;

        /**
         * Also copy scale and scale2 from the original spectrum, which are used to run deep picker and peak fitting
         */
        result_spectrum.scale = e.data.scale;
        result_spectrum.scale2 = e.data.scale2;

        draw_spectrum([result_spectrum], false/**from fid */, false/** re-process of fid or ft2 */);
        /**
         * Clear the processing message
         */
        document.getElementById("webassembly_message").innerText = "";


    }

    else if (webassembly_job === "generate_voigt_profiles_1d") {

        /**
         * If peak index == 0, we are receiving the first one from a new batch, remove all existing profiles first
         */
        if (e.data.profile_index == 0) {
            main_plot.remove_all_peak_profiles();
        }
        /**
         * Add the profile to the main_plot
         */
        main_plot.add_peak_profile(e.data.profile_ppm, e.data.profile_data);
    }

    else if (webassembly_job === "baseline_correction_1d") {
        let spectrum_index = e.data.spectrum_index;
        if (spectrum_index >= 0 && spectrum_index < all_spectra.length) {
            all_spectra[spectrum_index].baseline = e.data.baseline;
            /**
             * Convert e.data.baseline from Float32Array to regular array baseline
             * baseline is an array of array of 2: [[ppm1, value1], [ppm2, value2], ...]
             */
            let baseline = [];
            for (let i = 0; i < e.data.baseline.length; i++) {
                let ppm_value = all_spectra[spectrum_index].x_ppm_start + all_spectra[spectrum_index].x_ppm_step * i;
                baseline.push([ppm_value, e.data.baseline[i]]);
            }
            main_plot.show_baseline(baseline, spectrum_index);
            disable_enable_phase_baseline_buttons(true);
        }
    }

    else if (e.data.error) {
        console.error('1D worker error:', e.data.error);
        document.getElementById("webassembly_message").innerText = e.data.error;
        document.getElementById("button_fid_process").disabled = false;
    }


    else if (e.data.stdout) {
        document.getElementById("log").value += e.data.stdout + "\n";
        document.getElementById("log").scrollTop = document.getElementById("log").scrollHeight;
    }
}

var plot_div_resize_observer = new ResizeObserver(entries => {
    for (let entry of entries) {
        const cr = entry.contentRect;
        /** 
         * resize the SVG element (id: main_plot) to the same size as the div (id: plot_div)
         */
        main_plot.resize(cr.width - 4, cr.height - 4);
    }
});

/**
 * Save current size and zoom level to the input field "size_and_zoom_string"
 */
function write_current_size() {
    let width = document.getElementById("plot_1d").style.width;
    let height = document.getElementById("plot_1d").style.height;
    /**
     * Remove "px" from width and height
     */
    width = parseFloat(width.replace("px", ""));
    height = parseFloat(height.replace("px", ""));

    let xscale = main_plot.xscale.domain();
    let yscale = main_plot.yscale.domain();

    let size_info = width.toString().concat(" ", height.toString(), " ", xscale[0].toFixed(3), " ", xscale[1].toFixed(3), " ", yscale[0].toFixed(3), " ", yscale[1].toFixed(3));

    document.getElementById("size_and_zoom_string").value = size_info;
}

/**
 * Apply size and zoom level from the input field "size_and_zoom_string"
 */
function apply_size_and_zoom() {
    let size_info = document.getElementById("size_and_zoom_string").value.split(" ");
    if (size_info.length === 6 && main_plot !== null) {
        let width = parseFloat(size_info[0]);
        let height = parseFloat(size_info[1]);
        let xscale = [parseFloat(size_info[2]), parseFloat(size_info[3])];
        let yscale = [parseFloat(size_info[4]), parseFloat(size_info[5])];

        document.getElementById("plot_1d").style.width = width.toString().concat("px");
        document.getElementById("plot_1d").style.height = height.toString().concat("px");
        main_plot.xscale.domain(xscale);
        main_plot.yscale.domain(yscale);
        main_plot.redraw();
    }
}

/**
 * Change font size of the plot
 */
function apply_font_size() {
    let new_size = parseFloat(document.getElementById("fontsize").value);
    if (!isNaN(new_size)) {
        plot_font_size = new_size;
        /**
         * Calculate new margins based on the new font size
         */
        let new_margin = {
            left: 15 + plot_font_size * 5,
            right: 10,
            top: 10,
            bottom: 15 + plot_font_size * 3
        };
        main_plot.update_margins_and_font(new_margin, plot_font_size);
    }
}


function resize_main_plot(wid, height, padding, margin_left, margin_top, margin_right, margin_bottom) {
    /**
     * same size for svg_parent (parent of visualization), canvas_parent (parent of canvas1), canvas1, 
     * and vis_parent (parent of visualization and canvas_parent)
     */
    document.getElementById('svg_parent').style.height = height.toString().concat('px');
    document.getElementById('svg_parent').style.width = wid.toString().concat('px');
    document.getElementById('svg_parent').style.top = padding.toFixed(0).concat('px');
    document.getElementById('svg_parent').style.left = padding.toFixed(0).concat('px');

    /**
     * Set the size of the visualization div to be the same as its parent
     */
    document.getElementById('visualization').style.height = height.toString().concat('px');
    document.getElementById('visualization').style.width = wid.toString().concat('px');

    /**
     * canvas is shifted 50px to the right, 20 px to the bottom.
     * It is also shortened by 20px in width on the right and 50px in height on the bottom.
     */
    let canvas_height = height - (margin_top + margin_bottom);
    let canvas_width = wid - (margin_left + margin_right);

    // document.getElementById('canvas_parent').style.height = canvas_height.toString().concat('px');
    // document.getElementById('canvas_parent').style.width = canvas_width.toString().concat('px');
    document.getElementById('canvas_parent').style.top = (padding + margin_top).toFixed(0).concat('px');
    document.getElementById('canvas_parent').style.left = (padding + margin_left).toFixed(0).concat('px');


    /**
     * Set canvas1 style width and height to be the same as its parent
     */
    // document.getElementById('canvas1').style.height = canvas_height.toString().concat('px');
    // document.getElementById('canvas1').style.width = canvas_width.toString().concat('px');
    /**
     * Set canvas1 width and height to be the same as its style width and height
     */
    document.getElementById('canvas1').setAttribute("height", canvas_height.toString());
    document.getElementById('canvas1').setAttribute("width", canvas_width.toString());

    let input = {
        WIDTH: wid,
        HEIGHT: height
    };

    if (main_plot !== null) {
        main_plot.update(input);
    }


}

/**
 * Drag and drop spectra to reorder them 
 */
const sortableList = document.getElementById("spectra_list_ol");

sortableList.addEventListener(
    "dragstart",
    (e) => {
        if (!b_allow_dragging_spectrum) return;
        /**
         * We will move the parent element (div)'s parent (li) of the dragged item
         */
        draggedItem = e.target.parentElement.parentElement
        setTimeout(() => {
            e.target.parentElement.style.display =
                "none";
        }, 0);
    });

sortableList.addEventListener(
    "dragend",
    (e) => {
        if (!b_allow_dragging_spectrum) return;
        setTimeout(() => {
            e.target.parentElement.style.display = "";
            draggedItem = null;
        }, 0);

        /**
         * Get the index of the new order
         */
        let new_order = [];
        let list_items = spectra_list_ol.querySelectorAll("li");
        for (let i = 0; i < list_items.length; i++) {
            let index = parseInt(list_items[i].id.split("-")[1]); //ID is spectrum-index
            new_order.push(index);
        }
        /**
         * In case new_order.length !== main_plot.spectral_order.length,
         * we need to wait for the worker to finish the calculation then update the order
         */
        let interval_id = setInterval(() => {
            if (new_order.length === main_plot.spectral_order.length) {
                clearInterval(interval_id);
                main_plot.spectral_order = new_order;
                main_plot.redraw_order();
            }
        }, 1000);
    });

sortableList.addEventListener(
    "dragover",
    (e) => {
        if (!b_allow_dragging_spectrum) return;
        e.preventDefault();
        /**
         * If draggedItem is null, return (user is dragging something else)
         */
        if (draggedItem === null) {
            return;
        }
        const afterElement =
            getDragAfterElement(
                sortableList,
                e.clientY);
        // const currentElement =document.querySelector(".dragging").parentElement;

        if (afterElement == null) {
            sortableList.appendChild(
                draggedItem
            );
        }
        else {
            sortableList.insertBefore(
                draggedItem,
                afterElement
            );
        }
    });

const getDragAfterElement = (container, y) => {
    const draggableElements = [
        ...container.querySelectorAll(
            ":scope > li:not(.dragging)"
        ),];

    return draggableElements.reduce(
        (closest, child) => {
            const box =
                child.getBoundingClientRect();
            const offset =
                y - box.top - box.height / 2;
            if (
                offset < 0 &&
                offset > closest.offset) {
                return {
                    offset: offset,
                    element: child,
                };
            }
            else {
                return closest;
            }
        },
        {
            offset: Number.NEGATIVE_INFINITY,
        }
    ).element;
};

function minimize_fid_area(self) {
    /**
     * Get button text
     */
    let button_text = self.innerText;
    /**
     * if button_text is "+", change it to "-"
     * and set the height of the fid_file_area to 3rem, clip the overflow
     */
    if (button_text === "-") {
        self.innerText = "+";
        document.getElementById("fid_file_area").style.height = "3rem";
        document.getElementById("fid_file_area").style.overflow = "clip";
    }
    /**
     * if button_text is "-", change it to "+". Set the height of the fid_file_area to auto, visible overflow
     */
    else {
        self.innerText = "-";
        document.getElementById("fid_file_area").style.height = "auto";
        document.getElementById("fid_file_area").style.overflow = "visible";
    }
}

function minimize_file_area(self) {
    /**
     * Get button text
     */
    let button_text = self.innerText;
    /**
     * if button_text is "+", change it to "-"
     * and set the height of the file_area to 3rem, clip the overflow
     */
    if (button_text === "-") {
        self.innerText = "+";
        document.getElementById("file_area").style.height = "3rem";
        document.getElementById("file_area").style.overflow = "clip";
    }
    /**
     * if button_text is "-", change it to "+". Set the height of the file_area to auto, visible overflow
    */
    else {
        self.innerText = "-";
        document.getElementById("file_area").style.height = "auto";
        document.getElementById("file_area").style.overflow = "visible";
    }
}


function minimize_spectrum(button, index) {
    let spectrum_div = document.getElementById("spectrum-".concat(index)).querySelector("div");
    let minimize_button = button;
    if (minimize_button.innerText === "-") {
        /**
         * If this is current spectrum, do not minimize it
         */
        if (main_plot.current_spectrum_index === index) {
            return;
        }
        /**
         * If current spectrum is recon spectrum of spectrum index, do not minimize it
         */
        if (all_spectra[main_plot.current_spectrum_index].spectrum_origin === index) {
            return;
        }

        minimize_button.innerText = "+";
        spectrum_div.style.height = "1.75rem";
        spectrum_div.style.overflow = "clip";

        all_spectra[index].visible = false;
        main_plot.update_visibility(index, false);

        /**
         * If peaks are shown, remove them as well
         */
        if (current_spectrum_index_of_peaks === index) {
            current_spectrum_index_of_peaks = -1;
            main_plot.remove_peaks();
        }

        /**
         * Loop all spectra, find children of this spectrum, hide them too
         */
        for (let i = 0; i < all_spectra.length; i++) {
            if (all_spectra[i].spectrum_origin === index) {
                all_spectra[i].visible = false;
                main_plot.update_visibility(i, false);
                if (current_spectrum_index_of_peaks === i) {
                    current_spectrum_index_of_peaks = -1;
                    main_plot.remove_peaks();
                }
            }
        }
    }
    else {
        minimize_button.innerText = "-";
        spectrum_div.style.height = "auto";
        all_spectra[index].visible = true;
        main_plot.update_visibility(index, true);

        /**
         * Loop all spectra, find children of this spectrum, show them too
         */
        for (let i = 0; i < all_spectra.length; i++) {
            if (all_spectra[i].spectrum_origin === index) {
                all_spectra[i].visible = true;
                main_plot.update_visibility(i, true);
            }
        }
    }
}

/**
 * Main function to add a new spectrum_1d to the list (with all the buttons, etc)
 * @param {*} index: spectrum index in all_spectra
 * IMPORTANT: This function is called AFTER contour is drawn
 */
function add_to_list(index) {
    let new_spectrum = all_spectra[index];
    let new_spectrum_div_list = document.createElement("li");
    let new_spectrum_div = document.createElement("div");

    /**
     * Assign a ID to the new spectrum_1d div
     */
    new_spectrum_div_list.id = "spectrum-".concat(index);

    /**
     * If this is a removed spectrum, do not add it to the list
     * this is required when user loads previously saved data, some spectra may be removed
     */
    if (new_spectrum.spectrum_origin === -3) {
        return;
    }

    /**
     * Add a draggable div to the new spectrum_1d div, only if the spectrum is experimental
     */
    if (new_spectrum.spectrum_origin === -1 || new_spectrum.spectrum_origin === -2 || new_spectrum.spectrum_origin >= 10000) {
        /**
         * Also add an minimize button to the new spectrum_1d div
         */
        let minimize_button = document.createElement("button");
        minimize_button.id = "minimize-".concat(index);
        minimize_button.innerText = "-";
        minimize_button.onclick = function () { minimize_spectrum(this, index); };
        new_spectrum_div.appendChild(minimize_button);

        let draggable_span = document.createElement("span");
        draggable_span.draggable = true;
        draggable_span.classList.add("draggable");
        draggable_span.appendChild(document.createTextNode("\u2195 Drag me. "));
        draggable_span.style.cursor = "move";
        new_spectrum_div.appendChild(draggable_span);
    }

    /**
     * Add a "Reprocess" button to the new spectrum_1d div if
     * 1. spectrum_origin == -2 (experimental spectrum from fid, and must be first if from pseudo 2D)
     * TODO: 2. spectrum_origin == -1 (experimental spectrum from ft2) && raw_data_i or raw_data_i is not empty
     */
    if (new_spectrum.spectrum_origin === -2) {
        let reprocess_button = document.createElement("button");
        reprocess_button.id = "reprocess-".concat(index);
        reprocess_button.innerText = "Edit FID processing";
        reprocess_button.title = "Load this spectrum's FID data and its previous processing parameters back into the FID processing section above, so you can adjust them. This does NOT reprocess anything yet; click the \"Reprocess\" button in that section to run the processing again.";
        reprocess_button.onclick = function () { reprocess_spectrum(this, index); };
        new_spectrum_div.appendChild(reprocess_button);
    }

    if (new_spectrum.spectrum_origin === -1 || new_spectrum.spectrum_origin === -2 || new_spectrum.spectrum_origin >= 10000) {
        /**
         * The new DIV will have the following children:
         * A original index (which is different from the index in the list, because of the order change by drag and drop)
         */
        let span_for_index = document.createElement("span");
        let original_index_node = document.createTextNode("Original index: ".concat(index.toString(), ", "));
        span_for_index.appendChild(original_index_node);
        new_spectrum_div.appendChild(span_for_index);
        /**
         * make this one the default selected spectrum
         */
        if (main_plot.current_spectrum_index >= 0 && main_plot.current_spectrum_index < all_spectra.length) {

            let current_spectrum_div = document.getElementById("spectrum-".concat(main_plot.current_spectrum_index));
            if (current_spectrum_div) {
                current_spectrum_div.querySelector("div").style.backgroundColor = "white";
            }
        }

        if (index >= 0 && index < all_spectra.length) {
            if (main_plot.current_spectrum_index != -1 && main_plot.current_spectrum_index != index) {
                permanently_apply_phase_correction();
            }
            main_plot.current_spectrum_index = index;
        }
        else {
            main_plot.current_spectrum_index = -1;
        }

        /**
         * Highlight the current spectrum in the list
         */
        new_spectrum_div.style.backgroundColor = "lightblue";


        /**
         * Add a onclick function to the new spectrum_1d div to set the current spectrum index
         */
        span_for_index.onclick = function () {
            set_current_spectrum_0(index);
        }
        /**
         * Add filename as a text node
         */
        let fname_text = document.createTextNode(" File name: " + all_spectra[index].filename + " ");
        new_spectrum_div.appendChild(fname_text);
        new_spectrum_div.appendChild(document.createElement("br"));


        new_spectrum_div.appendChild(document.createTextNode("Noise: " + new_spectrum.noise_level.toExponential(4) + ","));
    }


    /**
     * Add a download button to download the spectrum 
     * Allow download of from fid and from reconstructed spectrum
     */
    if (new_spectrum.spectrum_origin >= 0 && new_spectrum.spectrum_origin < 10000) {
        let minimizer_button = document.createElement("button");
        minimizer_button.innerText = "-";
        minimizer_button.classList.add("header-control");
        minimizer_button.onclick = function () { minimize_reconstructed_spectrum(this, index); };
        /**
         * Insert 2 spaces
         */
        new_spectrum_div.appendChild(minimizer_button);
        new_spectrum_div.appendChild(document.createTextNode("  "));
    }

    let download_button = document.createElement("button");
    download_button.innerText = "Download ft1";
    download_button.classList.add("header-control");
    download_button.onclick = function () { download_spectrum(index, 'original'); };
    new_spectrum_div.appendChild(download_button);

    /**
     * A color picker element with the color of the contour plot, whose ID is "contour_color-".concat(index)
     * Set the color of the picker to the color of the spectrum
     * Also add an event listener to update the color of the contour plot
     */
    let line_color_label = document.createElement("label");
    line_color_label.setAttribute("for", "line_color-".concat(index));
    line_color_label.innerText = "Color: ";
    line_color_label.classList.add("header-control");
    let line_color_input = document.createElement("input");
    line_color_input.setAttribute("type", "color");
    line_color_input.setAttribute("value", new_spectrum.spectrum_color);
    line_color_input.setAttribute("id", "contour_color-".concat(index));
    line_color_input.addEventListener("change", (e) => { update_line_color(e, index); });
    line_color_input.classList.add("header-control");
    new_spectrum_div.appendChild(line_color_label);
    new_spectrum_div.appendChild(line_color_input);

    /**
     * A line width input element (type number) with ID "line_width-".concat(index)
     * Set the value of the input to default value of 2
     * Also add an event listener to update the line width of the contour plot
     */
    let line_width_label = document.createElement("label");
    line_width_label.setAttribute("for", "line_width-".concat(index));
    line_width_label.innerText = " Line width: ";
    line_width_label.classList.add("header-control");
    let line_width_input = document.createElement("input");
    line_width_input.setAttribute("type", "number");
    line_width_input.setAttribute("id", "line_width-".concat(index));
    line_width_input.setAttribute("min", "1");
    line_width_input.setAttribute("value", "2");
    line_width_input.style.width = '48px';
    line_width_input.addEventListener("change", (e) => { update_line_width(e, index); });
    line_width_input.classList.add("header-control");
    new_spectrum_div.appendChild(line_width_label);
    new_spectrum_div.appendChild(line_width_input);

    /**
     * For no-reconstructed spectra or add spectra from pseudo 2D, add 
     * Label and span for spectrum scale, default is 1.0
     * Label and span for spectrum reference, default is 0.0
     */
    if (new_spectrum.spectrum_origin < 0) {
        let scale_label = document.createElement("label");
        scale_label.setAttribute("for", "spectrum-scale-".concat(index));
        scale_label.innerText = "Scale: ";
        let scale_span = document.createElement("span");
        scale_span.setAttribute("id", "spectrum-scale-".concat(index));
        scale_span.innerText = "1.00";
        new_spectrum_div.appendChild(scale_label);
        new_spectrum_div.appendChild(scale_span);

        /**
         * Add a double spaces between scale and reference
         */
        new_spectrum_div.appendChild(document.createTextNode("  "));


        let ref_label = document.createElement("label");
        ref_label.setAttribute("for", "spectrum-reference-".concat(index));
        ref_label.innerText = "Reference: ";
        let ref_span = document.createElement("span");
        ref_span.setAttribute("id", "spectrum-reference-".concat(index));
        ref_span.innerText = "0.0000";
        new_spectrum_div.appendChild(ref_label);
        new_spectrum_div.appendChild(ref_span);

    }

    new_spectrum_div.appendChild(document.createElement("br"));


    /**
     * If the spectrum is experimental, add a run_DEEP_Picker, run Voigt fitter, run Gaussian fitter, and download peaks button
     */
    if (new_spectrum.spectrum_origin === -1 || new_spectrum.spectrum_origin === -2 || new_spectrum.spectrum_origin >= 10000) {
        /**
         * Add a file input field to upload a peak list, with a label "Load peak list: "
         */
        let load_peak_list_label = document.createElement("label");
        load_peak_list_label.setAttribute("for", "run_load_peak_list-".concat(index));
        load_peak_list_label.innerText = " Load peak list: ";
        let peak_list_input = document.createElement("input");
        peak_list_input.setAttribute("type", "file");
        peak_list_input.setAttribute("id", "run_load_peak_list-".concat(index));
        peak_list_input.onchange = function () { load_peak_list(index); };
        new_spectrum_div.appendChild(load_peak_list_label);
        new_spectrum_div.appendChild(peak_list_input);

        /**
         * Add an input field to set minimum peak height (relative to noise level) for DEEP picker (ID: "scale1-".concat(index))
         */
        let scale1_label = document.createElement("label");
        scale1_label.setAttribute("for", "scale1-".concat(index));
        scale1_label.innerText = " Scale1: ";
        let scale1_input = document.createElement("input");
        scale1_input.setAttribute("type", "number");
        scale1_input.setAttribute("step", "0.1");
        scale1_input.setAttribute("min", "4.0");
        scale1_input.setAttribute("id", "scale1-".concat(index));
        scale1_input.setAttribute("size", "4");
        scale1_input.setAttribute("value", "10.0");
        new_spectrum_div.appendChild(scale1_label);
        new_spectrum_div.appendChild(scale1_input);


        /**
         * Add a run_DEEP_Picker button to run DEEP picker. Default is enabled
         */
        let deep_picker_button = document.createElement("button");
        deep_picker_button.setAttribute("id", "run_deep_picker-".concat(index));
        deep_picker_button.innerText = "DEEP Picker";
        deep_picker_button.onclick = function () { run_DEEP_Picker(index, 0); };
        new_spectrum_div.appendChild(deep_picker_button);

        // Add a line break
        if (new_spectrum.spectrum_origin >= 0 && new_spectrum.spectrum_origin < 10000) {

        }
        else {
            new_spectrum_div.appendChild(document.createElement("br"));
        }

        /**
         * Add a combine_peak cutoff input filed with ID "peak_combine_cutoff-".concat(index)
         * run_Voigt_fitter() will read this value and send to wasm to combine peaks in the fitting
         */
        let peak_combine_cutoff_label = document.createElement("label");
        peak_combine_cutoff_label.setAttribute("for", "peak_combine_cutoff-".concat(index));
        peak_combine_cutoff_label.innerText = " Combine peak cutoff: ";
        let peak_combine_cutoff_input = document.createElement("input");
        peak_combine_cutoff_input.setAttribute("type", "number");
        peak_combine_cutoff_input.setAttribute("step", "0.01");
        peak_combine_cutoff_input.setAttribute("min", "0.00");
        peak_combine_cutoff_input.setAttribute("id", "peak_combine_cutoff-".concat(index));
        peak_combine_cutoff_input.setAttribute("size", "1");
        peak_combine_cutoff_input.setAttribute("value", "0.1");
        new_spectrum_div.appendChild(peak_combine_cutoff_label);
        new_spectrum_div.appendChild(peak_combine_cutoff_input);

        /**
         * Add a maxround input filed (type: int number) with ID "maxround-".concat(index)
         */
        let maxround_label = document.createElement("label");
        maxround_label.setAttribute("for", "maxround-".concat(index));
        maxround_label.innerText = " Max round: ";
        let maxround_input = document.createElement("input");
        maxround_input.setAttribute("type", "number");
        maxround_input.setAttribute("step", "1");
        maxround_input.setAttribute("min", "1");
        maxround_input.setAttribute("id", "maxround-".concat(index));
        maxround_input.setAttribute("size", "1");
        maxround_input.setAttribute("value", "50"); //Default value is 50
        new_spectrum_div.appendChild(maxround_label);
        new_spectrum_div.appendChild(maxround_input);

        /**
         * Add one buttons to call run_Voigt_fitter, with option 0,1, or 2
         * Disabled (enabled) if all_spectra[index].picked_peaks_object is empty (not empty)
         */
        let run_voigt_fitter_select = document.createElement("select");
        run_voigt_fitter_select.setAttribute("id", "run_voigt_fitter_select-".concat(index));
        let run_voigt_fitter_select_label = document.createElement("label");
        run_voigt_fitter_select_label.setAttribute("for", "run_voigt_fitter_select-".concat(index));
        run_voigt_fitter_select_label.innerText = " Peak profile: ";
        /**
         * Add 2 options: Voigt, Gaussian
         */
        let voigt_option = document.createElement("option");
        voigt_option.setAttribute("value", "0");
        voigt_option.innerText = "Voigt";
        run_voigt_fitter_select.appendChild(voigt_option);

        let gaussian_option = document.createElement("option");
        gaussian_option.setAttribute("value", "1");
        gaussian_option.innerText = "Gaussian";
        run_voigt_fitter_select.appendChild(gaussian_option);


        new_spectrum_div.appendChild(run_voigt_fitter_select_label);
        new_spectrum_div.appendChild(run_voigt_fitter_select);

        let run_voigt_fitter_button0 = document.createElement("button");
        run_voigt_fitter_button0.innerText = "Peak Fitting";
        run_voigt_fitter_button0.onclick = function () {
            /**
             * Get the value of run_voigt_fitter_options: 0, 1, or 2
             */
            let index = parseInt(this.id.split("-")[1]);
            let run_voigt_fitter_select = document.getElementById("run_voigt_fitter_select-".concat(index));
            let option = parseInt(run_voigt_fitter_select.value);
            run_Voigt_fitter(index, option);
        };
        if (all_spectra[index].picked_peaks_object === null || all_spectra[index].picked_peaks_object.column_headers.length === 0) {
            run_voigt_fitter_button0.disabled = true;
        }
        run_voigt_fitter_button0.setAttribute("id", "run_voigt_fitter-".concat(index));
        new_spectrum_div.appendChild(run_voigt_fitter_button0);


        /**
         * Add a new line
         */
        new_spectrum_div.appendChild(document.createElement("br"));
    }

    /**
     * Add a download button to download the picked peaks. 
     * Disabled (enabled) if all_spectra[index].picked_peaks_object is empty (not empty)
     */
    let download_peaks_button = document.createElement("button");
    download_peaks_button.innerText = "Download picked peaks";
    download_peaks_button.setAttribute("id", "download_peaks-".concat(index));
    download_peaks_button.onclick = function () { download_peaks(index, 'picked'); };
    new_spectrum_div.appendChild(download_peaks_button);



    if (new_spectrum.spectrum_origin >= 0 && new_spectrum.spectrum_origin < 10000) {
        /**
         * Add a download button to download the fitted peaks.
         * Disabled (enabled) if all_spectra[index].fitted_peaks_object is empty (not empty)
         */
        let download_fitted_peaks_button = document.createElement("button");
        download_fitted_peaks_button.innerText = "Download fitted peaks";
        download_fitted_peaks_button.setAttribute("id", "download_fitted_peaks-".concat(index));
        download_fitted_peaks_button.onclick = function () { download_peaks(index, 'fitted'); };
        new_spectrum_div.appendChild(download_fitted_peaks_button);
    }

    /**
     * Add a checkbox to show or hide the picked peaks. Default is unchecked
     * It has an event listener to show or hide the peaks
     */
    let show_peaks_checkbox = document.createElement("input");
    show_peaks_checkbox.setAttribute("type", "checkbox");
    show_peaks_checkbox.setAttribute("id", "show_peaks-".concat(index));
    show_peaks_checkbox.onclick = function (e) {
        /**
         * If the checkbox is checked, show the peaks
         */
        if (e.target.checked) {
            show_hide_peaks(index, 'picked', true);
        }
        else {
            show_hide_peaks(index, 'picked', false);
        }
    }
    new_spectrum_div.appendChild(show_peaks_checkbox);
    let show_peaks_label = document.createElement("label");
    show_peaks_label.setAttribute("for", "show_peaks-".concat(index));
    show_peaks_label.innerText = "Show picked peaks";
    new_spectrum_div.appendChild(show_peaks_label);

    if (new_spectrum.spectrum_origin >= 0 && new_spectrum.spectrum_origin < 10000) {
        /**
         * Add a checkbox to show or hide the fitted peaks. Default is unchecked
         */
        let show_fitted_peaks_checkbox = document.createElement("input");
        show_fitted_peaks_checkbox.setAttribute("type", "checkbox");
        show_fitted_peaks_checkbox.setAttribute("id", "show_fitted_peaks-".concat(index));
        show_fitted_peaks_checkbox.onclick = function (e) {
            /**
             * If the checkbox is checked, show the peaks
             */
            if (e.target.checked) {
                show_hide_peaks(index, 'fitted', true);
            }
            else {
                show_hide_peaks(index, 'fitted', false);
            }
        }
        if (all_spectra[index].fitted_peaks_object === null || all_spectra[index].fitted_peaks_object.column_headers.length === 0) {
            show_fitted_peaks_checkbox.disabled = true;
            download_fitted_peaks_button.disabled = true;
        }
        new_spectrum_div.appendChild(show_fitted_peaks_checkbox);
        let show_fitted_peaks_label = document.createElement("label");
        show_fitted_peaks_label.setAttribute("for", "show_fitted_peaks-".concat(index));
        show_fitted_peaks_label.innerText = "Show fitted peaks";
        new_spectrum_div.appendChild(show_fitted_peaks_label);

        let peak_profile_lw_label = document.createElement("label");
        peak_profile_lw_label.setAttribute("for", "peak_profile_line_width-".concat(index));
        peak_profile_lw_label.innerText = " Peak profile line width: ";
        new_spectrum_div.appendChild(peak_profile_lw_label);

        let peak_profile_lw_input = document.createElement("input");
        peak_profile_lw_input.setAttribute("type", "number");
        peak_profile_lw_input.setAttribute("id", "peak_profile_line_width-".concat(index));
        peak_profile_lw_input.setAttribute("min", "0.5");
        peak_profile_lw_input.setAttribute("max", "10");
        peak_profile_lw_input.setAttribute("step", "0.5");
        peak_profile_lw_input.setAttribute("value", main_plot.peak_profile_line_width || "1");
        peak_profile_lw_input.style.width = "50px";
        peak_profile_lw_input.oninput = function (e) {
            main_plot.set_peak_profile_line_width(parseFloat(this.value));
        };
        peak_profile_lw_input.onchange = function (e) {
            main_plot.set_peak_profile_line_width(parseFloat(this.value));
        };
        new_spectrum_div.appendChild(peak_profile_lw_input);

        let peak_size_label = document.createElement("label");
        peak_size_label.setAttribute("for", "peak_size_item-".concat(index));
        peak_size_label.innerText = " Peak symbol size: ";
        new_spectrum_div.appendChild(peak_size_label);

        let peak_size_input = document.createElement("input");
        peak_size_input.setAttribute("type", "number");
        peak_size_input.setAttribute("id", "peak_size_item-".concat(index));
        peak_size_input.setAttribute("min", "1");
        peak_size_input.setAttribute("max", "20");
        peak_size_input.setAttribute("step", "1");
        peak_size_input.setAttribute("value", main_plot.peak_size || "3");
        peak_size_input.style.width = "50px";
        const update_peak_size = function () {
            main_plot.peak_size = parseFloat(this.value) || 3;
            main_plot.redraw_peaks(1);
            let global_ps = document.getElementById("peak_size");
            if (global_ps && global_ps !== this) global_ps.value = this.value;
        };
        peak_size_input.oninput = update_peak_size;
        peak_size_input.onchange = update_peak_size;
        new_spectrum_div.appendChild(peak_size_input);
    }

    /**
     * Disable the download or show picked or fitted peaks buttons, depending on the state of the picked or fitted peaks
     */
    if (all_spectra[index].picked_peaks_object === null || all_spectra[index].picked_peaks_object.column_headers.length === 0) {
        show_peaks_checkbox.disabled = true;
        download_peaks_button.disabled = true;
    }

    /**
     * Add a new line
    */
    new_spectrum_div.appendChild(document.createElement("br"));


    /**
     * Add some spaces
     */
    new_spectrum_div.appendChild(document.createTextNode("  "));


    /**
     * Add a line break
     */
    new_spectrum_div.appendChild(document.createElement("br"));


    /**
     * For experimental spectra:
     * Add a h5 element to hold the title of "Reconstructed spectrum"
     * Add a ol element to hold reconstructed spectrum
     */
    if (new_spectrum.spectrum_origin < 0 || new_spectrum.spectrum_origin >= 10000) {
        let reconstructed_spectrum_h5 = document.createElement("h5");
        reconstructed_spectrum_h5.innerText = "Reconstructed spectrum";
        reconstructed_spectrum_h5.style.display = "none"; // Hide by default
        new_spectrum_div.appendChild(reconstructed_spectrum_h5);
        let reconstructed_spectrum_ol = document.createElement("ol");
        reconstructed_spectrum_ol.setAttribute("id", "reconstructed_spectrum_ol-".concat(index));
        reconstructed_spectrum_ol.style.display = "none"; // Hide by default
        new_spectrum_div.appendChild(reconstructed_spectrum_ol);
    }

    new_spectrum_div_list.appendChild(new_spectrum_div);

    /**
     * Add the new spectrum_1d div to the list of spectra if it is from experimental data
    */
    if (all_spectra[index].spectrum_origin < 0 || all_spectra[index].spectrum_origin >= 10000) {
        document.getElementById("spectra_list_ol").appendChild(new_spectrum_div_list);
    }
    /**
     * If the spectrum is reconstructed, add the new spectrum_1d div to the reconstructed spectrum list
     */
    else {
        let recon_list = document.getElementById("reconstructed_spectrum_ol-".concat(all_spectra[index].spectrum_origin));
        recon_list.appendChild(new_spectrum_div_list);
        // Show the list and header when data is added
        recon_list.style.display = "block";
        if (recon_list.previousElementSibling) {
            recon_list.previousElementSibling.style.display = "block";
        }
    }

    if (new_spectrum.spectrum_origin === -1 || new_spectrum.spectrum_origin === -2 || new_spectrum.spectrum_origin >= 10000) {
        total_number_of_experimental_spectra += 1;
    }
}




function resetzoom() {

    /**
     * this.xscale = [input.x_ppm_start, input.x_ppm_start + input.x_ppm_step * input.n_direct];
     * this.yscale = [input.y_ppm_start, input.y_ppm_start + input.y_ppm_step * input.n_indirect];
     */

    /**
     * Loop through all the spectra to get 
     * max of x_ppm_start and min of x_ppm_end (x_ppm_start + x_ppm_step * n_direct)
     * max of y_ppm_start and min of y_ppm_end (y_ppm_start + y_ppm_step * n_indirect)
     */
    let x_ppm_start = -1000.0;
    let x_ppm_end = 1000.0;
    let y_ppm_start = -1000.0;
    let y_ppm_end = 1000.0;

    for (let i = 0; i < all_spectra.length; i++) {
        if (all_spectra[i].x_ppm_start + all_spectra[i].x_ppm_ref > x_ppm_start) {
            x_ppm_start = all_spectra[i].x_ppm_start + + all_spectra[i].x_ppm_ref;
        }
        if (all_spectra[i].x_ppm_start + all_spectra[i].x_ppm_ref + all_spectra[i].x_ppm_step * all_spectra[i].n_direct < x_ppm_end) {
            x_ppm_end = all_spectra[i].x_ppm_start + all_spectra[i].x_ppm_step * all_spectra[i].n_direct + all_spectra[i].x_ppm_ref;
        }
        if (all_spectra[i].y_ppm_start + all_spectra[i].y_ppm_ref > y_ppm_start) {
            y_ppm_start = all_spectra[i].y_ppm_start + all_spectra[i].y_ppm_ref;
        }
        if (all_spectra[i].y_ppm_start + all_spectra[i].y_ppm_step * all_spectra[i].n_indirect + all_spectra[i].y_ppm_ref < y_ppm_end) {
            y_ppm_end = all_spectra[i].y_ppm_start + all_spectra[i].y_ppm_step * all_spectra[i].n_indirect + all_spectra[i].y_ppm_ref;
        }
    }

}


/**
 * Download spectrum
 *
 */
function download_spectrum(index, flag) {

    let data;
    let filename;


    filename = all_spectra[index].filename;
    /**
     * if filename has no extension, add .ft1
     */
    if (!filename.match(/\.\w+$/)) {
        filename += ".ft1";
    }
    /**
     * If extension is not ft1, replace it with .ft1
     */
    else if (!filename.toLowerCase().endsWith('.ft1')) {
        filename = filename.replace(/\.\w+$/, ".ft1");
    }


    /**
     * generate a blob, which is all_spectra[index].header + all_spectra[index].raw_data
     * case 1: both are real
     */
    if (all_spectra[index].datatype_direct === 1) {
        data = Float32Concat(all_spectra[index].header, all_spectra[index].raw_data);
    }
    else {
        data = new Float32Array(512 + all_spectra[index].n_direct * 2);
        let current_position = 0;
        data.set(all_spectra[index].header, current_position);
        current_position += 512;
        data.set(all_spectra[index].raw_data, current_position);
        current_position += all_spectra[index].n_direct;
        data.set(all_spectra[index].raw_data_i, current_position);
    }

    let blob = new Blob([data], { type: 'application/octet-stream' });
    let url = URL.createObjectURL(blob);
    let a = document.createElement('a');
    a.href = url;
    a.download = filename;
    a.click();
}

/**
 * Called when the user clicks the "Reprocess" button in the spectrum_1d list to reprocess
 * or quit reprocessing the spectrum.
 * @param {*} button: the button element that was clicked
 * @param {*} spectrum_index: the index of the spectrum in the all_spectra array
 */
function reprocess_spectrum(button, spectrum_index) {

    function set_fid_parameters(fid_process_parameters) {
        /**
         * Set fid_process_parameters to the input fields
         */
        document.getElementById("apodization_direct").value = fid_process_parameters.apodization_string;
        document.getElementById("zf_direct").value = fid_process_parameters.zf_direct;
        document.getElementById("phase_correction_direct_p0").value = fid_process_parameters.phase_correction_direct_p0.toFixed(2);
        document.getElementById("phase_correction_direct_p1").value = fid_process_parameters.phase_correction_direct_p1.toFixed(2);
        document.getElementById("auto_direct").checked = fid_process_parameters.auto_direct;
        document.getElementById("auto_direct_2").checked = fid_process_parameters.auto_direct_2;
        document.getElementById("auto_direct_3").checked = fid_process_parameters.auto_direct_3;
        document.getElementById("delete_imaginary").checked = fid_process_parameters.delete_imaginary;
    }

    function set_default_fid_parameters() {
        /**
         * Set fid_process_parameters to default values, preserving apodization and zero filling
         */
        document.getElementById("phase_correction_direct_p0").value = "0.0";
        document.getElementById("phase_correction_direct_p1").value = "0.0";
        document.getElementById("auto_direct").checked = false;
        document.getElementById("auto_direct_2").checked = true;
        document.getElementById("auto_direct_3").checked = false;
        document.getElementById("delete_imaginary").checked = false;
    }

    /**
     * Get button text
     */
    let button_text = button.innerText;
    /**
     * If the button text is "Edit FID processing", we need to prepare for reprocess the spectrum
     */
    if (button_text === "Edit FID processing") {
        /**
         * hide input fid files
         */
        document.getElementById("input_files").style.display = "none";
        /**
         * Set all_spectra[spectrum_index] as the current spectrum
         */
        document.getElementById("spectrum-" + spectrum_index).querySelector("div").style.backgroundColor = "lightblue";
        document.getElementById("input_options").style.backgroundColor = "lightgreen";
        /**
         * Change button text to "Quit editing"
         */
        button.innerText = "Quit editing";
        button.title = "Leave FID parameter editing mode and restore the default FID processing section. The spectrum is left unchanged.";
        /**
         * Hide div "file_area" and "input_files" (of fid_file_area). 
         * Change the button "button_fid_process" text to "Reprocess"
         */
        document.getElementById("file_area").style.display = "none";
        document.getElementById("input_files").style.display = "none";
        document.getElementById("button_fid_process").value = "Reprocess";

        /**
         * Copy saved save parameters to html elements
         * (because user may change the parameters in the input fields before reprocessing)
         */
        all_spectra[spectrum_index].fid_process_parameters.reprocess = true; //set reprocess to true
        set_fid_parameters(all_spectra[spectrum_index].fid_process_parameters);

        current_reprocess_spectrum_index = spectrum_index;
        set_current_spectrum(spectrum_index);
    }
    else {
        exit_reprocessing_ui(spectrum_index);
    }
}



/**
 * Add a new spectrum_1d to the list and update the contour plot. When contour is updated, add_to_list() is called to update the list of spectra
 * in the uses interface
 * @param {*} result_spectra: an array of object of hsqc_spectrum
 * @param {*} b_from_fid: boolean, whether the spectrum is from a fid file
 * @param {*} b_reprocess: boolean, whether this is a new spectrum_1d or a reprocessed spectrum
 * @returns 
 */
function draw_spectrum(result_spectra, b_from_fid, b_reprocess, b_ann_phase_correction = false) {

    let spectrum_index;

    if (b_from_fid == false && b_reprocess === false) {
        /**
         * New spectrum from ft1, set its index (current length of the spectral array) and color
         * It is also possible this is a reconstructed spectrum from peak fitting
         */
        spectrum_index = all_spectra.length;
        result_spectra[0].spectrum_index = spectrum_index;
        result_spectra[0].spectrum_color = rgbToHex(color_list[(spectrum_index) % color_list.length]);
        all_spectra.push(result_spectra[0]);

        /**
         * If result_spectra[0].spectrum_origin >=0, it means this is a reconstructed spectrum
         * we update the original spectrum's reconstructed_indices
         */
        if (result_spectra[0].spectrum_origin >= 0) {
            all_spectra[result_spectra[0].spectrum_origin].reconstructed_indices.push(spectrum_index);
        }
    }
    else if (b_from_fid === true && b_reprocess === false) {
        /**
         * New spectra from fid, set its index (current length of the spectral array) and color
         * It is possible that there are multiple spectra from a single fid file (pseudo 3D)
         */
        let first_spectrum_index = -1;
        for (let i = 0; i < result_spectra.length; i++) {
            result_spectra[i].spectrum_index = all_spectra.length;
            result_spectra[i].spectrum_color = rgbToHex(color_list[(result_spectra[i].spectrum_index) % color_list.length]);

            /**
             * For spectrum from fid, we need to include all FID files and processing parameters in the result_spectra object
             */
            if (i == 0) {
                fid_process_parameters.spectrum_index = result_spectra[i].spectrum_index; //set the spectrum index in fid_process_parameters
                result_spectra[i].fid_process_parameters = fid_process_parameters;
                first_spectrum_index = result_spectra[i].spectrum_index;
                result_spectra[i].spectrum_origin = -2; //from fid
            }
            else {
                result_spectra[i].spectrum_origin = 10000 + first_spectrum_index;
            }

            all_spectra.push(result_spectra[i]);
            if (b_ann_phase_correction === true) {
                /**
                 * Apply tfjs phase correction to the spectrum
                 */
                run_ann_phase_correction(all_spectra.length - 1);
            }
        }
        spectrum_index = first_spectrum_index; //set the spectrum index to the first spectrum index
    }
    else if (b_reprocess === true) {
        /**
         * Reprocessed spectrum, get its index and update the spectrum. 
         * Also, update the fid_process_parameters
         */
        spectrum_index = result_spectra[0].spectrum_index;
        result_spectra[0].fid_process_parameters = fid_process_parameters;
        result_spectra[0].spectrum_color = rgbToHex(color_list[(spectrum_index) % color_list.length]);
        all_spectra[spectrum_index] = result_spectra[0];
        if (b_ann_phase_correction === true) {
            /**
             * Apply tfjs phase correction to the spectrum
             */
            run_ann_phase_correction(spectrum_index);
        }
    }


    /**
     * initialize the plot with the first spectrum. This function only run once
     */
    if (b_plot_initialized === false) {
        b_plot_initialized = true;
        main_plot = new myplot_1d(); //the plot object
        document.getElementById("plot_1d").style.display = "block"; //show the plot
        document.getElementById("plot_1d").style.width = "1200px";
        document.getElementById("plot_1d").style.height = "800px";
        const cr = document.getElementById("plot_1d").getBoundingClientRect();
        /**
         * Initialize the plot 
         * and draw the first spectrum.
         * main_plot will read result_spectra[0].raw_data and result_spectra[0].raw_data_i (if complex)
         * to fill the data
         */
        let peak_params = {
            peak_color: document.getElementById("peak_color").value,
            peak_size: parseFloat(document.getElementById("peak_size").value),
            peak_thickness: parseFloat(document.getElementById("peak_thickness").value),
            filled_peaks: document.getElementById("filled_peaks").checked,

        };
        main_plot.init(cr.width, cr.height, peak_params, update_reconstructed_peaks_debounced);

        /**
         * When initializing the plot, we also initialize the BroadcastChannel
         */
        inter_window_channel = new BroadcastChannel('plot_ppm_region');
        /**
         * Listen to channel message from other windows
         */
        inter_window_channel.onmessage = (event) => {

            console.log('Received message from other window:', event.data);

            /**
             * Get plot_group number (from 1 to 10)
             */
            let peak_group = document.getElementById("plot_group").value;

            if (event.data.type === '1d_zoom' && event.data.peak_group === peak_group) {
                if (main_plot !== null) {
                    main_plot.zoom_to(event.data.xscale);
                }
            }
            else if (event.data.type === '2d_zoom' && event.data.peak_group === peak_group) {
                if (main_plot !== null) {
                    /**
                     * For some reason, event.data.xscale from 2D plot is in ascending order, we need to switch
                     * before passing to main_plot.zoom_to()
                     */
                    let xscale = [event.data.xscale[1], event.data.xscale[0]];
                    main_plot.zoom_to(xscale);
                }
            }
        }
        main_plot.inter_window_channel = inter_window_channel;

        /**
         * Add first spectrum to the plot (result_spectra[0] is the first spectrum)
         * We need to make a data array of two numbers: ppm and amplitude
         */
        let data = [];
        if (result_spectra[0].raw_data_i.length === result_spectra[0].raw_data.length) {
            for (let i = 0; i < result_spectra[0].n_direct; i++) {
                data.push([result_spectra[0].x_ppm_start + result_spectra[0].x_ppm_step * i, result_spectra[0].raw_data[i], result_spectra[0].raw_data_i[i]]);
            }
        }
        else {
            for (let i = 0; i < result_spectra[0].n_direct; i++) {
                data.push([result_spectra[0].x_ppm_start + result_spectra[0].x_ppm_step * i, result_spectra[0].raw_data[i]]);
            }
        }
        main_plot.add_data(data, result_spectra[0].spectrum_index, result_spectra[0].spectrum_color);

        plot_div_resize_observer.observe(document.getElementById("plot_1d"));
    }
    else {
        let data = [];
        if (result_spectra[0].raw_data_i.length === result_spectra[0].raw_data.length) {
            for (let i = 0; i < result_spectra[0].n_direct; i++) {
                data.push([result_spectra[0].x_ppm_start + result_spectra[0].x_ppm_step * i, result_spectra[0].raw_data[i], result_spectra[0].raw_data_i[i]]);
            }
        }
        else {
            for (let i = 0; i < result_spectra[0].n_direct; i++) {
                data.push([result_spectra[0].x_ppm_start + result_spectra[0].x_ppm_step * i, result_spectra[0].raw_data[i]]);
            }
        }
        main_plot.add_data(data, result_spectra[0].spectrum_index, result_spectra[0].spectrum_color);
    }

    if (b_reprocess === false) {
        add_to_list(spectrum_index, b_from_fid, b_reprocess);
    }

}


/**
 * Concat two float32 arrays into one
 * @returns the concatenated array
 */
function Float32Concat(first, second) {
    var firstLength = first.length,
        result = new Float32Array(firstLength + second.length);

    result.set(first);
    result.set(second, firstLength);

    return result;
}



/**
 * Convert an RGB array to a hexadecimal string
 */
function rgbToHex(rgb) {
    return "#" + ((1 << 24) + (Math.round(rgb[0] * 255) << 16) + (Math.round(rgb[1] * 255) << 8) + Math.round(rgb[2] * 255)).toString(16).slice(1);
}

/**
 * Convert a hexadecimal string to an RGB array
 */
function hexToRgb(hex) {

    /**
     * Backward compatibility for old hex color format
     * In old version, hex might be [0,0,1,1] (rgba)
     * then we return as [0,0, ]
     */
    if (hex.length === 4) {
        return hex;
    }



    let r = parseInt(hex.substring(1, 3), 16) / 255;
    let g = parseInt(hex.substring(3, 5), 16) / 255;
    let b = parseInt(hex.substring(5, 7), 16) / 255;
    return [r, g, b, 1.0];
}

/**
 * Convert SVG to PNG code
 */
const dataHeader = 'data:image/svg+xml;charset=utf-8';


const loadImage = async url => {
    const $img = document.createElement('img')
    $img.src = url
    return new Promise((resolve, reject) => {
        $img.onload = () => resolve($img)
        $img.onerror = reject
    })
}

const serializeAsXML = $e => (new XMLSerializer()).serializeToString($e);
const encodeAsUTF8 = s => `${dataHeader},${encodeURIComponent(s)}`;

async function download_plot() {
    /**
     * Generate a link to download main_plot as a SVG file
     * The top SVG element has id = "main_plot"
     */
    var svgElement = document.getElementById("main_plot");
    if (!svgElement) {
        console.error("SVG element 'main_plot' not found.");
        return;
    }
    var svgData = serializeAsXML(svgElement);
    if (!svgData.startsWith('<?xml')) {
        svgData = '<?xml version="1.0" encoding="UTF-8" standalone="no"?>\n' + svgData;
    }
    var svgBlob = new Blob([svgData], { type: "image/svg+xml;charset=utf-8" });
    var svgUrl = URL.createObjectURL(svgBlob);
    var downloadLink = document.createElement("a");
    downloadLink.href = svgUrl;
    downloadLink.download = "colmar-vista.svg";
    document.body.appendChild(downloadLink);
    downloadLink.click();
    document.body.removeChild(downloadLink);
    URL.revokeObjectURL(svgUrl);
}

/**
 * Load a peak list to a spectrum
 */
function load_peak_list(spectrum_index) {
    /**
     * Get the file input element with ID "run_load_peak_list-"+spectrum_index
     */
    let file_input = document.getElementById("run_load_peak_list-" + spectrum_index);
    if (file_input.files.length === 0) {
        return;
    }

    let file = file_input.files[0];
    let reader = new FileReader();
    reader.onload = function (e) {
        let peak_list = new cpeaks();
        /**
         * Check file name extension, if it is .tab, load it as tab file, else if it is .list, load it as
         */
        if (file.name.endsWith(".tab") || file.name.endsWith(".list")) {
            if (file.name.endsWith(".tab")) {
                peak_list.process_peaks_tab(e.target.result);
            }
            else {
                peak_list.process_peaks_list(e.target.result);
            }
            all_spectra[spectrum_index].picked_peaks_object = peak_list;

            /**
             * when picked peaks are received, fitted peaks need to be reset
             */
            all_spectra[spectrum_index].fitted_peaks_object = null;
            /**
             * Disable the download fitted peaks button. Uncheck the show fitted peaks checkbox, disable it too
             */
            disable_enable_fitted_peak_buttons(spectrum_index, 0);
            /**
             * When peaks are loaded, set default scale and scale2 for peak fitting
             */
            all_spectra[spectrum_index].scale = 5.5;
            all_spectra[spectrum_index].scale2 = 3.5;

            disable_enable_peak_buttons(spectrum_index, 1);

            document.getElementById("show_peaks-".concat(spectrum_index)).checked = false;
            document.getElementById("show_peaks-".concat(spectrum_index)).click();
        }
        else {
            console.log("Unsupported peak file format");
        }
    };
    reader.readAsText(file);
}

/**
 * Disable or enable buttons of download_peaks-, run_deep_picker-, run_voigt_fitter-, show_peaks-
 */
function disable_enable_peak_buttons(spectrum_index, flag) {
    if (flag === 0 || flag === 2) {
        /**
         * Disable the buttons to run deep picker and voigt fitter
         */
        document.getElementById("download_peaks-".concat(spectrum_index)).disabled = true;
        document.getElementById("run_load_peak_list-".concat(spectrum_index)).disabled = true;
        document.getElementById("run_deep_picker-".concat(spectrum_index)).disabled = true;
        document.getElementById("run_voigt_fitter-".concat(spectrum_index)).disabled = true;
        if (flag === 0) {
            document.getElementById("show_peaks-".concat(spectrum_index)).disabled = true;
            document.getElementById("show_peaks-".concat(spectrum_index)).checked = false;
        }
    }
    else if (flag === 1) {
        /**
         * Enable the buttons to run deep picker and voigt fitter
         */
        document.getElementById("download_peaks-".concat(spectrum_index)).disabled = false;
        document.getElementById("run_load_peak_list-".concat(spectrum_index)).disabled = false;
        document.getElementById("run_deep_picker-".concat(spectrum_index)).disabled = false;
        document.getElementById("run_voigt_fitter-".concat(spectrum_index)).disabled = false;
        document.getElementById("show_peaks-".concat(spectrum_index)).disabled = false;
    }
}



function check_and_apply_manual_phase() {
    if (main_plot && main_plot.current_actively_corrected_spectrum_index !== -1) {
        permanently_apply_phase_correction();
    }
}

/**
 * Call DEEP Picker to run peaks picking the spectrum
 * @param {int} spectrum_index: index of the spectrum in all_spectra array
 * @param {int} flag: 0 for DEEP Picker, 1 for Simple Picker
 */
function run_DEEP_Picker(spectrum_index, flag) {
    check_and_apply_manual_phase();
    disable_enable_peak_buttons(spectrum_index, 0);
    disable_enable_fitted_peak_buttons(spectrum_index, 0);

    /**
     * Combine all_spectra[0].raw_data and all_spectra[0].header into one Float32Array
     * Need to copy the header first, modify complex flag (doesn't hurt even when not necessary), then concatenate with raw_data
     */
    let header = new Float32Array(all_spectra[spectrum_index].header);
    header[55] = 1.0; //keep real part only
    header[56] = 1.0; //keep real part only
    header[99] = all_spectra[spectrum_index].n_direct; //size of indirect dimension of the input spectrum
    header[219] = all_spectra[spectrum_index].n_indirect; //size of indirect dimension of the input spectrum


    /**
     * Get noise_level of the spectrum
     * And current lowest contour level of the spectrum
     * Calculate scale as lowest contour level / noise_level
     * and scale2 as 0.6 * scale
     */
    let noise_level = all_spectra[spectrum_index].noise_level;
    let scale = parseFloat(document.getElementById("scale1-".concat(spectrum_index)).value);
    let scale2 = 0.6 * scale;


    webassembly_1d_worker_2.postMessage({
        [WEBASSEMBLY_JOB_KEY]: "peak_picker_1d",
        spectrum_header: header, //float32 array
        spectrum_data: all_spectra[spectrum_index].raw_data, //float32 array
        spectrum_index: spectrum_index,
        scale: scale,
        scale2: scale2,
        noise_level: noise_level,
        mod: 2,
    });

    /**
     * Let user know the processing is started
     */
    document.getElementById("webassembly_message").innerText = "Run DEEP Picker, please wait...";

}

/**
 * Call Voigt fitter to run peak fitting on the spectrum
 * @param {int} spectrum_index: index of the spectrum in all_spectra array
 */
function run_Voigt_fitter(spectrum_index, flag) {
    check_and_apply_manual_phase();
    /**
     * Disable the buttons to run deep picker and voigt fitter
     */
    disable_enable_peak_buttons(spectrum_index, 2);
    disable_enable_fitted_peak_buttons(spectrum_index, 0);

    /**
     * Get maxround input field with ID "maxround-"+spectrum_index
     */
    let maxround = parseInt(document.getElementById("maxround-" + spectrum_index).value);

    /**
     * Get peak combine cutoff
     */
    let peak_combine_cutoff = parseFloat(document.getElementById("peak_combine_cutoff-" + spectrum_index).value);


    /**
     * Get subset of the picked peaks (within visible region)
     * start < end from the get_visible_region function call
     */
    [x_ppm_visible_start, x_ppm_visible_end] = main_plot.get_visible_region();

    /**
     * Get a copy of the picked peaks, so that we can filter it
     */
    let picked_peaks_copy = new cpeaks();
    picked_peaks_copy.copy_data(all_spectra[spectrum_index].picked_peaks_object);
    picked_peaks_copy.filter_by_column_range("X_PPM", x_ppm_visible_start, x_ppm_visible_end);

    let picked_peaks_copy_tab = picked_peaks_copy.save_peaks_tab();

    /**
     * Make sure x_ppm_visible_start > x_ppm_visible_end
     */
    if (x_ppm_visible_start < x_ppm_visible_end) {
        let temp = x_ppm_visible_start;
        x_ppm_visible_start = x_ppm_visible_end;
        x_ppm_visible_end = temp;
    }


    /**
     * Combine all_spectra[spectrum_index].raw_data and all_spectra[spectrum_index].header into one Float32Array
     * Need to copy the header first, modify complex flag (doesn't hurt even when not necessary), then concatenate with raw_data
     */
    let header = new Float32Array(all_spectra[spectrum_index].header);
    header[55] = 1.0;
    header[56] = 1.0;
    header[219] = all_spectra[spectrum_index].n_indirect; //size of indirect dimension of the input spectrum
    header[99] = all_spectra[spectrum_index].n_direct; //size of direct dimension of the input spectrum


    webassembly_1d_worker_2.postMessage({
        [WEBASSEMBLY_JOB_KEY]: "peak_fitter_1d",
        spectrum_header: header, //float32 array
        spectrum_data: all_spectra[spectrum_index].raw_data, //float32 array
        picked_peaks: picked_peaks_copy_tab,
        spectrum_begin: x_ppm_visible_start,
        spectrum_end: x_ppm_visible_end,
        spectrum_index: spectrum_index,
        maxround: maxround,
        peak_combine_cutoff: peak_combine_cutoff,
        flag: flag, //0: Voigt, 1: Gaussian
        scale: all_spectra[spectrum_index].scale,
        scale2: all_spectra[spectrum_index].scale2,
        noise_level: all_spectra[spectrum_index].noise_level
    });
    /**
     * Let user know the processing is started
     */
    document.getElementById("webassembly_message").innerText = "Run Peak fitting, please wait...";
}

/**
 * Disable or enable buttons for download_fitted_peaks and show_fitted_peaks
 * @param {int} spectrum_index: index of the spectrum in all_spectra array
 * @param {int} flag: 0 to disable, 1 to enable
 */
function disable_enable_fitted_peak_buttons(spectrum_index, flag) {
    /**
     * (new_spectrum.spectrum_origin >= 0 && new_spectrum.spectrum_origin < 10000) means reconstructed spectrum
     */
    let b_reconstructed = (all_spectra[spectrum_index].spectrum_origin >= 0 && all_spectra[spectrum_index].spectrum_origin < 10000);

    if (flag == 0 && b_reconstructed) {
        document.getElementById("download_fitted_peaks-".concat(spectrum_index)).disabled = true;
        document.getElementById("show_fitted_peaks-".concat(spectrum_index)).disabled = true;
        document.getElementById("show_fitted_peaks-".concat(spectrum_index)).checked = false;
    }
    else if (flag == 1) {
        if (b_reconstructed === true) {
            document.getElementById("download_fitted_peaks-".concat(spectrum_index)).disabled = false;
            document.getElementById("show_fitted_peaks-".concat(spectrum_index)).disabled = false;
        }
        else {
            /**
             * Enable run deep picker and run voigt fitter buttons (allow run again)
             */
            document.getElementById("run_load_peak_list-".concat(spectrum_index)).disabled = false;
            document.getElementById("run_deep_picker-".concat(spectrum_index)).disabled = false;
            document.getElementById("run_voigt_fitter-".concat(spectrum_index)).disabled = false;
        }
    }
}

/**
 * Show or hide peaks on the plot
 */
function show_hide_peaks(index, flag, b_show) {
    /**
     * Turn off checkbox of all other spectra
     */
    for (let i = 0; i < all_spectra.length; i++) {
        const b_reconstructed = (all_spectra[i].spectrum_origin >= 0 && all_spectra[i].spectrum_origin < 10000);
        if (i !== index) {
            document.getElementById("show_peaks-" + i).checked = false;
            if (b_reconstructed) {
                document.getElementById("show_fitted_peaks-" + i).checked = false;
            }
        }
        /**
         * uncheck the checkbox of the current spectrum
         */
        else {
            if (flag === 'picked') {
                if (b_reconstructed) {
                    document.getElementById("show_fitted_peaks-" + i).checked = false;
                }
            }
            else if (flag === 'fitted') {
                document.getElementById("show_peaks-" + i).checked = false;
            }
        }
    }

    if (b_show) {
        current_spectrum_index_of_peaks = index;
        set_current_spectrum(index);
        current_flag_of_peaks = flag;
        show_peak_table();
        main_plot.remove_peaks();

        if (flag === 'picked') {
            main_plot.add_peaks(all_spectra[index].picked_peaks_object, 'picked');
        }
        else {
            main_plot.add_peaks(all_spectra[index].fitted_peaks_object, 'fitted');
            update_reconstructed_peaks(current_spectrum_index_of_peaks);
        }
    }
    else {
        current_spectrum_index_of_peaks = -1; // -1 means no spectrum is selected. flag is not important
        main_plot.remove_peaks();
        remove_peak_table();
    }
}

// [Shared Module] update_reconstructed_peaks & update_reconstructed_peaks_debounced loaded from js/shared/voigt_reconstruction.js

function download_peaks(spectrum_index, flag) {
    let file_buffer;

    if (flag === 'picked') {
        file_buffer = all_spectra[spectrum_index].picked_peaks_object.save_peaks_tab();
    }
    else if (flag === 'fitted') {
        file_buffer = all_spectra[spectrum_index].fitted_peaks_object.save_peaks_tab();
    }

    let blob = new Blob([file_buffer], { type: 'text/plain' });
    let url = URL.createObjectURL(blob);
    let a = document.createElement('a');
    a.href = url;
    a.download = all_spectra[spectrum_index].filename + ".tab";
    a.click();

    /**
     * Remove the url and a
     */
    URL.revokeObjectURL(url);
    a.remove();
}




/**
 * Clear the textarea log
 */
function clear_log() {
    document.getElementById("log").value = "";
}

/**
 * Save the current textarea log to a file
 */
function download_log() {
    let log = document.getElementById("log").value;
    let blob = new Blob([log], { type: 'text/plain' });
    let url = URL.createObjectURL(blob);
    let a = document.createElement('a');
    a.href = url;
    a.download = "log.txt";
    a.click();

    /**
     * Remove the url and a
     */
    URL.revokeObjectURL(url);
    a.remove();
}

function update_line_color(e, index) {
    let color = e.target.value;  //hex format
    all_spectra[index].spectrum_color = (color);
    main_plot.update_spectrum_color(index, color);
}

function update_line_width(e, index) {
    let width = parseFloat(e.target.value);
    main_plot.update_spectrum_line_width(index, width);
}

/**
 * Onclick event from save button
*/
function save_to_file() {
    /**
     * Step 1, prepare the json data. Convert all_spectra to a all_spectra_copy
     * where in each spectrum object, we call create_shallow_copy_wo_float32 to have a shallow (modified) copy of the spectrum
     */
    let all_spectra_copy = [];
    for (let i = 0; i < all_spectra.length; i++) {
        let spectrum_copy = all_spectra[i].create_shallow_copy_wo_float32();
        all_spectra_copy.push(spectrum_copy);
    }

    let to_save = {
        all_spectra: all_spectra_copy,
    };

    /**
     * Step 2, prepare the binaryData, which is a concatenation of all 
     *  header, raw_data, raw_data_i
     */
    let totalLength = 0;
    for (let i = 0; i < all_spectra.length; i++) {
        totalLength += all_spectra[i].header.length + all_spectra[i].raw_data.length + all_spectra[i].raw_data_i.length;
    }

    const jsonString = JSON.stringify(to_save);
    const jsonBytes = new TextEncoder().encode(jsonString);
    const jsonLength = jsonBytes.length;

    // Create a DataView to write the length as an Int32:
    const lengthBuffer = new ArrayBuffer(4);
    const lengthView = new DataView(lengthBuffer);
    lengthView.setInt32(0, jsonLength, true); // true for little-endian

    // Combine length, JSON, and binary data:
    const combinedBuffer = new ArrayBuffer(4 + jsonLength + totalLength * Float32Array.BYTES_PER_ELEMENT);
    const combinedView = new Uint8Array(combinedBuffer);

    console.log("Length of length: 4, Length of JSON data: " + jsonLength);
    console.log("Total length of binary data: " + totalLength * Float32Array.BYTES_PER_ELEMENT);

    combinedView.set(new Uint8Array(lengthBuffer), 0);
    combinedView.set(jsonBytes, 4);
    /**
     * Step 3, copy all binary data into combinedView
     */
    let offset = 4 + jsonLength;
    for (let i = 0; i < all_spectra.length; i++) {
        combinedView.set(new Uint8Array(all_spectra[i].header.buffer, 0, 2048), offset);
        console.log("all_spectra[i].header.length: " + all_spectra[i].header.length);
        console.log("set header at offset " + offset);
        offset += all_spectra[i].header.length * Float32Array.BYTES_PER_ELEMENT;
        combinedView.set(new Uint8Array(all_spectra[i].raw_data.buffer, 0, all_spectra[i].raw_data.length * 4), offset);
        console.log("set raw_data at offset " + offset);
        offset += all_spectra[i].raw_data.length * Float32Array.BYTES_PER_ELEMENT;
        combinedView.set(new Uint8Array(all_spectra[i].raw_data_i.buffer, 0, all_spectra[i].raw_data_i.length * 4), offset);
        console.log("set raw_data_i at offset " + offset);
        offset += all_spectra[i].raw_data_i.length * Float32Array.BYTES_PER_ELEMENT;
        console.log("After saving spectrum " + i + ", offset is " + offset);
    }

    // Create Blob and download:
    const blob = new Blob([combinedBuffer], { type: "application/octet-stream" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = "colmarvista1d.save";
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
};

/**
 * Async function to load all_spectra from a file
 */
async function loadBinaryAndJsonWithLength(arrayBuffer) {

    const uint8Array = new Uint8Array(arrayBuffer);

    // Read the length of the JSON data (first 4 bytes)
    const jsonLength = new DataView(arrayBuffer).getInt32(0, true); // true for little-endian
    console.log("Length of JSON data: " + jsonLength);

    // Extract the JSON data
    const jsonBytes = uint8Array.slice(4, 4 + jsonLength);
    const jsonString = new TextDecoder().decode(jsonBytes);
    let to_save = JSON.parse(jsonString);

    all_spectra = to_save.all_spectra;

    /**
     * backward compatibility: if any spectrum doesn't have spectrum_scale, assign 1.0 to it
     */
    for (let i = 0; i < all_spectra.length; i++) {
        if (!all_spectra[i].hasOwnProperty('spectrum_scale')) {
            all_spectra[i].spectrum_scale = 1.0;
        }
    }

    /**
     * Change spectrum_origin from -2 to -1 for all spectra loaded from file
     * because we do not save/load fid data
     */
    for (let i = 0; i < all_spectra.length; i++) {
        if (all_spectra[i].spectrum_origin === -2) {
            all_spectra[i].spectrum_origin = -1;
        }
    }

    /**
     * Reattach methods defined in spectrum.js to all all_spectra objects
     */
    for (let i = 0; i < all_spectra.length; i++) {
        /**
         * Loop all methods of class spectrum_1d and attach them to the all_spectra[i] object
         */
        let spectrum_methods = Object.getOwnPropertyNames(spectrum_1d.prototype);
        for (let j = 0; j < spectrum_methods.length; j++) {
            if (spectrum_methods[j] !== 'constructor') {
                all_spectra[i][spectrum_methods[j]] = spectrum_1d.prototype[spectrum_methods[j]];
            }
        }
        /**
         * For all_spectra[i].fitted_peaks_object and picked_peaks_object, we need to reattach methods as well
         */
        if (all_spectra[i].picked_peaks_object !== null && all_spectra[i].picked_peaks_object.column_headers.length > 0) {
            let peaks_methods = Object.getOwnPropertyNames(cpeaks.prototype);
            for (let j = 0; j < peaks_methods.length; j++) {
                if (peaks_methods[j] !== 'constructor') {
                    all_spectra[i].picked_peaks_object[peaks_methods[j]] = cpeaks.prototype[peaks_methods[j]];
                }
            }
        }
        if (all_spectra[i].fitted_peaks_object !== null && all_spectra[i].fitted_peaks_object.column_headers.length > 0) {
            let peaks_methods = Object.getOwnPropertyNames(cpeaks.prototype);
            for (let j = 0; j < peaks_methods.length; j++) {
                if (peaks_methods[j] !== 'constructor') {
                    all_spectra[i].fitted_peaks_object[peaks_methods[j]] = cpeaks.prototype[peaks_methods[j]];
                }
            }
        }
    }


    // Now we need to extract the binary data
    let offset = 4 + jsonLength;
    for (let m = 0; m < all_spectra.length; m++) {
        all_spectra[m].header = new Float32Array(arrayBuffer.slice(offset, offset + all_spectra[m].header_length * Float32Array.BYTES_PER_ELEMENT));
        console.log("all_spectra[m].header_length: " + all_spectra[m].header_length);
        console.log('load header at offset ' + offset);
        offset += all_spectra[m].header_length * Float32Array.BYTES_PER_ELEMENT;

        all_spectra[m].raw_data = new Float32Array(arrayBuffer.slice(offset, offset + all_spectra[m].raw_data_length * Float32Array.BYTES_PER_ELEMENT));
        console.log('load raw_data at offset ' + offset);
        offset += all_spectra[m].raw_data_length * Float32Array.BYTES_PER_ELEMENT;

        all_spectra[m].raw_data_i = new Float32Array(arrayBuffer.slice(offset, offset + all_spectra[m].raw_data_i_length * Float32Array.BYTES_PER_ELEMENT));
        console.log('load raw_data_i at offset ' + offset);
        offset += all_spectra[m].raw_data_i_length * Float32Array.BYTES_PER_ELEMENT;
        console.log("After loading spectrum " + m + ", offset is " + offset);

        if (b_plot_initialized === false) {
            b_plot_initialized = true;
            main_plot = new myplot_1d(); //the plot object
            document.getElementById("plot_1d").style.display = "block"; //show the plot
            document.getElementById("plot_1d").style.width = "1200px";
            document.getElementById("plot_1d").style.height = "800px";
            const cr = document.getElementById("plot_1d").getBoundingClientRect();
            /**
             * Initialize the plot 
             * and draw the first spectrum.
             * main_plot will read result_spectra[0].raw_data and result_spectra[0].raw_data_i (if complex)
             * to fill the data
             */
            let peak_params = {
                peak_color: document.getElementById("peak_color").value,
                peak_size: parseFloat(document.getElementById("peak_size").value),
                peak_thickness: parseFloat(document.getElementById("peak_thickness").value),
                filled_peaks: document.getElementById("filled_peaks").checked,

            };
            main_plot.init(cr.width, cr.height, peak_params, update_reconstructed_peaks_debounced);
            /**
             * When initializing the plot, we also initialize the BroadcastChannel
             */
            inter_window_channel = new BroadcastChannel('plot_ppm_region');
            /**
             * Listen to channel message from other windows
             */
            inter_window_channel.onmessage = (event) => {
                /**
                 * Get plot_group number (from 1 to 10)
                 */
                let peak_group = document.getElementById("plot_group").value;

                if (event.data.type === '1d_zoom' && event.data.peak_group === peak_group) {
                    if (main_plot !== null) {
                        main_plot.zoom_to(event.data.xscale);
                    }
                }
                else if (event.data.type === '2d_zoom' && event.data.peak_group === peak_group) {
                    /**
                     * From 2d, we need to swap xscale[0] and xscale[1]
                     */
                    let xscale = [event.data.xscale[1], event.data.xscale[0]];
                    if (main_plot !== null) {
                        main_plot.zoom_to(xscale);
                    }
                }
            }
            main_plot.inter_window_channel = inter_window_channel;

            /**
             * Add first spectrum to the plot (result_spectra[0] is the first spectrum)
             * We need to make a data array of two numbers: ppm and amplitude
             */
            let data = [];
            if (all_spectra[m].raw_data_i.length === all_spectra[m].raw_data.length) {
                for (let i = 0; i < all_spectra[m].n_direct; i++) {
                    data.push([all_spectra[m].x_ppm_start + all_spectra[m].x_ppm_step * i, all_spectra[m].raw_data[i], all_spectra[m].raw_data_i[i]]);
                }
            }
            else {
                for (let i = 0; i < all_spectra[m].n_direct; i++) {
                    data.push([all_spectra[m].x_ppm_start + all_spectra[m].x_ppm_step * i, all_spectra[m].raw_data[i]]);
                }
            }
            main_plot.add_data(data, all_spectra[m].spectrum_index, all_spectra[m].spectrum_color);

            plot_div_resize_observer.observe(document.getElementById("plot_1d"));
        }
        else {
            let data = [];
            if (all_spectra[m].raw_data_i.length === all_spectra[m].raw_data.length) {
                for (let i = 0; i < all_spectra[m].n_direct; i++) {
                    data.push([all_spectra[m].x_ppm_start + all_spectra[m].x_ppm_step * i, all_spectra[m].raw_data[i], all_spectra[m].raw_data_i[i]]);
                }
            }
            else {
                for (let i = 0; i < all_spectra[m].n_direct; i++) {
                    data.push([all_spectra[m].x_ppm_start + all_spectra[m].x_ppm_step * i, all_spectra[m].raw_data[i]]);
                }
            }
            main_plot.add_data(data, all_spectra[m].spectrum_index, all_spectra[m].spectrum_color);
        }
        add_to_list(m, false, false);
    }


};

function zoom_to_peak(index) {
    let peaks_object = get_current_peak_object();

    /**
     * Get the peak position (column X_PPM and Y_PPM)
     */
    let x_ppm = peaks_object.get_column_by_header('X_PPM')[index];

    let x_ppm_scale = [x_ppm - 0.1, x_ppm + 0.1];

    main_plot.zoom_to(x_ppm_scale);

}


function remove_peak_table() {
    let peak_area = document.getElementById('peak_area');
    let table = peak_area.getElementsByTagName('table')[0];

    /**
     * Remove all children from the table
     */
    table.removeEventListener('click', table_click_handler);
    while (table.firstChild) {
        table.removeChild(table.firstChild);
    }

    /**
     * Hide the peak_area
     */
    peak_area.style.display = "none";
}

function get_current_peak_object() {
    let peaks_object;
    if (current_spectrum_index_of_peaks === -1) {
        return;
    }
    else if (current_spectrum_index_of_peaks === -2) {
        peaks_object = pseudo3d_fitted_peaks_object;
    }
    else {
        if (current_flag_of_peaks === 'picked') {
            peaks_object = all_spectra[current_spectrum_index_of_peaks].picked_peaks_object;
        }
        else if (current_flag_of_peaks === 'fitted') {
            peaks_object = all_spectra[current_spectrum_index_of_peaks].fitted_peaks_object;
        }
    }
    return peaks_object;
}


function show_peak_table() {
    /**
     * Step 1, clear current peak_table.
     * Get peak_area's all table children and remove them
     */
    let peak_area = document.getElementById('peak_area');
    let table = peak_area.getElementsByTagName('table')[0];
    let peaks_object = get_current_peak_object();

    /**
     * Remove old event listener
     */
    table.removeEventListener('click', table_click_handler);
    /**
     * Remove all children from the table
     */
    while (table.firstChild) {
        table.removeChild(table.firstChild);
    }

    /**
     * Create a new table from peaks_object
     * all children of the table will be replaced
     * @param peaks_object: the peaks object to be displayed
     * @param table: the HTML table element to be replaced
     */
    createTable_from_peak(peaks_object, table);
    new Tablesort(table); //make all rows sortable


    /**
     * Add new event listener
     * This will call table_click_handler when a row is clicked
     */
    table.addEventListener('click', table_click_handler);

    /**
     * Show the peak_area. If its height is too larger > 600px, set it to 600px
     */
    peak_area.style.display = "block";
    if (peak_area.clientHeight > 600) {
        peak_area.style.height = "600px";
    }
    else {
        peak_area.style.height = "auto";
    }
}

function table_click_handler(event) {
    const row = event.target.closest('tr'); // Find the closest 'tr' element
    if (row) {
        // Row was clicked!
        let tds = row.getElementsByTagName("td");
        if (tds.length < 1) {
            /**
             * If the clicked row has no td elements, do nothing
             * (such as the header row)
             */
            return;
        }
        /**
         * Get the clicked cell. If classes of the cell includes "editable_cell", convert it to input
         * to update the value.
         */
        let cell = event.target.closest('td');
        if (cell && cell.classList.contains("editable_cell")) {
            const originalText = cell.textContent;
            const input = document.createElement('input');
            input.value = originalText;

            cell.innerHTML = '';
            cell.appendChild(input);
            input.focus();

            input.addEventListener('blur', handleEdit);
            input.addEventListener('keydown', (e) => {
                if (e.key === 'Enter') {
                    handleEdit(e);
                }
            });

            function handleEdit(event) {
                const newText = event.target.value;
                cell.textContent = newText;
                /**
                 * Need to update the peaks_object as well
                 */
                let peak_index = parseInt(tds[0].innerText);
                let peaks_object = get_current_peak_object();
                if (peak_index > 0) {
                    peaks_object.set_column_row_value('ASS', peak_index - 1, newText);
                    /**
                     * Need to ask main_plot to update as well.
                     * Because main_plot.new_peaks is a copy of peaks_object
                     */
                    if (main_plot !== null) {
                        main_plot.update_peak_ass_property(peak_index, newText);
                    }
                }
            }
        }
        else {
            /**
             * Zoom to the peak, using the first column of the row to get the peak index
             */
            let peak_index = parseInt(tds[0].innerText);
            console.log('peak_index:', peak_index);
            zoom_to_peak(peak_index - 1); // Call zoom_to_peak with the row index
        }

    }
};

/**
 * Search text from all fields of the peak_table
 * scrollToTableRow if found and highlight the row with yellow background color then remove it after 3 seconds
 */
function search_peak() {
    let input = document.getElementById("peak_search_text").value;
    let filter = input.toUpperCase();
    let table = document.getElementById("peak_table");
    let tr = table.getElementsByTagName("tr");
    let found = false;
    let index;
    for (let i = 0; i < tr.length; i++) {
        let td = tr[i].getElementsByTagName("td");
        if (td.length > 0) {
            let j;
            for (j = 0; j < td.length; j++) {
                let t = td[j];
                if (t) {
                    txtValue = t.textContent || t.innerText;
                    if (txtValue.toUpperCase().indexOf(filter) > -1) {
                        found = true;
                        tr[i].style.backgroundColor = "yellow";
                        index = i;
                        break;
                    }
                }
            }
            if (found) {
                break;
            }
        }
    }
    if (found) {
        scrollToTableRow('peak_table', index);
        setTimeout(function () {
            tr[index].style.backgroundColor = "";
        }, 5000);
        /**
         * Ask main_plot to zoom to the peak
         * Notice that index is the row index, we need to get the peak index from the table
         */
        if (index > 0) {
            /**
             * When user sort tables by column,
             * Row index is not the same as peak index
             * We need to get the peak index from the table
             */
            let td = tr[index].getElementsByTagName("td");
            let peak_index = parseInt(td[0].innerText);
            zoom_to_peak(peak_index - 1);
        }
    }
};

function set_current_spectrum_0(spectrum_index) {
    /**
     * If b_allow_dragging_spectrum is false, do nothing
     */
    if (b_allow_dragging_spectrum === false) {
        return;
    }
    set_current_spectrum(spectrum_index);
}

function set_current_spectrum(spectrum_index) {
    abandon_baseline_correction(main_plot.current_spectrum_index);//need to run before changing current spectrum

    if (main_plot.current_spectrum_index >= 0 && main_plot.current_spectrum_index < all_spectra.length) {
        if (main_plot.current_spectrum_index !== spectrum_index) {
            document.getElementById("spectrum-" + main_plot.current_spectrum_index).querySelector("div").style.backgroundColor = "white";
        }
    }

    if (spectrum_index >= 0 && spectrum_index < all_spectra.length) {
        if (main_plot.current_spectrum_index != -1 && main_plot.current_spectrum_index != spectrum_index) {
            permanently_apply_phase_correction();
        }
        main_plot.current_spectrum_index = spectrum_index;
    }
    else {
        main_plot.current_spectrum_index = -1;
    }


    document.getElementById("spectrum-" + spectrum_index).querySelector("div").style.backgroundColor = "lightblue";

    /**
     * If current showing peaks is not the same as current_spectrum_index, 
     * we need to reset current_spectrum_index_of_peaks to -1 (no peaks showing)
     */
    if (current_spectrum_index_of_peaks !== spectrum_index) {
        current_spectrum_index_of_peaks = -1;
        current_flag_of_peaks = 'picked'; //reset to picked peaks
        remove_peak_table();
        main_plot.remove_peaks();
    }


}


/**
 * 
 * @param {array} peaks peaks is an array of peaks, each peak is an array of [x,y] coordinates
 * @returns {array} peaks_center
 * For each peak, this function calculate the x coordinate of the peak center (mean of x coordinates of all points in the peak)
 * Return an array of peak centers
 */
function get_center(peaks) {
    let peaks_center = new Array(peaks.length);

    for (var i = 0; i < peaks.length; i++) {
        let x_min = 1000.0;
        let x_max = -1000.0;
        for (var j = 0; j < peaks[i].length; j++) {
            if (peaks[i][j][0] < x_min) { x_min = peaks[i][j][0]; }
            if (peaks[i][j][0] > x_max) { x_max = peaks[i][j][0]; }

        }
        peaks_center[i] = (x_min + x_max) / 2.0;
    }
    return peaks_center;
}

/**
 * On-call when button is clicked
 */
// [Shared Module] Phase correction routines (ANN models, manual phasing math) loaded from js/shared/nmr_phase_1d.js

function run_baseline_correction() {
    check_and_apply_manual_phase();
    if (main_plot.current_spectrum_index < 0 || main_plot.current_spectrum_index >= all_spectra.length) {
        alert("No spectrum selected for baseline correction.");
        return;
    }
    let spectrum_index = main_plot.current_spectrum_index;

    let header = new Float32Array(all_spectra[spectrum_index].header);
    header[55] = 1.0; //keep real part only
    header[56] = 1.0; //keep real part only
    header[99] = all_spectra[spectrum_index].n_direct; //size of indirect dimension of the input spectrum
    header[219] = 1; //size of indirect dimension of the input spectrum (always 1 for 1D)
    let n_water = 0; //default value
    if (document.getElementById("exclude_water").checked) {
        n_water = all_spectra[spectrum_index].n_direct / 512; //number of water points to be excluded in baseline correction
    }

    let smooth_parameter = document.getElementById("smooth_parameter").value;
    smooth_parameter = parseFloat(smooth_parameter);

    webassembly_1d_worker_2.postMessage({
        [WEBASSEMBLY_JOB_KEY]: 'baseline_correction',
        spectrum_header: header, //float32 array
        spectrum_data: all_spectra[spectrum_index].raw_data, //float32 array
        spectrum_index: spectrum_index,
        a0: Math.pow(10, smooth_parameter),
        b0: 1.5,
        n_water: n_water,
    });
    disable_enable_phase_baseline_buttons(false);
}

/**
 * User click button to apply baseline correction
 */
function apply_baseline_correction() {
    let spectrum_index = main_plot.current_spectrum_index;
    if (spectrum_index < 0 || spectrum_index >= all_spectra.length) {
        alert("No spectrum selected for baseline correction.");
        return;
    }


    if (typeof all_spectra[spectrum_index].baseline === "undefined"
        || all_spectra[spectrum_index].baseline.length === 0
        || all_spectra[spectrum_index].raw_data.length !== all_spectra[spectrum_index].baseline.length) {
        return;
    }


    disable_enable_phase_baseline_buttons(false);

    for (let i = 0; i < all_spectra[spectrum_index].n_direct; i++) {
        all_spectra[spectrum_index].raw_data[i] = all_spectra[spectrum_index].raw_data[i] - all_spectra[spectrum_index].baseline[i];
    }
    /**
     * Remove imaginary part if exists, because baseline correction is only applied to real part and after that, imaginary part is not valid anymore
     */
    all_spectra[spectrum_index].raw_data_i = new Float32Array(0);
    /**
     * Clear saved baseline as well
     */
    all_spectra[spectrum_index].baseline = new Float32Array(0);

    //update the plot
    main_plot.remove_baseline_area();
    let data = [];

    for (let i = 0; i < all_spectra[spectrum_index].n_direct; i++) {
        data.push([all_spectra[spectrum_index].x_ppm_start + all_spectra[spectrum_index].x_ppm_step * i, all_spectra[spectrum_index].raw_data[i]]);
    }

    main_plot.add_data(data, all_spectra[spectrum_index].spectrum_index, all_spectra[spectrum_index].spectrum_color);
    disable_enable_phase_baseline_buttons(true);
}

/**
 * When user run phase correction without applying baseline or rerun baseline calculation, abandon the baseline correction
 * User can also click a button to abandon baseline correction
 */
function abandon_baseline_correction(ndx) {
    if (ndx < 0) {
        ndx = main_plot.current_spectrum_index;
    }
    // Clear the baseline and raw data
    all_spectra[ndx].baseline = new Float32Array(0);

    // Update the plot
    main_plot.remove_baseline_area();
}

/**
 * When auto phase correction or baseline correction is running, disable manual phase correction and baseline correction buttons
 * Also disable dragging of spectrum to re-order
 * Also disable click to reset current spectrum
 * @param {*} enable 
 */
function disable_enable_phase_baseline_buttons(enable = true) {
    document.getElementById("button_auto_pc").disabled = !enable;
    document.getElementById("button_apply_pc").disabled = !enable;
    document.getElementById("button_baseline_correction").disabled = !enable;
    document.getElementById("button_apply_baseline_correction").disabled = !enable;
    b_allow_manual_phase_correction = enable;
    b_allow_dragging_spectrum = enable;
}

/**
 * Tutorial Logic
 */
var tutorial = null;

function startTutorial() {
    // 1. Ensure FID area is expanded
    const btn = document.getElementById("button_minimize_fid_area");
    if (btn && btn.innerText === "+") {
        minimize_fid_area(btn);
    }

    if (typeof SimpleTutorial === 'undefined') {
        alert("Tutorial script not loaded.");
        console.error("SimpleTutorial class is missing.");
        return;
    }

    // State for the combined interactive step
    let interactionState = { pan: false, zoomX: false, zoomY: false };

    const steps = [
        {
            elementId: 'input_options',
            message: "<strong>Welcome!</strong><br>For this tutorial, please <strong>do not change</strong> any of these processing parameters. Keep them at their default values.",
            triggerEvent: null
        },
        {
            elementId: 'input_files',
            message: "<strong>Step 1:</strong> Drag and drop your Bruker data folder (containing <code>fid</code> and <code>acqus</code>) into this area. <br>Or select files manually.",
            triggerEvent: ['drop', 'change'],
            hideNext: true,
            validate: (e) => {
                // Check if both fid and acqus inputs have files
                const fidFiles = document.getElementById('fid_file').files;
                const acqusFiles = document.getElementById('acquisition_file').files;
                return fidFiles.length > 0 && acqusFiles.length > 0;
            }
        },
        {
            elementId: 'button_fid_process',
            message: "<strong>Step 2:</strong> Click this button to upload and process the data.",
            triggerEvent: 'click',
            hideNext: true
        },
        {
            elementId: 'button_fid_process', // Stay on the button, or move to plot? Button is fine while waiting.
            message: "<strong>Processing...</strong> Please wait for the automatic phase correction to finish.",
            triggerEvent: 'colmar:processing_finished',
            hideNext: true // Prevent user from skipping wait
        },
        {
            elementId: 'plot_1d',
            message: "<strong>Success:</strong> Your processed spectrum will appear here. You can interact with it using the mouse.",
            triggerEvent: null
        },
        {
            elementId: 'plot_1d',
            message: "<strong>Practice:</strong> Please try all 3 interactions:<br>1. <strong>Pan:</strong> Drag mouse.<br>2. <strong>Zoom X:</strong> Scroll wheel over spectrum (right of axis).<br>3. <strong>Zoom Y:</strong> Scroll wheel over left axis (left of axis).",
            triggerEvent: ['mousemove', 'wheel'],
            hideNext: true,
            validate: (e) => {
                // e.buttons works for mousemove pan check
                const btn = e.buttons !== undefined ? e.buttons : e.which;
                if (e.type === 'mousemove' && (btn & 1)) {
                    interactionState.pan = true;
                }
                if (e.type === 'wheel') {
                    if (e.offsetX > 120) interactionState.zoomX = true;
                    if (e.offsetX <= 120) interactionState.zoomY = true;
                }

                return interactionState.pan && interactionState.zoomX && interactionState.zoomY;
            }
        },
        {
            elementId: 'instructions_link',
            message: "<strong>Tutorial Complete!</strong><br>This covered the basics. Please read the <a href='https://github.com/lidawei1975/colmarviewer/wiki' target='_blank' style='color: lightblue'>full instructions</a> for details on all features.",
            triggerEvent: null
        }
    ];

    tutorial = new SimpleTutorial(steps, () => {
        // Hide the start tutorial button when finished
        const btn = document.getElementById("button_tutorial");
        if (btn) btn.style.display = 'none';

        // Also remove the tutorial instance logic if needed
        tutorial = null;
    });
    tutorial.start();
}

/**
 * Show a floating window with FID data
 * @param {Float32Array|Float64Array|Int32Array} fid_data 
 * @param {number} cutoff_index 
 * @param {Function} [confirm_callback] - If provided, enables editing cutoff and adds confirm button. Callback(new_cutoff).
 */
// [Shared Module] FID tools (show_fid_window, detect_signal_end, get_fid_data_from_buffer) loaded from js/shared/fid_tools_1d.js

function minimize_reconstructed_spectrum(button, index) {
    const isMinimized = button.innerText === "+";
    const container = document.getElementById("spectrum-".concat(index));
    if (!container) return;

    // The container is an LI. The actual content is in the first DIV child.
    const div = container.getElementsByTagName("div")[0];
    if (!div) return;

    if (!isMinimized) {
        // ACTION: MINIMIZE
        // 1. Change button text
        button.innerText = "+";

        // 2. Hide all non-header elements
        const children = div.children;
        for (let i = 0; i < children.length; i++) {
            const child = children[i];
            if (!child.classList.contains("header-control")) {
                // Store original display style if needed? 
                // Mostly they are inline or block. We just hide them.
                // We use a custom attribute to mark them as hidden by minimizer
                child.setAttribute("data-minimized-hidden", "true");
                child.style.display = "none";
            }
        }

        // Hide BR tags (they don't have classes)
        // Since BRs are elements, they are covered by the loop above (no header-control class).

        // Hide TextNodes? TextNodes are not in .children collection. 
        // They remain visible. This might leave some stray text since we can't easily target them.

        // 3. Hide Spectrum Trace
        if (main_plot && typeof main_plot.update_visibility === 'function') {
            main_plot.update_visibility(index, false);
        }

        // 4. Uncheck Peaks and Hide them
        const showPicked = document.getElementById("show_peaks-".concat(index));
        if (showPicked && showPicked.checked) {
            showPicked.checked = false;
            // Trigger hide logic
            if (typeof show_hide_peaks === 'function') {
                show_hide_peaks(index, 'picked', false);
            }
        }

        const showFitted = document.getElementById("show_fitted_peaks-".concat(index));
        if (showFitted && showFitted.checked) {
            showFitted.checked = false;
            // Trigger hide logic
            if (typeof show_hide_peaks === 'function') {
                show_hide_peaks(index, 'fitted', false);
            }
        }

    } else {
        // ACTION: MAXIMIZE
        // 1. Change button text
        button.innerText = "-";

        // 2. Show hidden elements
        const children = div.children;
        for (let i = 0; i < children.length; i++) {
            const child = children[i];
            if (child.getAttribute("data-minimized-hidden") === "true") {
                child.style.display = ""; // Restore default
                child.removeAttribute("data-minimized-hidden");
            }
        }

        // 3. Show Spectrum Trace
        if (main_plot && typeof main_plot.update_visibility === 'function') {
            main_plot.update_visibility(index, true);
        }

        // 4. Do NOT re-check peaks (as requested "automatically unchecked")
    }
}

/**
 * Helper function to exit reprocessing UI mode
 * @param {number} index - The spectrum index
 */
function exit_reprocessing_ui(index) {
    let button = document.getElementById("reprocess-".concat(index));
    if (!button) return;

    /**
     * Undo hide of input fid files
     */
    document.getElementById("input_files").style.display = "flex";
    /**
     * Change button text back to "Edit FID processing"
     */
    button.innerText = "Edit FID processing";
    button.title = "Load this spectrum's FID data and its previous processing parameters back into the FID processing section above, so you can adjust them. This does NOT reprocess anything yet; click the \"Reprocess\" button in that section to run the processing again.";
    /**
     * Un-highlight the user option div
     */
    document.getElementById("input_options").style.backgroundColor = "white";
    /**
     * Show div "file_area" and "input_files" (of fid_file_area).
     * Change the button "button_fid_process"text back to "Upload experimental files and process"
     */
    document.getElementById("file_area").style.display = "block";
    document.getElementById("input_files").style.display = "flex";
    document.getElementById("button_fid_process").value = "Upload experimental files and process";
    current_reprocess_spectrum_index = -1;

    /**
     * Also reset the background color of the spectrum div
     */
    let spectrum_div = document.getElementById("spectrum-" + index);
    if (spectrum_div) {
        let div = spectrum_div.querySelector("div");
        if (div) div.style.backgroundColor = ""; // Reset to default (or remove inline style)
    }
}

/**
 * Minimizes or restores the floating background log area.
 */
function toggle_log_minimize() {
    const log_area = document.getElementById('log_area');
    const log_textarea = document.getElementById('log');
    const min_btn = document.getElementById('button_minimize_log');

    if (!log_area || !log_textarea || !min_btn) return;

    if (log_textarea.style.display === 'none') {
        log_textarea.style.display = 'block';
        log_area.style.height = log_area.dataset.lastHeight || '300px';
        log_area.style.width = log_area.dataset.lastWidth || '500px';
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
 * Makes the floating background log area draggable by its header.
 */
function make_log_movable() {
    const log_area = document.getElementById("log_area");
    const header = log_area ? log_area.querySelector(".log-header") : null;
    if (!log_area || !header) return;

    let startX, startY, initialLeft, initialTop;

    header.onmousedown = function (e) {
        // If clicking on a button inside the header, don't drag
        if (e.target.tagName.toLowerCase() === 'button') {
            return;
        }
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

// Call this once to initialize log dragging
setTimeout(make_log_movable, 100);