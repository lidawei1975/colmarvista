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
try {
    webassembly_1d_worker_2 = new Worker('./js/webass1d_2.js');
}
catch (err) {
    console.log(err);
    if (typeof (webassembly_1d_worker_2) === "undefined" )
    {
        alert("Failed to load WebWorker for NUS, probably due to browser incompatibility. Please use a modern browser, if you run this program locally, please read the instructions titled 'How to run COLMAR Viewer locally'");
    }
}


var main_plot = null; //hsqc plot object
var b_plot_initialized = false; //flag to indicate if the plot is initialized
var tooldiv; //tooltip div (used by myplot1_new.js, this is not a good practice, but it is a quick fix)
var current_spectrum_index_of_peaks = -1; //index of the spectrum that is currently showing peaks, -1 means none, -2 means pseudo 2D fitted peaks
var current_flag_of_peaks = 'picked'; //flag of the peaks that is currently showing, 'picked' or 'fitted
var total_number_of_experimental_spectra = 0; //total number of experimental spectra
var pseudo3d_fitted_peaks_object = null; //pseudo 3D fitted peaks object
var pseudo2d_fitted_peaks_error = []; //pseudo 3D fitted peaks with error estimation array, each element is a Cpeaks object

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
var oOutput;

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

    fetch('navbar.html')
        .then(response => response.text())
        .then(data => {
            document.getElementById('navbar-placeholder').innerHTML = data;
        });

    /**
     * This is the main information output area
     */
    oOutput = document.getElementById("infor");

    /**
     * Tooltip div. Set the opacity to 0
     */
    tooldiv = d3.select("body")
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
    .files_name(["acqus", "ser", "fid"])  /** file names to be searched from upload */
    .files_id([ "acquisition_file", "fid_file", "fid_file"]) /** Corresponding file element IDs */
    .file_extension([])  /** file extensions to be searched from upload */
    .required_files([0,1])
    .init();


    /**
     * ft2 file drop processor
     */
    ft1_file_drop_processor = new file_drop_processor()
    .drop_area('file_area') /** id of dropzone */
    .files_name([]) /** file names to be searched from upload. It is empty because we will use file_extension*/
    .file_extension(["ft1","txt"])  /** file extensions to be searched from upload */
    .files_id(["userfile","userfile"]) /** Corresponding file element IDs */
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
                    if(this.querySelector('input[type="file"]').files[ii].name.endsWith(".ft1") || this.querySelector('input[type="file"]').files[ii].name.endsWith(".ucsf") )
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
                        let result_spectrum = new spectrum_1d();
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
                            result_spectrum = new spectrum_1d();
                            result_spectrum.process_ft_file(file_data,this.querySelector('input[type="file"]').files[ii].name,-1);
                        }
                        else
                        {
                            result_spectrum = new spectrum_1d();
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
        

        if(button_text === "Reprocess"){
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
            fid_process_parameters.delete_imaginary = document.getElementById("delete_imaginary").checked;
            fid_process_parameters.pseudo_2d_process = document.querySelector('input[name="Pseudo-2D-process"]:checked').id;

            /**
             * Send to webassembly worker
             */
            webassembly_1d_worker_2.postMessage(fid_process_parameters);
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

            if (acquisition_file && fid_file) {
                let acquisition_string = await read_file_text(acquisition_file);
                let fid_buffer = await read_file(fid_file);
                /**
                 * Convert fid_buffer to Float32Array
                 */
                let apodization_string = document.getElementById("apodization_direct").value;
                let zf_direct = parseInt(document.getElementById("zf_direct").value);
                let phase_correction_direct_p0 = parseFloat(document.getElementById("phase_correction_direct_p0").value);
                let phase_correction_direct_p1 = parseFloat(document.getElementById("phase_correction_direct_p1").value);
                let auto_direct = document.getElementById("auto_direct").checked;
                let delete_imaginary = document.getElementById("delete_imaginary").checked;
                /**
                 * Get radio group name "Pseudo-2D-process", id "first_only" or "all_traces"
                 */
                let pseudo_2d_process = document.querySelector('input[name="Pseudo-2D-process"]:checked').id;

                /**
                 * fid_process_parameters is a GLOBAL object that will be sent to the webassembly worker
                 * It will be saved here, in case we need to re-process the fid file
                 */
                fid_process_parameters = {
                    webassembly_job: "fid_processor_1d",
                    acquisition_string: acquisition_string,
                    fid_buffer: fid_buffer,
                    apodization_string: apodization_string,
                    zf_direct: zf_direct,
                    phase_correction_direct_p0: phase_correction_direct_p0,
                    phase_correction_direct_p1: phase_correction_direct_p1,
                    auto_direct: auto_direct,
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

                webassembly_1d_worker_2.postMessage(fid_process_parameters);
                /**
                 * Disable the submit button of this form
                 */
                document.getElementById("button_fid_process").disabled = true;
            }
            else{
                alert("Please select both acquisition and fid files.");
            }
        }
    });

    /**
     * Event listener for peak_size, peak_thickness, filled_peaks and peak_color
     */
    document.getElementById('peak_size').addEventListener('change', function (e) {
        main_plot.peak_size = parseFloat(this.value);
        main_plot.redraw_peaks(1);
    });
    document.getElementById('peak_thickness').addEventListener('change', function (e) {
        main_plot.peak_thickness = parseFloat(this.value);
        main_plot.redraw_peaks(2);
    });
    document.getElementById('filled_peaks').addEventListener('change', function (e) {
        main_plot.filled_peaks = this.checked;
        main_plot.redraw_peaks(3);
    });
    document.getElementById('peak_color').addEventListener('change', function (e) {
        main_plot.peak_color = this.value;
        main_plot.redraw_peaks(4);
    });
});

