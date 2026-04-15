
/**
 * Global variables required by myplot1_new.js and others
 */
var hsqc_spectra = []; // Defines the current slice being displayed (length 1)
var spectra_3d = [];   // Stores all loaded 3D planes (spectrum objects)
var theoretical_spectra_3d = []; // Stores theoretical 3D volume
var theoretical_spectrum_xz = null;
var theoretical_spectrum_yz = null;
var main_plot = null;
var my_contour_worker = null;
var tooldiv = document.getElementById("information_bar");
var zoom_on_call_function = null;
var iso_renderer = null;
var iso_renderer_recon = null;

// Function to download 3D region as text
function download_region() {
    if (!spectra_3d || spectra_3d.length === 0) {
        alert("No spectra loaded.");
        return;
    }

    let s0 = spectra_3d[0];

    // Get Ranges from plots
    // XY Plot (Direct vs Indirect)
    if (!main_plot) return;
    let x_dom = main_plot.xRange.domain(); // Direct
    let y_dom = main_plot.yRange.domain(); // Indirect

    // XZ Plot (defines Z range)
    if (!main_plot_xz) {
        alert("XZ plot not initialized.");
        return;
    }
    let z_dom = main_plot_xz.yRange.domain(); // Z axis is Y-axis of XZ plot

    // Calculate Indices
    function get_indices(val_min, val_max, start, step, max_idx) {
        let idx1 = Math.round((val_min - start) / step);
        let idx2 = Math.round((val_max - start) / step);
        let i_min = Math.min(idx1, idx2);
        let i_max = Math.max(idx1, idx2);
        i_min = Math.max(0, i_min);
        i_max = Math.min(max_idx - 1, i_max);
        return [i_min, i_max];
    }

    let [ix_min, ix_max] = get_indices(x_dom[0], x_dom[1], s0.x_ppm_start, s0.x_ppm_step, s0.n_direct);
    let [iy_min, iy_max] = get_indices(y_dom[0], y_dom[1], s0.y_ppm_start, s0.y_ppm_step, s0.n_indirect);

    // For Z index, we use Z params from spectrum
    let [iz_min, iz_max] = get_indices(z_dom[0], z_dom[1], s0.z_ppm_start, s0.z_ppm_step, spectra_3d.length);

    // console.log("Download Region:", 
    //     "X:", ix_min, ix_max, 
    //     "Y:", iy_min, iy_max, 
    //     "Z:", iz_min, iz_max);

    let content = [];
    content.push(`# 3D Region Export`);
    content.push(`# Z-Slices: ${iz_min} to ${iz_max} (Indices)`);
    content.push(`# Y-Range: ${iy_min} to ${iy_max} (Indices)`);
    content.push(`# X-Range: ${ix_min} to ${ix_max} (Indices)`);
    content.push(`# Format: Matrix of size (Z_count * Y_count) rows x (X_count) columns`);
    content.push(`# Loop order: Outer Loop Z, Inner Loop Y`);

    // Header row with PPMs? Or just data?
    // User requested "human readable text file". Matrix format.

    for (let z = iz_min; z <= iz_max; z++) {
        let s = spectra_3d[z];
        if (!s || !s.raw_data) continue;

        // s.raw_data is Float32Array. 
        // Assuming row-major: index = y * n_direct + x

        for (let y = iy_min; y <= iy_max; y++) {
            let row_vals = [];
            for (let x = ix_min; x <= ix_max; x++) {
                let idx = y * s.n_direct + x;
                if (idx < s.raw_data.length) {
                    row_vals.push(s.raw_data[idx].toExponential(6));
                } else {
                    row_vals.push("0");
                }
            }
            content.push(row_vals.join(" "));
        }
    }

    let blob = new Blob([content.join("\n")], { type: "text/plain" });
    let url = URL.createObjectURL(blob);
    let a = document.createElement("a");
    a.href = url;
    a.download = "region_3d.txt";
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
}
var current_reprocess_spectrum_index = -1; // Not used but required by global var comment in myplot1_new.js
var current_slice_index = -1;

function append_3d_log(message) {
    const logElem = document.getElementById("log");
    if (!logElem) {
        return;
    }
    logElem.value += String(message) + "\n";
    logElem.scrollTop = logElem.scrollHeight;
}

