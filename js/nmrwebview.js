/**
 * Workflows:
 * 1. Read ft2 or read fid files. If FID, run webassembly_worker to process the FID (webassembly_worker2 for NUS) 
 * 2. Once ft2 files are read or generated from FID, call functions pair: process_ft_file and draw_spectrum
 * 3. Draw_spectrum will push the new spectrum object to hsqc_spectra array. Order in the array depends on who is generated first (ft2 may jump before fid even if fid is read first)
 * 4. Draw_spectrum will call contour_worker to generate contour plot from the spectrum object
 * 5. When all contour (pos and neg) are generated, contour_worker will send the data back to the main thread to show call and add_to_list()
 */


/**
 * Make sure we can load WebWorker
*/

var my_contour_worker, webassembly_worker, webassembly_worker2;

try {
    my_contour_worker = new Worker('./js/contour.js');
    webassembly_worker = new Worker('./js/webass.js');
    webassembly_worker2 = new Worker('./js/webass2.js');
}
catch (err) {
    console.log(err);
    if (typeof (my_contour_worker) === "undefined" 
        || typeof (webassembly_worker) === "undefined"
        || typeof (webassembly_worker2) === "undefined")
    {
        alert("Failed to load WebWorker, probably due to browser incompatibility. Please use a modern browser, if you run this program locally, please read the instructions titled 'How to run COLMAR Viewer locally'");
    }
}


var plot_margin_top = 20;
var plot_margin_bottom = 70;
var plot_margin_left = 90;
var plot_margin_right = 20;


var main_plot = null; //hsqc plot object
var b_plot_initialized = false; //flag to indicate if the plot is initialized
var tooldiv; //tooltip div (used by myplot1_new.js, this is not a good practice, but it is a quick fix)
var current_spectrum_index_of_peaks = -1; //index of the spectrum that is currently showing peaks, -1 means none, -2 means pseudo 3D fitted peaks
var current_flag_of_peaks = 'picked'; //flag of the peaks that is currently showing, 'picked' or 'fitted
var total_number_of_experimental_spectra = 0; //total number of experimental spectra
var pseudo3d_fitted_peaks_object = null; //pseudo 3D fitted peaks object

/**
 * For FID re-processing. Saved file data
 */
var fid_process_parameters; 
var current_reprocess_spectrum_index = -1;
    
/**
 * Default var in peaks to color-map the peaks symbols
 */
var color_map_list = ['HEIGHT'];
/**
 * Corresponding color map limits for the color_map_list
 * Save length of color_map_list.
 */
var color_map_limit = [[0,1]]; 




/**
 * ft2 file drop processor
 */
var ft2_file_drop_processor;

/**
* fid file drop processor for the time domain spectra
*/
var fid_drop_process;

/**
 * DOM div for the processing message
 */
var oOutput;

/**
 * Current phase correction values:
 * direct_p0, direct_p1, indirect_p0, indirect_p1
 */
var current_phase_correction = [0, 0, 0, 0];




var hsqc_spectra = []; //array of hsqc spectra

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


/**
 * Read a file as array buffer
 * @param {*} file: file object
 * @returns 
 */
const read_file = (file) => {
    return new Promise((resolve, reject) => {

        var reader = new FileReader();
        reader.onload = function () {
            return resolve(reader.result);
        };
        reader.onerror = function (e) {
            reject("Error reading file");
        };
        reader.readAsArrayBuffer(file);
    });
}

/**
 * Read a file as text
 */
const read_file_text = (file) => {
    return new Promise((resolve, reject) => {

        var reader = new FileReader();
        reader.onload = function () {
            return resolve(reader.result);
        };
        reader.onerror = function (e) {
            reject("Error reading file");
        };
        reader.readAsText(file);
    });
}



