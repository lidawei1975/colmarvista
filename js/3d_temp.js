
/**
 * Global variables required by myplot1_new.js and others
 */
var hsqc_spectra = []; // Defines the current slice being displayed (length 1)
var spectra_3d = [];   // Stores all loaded 3D planes (spectrum objects)
var main_plot = null;
var my_contour_worker = null;
var tooldiv = document.getElementById("information_bar");
var zoom_on_call_function = null;
var current_reprocess_spectrum_index = -1; // Not used but required by global var comment in myplot1_new.js
var current_slice_index = -1;

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
});


/**
 * Handle messages from the contour worker
 */
function handle_worker_message(e) {
    if (e.data.message) {
        document.getElementById("contour_message").innerText = e.data.message;
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

        let slice_idx = e.data.spectrum_index; // We passed slice index as spectrum_index

        if (slice_idx < 0 || slice_idx >= spectra_3d.length) return;

        let spec = spectra_3d[slice_idx];

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
            refresh_current_view();
        }

        document.getElementById("contour_message").innerText = "";
    }
}

function handle_ortho_response(data, type) {
    let spec = (type === "xz") ? spectrum_xz : spectrum_yz;
    if (!spec) return;

    if (data.contour_sign === 0) {
        spec.cached_contour_pos = data;
    } else {
        spec.cached_contour_neg = data;
    }

    // Refresh the ortho view if we have data
    // We can do it immediately or wait for both? 
    // refresh_ortho_plot can handle partial data
    refresh_ortho_plot(type);
}

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

        // Assuming plotit allows setting xscale/yscale manually or via zoom().
    }
}

async function load_files() {
    let fileInput = document.getElementById('userfile');
    let files = Array.from(fileInput.files);

    if (files.length === 0) {
        alert("Please select at least one .ft2 file.");
        return;
    }

    document.getElementById("webassembly_message").innerText = "Loading and sorting " + files.length + " files...";

    // Reset state
    spectra_3d = [];
    hsqc_spectra = [];
    current_slice_index = -1;

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
            s.spectrum_color = "#ff0000"; // Red for positive
            s.spectrum_color_negative = "#0000ff"; // Blue for negative
            s.levels = calculate_levels(s.noise_level, 1.5, 30); // Default levels
            s.negative_levels = calculate_levels(s.noise_level, 1.5, 30);
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
        document.getElementById('spectra_list').style.display = 'block'; // Or hide if not needed
        document.getElementById('main_plot_area').style.display = 'flex';

        // Initialize the main plot now that we have data dimensions from the first slice
        init_main_plot(spectra_3d[0]);

        // Draw first slice
        draw_slice(0);
    }

    document.getElementById("webassembly_message").innerText = "";
}

function read_file_as_buffer(file) {
    return new Promise((resolve, reject) => {
        let reader = new FileReader();
        reader.onload = (e) => resolve(e.target.result);
        reader.onerror = (e) => reject(e);
        reader.readAsArrayBuffer(file);
    });
}

function calculate_levels(noise, scale, count) {
    let levels = [];
    let current = noise * 5.0; // Start at 5*noise
    for (let i = 0; i < count; i++) {
        levels.push(current);
        current *= scale;
    }
    return levels;
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

function popzoom() {
    if (main_plot) {
        main_plot.popzoom();
    }
}

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
    let plot_width = cr.width - plot_margin_left - plot_margin_right;
    let plot_height = cr.height - plot_margin_top - plot_margin_bottom;

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

    // Initialize Orthogonal Plots
    init_ortho_plots(first_spectrum);
}

function draw_slice(index) {
    if (index < 0 || index >= spectra_3d.length) return;

    current_slice_index = index;
    let s = spectra_3d[index];

    // Update global hsqc_spectra (length 1)
    hsqc_spectra = [s];
    s.spectrum_index = 0; // It's always the 0-th element in this view

    // Update Info Display
    document.getElementById('slice_info').innerText = (index + 1) + " / " + spectra_3d.length;
    document.getElementById('slice_filename').innerText = s.filename || ("Slice " + index);

    // Check if we have contour data
    if (s.cached_contour_pos) {
        refresh_current_view();
    } else {
        // Clear the previous view to prevent "flashing" / ghosting
        if (main_plot && main_plot.contour_plot && main_plot.contour_plot.gl) {
            main_plot.contour_plot.gl.clearColor(1, 1, 1, 1);
            main_plot.contour_plot.gl.clear(main_plot.contour_plot.gl.COLOR_BUFFER_BIT);
        }

        // Request Worker
        request_contour_calculation(s, index, 0); // Positive
    }

    // Also request negative if not cached
    if (!s.cached_contour_neg) {
        request_contour_calculation(s, index, 1); // Negative
    }
}