function append_3d_worker_stdout(stdoutText) {
    const logElem = document.getElementById("log");
    if (!logElem) {
        return;
    }

    const text = stdoutText == null ? "" : String(stdoutText);
    logElem.value += "[worker] " + text;
    if (!text.endsWith("\n")) {
        logElem.value += "\n";
    }
    logElem.scrollTop = logElem.scrollHeight;
}

function clear_3d_log() {
    const logElem = document.getElementById("log");
    if (!logElem) {
        return;
    }
    logElem.value = "";
}

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

    let ft3Form = document.getElementById('ft3_file_form');
    if (ft3Form) {
        ft3Form.addEventListener('submit', function (e) {
            e.preventDefault();
            load_ft3_file();
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

    let file = fileInput.files[0];
    let text = await file.text();
    let lines = text.split('\n');

    let peaks = [];
    let header_map = null;
    partition_bounds_data = null; // Reset bounds

    // Parse file.
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
        if (!header_map && parts.includes("Amplitude") && parts.includes("X_Center")) {
            header_map = {};
            parts.forEach((col, idx) => {
                header_map[col] = idx;
            });
            continue;
        }

        // Skip separator lines or other header-like lines if we haven't found our map yet or if they are just separators
        if (line.startsWith("=") || line.startsWith("-")) continue;
        // Skip explicitly known header starts if we are in legacy mode check or if they are redundant
        if (line.startsWith("Rank") || line.startsWith("Peak")) continue;

        if (header_map) {
            // Dynamic parsing based on header
            let get_val = (key, default_val = 0.0) => {
                let idx = header_map[key];
                if (idx !== undefined && idx < parts.length) return parseFloat(parts[idx]);
                return default_val;
            };

            // Basic validation: Amplitude must be a number
            let amp = get_val("Amplitude");
            if (isNaN(amp)) continue;

            peaks.push({
                amp: amp,
                x: get_val("X_Center"),
                y: get_val("Y_Center"),
                z: get_val("Z_Center"),
                x_ppm: get_val("X_Center_ppm", undefined),
                y_ppm: get_val("Y_Center_ppm", undefined),
                z_ppm: get_val("Z_Center_ppm", undefined),
                fwhh_x: get_val("X_FWHH"),
                fwhh_y: get_val("Y_FWHH"),
                fwhh_z: get_val("Z_FWHH"),
                lx: get_val("Lx"),
                ly: get_val("Ly"),
                lz: get_val("Lz")
            });
        } else {
            // Legacy format: ID Amp X Y Z X_FWHH Y_FWHH Z_FWHH Lx Ly Lz
            // 11 columns expected.
            if (parts.length >= 11) {
                // Ensure it's data by checking if ID (0) or Amp (1) is a number
                if (isNaN(parseFloat(parts[1]))) continue;

                peaks.push({
                    amp: parseFloat(parts[1]),
                    x: parseFloat(parts[2]),
                    y: parseFloat(parts[3]),
                    z: parseFloat(parts[4]),
                    x_ppm: undefined,
                    y_ppm: undefined,
                    z_ppm: undefined,
                    fwhh_x: parseFloat(parts[5]),
                    fwhh_y: parseFloat(parts[6]),
                    fwhh_z: parseFloat(parts[7]),
                    lx: parseFloat(parts[8]),
                    ly: parseFloat(parts[9]),
                    lz: parseFloat(parts[10])
                });
            }
        }
    }

    if (peaks.length === 0) {
        alert("No valid peaks found in file.");
        return;
    }

    console.log("Loaded " + peaks.length + " theoretical peaks (Pseudo-Voigt).");
    theoretical_peaks_data = peaks;
    generate_theoretical_volume(peaks);

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
}

function generate_theoretical_volume(peaks) {
    if (!spectra_3d || spectra_3d.length === 0) return;

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
        s.spectrum_color = "#00FF00"; // Green for theoretical
        s.spectrum_color_negative = "#FF00FF";
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

        // Ortho Theoretical
        if (e.data.spectrum_type === "xz_theo") {
            handle_ortho_response(e.data, "xz_theo");
            return;
        }
        if (e.data.spectrum_type === "yz_theo") {
            handle_ortho_response(e.data, "yz_theo");
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

        document.getElementById("contour_message").innerText = "";
    }
}

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
    } else {
        // Request it
        document.getElementById("contour_message").innerText = "Loading contour...";
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
    if (main_plot && typeof theoretical_peaks_data !== 'undefined' && theoretical_peaks_data.length > 0) {
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

            if (abs_diff <= 1.0) {
                // Square
                visible_peaks.push({
                    x: p.x_ppm !== undefined ? p.x_ppm : (s.x_ppm_start + p.x * s.x_ppm_step),
                    y: p.y_ppm !== undefined ? p.y_ppm : (s.y_ppm_start + p.y * s.y_ppm_step),
                    symbol: 'square',
                    color: 'red', // Use Red as requested
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
                        color: 'red',
                        size: 5,
                        fill: true
                    });
                } else {
                    // Peak Z > Current Z -> Cross
                    visible_peaks.push({
                        x: p.x_ppm !== undefined ? p.x_ppm : (s.x_ppm_start + p.x * s.x_ppm_step),
                        y: p.y_ppm !== undefined ? p.y_ppm : (s.y_ppm_start + p.y * s.y_ppm_step),
                        symbol: 'cross',
                        color: 'red',
                        size: 5,
                        fill: false
                    });
                }
            }
        }
        main_plot.add_extra_peaks(visible_peaks);

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
}

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