$(document).ready(function () {

    /**
     * This is the main information output area
     */
    oOutput = document.getElementById("infor");

    /**
     * Tooltip div. Set the opacity to 0
     */
    tooldiv = document.getElementById("information_bar");
    tooldiv.style.opacity = 0;

    /**
     * clear hsqc_spectra array
     */
    hsqc_spectra = [];



    /**
     * Initialize the big plot
     */
    resize_main_plot(1200, 800, 20, 90, 20, 20, 20);

    /**
     * Resize observer for the big plot
     */
    plot_div_resize_observer.observe(document.getElementById("vis_parent")); 

    /**
     * ft2 file drop processor
     */
    ft2_file_drop_processor = new file_drop_processor()
    .drop_area('file_area') /** id of dropzone */
    .files_name([]) /** file names to be searched from upload. It is empty because we will use file_extension*/
    .file_extension(["ft2","ft3","txt","ucsf"])  /** file extensions to be searched from upload */
    .files_id(["userfile","userfile","userfile","userfile"]) /** Corresponding file element IDs */
    .init();

    /**
    * INitialize the file drop processor for the time domain spectra
    */
    fid_drop_process = new file_drop_processor()
    .drop_area('input_files') /** id of dropzone */
    .files_name(["acqu2s", "acqu3s", "acqus", "ser", "fid","nuslist"])  /** file names to be searched from upload */
    .files_id(["acquisition_file2","acquisition_file2", "acquisition_file", "fid_file", "fid_file","nuslist_file"]) /** Corresponding file element IDs */
    .file_extension([])  /** file extensions to be searched from upload */
    .init();

    /**
     * Upload a file with assignment information. 
     * Assignment will be transfer to current showing fitted peaks
     */
    document.getElementById('assignment_file').addEventListener('change', function (e) {
        
        /**
         * Do nothing if pseudo3d_fitted_peaks_object is null
         */
        if(pseudo3d_fitted_peaks_object === null)
        {
            return;
        }

        /**
         * Read the file (text file) then send it to the worker, together with the current spectrum's fitted_peaks_tab
         */
        let file = document.getElementById('assignment_file').files[0];
        if (file) {
            var reader = new FileReader();
            reader.onload = function () {
                var data = reader.result;
                webassembly_worker.postMessage({
                    webassembly_job: "assignment",
                    assignment: data,
                    fitted_peaks_tab: pseudo3d_fitted_peaks_object.get_peaks_tab(),
                });
            };
            reader.onerror = function (e) {
                console.log("Error reading file");
            };
            reader.readAsText(file);
        }
    });




    /**
     * When use selected a file, read the file and process it
     */
    document.getElementById('ft2_file_form').addEventListener('submit', function (e) {
        e.preventDefault();

        /**
         * Clear file_drop_processor container
         * clearData() does not work ???
         */
        ft2_file_drop_processor.container = new DataTransfer();
        
        /**
         * Collect all file names
         */
        let file_names = [];
        for(let i=0;i<this.querySelector('input[type="file"]').files.length;i++)
        {
            file_names.push(this.querySelector('input[type="file"]').files[i].name);
        }
        /**
         * Sort the file names, keep the index
         */
        let index_array = Array.from(Array(file_names.length).keys());
        index_array.sort(function(a,b){
            return file_names[a].localeCompare(file_names[b]);
        });

        console.log(index_array);

        /**
         * To keep order, we will read the files one by one using a chain of promises
         */
        let chain = Promise.resolve();
        for(let i=0;i<this.querySelector('input[type="file"]').files.length;i++)
        {
            let ii = index_array[i];
            
            chain = chain.then(() => {
                    console.log("read file",this.querySelector('input[type="file"]').files[ii].name);
                    /**
                     * If not a .ft2 file or .ft3 file, resolve the promise
                     */
                    if(this.querySelector('input[type="file"]').files[ii].name.endsWith(".ft2")
                        || this.querySelector('input[type="file"]').files[ii].name.endsWith(".ft3")
                        || this.querySelector('input[type="file"]').files[ii].name.endsWith(".ucsf") )
                    {
                        return read_file(this.querySelector('input[type="file"]').files[ii]);
                    }
                    else if(this.querySelector('input[type="file"]').files[ii].name.endsWith(".txt"))
                    {
                        return read_file_text(this.querySelector('input[type="file"]').files[ii]);
                    }
                    else
                    {
                        return Promise.resolve(null);
                    }
            }).then((file_data) => {
                /**
                 * If the file is a ft2 file (file_data is a array buffer), process it
                 */
                if(file_data !== null && file_data !== undefined )
                {   
                    /**
                     * If read as text file, 
                     */
                    if(typeof file_data === "string")
                    {
                        /**
                         * Get field strength from the html input field with id "field_strength" if it exists
                         */
                        let field_strength = 850.0; //default field strength
                        if (document.getElementById("field_strength") !== null) {
                            field_strength = parseFloat(document.getElementById("field_strength").value);
                        }
                        let result_spectrum = new spectrum();
                        result_spectrum.process_topspin_file(file_data,this.querySelector('input[type="file"]').files[ii].name,field_strength);
                        draw_spectrum([result_spectrum],false/**from fid */,false/** re-process of fid or ft2 */);
                    }
                    else
                    {
                        /**
                         * Get first float32 number of the file_data. 
                         * If it is "0.0", it is a nmrPipe file, otherwise consider it as Sparky .ucsf file 
                         */
                        let first_float32 = new Float32Array(file_data,0,1)[0];
                        let result_spectrum;
                        if(first_float32 === 0.0)
                        {
                            result_spectrum = new spectrum();
                            result_spectrum.process_ft_file(file_data,this.querySelector('input[type="file"]').files[ii].name,-1);
                        }
                        else
                        {
                            result_spectrum = new spectrum();
                            result_spectrum.process_sparky_file(file_data,this.querySelector('input[type="file"]').files[ii].name,-1);
                        }
                        draw_spectrum([result_spectrum],false/**from fid */,false/** re-process of fid or ft2 */);
                    }
                }
                /**
                 * If it is the last file, clear the file input
                 */
                if(i===this.querySelector('input[type="file"]').files.length-1)
                {
                    document.getElementById('userfile').value = "";
                }
            }).catch((err) => {
                console.log(err);
            });
        }
    });


    /**
     * When user click submit button, read the time domain spectra and process it
     */
    document.getElementById('fid_file_form').addEventListener('submit', function (e) {

        let current_fid_files;

            
        /**
         * Function to process the file
         */
        function process_fid_files(processing_flag, spectrum_index) {

            /**
             * Get html checkbox water_suppression checked: true or false
             */
            let water_suppression = document.getElementById("water_suppression").checked;

            /**
             * Get html option "polynomial" value: -1,0,1,2,3
             */
            let polynomial = document.getElementById("polynomial").value;

            /**
             * Get HTML select "hsqc_acquisition_seq" value: "321" or "312"
            */
            let acquisition_seq = document.getElementById("hsqc_acquisition_seq").value;

            /**
             * Get HTML text input apodization_direct
             */
            let apodization_direct = document.getElementById("apodization_direct").value;

            /**
             * Get HTML select zf_direct value: "2" or "4" or "8"
             */
            let zf_direct = document.getElementById("zf_direct").value;

            /**
             * Get HTML number input phase_correction_direct_p0 and phase_correction_direct_p1
             * and checkbox auto_direct checked: true or false
             * and checkbox delete_direct checked: true or false
             */
            let phase_correction_direct_p0 = parseFloat(document.getElementById("phase_correction_direct_p0").value);
            let phase_correction_direct_p1 = parseFloat(document.getElementById("phase_correction_direct_p1").value);
            let auto_direct = document.getElementById("auto_direct").checked; //true or false
            let delete_direct = document.getElementById("delete_imaginary").checked; //true or false

            /**
             * Get HTML text input extract_direct_from and extract_direct_to. Input is in percentage
             */
            let extract_direct_from = parseFloat(document.getElementById("extract_direct_from").value) / 100.0;
            let extract_direct_to = parseFloat(document.getElementById("extract_direct_to").value) / 100.0;

            /**
             * Get HTML text input apodization_indirect
             */
            let apodization_indirect = document.getElementById("apodization_indirect").value;

            /**
             * Get HTML select zf_indirect value: "2" or "4" or "8"
             */
            let zf_indirect = document.getElementById("zf_indirect").value;


            /**
             * Get HTML number input phase_correction_indirect_p0 and phase_correction_indirect_p1
             * and checkbox auto_indirect checked: true or false
             * and checkbox delete_indirect checked: true or false
             */
            let phase_correction_indirect_p0 = parseFloat(document.getElementById("phase_correction_indirect_p0").value);
            let phase_correction_indirect_p1 = parseFloat(document.getElementById("phase_correction_indirect_p1").value);
            let auto_indirect = document.getElementById("auto_indirect").checked; //true or false
            let delete_indirect = document.getElementById("delete_imaginary_indirect").checked; //true or false


            /**
             * Get HTML checkbox "neg_imaginary".checked: true or false. Convert to "yes" or "no" for the worker
             */
            let neg_imaginary = document.getElementById("neg_imaginary").checked ? "yes" : "no";

            /**
             * Get radio group "Pseudo-3D-process" value: first_only or all_planes
             */
            let pseudo3d_process = document.querySelector('input[name="Pseudo-3D-process"]:checked').value;

            /**
             * Normal or NUS processing 
             */
            let webassembly_job = "process_fid";
            if(current_fid_files.length === 4)
            {
                webassembly_job = "nus_step1";
            }

            fid_process_parameters = {
                webassembly_job: webassembly_job,
                water_suppression: water_suppression,
                polynomial: polynomial,
                file_data: current_fid_files,
                acquisition_seq: acquisition_seq,
                pseudo3d_process: pseudo3d_process,
                neg_imaginary: neg_imaginary,
                apodization_direct: apodization_direct,
                apodization_indirect: apodization_indirect,
                auto_direct: auto_direct,
                auto_indirect: auto_indirect,
                delete_direct: delete_direct,
                delete_indirect: delete_indirect,
                phase_correction_direct_p0: phase_correction_direct_p0,
                phase_correction_direct_p1: phase_correction_direct_p1,
                phase_correction_indirect_p0: phase_correction_indirect_p0,
                phase_correction_indirect_p1: phase_correction_indirect_p1,
                zf_direct: zf_direct,
                zf_indirect: zf_indirect,
                extract_direct_from: extract_direct_from,
                extract_direct_to: extract_direct_to,
                processing_flag: processing_flag, //0: process, 1: reprocess
                spectrum_index: spectrum_index, //not used if not reprocessing
            };

            if(processing_flag==1)
            {
                fid_process_parameters.pseudo3d_children = hsqc_spectra[spectrum_index].pseudo3d_children;
            }
            else
            {
                fid_process_parameters.pseudo3d_children = [];
            }

            /**
             * Note. Add below 2 for reprocessing
             * spectrum_index: spectrum_index, 
             * flag: 1 (reprocess)
             */
            webassembly_worker.postMessage(fid_process_parameters);
            /**
             * Let user know the processing is started
             */
            document.getElementById("webassembly_message").innerText = "Processing time domain spectra, please wait...";
        }

        e.preventDefault();
        /**
         * The default value of the button is "Upload experimental files and process"
         * For reprocessing, the button value is set to "Reprocess" by JS code.
         */
        let button_value = e.submitter.value;


        if(button_value === "Reprocess")
        {
            current_fid_files = hsqc_spectra[current_reprocess_spectrum_index].fid_process_parameters.file_data;

            process_fid_files(1,current_reprocess_spectrum_index);   
        }

        else
        {
            /**
             * UN-highlight the input_options div
             */
            document.getElementById("input_options").style.backgroundColor = "white";

            let acquisition_file = document.getElementById('acquisition_file').files[0];
            let acquisition_file2 = document.getElementById('acquisition_file2').files[0];
            let fid_file = document.getElementById('fid_file').files[0];
            /**
             * Nuslist file is optional (for non-uniform sampling)
             * If it is not selected, it will be null
             */
            let nuslist_file = document.getElementById('nuslist_file').files[0];



            let promises;
            if (typeof nuslist_file === "undefined") {
                promises = [read_file(acquisition_file), read_file(acquisition_file2), read_file(fid_file)];
            }
            else {
                promises = [read_file(acquisition_file), read_file(acquisition_file2), read_file(fid_file), read_file(nuslist_file)];
            }

            Promise.all(promises)
                .then((result) => {

                    /**
                     * For each element in result (raw data of the files), we will convert it to Uint8Array
                     * so that they can be transferred to the worker
                     */
                    if (typeof nuslist_file === "undefined") {
                        current_fid_files = [new Uint8Array(result[0]), new Uint8Array(result[1]), new Uint8Array(result[2])];
                    }
                    else {
                        current_fid_files = [new Uint8Array(result[0]), new Uint8Array(result[1]), new Uint8Array(result[2]), new Uint8Array(result[3])];
                        /**
                         * convert nuslist file content (arrayBuffer) to string
                         */
                        let nuslist_array = new Uint8Array(result[3]);
                        nuslist_as_string = String.fromCharCode.apply(null, nuslist_array);
                    }

                    /**
                     * Clear file input
                     */
                    document.getElementById('acquisition_file').value = "";
                    document.getElementById('acquisition_file2').value = "";
                    document.getElementById('fid_file').value = "";
                    document.getElementById('nuslist_file').value = "";

                    process_fid_files(0,0);

                })
                .catch((err) => {
                    console.log(err);
                });
        }

    });

    /**
     * Event listener for checkbox "show_peak_label"
     */
    document.getElementById("show_peak_label").addEventListener('change', function () {
        if (main_plot === null) {
            return;
        }

        let min_dis = parseFloat(document.getElementById("min_distance").value);
        let max_dis = parseFloat(document.getElementById("max_distance").value);
        let repulsive_force = parseFloat(document.getElementById("repulsive_force").value);
        let font_size = parseFloat(document.getElementById("peak_label_size").value);
        let color = document.getElementById("peak_color").value;
        let labels = document.getElementById("labels").value;

        if (this.checked) {
            main_plot.update_peak_labels(true,min_dis,max_dis,repulsive_force,font_size,color,labels);
        }
        else {
            main_plot.update_peak_labels(false,min_dis,max_dis,repulsive_force,font_size,color,labels);
        }
    });

    /**
     * These 3 checkbox can only be triggered when the checkboxes are enabled
     * which means the main_plot is already defined
     * and current spectrum is an experimental spectrum
     * and current showing peaks are picked peaks (not fitted peaks)
     */

    /** 
     * Add event listener to the allow_brush_to_remove checkbox
     */
    document.getElementById("allow_brush_to_remove").addEventListener('change', function () {
        if (this.checked) {
            main_plot.allow_brush_to_remove = true;
        }
        else {
            /**
             * Disable the peak editing in main plot
             */
            main_plot.allow_brush_to_remove = false;
        }
    });

    /**
     * Event listener for the allow_drag_and_drop checkbox
     */
    document.getElementById("allow_drag_and_drop").addEventListener('change', function () {
        if (this.checked) {
            main_plot.allow_peak_dragging(true);
        }
        else {
            main_plot.allow_peak_dragging(false);
        }
    });

    /**
     * Event listener for the allow_click_to_add_peak checkbox
    */
    document.getElementById("allow_click_to_add_peak").addEventListener('change', function () {
        if (this.checked) {
            main_plot.allow_click_to_add_peak(true);
        }
        else {
            main_plot.allow_click_to_add_peak(false);
        }
    });

    /**
     * On click event for the show_peaks checkbox
     */
    document.getElementById("show_pseudo3d_peaks").addEventListener('change', function () {
        if (this.checked) {
            /**
             * Show the picked peaks
             */
            show_hide_peaks(-2, 'fitted', true);
        }
        else {
            /**
             * Hide the picked peaks
             */
            show_hide_peaks(-2, 'picked', false);
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

});




/**
 * When user click button to run pseudo 3D fitting
 */
function run_pseudo3d(flag) {

    /**
     * Get initial peaks from current_spectrum_index_of_peaks and current_flag_of_peaks
     */
    if (current_spectrum_index_of_peaks === -1) {
        alert("Please select a initial peak list to run pseudo 3D fitting");
        return;
    }

    let initial_peaks;
    if (current_flag_of_peaks === 'picked') {
        initial_peaks = hsqc_spectra[current_spectrum_index_of_peaks].picked_peaks_object.save_peaks_tab();
    }
    else {
        initial_peaks = hsqc_spectra[current_spectrum_index_of_peaks].fitted_peaks_object.save_peaks_tab();
    }

    /**
     * Get input field "max_round" value (number type)
     */
    let max_round = parseInt(document.getElementById("max_round").value);

    /**
     * Check all spectra, collect the ones that are experimental
     * Save their header and raw data like this: 
     * Combine hsqc_spectra[index].raw_data and hsqc_spectra[index].header into one Float32Array
     * Convert to Uint8Array to be transferred to the worker: let data_uint8 = new Uint8Array(data.buffer);
     */
    let all_files = [];
    for (let i = 0; i < hsqc_spectra.length; i++) {
        if (hsqc_spectra[i].spectrum_origin === -1 || hsqc_spectra[i].spectrum_origin === -2 || hsqc_spectra[i].spectrum_origin>=10000) {
            let data = new Float32Array(hsqc_spectra[i].header.length + hsqc_spectra[i].raw_data.length);
            let temp_header = new Float32Array(hsqc_spectra[i].header);
            /**
             * Set temp_header to 1.0 to indicate it is real data (not complex data) because we only send raw_data (not raw_data_ri, ..)
             */
            if( temp_header[55] == 0.0 && temp_header[56] == 0.0)
            {
                temp_header[219] /= 2.0; //when both are complex, nmrPipe set 219 to 2 times true indirect size   
            }
            temp_header[55] = 1;
            temp_header[56] = 1;
            data.set(temp_header, 0);
            data.set(hsqc_spectra[i].raw_data, hsqc_spectra[i].header.length);
            let data_uint8 = new Uint8Array(data.buffer);
            all_files.push(data_uint8);
        }
    }

    /**
     * Disable the download fitted peaks buttons to run pseudo 3D fitting
     */
    document.getElementById("button_run_pseudo3d_gaussian").disabled = true;
    document.getElementById("button_run_pseudo3d_voigt").disabled = true;

    /**
     * Show the processing message to let user know the fitting is running
     */
    document.getElementById("webassembly_message").innerText = "Running pseudo 3D fitting, please wait...";

    /**
     * Send the initial peaks, all_files to the worker
     */
    webassembly_worker.postMessage({
        webassembly_job: "pseudo3d_fitting",
        initial_peaks: initial_peaks,
        all_files: all_files,
        noise_level: hsqc_spectra[current_spectrum_index_of_peaks].noise_level,
        scale: hsqc_spectra[current_spectrum_index_of_peaks].scale,
        scale2: hsqc_spectra[current_spectrum_index_of_peaks].scale2,
        flag: flag, //0: voigt, 1: Gaussian
        maxround: max_round,
    });
}

webassembly_worker2.onmessage = function (e) {

    /**
     * if result is stdout, it is the processing message
     */
    if (e.data.stdout) {

        /**
         * Append e.data.stdout to textarea with ID "log"
         * and add a new line
         */
        document.getElementById("log").value += e.data.stdout + "\n";
        document.getElementById("log").scrollTop = document.getElementById("log").scrollHeight;
    }
    /**
     * If result is spectrum_data, it is the processed spectrum
     */
    else if (e.data.spectrum_data) {
        console.log("Processed smile spectrum data received");
        let spectrum_data = new Uint8Array(e.data.spectrum_data);
        /**
         * Send e.data.spectrum_data to webassembly_worker to process it
         */
        webassembly_worker.postMessage({
            webassembly_job: "nus_step2",
            file_data: [spectrum_data],
            spectrum_index: e.data.spectrum_index,
            phase_correction_indirect_p0: phase_correction_indirect_p0,
            phase_correction_indirect_p1: phase_correction_indirect_p1,
            apodization_indirect: apodization_indirect,
            zf_indirect: zf_indirect,
            processing_flag: e.data.processing_flag,
        });
    }
}


webassembly_worker.onmessage = function (e) {

    /**
     * if result is stdout, it is the processing message
     */
    if (e.data.stdout) {

        /**
         * Append e.data.stdout to textarea with ID "log"
         * and add a new line
         */
        document.getElementById("log").value += e.data.stdout + "\n";
        document.getElementById("log").scrollTop = document.getElementById("log").scrollHeight;
    }
    /**
     * e.data.stdout is defined but empty, it is the end of the processing message
     */
    else if (typeof e.data.stdout !== "undefined" && e.data.stdout === "") {
    }

    /**
     * If result is peaks
     */
    else if (e.data.peaks) {
        let peaks = new cpeaks();
        peaks.process_peaks_tab(e.data.picked_peaks_tab);
        hsqc_spectra[e.data.spectrum_index].picked_peaks_object = peaks;

     
        /**
         * when picked peaks are received, fitted peaks need to be reset
         */
        hsqc_spectra[e.data.spectrum_index].fitted_peaks_object = null;
        /**
         * Disable the download fitted peaks button. Uncheck the show fitted peaks checkbox, disable it too
         */
        document.getElementById("download_fitted_peaks-".concat(e.data.spectrum_index)).disabled = true;
        document.getElementById("show_fitted_peaks-".concat(e.data.spectrum_index)).checked = false;
        document.getElementById("show_fitted_peaks-".concat(e.data.spectrum_index)).disabled = true;

        /**
         * Need to save its scale and scale2 used to run deep picker
         * because we will need them to run peak fitting
         */
        hsqc_spectra[e.data.spectrum_index].scale = e.data.scale;
        hsqc_spectra[e.data.spectrum_index].scale2 = e.data.scale2;
        /**
         * Enable the download peaks button
         */
        document.getElementById("download_peaks-".concat(e.data.spectrum_index)).disabled = false;
        /**
         * Enable peak picking (we disabled it when starting deep picker) and peak fitting buttons
         */
        document.getElementById("run_deep_picker-".concat(e.data.spectrum_index)).disabled = false;
        document.getElementById("run_voigt_fitter-".concat(e.data.spectrum_index)).disabled = false;
        /**
         * Enable, set it as unchecked then simulate a click event to show the peaks
         */
        document.getElementById("show_peaks-".concat(e.data.spectrum_index)).disabled = false;
        document.getElementById("show_peaks-".concat(e.data.spectrum_index)).checked = false;
        document.getElementById("show_peaks-".concat(e.data.spectrum_index)).click();

        /**
         * Clear the processing message
         */
        document.getElementById("webassembly_message").innerText = "";
    }

    /**
     * If result is fitted_peaks and recon_spectrum
     */
    else if (e.data.fitted_peaks && e.data.recon_spectrum) {
        console.log("Fitted peaks and recon_spectrum received");

        /**
         * Define a new class peaks object, process e.data.fitted_peaks_tab
         */
        let peaks = new cpeaks();
        peaks.process_peaks_tab(e.data.fitted_peaks_tab);
        hsqc_spectra[e.data.spectrum_origin].fitted_peaks_object = peaks;

        /**
         * Enable run deep picker and run voigt fitter buttons
         */
        document.getElementById("run_deep_picker-".concat(e.data.spectrum_origin)).disabled = false;
        document.getElementById("run_voigt_fitter-".concat(e.data.spectrum_origin)).disabled = false;

        /**
         * Enable the download fitted peaks button and show the fitted peaks button
         */
        document.getElementById("download_fitted_peaks-".concat(e.data.spectrum_origin)).disabled = false;
        document.getElementById("show_fitted_peaks-".concat(e.data.spectrum_origin)).disabled = false;

        /**
         * Uncheck the show_peaks checkbox then simulate a click event to show the peaks (with updated peaks from fitted_peaks)
         */
        document.getElementById("show_fitted_peaks-".concat(e.data.spectrum_origin)).checked = false;
        document.getElementById("show_fitted_peaks-".concat(e.data.spectrum_origin)).click();

        /**
         * Treat the received recon_spectrum as a frequency domain spectrum
         */
        let arrayBuffer = new Uint8Array(e.data.recon_spectrum).buffer;

        /**
         * Process the frequency domain spectrum, spectrum name is "recon-".spectrum_origin.".ft2"
         */
        let result_spectrum_name = "recon-".concat(e.data.spectrum_origin.toString(), ".ft2");
        let result_spectrum = new spectrum();
        result_spectrum.process_ft_file(arrayBuffer,result_spectrum_name,e.data.spectrum_origin);

        /**
         * Replace its header with the header of the original spectrum
         * and noise_level, levels, negative_levels, spectral_max and spectral_min with the original spectrum
         */
        result_spectrum.header = hsqc_spectra[e.data.spectrum_origin].header;
        result_spectrum.noise_level = hsqc_spectra[e.data.spectrum_origin].noise_level;
        result_spectrum.levels = hsqc_spectra[e.data.spectrum_origin].levels;
        result_spectrum.negative_levels = hsqc_spectra[e.data.spectrum_origin].negative_levels;
        result_spectrum.spectral_max = hsqc_spectra[e.data.spectrum_origin].spectral_max;
        result_spectrum.spectral_min = hsqc_spectra[e.data.spectrum_origin].spectral_min;

        /**
         * Copy picked_peaks_object and fitted_peaks_object from the original spectrum
         */
        result_spectrum.picked_peaks_object = hsqc_spectra[e.data.spectrum_origin].picked_peaks_object;
        result_spectrum.fitted_peaks_object = hsqc_spectra[e.data.spectrum_origin].fitted_peaks_object;

        /**
         * Also copy scale and scale2 from the original spectrum, which are used to run deep picker and peak fitting
         */
        result_spectrum.scale = e.data.scale;
        result_spectrum.scale2 = e.data.scale2;
        draw_spectrum([result_spectrum],false/**from fid */,false/**re-process of fid or ft2 */);

        /**
         * Clear the processing message
         */
        document.getElementById("webassembly_message").innerText = "";
    }

    /**
     * IF result is file_data and file_type is "direct", it is a hybrid spectrum
     * (direct dimension only processing) from a NUS experiment
     */
    else if(e.data.file_data && e.data.file_type && e.data.file_type === 'direct')
    {
        /**
         * Update direct dimension phase correction values
         * from e.data.phasing_data
         */
        let current_phase_correction = e.data.phasing_data.split(/\s+/).map(Number);
        document.getElementById("phase_correction_direct_p0").value = current_phase_correction[0];
        document.getElementById("phase_correction_direct_p1").value = current_phase_correction[1];

        /**
         * Send e.data.file_data as Unit8Array to webass2 (smile) work to process it.
         * Also need:
         * nuslist file as a string
         * apodization_direct as a string
         * indirect phase correction p0 and p1 as numbers
        */   
        let arrayBuffer = new Uint8Array(e.data.file_data);

        webassembly_worker2.postMessage({
            spectrum_data: arrayBuffer,
            nuslist_as_string: nuslist_as_string, //saved as global variable
            apodization_direct: apodization_direct, //saved as global variable
            phase_correction_indirect_p0: phase_correction_indirect_p0, 
            phase_correction_indirect_p1: phase_correction_indirect_p1,
            /**
             * Pass the current spectrum index to the worker
             */
            spectrum_index: e.data.spectrum_index,
            processing_flag: e.data.processing_flag,
        });
    }

    /**
     * If result is file_data and phasing_data, it is the frequency domain spectrum returned from the worker
     * from the time domain spectrum
     */
    else if (e.data.file_data && e.data.file_type && (e.data.file_type ==='full' || e.data.file_type ==='indirect') && e.data.phasing_data) {

        /**
         * e.data.phasing_data is a string with 4 numbers separated by space(s)
         * Firstly replace all space(s) with a single space
         * Then convert it to an array of 4 numbers
         */
        let current_phase_correction = e.data.phasing_data.split(/\s+/).map(Number);

         /**
         * Fill HTML filed with id "phase_correction_direct_p0" and "phase_correction_direct_p1" with the first two numbers
         * and "phase_correction_indirect_p0" and "phase_correction_indirect_p1" with the last two numbers
         * IF these numbers are already filled (then send to the worker), they will be returned without change,
         * that is, there is no need to fill them again, but won't hurt to fill them again (because they are the same)
         */
        if (e.data.file_type === 'full') {
            document.getElementById("phase_correction_direct_p0").value = current_phase_correction[0];
            document.getElementById("phase_correction_direct_p1").value = current_phase_correction[1];
            document.getElementById("phase_correction_indirect_p0").value = current_phase_correction[2];
            document.getElementById("phase_correction_indirect_p1").value = current_phase_correction[3];
            /**
             * In case of full, also need to update apodization_indirect because auto phase correction may change it
             */
            apodization_indirect = e.data.apodization_indirect;
            document.getElementById("apodization_indirect").value = apodization_indirect;

            /**
             * Save the phase correction values to fid_process_parameters
             */
            fid_process_parameters.phase_correction_direct_p0 = current_phase_correction[0];
            fid_process_parameters.phase_correction_direct_p1 = current_phase_correction[1];
            fid_process_parameters.phase_correction_indirect_p0 = current_phase_correction[2];
            fid_process_parameters.phase_correction_indirect_p1 = current_phase_correction[3];
            fid_process_parameters.apodization_indirect = apodization_indirect;
        }
        
        /**
         * Determine whether this is a re-process or a new process
         * if b_reprocess is true, we will replace the current spectrum
         * if b_reprocess is false, we will add the spectrum to the hsqc_spectra array
         * Both are done in draw_spectrum function
         */
        let arrayBuffer = new Uint8Array(e.data.file_data).buffer;
        let result_spectrum = new spectrum();
        result_spectrum.process_ft_file(arrayBuffer,"from_fid.ft2",-2);
        let b_reprocess = e.data.processing_flag == 1 ? true : false;
        
        result_spectrum.spectrum_index = e.data.spectrum_index; //only used when reprocess
        let result_spectra = [result_spectrum];
        

        /**
         * Process additional ft2 files (send back from webass worker) in case of pseudo 3D processing
         */
        for(let i=0;i<e.data.pseudo3d_files.length;i++)
        {
            let arrayBuffer = new Uint8Array(e.data.pseudo3d_files[i]).buffer;
            let result_spectrum = new spectrum();
            result_spectrum.process_ft_file(arrayBuffer,"pseudo3d-".concat((i+1).toString(),".ft2"),-4);
            result_spectra.push(result_spectrum);
        }
        draw_spectrum(result_spectra,true/**from fid */,b_reprocess,e.data.pseudo3d_children);

        /**
         * Clear the processing message
         */
        document.getElementById("webassembly_message").innerText = "";
        /**
         * Unselect auto phase correction
         */
        document.getElementById("auto_direct").checked = false;
        document.getElementById("auto_indirect").checked = false;
    }

    /**
     * Only file_data and phase_correction. it is a phase corrected spectrum
     */
    else if (e.data.file_data && e.data.spectrum_name)
    {
        console.log("Phase corrected spectrum received");
        document.getElementById("webassembly_message").innerText = "";
        let arrayBuffer = new Uint8Array(e.data.file_data).buffer;
        let result_spectrum = new spectrum();
        result_spectrum.process_ft_file(arrayBuffer,e.data.spectrum_name,-1);
        result_spectrum.spectrum_index = e.data.spectrum_index;
        draw_spectrum([result_spectrum],false/**from fid */,true/**re-process of fid or ft2 */);
        /**
         * If e.data.b_auto is true. This is an automatic phase correction run. We need to update
         * html element "pc_info" with the e.data.phase_correction (trim ending newline if it exists)
         */
        if(e.data.automatic_pc)
        {
            document.getElementById("pc_info").innerText =  "Phase correction: " + e.data.phase_correction.trim();
        }
    }

    /**
     * If result is pseudo3d_fitted_peaks, it is from the pseudo 3D fitting
     */
    else if (e.data.pseudo3d_fitted_peaks_tab) {
        console.log("Pseudo 3D fitted peaks received");
        pseudo3d_fitted_peaks_object = new cpeaks();
        pseudo3d_fitted_peaks_object.process_peaks_tab(e.data.pseudo3d_fitted_peaks_tab);

        /**
         * Enable the download fitted peaks button and show the fitted peaks button
         */
        document.getElementById("button_download_fitted_peaks").disabled = false;
        document.getElementById("show_pseudo3d_peaks").disabled = false;

        /**
         * Uncheck all other show peaks checkboxes
         */
        for(let i=0;i<hsqc_spectra.length;i++)
        {
            /**
             * -3 means removed spectrum, all DOM element for removed spectrum is also removed
             */
            if(hsqc_spectra[i].spectrum_origin !== -3)
            {
                document.getElementById("show_peaks-".concat(i)).checked = false;
                document.getElementById("show_fitted_peaks-".concat(i)).checked = false;
            }
        }

        /**
         * Uncheck the show_peaks checkbox then simulate a click event to show the peaks (with updated peaks from fitted_peaks)
         */
        document.getElementById("show_pseudo3d_peaks").checked = false;
        document.getElementById("show_pseudo3d_peaks").click();

        /**
         * Clear the processing message
         */
        document.getElementById("webassembly_message").innerText = "";
        /**
         * Re-enable the run pseudo 3D buttons
         */
        document.getElementById("button_run_pseudo3d_gaussian").disabled = false;
        document.getElementById("button_run_pseudo3d_voigt").disabled = false;
        /**
         * Enable the assignment_file
         */
        document.getElementById("assignment_file").disabled = false;
    }

    else if(e.data.matched_peaks_tab)
    {
        console.log("Assignment transfer received.");
        /**
         * Update pseudo3d_fitted_peaks_object with the assignment
         */
        pseudo3d_fitted_peaks_object.process_peaks_tab(e.data.matched_peaks_tab);
    }

    else if(e.data.webassembly_job === "spin_optimization")
    {
        process_spin_optimization_result(e.data.spin_system);
    }

    else{
        console.log(e.data);
    }
};

var plot_div_resize_observer = new ResizeObserver(entries => {
    for (let entry of entries) {

        const cr = entry.contentRect;
        let padding = 20;
        let margin_left = plot_margin_left;
        let margin_top = plot_margin_top;
        let margin_right = plot_margin_right;
        let margin_bottom = plot_margin_bottom;

        resize_main_plot(cr.width,cr.height,padding,margin_left,margin_top,margin_right,margin_bottom);
    }
});


function resize_main_plot(wid, height, padding, margin_left, margin_top, margin_right, margin_bottom)
{
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

    /**
     * Also resize cross_section_x width to be the same as the width of the visualization div
     * and cross_section_y height to be the same as the height of the visualization div
     */
    document.getElementById('cross_section_x').style.width = wid.toString().concat('px');
    document.getElementById('cross_section_svg_x').setAttribute("width", wid.toString().concat('px'));
    document.getElementById('cross_section_y').style.height = height.toString().concat('px');
    document.getElementById('cross_section_svg_y').setAttribute("height", height.toString().concat('px'));
}

/**
 * Drag and drop spectra to reorder them 
 */
const sortableList = document.getElementById("spectra_list_ol");

sortableList.addEventListener(
    "dragstart",
    (e) => {
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
                main_plot.redraw_contour_order();
            }
        }, 1000);
    });
 
sortableList.addEventListener(
    "dragover",
    (e) => {
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
            );} 
        else {
            sortableList.insertBefore(
                draggedItem,
                afterElement
            );}
    });
 
