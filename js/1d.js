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

var webassembly_1d_worker;

try {
    webassembly_1d_worker = new Worker('./js/webass1d.js');
}
catch (err) {
    console.log(err);
    if (typeof (webassembly_1d_worker) === "undefined" )
    {
        alert("Failed to load WebWorker, probably due to browser incompatibility. Please use a modern browser, if you run this program locally, please read the instructions titled 'How to run COLMAR Viewer locally'");
    }
}


var main_plot = null; //hsqc plot object
var b_plot_initialized = false; //flag to indicate if the plot is initialized
var tooldiv; //tooltip div (used by myplot1_new.js, this is not a good practice, but it is a quick fix)
var current_spectrum_index_of_peaks = -1; //index of the spectrum that is currently showing peaks, -1 means none, -2 means pseudo 3D fitted peaks
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
 * direct_p0, direct_p1, indirect_p0, indirect_p1
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
                    if(this.querySelector('input[type="file"]').files[ii].name.endsWith(".ft1") )
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

});



webassembly_1d_worker.onmessage = function (e) {

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
    else if (e.data.webassembly_job === "peak_picker") {
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
        let result_spectrum_name = "recon-".concat(e.data.spectrum_origin.toString(), ".ft1");
        let result_spectrum = new spectrum_1d();
        result_spectrum.process_ft_file(arrayBuffer,result_spectrum_name,e.data.spectrum_origin);

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

        /**
         * Also copy scale and scale2 from the original spectrum, which are used to run deep picker and peak fitting
         */
        result_spectrum.scale = e.data.scale;
        result_spectrum.scale2 = e.data.scale2;

        all_spectra.push(result_spectrum);

        /**
         * Clear the processing message
         */
        document.getElementById("webassembly_message").innerText = "";

        /**
         * At this moment, add recon.js to the plot
         */
        let recon_peaks = JSON.parse(e.data.recon_json);
        let peaks_center = get_center(recon_peaks.peaks_recon);
        main_plot.show_recon(recon_peaks.spectrum_recon, recon_peaks.peaks_recon, recon_peaks.peak_params, peaks_center);


    }


    else{
        console.log(e.data);
    }
};

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
        all_spectra[index].visible = false;

        /**
         * Loop all spectra, find children of this spectrum, hide them too
         */
        for(let i=0;i<all_spectra.length;i++)
        {
            if(all_spectra[i].spectrum_origin === index)
            {
                all_spectra[i].visible = false;
            }
        }
    }
    else
    {
        minimize_button.innerText = "-";
        spectrum_div.style.height = "auto";
        all_spectra[index].visible = true;

        /**
         * Loop all spectra, find children of this spectrum, show them too
         */
        for(let i=0;i<all_spectra.length;i++)
        {
            if(all_spectra[i].spectrum_origin === index)
            {
                all_spectra[i].visible = true;
            }
        }
    }
    main_plot.redraw_contour();
    main_plot.redraw_1d();
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
        let span_for_index = document.createElement("span");
        let original_index_node = document.createTextNode("Original index: ".concat(index.toString(), ", "));
        span_for_index.appendChild(original_index_node);
        new_spectrum_div.appendChild(span_for_index);
        /**
         * make this one the default selected spectrum
         */
        if (main_plot.current_spectral_index >= 0 && main_plot.current_spectral_index < all_spectra.length) {

            let current_spectrum_div = document.getElementById("spectrum-".concat(main_plot.current_spectral_index));
            if (current_spectrum_div) {
                current_spectrum_div.querySelector("div").style.backgroundColor = "white";
            }
        }
        main_plot.current_spectral_index = index;
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
            if(all_spectra[index].raw_data_ri.length > 0 && all_spectra[index].raw_data_ir.length > 0 && all_spectra[index].raw_data_ii.length > 0 && all_spectra[index].spectrum_origin === -1)
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

    /**
     * Add a download button to download the fitted peaks.
     * Disabled (enabled) if all_spectra[index].fitted_peaks_object is empty (not empty)
     */
    let download_fitted_peaks_button = document.createElement("button");
    download_fitted_peaks_button.innerText = "Download fitted peaks";
    download_fitted_peaks_button.setAttribute("id", "download_fitted_peaks-".concat(index));
    download_fitted_peaks_button.onclick = function () { download_peaks(index,'fitted'); };
    new_spectrum_div.appendChild(download_fitted_peaks_button);

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

    /**
     * Disable the download or show picked or fitted peaks buttons, depending on the state of the picked or fitted peaks
     */
    if(all_spectra[index].picked_peaks_object === null || all_spectra[index].picked_peaks_object.column_headers.length === 0)
    {
        show_peaks_checkbox.disabled = true;
        download_peaks_button.disabled = true;
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

    /**
     * Add a new line
    */
    new_spectrum_div.appendChild(document.createElement("br"));  
    

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
    contour_color_input.setAttribute("value", new_spectrum.spectrum_color);
    contour_color_input.setAttribute("id", "contour_color-".concat(index));
    contour_color_input.addEventListener("change", (e) => { update_contour_color(e, index, 0); });
    new_spectrum_div.appendChild(contour_color_label);
    new_spectrum_div.appendChild(contour_color_input);

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
        /**
         * If we have 2 or more experimental spectra, we enable the run_Voigt_fitter button
         */
        if(total_number_of_experimental_spectra >= 2)
        {
            document.getElementById("button_run_pseudo3d_gaussian").disabled = false;
            document.getElementById("button_run_pseudo3d_voigt").disabled = false;
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

        all_spectra[index].update_x_ppm_ref(new_ref);
        /**
         * spectral_information is required to redraw the contour plot by myplot_webgl.js
         */
        main_plot.spectral_information[index].x_ppm_ref = new_ref;
    }
    else if (flag === 1) {
        let new_ref = parseFloat(document.getElementById("ref2".concat("-").concat(index)).value);
        
        all_spectra[index].update_y_ppm_ref(new_ref);
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
        n_direct: all_spectra[index].n_direct,
        n_indirect: all_spectra[index].n_indirect,
        spectrum_type: "partial",
        spectrum_index: index,
        spectrum_origin: all_spectra[index].spectrum_origin,
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
        all_spectra[index].levels.unshift(current_level);

        spectrum_information.levels = [current_level];

        /**
         * Update slider.
         */
        document.getElementById("contour-slider-".concat(index)).max = all_spectra[index].levels.length;
        document.getElementById("contour-slider-".concat(index)).value = 1;
        document.getElementById("contour_level-".concat(index)).innerText = all_spectra[index].levels[0].toExponential(4);
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
        all_spectra[index].negative_levels.unshift(current_level);

        spectrum_information.levels = [current_level];

        /**
         * Update slider.
         */
        document.getElementById("contour-slider_negative-".concat(index)).max = all_spectra[index].negative_levels.length;
        document.getElementById("contour-slider_negative-".concat(index)).value = 1;
        document.getElementById("contour_level_negative-".concat(index)).innerText = all_spectra[index].negative_levels[0].toExponential(4);
    }


}