async function load_ft3_file() {
    let fileInput = document.getElementById('userfile_ft3');
    let files = Array.from(fileInput.files);

    if (files.length === 0) {
        alert("Please select a .ft3 file.");
        return;
    }

    let file = files[0];
    document.getElementById("webassembly_message").innerText = "Loading " + file.name + "...";

    // Reset state
    spectra_3d = [];
    hsqc_spectra = [];
    current_slice_index = -1;
    theoretical_peaks_data = [];
    theoretical_spectra_3d = [];

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

            s.spectrum_color = "#ff0000";
            s.spectrum_color_negative = "#0000ff";
            s.levels = calculate_levels(s.noise_level, 1.5, 30);
            s.negative_levels = calculate_levels(s.noise_level, 1.5, 30);
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
        document.getElementById('spectra_list').style.display = 'block'; // Or hide if not needed
        document.getElementById('main_plot_area').style.display = 'flex';

        // Initialize the main plot now that we have data dimensions from the first slice
        init_main_plot(spectra_3d[0]);

        // Draw first slice
        draw_slice(0);

        // Auto-render 3D Visualization with full dataset
        setTimeout(() => {
            visualize_3d();
        }, 500);
    }

    document.getElementById("webassembly_message").innerText = "";
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
    theoretical_peaks_data = []; // Clear loaded peaks
    theoretical_spectra_3d = []; // Clear generated volume

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

        // Auto-render 3D Visualization with full dataset
        setTimeout(() => {
            visualize_3d();
        }, 500);
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


function Float32Concat(first, second) {
    var firstLength = first.length,
        result = new Float32Array(firstLength + second.length);
    result.set(first);
    result.set(second, firstLength);
    return result;
}

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
        color_neg_list.push(hexToRgb(spec.spectrum_color_negative));

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

    // Always update crosshairs because even if indices (PPM center) didn't change,
    // the zoom scale might have changed, requiring new pixel coordinates.
    // Call this at the end to ensure all scales are updated.
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
 * XZ and YZ Plot Logic
 */
var main_plot_xz = null;
var main_plot_yz = null;

var spectrum_xz = null;
var spectrum_yz = null;