const getDragAfterElement = (container, y) =>
{
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

function minimize_fid_area(self)
{
    /**
     * Get button text
     */
    let button_text = self.innerText;
    /**
     * if button_text is "+", change it to "-"
     * and set the height of the fid_file_area to 3rem, clip the overflow
     */
    if(button_text === "-")
    {
        self.innerText = "+";
        document.getElementById("fid_file_area").style.height = "3rem";
        document.getElementById("fid_file_area").style.overflow = "clip";
    }
    /**
     * if button_text is "-", change it to "+". Set the height of the fid_file_area to auto, visible overflow
     */
    else
    {
        self.innerText = "-";
        document.getElementById("fid_file_area").style.height = "auto";
        document.getElementById("fid_file_area").style.overflow = "visible";
    }
}

function minimize_pseudo3d_area(self)
{
    /**
     * Get button text
     */
    let button_text = self.innerText;
    /**
     * if button_text is "+", change it to "-"
     * and set the height of the pseudo3d_area to 3rem, clip the overflow
     */
    if(button_text === "-")
    {
        self.innerText = "+";
        document.getElementById("pseudo3d_area").style.height = "3rem";
        document.getElementById("pseudo3d_area").style.overflow = "clip";
    }
    else
    {
        self.innerText = "-";
        document.getElementById("pseudo3d_area").style.height = "auto";
        document.getElementById("pseudo3d_area").style.overflow = "visible";
    }
}

function minimize_file_area(self)
{
    /**
     * Get button text
     */
    let button_text = self.innerText;
    /**
     * if button_text is "+", change it to "-"
     * and set the height of the file_area to 3rem, clip the overflow
     */
    if(button_text === "-")
    {
        self.innerText = "+";
        document.getElementById("file_area").style.height = "3rem";
        document.getElementById("file_area").style.overflow = "clip";
    }
    /**
     * if button_text is "-", change it to "+". Set the height of the file_area to auto, visible overflow
    */
    else
    {
        self.innerText = "-";
        document.getElementById("file_area").style.height = "auto";
        document.getElementById("file_area").style.overflow = "visible";
    }
}


function minimize_spectrum(button,index)
{
    let spectrum_div = document.getElementById("spectrum-".concat(index)).querySelector("div");
    let minimize_button = button;
    if(minimize_button.innerText === "-")
    {
        minimize_button.innerText = "+";
        spectrum_div.style.height = "1.75rem";
        spectrum_div.style.overflow = "clip";
        /**
         * Also set lbs to hide all contours for this spectrum
         */
        hsqc_spectra[index].visible = false;

        /**
         * Loop all spectra, find children of this spectrum, hide them too
         */
        for(let i=0;i<hsqc_spectra.length;i++)
        {
            if(hsqc_spectra[i].spectrum_origin === index)
            {
                hsqc_spectra[i].visible = false;
            }
        }


        main_plot.redraw_contour();
    }
    else
    {
        minimize_button.innerText = "-";
        spectrum_div.style.height = "auto";
        hsqc_spectra[index].visible = true;

        /**
         * Loop all spectra, find children of this spectrum, show them too
         */
        for(let i=0;i<hsqc_spectra.length;i++)
        {
            if(hsqc_spectra[i].spectrum_origin === index)
            {
                hsqc_spectra[i].visible = true;
            }
        }
        main_plot.redraw_contour();
    }

}


function add_to_list(index) {
    let new_spectrum = hsqc_spectra[index];
    let new_spectrum_div_list = document.createElement("li");
    let new_spectrum_div = document.createElement("div");

    /**
     * Assign a ID to the new spectrum div
     */
    new_spectrum_div_list.id = "spectrum-".concat(index);

    /**
     * Add a draggable div to the new spectrum div, only if the spectrum is experimental
     */
    if(new_spectrum.spectrum_origin === -1 || new_spectrum.spectrum_origin === -2 || new_spectrum.spectrum_origin >=10000)
    {
        /**
         * Also add an minimize button to the new spectrum div
         */
        let minimize_button = document.createElement("button");
        minimize_button.innerText = "-";
        minimize_button.onclick = function () { minimize_spectrum(this,index); };
        new_spectrum_div.appendChild(minimize_button);

        let draggable_span = document.createElement("span");
        draggable_span.draggable = true;
        draggable_span.classList.add("draggable");
        draggable_span.appendChild(document.createTextNode("\u2195 Drag me. "));
        draggable_span.style.cursor = "move";
        new_spectrum_div.appendChild(draggable_span);
    }

    /**
     * Add a "Reprocess" button to the new spectrum div if
     * 1. spectrum_origin == -2 (experimental spectrum from fid, and must be first if from pseudo 3D)
     * TODO: 2. spectrum_origin == -1 (experimental spectrum from ft2) && raw_data_ri or raw_data_ir is not empty
     */
    if(new_spectrum.spectrum_origin === -2)
    {
        let reprocess_button = document.createElement("button");
        reprocess_button.innerText = "Reprocess";
        reprocess_button.onclick = function () { reprocess_spectrum(this,index); };
        new_spectrum_div.appendChild(reprocess_button);
    }

    /**
     * If this is a reconstructed spectrum, add a button called "Remove me"
     */
    if (new_spectrum.spectrum_origin >= 0 && new_spectrum.spectrum_origin < 10000) {
        let remove_button = document.createElement("button");
        remove_button.innerText = "Remove me";
        remove_button.onclick = function () { remove_spectrum_caller(index); };
        new_spectrum_div.appendChild(remove_button);
    }
    
    if(new_spectrum.spectrum_origin === -1 || new_spectrum.spectrum_origin === -2 || new_spectrum.spectrum_origin >=10000)
    {
        /**
         * The new DIV will have the following children:
         * A original index (which is different from the index in the list, because of the order change by drag and drop)
         */
        new_spectrum_div.appendChild(document.createTextNode("Original index: ".concat(index.toString(), ", ")));
        /**
         * Add filename as a text node
         */
        let fname_text = document.createTextNode(" File name: " + hsqc_spectra[index].filename + " ");
        new_spectrum_div.appendChild(fname_text);
        new_spectrum_div.appendChild(document.createElement("br"));


        new_spectrum_div.appendChild(document.createTextNode("Noise: " + new_spectrum.noise_level.toExponential(4) + ","));
        /**
         * Add two input text element with ID ref1 and ref2, default value is 0 and 0
         * They also have a label element with text "Ref direct: " and "Ref indirect: "
         * They also have an onblur event to update the ref_direct and ref_indirect values
         */
        let ref_direct_label = document.createElement("label");
        ref_direct_label.setAttribute("for", "ref1-".concat(index));
        ref_direct_label.innerText = " Ref direct: ";
        let ref_direct_input = document.createElement("input");
        ref_direct_input.setAttribute("type", "text");
        ref_direct_input.setAttribute("id", "ref1-".concat(index));
        ref_direct_input.setAttribute("size", "4");
        ref_direct_input.setAttribute("value", "0.0");
        ref_direct_input.onblur = function () { adjust_ref(index, 0); };
        new_spectrum_div.appendChild(ref_direct_label);
        new_spectrum_div.appendChild(ref_direct_input);

        let ref_indirect_label = document.createElement("label");
        ref_indirect_label.setAttribute("for", "ref2-".concat(index));
        ref_indirect_label.innerText = " Ref indirect: ";
        let ref_indirect_input = document.createElement("input");
        ref_indirect_input.setAttribute("type", "text");
        ref_indirect_input.setAttribute("id", "ref2-".concat(index));
        ref_indirect_input.setAttribute("size", "4");
        ref_indirect_input.setAttribute("value", "0.0");
        ref_indirect_input.onblur = function () { adjust_ref(index, 1); };
        new_spectrum_div.appendChild(ref_indirect_label);
        new_spectrum_div.appendChild(ref_indirect_input);


        /**
         * Add 3 radio buttons to select:
         * 1. show cross section
         * 2. show projection (default, checked)
         * and a new line
         */
        let show_cross_section_radio = document.createElement("input");
        show_cross_section_radio.setAttribute("type", "radio");
        show_cross_section_radio.setAttribute("id", "show_cross_section-".concat(index));   
        show_cross_section_radio.setAttribute("name", "show-".concat(index));
        show_cross_section_radio.onclick = function () { show_cross_section(index); };
        let show_cross_section_label = document.createElement("label");
        show_cross_section_label.setAttribute("for", "show_cross_section-".concat(index));
        show_cross_section_label.innerText = " Cross section ";
        new_spectrum_div.appendChild(show_cross_section_radio);
        new_spectrum_div.appendChild(show_cross_section_label);

        let show_projection_radio = document.createElement("input");
        show_projection_radio.setAttribute("type", "radio");
        show_projection_radio.setAttribute("id", "show_projection-".concat(index));
        show_projection_radio.setAttribute("name", "show-".concat(index));
        show_projection_radio.checked = true;
        show_projection_radio.onclick = function () { show_projection(index); };
        let show_projection_label = document.createElement("label");
        show_projection_label.setAttribute("for", "show_projection-".concat(index));
        show_projection_label.innerText = " Projection ";
        new_spectrum_div.appendChild(show_projection_radio);
        new_spectrum_div.appendChild(show_projection_label);
    }


    /**
     * Add a download button to download the spectrum 
     * Allow download of from fid and from reconstructed spectrum
     */
    let download_button = document.createElement("button");
    download_button.innerText = "Download ft2";
    download_button.onclick = function () { download_spectrum(index,'original'); };
    new_spectrum_div.appendChild(download_button);
    /**
     * Add a different spectrum download button for reconstructed spectrum only
     */
    if (new_spectrum.spectrum_origin >=0 && new_spectrum.spectrum_origin < 10000) {
        let download_button = document.createElement("button");
        download_button.innerText = "Download diff.ft2";
        download_button.onclick = function () { download_spectrum(index,'diff'); };
        new_spectrum_div.appendChild(download_button);
    }
    new_spectrum_div.appendChild(document.createElement("br"));


    /**
     * If the spectrum is experimental, add a run_DEEP_Picker, run Voigt fitter, run Gaussian fitter, and download peaks button
     */
    if(new_spectrum.spectrum_origin === -1 || new_spectrum.spectrum_origin === -2 || new_spectrum.spectrum_origin >=10000)
    {
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
         * Add a run_DEEP_Picker button to run DEEP picker. Default is enabled
         */
        let deep_picker_button = document.createElement("button");
        deep_picker_button.setAttribute("id", "run_deep_picker-".concat(index));
        deep_picker_button.innerText = "DEEP Picker";
        deep_picker_button.onclick = function () { run_DEEP_Picker(index,0); };
        new_spectrum_div.appendChild(deep_picker_button);

        /**
         * Add a run_Simple_Picker button to run simple picker. Default is enabled
         */
        let simple_picker_button = document.createElement("button");
        simple_picker_button.setAttribute("id", "run_simple_picker-".concat(index));
        simple_picker_button.innerText = "Simple Picker";
        simple_picker_button.onclick = function () { run_DEEP_Picker(index,1); };
        new_spectrum_div.appendChild(simple_picker_button);

        new_spectrum_div.appendChild(document.createElement("br"));

        /**
         * Add a combine_peak cutoff input filed with ID "combine_peak_cutoff-".concat(index)
         * run_Voigt_fitter() will read this value and send to wasm to combine peaks in the fitting
         */
        let combine_peak_cutoff_label = document.createElement("label");
        combine_peak_cutoff_label.setAttribute("for", "combine_peak_cutoff-".concat(index));
        combine_peak_cutoff_label.innerText = " Combine peak cutoff: ";
        let combine_peak_cutoff_input = document.createElement("input");
        combine_peak_cutoff_input.setAttribute("type", "number");
        combine_peak_cutoff_input.setAttribute("step", "0.01");
        combine_peak_cutoff_input.setAttribute("min", "0.00");
        combine_peak_cutoff_input.setAttribute("id", "combine_peak_cutoff-".concat(index));
        combine_peak_cutoff_input.setAttribute("size", "1");
        combine_peak_cutoff_input.setAttribute("value", "0.1");
        new_spectrum_div.appendChild(combine_peak_cutoff_label);
        new_spectrum_div.appendChild(combine_peak_cutoff_input);

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
         * Default is disabled
         */
        let run_voigt_fitter_select = document.createElement("select");
        run_voigt_fitter_select.setAttribute("id", "run_voigt_fitter_select-".concat(index));
        let run_voigt_fitter_select_label = document.createElement("label");
        run_voigt_fitter_select_label.setAttribute("for", "run_voigt_fitter_select-".concat(index));
        run_voigt_fitter_select_label.innerText = " Peak profile: ";
        /**
         * Add three options: Voigt, Gaussian, and Voigt_Lorentzian
         */
        let voigt_option = document.createElement("option");
        voigt_option.setAttribute("value", "0");
        voigt_option.innerText = "Voigt";
        run_voigt_fitter_select.appendChild(voigt_option);

        let gaussian_option = document.createElement("option");
        gaussian_option.setAttribute("value", "1");
        gaussian_option.innerText = "Gaussian";
        run_voigt_fitter_select.appendChild(gaussian_option);

        let voigt_lorentzian_option = document.createElement("option");
        voigt_lorentzian_option.setAttribute("value", "2");
        voigt_lorentzian_option.innerText = "Voigt_Lorentzian";
        run_voigt_fitter_select.appendChild(voigt_lorentzian_option);
        
        
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
        run_voigt_fitter_button0.disabled = true;
        run_voigt_fitter_button0.setAttribute("id", "run_voigt_fitter-".concat(index));
        new_spectrum_div.appendChild(run_voigt_fitter_button0);

       

        /**
         * Add a new line
         */
        new_spectrum_div.appendChild(document.createElement("br"));
    }

    /**
     * Add a download button to download the picked peaks. Default is disabled unless it is a reconstructed spectrum
     */
    let download_peaks_button = document.createElement("button");
    download_peaks_button.innerText = "Download picked peaks";
    if(new_spectrum.spectrum_origin === -1 || new_spectrum.spectrum_origin === -2 || new_spectrum.spectrum_origin >=10000){
        download_peaks_button.disabled = true;
    }
    download_peaks_button.setAttribute("id", "download_peaks-".concat(index));
    download_peaks_button.onclick = function () { download_peaks(index,'picked'); };
    new_spectrum_div.appendChild(download_peaks_button);

    /**
     * Add a download button to download the fitted peaks. Default is disabled unless it is a reconstructed spectrum
     */
    let download_fitted_peaks_button = document.createElement("button");
    download_fitted_peaks_button.innerText = "Download fitted peaks";
    if(new_spectrum.spectrum_origin === -1 || new_spectrum.spectrum_origin === -2 || new_spectrum.spectrum_origin >=10000){
        download_fitted_peaks_button.disabled = true;
    }
    download_fitted_peaks_button.setAttribute("id", "download_fitted_peaks-".concat(index));
    download_fitted_peaks_button.onclick = function () { download_peaks(index,'fitted'); };
    new_spectrum_div.appendChild(download_fitted_peaks_button);

    /**
     * Add a checkbox to show or hide the picked peaks. Default is unchecked
     * It has an event listener to show or hide the peaks
     */
    let show_peaks_checkbox = document.createElement("input");
    show_peaks_checkbox.setAttribute("type", "checkbox");
    if(new_spectrum.spectrum_origin === -1 || new_spectrum.spectrum_origin === -2 || new_spectrum.spectrum_origin >=10000){
        show_peaks_checkbox.disabled = true;
    }
    show_peaks_checkbox.setAttribute("id", "show_peaks-".concat(index));
    show_peaks_checkbox.onclick = function (e) {
        /**
         * If the checkbox is checked, show the peaks
         */
        if (e.target.checked) {
            show_hide_peaks(index,'picked', true);
        }
        else {
            show_hide_peaks(index,'picked', false);
        }
    }
    new_spectrum_div.appendChild(show_peaks_checkbox);
    let show_peaks_label = document.createElement("label");
    show_peaks_label.setAttribute("for", "show_peaks-".concat(index));
    show_peaks_label.innerText = "Show picked peaks";
    new_spectrum_div.appendChild(show_peaks_label);

    /**
     * Add a checkbox to show or hide the fitted peaks. Default is unchecked
     */
    let show_fitted_peaks_checkbox = document.createElement("input");
    show_fitted_peaks_checkbox.setAttribute("type", "checkbox");
    if(new_spectrum.spectrum_origin === -1 || new_spectrum.spectrum_origin === -2 || new_spectrum.spectrum_origin >=10000){
        show_fitted_peaks_checkbox.disabled = true;
    }
    show_fitted_peaks_checkbox.setAttribute("id", "show_fitted_peaks-".concat(index));
    show_fitted_peaks_checkbox.onclick = function (e) {
        /**
         * If the checkbox is checked, show the peaks
         */
        if (e.target.checked) {
            show_hide_peaks(index,'fitted', true);
        }
        else {
            show_hide_peaks(index,'fitted', false);
        }
    }
    new_spectrum_div.appendChild(show_fitted_peaks_checkbox);
    let show_fitted_peaks_label = document.createElement("label");
    show_fitted_peaks_label.setAttribute("for", "show_fitted_peaks-".concat(index));
    show_fitted_peaks_label.innerText = "Show fitted peaks";
    new_spectrum_div.appendChild(show_fitted_peaks_label);



    /**
     * Add a new line
    */
    new_spectrum_div.appendChild(document.createElement("br"));  
    

    /**
     * Positive contour levels first
     * A input text element with the lowest contour level for contour calculation, whose ID is "contour0-".concat(index)
     */
    let contour0_input_label = document.createElement("label");
    contour0_input_label.setAttribute("for", "contour0-".concat(index));
    contour0_input_label.innerText = "Lowest: ";
    let contour0_input = document.createElement("input");
    contour0_input.setAttribute("type", "text");
    contour0_input.setAttribute("id", "contour0-".concat(index));
    contour0_input.setAttribute("size", "8");
    contour0_input.setAttribute("min",0.001);
    contour0_input.setAttribute("value", new_spectrum.levels[0].toExponential(4));
    new_spectrum_div.appendChild(contour0_input_label);
    new_spectrum_div.appendChild(contour0_input);


    let reduce_contour_button = document.createElement("button");
    /**
     * Create a text node with the text ">" and class rotate90
     */
    let textnode = document.createTextNode(">");
    let textdiv = document.createElement("div");
    textdiv.appendChild(textnode);
    textdiv.classList.add("rotate90");

    reduce_contour_button.appendChild(textdiv);
    reduce_contour_button.onclick = function() { reduce_contour(index,0); };
    reduce_contour_button.style.marginLeft = "1em";
    reduce_contour_button.style.marginRight = "1em";
    reduce_contour_button.setAttribute("id", "reduce_contour-".concat(index));
    /**
     * Add a tooltip to the button
     */
    reduce_contour_button.setAttribute("title", "Insert a new level, which is the current level divided by the logarithmic scale. This is more efficient than full recalculation.");
    new_spectrum_div.appendChild(reduce_contour_button);



    /**
     * A input text element with the logarithmic scale for contour calculation, whose ID is "logarithmic_scale-".concat(index)
     */
    let logarithmic_scale_input_label = document.createElement("label");
    logarithmic_scale_input_label.setAttribute("for", "logarithmic_scale-".concat(index));
    logarithmic_scale_input_label.innerText = "Scale: ";
    let logarithmic_scale_input = document.createElement("input");
    logarithmic_scale_input.setAttribute("type", "text");
    logarithmic_scale_input.setAttribute("id", "logarithmic_scale-".concat(index));
    logarithmic_scale_input.setAttribute("value", "1.5");
    logarithmic_scale_input.setAttribute("size", "3");
    logarithmic_scale_input.setAttribute("min",1.05);
    new_spectrum_div.appendChild(logarithmic_scale_input_label);
    new_spectrum_div.appendChild(logarithmic_scale_input);

    /**
     * A button to update the contour plot with the new lowest level and logarithmic scale
     */
    let update_contour_button = document.createElement("button");
    update_contour_button.innerText = "Recalculate";
    update_contour_button.onclick = function() { update_contour0_or_logarithmic_scale(index,0); };
    update_contour_button.setAttribute("title","Update the contour plot with the new lowest level and logarithmic scale. This process might be slow.");
    update_contour_button.style.marginLeft = "1em";
    update_contour_button.style.marginRight = "1em";
    new_spectrum_div.appendChild(update_contour_button);

    /**
     * A input number element with the number of contour levels,for linear contour levels
     * whose ID is "number_of_contours-".concat(index). Default value is 30
     */
    let number_of_contours_label = document.createElement("label");
    number_of_contours_label.setAttribute("for", "number_of_contours-".concat(index));
    number_of_contours_label.innerText = " # of linear contours: ";
    let number_of_contours_input = document.createElement("input");
    number_of_contours_input.setAttribute("type", "number"); 
    number_of_contours_input.setAttribute("min", "10");
    number_of_contours_input.setAttribute("max", "50");
    number_of_contours_input.setAttribute("value", "30");
    number_of_contours_input.setAttribute("id", "number_of_contours-".concat(index));
    /**
     * A button to update the contour plot with the new number of linear contour levels
     */
    let update_contour_button_linear = document.createElement("button");
    update_contour_button_linear.innerText = "Recalculate";
    update_contour_button_linear.onclick = function() { update_linear_scale(index,0); };
    update_contour_button_linear.setAttribute("title","Update the contour plot with the new number of linear contour levels. This process might be slow.");
    update_contour_button_linear.style.marginLeft = "1em";
    update_contour_button_linear.style.marginRight = "1em";
    new_spectrum_div.appendChild(number_of_contours_label);
    new_spectrum_div.appendChild(number_of_contours_input);
    new_spectrum_div.appendChild(update_contour_button_linear);

    /**
     * Add a new line and a slider for the contour level
     * Add a event listener to update the contour level
     */
    let contour_slider = document.createElement("input");
    contour_slider.setAttribute("type", "range");
    contour_slider.setAttribute("id", "contour-slider-".concat(index));
    contour_slider.setAttribute("min", "1");
    contour_slider.setAttribute("max", hsqc_spectra[index].levels.length.toString());
    contour_slider.style.width = "10%";
    contour_slider.addEventListener("input", (e) => { update_contour_slider(e, index, 'positive'); });
    
    /**
     * A span element with the current contour level, whose ID is "contour_level-".concat(index)
     */
    let contour_level_span = document.createElement("span");
    contour_level_span.setAttribute("id", "contour_level-".concat(index));
    contour_level_span.classList.add("information");
    
    if(total_number_of_experimental_spectra<=4)
    {
        contour_slider.setAttribute("value", "1");
        contour_level_span.innerText = new_spectrum.levels[0].toExponential(4);
    }
    else
    {
        contour_slider.setAttribute("value", (hsqc_spectra[index].levels.length).toString());
        contour_level_span.innerText = new_spectrum.levels[hsqc_spectra[index].levels.length-1].toExponential(4);
    }
    new_spectrum_div.appendChild(contour_slider);
    new_spectrum_div.appendChild(contour_level_span);


    /**
     * Add some spaces
     */
    new_spectrum_div.appendChild(document.createTextNode("  "));

    /**
     * A color picker element with the color of the contour plot, whose ID is "contour_color-".concat(index)
     * Set the color of the picker to the color of the spectrum
     * Also add an event listener to update the color of the contour plot
     */
    let contour_color_label = document.createElement("label");
    contour_color_label.setAttribute("for", "contour_color-".concat(index));
    contour_color_label.innerText = "Color: ";
    let contour_color_input = document.createElement("input");
    contour_color_input.setAttribute("type", "color");
    contour_color_input.setAttribute("value", rgbToHex(new_spectrum.spectrum_color));
    contour_color_input.setAttribute("id", "contour_color-".concat(index));
    contour_color_input.addEventListener("change", (e) => { update_contour_color(e, index, 0); });
    new_spectrum_div.appendChild(contour_color_label);
    new_spectrum_div.appendChild(contour_color_input);

    /**
     * Add a line break
     */
    new_spectrum_div.appendChild(document.createElement("br"));



    /**
     * Negative contour levels first
     * A input text element with the lowest contour level for contour calculation
     */
    let contour0_input_label_negative = document.createElement("label");
    contour0_input_label_negative.setAttribute("for", "contour0_negative-".concat(index));
    contour0_input_label_negative.innerText = "Lowest: ";
    let contour0_input_negative = document.createElement("input");
    contour0_input_negative.setAttribute("type", "text");
    contour0_input_negative.setAttribute("id", "contour0_negative-".concat(index));
    contour0_input_negative.setAttribute("size", "8");
    contour0_input_negative.setAttribute("min", 0.001);
    contour0_input_negative.setAttribute("value", new_spectrum.negative_levels[0].toExponential(4));
    new_spectrum_div.appendChild(contour0_input_label_negative);
    new_spectrum_div.appendChild(contour0_input_negative);


    let reduce_contour_button_negative = document.createElement("button");
    /**
     * Create a text node with the text ">" and class rotate90
     */
    let textnode_negative = document.createTextNode(">");
    let textdiv_negative = document.createElement("div");
    textdiv_negative.appendChild(textnode_negative);
    textdiv_negative.classList.add("rotate90");

    reduce_contour_button_negative.appendChild(textdiv_negative);
    reduce_contour_button_negative.onclick = function () { reduce_contour(index, 1); };
    reduce_contour_button_negative.style.marginLeft = "1em";
    reduce_contour_button_negative.style.marginRight = "1em";
    reduce_contour_button_negative.setAttribute("id", "reduce_contour_negative-".concat(index));
    /**
     * Add a tooltip to the button
     */
    reduce_contour_button_negative.setAttribute("title", "Insert a new level, which is the current level divided by the logarithmic scale. This is more efficient than full recalculation.");
    new_spectrum_div.appendChild(reduce_contour_button_negative);



    /**
     * A input text element with the logarithmic scale for contour calculation, whose ID is "logarithmic_scale-".concat(index)
     */
    let logarithmic_scale_input_label_negative = document.createElement("label");
    logarithmic_scale_input_label_negative.setAttribute("for", "logarithmic_scale_negative-".concat(index));
    logarithmic_scale_input_label_negative.innerText = "Scale: ";
    let logarithmic_scale_input_negative = document.createElement("input");
    logarithmic_scale_input_negative.setAttribute("type", "text");
    logarithmic_scale_input_negative.setAttribute("id", "logarithmic_scale_negative-".concat(index));
    logarithmic_scale_input_negative.setAttribute("value", "1.5");
    logarithmic_scale_input_negative.setAttribute("size", "3");
    logarithmic_scale_input_negative.setAttribute("min", 1.05);
    new_spectrum_div.appendChild(logarithmic_scale_input_label_negative);
    new_spectrum_div.appendChild(logarithmic_scale_input_negative);

    /**
     * A button to update the contour plot with the new lowest level and logarithmic scale
     */
    let update_contour_button_negative = document.createElement("button");
    update_contour_button_negative.innerText = "Recalculate";
    update_contour_button_negative.onclick = function () { update_contour0_or_logarithmic_scale(index, 1); };
    update_contour_button_negative.setAttribute("title", "Update the contour plot with the new lowest level and logarithmic scale. This process might be slow.");
    update_contour_button_negative.style.marginLeft = "1em";
    update_contour_button_negative.style.marginRight = "1em";
    new_spectrum_div.appendChild(update_contour_button_negative);


     /**
     * A input number element with the number of negative contour levels,for linear contour levels
     * whose ID is "number_of_negative_contours-".concat(index). Default value is 30
     */
    let number_of_negative_contours_label = document.createElement("label");
    number_of_negative_contours_label.setAttribute("for", "number_of_negative_contours-".concat(index));
    number_of_negative_contours_label.innerText = " # of linear contours: ";
    let number_of_negative_contours_input = document.createElement("input");
    number_of_negative_contours_input.setAttribute("type", "number");
    number_of_negative_contours_input.setAttribute("min", "10");
    number_of_negative_contours_input.setAttribute("max", "60");
    number_of_negative_contours_input.setAttribute("value", "30");
    number_of_negative_contours_input.setAttribute("id", "number_of_negative_contours-".concat(index));
    /**
     * A button to update the contour plot with the new number of linear contour levels
     */
    let update_contour_button_linear_negative = document.createElement("button");
    update_contour_button_linear_negative.innerText = "Recalculate";
    update_contour_button_linear_negative.onclick = function () { update_linear_scale(index, 1); };
    update_contour_button_linear_negative.setAttribute("title", "Update the contour plot with the new number of linear contour levels. This process might be slow.");
    update_contour_button_linear_negative.style.marginLeft = "1em";
    update_contour_button_linear_negative.style.marginRight = "1em";
    new_spectrum_div.appendChild(number_of_negative_contours_label);
    new_spectrum_div.appendChild(number_of_negative_contours_input);
    new_spectrum_div.appendChild(update_contour_button_linear_negative);


    /**
     * Add a new line and a slider for the contour level
     * Add a event listener to update the contour level
     */
    let contour_slider_negative = document.createElement("input");
    contour_slider_negative.setAttribute("type", "range");
    contour_slider_negative.setAttribute("id", "contour-slider_negative-".concat(index));
    contour_slider_negative.setAttribute("min", "1");
    contour_slider_negative.setAttribute("max", hsqc_spectra[index].negative_levels.length.toString());
    contour_slider_negative.style.width = "10%";
    contour_slider_negative.addEventListener("input", (e) => { update_contour_slider(e, index, 'negative'); });
    

    /**
     * A span element with the current contour level, whose ID is "contour_level-".concat(index)
     */
    let contour_level_span_negative = document.createElement("span");
    contour_level_span_negative.setAttribute("id", "contour_level_negative-".concat(index));
    contour_level_span_negative.classList.add("information");

    if(total_number_of_experimental_spectra<=4)
    {
        contour_slider_negative.setAttribute("value", "1");
        contour_level_span_negative.innerText = new_spectrum.negative_levels[0].toExponential(4);
    }
    else
    {
        contour_slider_negative.setAttribute("value", (hsqc_spectra[index].negative_levels.length).toString());
        contour_level_span_negative.innerText = new_spectrum.negative_levels[hsqc_spectra[index].negative_levels.length-1].toExponential(4);
    }

    new_spectrum_div.appendChild(contour_slider_negative);
    new_spectrum_div.appendChild(contour_level_span_negative);

    /**
     * Add some spaces
     */
    new_spectrum_div.appendChild(document.createTextNode("  "));

    /**
     * A color picker element with the color of the contour plot, whose ID is "contour_color-".concat(index)
     * Set the color of the picker to the color of the spectrum
     * Also add an event listener to update the color of the contour plot
     */
    let contour_color_label_negative = document.createElement("label");
    contour_color_label_negative.setAttribute("for", "contour_color_negative-".concat(index));
    contour_color_label_negative.innerText = "Color: ";
    let contour_color_input_negative = document.createElement("input");
    contour_color_input_negative.setAttribute("type", "color");
    contour_color_input_negative.setAttribute("value", rgbToHex(new_spectrum.spectrum_color_negative));
    contour_color_input_negative.setAttribute("id", "contour_color_negative-".concat(index));
    contour_color_input_negative.addEventListener("change", (e) => { update_contour_color(e, index, 1); });
    new_spectrum_div.appendChild(contour_color_label_negative);
    new_spectrum_div.appendChild(contour_color_input_negative);

    /**
     * For experimental spectra:
     * Add a h5 element to hold the title of "Reconstructed spectrum"
     * Add a ol element to hold reconstructed spectrum
     */
    if(new_spectrum.spectrum_origin < 0 || new_spectrum.spectrum_origin >= 10000)
    {
        let reconstructed_spectrum_h5 = document.createElement("h5");
        reconstructed_spectrum_h5.innerText = "Reconstructed spectrum";
        new_spectrum_div.appendChild(reconstructed_spectrum_h5);
        let reconstructed_spectrum_ol = document.createElement("ol");
        reconstructed_spectrum_ol.setAttribute("id", "reconstructed_spectrum_ol-".concat(index));   
        new_spectrum_div.appendChild(reconstructed_spectrum_ol);
    }

    new_spectrum_div_list.appendChild(new_spectrum_div);

    /**
     * Add the new spectrum div to the list of spectra if it is from experimental data
    */
    if(hsqc_spectra[index].spectrum_origin < 0 || hsqc_spectra[index].spectrum_origin >= 10000)
    {
        document.getElementById("spectra_list_ol").appendChild(new_spectrum_div_list);
    }
    /**
     * If the spectrum is reconstructed, add the new spectrum div to the reconstructed spectrum list
     */
    else
    {
        document.getElementById("reconstructed_spectrum_ol-".concat(hsqc_spectra[index].spectrum_origin)).appendChild(new_spectrum_div_list);
    }

    if(new_spectrum.spectrum_origin === -1 || new_spectrum.spectrum_origin === -2 || new_spectrum.spectrum_origin >=10000)
    {
        total_number_of_experimental_spectra += 1;
        /**
         * If we have 2 or more experimental spectra, we enable the run_Voigt_fitter button
         */
        if(total_number_of_experimental_spectra >= 2)
        {
            document.getElementById("button_run_pseudo3d_gaussian").disabled = false;
            document.getElementById("button_run_pseudo3d_voigt").disabled = false;
        }

        /**
         * For experimental spectrum, switch default to show projection
         */
        show_projection(index);
    }

}

my_contour_worker.onmessage = (e) => {

    if (typeof e.data.message !== "undefined") {
        document.getElementById("contour_message").innerText = e.data.message;
        return;
    }
    else if(typeof e.data.remove_spectrum !== "undefined")
    {
        remove_spectrum(e.data.remove_spectrum);
        return;
    }

    /**
     * If the message is not a message, it is a result from the worker.
     */

    console.log("Message received from worker, spectral type: " + e.data.spectrum_type);


    if (e.data.spectrum_type === "full" && e.data.spectrum_index > main_plot.levels_length_negative.length)
    {
        /**
         * This is impossible unless there is a bug in the code
         */
        console.log("Error: spectrum_index is larger than main_plot.levels_length_negative.length");
    }

    /**
     * Type is full and spectrum_index === main_plot.levels_length_negative.length, we are adding spectrum
     */
    else if (e.data.spectrum_type === "full" && e.data.spectrum_index === main_plot.levels_length_negative.length)
    {

        if(e.data.contour_sign === 0)
        {   
            /**
             * Append data to main_plot
             */
            main_plot.levels_length.push(e.data.levels_length);
            main_plot.polygon_length.push(e.data.polygon_length);
            main_plot.colors.push(hsqc_spectra[e.data.spectrum_index].spectrum_color);

            /**
             * Default contour level is 0, when total_number_of_experimental_spectra <=5
             */
            if(total_number_of_experimental_spectra <= 4)
            {
                main_plot.contour_lbs.push(0);
            }
            else
            {
                /**
                 * Set to highest level to avoid too many contour plots
                 */
                let highest_level = hsqc_spectra[e.data.spectrum_index].levels.length - 1;
                main_plot.contour_lbs.push(highest_level);
            }

            /**
             * Keep track of the start of the points array (Float32Array)
             */
            main_plot.points_start.push(main_plot.points.length);
            main_plot.points=Float32Concat(main_plot.points, new Float32Array(e.data.points));

            main_plot.spectral_information.push({
                n_direct: hsqc_spectra[e.data.spectrum_index].n_direct,
                n_indirect: hsqc_spectra[e.data.spectrum_index].n_indirect,
                x_ppm_start: hsqc_spectra[e.data.spectrum_index].x_ppm_start,
                x_ppm_step: hsqc_spectra[e.data.spectrum_index].x_ppm_step,
                y_ppm_start: hsqc_spectra[e.data.spectrum_index].y_ppm_start,
                y_ppm_step: hsqc_spectra[e.data.spectrum_index].y_ppm_step,
                x_ppm_ref: hsqc_spectra[e.data.spectrum_index].x_ppm_ref,
                y_ppm_ref: hsqc_spectra[e.data.spectrum_index].y_ppm_ref,
            });
            add_to_list(e.data.spectrum_index);
            /**
             * For experimental spectra, we add the index to the end of main_plot.spectral_order array
             */
            if(e.data.spectrum_origin<0 || e.data.spectrum_origin >= 10000)
            {
                main_plot.spectral_order.push(e.data.spectrum_index);
            }
            /**
             * For reconstructed spectra, we first find location of the spectrum_origin in main_plot.spectral_order array
             * Then insert the index of the new spectrum after the location
             */
            else
            {
                let index = main_plot.spectral_order.indexOf(e.data.spectrum_origin);
                main_plot.spectral_order.splice(index+1,0,e.data.spectrum_index);
            }
            main_plot.redraw_contour();
        }
        else if(e.data.contour_sign === 1)
        {
            /**
             * Append data to main_plot
             */
            main_plot.levels_length_negative.push(e.data.levels_length);
            main_plot.polygon_length_negative.push(e.data.polygon_length);
            main_plot.colors_negative.push(hsqc_spectra[e.data.spectrum_index].spectrum_color_negative);

            if(total_number_of_experimental_spectra <= 4){
                main_plot.contour_lbs_negative.push(0);
            }
            else{
                let highest_level = hsqc_spectra[e.data.spectrum_index].negative_levels.length - 1;
                main_plot.contour_lbs_negative.push(highest_level);
            }

            /**
             * Keep track of the start of the points array (Float32Array)
             */
            main_plot.points_start_negative.push(main_plot.points.length);
            main_plot.points=Float32Concat(main_plot.points, new Float32Array(e.data.points));

            /**
             * IMPORTANT: We always calculate positive contour first, then negative contour.
             * So no need to update spectral_information array again
             */
            main_plot.redraw_contour();
        }
    }

    /**
     * Type is full and  hsqc_spectra.length === main_plot.levels_length.length
     * We are updating an existing overlay to the main plot
     * IMPORTANT: if might be a recalculated spectrum, so we need to update the spectral_information array
     * it can also be a recalculation of the contour of the same spectrum, which doesn't change the spectral_information array
     */
    else if (e.data.spectrum_type === "full" && e.data.spectrum_index < main_plot.levels_length.length)
    {
        let new_points = new Float32Array();

        /**
         * If contour_sign is 0, 
         * we keep the first main_plot.points[ main_plot.points_start[e.data.spectrum_index]]
         * we replace main_plot.points[ main_plot.points_start[e.data.spectrum_index]:main_plot.points_start_negative[e.data.spectrum_index]]
         * with new points data
         */
        if(e.data.contour_sign === 0)
        {
            new_points =main_plot.points.slice(0, main_plot.points_start[e.data.spectrum_index]);
            new_points = Float32Concat(new_points,new Float32Array(e.data.points));
            new_points = Float32Concat(new_points,main_plot.points.slice(main_plot.points_start_negative[e.data.spectrum_index]));
            /**
             * After calculate the length change, we update the points_start array from index+1 to the end and points_start_negative array from index to the end
             */
            let length_change = e.data.points.length - (main_plot.points_start_negative[e.data.spectrum_index] - main_plot.points_start[e.data.spectrum_index]);
            main_plot.points_start_negative[e.data.spectrum_index] += length_change;
            for(let i=e.data.spectrum_index+1;i<main_plot.points_start.length;i++)
            {
                main_plot.points_start[i] += length_change;
                main_plot.points_start_negative[i] += length_change;
            }
        }
        /**
         * if contour_sign is 1,
         * we keep the first main_plot.points[ main_plot.points_start_negative[e.data.spectrum_index]]
         * we replace main_plot.points[ main_plot.points_start_negative[e.data.spectrum_index]:main_plot.points_start[e.data.spectrum_index+1]]
         */
        else if(e.data.contour_sign === 1)
        {
            new_points = Float32Concat(new_points,main_plot.points.slice(0,main_plot.points_start_negative[e.data.spectrum_index]));
            new_points = Float32Concat(new_points,new Float32Array(e.data.points));
            if(e.data.spectrum_index+1<main_plot.points_start.length)
            {
                new_points = Float32Concat(new_points,main_plot.points.slice(main_plot.points_start[e.data.spectrum_index+1]));
            }
            /**
             * After calculate the length change, we update the points_start array from index+1 to the end and points_start_negative array from index to the end
             */
            let length_change = 0;
            if(e.data.spectrum_index+1<main_plot.points_start.length)
            {
                length_change = e.data.points.length - (main_plot.points_start[e.data.spectrum_index+1] - main_plot.points_start_negative[e.data.spectrum_index]);
            }
            else
            {
                length_change = e.data.points.length - (main_plot.points.length - main_plot.points_start_negative[e.data.spectrum_index]);
            }
            for(let i=e.data.spectrum_index+1;i<main_plot.points_start.length;i++)
            {
                main_plot.points_start[i] += length_change;
                main_plot.points_start_negative[i] += length_change;
            }
        }

        main_plot.points = new_points;
        
        /**
         * Step 2, update the levels_length array and polygon_length array
         */
        if(e.data.contour_sign === 0)
        {
            main_plot.levels_length[e.data.spectrum_index] = e.data.levels_length;
            main_plot.polygon_length[e.data.spectrum_index] = e.data.polygon_length;
        }
        else if(e.data.contour_sign === 1)
        {
            main_plot.levels_length_negative[e.data.spectrum_index] = e.data.levels_length;
            main_plot.polygon_length_negative[e.data.spectrum_index] = e.data.polygon_length;
        }

        /**
         * Reprocess may change the spectral information, so we update the spectral_information array
         * so that we can redraw the contour plot correctly
         */
        main_plot.spectral_information[e.data.spectrum_index]={
            n_direct: hsqc_spectra[e.data.spectrum_index].n_direct,
            n_indirect: hsqc_spectra[e.data.spectrum_index].n_indirect,
            x_ppm_start: hsqc_spectra[e.data.spectrum_index].x_ppm_start,
            x_ppm_step: hsqc_spectra[e.data.spectrum_index].x_ppm_step,
            y_ppm_start: hsqc_spectra[e.data.spectrum_index].y_ppm_start,
            y_ppm_step: hsqc_spectra[e.data.spectrum_index].y_ppm_step,
            x_ppm_ref: hsqc_spectra[e.data.spectrum_index].x_ppm_ref,
            y_ppm_ref: hsqc_spectra[e.data.spectrum_index].y_ppm_ref,
        };

        /**
         * Step 3, update the contour plot
         */
        main_plot.redraw_contour();
    }
    /**
    * Type is partial, we are updating the contour plot with a new level (at the beginning of the levels array)
    */
    else if (e.data.spectrum_type === "partial") {
        
        let index = e.data.spectrum_index;
        let new_points = new Float32Array();
        
        if (e.data.contour_sign === 0) {
            if (index > 0) {
                new_points = main_plot.points.slice(0, main_plot.points_start[index]);
            }
            /**
            * For positive contour, we then add the new points 
            * and then add the rest of the points from main_plot.points_start[index]
            */
            new_points = Float32Concat(new_points, new Float32Array(e.data.points));
            new_points = Float32Concat(new_points, main_plot.points.slice(main_plot.points_start[index]));
            let length_change = e.data.points.length;
            main_plot.points_start_negative[index] += length_change;
            for (let i = index + 1; i < main_plot.points_start.length; i++) {
                main_plot.points_start[i] += length_change;
                main_plot.points_start_negative[i] += length_change;
            }
        }
        else if (e.data.contour_sign === 1) {
            new_points = main_plot.points.slice(0, main_plot.points_start_negative[index]);
            /**
             * Copy main_plot.points upto main_plot.points_start_negative[0] to new_points
             */
            new_points = Float32Concat(new_points, new Float32Array(e.data.points));
            new_points = Float32Concat(new_points, main_plot.points.slice(main_plot.points_start_negative[index]));
            let length_change = e.data.points.length;
            for (let i = index+1; i < main_plot.points_start.length; i++) {
                main_plot.points_start[i] += length_change;
                main_plot.points_start_negative[i] += length_change;
            }
        }
        main_plot.points = new_points;
        
        
        if(e.data.contour_sign === 0)
        {
            /**
             * Step 2, concat the new polygon_length and current polygon_length 
             * Before that, add e.data.polygon_length[last_element] to each element of main_plot.polygon_length
             */
            let polygon_shift = e.data.polygon_length[e.data.polygon_length.length-1];
            for(let i=0;i<main_plot.polygon_length[index].length;i++)
            {
                main_plot.polygon_length[index][i] += polygon_shift;
            }
            main_plot.polygon_length[index] = e.data.polygon_length.concat(main_plot.polygon_length[index]);
    
            /**
             * Step 3, concat the new levels_length and current levels_length
             * Before that, add e.data.levels_length[last_element] to each element of mainplot.levels_length
             */
            let levels_shift = e.data.levels_length[e.data.levels_length.length-1];
            for(let i=0;i<main_plot.levels_length[index].length;i++)
            {
                main_plot.levels_length[index][i] += levels_shift;
            }
            main_plot.levels_length[index] = e.data.levels_length.concat(main_plot.levels_length[index]);
        }
        else
        {
            /**
             * Step 2, concat the new polygon_length and current polygon_length 
             * Before that, add e.data.polygon_length[last_element] to each element of main_plot.polygon_length
             */
            let polygon_shift = e.data.polygon_length[e.data.polygon_length.length-1];
            for(let i=0;i<main_plot.polygon_length_negative[index].length;i++)
            {
                main_plot.polygon_length_negative[index][i] += polygon_shift;
            }
            main_plot.polygon_length_negative[index] = e.data.polygon_length.concat(main_plot.polygon_length_negative[index]);
    
            /**
             * Step 3, concat the new levels_length and current levels_length
             * Before that, add e.data.levels_length[last_element] to each element of mainplot.levels_length
             */
            let levels_shift = e.data.levels_length[e.data.levels_length.length-1];
            for(let i=0;i<main_plot.levels_length_negative[index].length;i++)
            {
                main_plot.levels_length_negative[index][i] += levels_shift;
            }
            main_plot.levels_length_negative[index] = e.data.levels_length.concat(main_plot.levels_length_negative[index]);
        }
        main_plot.redraw_contour();
    }

    

    document.getElementById("contour_message").innerText = "";
};

/**
 * This function should be called only once when the first spectrum is loaded
 * to initialize the big plot
 * @param {obj} input an spectrum object. 
 */
function init_plot(input) {

    if (b_plot_initialized) {
        return;
    }
    b_plot_initialized = true;

    /**
     * main_plot need to know the size of the plot with ID visualization
     */
    let current_width = document.getElementById("visualization").style.width;
    let current_height = document.getElementById("visualization").style.height;

    /**
     * Remove px from the width and height
     */
    current_width = current_width.substring(0, current_width.length - 2);
    current_height = current_height.substring(0, current_height.length - 2);

    input.PointData = [];
    input.WIDTH = current_width;
    input.HEIGHT = current_height;
    input.MARGINS = { top: plot_margin_top, right: plot_margin_right, bottom: plot_margin_bottom, left: plot_margin_left };
    input.drawto = "#visualization";
    input.drawto_legend = "#legend";
    input.drawto_peak = "#peaklist";
    input.drawto_contour = "canvas1"; //webgl background as contour plot

    /**
     * Check whether checkbox Horizontal_cross_section and Vertical_cross_section are checked
     */
    input.horizontal = false;
    input.vertical = false;


    main_plot = new plotit(input);
    main_plot.draw();


    /**
     * INitialize the contour plot with empty data
     */
    main_plot.polygon_length = [];
    main_plot.polygon_length_negative = [];
    main_plot.levels_length = [];
    main_plot.levels_length_negative = [];
    main_plot.colors = [];
    main_plot.colors_negative = [];
    main_plot.contour_lbs = [];
    main_plot.contour_lbs_negative = [];
    main_plot.spectral_information = [];
    main_plot.spectral_order = [];
    main_plot.points_start = [];
    main_plot.points_start_negative = [];
    main_plot.points = new Float32Array();


    /**
     * Event listener for peak_color, peak_size and peak_thickness
     */
    document.getElementById("peak_color").addEventListener('change', function () {
        main_plot.peak_color = this.value;
        main_plot.redraw_peaks();
    });

    document.getElementById("peak_size").addEventListener('change', function () {
        main_plot.peak_size = parseInt(this.value);
        main_plot.redraw_peaks();
    });

    document.getElementById("peak_thickness").addEventListener('change', function () {
        main_plot.peak_thickness = parseInt(this.value);
        main_plot.redraw_peaks();
    });

    document.getElementById("peak_colormap").addEventListener('change', function (e) {
        main_plot.peak_color_flag = e.target.value;
        let index = e.target.selectedIndex;
        if(index>0) {main_plot.peak_color_flag_limit = color_map_limit[index-1];} //index 0 is solid, not in the list
        main_plot.redraw_peaks();
    });

};

function show_cross_section(index) {
    uncheck_all_1d_except(index);
    main_plot.current_spectral_index = index;
    main_plot.b_show_cross_section = true;
    main_plot.b_show_projection = false;
    /**
     * when showing cross section and image data of hsqc_spectra[index] is not null
     * and  current spectrum is from a ft2 file
     * Enable button_apply_ps button
     */
    if(hsqc_spectra[index].raw_data_ri.length > 0 && hsqc_spectra[index].raw_data_ir.length > 0 && hsqc_spectra[index].raw_data_ii.length > 0 && hsqc_spectra[index].spectrum_origin === -1)
    {
        document.getElementById("automatic_pc").disabled = false;
        document.getElementById("button_apply_ps").disabled = false;
    }
    else
    {
        document.getElementById("button_apply_ps").disabled = true;
        document.getElementById("automatic_pc").disabled = true;
    }

}

function show_projection(index) {
    uncheck_all_1d_except(index);
    main_plot.current_spectral_index = index;
    main_plot.b_show_cross_section = false;
    main_plot.b_show_projection = true;
    main_plot.show_projection();
    document.getElementById("button_apply_ps").disabled = true;
    document.getElementById("automatic_pc").disabled = true;
}

function uncheck_all_1d_except(index) {

    /**
     * It is possible hsqc_spectra.length > main_plot.levels_length.length
     * (main_plot.levels_length.length === total # of all "spectrum-".concat(i) HTML elements)
     */
    let total_number_of_spectra = hsqc_spectra.length;
    if(main_plot.levels_length.length < total_number_of_spectra)
    {
        total_number_of_spectra = main_plot.levels_length.length;
    }

    for(let i=0;i<total_number_of_spectra;i++)
    {   
        /**
         * Only if this is not the current spectrum and
         * this is NOT a reconstructed spectrum or removed spectrum
         * we uncheck the checkbox
         */
        if(i!==index && (hsqc_spectra[i].spectrum_origin ==-2 || hsqc_spectra[i].spectrum_origin ==-1 || hsqc_spectra[i].spectrum_origin >= 10000)) {
            document.getElementById("show_cross_section".concat("-").concat(i)).checked = false;
            document.getElementById("show_projection".concat("-").concat(i)).checked = false;
            document.getElementById("spectrum-".concat(i)).style.backgroundColor = "white";
        }
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

    for (let i = 0; i < hsqc_spectra.length; i++) {
        if (hsqc_spectra[i].x_ppm_start + hsqc_spectra[i].x_ppm_ref > x_ppm_start) {
            x_ppm_start = hsqc_spectra[i].x_ppm_start +  + hsqc_spectra[i].x_ppm_ref;
        }
        if (hsqc_spectra[i].x_ppm_start  + hsqc_spectra[i].x_ppm_ref + hsqc_spectra[i].x_ppm_step * hsqc_spectra[i].n_direct < x_ppm_end) {
            x_ppm_end = hsqc_spectra[i].x_ppm_start + hsqc_spectra[i].x_ppm_step * hsqc_spectra[i].n_direct  + hsqc_spectra[i].x_ppm_ref ;
        }
        if (hsqc_spectra[i].y_ppm_start  + hsqc_spectra[i].y_ppm_ref > y_ppm_start) {
            y_ppm_start = hsqc_spectra[i].y_ppm_start + hsqc_spectra[i].y_ppm_ref ;
        }
        if (hsqc_spectra[i].y_ppm_start + hsqc_spectra[i].y_ppm_step * hsqc_spectra[i].n_indirect + hsqc_spectra[i].y_ppm_ref < y_ppm_end) {
            y_ppm_end = hsqc_spectra[i].y_ppm_start + hsqc_spectra[i].y_ppm_step * hsqc_spectra[i].n_indirect+ hsqc_spectra[i].y_ppm_ref ;
        }
    }

    main_plot.resetzoom([x_ppm_start, x_ppm_end], [y_ppm_start, y_ppm_end]);
}

function popzoom() {
    main_plot.popzoom();
}

function zoomout() {
    main_plot.zoomout();
}

function toggle_contour() {
    main_plot.toggle_contour();
}

function toggle_peak() {
    main_plot.toggle_peak();
}

/**
 * Event listener for onblur event of ref1 and ref2 input fields
 */
function adjust_ref(index, flag) {
    
    if (flag === 0) {
        let new_ref = parseFloat(document.getElementById("ref1".concat("-").concat(index)).value);

        hsqc_spectra[index].update_x_ppm_ref(new_ref);
        /**
         * spectral_information is required to redraw the contour plot by myplot_webgl.js
         */
        main_plot.spectral_information[index].x_ppm_ref = new_ref;
    }
    else if (flag === 1) {
        let new_ref = parseFloat(document.getElementById("ref2".concat("-").concat(index)).value);
        
        hsqc_spectra[index].update_y_ppm_ref(new_ref);
        main_plot.spectral_information[index].y_ppm_ref = new_ref;
    }
    /**
     * Redraw the contour plot
     */
    main_plot.redraw_contour();
    /**
     * Update the cross section with the new reference
     */
    main_plot.update_cross_section(index,flag);
    /**
     * Redraw the peak list. Need to call draw_peaks() to update the peak list because the reference has changed
     */
    main_plot.draw_peaks();
}


/**
 * Event listener for button reduce_contour
 */
function reduce_contour(index,flag) {
    
    /**
    * Setup the spectrum_information object to be sent to the worker
    */
    let spectrum_information = {
        n_direct: hsqc_spectra[index].n_direct,
        n_indirect: hsqc_spectra[index].n_indirect,
        spectrum_type: "partial",
        spectrum_index: index,
        spectrum_origin: hsqc_spectra[index].spectrum_origin,
        contour_sign: flag
    };

    if(flag==0)
    {
        /**
         * Get current lowest level from input field contour0
         * and current scale from input field logarithmic_scale
         */
        let current_level = parseFloat(document.getElementById('contour0-'+index.toFixed(0)).value);
        let scale = parseFloat(document.getElementById('logarithmic_scale-'+index.toFixed(0)).value);

        /**
         * Reduce the level by scale
         */
        current_level /= scale;

        /**
         * Update the input field contour0
         */
        document.getElementById('contour0-'+index.toFixed(0)).value = current_level;

        /**
         * Update hsqc_spectrum.levels (add the new level to the beginning of the array)
         */
        hsqc_spectra[index].levels.unshift(current_level);

        spectrum_information.levels = [current_level];

        /**
         * Update slider.
         */
        document.getElementById("contour-slider-".concat(index)).max = hsqc_spectra[index].levels.length;
        document.getElementById("contour-slider-".concat(index)).value = 1;
        document.getElementById("contour_level-".concat(index)).innerText = hsqc_spectra[index].levels[0].toExponential(4);
    }
    else if(flag==1)
    {
        /**
         * Get current lowest level from input field contour0_negative
         *  and current scale from input field logarithmic_scale_negative
         */
        let current_level = parseFloat(document.getElementById('contour0_negative-'+index.toFixed(0)).value);
        let scale = parseFloat(document.getElementById('logarithmic_scale_negative-'+index.toFixed(0)).value);

        /**
         * Reduce the level by scale
         */
        current_level /= scale;

        /**
         * Update the input field contour0_negative
         */
        document.getElementById('contour0_negative-'+index.toFixed(0)).value = current_level;

        /**
         * Update hsqc_spectrum.levels (add the new level to the beginning of the array)
         */
        hsqc_spectra[index].negative_levels.unshift(current_level);

        spectrum_information.levels = [current_level];

        /**
         * Update slider.
         */
        document.getElementById("contour-slider_negative-".concat(index)).max = hsqc_spectra[index].negative_levels.length;
        document.getElementById("contour-slider_negative-".concat(index)).value = 1;
        document.getElementById("contour_level_negative-".concat(index)).innerText = hsqc_spectra[index].negative_levels[0].toExponential(4);
    }

    my_contour_worker.postMessage({ response_value: hsqc_spectra[index].raw_data, spectrum: spectrum_information });

}

/**
 * Called on button to update logarithmic scale contour
 */
function update_contour0_or_logarithmic_scale(index,flag) {

    let hsqc_spectrum = hsqc_spectra[index]; 

    let spectrum_information = {
        n_direct: hsqc_spectrum.n_direct,
        n_indirect: hsqc_spectrum.n_indirect,
        spectrum_type: "full",
        spectrum_index: index,
        spectrum_origin: hsqc_spectrum.spectrum_origin,
        contour_sign: flag,
    };

    if(flag==0)
    {
        let current_level = parseFloat(document.getElementById('contour0-'+index.toFixed(0)).value);
        let scale = parseFloat(document.getElementById('logarithmic_scale-'+index.toFixed(0)).value);

        /**
         * Recalculate the hsqc_spectrum.levels
         */
        hsqc_spectrum.levels[0] = current_level;
        for (let i = 1; i < 40; i++) {
            hsqc_spectrum.levels[i] = hsqc_spectrum.levels[i - 1] * scale;
            if (hsqc_spectrum.levels[i] > hsqc_spectrum.spectral_max) {
                hsqc_spectrum.levels = hsqc_spectrum.levels.slice(0, i+1);
                break;
            }
        }
        hsqc_spectra[index].positive_contour_type = "logarithmic";
        /**
         * Enable reduce_contour button
         */
        document.getElementById("reduce_contour-".concat(index)).disabled = false;

        spectrum_information.levels = hsqc_spectrum.levels;
        
        /**
         * Update slider.
         */
        document.getElementById("contour-slider-".concat(index)).max = hsqc_spectrum.levels.length;
        document.getElementById("contour-slider-".concat(index)).value = 1;
        document.getElementById("contour_level-".concat(index)).innerText = hsqc_spectrum.levels[0].toExponential(4);
    }
    else if(flag==1)
    {
        let current_level = parseFloat(document.getElementById('contour0_negative-'+index.toFixed(0)).value);
        let scale = parseFloat(document.getElementById('logarithmic_scale_negative-'+index.toFixed(0)).value);

        /**
         * Recalculate the hsqc_spectrum.levels
         */
        hsqc_spectrum.negative_levels[0] = current_level;
        for (let i = 1; i < 40; i++) {
            hsqc_spectrum.negative_levels[i] = hsqc_spectrum.negative_levels[i - 1] * scale;
            if (hsqc_spectrum.negative_levels[i] < hsqc_spectrum.spectral_min) {
                hsqc_spectrum.negative_levels = hsqc_spectrum.negative_levels.slice(0, i+1);
                break;
            }
        }
        hsqc_spectra[index].negative_contour_type = "logarithmic";
        /**
         * Enable reduce_contour button
         */
        document.getElementById("reduce_contour_negative-".concat(index)).disabled = false;

        /**
         * Update slider.
         */
        document.getElementById("contour-slider_negative-".concat(index)).max = hsqc_spectrum.negative_levels.length;
        document.getElementById("contour-slider_negative-".concat(index)).value = 1;
        document.getElementById("contour_level_negative-".concat(index)).innerText = hsqc_spectrum.negative_levels[0].toExponential(4);

        spectrum_information.levels = hsqc_spectrum.negative_levels;
    }


    my_contour_worker.postMessage({ response_value: hsqc_spectrum.raw_data, spectrum: spectrum_information });

}


/**
 * Called on button to update linear scale contour
 * @param {int} index index of the spectrum
 * @param {int} flag 0 for positive contour, 1 for negative contour
 */
function update_linear_scale(index,flag) {

    let hsqc_spectrum = hsqc_spectra[index];

    let spectrum_information = {
        n_direct: hsqc_spectrum.n_direct,
        n_indirect: hsqc_spectrum.n_indirect,
        spectrum_type: "full",
        spectrum_index: index,
        spectrum_origin: hsqc_spectrum.spectrum_origin,
        contour_sign: flag,
    };

    /**
     * Recalculate the hsqc_spectrum.levels
     * levels[0] = hsqc_spectrum.spectral_max/number_of_contours
     * levels[1] = 2*levels[0]
     * levels[2] = 3*levels[0]
     */
    if(flag==0)
    {
        let number_of_contours = parseInt(document.getElementById('number_of_contours-'.concat(index)).value);
        
        hsqc_spectrum.levels = [];
        hsqc_spectrum.levels.push(hsqc_spectrum.spectral_max/number_of_contours);
        for(let i=1;i<number_of_contours;i++)
        {
            hsqc_spectrum.levels.push((i+1)*hsqc_spectrum.levels[0]);
        }
        hsqc_spectra[index].positive_contour_type = "linear";
        /**
         * Disable reduce_contour button
         */
        document.getElementById("reduce_contour-".concat(index)).disabled = true;

        spectrum_information.levels = hsqc_spectrum.levels;

        /**
         * Update slider.
         */
        document.getElementById("contour-slider-".concat(index)).max = hsqc_spectrum.levels.length;
        document.getElementById("contour-slider-".concat(index)).value = 1;
        document.getElementById("contour_level-".concat(index)).innerText = hsqc_spectrum.levels[0].toExponential(4);
    }
    else if(flag==1){
        let number_of_contours = parseInt(document.getElementById('number_of_negative_contours-'.concat(index)).value);
        
        hsqc_spectrum.negative_levels = [];
        hsqc_spectrum.negative_levels.push(hsqc_spectrum.spectral_min/number_of_contours);
        for(let i=1;i<number_of_contours;i++)
        {
            hsqc_spectrum.negative_levels.push((i+1)*hsqc_spectrum.negative_levels[0]);
        }
        hsqc_spectra[index].negative_contour_type = "linear";
        /**
         * Disable reduce_contour button
         */
        document.getElementById("reduce_contour_negative-".concat(index)).disabled = true;

        spectrum_information.levels = hsqc_spectrum.negative_levels;

        /**
         * Update slider.
         */
        document.getElementById("contour-slider_negative-".concat(index)).max = hsqc_spectrum.negative_levels.length;
        document.getElementById("contour-slider_negative-".concat(index)).value = 1;
        document.getElementById("contour_level_negative-".concat(index)).innerText = hsqc_spectrum.negative_levels[0].toExponential(4);
    }

    my_contour_worker.postMessage({ response_value: hsqc_spectrum.raw_data, spectrum: spectrum_information });
};

/**
 * Event listener for slider contour-slider
 */
function update_contour_slider(e,index,flag) {

    /**
     * Get new level from the slider value
     */
    let level = parseInt(e.target.value);

    if(flag === 'positive')
    {
        /**
         * Update text of corresponding contour_level
         */
        document.getElementById("contour_level-".concat(index)).innerText = hsqc_spectra[index].levels[level - 1].toExponential(4);

        /**
         * Update the current lowest shown level in main_plot
         */
        main_plot.contour_lbs[index] = level - 1;

        /**
         * Update peaks only if current index is the same as current spectrum index of peaks
         * and current spectrum has picked peaks and is visible
         */
        if(current_spectrum_index_of_peaks === index )
        {
            let level = hsqc_spectra[index].levels[main_plot.contour_lbs[index]];
            main_plot.set_peak_level(level);
            main_plot.redraw_peaks();
        }

    }
    else if(flag === 'negative')
    {
        /**
         * Update text of corresponding contour_level
         */
        document.getElementById("contour_level_negative-".concat(index)).innerText = hsqc_spectra[index].levels[level - 1].toExponential(4);

        /**
         * Update the current lowest shown level in main_plot
         */
        main_plot.contour_lbs_negative[index] = level - 1;
    }

    main_plot.redraw_contour();

}


/**
 * Event listener for color picker contour_color
 */
function update_contour_color(e,index,flag) {

    let color = e.target.value;

    /**
     * Update the color of the spectrum
    */
    if(flag==0)
    {
        hsqc_spectra[index].spectrum_color = color;
        main_plot.colors[index] = hexToRgb(color);
    }
    else if(flag==1)
    {
        hsqc_spectra[index].spectrum_color_negative = color;
        main_plot.colors_negative[index] = hexToRgb(color);
    }
    
    /**
     * Update the color of the contour plot
     */
    
    main_plot.redraw_contour();
}




/**
 * Download spectrum
 *
 */
 function download_spectrum(index,flag) {

    let data;
    let filename;

    if(flag==='original')
    {
        filename = hsqc_spectra[index].filename;
        /**
         * generate a blob, which is hsqc_spectra[index].header + hsqc_spectra[index].raw_data
         * case 1: both are real
         */
        if(hsqc_spectra[index].datatype_direct === 1 && hsqc_spectra[index].datatype_indirect === 1)
        {
            data = Float32Concat(hsqc_spectra[index].header, hsqc_spectra[index].raw_data);
        }
        /**
         * One or two dimension(s) are complex
         */
        else
        {   
            let n_size = hsqc_spectra[index].n_direct * hsqc_spectra[index].n_indirect;
            if(hsqc_spectra[index].datatype_direct === 0 && hsqc_spectra[index].datatype_indirect === 0)
            {
                n_size *= 4;
            }
            else if(hsqc_spectra[index].datatype_direct === 0 || hsqc_spectra[index].datatype_indirect === 0)
            {
                n_size *= 2;
            }

            data = new Float32Array(512 + n_size);
            let current_position = 0;
            data.set(hsqc_spectra[index].header, current_position);
            current_position += 512;
            for(let i=0;i<hsqc_spectra[index].n_indirect;i++)
            {
                data.set(hsqc_spectra[index].raw_data.subarray(i*hsqc_spectra[index].n_direct,(i+1)*hsqc_spectra[index].n_direct), current_position);
                current_position += hsqc_spectra[index].n_direct;

                if(hsqc_spectra[index].datatype_direct === 0)
                {
                    data.set(hsqc_spectra[index].raw_data_ri.subarray(i*hsqc_spectra[index].n_direct,(i+1)*hsqc_spectra[index].n_direct), current_position);
                    current_position += hsqc_spectra[index].n_direct;
                }
                if(hsqc_spectra[index].datatype_indirect === 0)
                {
                    data.set(hsqc_spectra[index].raw_data_ir.subarray(i*hsqc_spectra[index].n_direct,(i+1)*hsqc_spectra[index].n_direct), current_position);
                    current_position += hsqc_spectra[index].n_direct;
                }
                if(hsqc_spectra[index].datatype_direct === 0 && hsqc_spectra[index].datatype_indirect === 0)
                {
                    data.set(hsqc_spectra[index].raw_data_ii.subarray(i*hsqc_spectra[index].n_direct,(i+1)*hsqc_spectra[index].n_direct), current_position);
                    current_position += hsqc_spectra[index].n_direct;
                }
            }
        }
    }
    else if(flag==='diff')
    {   
        /**
         * Replace recon with diff in the filename, if not found, add diff- to the filename at the beginning
         */
        filename = hsqc_spectra[index].filename.replace('recon','diff');
        if(filename === hsqc_spectra[index].filename)
        {
            filename = 'diff-'.concat(hsqc_spectra[index].filename);
        }

        /**
         * Get the original spectrum index
         */
        let spectrum_origin = hsqc_spectra[index].spectrum_origin;
        /**
         * Calcualte difference spectrum, which is hsqc_spectra[index].raw_data - hsqc_spectra[spectrum_origin].raw_data
         */
        let diff_data = new Float32Array(hsqc_spectra[index].raw_data.length);
        for(let i=0;i<hsqc_spectra[index].raw_data.length;i++)
        {
            diff_data[i] = hsqc_spectra[index].raw_data[i] - hsqc_spectra[spectrum_origin].raw_data[i];
        }
        /**
         * generate a blob, which is hsqc_spectra[index].header + diff_data
         * First, make a copy of the header and then concatenate with diff_data
         */
        let header = new Float32Array(hsqc_spectra[index].header);
        /**
         * Set datatype to 1, since the difference spectrum is always real
         */
        header[55] = 1.0;
        header[56] = 1.0;
        header[219] = hsqc_spectra[index].n_direct;
        data = Float32Concat(header, diff_data);
    }


    let blob = new Blob([data], { type: 'application/octet-stream' });
    let url = URL.createObjectURL(blob);
    let a = document.createElement('a');
    a.href = url;
    a.download = filename;
    a.click();
 }

/**
 * Add a new spectrum to the list and update the contour plot. When contour is updated, add_to_list() is called to update the list of spectra
 * in the uses interface
 * @param {*} result_spectra: an array of object of hsqc_spectrum
 * @param {*} b_from_fid: boolean, whether the spectrum is from a fid file
 * @param {*} b_reprocess: boolean, whether this is a new spectrum or a reprocessed spectrum
 * @param {*} pseudo3d_children: array of indices of pseudo 3D children's previous spectrum_index, only valid if b_reprocess is true and b_from_fid is true
 * @returns 
 */
function draw_spectrum(result_spectra, b_from_fid,b_reprocess,pseudo3d_children=[])
{

    let spectrum_index;

    if(b_from_fid ==false && b_reprocess === false)
    {
        /**
         * New spectrum from ft2, set its index (current length of the spectral array) and color
         */
        spectrum_index = hsqc_spectra.length;
        result_spectra[0].spectrum_index = spectrum_index;
        result_spectra[0].spectrum_color = color_list[(spectrum_index*2) % color_list.length];
        result_spectra[0].spectrum_color_negative = color_list[(spectrum_index*2+1) % color_list.length];
        hsqc_spectra.push(result_spectra[0]);
    }
    else if(b_from_fid === true && b_reprocess === false)
    {
        /**
         * New spectra from fid, set its index (current length of the spectral array) and color
         * It is possible that there are multiple spectra from a single fid file (pseudo 3D)
         */
        let first_spectrum_index = -1;
        for(let i=0;i<result_spectra.length;i++)
        {
            result_spectra[i].spectrum_index = hsqc_spectra.length;
            result_spectra[i].spectrum_color = color_list[(result_spectra[i].spectrum_index*2) % color_list.length];
            result_spectra[i].spectrum_color_negative = color_list[(result_spectra[i].spectrum_index*2+1) % color_list.length];

            /**
             * For spectrum from fid, we need to include all FID files and processing parameters in the result_spectra object
             */
            if(i==0)
            {
                result_spectra[i].fid_process_parameters = fid_process_parameters;
                first_spectrum_index = result_spectra[i].spectrum_index;
                result_spectra[i].spectrum_origin = -2; //from fid
            }
            else
            {
                result_spectra[i].spectrum_origin = 10000 + first_spectrum_index;
                hsqc_spectra[first_spectrum_index].pseudo3d_children.push(result_spectra[i].spectrum_index);
            }

            hsqc_spectra.push(result_spectra[i]);
        }
    }
    else if( b_reprocess === true)
    {
        /**
         * Reprocessed spectrum, get its index and update the spectrum. 
         * Also, update the fid_process_parameters
         */
        spectrum_index = result_spectra[0].spectrum_index;
        result_spectra[0].fid_process_parameters = fid_process_parameters;
        result_spectra[0].spectrum_color = color_list[(spectrum_index*2) % color_list.length];
        result_spectra[0].spectrum_color_negative = color_list[(spectrum_index*2+1) % color_list.length];
        hsqc_spectra[spectrum_index] = result_spectra[0];

        /**
         * If the spectrum is the current spectrum of the main plot, clear its cross section plot because it becomes invalid
         */
        if(main_plot.current_spectral_index === spectrum_index)
        {
            /**
             * clear main_plot.y_cross_section_plot and x_cross_section_plot
             */
            main_plot.y_cross_section_plot.clear();
            main_plot.x_cross_section_plot.clear();
        }

        /**
         * For pseudo-3D, there several cases:
         * 1. Reprocessed all spectra, and previously also processed all spectra,
         *    so pseudo3d_children.length === result_spectra.length-1
         */
        if(result_spectra.length -1 ==pseudo3d_children.length)
        {
            for(let i=1;i<result_spectra.length;i++)
            {
                let new_spectrum_index = pseudo3d_children[i-1];
                result_spectra[i].spectrum_index = new_spectrum_index;
                result_spectra[i].spectrum_origin = 10000 + spectrum_index;
                /**
                 * Copy previous colors
                 */
                result_spectra[i].spectrum_color = hsqc_spectra[new_spectrum_index].spectrum_color;
                result_spectra[i].spectrum_color_negative = hsqc_spectra[new_spectrum_index].spectrum_color_negative;
                hsqc_spectra[new_spectrum_index] = result_spectra[i];
            }
        }
        else if(pseudo3d_children.length === 0 && result_spectra.length > 1)
        {
            /**
             * Reprocessed all spectra, and previously only processed the first spectrum
             */
            for(let i=1;i<result_spectra.length;i++)
            {
                const new_spectrum_index = hsqc_spectra.length;
                result_spectra[i].spectrum_index = new_spectrum_index;
                result_spectra[i].spectrum_color = color_list[(new_spectrum_index*2) % color_list.length];
                result_spectra[i].spectrum_color_negative = color_list[(new_spectrum_index*2+1) % color_list.length];
                result_spectra[i].spectrum_origin = 10000 + spectrum_index;
                hsqc_spectra[spectrum_index].pseudo3d_children.push(new_spectrum_index);
                hsqc_spectra.push(result_spectra[i]);
            }
        }
        else 
        {
            /**
             * Do nothing. Error or unexpected case
             * Or reprocessed only first spectrum and previously processed all spectra or first spectrum
             */
        }

    }
    

    /**
     * initialize the plot with the first spectrum. This function only run once
     */
    init_plot(hsqc_spectra[0]);

    for(let i=0;i<result_spectra.length;i++)
    {
    
        /**
         * Positive contour calculation for the spectrum
         */
        let spectrum_information = {
            /**
             * n_direct,n_indirect, and levels are required for contour calculation
             */
            n_direct: result_spectra[i].n_direct,
            n_indirect: result_spectra[i].n_indirect,
            levels: result_spectra[i].levels,

            /**
             * These are flags to be send back to the main thread
             * so that the main thread know which part to update
             * @var spectrum_type: "full": all contour levels or "partial": new level added at the beginning
             * @var spectrum_index: index of the spectrum in the hsqc_spectra array
             * @var contour_sign: 0: positive contour, 1: negative contour
             */
            spectrum_type: "full",
            spectrum_index: result_spectra[i].spectrum_index,
            spectrum_origin: result_spectra[i].spectrum_origin,
            contour_sign: 0
        };
        my_contour_worker.postMessage({ response_value: result_spectra[i].raw_data, spectrum: spectrum_information });

        /**
         * Negative contour calculation for the spectrum
         */
        spectrum_information.contour_sign = 1;
        spectrum_information.levels = result_spectra[i].negative_levels;
        my_contour_worker.postMessage({ response_value: result_spectra[i].raw_data, spectrum: spectrum_information });
    }
}

/**
 * Calculate contour and draw them when loading previous sessions. 
 * Similar to draw_spectrum() but no need to update hsqc_spectra array (we loaded it)
 */
function draw_spectrum_from_loading()
{
    init_plot(hsqc_spectra[0]);

    for(let i=0;i<hsqc_spectra.length;i++)
    {
    
        /**
         * Positive contour calculation for the spectrum
         */
        let spectrum_information = {
            /**
             * n_direct,n_indirect, and levels are required for contour calculation
             */
            n_direct: hsqc_spectra[i].n_direct,
            n_indirect: hsqc_spectra[i].n_indirect,
            levels: hsqc_spectra[i].levels,

            /**
             * These are flags to be send back to the main thread
             * so that the main thread know which part to update
             * @var spectrum_type: "full": all contour levels or "partial": new level added at the beginning
             * @var spectrum_index: index of the spectrum in the hsqc_spectra array
             * @var contour_sign: 0: positive contour, 1: negative contour
             */
            spectrum_type: "full",
            spectrum_index: hsqc_spectra[i].spectrum_index,
            spectrum_origin: hsqc_spectra[i].spectrum_origin,
            contour_sign: 0
        };
        my_contour_worker.postMessage({ response_value: hsqc_spectra[i].raw_data, spectrum: spectrum_information });

        /**
         * Negative contour calculation for the spectrum
         */
        spectrum_information.contour_sign = 1;
        spectrum_information.levels = hsqc_spectra[i].negative_levels;
        my_contour_worker.postMessage({ response_value: hsqc_spectra[i].raw_data, spectrum: spectrum_information });
    }
}


/**
 * Concat two float32 arrays into one
 * @returns the concatenated array
 */
function Float32Concat(first, second)
{
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

async function download_plot()
{
    const format = 'png';

    const $svg = document.getElementById('visualization'); 

    /**
     * Generate an Image (from canvas1) 
     */
    var contour_image = new Image();
    contour_image.src = main_plot.contour_plot.drawScene(1);

    /**
     * Create a canvas element
     */

    const svgData = encodeAsUTF8(serializeAsXML($svg))

    const img = await loadImage(svgData);
    
    const $canvas = document.createElement('canvas')
    $canvas.width = $svg.clientWidth
    $canvas.height = $svg.clientHeight
    $canvas.getContext('2d').fillStyle = "white";
    $canvas.getContext('2d').fillRect(0, 0, $svg.clientWidth, $svg.clientHeight);
    $canvas.getContext('2d').drawImage(contour_image,90,20,$svg.clientWidth-110,$svg.clientHeight-90);
    $canvas.getContext('2d').drawImage(img, 0, 0, $svg.clientWidth, $svg.clientHeight)
    
    const dataURL = await $canvas.toDataURL(`image/${format}`, 1.0)
    
    const $img = document.createElement('img');
    $img.src = dataURL;

    /**
     * Download the image
     */
    const a = document.createElement('a');
    a.href = dataURL;
    a.download = 'nmr_plot.' + format;
    a.click();
}

/**
 * Load a peak list to a spectrum
 */
function load_peak_list(spectrum_index)
{
    /**
     * Get the file input element with ID "run_load_peak_list-"+spectrum_index
     */
    let file_input = document.getElementById("run_load_peak_list-"+spectrum_index);
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
        if(file.name.endsWith(".tab") || file.name.endsWith(".list"))
        {
            if(file.name.endsWith(".tab"))
            {
                peak_list.process_peaks_tab(e.target.result);
            }
            else {
                peak_list.process_peaks_list(e.target.result);
            }
            hsqc_spectra[spectrum_index].picked_peaks_object = peak_list;
            
            /**
             * when picked peaks are received, fitted peaks need to be reset
             */
            hsqc_spectra[spectrum_index].fitted_peaks_object = null;
            /**
             * Disable the download fitted peaks button. Uncheck the show fitted peaks checkbox, disable it too
             */
            document.getElementById("download_fitted_peaks-".concat(spectrum_index)).disabled = true;
            document.getElementById("show_fitted_peaks-".concat(spectrum_index)).checked = false;
            document.getElementById("show_fitted_peaks-".concat(spectrum_index)).disabled = true;
            /**
             * When peaks are loaded, set default scale and scale2 for peak fitting
             */
            hsqc_spectra[spectrum_index].scale = 5.5;
            hsqc_spectra[spectrum_index].scale2 = 3.5;

            /**
             * Enable the download peaks button
             */
            document.getElementById("download_peaks-".concat(spectrum_index)).disabled = false;
            /**
             * Enable peak picking (we disabled it when starting deep picker) and peak fitting buttons
             */
            document.getElementById("run_deep_picker-".concat(spectrum_index)).disabled = false;
            document.getElementById("run_voigt_fitter-".concat(spectrum_index)).disabled = false;
            /**
             * Enable, set it as unchecked then simulate a click event to show the peaks
             */
            document.getElementById("show_peaks-".concat(spectrum_index)).disabled = false;
            document.getElementById("show_peaks-".concat(spectrum_index)).checked = false;
            document.getElementById("show_peaks-".concat(spectrum_index)).click();
        }
        else{
            console.log("Unsupported peak file format");
        }
    };
    reader.readAsText(file);
}


/**
 * Call DEEP Picker to run peaks picking the spectrum
 * @param {int} spectrum_index: index of the spectrum in hsqc_spectra array
 */
function run_DEEP_Picker(spectrum_index,flag)
{
    /**
     * Disable the buttons to run deep picker and voigt fitter
     */
    document.getElementById("run_deep_picker-".concat(spectrum_index)).disabled = true;
    document.getElementById("run_voigt_fitter-".concat(spectrum_index)).disabled = true;


    /**
     * Combine hsqc_spectra[0].raw_data and hsqc_spectra[0].header into one Float32Array
     * Need to copy the header first, modify complex flag (doesn't hurt even when not necessary), then concatenate with raw_data
     */
    let header = new Float32Array(hsqc_spectra[spectrum_index].header);
    header[55] = 1.0;
    header[56] = 1.0;
    header[219] = hsqc_spectra[spectrum_index].n_indirect; //size of indirect dimension of the input spectrum
    let data = Float32Concat(header, hsqc_spectra[spectrum_index].raw_data);
    /**
     * Convert to Uint8Array to be transferred to the worker
     */
    let data_uint8 = new Uint8Array(data.buffer);

    /**
     * Get noise_level of the spectrum
     * And current lowest contour level of the spectrum
     * Calculate scale as lowest contour level / noise_level
     * and scale2 as 0.6 * scale
     */
    let noise_level = hsqc_spectra[spectrum_index].noise_level;
    let level = hsqc_spectra[spectrum_index].levels[main_plot.contour_lbs[spectrum_index]];
    let scale = level / noise_level;
    let scale2 = 0.6 * scale;

    /**
     * Add title to textarea "log"
     */
    webassembly_worker.postMessage({
        webassembly_job: "peak_picker",
        spectrum_data: data_uint8,
        spectrum_index: spectrum_index,
        scale: scale,
        scale2: scale2,
        noise_level: noise_level,
        flag: flag //0: DEEP Picker, 1: Simple Picker
    });
    /**
 * Let user know the processing is started
 */
    document.getElementById("webassembly_message").innerText = "Run DEEP Picker, please wait...";

}

/**
 * Call Voigt fitter to run peak fitting on the spectrum
 * @param {int} spectrum_index: index of the spectrum in hsqc_spectra array
 */
function run_Voigt_fitter(spectrum_index,flag)
{
    /**
     * Disable the buttons to run deep picker and voigt fitter
     */
    document.getElementById("run_deep_picker-".concat(spectrum_index)).disabled = true;
    document.getElementById("run_voigt_fitter-".concat(spectrum_index)).disabled = true;

    /**
     * Get maxround input field with ID "maxround-"+spectrum_index
     */
    let maxround = parseInt(document.getElementById("maxround-"+spectrum_index).value);

    /**
     * Get number input field with ID "combine_peak_cutoff-"+spectrum_index
     */
    let combine_peak_cutoff = parseFloat(document.getElementById("combine_peak_cutoff-"+spectrum_index).value);

    /**
     * Get subset of the picked peaks (within visible region)
     * start < end from the get_visible_region function call
     */
    [x_ppm_visible_start, x_ppm_visible_end, y_ppm_visible_start, y_ppm_visible_end] = main_plot.get_visible_region();

    /**
     * Get a copy of the picked peaks, so that we can filter it
     */
    let picked_peaks_copy = new cpeaks();
    picked_peaks_copy.copy_data(hsqc_spectra[spectrum_index].picked_peaks_object);
    picked_peaks_copy.filter_by_column_range("X_PPM", x_ppm_visible_start, x_ppm_visible_end);
    picked_peaks_copy.filter_by_column_range("Y_PPM", y_ppm_visible_start, y_ppm_visible_end);

    let picked_peaks_copy_tab = picked_peaks_copy.save_peaks_tab();


    /**
     * Combine hsqc_spectra[spectrum_index].raw_data and hsqc_spectra[spectrum_index].header into one Float32Array
     * Need to copy the header first, modify complex flag (doesn't hurt even when not necessary), then concatenate with raw_data
     */
    let header = new Float32Array(hsqc_spectra[spectrum_index].header);
    header[55] = 1.0;
    header[56] = 1.0;
    header[219] = hsqc_spectra[spectrum_index].n_indirect; //size of indirect dimension of the input spectrum
    /**
     * Also set 
     */
    let data = Float32Concat(header, hsqc_spectra[spectrum_index].raw_data);
    /**
     * Convert to Uint8Array to be transferred to the worker
     */
    let data_uint8 = new Uint8Array(data.buffer);

    webassembly_worker.postMessage({
        webassembly_job: "peak_fitter",
        spectrum_data: data_uint8,
        picked_peaks: picked_peaks_copy_tab,
        spectrum_index: spectrum_index,
        combine_peak_cutoff: combine_peak_cutoff,
        maxround: maxround,
        flag: flag, //0: Voigt, 1: Gaussian, 2: Voigt_Lorentzian
        scale: hsqc_spectra[spectrum_index].scale,
        scale2: hsqc_spectra[spectrum_index].scale2,
        noise_level: hsqc_spectra[spectrum_index].noise_level
    });
    /**
     * Let user know the processing is started
     */
    document.getElementById("webassembly_message").innerText = "Run Peak fitting, please wait...";

}

/**
 * Show or hide peaks on the plot
 */
function show_hide_peaks(index,flag,b_show)
{
    /**
     * Disable main_plot.allow_brush_to_remove and checkbox:
     * allow_brush_to_remove
     * allow_drag_and_drop
     * allow_click_to_add_peak
     */
    main_plot.allow_brush_to_remove = false;
    document.getElementById("allow_brush_to_remove").checked = false;
    document.getElementById("allow_brush_to_remove").disabled = true;
    document.getElementById("allow_drag_and_drop").checked = false;
    document.getElementById("allow_drag_and_drop").disabled = true;
    document.getElementById("allow_click_to_add_peak").checked = false;
    document.getElementById("allow_click_to_add_peak").disabled = true;
    
    /**
     * Turn off checkbox of all other spectra
     */
    for(let i=0;i<hsqc_spectra.length;i++)
    {
        if(i!==index)
        {
            /**
             * If spectrum is deleted, these checkboxes are no longer available.
             * So we need to check if they are available
             */
            if(hsqc_spectra[i].spectrum_origin !== -3)
            {
                document.getElementById("show_peaks-"+i).checked = false;
                document.getElementById("show_fitted_peaks-"+i).checked = false;
            }
        }
        /**
         * uncheck the checkbox of the current spectrum
         */
        else
        {
            if(flag === 'picked')
            {
                document.getElementById("show_fitted_peaks-"+i).checked = false;
            }
            else if(flag === 'fitted')
            {
                document.getElementById("show_peaks-"+i).checked = false;
            }
        }
    }

    /**
     * If index is not -2, we need to uncheck the checkbox of pseudo 3D peaks
     */
    if(index!==-2)
    {
        document.getElementById("show_pseudo3d_peaks").checked = false;
    }


    if(index==-2 && b_show)
    {
        current_spectrum_index_of_peaks = index;
        current_flag_of_peaks = 'fitted';
        /**
         * flag is always 'fitted' for pseudo 3D peaks.
         * First define a dummy hsqc_spectrum object. When flag is fitted, main_plot will only use fitted_peaks of the spectrum
         */
        let pseudo3d_spectrum = new spectrum();
        pseudo3d_spectrum.fitted_peaks_object = pseudo3d_fitted_peaks_object;

        /**
         * If we have DOSY in column_headers, add it to peak_properties.
         */
        if(pseudo3d_fitted_peaks_object.column_headers.indexOf('DOSY')!==-1)
        {

            main_plot.add_peaks(pseudo3d_spectrum,'fitted',['X_PPM','Y_PPM','HEIGHT','INDEX','ASS','DOSY'],'SOLID');
            /**
             * Insert ASS and DOSY into HTML select with ID labels
             */
            update_label_select(['DOSY','HEIGHT']);
            
            color_map_list = ['HEIGHT','DOSY'];
            color_map_limit =[get_peak_limit(pseudo3d_fitted_peaks_object,'HEIGHT'),get_peak_limit(pseudo3d_fitted_peaks_object,'DOSY')];
            update_colormap_select();

        }
        else
        {
            main_plot.add_peaks(pseudo3d_spectrum,'fitted',['X_PPM','Y_PPM','HEIGHT','INDEX','ASS'],'SOLID');    
            update_label_select(['HEIGHT']);
            color_map_list = ['HEIGHT'];
            color_map_limit =[get_peak_limit(pseudo3d_fitted_peaks_object,'HEIGHT')];
            update_colormap_select();
        }
    }

    else if(b_show)
    {
        current_spectrum_index_of_peaks = index;
        current_flag_of_peaks = flag;

        /**
         * Get current lowest contour level of the spectrum
         */
        let level = hsqc_spectra[index].levels[main_plot.contour_lbs[index]];
        main_plot.set_peak_level(level);

        if(flag === 'picked')
        {
            /**
             * Only for picked peaks of an experimental spectrum, allow user to make changes
             */
            if(hsqc_spectra[index].spectrum_origin === -1 || hsqc_spectra[index].spectrum_origin === -2 || hsqc_spectra[index].spectrum_origin >=10000)
            {
                document.getElementById("allow_brush_to_remove").disabled = false;
                document.getElementById("allow_drag_and_drop").disabled = false;
                document.getElementById("allow_click_to_add_peak").disabled = false;
            }
        }
        main_plot.add_peaks(hsqc_spectra[index],flag,['X_PPM','Y_PPM','HEIGHT','INDEX','ASS'],'SOLID');
        update_label_select(['INDEX','HEIGHT']);
        color_map_list = ['HEIGHT'];
        color_map_limit =[get_peak_limit( hsqc_spectra[index].picked_peaks_object,'HEIGHT')];
        update_colormap_select();
    }
    else
    {
        current_spectrum_index_of_peaks = -1; // -1 means no spectrum is selected. flag is not important
        main_plot.remove_picked_peaks();
        color_map_list=[];
        color_map_limit=[];
        update_colormap_select();
    }
    /**
     * There is no need to redraw the contour plot
     */
}

/**
 * User clicked button to run dosy fitting
 */
function run_dosy()
{
    /**
     * Convert space(s) delimited string (From dosy_gradient) to array of floats
     */
    let dosy_gradient_text = document.getElementById("dosy_gradient").value;
    let dosy_rescale = parseFloat(document.getElementById("dosy_rescale").value);
    let gradients = dosy_gradient_text.split(/\s+/).map(Number).filter(function (value) { return !isNaN(value); });
    pseudo3d_fitted_peaks_object.run_dosy_fitting(gradients,dosy_rescale);   
}

/**
 * Download pseudo 3D peak fitting result
 */
function download_pseudo3d()
{
    let  pseudo3d_fitted_peaks_tab = pseudo3d_fitted_peaks_object.save_peaks_tab();   
    let blob = new Blob([pseudo3d_fitted_peaks_tab], { type: 'text/plain' });

    let url = URL.createObjectURL(blob);
    let a = document.createElement('a');
    a.href = url;
    a.download = "pseudo3d.tab";
    a.click();
}


/**
 * Generate a list of peaks in nmrPipe .tab format
 */
function download_peaks(spectrum_index,flag)
{
    let file_buffer;

    if(flag === 'picked')
    {
        file_buffer = hsqc_spectra[spectrum_index].picked_peaks_object.save_peaks_tab();
    }
    else if(flag === 'fitted')
    {
        file_buffer = hsqc_spectra[spectrum_index].fitted_peaks_object.save_peaks_tab();
    }

    let blob = new Blob([file_buffer], { type: 'text/plain' });
    let url = URL.createObjectURL(blob);
    let a = document.createElement('a');
    a.href = url;
    a.download = hsqc_spectra[spectrum_index].filename + ".tab";
    a.click();

    /**
     * Remove the url and a
     */
    URL.revokeObjectURL(url);
    a.remove();
}

/**
 * Remove a reconstructed spectrum from the list and data.
 * This function will send a message to the contour worker,
 * The contour worker will send it back to the main thread 
 * then the main thread will call remove_spectrum(index) to remove the spectrum
 * This is to make sure that the contour plot is updated correctly (single thread for the contour plot)
 */
function remove_spectrum_caller(index)
{
    /**
     * Send a message to the contour worker to remove the spectrum
     */
    my_contour_worker.postMessage({ remove_spectrum: index });
}

/**
 * 
 * ACtually remove a reconstructed spectrum from the list and data
 */
function remove_spectrum(index)
{
    /**
     * Remove all children of the <li> element with id "spectrum-index"
     * but keep the <li> element, because main_plot.spectrum_order can't reduce the length
     * Also set it hidden
     */
    document.getElementById("spectrum-".concat(index)).innerHTML = "";
    document.getElementById("spectrum-".concat(index)).style.display = "none";

    /**
     * Because we make extensive use of spectrum index and we don't want to change the index of the spectrum
     * So we remove its data (array member only), but keep the object in the array
     */
    hsqc_spectra[index].raw_data = new Float32Array();
    hsqc_spectra[index].header = new Float32Array();
    hsqc_spectra[index].levels = [];
    hsqc_spectra[index].negative_levels = [];
    hsqc_spectra[index].spectrum_origin = -3; // -3 means the spectrum is removed
    hsqc_spectra[index].picked_peaks_object = null;
    hsqc_spectra[index].fitted_peaks_object = null;

    /**
     * Remove its contour data from main_plot and redraw the contour plot
     */
    main_plot.levels_length[index] = [];
    main_plot.polygon_length[index] = [];
    main_plot.levels_length_negative[index] = [];
    main_plot.polygon_length_negative[index] = [];
    /**
     * Now remove main_plot.points (type is Float32Array)
     * from the  main_plot.points_start[index] main_plot.points_start[index+1]
     * (This means we also removed the negative contour points)
     */
    if(index === hsqc_spectra.length - 1) //last spectrum
    {
        main_plot.points = main_plot.points.slice(0, main_plot.points_start[index]);
    }
    else
    {
        const n_removed = main_plot.points_start[index + 1] - main_plot.points_start[index];
        main_plot.points = Float32Concat( main_plot.points.slice(0, main_plot.points_start[index]), main_plot.points.slice(main_plot.points_start[index + 1]));
        /**
         * We need to update main_plot.points_start and main_plot.points_start_negative from index+1
         */
        for (let i = index + 1; i < main_plot.points_start.length; i++) {
            main_plot.points_start[i] -= n_removed;
            main_plot.points_start_negative[i] -= n_removed;
        }
    }
    main_plot.points_start_negative[index]=main_plot.points_start[index];

    main_plot.redraw_contour();
}


/**
 * When flag ==0, apply manual phase correction
 * Get current manual phase correction values from main_plot
 * apply it to current spectrum.
 * If it is form fid, update the fid_process_parameters as well
 * 
 * When flag ==1, run automatic phase correction
 * @returns 
 */
function apply_current_pc_or_auto_pc(flag)
{
    let current_ps = [[0.0, 0.0], [0.0, 0.0]]; //all 0.0 means auto phase correction
    if(flag==0)
    {
        /**
         * Get the current PS from main_plot. array of 2 elements [p0,p1] in radian
         */
        current_ps = main_plot.get_phase_correction();
        /**
         * Convert to degree from radian
         */
        current_ps[0][0] *= 180.0 / Math.PI;
        current_ps[0][1] *= 180.0 / Math.PI;
        current_ps[1][0] *= 180.0 / Math.PI;
        current_ps[1][1] *= 180.0 / Math.PI;

        /**
         * If all are zero, do nothing
         */
        if(current_ps[0][0] === 0.0 && current_ps[0][1] === 0.0 && current_ps[1][0] === 0.0 && current_ps[1][1] === 0.0)
        {
            console.log('All phase correction are zero, do nothing');
            return;
        }


        /**
         * If main_plot.current_spectrum_index == current_reprocess_spectrum_index, we have fid data for the spectrum,
         * we need to update the phase correction for the fid data processing as well
         */
        if(main_plot.current_spectral_index === current_reprocess_spectrum_index)
        {
            let v;
            v=parseFloat(document.getElementById("phase_correction_direct_p0").value) + current_ps[0][0];
            document.getElementById("phase_correction_direct_p0").value = v.toFixed(1);
            hsqc_spectra[current_reprocess_spectrum_index].fid_process_parameters.phase_correction_direct_p0 = v;

            v=parseFloat(document.getElementById("phase_correction_direct_p1").value) + current_ps[0][1];
            document.getElementById("phase_correction_direct_p1").value = v.toFixed(1);
            hsqc_spectra[current_reprocess_spectrum_index].fid_process_parameters.phase_correction_direct_p1 = v;

            v=parseFloat(document.getElementById("phase_correction_indirect_p0").value) + current_ps[1][0];
            document.getElementById("phase_correction_indirect_p0").value = v.toFixed(1);
            hsqc_spectra[current_reprocess_spectrum_index].fid_process_parameters.phase_correction_indirect_p0 = v;

            v=parseFloat(document.getElementById("phase_correction_indirect_p1").value) + current_ps[1][1];
            document.getElementById("phase_correction_indirect_p1").value = v.toFixed(1);
            hsqc_spectra[current_reprocess_spectrum_index].fid_process_parameters.phase_correction_indirect_p1 = v;
            /**
             * To be safe, uncheck auto phase correction
             */
            document.getElementById("auto_direct").checked = false;
            document.getElementById("auto_indirect").checked = false;
            hsqc_spectra[current_reprocess_spectrum_index].fid_process_parameters.auto_direct = false;
            hsqc_spectra[current_reprocess_spectrum_index].fid_process_parameters.auto_indirect = false;
        }

        /**
         * Update span pc_info
         */
        document.getElementById("pc_info").innerText = "Phase correction: " + current_ps[0][0].toFixed(1) + " " + current_ps[0][1].toFixed(1) + " " + current_ps[1][0].toFixed(1) + " " + current_ps[1][1].toFixed(1);
    }


    /**
     * Run webass worker to apply phase correction.
     * First, pass the spectrum as a file. 
     */
    let index  = main_plot.current_spectral_index;
    let n_size = hsqc_spectra[index].n_direct * hsqc_spectra[index].n_indirect * 4;
    let data = new Float32Array(512 + n_size);
    let current_position = 0;
    data.set(hsqc_spectra[index].header, current_position);
    current_position += 512;
    for (let i = 0; i < hsqc_spectra[index].n_indirect; i++) {
        data.set(hsqc_spectra[index].raw_data.subarray(i * hsqc_spectra[index].n_direct, (i + 1) * hsqc_spectra[index].n_direct), current_position);
        current_position += hsqc_spectra[index].n_direct;

        if (hsqc_spectra[index].datatype_direct === 0) {
            data.set(hsqc_spectra[index].raw_data_ri.subarray(i * hsqc_spectra[index].n_direct, (i + 1) * hsqc_spectra[index].n_direct), current_position);
            current_position += hsqc_spectra[index].n_direct;
        }
        if (hsqc_spectra[index].datatype_indirect === 0) {
            data.set(hsqc_spectra[index].raw_data_ir.subarray(i * hsqc_spectra[index].n_direct, (i + 1) * hsqc_spectra[index].n_direct), current_position);
            current_position += hsqc_spectra[index].n_direct;
        }
        if (hsqc_spectra[index].datatype_direct === 0 && hsqc_spectra[index].datatype_indirect === 0) {
            data.set(hsqc_spectra[index].raw_data_ii.subarray(i * hsqc_spectra[index].n_direct, (i + 1) * hsqc_spectra[index].n_direct), current_position);
            current_position += hsqc_spectra[index].n_direct;
        }
    }
    /**
     * Convert to Uint8Array to be transferred to the worker
     */
    let data_uint8 = new Uint8Array(data.buffer);
    webassembly_worker.postMessage({
        webassembly_job: "apply_phase_correction",
        spectrum_data: data_uint8,
        phase_correction: current_ps, //all 0.0 means auto phase correction
        spectrum_index: main_plot.current_spectral_index,
        spectrum_name: hsqc_spectra[main_plot.current_spectral_index].filename,
    });
    /**
     * Let user know the processing is started
     */
    document.getElementById("webassembly_message").innerText = "Apply phase correction, please wait...";
}

/**
 * Clear the textarea log
 */
function clear_log()
{
    document.getElementById("log").value = "";
}

/**
 * Save the current textarea log to a file
 */
function download_log()
{
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


function median(values) 
{
    if (values.length === 0) {
      throw new Error('Input array is empty');
    }
  
    // Sorting values, preventing original array
    // from being mutated.
    values = [...values].sort((a, b) => a - b);
  
    const half = Math.floor(values.length / 2);
  
    return (values.length % 2
      ? values[half]
      : (values[half - 1] + values[half]) / 2
    );
  
}

/**
 * Estimate noise level of a spectrum.
 * Calculate RMSD of each 32*32 segment, and get the median value
 * @param {*} xdim: x dimension of the spectrum
 * @param {*} ydim: y dimension of the spectrum
 * @param {Float32Array} spect: the spectrum data, row major. y*xdim + x to access the element at (x,y)
 * @returns 
 */
function estimate_noise_level(xdim,ydim,spect)
{
    let n_segment_x = Math.floor(xdim / 32);
let n_segment_y = Math.floor(ydim / 32);

let variances = [];      // variance of each segment
let maximal_values = []; // maximal value of each segment

    /**
     * loop through each segment, and calculate variance
     */
    for (let i = 0; i < n_segment_x; i++) {
        for (let j = 0; j < n_segment_y; j++) {
            let t = [];
            for (let m = 0; m < 32; m++) {
                for (let n = 0; n < 32; n++) {
                    t.push(spect[(j * 32 + m) * xdim + i * 32 + n]);
                }
            }

            /**
             * calculate variance of this segment. Subtract the mean value of this segment first
             * also calculate the max value of this segment
             */
            let max_of_t = 0.0;
            let mean_of_t = 0.0;
            for (let k = 0; k < t.length; k++) {
                mean_of_t += t[k];
                if (Math.abs(t[k]) > max_of_t) {
                    max_of_t = Math.abs(t[k]);
                }
            }
            mean_of_t /= t.length;

            let variance_of_t = 0.0;
            for (let k = 0; k < t.length; k++) {
                variance_of_t += (t[k] - mean_of_t) * (t[k] - mean_of_t);
            }
            variance_of_t /= t.length;
            variances.push(variance_of_t);
            maximal_values.push(max_of_t);
        }
    }

    /**
     * Sort the variances and get the median value
     */
    let variances_sorted = [...variances]; // Copy of variances array
    variances_sorted.sort((a, b) => a - b); // Sort in ascending order
    let noise_level = Math.sqrt(variances_sorted[Math.floor(variances_sorted.length / 2)]);
    console.log("Noise level is " + noise_level + " using variance estimation.");

    /**
     * Loop through maximal_values and remove the ones that are larger than 10.0 * noise_level
     * Also remove the corresponding variance as well
     */
    for (let i = maximal_values.length - 1; i >= 0; i--) {
        if (maximal_values[i] > 10.0 * noise_level) {
            maximal_values.splice(i, 1);  // Remove the element at index i
            variances.splice(i, 1);       // Remove corresponding variance
        }
    }

    /**
     * Sort the variances again and get the new median value
     */
    variances_sorted = [...variances];  // Copy the updated variances array
    variances_sorted.sort((a, b) => a - b);  // Sort in ascending order
    noise_level = Math.sqrt(variances_sorted[Math.floor(variances_sorted.length / 2)]);

    console.log("Final noise level is estimated to be " + noise_level);

    return noise_level;

}

function update_label_select(labels)        
{
    /**
     * Remove all except 1st 
     */
    let selectElement=document.getElementById('labels');
    let i = selectElement.options.length-1;
    while (i>0) {
        selectElement.remove(i);
        i--;
    }

    for(let i=0;i<labels.length;i++)
    {
        const option = document.createElement("option");
        option.value = labels[i];
        option.text = labels[i];
        selectElement.add(option);
    }
}

function update_colormap_select()
{
    /**
     * Remove all except 1st (which is Solid: means solid color, not colormap
     */
    let selectElement=document.getElementById('peak_colormap');
    let i = selectElement.options.length-1;
    while (i>0) {
        selectElement.remove(i);
        i--;
    }
    for(let i=0;i<color_map_list.length;i++)
    {
        const option = document.createElement("option");
        option.value = color_map_list[i];
        option.text = color_map_list[i];
        selectElement.add(option);
    }
}

function get_peak_limit(peak_object,header)
{
    let values = peak_object.get_column_by_header(header);
    let min = values[0];
    let max = values[0];
  
    for (let i = 1; i < values.length; i++) {
      if (values[i] < min) {
        min = values[i];
      }
      if (values[i] > max) {
        max = values[i];
      }
    }
    return [min,max];
}

/**
 * User click on the button to reprocess the spectrum
 */
function reprocess_spectrum(self,spectrum_index)
{
    function set_fid_parameters(fid_process_parameters)
    {
        document.getElementById("water_suppression").checked = fid_process_parameters.water_suppression;
        document.getElementById("polynomial").value = fid_process_parameters.polynomial;
        document.getElementById("hsqc_acquisition_seq").value = fid_process_parameters.acquisition_seq;
        document.getElementById("apodization_direct").value = fid_process_parameters.apodization_direct;
        document.getElementById("zf_direct").value = fid_process_parameters.zf_direct;
        document.getElementById("phase_correction_direct_p0").value = fid_process_parameters.phase_correction_direct_p0;
        document.getElementById("phase_correction_direct_p1").value = fid_process_parameters.phase_correction_direct_p1;
        document.getElementById("auto_direct").checked = fid_process_parameters.auto_direct;
        document.getElementById("delete_imaginary").checked = fid_process_parameters.delete_direct;
        document.getElementById("extract_direct_from").value = fid_process_parameters.extract_direct_from * 100;
        document.getElementById("extract_direct_to").value = fid_process_parameters.extract_direct_to * 100;
        document.getElementById("apodization_indirect").value = fid_process_parameters.apodization_indirect;
        document.getElementById("zf_indirect").value = fid_process_parameters.zf_indirect;
        document.getElementById("phase_correction_indirect_p0").value = fid_process_parameters.phase_correction_indirect_p0;
        document.getElementById("phase_correction_indirect_p1").value = fid_process_parameters.phase_correction_indirect_p1;
        document.getElementById("auto_indirect").checked = fid_process_parameters.auto_indirect;
        document.getElementById("delete_imaginary_indirect").checked = fid_process_parameters.delete_indirect;
        document.getElementById("neg_imaginary").checked = fid_process_parameters.neg_imaginary === "yes" ? true : false;
    }

    function set_default_fid_parameters()
    {
        document.getElementById("water_suppression").checked = false;
        document.getElementById("polynomial").value =-1;
        document.getElementById("hsqc_acquisition_seq").value = "321"
        document.getElementById("apodization_direct").value = "SP off 0.5 end 0.98 pow 2 elb 0 c 0.5";
        document.getElementById("zf_direct").value = "2";
        document.getElementById("phase_correction_direct_p0").value = 0;
        document.getElementById("phase_correction_direct_p1").value = 0;
        document.getElementById("auto_direct").checked = true;
        document.getElementById("delete_imaginary").checked = false
        document.getElementById("extract_direct_from").value = 0;   
        document.getElementById("extract_direct_to").value =    100;
        document.getElementById("apodization_indirect").value = " SP off 0.5 end 0.98 pow 2 elb 0 c 0.5";
        document.getElementById("zf_indirect").value = "2";
        document.getElementById("phase_correction_indirect_p0").value = 0;
        document.getElementById("phase_correction_indirect_p1").value = 0;
        document.getElementById("auto_indirect").checked = true;
        document.getElementById("delete_imaginary_indirect").checked = false;
        document.getElementById("neg_imaginary").checked = false
    }
    /**
     * Get button text
     */
    let button_text = self.innerText;
    /**
     * If the button text is "Reprocess", we need to prepare for reprocess the spectrum
     */
    if(button_text === "Reprocess")
    {
        /**
         * hide input fid files
         */
        document.getElementById("input_files").style.display = "none";

        /**
         * Set hsqc_spectra[spectrum_index] as the current spectrum
         */
        document.getElementById("spectrum-" + spectrum_index).style.backgroundColor = "lightblue";
        document.getElementById("input_options").style.backgroundColor = "lightblue";
        /**
         * Change button text to "Quit reprocessing"
         */
        self.innerText = "Quit reprocessing";
        /**
         * Hide div "file_area" and "input_files" (of fid_file_area). 
         * Change the button "button_fid_process" text to "Reprocess"
         */
        document.getElementById("file_area").style.display = "none";
        document.getElementById("input_files").style.display = "none";
        document.getElementById("button_fid_process").value = "Reprocess";

        /**
         * Set html elements with the fid_process_parameters of the spectrum
         */
        set_fid_parameters(hsqc_spectra[spectrum_index].fid_process_parameters);
        
        /**
         * Switch to cross section mode for current spectrum by simulating a click event
         */
        document.getElementById("show_cross_section".concat("-").concat(spectrum_index)).click();
        // document.getElementById("show_cross_section".concat("-").concat(spectrum_index)).checked = true;
        // document.getElementById("show_projection".concat("-").concat(spectrum_index)).checked = false;
        current_reprocess_spectrum_index = spectrum_index;


        /**
         * Enable apply_phase_correction button
         */
        document.getElementById("button_apply_ps").disabled = false;
    }
    else
    {
        /**
         * Undo hide of input fid files
         */
        document.getElementById("input_files").style.display = "flex";

        /**
         * Reset the spectrum color
         */
        document.getElementById("spectrum-" + spectrum_index).style.backgroundColor = "white";
        document.getElementById("input_options").style.backgroundColor = "white";
        /**
         * Change button text back to "Reprocess"
         */
        self.innerText = "Reprocess";
        /**
         * Show div "file_area" and "input_files" (of fid_file_area).
         * Change the button "button_fid_process"text back to "Upload experimental files and process"
         */
        document.getElementById("file_area").style.display = "block";
        document.getElementById("input_files").style.display = "flex";
        document.getElementById("button_fid_process").value = "Upload experimental files and process";
        current_reprocess_spectrum_index = -1;

        /**
         * Restore default values for html elements
         */
        set_default_fid_parameters();
        /**
         * Disable apply_phase_correction button
         */
        document.getElementById("button_apply_ps").disabled = true;
    }
}

/**
 * Onclick event from save button
*/ 
function save_to_file()
{
    /**
     * Step 1, prepare the json data. Convert hsqc_spectra to a hsqc_spectra_copy
     * where in each spectrum object, we call create_shallow_copy_wo_float32 to have a shallow (modified) copy of the spectrum
     */
    let hsqc_spectra_copy = [];
    for(let i=0;i<hsqc_spectra.length;i++)
    {
        let spectrum_copy = hsqc_spectra[i].create_shallow_copy_wo_float32();
        hsqc_spectra_copy.push(spectrum_copy);
    }

    /**
     * Step 2, prepare the binaryData, which is a concatenation of all 
     *  header, raw_data, raw_data_ri, raw_data_ir, raw_data_ii in all hsqc_spectra elements
     */
    let totalLength = 0;
    for(let i=0;i<hsqc_spectra.length;i++){
        totalLength += hsqc_spectra[i].header.length + hsqc_spectra[i].raw_data.length + hsqc_spectra[i].raw_data_ri.length + hsqc_spectra[i].raw_data_ir.length + hsqc_spectra[i].raw_data_ii.length;
    }

    const jsonString = JSON.stringify(hsqc_spectra_copy);
    const jsonBytes = new TextEncoder().encode(jsonString);
    const jsonLength = jsonBytes.length;

    // Create a DataView to write the length as an Int32:
    const lengthBuffer = new ArrayBuffer(4);
    const lengthView = new DataView(lengthBuffer);
    lengthView.setInt32(0, jsonLength, true); // true for little-endian

    // Combine length, JSON, and binary data:
    const combinedBuffer = new ArrayBuffer(4 + jsonLength + totalLength*Float32Array.BYTES_PER_ELEMENT);
    const combinedView = new Uint8Array(combinedBuffer);

    combinedView.set(new Uint8Array(lengthBuffer), 0);
    combinedView.set(jsonBytes, 4);
    /**
     * Step 3, copy all binary data into combinedView
     */
    let offset = 4 + jsonLength;
    for(let i=0;i<hsqc_spectra.length;i++){
        combinedView.set(new Uint8Array(hsqc_spectra[i].header.buffer), offset);
        console.log('set header at offset ' + offset);
        console.log(hsqc_spectra[i].header);
        offset += hsqc_spectra[i].header.length * Float32Array.BYTES_PER_ELEMENT;
        combinedView.set(new Uint8Array(hsqc_spectra[i].raw_data.buffer), offset);
        offset += hsqc_spectra[i].raw_data.length * Float32Array.BYTES_PER_ELEMENT;
        combinedView.set(new Uint8Array(hsqc_spectra[i].raw_data_ri.buffer), offset);
        offset += hsqc_spectra[i].raw_data_ri.length * Float32Array.BYTES_PER_ELEMENT;
        combinedView.set(new Uint8Array(hsqc_spectra[i].raw_data_ir.buffer), offset);
        offset += hsqc_spectra[i].raw_data_ir.length * Float32Array.BYTES_PER_ELEMENT;
        combinedView.set(new Uint8Array(hsqc_spectra[i].raw_data_ii.buffer), offset);
        offset += hsqc_spectra[i].raw_data_ii.length * Float32Array.BYTES_PER_ELEMENT;
    }    

    // Create Blob and download:
    const blob = new Blob([combinedBuffer], { type: "application/octet-stream" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = "colmarvista_save.bin";
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
};

/**
 * Async function to load hsqc_spectra from a file
 */
async function loadBinaryAndJsonWithLength(arrayBuffer) {
    
    const uint8Array = new Uint8Array(arrayBuffer);

    // Read the length of the JSON data (first 4 bytes)
    const jsonLength = new DataView(arrayBuffer).getInt32(0, true); // true for little-endian

    // Extract the JSON data
    const jsonBytes = uint8Array.slice(4, 4 + jsonLength);
    const jsonString = new TextDecoder().decode(jsonBytes);
    hsqc_spectra = JSON.parse(jsonString);

    /**
     * Reattach methods defined in spectrum.js to all hsqc_spectra objects
     */
    for(let i=0;i<hsqc_spectra.length;i++)
    {
        /**
         * Loop all methods of class spectrum and attach them to the hsqc_spectra[i] object
         */
        let spectrum_methods = Object.getOwnPropertyNames(spectrum.prototype);
        for(let j=0;j<spectrum_methods.length;j++)
        {
            if(spectrum_methods[j] !== 'constructor')
            {
                hsqc_spectra[i][spectrum_methods[j]] = spectrum.prototype[spectrum_methods[j]];
            }
        }
        /**
         * For hsqc_spectra[i].fitted_peaks_object and picked_peaks_object, we need to reattach methods as well
         */
        if(hsqc_spectra[i].picked_peaks_object !== null)
        {
            let peaks_methods = Object.getOwnPropertyNames(cpeaks.prototype);
            for(let j=0;j<peaks_methods.length;j++)
            {
                if(peaks_methods[j] !== 'constructor')
                {
                    hsqc_spectra[i].picked_peaks_object[peaks_methods[j]] = cpeaks.prototype[peaks_methods[j]];
                }
            }
        }
        if(hsqc_spectra[i].fitted_peaks_object !== null)
        {
            let peaks_methods = Object.getOwnPropertyNames(cpeaks.prototype);
            for(let j=0;j<peaks_methods.length;j++)
            {
                if(peaks_methods[j] !== 'constructor')
                {
                    hsqc_spectra[i].fitted_peaks_object[peaks_methods[j]] = cpeaks.prototype[peaks_methods[j]];
                }
            }
        }
    }

    // Now we need to extract the binary data
    let offset = 4 + jsonLength;
    for(let i=0;i<hsqc_spectra.length;i++){
        hsqc_spectra[i].header = new Float32Array(arrayBuffer.slice(offset, offset + 512 * Float32Array.BYTES_PER_ELEMENT));
        console.log('load header at offset ' + offset);
        console.log(hsqc_spectra[i].header);
        offset += 512 * Float32Array.BYTES_PER_ELEMENT;
        
        hsqc_spectra[i].raw_data = new Float32Array(arrayBuffer.slice(offset, offset + hsqc_spectra[i].raw_data_length * Float32Array.BYTES_PER_ELEMENT));
        offset += hsqc_spectra[i].raw_data_length * Float32Array.BYTES_PER_ELEMENT;

        hsqc_spectra[i].raw_data_ri = new Float32Array(arrayBuffer.slice(offset, offset + hsqc_spectra[i].raw_data_ri_length * Float32Array.BYTES_PER_ELEMENT));
        offset += hsqc_spectra[i].raw_data_ri_length * Float32Array.BYTES_PER_ELEMENT;

        hsqc_spectra[i].raw_data_ir = new Float32Array(arrayBuffer.slice(offset, offset + hsqc_spectra[i].raw_data_ir_length * Float32Array.BYTES_PER_ELEMENT));
        offset += hsqc_spectra[i].raw_data_ir_length * Float32Array.BYTES_PER_ELEMENT;

        hsqc_spectra[i].raw_data_ii = new Float32Array(arrayBuffer.slice(offset, offset + hsqc_spectra[i].raw_data_ii_length * Float32Array.BYTES_PER_ELEMENT));
        offset += hsqc_spectra[i].raw_data_ii_length * Float32Array.BYTES_PER_ELEMENT;
    }
    draw_spectrum_from_loading();
};