webassembly_1d_worker_2.onmessage = function (e) {
    
    if(e.data.webassembly_job === "fid_processor_1d"){
        /**
         * Received fid processing result:
         *  webassembly_job: event.data.webassembly_job,
            fid_json: fid_json,
            spectrum_header : header_data,
            real_spectrum_data: real_spectrum_data,
         */
        result_spectrum = new spectrum_1d();

        /**
         * Combine header and fid_json to create a new float32 array and convert to arrayBuffer
         */
        const combined = new Float32Array(e.data.spectrum_header.length + e.data.real_spectrum_data.length*2);
        combined.set(e.data.spectrum_header);
        combined.set(e.data.real_spectrum_data, e.data.spectrum_header.length);
        combined.set(e.data.image_spectrum_data, e.data.spectrum_header.length + e.data.real_spectrum_data.length);
        const buffer = combined.buffer;
        result_spectrum.process_ft_file(buffer,'from_fid.ft1',-2);
        result_spectrum.spectrum_index = e.data.spectrum_index; //spectrum_index is set to what is in reprocess_spectrum_index

        /**
         * Save the phase correction values to fid_process_parameters
         */
        fid_process_parameters.phase_correction_direct_p0 = e.data.p0;
        fid_process_parameters.phase_correction_direct_p1 = e.data.p1;

        /**
         * Update fid processing box parameters
         */
        document.getElementById("phase_correction_direct_p0").value = e.data.p0.toFixed(2);
        document.getElementById("phase_correction_direct_p1").value = e.data.p1.toFixed(2);

        draw_spectrum([result_spectrum],true/**from fid */,e.data.reprocess/** re-process of fid or ft2 */);
        /**
         * Re-enable the button to process fid file
         */
        document.getElementById("button_fid_process").disabled = false;
    }


    else if(e.data.webassembly_job === "peak_picker")
    {
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
        disable_enable_fitted_peak_buttons(e.data.spectrum_index,0);

        /**
         * Need to save its scale and scale2 used to run deep picker
         * because we will need them to run peak fitting
         */
        all_spectra[e.data.spectrum_index].scale = e.data.scale;
        all_spectra[e.data.spectrum_index].scale2 = e.data.scale2;
        
        disable_enable_peak_buttons(e.data.spectrum_index,1);

        /**
         * Clear the processing message
         */
        document.getElementById("webassembly_message").innerText = "";
    }
    /**
     * If result is fitted_peaks and recon_spectrum
     */
    else if (e.data.webassembly_job === "peak_fitter") { 
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
        disable_enable_fitted_peak_buttons(e.data.spectrum_origin,1);
        
        /**
         * Process the frequency domain spectrum, spectrum name is "recon-".spectrum_origin.".ft2"
         */
        let result_spectrum_name = "recon-".concat(e.data.spectrum_origin.toString(), ".ft1");
        let result_spectrum = new spectrum_1d();
        result_spectrum.process_ft_file_type2(all_spectra[e.data.spectrum_origin].header,e.data.recon_spectrum,result_spectrum_name,e.data.spectrum_origin);

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

    else if(e.data.webassembly_job === "generate_voigt_profiles"){

        /**
         * If peak index == 0, we are receiving the first one from a new batch, remove all existing profiles first
         */
        if(e.data.profile_index==0)
        {
            main_plot.remove_all_peak_profiles();
        }
        /**
         * Add the profile to the main_plot
         */
        main_plot.add_peak_profile(e.data.profile_ppm, e.data.profile_data);
    }


    else if(e.data.stdout)
    {
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
                main_plot.redraw_order();
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
        /**
         * If this is current spectrum, do not minimize it
         */
        if(main_plot.current_spectrum_index === index)
        {
            return; 
        }
        /**
         * If current spectrum is recon spectrum of spectrum index, do not minimize it
         */
        if( all_spectra[main_plot.current_spectrum_index].spectrum_origin  === index)
        {
            return;
        }

        minimize_button.innerText = "+";
        spectrum_div.style.height = "1.75rem";
        spectrum_div.style.overflow = "clip";
        
        all_spectra[index].visible = false;
        main_plot.update_visibility(index,false);

        /**
         * If peaks are shown, remove them as well
         */
        if(current_spectrum_index_of_peaks === index)
        {
            current_spectrum_index_of_peaks = -1;
            main_plot.remove_peaks();
        }

        /**
         * Loop all spectra, find children of this spectrum, hide them too
         */
        for(let i=0;i<all_spectra.length;i++)
        {
            if(all_spectra[i].spectrum_origin === index)
            {
                all_spectra[i].visible = false;
                main_plot.update_visibility(i,false);
                if(current_spectrum_index_of_peaks === i)
                {
                    current_spectrum_index_of_peaks = -1;
                    main_plot.remove_peaks();
                }
            }
        }
    }
    else
    {
        minimize_button.innerText = "-";
        spectrum_div.style.height = "auto";
        all_spectra[index].visible = true;
        main_plot.update_visibility(index,true);

        /**
         * Loop all spectra, find children of this spectrum, show them too
         */
        for(let i=0;i<all_spectra.length;i++)
        {
            if(all_spectra[i].spectrum_origin === index)
            {
                all_spectra[i].visible = true;
                main_plot.update_visibility(i,true);
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
    if(new_spectrum.spectrum_origin === -3)
    {
        return;
    }

    /**
     * Add a draggable div to the new spectrum_1d div, only if the spectrum is experimental
     */
    if(new_spectrum.spectrum_origin === -1 || new_spectrum.spectrum_origin === -2 || new_spectrum.spectrum_origin >=10000)
    {
        /**
         * Also add an minimize button to the new spectrum_1d div
         */
        let minimize_button = document.createElement("button");
        minimize_button.id = "minimize-".concat(index);
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
     * Add a "Reprocess" button to the new spectrum_1d div if
     * 1. spectrum_origin == -2 (experimental spectrum from fid, and must be first if from pseudo 2D)
     * TODO: 2. spectrum_origin == -1 (experimental spectrum from ft2) && raw_data_i or raw_data_i is not empty
     */
    if(new_spectrum.spectrum_origin === -2)
    {
        let reprocess_button = document.createElement("button");
        reprocess_button.innerText = "Reprocess";
        reprocess_button.onclick = function () { reprocess_spectrum(this,index); };
        new_spectrum_div.appendChild(reprocess_button);
    }
    
    if(new_spectrum.spectrum_origin === -1 || new_spectrum.spectrum_origin === -2 || new_spectrum.spectrum_origin >=10000)
    {
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
        main_plot.update_current_spectrum_index(index);
        /**
         * Highlight the current spectrum in the list
         */
        new_spectrum_div.style.backgroundColor = "lightblue";
        

        /**
         * Add a onclick function to the new spectrum_1d div to set the current spectrum index
         */
        span_for_index.onclick = function () {
            /**
             * Un-highlight the current spectrum in the list
             */
            set_current_spectrum(index);
            /**
             * If this new spectrum_1d has no imaginary part, disable auto phase correction button
             */
            if(all_spectra[index].raw_data_i.length > 0 && all_spectra[index].raw_data_i.length > 0 )
            {
                document.getElementById("automatic_pc").disabled = false;
            }
            else
            {
                document.getElementById("automatic_pc").disabled = true;
            }
        }
        /**
         * Add filename as a text node
         */
        let fname_text = document.createTextNode(" File name: " + all_spectra[index].filename + " ");
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
    }


    /**
     * Add a download button to download the spectrum 
     * Allow download of from fid and from reconstructed spectrum
     */
    let download_button = document.createElement("button");
    download_button.innerText = "Download ft1";
    download_button.onclick = function () { download_spectrum(index,'original'); };
    new_spectrum_div.appendChild(download_button);
    
    /**
     * A color picker element with the color of the contour plot, whose ID is "contour_color-".concat(index)
     * Set the color of the picker to the color of the spectrum
     * Also add an event listener to update the color of the contour plot
     */
    let line_color_label = document.createElement("label");
    line_color_label.setAttribute("for", "line_color-".concat(index));
    line_color_label.innerText = "Color: ";
    let line_color_input = document.createElement("input");
    line_color_input.setAttribute("type", "color");
    line_color_input.setAttribute("value", new_spectrum.spectrum_color);
    line_color_input.setAttribute("id", "contour_color-".concat(index));
    line_color_input.addEventListener("change", (e) => { update_line_color(e, index); });
    new_spectrum_div.appendChild(line_color_label);
    new_spectrum_div.appendChild(line_color_input);

    /**
     * For no-reconstructed spectra or add spectra from pseudo 2D, add 
     * Label and span for spectrum scale, default is 1.0
     * Label and span for spectrum reference, default is 0.0
     */
    if( new_spectrum.spectrum_origin < 0 )
    {
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
        deep_picker_button.onclick = function () { run_DEEP_Picker(index,0); };
        new_spectrum_div.appendChild(deep_picker_button);

        // Add a line break
        if (new_spectrum.spectrum_origin >= 0 && new_spectrum.spectrum_origin < 10000)
        {

        }
        else{
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
        if(all_spectra[index].picked_peaks_object === null || all_spectra[index].picked_peaks_object.column_headers.length === 0)
        {
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
    download_peaks_button.onclick = function () { download_peaks(index,'picked'); };
    new_spectrum_div.appendChild(download_peaks_button);



    if (new_spectrum.spectrum_origin >= 0 && new_spectrum.spectrum_origin < 10000) {
        /**
         * Add a download button to download the fitted peaks.
         * Disabled (enabled) if all_spectra[index].fitted_peaks_object is empty (not empty)
         */
        let download_fitted_peaks_button = document.createElement("button");
        download_fitted_peaks_button.innerText = "Download fitted peaks";
        download_fitted_peaks_button.setAttribute("id", "download_fitted_peaks-".concat(index));
        download_fitted_peaks_button.onclick = function () { download_peaks(index,'fitted'); };
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
                show_hide_peaks(index,'fitted', true);
            }
            else {
                show_hide_peaks(index,'fitted', false);
            }
        }
        if(all_spectra[index].fitted_peaks_object === null || all_spectra[index].fitted_peaks_object.column_headers.length === 0)
        {
            show_fitted_peaks_checkbox.disabled = true;
            download_fitted_peaks_button.disabled = true;
        }
         new_spectrum_div.appendChild(show_fitted_peaks_checkbox);
        let show_fitted_peaks_label = document.createElement("label");
        show_fitted_peaks_label.setAttribute("for", "show_fitted_peaks-".concat(index));
        show_fitted_peaks_label.innerText = "Show fitted peaks";
        new_spectrum_div.appendChild(show_fitted_peaks_label);
    }

    /**
     * Disable the download or show picked or fitted peaks buttons, depending on the state of the picked or fitted peaks
     */
    if(all_spectra[index].picked_peaks_object === null || all_spectra[index].picked_peaks_object.column_headers.length === 0)
    {
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
     * Add the new spectrum_1d div to the list of spectra if it is from experimental data
    */
    if(all_spectra[index].spectrum_origin < 0 || all_spectra[index].spectrum_origin >= 10000)
    {
        document.getElementById("spectra_list_ol").appendChild(new_spectrum_div_list);
    }
    /**
     * If the spectrum is reconstructed, add the new spectrum_1d div to the reconstructed spectrum list
     */
    else
    {
        document.getElementById("reconstructed_spectrum_ol-".concat(all_spectra[index].spectrum_origin)).appendChild(new_spectrum_div_list);
    }

    if(new_spectrum.spectrum_origin === -1 || new_spectrum.spectrum_origin === -2 || new_spectrum.spectrum_origin >=10000)
    {
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
            x_ppm_start = all_spectra[i].x_ppm_start +  + all_spectra[i].x_ppm_ref;
        }
        if (all_spectra[i].x_ppm_start  + all_spectra[i].x_ppm_ref + all_spectra[i].x_ppm_step * all_spectra[i].n_direct < x_ppm_end) {
            x_ppm_end = all_spectra[i].x_ppm_start + all_spectra[i].x_ppm_step * all_spectra[i].n_direct  + all_spectra[i].x_ppm_ref ;
        }
        if (all_spectra[i].y_ppm_start  + all_spectra[i].y_ppm_ref > y_ppm_start) {
            y_ppm_start = all_spectra[i].y_ppm_start + all_spectra[i].y_ppm_ref ;
        }
        if (all_spectra[i].y_ppm_start + all_spectra[i].y_ppm_step * all_spectra[i].n_indirect + all_spectra[i].y_ppm_ref < y_ppm_end) {
            y_ppm_end = all_spectra[i].y_ppm_start + all_spectra[i].y_ppm_step * all_spectra[i].n_indirect+ all_spectra[i].y_ppm_ref ;
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
    if (all_spectra[index].datatype_direct === 1 ) {
        data = Float32Concat(all_spectra[index].header, all_spectra[index].raw_data);
    }
    else
    {
        data = new Float32Array(512 + all_spectra[index].n_direct*2);
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

    function set_fid_parameters(fid_process_parameters){
        /**
         * Set fid_process_parameters to the input fields
         */
        document.getElementById("apodization_direct").value = fid_process_parameters.apodization_string;
        document.getElementById("zf_direct").value = fid_process_parameters.zf_direct;
        document.getElementById("phase_correction_direct_p0").value = fid_process_parameters.phase_correction_direct_p0.toFixed(2);
        document.getElementById("phase_correction_direct_p1").value = fid_process_parameters.phase_correction_direct_p1.toFixed(2);
        document.getElementById("auto_direct").checked = fid_process_parameters.auto_direct;
        document.getElementById("delete_imaginary").checked = fid_process_parameters.delete_imaginary;
    }

    function set_default_fid_parameters(){
        /**
         * Set fid_process_parameters to the default values
         */
        document.getElementById("apodization_direct").value = "SP off 0.5 end 0.98 pow 2 elb 0 c 0.5";
        document.getElementById("zf_direct").value = "2";
        document.getElementById("phase_correction_direct_p0").value = "0.0";
        document.getElementById("phase_correction_direct_p1").value = "0.0";
        document.getElementById("auto_direct").checked = true;
        document.getElementById("delete_imaginary").checked = false;
    }

    /**
     * Get button text
     */
    let button_text = button.innerText;
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
         * Set all_spectra[spectrum_index] as the current spectrum
         */
        document.getElementById("spectrum-" + spectrum_index).querySelector("div").style.backgroundColor = "lightblue";
        document.getElementById("input_options").style.backgroundColor = "lightgreen";
        /**
         * Change button text to "Quit reprocessing"
         */
        button.innerText = "Quit reprocessing";
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
    else
    {
        /**
         * Undo hide of input fid files
         */
        document.getElementById("input_files").style.display = "flex";
        /**
         * Change button text back to "Reprocess"
         */
        button.innerText = "Reprocess";
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
         * Restore default values for html elements
         */
        set_default_fid_parameters();
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
function draw_spectrum(result_spectra, b_from_fid,b_reprocess)
{

    let spectrum_index;

    if(b_from_fid ==false && b_reprocess === false)
    {
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
        if(result_spectra[0].spectrum_origin >=0)
        {
            all_spectra[result_spectra[0].spectrum_origin].reconstructed_indices.push(spectrum_index);
        }
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
            result_spectra[i].spectrum_index = all_spectra.length;
            result_spectra[i].spectrum_color = rgbToHex(color_list[(result_spectra[i].spectrum_index) % color_list.length]);

            /**
             * For spectrum from fid, we need to include all FID files and processing parameters in the result_spectra object
             */
            if(i==0)
            {
                fid_process_parameters.spectrum_index = result_spectra[i].spectrum_index; //set the spectrum index in fid_process_parameters
                result_spectra[i].fid_process_parameters = fid_process_parameters;
                first_spectrum_index = result_spectra[i].spectrum_index;
                result_spectra[i].spectrum_origin = -2; //from fid
            }
            else
            {
                result_spectra[i].spectrum_origin = 10000 + first_spectrum_index;
            }

            all_spectra.push(result_spectra[i]);
        }
        spectrum_index = first_spectrum_index; //set the spectrum index to the first spectrum index
    }
    else if( b_reprocess === true)
    {
        /**
         * Reprocessed spectrum, get its index and update the spectrum. 
         * Also, update the fid_process_parameters
         */
        spectrum_index = result_spectra[0].spectrum_index;
        result_spectra[0].fid_process_parameters = fid_process_parameters;
        result_spectra[0].spectrum_color = rgbToHex(color_list[(spectrum_index) % color_list.length]);
        all_spectra[spectrum_index] = result_spectra[0];
    }
    

    /**
     * initialize the plot with the first spectrum. This function only run once
     */
    if(b_plot_initialized === false)
    {
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
        main_plot.init(cr.width, cr.height,peak_params,update_reconstructed_peaks_debounced,permanently_apply_phase_correction);

        /**
         * Add first spectrum to the plot (result_spectra[0] is the first spectrum)
         * We need to make a data array of two numbers: ppm and amplitude
         */
        let data = [];
        if(result_spectra[0].raw_data_i.length === result_spectra[0].raw_data.length)
        {
            for (let i = 0; i < result_spectra[0].n_direct; i++) {
                data.push([result_spectra[0].x_ppm_start + result_spectra[0].x_ppm_step * i + result_spectra[0].x_ppm_ref, result_spectra[0].raw_data[i],result_spectra[0].raw_data_i[i]]);
            }
        }    
        else
        {
            for (let i = 0; i < result_spectra[0].n_direct; i++)
            {
                data.push([result_spectra[0].x_ppm_start + result_spectra[0].x_ppm_step * i + result_spectra[0].x_ppm_ref, result_spectra[0].raw_data[i]]);
            }
        }
        main_plot.add_data(data,result_spectra[0].spectrum_index,result_spectra[0].spectrum_color);

        plot_div_resize_observer.observe(document.getElementById("plot_1d")); 
    }
    else
    {
        let data = [];
        if(result_spectra[0].raw_data_i.length === result_spectra[0].raw_data.length)
        {
            for(let i=0; i < result_spectra[0].n_direct; i++)
            {
                data.push([result_spectra[0].x_ppm_start + result_spectra[0].x_ppm_step * i + result_spectra[0].x_ppm_ref, result_spectra[0].raw_data[i],result_spectra[0].raw_data_i[i]]);
            }
        }
        else
        {
            for (let i = 0; i < result_spectra[0].n_direct; i++) {
                data.push([result_spectra[0].x_ppm_start + result_spectra[0].x_ppm_step * i + result_spectra[0].x_ppm_ref, result_spectra[0].raw_data[i]]);
            }
        }
        main_plot.add_data(data,result_spectra[0].spectrum_index, result_spectra[0].spectrum_color);
    }

    if(b_reprocess === false)
    {
        add_to_list(spectrum_index,b_from_fid,b_reprocess);
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

    /**
     * Backward compatibility for old hex color format
     * In old version, hex might be [0,0,1,1] (rgba)
     * then we return as [0,0, ]
     */
    if(hex.length === 4)
    {
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

async function download_plot()
{
/**
     * Generate a link to download main_plot as a SVG file
     * The top SVG element has id = "plot_1d"
     */
    var svgData = document.getElementById("plot_1d").outerHTML;
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
            all_spectra[spectrum_index].picked_peaks_object = peak_list;
            
            /**
             * when picked peaks are received, fitted peaks need to be reset
             */
            all_spectra[spectrum_index].fitted_peaks_object = null;
            /**
             * Disable the download fitted peaks button. Uncheck the show fitted peaks checkbox, disable it too
             */
            disable_enable_fitted_peak_buttons(spectrum_index,0);
            /**
             * When peaks are loaded, set default scale and scale2 for peak fitting
             */
            all_spectra[spectrum_index].scale = 5.5;
            all_spectra[spectrum_index].scale2 = 3.5;

            disable_enable_peak_buttons(spectrum_index,1);

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
 * Disable or enable buttons of download_peaks-, run_deep_picker-, run_voigt_fitter-, show_peaks-
 */
function disable_enable_peak_buttons(spectrum_index,flag)
{
    if(flag===0 || flag===2)
    {
        /**
         * Disable the buttons to run deep picker and voigt fitter
         */
        document.getElementById("download_peaks-".concat(spectrum_index)).disabled = true;
        document.getElementById("run_load_peak_list-".concat(spectrum_index)).disabled = true;
        document.getElementById("run_deep_picker-".concat(spectrum_index)).disabled = true;
        document.getElementById("run_voigt_fitter-".concat(spectrum_index)).disabled = true;
        if(flag===0)
        {
            document.getElementById("show_peaks-".concat(spectrum_index)).disabled = true;
            document.getElementById("show_peaks-".concat(spectrum_index)).checked = false;
        }
    }
    else if(flag===1)
    {
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



/**
 * Call DEEP Picker to run peaks picking the spectrum
 * @param {int} spectrum_index: index of the spectrum in all_spectra array
 * @param {int} flag: 0 for DEEP Picker, 1 for Simple Picker
 */
function run_DEEP_Picker(spectrum_index,flag)
{
    disable_enable_peak_buttons(spectrum_index,0);
    disable_enable_fitted_peak_buttons(spectrum_index,0);

    /**
     * Combine all_spectra[0].raw_data and all_spectra[0].header into one Float32Array
     * Need to copy the header first, modify complex flag (doesn't hurt even when not necessary), then concatenate with raw_data
     */
    let header = new Float32Array(all_spectra[spectrum_index].header);
    header[55] = 1.0; //keep real part only
    header[56] = 1.0; //keep real part only
    header[99] = all_spectra[spectrum_index].n_direct; //size of indirect dimension of the input spectrum
    header[219] = all_spectra[spectrum_index].n_indirect; //size of indirect dimension of the input spectrum
    let data = Float32Concat(header, all_spectra[spectrum_index].raw_data);


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
        webassembly_job: "peak_picker",
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
function run_Voigt_fitter(spectrum_index,flag)
{
    /**
     * Disable the buttons to run deep picker and voigt fitter
     */
    disable_enable_peak_buttons(spectrum_index,2);
    disable_enable_fitted_peak_buttons(spectrum_index,0);

    /**
     * Get maxround input field with ID "maxround-"+spectrum_index
     */
    let maxround = parseInt(document.getElementById("maxround-"+spectrum_index).value);

    /**
     * Get peak combine cutoff
     */
    let peak_combine_cutoff = parseFloat(document.getElementById("peak_combine_cutoff-"+spectrum_index).value);

  
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
    if(x_ppm_visible_start < x_ppm_visible_end)
    {
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
        webassembly_job: "peak_fitter",
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
function disable_enable_fitted_peak_buttons(spectrum_index,flag)
{
    /**
     * (new_spectrum.spectrum_origin >= 0 && new_spectrum.spectrum_origin < 10000) means reconstructed spectrum
     */
    let b_reconstructed = (all_spectra[spectrum_index].spectrum_origin >= 0 && all_spectra[spectrum_index].spectrum_origin < 10000);

    if(flag==0 && b_reconstructed)
    {
        document.getElementById("download_fitted_peaks-".concat(spectrum_index)).disabled = true;
        document.getElementById("show_fitted_peaks-".concat(spectrum_index)).disabled = true;   
        document.getElementById("show_fitted_peaks-".concat(spectrum_index)).checked = false;
    }
    else if(flag==1)
    {
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
function show_hide_peaks(index,flag,b_show)
{
    /**
     * Turn off checkbox of all other spectra
     */
    for(let i=0;i<all_spectra.length;i++)
    {
        const b_reconstructed = (all_spectra[i].spectrum_origin >= 0 && all_spectra[i].spectrum_origin < 10000);
        if(i!==index)
        {
            document.getElementById("show_peaks-"+i).checked = false;
            if(b_reconstructed)
            {
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
                if(b_reconstructed){
                    document.getElementById("show_fitted_peaks-"+i).checked = false;
                }
            }
            else if(flag === 'fitted')
            {
                document.getElementById("show_peaks-"+i).checked = false;
            }
        }
    }

    if(b_show)
    {
        current_spectrum_index_of_peaks = index;
        set_current_spectrum(index);
        current_flag_of_peaks = flag;
        show_peak_table();
        main_plot.remove_peaks();

        if(flag === 'picked')
        {
            main_plot.add_peaks(all_spectra[index].picked_peaks_object,'picked');
        }
        else
        {
            main_plot.add_peaks(all_spectra[index].fitted_peaks_object,'fitted');
            update_reconstructed_peaks(current_spectrum_index_of_peaks);
        }
    }
    else
    {
        current_spectrum_index_of_peaks = -1; // -1 means no spectrum is selected. flag is not important
        main_plot.remove_peaks();
        remove_peak_table();
    }
}

let zoomPanTimeout; // to debounce zoom and pan events
function update_reconstructed_peaks_debounced(index) {
    clearTimeout(zoomPanTimeout);

  // Set a new timeout
  zoomPanTimeout = setTimeout(() => {
    console.log("Zoom or pan stopped. Running function.");
    update_reconstructed_peaks(index);
  }, 100);
}


function update_reconstructed_peaks(index) {


    main_plot.update_reconstructed_peaks([]);

    /**
     * If picked peaks, do nothing
     */
    if (current_flag_of_peaks === 'picked') {
        return;
    }

    /**
     * Generate fitted peak profiles from all_spectra[index].fitted_peaks_object
     * step1: get all peaks from fitted_peaks_object that are within visible region of main_plot
     * and extract the following columns: "X_PPM","HEIGHT","SIGMAX","GAMMAX"
     */
    const [x_ppm_visible_start, x_ppm_visible_end] = main_plot.get_visible_region();
    const plot_width = main_plot.true_width; //get the width of the plot in pixels
    /**
     * Get median peak width in fitted_peaks_object
     */
    const all_peak_widths = all_spectra[index].fitted_peaks_object.get_column_by_header("XW").sort((a, b) => a - b); //sort the peak widths
    const median_peak_width = all_peak_widths[all_peak_widths.length >> 1] * Math.abs(all_spectra[index].x_ppm_step); //get the median peak width in ppm
    const median_peak_width_pixel = median_peak_width / (x_ppm_visible_end - x_ppm_visible_start) * plot_width; //convert to pixel width

    /**
     * We only need to generate profiles for peaks when median_peak_width_pixel is at least 4 pixels
     */
    if (median_peak_width_pixel > 4) {
        let filtered_peaks_recon = all_spectra[index].recon_peaks.filter((value, i) => all_spectra[index].recon_peaks_center[i] >= x_ppm_visible_start && all_spectra[index].recon_peaks_center[i] <= x_ppm_visible_end);

        main_plot.update_reconstructed_peaks(filtered_peaks_recon);

        /**
         * Each peak is an array of [X_AXIS, HEIGHT, SIGMAX, GAMMAX], that is, 4 numbers
         * Step 2: for each peak, generate a profile
         * We need web assembly worker to generate the profile (pseudo Voigt profile)
         */
        // const peaks_as_array = all_spectra[index].fitted_peaks_object.get_selected_columns_as_array(["X_PPM","HEIGHT","SIGMAX","GAMMAX"])
        //         .filter(peak => {
        //             return peak[0] >= x_ppm_visible_start && peak[0] <= x_ppm_visible_end;
        //         });
        // webassembly_1d_worker_2.postMessage({
        //     webassembly_job: "generate_voigt_profiles",
        //     peaks: peaks_as_array, //array of peaks, each peak is an array of [X_AXIS, HEIGHT, SIGMAX, GAMMAX]
        //     step: Math.abs(all_spectra[index].x_ppm_step), //step of the spectrum
        // });
    }
}

/**
 * Generate a list of peaks in nmrPipe .tab format
 */
function download_peaks(spectrum_index,flag)
{
    let file_buffer;

    if(flag === 'picked')
    {
        file_buffer = all_spectra[spectrum_index].picked_peaks_object.save_peaks_tab();
    }
    else if(flag === 'fitted')
    {
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

function update_line_color(e,index) {
    let color = e.target.value;  //hex format
    all_spectra[index].spectrum_color = (color);
    main_plot.update_spectrum_color(index, color);
}

/**
 * Onclick event from save button
*/ 
function save_to_file()
{
    /**
     * Step 1, prepare the json data. Convert all_spectra to a all_spectra_copy
     * where in each spectrum object, we call create_shallow_copy_wo_float32 to have a shallow (modified) copy of the spectrum
     */
    let all_spectra_copy = [];
    for(let i=0;i<all_spectra.length;i++)
    {
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
    for(let i=0;i<all_spectra.length;i++){
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
    const combinedBuffer = new ArrayBuffer(4 + jsonLength + totalLength*Float32Array.BYTES_PER_ELEMENT);
    const combinedView = new Uint8Array(combinedBuffer);

    console.log("Length of length: 4, Length of JSON data: " + jsonLength);
    console.log("Total length of binary data: " + totalLength*Float32Array.BYTES_PER_ELEMENT);

    combinedView.set(new Uint8Array(lengthBuffer), 0);
    combinedView.set(jsonBytes, 4);
    /**
     * Step 3, copy all binary data into combinedView
     */
    let offset = 4 + jsonLength;
    for(let i=0;i<all_spectra.length;i++){
        combinedView.set(new Uint8Array(all_spectra[i].header.buffer, 0, 2048), offset);
        console.log("all_spectra[i].header.length: " + all_spectra[i].header.length);
        console.log("set header at offset " + offset);
        offset += all_spectra[i].header.length * Float32Array.BYTES_PER_ELEMENT;
        combinedView.set(new Uint8Array(all_spectra[i].raw_data.buffer,0,all_spectra[i].raw_data.length*4), offset);
        console.log("set raw_data at offset " + offset);
        offset += all_spectra[i].raw_data.length * Float32Array.BYTES_PER_ELEMENT;
        combinedView.set(new Uint8Array(all_spectra[i].raw_data_i.buffer,0,all_spectra[i].raw_data_i.length*4), offset);
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
     * Reattach methods defined in spectrum.js to all all_spectra objects
     */
    for(let i=0;i<all_spectra.length;i++)
    {
        /**
         * Loop all methods of class spectrum_1d and attach them to the all_spectra[i] object
         */
        let spectrum_methods = Object.getOwnPropertyNames(spectrum_1d.prototype);
        for(let j=0;j<spectrum_methods.length;j++)
        {
            if(spectrum_methods[j] !== 'constructor')
            {
                all_spectra[i][spectrum_methods[j]] = spectrum_1d.prototype[spectrum_methods[j]];
            }
        }
        /**
         * For all_spectra[i].fitted_peaks_object and picked_peaks_object, we need to reattach methods as well
         */
        if(all_spectra[i].picked_peaks_object !== null && all_spectra[i].picked_peaks_object.column_headers.length > 0)
        {
            let peaks_methods = Object.getOwnPropertyNames(cpeaks.prototype);
            for(let j=0;j<peaks_methods.length;j++)
            {
                if(peaks_methods[j] !== 'constructor')
                {
                    all_spectra[i].picked_peaks_object[peaks_methods[j]] = cpeaks.prototype[peaks_methods[j]];
                }
            }
        }
        if(all_spectra[i].fitted_peaks_object !== null && all_spectra[i].fitted_peaks_object.column_headers.length > 0)
        {
            let peaks_methods = Object.getOwnPropertyNames(cpeaks.prototype);
            for(let j=0;j<peaks_methods.length;j++)
            {
                if(peaks_methods[j] !== 'constructor')
                {
                    all_spectra[i].fitted_peaks_object[peaks_methods[j]] = cpeaks.prototype[peaks_methods[j]];
                }
            }
        }
    }


    // Now we need to extract the binary data
    let offset = 4 + jsonLength;
    for(let m=0;m<all_spectra.length;m++){
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
    
        if(b_plot_initialized === false)
        {
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
            main_plot.init(cr.width, cr.height,peak_params,update_reconstructed_peaks_debounced);

            /**
             * Add first spectrum to the plot (result_spectra[0] is the first spectrum)
             * We need to make a data array of two numbers: ppm and amplitude
             */
            let data = [];
            for (let i = 0; i < all_spectra[m].n_direct; i++) {
                data.push([all_spectra[m].x_ppm_start + all_spectra[m].x_ppm_step * i + all_spectra[m].x_ppm_ref, all_spectra[m].raw_data[i]]);
            }
            main_plot.add_data(data,all_spectra[m].spectrum_index,all_spectra[m].spectrum_color);

            plot_div_resize_observer.observe(document.getElementById("plot_1d")); 
        }
        else
        {
            let data = [];
            for (let i = 0; i < all_spectra[m].n_direct; i++) {
                data.push([all_spectra[m].x_ppm_start + all_spectra[m].x_ppm_step * i + all_spectra[m].x_ppm_ref, all_spectra[m].raw_data[i]]);
            }
            main_plot.add_data(data,all_spectra[m].spectrum_index,all_spectra[m].spectrum_color);
        }
        add_to_list(m,false,false);
    }

  
};

function zoom_to_peak(index)
{
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

function get_current_peak_object(){
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
        if(tds.length < 1)
        {
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
            input.addEventListener('keydown', (e)=>{
            if (e.key === 'Enter'){
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
                if(peak_index>0){
                    peaks_object.set_column_row_value('ASS',peak_index-1,newText);
                    /**
                     * Need to ask main_plot to update as well.
                     * Because main_plot.new_peaks is a copy of peaks_object
                     */
                    if(main_plot !== null)
                    {
                        main_plot.update_peak_ass_property(peak_index,newText);
                    }
                }
            }
        }
        else
        {
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
function search_peak()
{
    let input = document.getElementById("peak_search_text").value;
    let filter = input.toUpperCase();
    let table = document.getElementById("peak_table");
    let tr = table.getElementsByTagName("tr");
    let found = false;
    let index;
    for (let i = 0; i < tr.length; i++)
    {
        let td = tr[i].getElementsByTagName("td");
        if (td.length > 0)
        {
            let j;
            for(j=0;j<td.length;j++)
            {
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
            if(found)
            {
                break;
            }
        }
    }
    if(found)
    {
        scrollToTableRow('peak_table',index);
        setTimeout(function(){
            tr[index].style.backgroundColor = "";
        },5000);
        /**
         * Ask main_plot to zoom to the peak
         * Notice that index is the row index, we need to get the peak index from the table
         */
        if(index>0){
            /**
             * When user sort tables by column,
             * Row index is not the same as peak index
             * We need to get the peak index from the table
             */
            let td = tr[index].getElementsByTagName("td");
            let peak_index = parseInt(td[0].innerText);
            zoom_to_peak(peak_index-1);
        }
    }
};

function set_current_spectrum(spectrum_index)
{
    if (main_plot.current_spectrum_index >= 0 && main_plot.current_spectrum_index < all_spectra.length) {
        if (main_plot.current_spectrum_index !== spectrum_index) {
            document.getElementById("spectrum-" + main_plot.current_spectrum_index).querySelector("div").style.backgroundColor = "white";
        }
    }
    main_plot.update_current_spectrum_index(spectrum_index);
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
function permanently_apply_phase_correction()
{
    // let ndx = main_plot.current_actively_corrected_spectrum_index;
    return_data = main_plot.permanently_apply_phase_correction();
    let ndx = return_data.index;

    if ( all_spectra[ndx].fid_process_parameters !== null)
    {
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

    for(let m=0;m<all_spectra[ndx].raw_data.length;m++){
        new_raw_data[m]   =  all_spectra[ndx].raw_data[m] * Math.cos(phase_correction[m] ) + all_spectra[ndx].raw_data_i[m] * Math.sin(phase_correction[m] );
        new_raw_data_i[m] = -all_spectra[ndx].raw_data[m] * Math.sin(phase_correction[m] ) - all_spectra[ndx].raw_data_i[m] * Math.cos(phase_correction[m] );
    }

    all_spectra[ndx].raw_data = new_raw_data;
    all_spectra[ndx].raw_data_i = new_raw_data_i;

    /**
     * Clear shown phase correction in the main page.
     */
    document.getElementById("pc_left_end").textContent  = "0.0";
    document.getElementById("pc_right_end").textContent  = "0.0";
    document.getElementById("anchor").textContent  = "not set";

    /**
     * If we are in reprocessing mode (spectrum_origin >= 10000),
     * Change input field phase_correction_direct_p0 and p1 to the new values
     */
    if(current_reprocess_spectrum_index === ndx && all_spectra[ndx].fid_process_parameters !== null)
    {
        document.getElementById("phase_correction_direct_p0").value = all_spectra[ndx].fid_process_parameters.phase_correction_direct_p0.toFixed(2);
        document.getElementById("phase_correction_direct_p1").value = all_spectra[ndx].fid_process_parameters.phase_correction_direct_p1.toFixed(2);
    }
}


// Wrap the logic in an async function to use 'await'
/**
 * 
 * @param {Float32Array} data This is one 1D spectrum data, length is 65536 
 */
async function runPrediction(data) {
    // 1. Load the model
    console.log('Loading model...');
    // Use tf.loadGraphModel for SavedModel format, or tf.loadLayersModel for Keras
    const model_p0 = await tf.loadGraphModel('./saved_model_p0/model.json');
    const model_p1 = await tf.loadGraphModel('./saved_model_p1/model.json');
    console.log('Model loaded successfully!');

    // 2. Preprocess Input Data (Example)
    // Let's assume your model expects a tensor of shape [1, 224, 224, 3]
    // representing a single normalized image.
    // NOTE: This is a placeholder! You must replace this with your actual input data.
    console.log('Creating input tensor...');
    // --- 1. Generate the Main Input ---
    // This creates a placeholder tensor with random data.
    // In your real application, you would replace this with your actual 1D array data.
    const data_length = data.length; // Should be 65536
    const mainTensor = tf.tensor(data).reshape([1, data_length, 1]);

    // --- 2. Generate the Mask Input ---
    // This creates a tensor of shape [1, 512] filled with the value 1.0.
    const mask_length = data_length/128; // Example length, replace with actual if different
    const maskTensor = tf.ones([1, mask_length],'bool');


    const inputs = {
        'main_input': mainTensor,
        'mask_input': maskTensor
        };

    // 3. Run the prediction with the input object
    console.log('Running prediction with named inputs...');
    const prediction_p0 = model_p0.predict(inputs);
    const prediction_p1 = model_p1.predict(inputs);

    // The output 'prediction' is a tensor.

    // 4. Process Output
    console.log('Processing output...');
    // Use .dataSync() or .data() (async) to get the raw values from the tensor
    const outputData_p0 = prediction_p0.dataSync();
    const outputData_p1 = prediction_p1.dataSync();

    const probabilities_p0 = Array.from(outputData_p0);
    const probabilities_p1 = Array.from(outputData_p1);

    console.log(`Prediction finished.`);
    console.log('Output Probabilities P0:', probabilities_p0);
    console.log('Output Probabilities P1:', probabilities_p1);

    // Clean up memory by disposing of the tensors
    mainTensor.dispose();
    maskTensor.dispose();
    prediction_p0.dispose();
    prediction_p1.dispose();
}