// Temporary Fixed positions (Center of the cube)
// Ideally updated by crosshair interaction
var current_y_index = -1; // Set during init
var current_x_index = -1; // Set during init

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

        let plot_width = cr.width - plot_margin_left - plot_margin_right;
        let plot_height = cr.height - plot_margin_top - plot_margin_bottom;

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
            size: [cr.width, cr.height]
        };
        main_plot_xz = new plotit(input_xz);
        main_plot_xz.draw();

        // Draw fixed center crosshairs
        if (typeof main_plot_xz.draw_center_lines === 'function') {
            main_plot_xz.draw_center_lines();
        }
    }

    if (!main_plot_yz) {
        let parent = document.getElementById("vis_parent_yz");
        let cr = parent.getBoundingClientRect();

        let plot_width = cr.width - plot_margin_left - plot_margin_right;
        let plot_height = cr.height - plot_margin_top - plot_margin_bottom;

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
            size: [cr.width, cr.height]
        };
        main_plot_yz = new plotit(input_yz);
        main_plot_yz.draw();

        // Draw fixed center crosshairs
        if (typeof main_plot_yz.draw_center_lines === 'function') {
            main_plot_yz.draw_center_lines();
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

function refresh_xz_view() {
    if (!main_plot_xz || spectra_3d.length === 0) return;

    // Generate XZ Spectrum at current_y_index
    // Direct Dim: Original X (0 to n_direct)
    // Indirect Dim: Z slices (0 to spectra_3d.length) -- Treating Z as Indirect ("Y" of this plot)

    let base_spec = spectra_3d[0]; // Assume all have same params for X

    // Create a synthetic spectrum object
    let spec = new spectrum();
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
    let raw = new Float32Array(sz * nx);

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
        let spec_theo = new spectrum();
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
        let raw_theo = new Float32Array(sz * nx);

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
        if (typeof theoretical_peaks_data !== 'undefined' && theoretical_peaks_data.length > 0) {
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

                    // Map coordinates for XZ plot
                    // X-axis: X PPM
                    // Y-axis: Z PPM
                    visible_peaks_xz.push({
                        x: p.x_ppm !== undefined ? p.x_ppm : (s.x_ppm_start + p.x * s.x_ppm_step),
                        y: p.z_ppm !== undefined ? p.z_ppm : (s.z_ppm_start + p.z * s.z_ppm_step),
                        symbol: symbol_type,
                        color: 'red',
                        size: (symbol_type === 'square') ? 6 : 5,
                        fill: fill_flag
                    });
                }
            }
            main_plot_xz.add_extra_peaks(visible_peaks_xz);

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
}

function refresh_yz_view() {
    if (!main_plot_yz || spectra_3d.length === 0) return;

    // Generate YZ Spectrum at current_x_index
    // Direct Dim: Z slices (0 to spectra_3d.length) -- Treating Z as Direct ("X" of this plot?)
    // Indirect Dim: Original Y (0 to n_indirect)

    let base_spec = spectra_3d[0];

    let spec = new spectrum();
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

    let raw = new Float32Array(sz * ny); // Width=sz, Height=ny

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
            raw.set([val], y * sz + z);
        }
    }
    spec.raw_data = raw;

    request_orthogonal_contour(spec, 0, "yz");
    request_orthogonal_contour(spec, 1, "yz");

    spectrum_yz = spec;

    // Handle Theoretical
    if (theoretical_spectra_3d && theoretical_spectra_3d.length > 0) {
        let base_spec_theo = theoretical_spectra_3d[0];

        let spec_theo = new spectrum();
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

        let raw_theo = new Float32Array(sz * ny);

        for (let y = 0; y < ny; y++) {
            for (let z = 0; z < sz; z++) {
                let slice = theoretical_spectra_3d[z];
                let val = 0;
                if (slice.raw_data && slice.raw_data.length > 0) {
                    val = slice.raw_data[y * nx + current_x_index];
                }
                raw_theo.set([val], y * sz + z);
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
        if (typeof theoretical_peaks_data !== 'undefined' && theoretical_peaks_data.length > 0) {
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

                    // Map coordinates for YZ plot
                    // X-axis: Z PPM
                    // Y-axis: Y PPM
                    visible_peaks_yz.push({
                        x: p.z_ppm !== undefined ? p.z_ppm : (s.z_ppm_start + p.z * s.z_ppm_step),
                        y: p.y_ppm !== undefined ? p.y_ppm : (s.y_ppm_start + p.y * s.y_ppm_step),
                        symbol: symbol_type,
                        color: 'red',
                        size: (symbol_type === 'square') ? 6 : 5,
                        fill: fill_flag
                    });
                }
            }
            main_plot_yz.add_extra_peaks(visible_peaks_yz);

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
}

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
        color_neg_list.push(hexToRgb(s.spectrum_color_negative));

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
}

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

function show_cross_section() { }
function show_peak_table() { }
function remove_peak_table() { }
function draw_spectrum() { }

// -- 3D Visualization Integration --

var iso_renderer = null;

var current_volume_data = null; // Stores { data, dims, min, max, noise }