/**
 * Called on button to update logarithmic scale contour
 */
function update_contour0_or_logarithmic_scale(index,flag) {

    let hsqc_spectrum = all_spectra[index]; 

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
        all_spectra[index].positive_contour_type = "logarithmic";
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
        all_spectra[index].negative_contour_type = "logarithmic";
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



}


/**
 * Called on button to update linear scale contour
 * @param {int} index index of the spectrum
 * @param {int} flag 0 for positive contour, 1 for negative contour
 */
function update_linear_scale(index,flag) {

    let hsqc_spectrum = all_spectra[index];

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
        all_spectra[index].positive_contour_type = "linear";
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
        all_spectra[index].negative_contour_type = "linear";
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
        document.getElementById("contour_level-".concat(index)).innerText = all_spectra[index].levels[level - 1].toExponential(4);

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
            let level = all_spectra[index].levels[main_plot.contour_lbs[index]];
            main_plot.set_peak_level(level);
            main_plot.redraw_peaks();
        }

    }
    else if(flag === 'negative')
    {
        /**
         * Update text of corresponding contour_level
         */
        document.getElementById("contour_level_negative-".concat(index)).innerText = all_spectra[index].levels[level - 1].toExponential(4);

        /**
         * Update the current lowest shown level in main_plot
         */
        main_plot.contour_lbs_negative[index] = level - 1;
        /**
         * Update peaks only if current index is the same as current spectrum index of peaks
         * and current spectrum has picked peaks and is visible
         */
        if(current_spectrum_index_of_peaks === index )
        {
            let level_negative = all_spectra[index].negative_levels[main_plot.contour_lbs_negative[index]];
            main_plot.set_peak_level_negative(level_negative);
            main_plot.redraw_peaks();
        }
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
        all_spectra[index].spectrum_color = color;
        main_plot.colors[index] = hexToRgb(color);
    }
    else if(flag==1)
    {
        all_spectra[index].spectrum_color_negative = color;
        main_plot.colors_negative[index] = hexToRgb(color);
    }
    
    /**
     * Update the color of the contour plot
     */
    
    main_plot.redraw_contour();
    main_plot.redraw_1d();
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
        filename = all_spectra[index].filename;
        /**
         * if filename has no extension, add .ft2
         */
        if (!filename.match(/\.\w+$/)) {
            filename += ".ft2";
        }
        /**
         * If extension is not ft2, replace it with .ft2
         */
        else if( !filename.toLowerCase().endsWith('.ft2')) {
            filename = filename.replace(/\.\w+$/, ".ft2");
        }
        

        /**
         * generate a blob, which is all_spectra[index].header + all_spectra[index].raw_data
         * case 1: both are real
         */
        if(all_spectra[index].datatype_direct === 1 && all_spectra[index].datatype_indirect === 1)
        {
            data = Float32Concat(all_spectra[index].header, all_spectra[index].raw_data);
        }
        /**
         * One or two dimension(s) are complex
         */
        else
        {   
            let n_size = all_spectra[index].n_direct * all_spectra[index].n_indirect;
            if(all_spectra[index].datatype_direct === 0 && all_spectra[index].datatype_indirect === 0)
            {
                n_size *= 4;
            }
            else if(all_spectra[index].datatype_direct === 0 || all_spectra[index].datatype_indirect === 0)
            {
                n_size *= 2;
            }

            data = new Float32Array(512 + n_size);
            let current_position = 0;
            data.set(all_spectra[index].header, current_position);
            current_position += 512;
            for(let i=0;i<all_spectra[index].n_indirect;i++)
            {
                data.set(all_spectra[index].raw_data.subarray(i*all_spectra[index].n_direct,(i+1)*all_spectra[index].n_direct), current_position);
                current_position += all_spectra[index].n_direct;

                if(all_spectra[index].datatype_direct === 0)
                {
                    data.set(all_spectra[index].raw_data_ri.subarray(i*all_spectra[index].n_direct,(i+1)*all_spectra[index].n_direct), current_position);
                    current_position += all_spectra[index].n_direct;
                }
                if(all_spectra[index].datatype_indirect === 0)
                {
                    data.set(all_spectra[index].raw_data_ir.subarray(i*all_spectra[index].n_direct,(i+1)*all_spectra[index].n_direct), current_position);
                    current_position += all_spectra[index].n_direct;
                }
                if(all_spectra[index].datatype_direct === 0 && all_spectra[index].datatype_indirect === 0)
                {
                    data.set(all_spectra[index].raw_data_ii.subarray(i*all_spectra[index].n_direct,(i+1)*all_spectra[index].n_direct), current_position);
                    current_position += all_spectra[index].n_direct;
                }
            }
        }
    }
    else if(flag==='diff')
    {   
        /**
         * Replace recon with diff in the filename, if not found, add diff- to the filename at the beginning
         */
        filename = all_spectra[index].filename.replace('recon','diff');
        if(filename === all_spectra[index].filename)
        {
            filename = 'diff-'.concat(all_spectra[index].filename);
        }

        /**
         * Get the original spectrum index
         */
        let spectrum_origin = all_spectra[index].spectrum_origin;
        /**
         * Calcualte difference spectrum, which is all_spectra[index].raw_data - all_spectra[spectrum_origin].raw_data
         */
        let diff_data = new Float32Array(all_spectra[index].raw_data.length);
        for(let i=0;i<all_spectra[index].raw_data.length;i++)
        {
            diff_data[i] = all_spectra[index].raw_data[i] - all_spectra[spectrum_origin].raw_data[i];
        }
        /**
         * generate a blob, which is all_spectra[index].header + diff_data
         * First, make a copy of the header and then concatenate with diff_data
         */
        let header = new Float32Array(all_spectra[index].header);
        /**
         * Set datatype to 1, since the difference spectrum is always real
         */
        header[55] = 1.0;
        header[56] = 1.0;
        header[219] = all_spectra[index].n_direct;
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
 * Add a new spectrum_1d to the list and update the contour plot. When contour is updated, add_to_list() is called to update the list of spectra
 * in the uses interface
 * @param {*} result_spectra: an array of object of hsqc_spectrum
 * @param {*} b_from_fid: boolean, whether the spectrum is from a fid file
 * @param {*} b_reprocess: boolean, whether this is a new spectrum_1d or a reprocessed spectrum
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
         * It is also possible this is a reconstructed spectrum from peak fitting
         */
        spectrum_index = all_spectra.length;
        result_spectra[0].spectrum_index = spectrum_index;
        result_spectra[0].spectrum_color = rgbToHex(color_list[(spectrum_index*2) % color_list.length]);
        result_spectra[0].spectrum_color_negative =  rgbToHex(color_list[(spectrum_index*2+1) % color_list.length]);
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
            result_spectra[i].spectrum_color = rgbToHex(color_list[(result_spectra[i].spectrum_index*2) % color_list.length]);
            result_spectra[i].spectrum_color_negative =  rgbToHex(color_list[(result_spectra[i].spectrum_index*2+1) % color_list.length]);

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
                all_spectra[first_spectrum_index].pseudo3d_children.push(result_spectra[i].spectrum_index);
            }

            all_spectra.push(result_spectra[i]);
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
        result_spectra[0].spectrum_color = rgbToHex(color_list[(spectrum_index*2) % color_list.length]);
        result_spectra[0].spectrum_color_negative =  rgbToHex(color_list[(spectrum_index*2+1) % color_list.length]);
        all_spectra[spectrum_index] = result_spectra[0];

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
                result_spectra[i].spectrum_color = all_spectra[new_spectrum_index].spectrum_color;
                result_spectra[i].spectrum_color_negative = all_spectra[new_spectrum_index].spectrum_color_negative;
                all_spectra[new_spectrum_index] = result_spectra[i];
            }
        }
        else if(pseudo3d_children.length === 0 && result_spectra.length > 1)
        {
            /**
             * Reprocessed all spectra, and previously only processed the first spectrum
             */
            for(let i=1;i<result_spectra.length;i++)
            {
                const new_spectrum_index = all_spectra.length;
                result_spectra[i].spectrum_index = new_spectrum_index;
                result_spectra[i].spectrum_color = rgbToHex(color_list[(new_spectrum_index*2) % color_list.length]);
                result_spectra[i].spectrum_color_negative = rgbToHex(color_list[(new_spectrum_index*2+1) % color_list.length]);
                result_spectra[i].spectrum_origin = 10000 + spectrum_index;
                all_spectra[spectrum_index].pseudo3d_children.push(new_spectrum_index);
                all_spectra.push(result_spectra[i]);
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
    if(b_plot_initialized === false)
    {
        b_plot_initialized = true;
        main_plot = new myplot_1d(); //the plot object
        document.getElementById("plot_1d").style.display = "block"; //show the plot
        document.getElementById("plot_1d").style.width = "1200px";
        document.getElementById("plot_1d").style.height = "800px";
        const cr = document.getElementById("plot_1d").getBoundingClientRect();
        main_plot.init(cr.width, cr.height, result_spectra[0]);
        plot_div_resize_observer.observe(document.getElementById("plot_1d")); 
    }

    add_to_list(0,b_from_fid,b_reprocess);

    for(let i=0;i<result_spectra.length;i++)
    {
    
        /**
         * Positive contour calculation for the spectrum
         */
        let spectrum_information = {
            n_direct: result_spectra[i].n_direct,
            spectrum_index: result_spectra[i].spectrum_index,
            spectrum_origin: result_spectra[i].spectrum_origin,
        };

        /**
         * Add the spectrum to the 1d plot
         */
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
 * Disable or enable buttons for download_fitted_peaks and show_fitted_peaks
 */
function disable_enable_fitted_peak_buttons(spectrum_index,flag)
{
    if(flag==0)
    {
        document.getElementById("download_fitted_peaks-".concat(spectrum_index)).disabled = true;
        document.getElementById("show_fitted_peaks-".concat(spectrum_index)).disabled = true;   
        document.getElementById("show_fitted_peaks-".concat(spectrum_index)).checked = false;
    }
    else if(flag==1)
    {
        document.getElementById("download_fitted_peaks-".concat(spectrum_index)).disabled = false;
        document.getElementById("show_fitted_peaks-".concat(spectrum_index)).disabled = false;
        /**
         * Enable run deep picker and run voigt fitter buttons (allow run again)
         */
        document.getElementById("run_load_peak_list-".concat(spectrum_index)).disabled = false;
        document.getElementById("run_deep_picker-".concat(spectrum_index)).disabled = false;
        document.getElementById("run_voigt_fitter-".concat(spectrum_index)).disabled = false;
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
     * Convert to Uint8Array to be transferred to the worker
     */
    let data_uint8 = new Uint8Array(data.buffer);

    /**
     * Get noise_level of the spectrum
     * And current lowest contour level of the spectrum
     * Calculate scale as lowest contour level / noise_level
     * and scale2 as 0.6 * scale
     */
    let noise_level = all_spectra[spectrum_index].noise_level;
    let scale = 5.5;
    let scale2 = 0.6 * scale;
    let maxround = 10;

   
    /**
     * Add title to textarea "log"
     */
    webassembly_1d_worker.postMessage({
        webassembly_job: "peak_picker",
        spectrum_data: data_uint8,
        spectrum_index: spectrum_index,
        scale: scale,
        scale2: scale2,
        noise_level: noise_level,
        maxround: maxround,
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
     * Combine all_spectra[spectrum_index].raw_data and all_spectra[spectrum_index].header into one Float32Array
     * Need to copy the header first, modify complex flag (doesn't hurt even when not necessary), then concatenate with raw_data
     */
    let header = new Float32Array(all_spectra[spectrum_index].header);
    header[55] = 1.0;
    header[56] = 1.0;
    header[219] = all_spectra[spectrum_index].n_indirect; //size of indirect dimension of the input spectrum
    header[99] = all_spectra[spectrum_index].n_direct; //size of direct dimension of the input spectrum
    /**
     * Also set 
     */
    let data = Float32Concat(header, all_spectra[spectrum_index].raw_data);
    /**
     * Convert to Uint8Array to be transferred to the worker
     */
    let data_uint8 = new Uint8Array(data.buffer);

    webassembly_1d_worker.postMessage({
        webassembly_job: "peak_fitter",
        spectrum_data: data_uint8,
        picked_peaks: picked_peaks_copy_tab,
        spectrum_index: spectrum_index,
        noise_level: all_spectra[spectrum_index].noise_level,
        maxround: maxround,
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
    for(let i=0;i<all_spectra.length;i++)
    {
        if(i!==index)
        {
            /**
             * If spectrum is deleted, these checkboxes are no longer available.
             * So we need to check if they are available
             */
            if(all_spectra[i].spectrum_origin !== -3)
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

    if(b_show)
    {
        current_spectrum_index_of_peaks = index;
        set_current_spectrum(index);
        current_flag_of_peaks = flag;
        show_peak_table();
        main_plot.remove_peaks();

        if(flag === 'picked')
        {
            /**
             * Only for picked peaks of an experimental spectrum, allow user to make changes
             */
            if(all_spectra[index].spectrum_origin === -1 || all_spectra[index].spectrum_origin === -2 || all_spectra[index].spectrum_origin >=10000)
            {
                document.getElementById("allow_brush_to_remove").disabled = false;
                document.getElementById("allow_drag_and_drop").disabled = false;
                document.getElementById("allow_click_to_add_peak").disabled = false;
            }
            main_plot.add_peaks(all_spectra[index].picked_peaks_object,all_spectra[index].spectral_max);
        }
        else
        {
            main_plot.add_peaks(all_spectra[index].fitted_peaks_object,all_spectra[index].spectral_max);
        }
    }
    else
    {
        current_spectrum_index_of_peaks = -1; // -1 means no spectrum is selected. flag is not important
        main_plot.remove_peaks();
        remove_peak_table();
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
    let dosy_gradient_weight_text = document.getElementById("dosy_gradient_weight").value;
    let dosy_rescale = parseFloat(document.getElementById("dosy_rescale").value);
    let gradients = dosy_gradient_text.trim().split(/\s+/).map(Number).filter(function (value) { return !isNaN(value); });
    let weights = dosy_gradient_weight_text.trim().split(/\s+/).map(Number).filter(function (value) { return !isNaN(value); });

    /**
     * If size of gradients !== # of Z_A* field of pseudo3d_fitted_peaks_object
     */
    if(gradients.length !== pseudo3d_fitted_peaks_object.column_headers.filter(function(header) {
        return header.startsWith('Z_A') && !header.endsWith('_STD');
    }).length)
    {
        alert("Number of gradients must be equal to number of Z_A* fields in the peak list");
        return;
    }

    let dosy_result = pseudo3d_fitted_peaks_object.run_dosy_fitting(gradients,weights,dosy_rescale);   

    /**
     * If pseudo2d_fitted_peaks_error is not empty, run dosy on them as well
     */
    if(typeof pseudo2d_fitted_peaks_error !== 'undefined' && pseudo2d_fitted_peaks_error.length !== 0)
    {
        for(let i=0;i<pseudo2d_fitted_peaks_error.length;i++)
        {
            pseudo2d_fitted_peaks_error[i].run_dosy_fitting(gradients,weights,dosy_rescale);
        }
    }

    /**
     * Run error estimation on pseudo2d_fitted_peaks_error (calcualte RMSD of selected columns from pseudo2d_fitted_peaks_error)
     * Pre-step: Add Z_A1, Z_A2, Z_A3, upto Z_A{n} to pseudo2d_fitted_peaks_error, where n is the number of gradients - 1
     * then add DOSY column to the end
     */
    let selected_columns = [];
    for(let i=1;i<gradients.length;i++)
    {
        selected_columns.push('Z_A'+i);
    }
    selected_columns.push('DOSY');

    dosy_error_est = new cpeaks();
    dosy_error_est.error_estimate(pseudo2d_fitted_peaks_error,selected_columns);

    /**
     * Attach the error estimation to the pseudo3d_fitted_peaks_object.
     * But first, remove previous _STD columns
     */
    pseudo3d_fitted_peaks_object.remove_error_columns();
    pseudo3d_fitted_peaks_object.append_columns(dosy_error_est);

    /**
     * Let user know DOSY result is ready
     */
    document.getElementById("dosy_result").textContent = dosy_result.message;
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
         * Set all_spectra[spectrum_index] as the current spectrum
         */
        document.getElementById("spectrum-" + spectrum_index).querySelector("div").style.backgroundColor = "lightblue";
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
        set_fid_parameters(all_spectra[spectrum_index].fid_process_parameters);
        
        /**
         * Switch to cross section mode for current spectrum by simulating a click event
         */
        current_reprocess_spectrum_index = spectrum_index;
        set_current_spectrum(spectrum_index);


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
     * Step 1, prepare the json data. Convert all_spectra to a hsqc_spectra_copy
     * where in each spectrum object, we call create_shallow_copy_wo_float32 to have a shallow (modified) copy of the spectrum
     */
    let hsqc_spectra_copy = [];
    for(let i=0;i<all_spectra.length;i++)
    {
        let spectrum_copy = all_spectra[i].create_shallow_copy_wo_float32();
        hsqc_spectra_copy.push(spectrum_copy);
    }

    let to_save = {
        all_spectra: hsqc_spectra_copy,
        pseudo3d_fitted_peaks_object: pseudo3d_fitted_peaks_object,
        pseudo2d_fitted_peaks_error: pseudo2d_fitted_peaks_error,
    };

    /**
     * Step 2, prepare the binaryData, which is a concatenation of all 
     *  header, raw_data, raw_data_ri, raw_data_ir, raw_data_ii in all all_spectra elements
     */
    let totalLength = 0;
    for(let i=0;i<all_spectra.length;i++){
        totalLength += all_spectra[i].header.length + all_spectra[i].raw_data.length + all_spectra[i].raw_data_ri.length + all_spectra[i].raw_data_ir.length + all_spectra[i].raw_data_ii.length;
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

    combinedView.set(new Uint8Array(lengthBuffer), 0);
    combinedView.set(jsonBytes, 4);
    /**
     * Step 3, copy all binary data into combinedView
     */
    let offset = 4 + jsonLength;
    for(let i=0;i<all_spectra.length;i++){
        combinedView.set(new Uint8Array(all_spectra[i].header.buffer), offset);
        console.log('set header at offset ' + offset);
        console.log(all_spectra[i].header);
        offset += all_spectra[i].header.length * Float32Array.BYTES_PER_ELEMENT;
        combinedView.set(new Uint8Array(all_spectra[i].raw_data.buffer), offset);
        offset += all_spectra[i].raw_data.length * Float32Array.BYTES_PER_ELEMENT;
        combinedView.set(new Uint8Array(all_spectra[i].raw_data_ri.buffer), offset);
        offset += all_spectra[i].raw_data_ri.length * Float32Array.BYTES_PER_ELEMENT;
        combinedView.set(new Uint8Array(all_spectra[i].raw_data_ir.buffer), offset);
        offset += all_spectra[i].raw_data_ir.length * Float32Array.BYTES_PER_ELEMENT;
        combinedView.set(new Uint8Array(all_spectra[i].raw_data_ii.buffer), offset);
        offset += all_spectra[i].raw_data_ii.length * Float32Array.BYTES_PER_ELEMENT;
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
 * Async function to load all_spectra from a file
 */
async function loadBinaryAndJsonWithLength(arrayBuffer) {
    
    const uint8Array = new Uint8Array(arrayBuffer);

    // Read the length of the JSON data (first 4 bytes)
    const jsonLength = new DataView(arrayBuffer).getInt32(0, true); // true for little-endian

    // Extract the JSON data
    const jsonBytes = uint8Array.slice(4, 4 + jsonLength);
    const jsonString = new TextDecoder().decode(jsonBytes);
    let to_save = JSON.parse(jsonString);

    all_spectra = to_save.all_spectra;
    pseudo3d_fitted_peaks_object = to_save.pseudo3d_fitted_peaks_object;
    if(typeof to_save.pseudo2d_fitted_peaks_error === 'undefined')
    {
        pseudo2d_fitted_peaks_error = [];   
    }
    else
    {
        pseudo2d_fitted_peaks_error = to_save.pseudo2d_fitted_peaks_error;
    }

    /**
     * Reattach methods defined in spectrum.js to all all_spectra objects
     */
    for(let i=0;i<all_spectra.length;i++)
    {
        /**
         * Loop all methods of class spectrum and attach them to the all_spectra[i] object
         */
        let spectrum_methods = Object.getOwnPropertyNames(spectrum.prototype);
        for(let j=0;j<spectrum_methods.length;j++)
        {
            if(spectrum_methods[j] !== 'constructor')
            {
                all_spectra[i][spectrum_methods[j]] = spectrum.prototype[spectrum_methods[j]];
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

    /**
     * If pseudo3d_fitted_peaks_object is not null, we need to reattach methods as well
     */
    if(pseudo3d_fitted_peaks_object !== null )
    {
        let peaks_methods = Object.getOwnPropertyNames(cpeaks.prototype);
        for(let j=0;j<peaks_methods.length;j++)
        {
            if(peaks_methods[j] !== 'constructor')
            {
                pseudo3d_fitted_peaks_object[peaks_methods[j]] = cpeaks.prototype[peaks_methods[j]];
                if(typeof pseudo2d_fitted_peaks_error !== 'undefined' && pseudo2d_fitted_peaks_error !== null)
                {
                    for(let i=0;i<pseudo2d_fitted_peaks_error.length;i++)
                    {
                        pseudo2d_fitted_peaks_error[i][peaks_methods[j]] = cpeaks.prototype[peaks_methods[j]];
                    }
                }
            }
        }
    }

    /**
     * Because we will re-calculate contour plot, we reset all visible to true
     */
    for(let i=0;i<all_spectra.length;i++)
    {
        all_spectra[i].visible = true;
    }

    // Now we need to extract the binary data
    let offset = 4 + jsonLength;
    for(let i=0;i<all_spectra.length;i++){
        all_spectra[i].header = new Float32Array(arrayBuffer.slice(offset, offset + all_spectra[i].header_length * Float32Array.BYTES_PER_ELEMENT));
        console.log('load header at offset ' + offset);
        console.log(all_spectra[i].header);
        offset += all_spectra[i].header_length * Float32Array.BYTES_PER_ELEMENT;
        
        all_spectra[i].raw_data = new Float32Array(arrayBuffer.slice(offset, offset + all_spectra[i].raw_data_length * Float32Array.BYTES_PER_ELEMENT));
        offset += all_spectra[i].raw_data_length * Float32Array.BYTES_PER_ELEMENT;

        all_spectra[i].raw_data_ri = new Float32Array(arrayBuffer.slice(offset, offset + all_spectra[i].raw_data_ri_length * Float32Array.BYTES_PER_ELEMENT));
        offset += all_spectra[i].raw_data_ri_length * Float32Array.BYTES_PER_ELEMENT;

        all_spectra[i].raw_data_ir = new Float32Array(arrayBuffer.slice(offset, offset + all_spectra[i].raw_data_ir_length * Float32Array.BYTES_PER_ELEMENT));
        offset += all_spectra[i].raw_data_ir_length * Float32Array.BYTES_PER_ELEMENT;

        all_spectra[i].raw_data_ii = new Float32Array(arrayBuffer.slice(offset, offset + all_spectra[i].raw_data_ii_length * Float32Array.BYTES_PER_ELEMENT));
        offset += all_spectra[i].raw_data_ii_length * Float32Array.BYTES_PER_ELEMENT;
    }
    draw_spectrum_from_loading();
    /**
     * process pseudo-3D buttons and dosy information
     */
    if(pseudo3d_fitted_peaks_object !== null)
    {
        if(pseudo3d_fitted_peaks_object.gradients !== null)
        {
            document.getElementById("dosy_gradient").value = pseudo3d_fitted_peaks_object.gradients.join(' ');
            document.getElementById("dosy_rescale").value = pseudo3d_fitted_peaks_object.scale_constant;
            document.getElementById("dosy_result").textContent = "Dosy result is available";
        }
        document.getElementById("button_download_fitted_peaks").disabled = false;
        document.getElementById("show_pseudo3d_peaks").disabled = false;
    }
};

function zoom_to_peak(index)
{
    let peaks_object = get_current_peak_object();

    /**
     * Get the peak position (column X_PPM and Y_PPM)
     */
    let x_ppm = peaks_object.get_column_by_header('X_PPM')[index];
    let y_ppm = peaks_object.get_column_by_header('Y_PPM')[index];

    let x_ppm_scale = [x_ppm + 0.5, x_ppm - 0.5];
    let y_ppm_scale = [y_ppm + 5, y_ppm - 5];

    main_plot.zoom_to(x_ppm_scale, y_ppm_scale);

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
    if (main_plot.current_spectral_index >= 0 && main_plot.current_spectral_index < all_spectra.length) {
        if (main_plot.current_spectral_index !== spectrum_index) {
            document.getElementById("spectrum-" + main_plot.current_spectral_index).querySelector("div").style.backgroundColor = "white";
        }
    }
    main_plot.current_spectral_index = spectrum_index;
    document.getElementById("spectrum-" + spectrum_index).querySelector("div").style.backgroundColor = "lightblue";
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