function request_contour_calculation(spectrum, index, sign) {
    // Mimic the message structure expected by contour.js
    // contour.js reads: e.data.spectrum.levels, etc.

    let spec_data = {
        levels: (sign === 0) ? spectrum.levels : spectrum.negative_levels,
        n_direct: spectrum.n_direct,
        n_indirect: spectrum.n_indirect,
        contour_sign: sign,
        spectrum_type: "full",
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


function Float32Concat(first, second) {
    var firstLength = first.length,
        result = new Float32Array(firstLength + second.length);
    result.set(first);
    result.set(second, firstLength);
    return result;
}

function refresh_current_view() {
    if (!main_plot) return;

    let s = hsqc_spectra[0];
    if (!s) return;

    // Prepare arrays for set_data
    // We construct arrays of length 1 (since we only show 1 spectrum)

    let points_pos = s.cached_contour_pos ? s.cached_contour_pos.points : new Float32Array([]);
    // Ensure it's a Float32Array
    if (!(points_pos instanceof Float32Array)) {
        points_pos = new Float32Array(points_pos);
    }

    let len_pos = s.cached_contour_pos ? [s.cached_contour_pos.levels_length] : [[]]; // Array of array
    let poly_pos = s.cached_contour_pos ? [s.cached_contour_pos.polygon_length] : [[]]; // Array of array

    let points_neg = s.cached_contour_neg ? s.cached_contour_neg.points : new Float32Array([]);
    if (!(points_neg instanceof Float32Array)) {
        points_neg = new Float32Array(points_neg);
    }

    let len_neg = s.cached_contour_neg ? [s.cached_contour_neg.levels_length] : [[]];
    let poly_neg = s.cached_contour_neg ? [s.cached_contour_neg.polygon_length] : [[]];

    let color_pos = [hexToRgb(s.spectrum_color)];
    let color_neg = [hexToRgb(s.spectrum_color_negative)];

    let lbs_pos = [0]; // Show all levels starting from index 0
    let lbs_neg = [0];

    let start_pos = [0];

    // Concatenate points for single buffer requirement of myplot_webgl
    let combined_points = Float32Concat(points_pos, points_neg);

    // Negative start offset is length of positive points
    let start_neg = [points_pos.length];

    // Construct spectral_information for the plot
    // setCamera uses this (line 154 of myplot_webgl.js)
    let spectral_info = [{
        x_ppm_start: s.x_ppm_start,
        x_ppm_step: s.x_ppm_step,
        y_ppm_start: s.y_ppm_start,
        y_ppm_step: s.y_ppm_step,
        x_ppm_ref: 0, // Assume 0 if not set
        y_ppm_ref: 0
    }];

    // Set the data
    main_plot.contour_plot.spectral_order = [0]; // Should draw index 0

    main_plot.contour_plot.set_data(
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

    // Explicitly sync camera to ensuring initial view is correct (Fixes "Zoom Once" issue)
    let x_dom = main_plot.xRange.domain();
    let y_dom = main_plot.yRange.domain();
    main_plot.contour_plot.setCamera_ppm(x_dom[0], x_dom[1], y_dom[0], y_dom[1]);

    // Redraw only the WebGL scene
    main_plot.contour_plot.drawScene();
}

/**
 * Sync XZ and YZ sliders AND axes to the main XY plot
 */
function sync_sliders_to_center() {
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
        current_y_index = new_y_index;
        sl_xz.value = current_y_index;
        let ppm_y = s.y_ppm_start + (current_y_index * s.y_ppm_step);
        val_xz.innerText = ppm_y.toFixed(3) + " ppm";
        refresh_xz_view();
    }

    let sl_yz = document.getElementById("slider_yz");
    let val_yz = document.getElementById("val_yz");
    if (sl_yz && new_x_index !== current_x_index) {
        current_x_index = new_x_index;
        sl_yz.value = current_x_index;
        let ppm_x = s.x_ppm_start + (current_x_index * s.x_ppm_step);
        val_yz.innerText = ppm_x.toFixed(3) + " ppm";
        refresh_yz_view();
    }

    // Sync axes: XZ plot X-axis matches XY plot X-axis
    if (main_plot_xz) {
        main_plot_xz.xscale = [x_domain[0], x_domain[1]];
        main_plot_xz.xRange.domain(main_plot_xz.xscale);
        main_plot_xz.reset_axis();

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

    // Sync axes: YZ plot Y-axis matches XY plot Y-axis
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
}