function visualize_3d() {
    // Wrapper to start the process
    extract_3d_data();
}

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
            noise: noise
        };

        setup_sliders();
        update_3d_view();

    }, 50);
}

function setup_sliders() {
    if (!current_volume_data) return;

    const data = current_volume_data;
    const noise = data.noise;
    const maxVal = data.max;

    // Range: 5.5 * noise to 0.75 * max
    const minRange = 5.5 * noise;
    const maxRange = 0.75 * maxVal;

    // Step size
    const step = (maxRange - minRange) / 100;

    const sliderSolid = document.getElementById("iso_solid_slider");
    const sliderWire = document.getElementById("iso_wire_slider");

    if (sliderSolid && sliderWire) {
        sliderSolid.min = minRange;
        sliderSolid.max = maxRange;
        sliderSolid.step = step;
        sliderSolid.value = Math.max(minRange, Math.min(maxRange, 40 * noise)); // Default 40*noise

        sliderWire.min = minRange;
        sliderWire.max = maxRange;
        sliderWire.step = step;
        sliderWire.value = Math.max(minRange, Math.min(maxRange, 10 * noise)); // Default 10*noise

        // Attach Events (using 'change' to avoid lag during drag, or 'input' with debounce)
        // User requested constraints: Mesh < Solid.

        sliderSolid.onchange = function () {
            // Enforce constraints?
            let val = parseFloat(this.value);
            let wireVal = parseFloat(sliderWire.value);
            if (val <= wireVal) {
                // If Solid dragged below Mesh, move Mesh down? 
                // "mesh should be always smaller than solid red"
                sliderWire.value = val - step;
            }
            update_3d_view();
        };

        sliderWire.onchange = function () {
            let val = parseFloat(this.value);
            let solidVal = parseFloat(sliderSolid.value);
            if (val >= solidVal) {
                // If Mesh dragged above Solid, clamp it
                this.value = solidVal - step;
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

function update_3d_view() {
    if (!current_volume_data) return;

    let loadingEl = document.getElementById('loading_3d');
    if (loadingEl) loadingEl.style.display = 'block';

    // Allow UI update
    setTimeout(() => {
        const data = current_volume_data;

        const sliderSolid = document.getElementById("iso_solid_slider");
        const sliderWire = document.getElementById("iso_wire_slider");
        const sliderPeak = document.getElementById("iso_peak_slider");

        // Update labels
        if (document.getElementById("iso_solid_val")) document.getElementById("iso_solid_val").innerText = parseFloat(sliderSolid.value).toFixed(1);
        if (document.getElementById("iso_wire_val")) document.getElementById("iso_wire_val").innerText = parseFloat(sliderWire.value).toFixed(1);

        const isoSolid = parseFloat(sliderSolid.value);
        const isoWire = parseFloat(sliderWire.value);

        console.log(`Generating Meshes. Solid: ${isoSolid}, Wire: ${isoWire}`);

        let meshSolid, meshWire;
        let meshSolid_recon = null, meshWire_recon = null;

        try {
            meshSolid = MarchingCubes.compute(data.data, data.dims, isoSolid);
            meshWire = MarchingCubes.compute(data.data, data.dims, isoWire);

            // Reconstructed processing
            if (theoretical_spectra_3d && theoretical_spectra_3d.length > 0) {
                let data_recon = new Float32Array(data.dims.x * data.dims.y * data.dims.z);
                let idx = 0;
                for (let z = 0; z < data.dims.z; z++) {
                    let s_theo = theoretical_spectra_3d[z];
                    if (s_theo && s_theo.raw_data) {
                        data_recon.set(s_theo.raw_data, idx);
                    }
                    idx += data.dims.x * data.dims.y;
                }
                meshSolid_recon = MarchingCubes.compute(data_recon, data.dims, isoSolid);
                meshWire_recon = MarchingCubes.compute(data_recon, data.dims, isoWire);
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
        }
        if (!iso_renderer_recon) {
            iso_renderer_recon = new IsoSurfaceRenderer("canvas_3d_recon");
            iso_renderer_recon.onCameraChange = function (cam) {
                if (iso_renderer) iso_renderer.setCameraState(cam);
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
                    mode: 'TRIANGLES'
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
                        mode: 'TRIANGLES'
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


function reset_3d_view() {
    if (iso_renderer) {
        iso_renderer.resetView();
    }
    if (iso_renderer_recon) {
        iso_renderer_recon.resetView();
    }
}

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
var fid_drop_process_3d = null;

document.addEventListener('DOMContentLoaded', function () {
    if (window.Worker) {
        web_worker_3d = new Worker('./js/webass_3d.js');
        web_worker_3d.onmessage = handle_webass_3d_message;
        web_worker_3d.onerror = function (err) {
            console.error('[3D][worker] error', err);
            append_3d_log('[worker-error] ' + (err && err.message ? err.message : String(err)));
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

    let fid3dForm = document.getElementById('fid_file_form');
    if (fid3dForm) {
        fid3dForm.addEventListener('submit', function (e) {
            e.preventDefault();
            load_fid_3d_file();
        });
    }
});

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

async function load_fid_3d_file() {
    let acquisition_file = document.getElementById('acquisition_file').files[0];
    let acquisition_file2 = document.getElementById('acquisition_file2').files[0];
    let acquisition_file3 = document.getElementById('acquisition_file3').files[0];
    let fid_file = document.getElementById('fid_file').files[0];
    let nuslist_file = document.getElementById('nuslist_file').files[0];

    if (!fid_file || !acquisition_file || !acquisition_file2 || !acquisition_file3) {
        alert('Please provide fid/ser, acqus, acqu2s, and acqu3s files.');
        return;
    }

    console.log('[3D][fid] Starting 3D FID processing request');
    append_3d_log('[main] Starting 3D FID processing request');
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

        const cfg = {
            zfDirect: parseInt(document.getElementById('zf_direct').value) || 1,
            zfIndirect1: parseInt(document.getElementById('zf_indirect1').value) || 1,
            zfIndirect2: parseInt(document.getElementById('zf_indirect2').value) || 1,
            apodDirect: document.getElementById('apodization_direct').value,
            apodIndirect1: document.getElementById('apodization_indirect1').value,
            apodIndirect2: document.getElementById('apodization_indirect2').value,
            phaseText: document.getElementById('phase_correction_direct_p0').value + " " +
                       document.getElementById('phase_correction_direct_p1').value + " " +
                       document.getElementById('phase_correction_indirect1_p0').value + " " +
                       document.getElementById('phase_correction_indirect1_p1').value + " " +
                       document.getElementById('phase_correction_indirect2_p0').value + " " +
                       document.getElementById('phase_correction_indirect2_p1').value,
            tdPolyOrder: parseTdPolynomialOrder(),
            frqPolyOrder: parseFrqPolynomialOrder(),
            inverse: [0, 0, 0], // default
            deleteImage: [1, 1, 1], // always delete imaginary in 3D processing
            nusSerInflated: false,
            extPpm: [
                parseFloat(document.getElementById('extract_direct_from').value),
                parseFloat(document.getElementById('extract_direct_to').value)
            ]
        };

        console.log('[3D][fid] cfg prepared', cfg);
        append_3d_log('[main] cfg: zf=(' + cfg.zfDirect + ',' + cfg.zfIndirect1 + ',' + cfg.zfIndirect2 + '), mode UI ready');

        const textInputs = {
            pulse: "",
            acqus: buffers[1] ? new TextDecoder().decode(buffers[1]) : "",
            acqu2s: buffers[2] ? new TextDecoder().decode(buffers[2]) : "",
            acqu3s: buffers[3] ? new TextDecoder().decode(buffers[3]) : "",
            nuslist: buffers[4] ? new TextDecoder().decode(buffers[4]) : ""
        };
        append_3d_log('[main] textInputs length: acqus=' + textInputs.acqus.length + ', acqu2s=' + textInputs.acqu2s.length + ', acqu3s=' + textInputs.acqu3s.length + ', nuslist=' + textInputs.nuslist.length);
        
        let mode = "full";
        let modeInputs = document.getElementsByName('Process_Mode');
        for (let rad of modeInputs) {
            if (rad.checked) mode = rad.value;
        }

        console.log('[3D][fid] Sending worker message, mode=', mode);
        append_3d_log('[main] Posting process_fid_3d to worker (mode=' + mode + ')');

        document.getElementById("webassembly_message").innerText = "Processing 3D FID using WebAssembly...";
        web_worker_3d.postMessage({
            "#sym:webassembly_job ": "process_fid_3d",
            cfg: cfg,
            textInputs: textInputs,
            fidBytes: fidBytes,
            mode: mode
        });
    } catch (err) {
        console.error('[3D][fid] Error while reading/posting input', err);
        append_3d_log('[main-error] ' + (err && err.toString ? err.toString() : String(err)));
        document.getElementById("webassembly_message").innerText = "Error reading files: " + err.toString();
    }
}

function handle_webass_3d_message(e) {
    console.log('[3D][worker->main] message keys:', Object.keys(e.data || {}));
    if (e.data.error) {
        append_3d_log('[worker-error] ' + e.data.error);
        document.getElementById("webassembly_message").innerText = "Error: " + e.data.error;
        return;
    }
    if (Object.prototype.hasOwnProperty.call(e.data, 'stdout')) {
        append_3d_worker_stdout(e.data.stdout);
        return;
    }
    if (e.data["#sym:webassembly_job "] === "process_fid_3d") {
        append_3d_log('[main] Received process_fid_3d result');
        document.getElementById("webassembly_message").innerText = "3D processing complete. Rendering planes...";
        const dims = e.data.dims;
        const header = e.data.headerF32; // Float32Array 512 elements
        const rrr = e.data.rrrF32; // Float32Array

        const nx = dims.nx;
        const ny = dims.ny;
        const nz = dims.nz;
        append_3d_log('[main] dims: nx=' + nx + ', ny=' + ny + ', nz=' + nz + ', header=' + (header ? header.length : 0) + ', rrr=' + (rrr ? rrr.length : 0));
        console.log('[3D][fid] Received dims', dims);

        spectra_3d = [];
        hsqc_spectra = [];
        current_slice_index = -1;
        theoretical_peaks_data = [];
        theoretical_spectra_3d = [];

        let plane_float_count = nx * ny;
        let plane_byte_size = plane_float_count * 4;
        let headerUint8 = new Uint8Array(header.buffer, header.byteOffset, header.byteLength);

        for (let i = 0; i < nz; i++) {
            try {
                let plane_buffer = new ArrayBuffer(2048 + plane_byte_size);
                let dst = new Uint8Array(plane_buffer);

                // Copy header (2048 bytes)
                dst.set(headerUint8, 0);

                // Copy data slice
                let plane_data_f32 = rrr.subarray(i * plane_float_count, (i + 1) * plane_float_count);
                let plane_data_u8 = new Uint8Array(plane_data_f32.buffer, plane_data_f32.byteOffset, plane_data_f32.byteLength);
                dst.set(plane_data_u8, 2048);

                let s = new spectrum();
                let plane_name = "plane_" + String(i + 1).padStart(3, '0');
                s.process_ft_file(plane_buffer, plane_name, -1);

                s.spectrum_color = "#ff0000";
                s.spectrum_color_negative = "#0000ff";
                s.levels = calculate_levels(s.noise_level, 1.5, 30);
                s.negative_levels = calculate_levels(s.noise_level, 1.5, 30);
                s.visible = true;

                spectra_3d.push(s);
            } catch (err) {
                console.error("Error creating plane " + i, err);
                append_3d_log('[main-error] plane ' + i + ' creation failed: ' + (err && err.message ? err.message : String(err)));
            }
        }

        append_3d_log('[main] planes created: ' + spectra_3d.length);

        if (spectra_3d.length > 0) {
            let slider = document.getElementById('slice_slider');
            slider.max = spectra_3d.length - 1;
            slider.value = 0;
            document.getElementById('slice_control_area').style.display = 'block';
            document.getElementById('spectra_list').style.display = 'block';
            document.getElementById('main_plot_area').style.display = 'flex';

            // Keep initialization behavior consistent with .ft2/.ft3 file loaders.
            init_main_plot(spectra_3d[0]);

            draw_slice(0);

            let s0 = spectra_3d[0];
            init_ortho_plots(s0);

            visualize_3d();
            append_3d_log('[main] 3D render initialized successfully');
            document.getElementById("webassembly_message").innerText = "3D FID processing and rendering finished successfully.";
        } else {
            append_3d_log('[main] no planes generated from worker output');
            document.getElementById("webassembly_message").innerText = "No planes were generated.";
        }
    }
}
