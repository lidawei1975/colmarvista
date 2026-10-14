/**
 * Tooltips for all user-input controls (buttons, inputs, dropdowns, checkboxes, ...)
 * on the COLMARvista 1D and 2D pages.
 *
 * How it works
 * ------------
 * - Tooltips are looked up by element id (a trailing "-<spectrum index>" is stripped, so the
 *   controls created dynamically in "Your spectra list" are covered as well), by "name=value"
 *   for radio buttons, or by the visible text for buttons without an id.
 * - A tooltip is only set when the element has no title yet, so more specific titles that are
 *   written in the HTML or in 1d.js / 2d.js always win.
 * - Labels inherit the tooltip of the control they belong to.
 * - A MutationObserver applies tooltips to controls that are added to the page later.
 *
 * To add or change a tooltip, edit the maps below. Use TIPS_1D / TIPS_2D when the same id means
 * something different on the two pages.
 */
(function () {
    "use strict";

    /** Tooltips shared by the 1D and 2D pages, keyed by element id */
    const TIPS_COMMON = {
        /** Session and file loading */
        button_save: "Save the current session (spectra, peaks and settings) to a local file that can be loaded again later. Raw time-domain (FID) data is not saved.",
        load_file: "Load a session file (.save or .colmar) that was saved previously.",
        button_minimize_fid_area: "Expand or collapse the time-domain (FID) data processing section.",
        button_minimize_file_area: "Expand or collapse the frequency-domain spectra upload section.",
        fid_file: "Time-domain data file to process, e.g. fid or ser. You can select more than one file, or drag and drop the whole experiment folder onto the box.",
        apodization_direct: "Apodization (window) function applied before Fourier transform, in nmrPipe syntax, e.g. SP off 0.5 end 0.98 pow 2 elb 0 c 0.5.",
        zf_direct: "Zero-filling factor (2, 4 or 8). Larger values give a smoother spectrum with more data points, but use more memory and take longer.",
        phase_correction_direct_p0: "Zero-order phase correction P0 (degrees). Used as the starting phase and when automatic phase correction is turned off.",
        phase_correction_direct_p1: "First-order phase correction P1 (degrees). Used as the starting phase and when automatic phase correction is turned off.",
        button_fid_process: "Upload the selected time-domain files and process them with the parameters above. When editing an existing spectrum, this re-runs the processing with the current parameters.",
        userfile: "Frequency-domain spectrum file(s) to display. You can select several files, or drag and drop files or a folder onto the box.",

        /** Plot controls */
        plot_group: "Plot group number (1-10). Plots opened in other browser windows or tabs with the same group number keep their viewing region synchronized.",
        peak_size: "Size of the peak markers (1-20).",
        peak_thickness: "Line thickness of the peak markers (1-10).",
        filled_peaks: "Draw peak markers as filled symbols instead of open outlines.",
        peak_color: "Color of the peak markers.",
        allow_drag_and_drop: "Allow dragging peak markers to move them. Dragging a marker out of the plot area removes the peak. Requires a peak list to be shown.",

        /** Peak table, log */
        peak_search_text: "Type text (for example an assignment) or a chemical shift value to look for in the peak table.",
        peak_search: "Search the peak table for the text on the left and jump to the first matching peak.",
        button_minimize_log: "Minimize or restore the log window.",
        log: "Log of messages from the background processing. Read only.",

        /** Per-spectrum controls (created dynamically in the spectra list) */
        minimize: "Minimize or restore the controls of this spectrum.",
        contour_color: "Color used to draw this spectrum.",
        run_load_peak_list: "Load a peak list file (e.g. Sparky .list format) for this spectrum.",
        run_deep_picker: "Pick peaks with the DEEP Picker neural network. The minimum peak height is controlled by the current lowest contour level (2D) or by Scale1 (1D).",
        peak_combine_cutoff: "Peaks closer to each other than this cutoff are combined into one peak.",
        combine_peak_cutoff: "Peaks closer to each other than this cutoff are combined into one peak.",
        maxround: "Maximum number of optimization rounds used for peak fitting.",
        run_voigt_fitter_select: "Line shape used for peak fitting.",
        run_voigt_fitter: "Fit the picked peaks inside the visible spectral window with the selected line shape. A reconstructed spectrum is generated from the fitted peaks.",
        download_peaks: "Download the picked peaks of this spectrum as a text file.",
        download_fitted_peaks: "Download the fitted peaks of this spectrum as a text file.",
        show_peaks: "Show or hide the picked peaks of this spectrum on the plot.",
        show_fitted_peaks: "Show or hide the fitted peaks of this spectrum on the plot.",
        show_recon: "Show or hide the reconstructed spectrum calculated from the fitted peaks."
    };

    /** 1D page only */
    const TIPS_1D = {
        fid_file: "Time-domain data file to process: fid or ser (Bruker), data.1d (Magritek) or the .jdx file (Oxford). You can also drag and drop the whole experiment folder onto the box.",
        acquisition_file: "Direct dimension acquisition parameter file: acqus (Bruker), acqu.par (Magritek) or the .jdx / .dx file (Oxford).",
        userfile: "Frequency-domain 1D spectrum file(s): .ft1 (nmrPipe), .ucsf (Sparky) or .txt. You can select several files, or drag and drop files or a folder onto the box.",
        button_ft1_process: "Upload and display the selected frequency-domain spectra.",
        "fid_reduction_mode=full": "Process the complete time-domain data without truncation.",
        "fid_reduction_mode=auto": "Automatically detect where the signal has decayed and truncate the FID there to reduce noise before Fourier transform (default).",
        "fid_reduction_mode=auto_confirm": "Automatically detect the end of the signal, then ask you to confirm or edit it before processing.",
        "fid_reduction_mode=prev": "Reuse the FID size reduction from the previous processing. Only available when re-processing a spectrum.",
        "pc_method=1": "Automatic phase correction with a convolutional neural network that focuses on the regions around the main peaks.",
        "pc_method=2": "Automatic phase correction with a neural network that analyzes the full spectrum (default). May not work well for Magritek benchtop data.",
        "pc_method=3": "Automatic phase correction by entropy minimization.",
        "pc_method=0": "No automatic phase correction. The P0 and P1 values above are used, and the phase can be adjusted manually afterwards.",
        "Pseudo-2D-process=first_only": "Process only the first 1D experiment of a pseudo-2D data set. Quick, useful for tuning the processing parameters.",
        "Pseudo-2D-process=all_planes": "Process all traces of a pseudo-2D data set.",
        size_and_zoom_string: "Plot size and zoom level. Use Fill plot size and zoom to fill in the current values, or paste a string saved earlier and click Apply plot size and zoom.",
        fontsize: "Font size of the plot labels (8-72).",
        button_auto_pc: "Run automatic phase correction on the current spectrum. The result is shown as a preview that can still be adjusted manually.",
        button_apply_pc: "Permanently apply the current manual phase correction to the spectrum.",
        smooth_parameter: "Smoothness of the calculated baseline (larger values give a smoother baseline).",
        exclude_water: "Exclude the water suppression region when calculating the baseline, so solvent artifacts do not distort it.",
        button_baseline_correction: "Calculate the baseline of the current spectrum and show it as a preview.",
        button_apply_baseline_correction: "Subtract the calculated baseline from the spectrum.",
        run_deep_picker: "Pick peaks with the DEEP Picker neural network. Only peaks higher than Scale1 times the noise level are kept.",
        scale1: "Minimum peak height for the DEEP Picker, as a multiple of the estimated noise level.",
        line_width: "Line width used to draw this spectrum."
    };

    /** 2D page only */
    const TIPS_2D = {
        button_save: "Save the current session (spectra, peaks and settings) to a local file that can be loaded again later. Check 'Include raw FID data' to also save raw FID data for reprocessing.",
        save_fid_data: "Include raw time-domain (FID) data and processing parameters in the saved file. This enables reloading the session later and reprocessing the spectrum from raw FID. Note: saved file size will be larger.",
        save_fid_data_label: "Include raw time-domain (FID) data and processing parameters in the saved file. This enables reloading the session later and reprocessing the spectrum from raw FID. Note: saved file size will be larger.",
        fid_file: "Bruker time-domain data file to process: fid or ser (required). You can also drag and drop the whole Bruker experiment folder onto the box.",
        acquisition_file: "Direct dimension acquisition parameter file, usually acqus (required).",
        acquisition_file2: "Indirect dimension acquisition parameter file, usually acqu2s (required).",
        acquisition_file3: "Second indirect dimension acquisition parameter file, usually acqu3s (optional, needed for pseudo-3D data).",
        nuslist_file: "Non-uniform sampling (NUS) schedule file, usually nuslist. Only needed for NUS experiments.",
        water_suppression: "Check if the experiment used water suppression. The solvent signal is attenuated during processing.",
        apodization_indirect: "Apodization (window) function for the indirect dimension, in nmrPipe syntax, e.g. SP off 0.5 end 0.98 pow 2 elb 0 c 0.5.",
        zf_indirect: "Zero-filling factor for the indirect dimension (2, 4 or 8). Larger values give a smoother spectrum but use more memory.",
        phase_correction_indirect_p0: "Zero-order phase correction P0 (degrees) for the indirect dimension. Used when automatic phase correction is turned off.",
        phase_correction_indirect_p1: "First-order phase correction P1 (degrees) for the indirect dimension. Used when automatic phase correction is turned off.",
        auto_direct: "Automatic phase correction of the direct dimension, based on entropy minimization.",
        auto_indirect: "Automatic phase correction of the indirect dimension, based on entropy minimization.",
        ann_auto_direct: "Automatic phase correction of the direct dimension based on a neural network.",
        delete_imaginary: "Discard the imaginary data of the direct dimension after processing to save memory. Manual phase correction is not possible afterwards.",
        delete_imaginary_indirect: "Discard the imaginary data of the indirect dimension after processing to save memory. Manual phase correction of the indirect dimension is not possible afterwards.",
        nus_flatt_baseline: "Apply FLATT baseline correction to the direct dimension during NUS reconstruction.",
        nus_process_as_normal: "Process a NUS data set as if it was uniformly sampled, without NUS reconstruction. Faster, but the spectrum contains sampling artifacts.",
        extract_direct_from: "Start of the direct dimension region (ppm) to extract and process. The default covers the whole spectral width.",
        extract_direct_to: "End of the direct dimension region (ppm) to extract and process. The default covers the whole spectral width.",
        "Pseudo-3D-process=first_only": "Process only the first plane of a pseudo-3D data set. Quick, useful for tuning the processing parameters.",
        "Pseudo-3D-process=all_planes": "Process all planes of a pseudo-3D data set.",
        userfile: "Frequency-domain 2D spectrum file(s): .ft2 (nmrPipe), .ucsf (Sparky) or .txt. You can select several files, or drag and drop files or a folder onto the box.",
        button_ft2_process: "Upload and display the selected frequency-domain spectra.",

        /** Pseudo-3D, DOSY, CEST */
        button_minimize_preudo3d_area: "Expand or collapse the pseudo-3D fitting tool.",
        max_round: "Maximum number of optimization rounds for pseudo-3D fitting (1-1000).",
        button_run_pseudo3d_gaussian: "Fit all experimental spectra of the series with Gaussian line shapes. The peak list currently shown is used as the initial guess.",
        button_run_pseudo3d_voigt: "Fit all experimental spectra of the series with Voigt line shapes. The peak list currently shown is used as the initial guess.",
        pseudo3d_file: "Load pseudo-3D fitted peaks (.tab) that were saved earlier, instead of running the fitting again.",
        button_download_fitted_peaks: "Download the pseudo-3D fitted peaks as a .tab file.",
        show_pseudo3d_peaks: "Show the pseudo-3D fitted peaks on the plot.",
        assignment_file: "Upload a peak file (.list) with assignment information to transfer to the pseudo-3D fitted peaks.",
        button_minimize_dosy_area: "Expand or collapse the DOSY fitting tool.",
        dosy_gradient: "Gradient strengths of the DOSY experiment, separated by spaces, one value per plane.",
        dosy_gradient_weight: "Fitting weight of each gradient plane, separated by spaces (e.g. 1 0 0 1 1). Use 0 to leave a plane out of the fit.",
        dosy_rescale: "Rescale factor that converts the fitted diffusion values to convenient units.",
        button_run_dosy: "Fit the intensity decay of every pseudo-3D peak to obtain diffusion constants.",
        button_minimize_cest_area: "Expand or collapse the CEST fitting tool.",
        button_cest_pre_analysis: "Fit multiple Voigt line shapes to every CEST profile to locate the main dip and any secondary dips caused by chemical exchange.",
        button_cest_filter_multi_peaks: "Show only peaks whose CEST profile has two or more dips. Click again to show all peaks.",
        button_peak_area_filter_multi: "Show only peaks whose CEST profile has two or more dips. Click again to show all peaks.",
        cest_offsets: "CEST saturation offsets in Hz, separated by spaces, one per plane.",
        cest_offsets_file: "Load the CEST saturation offsets from a text file.",
        button_upload_cest_offsets: "Load the CEST saturation offsets from a file (.txt, .list, .tab, .dat or .csv).",
        cest_b1: "Strength of the B1 saturation field (Hz).",
        time_t1: "Duration of the CEST saturation period (s).",
        cest_b1_inh_inf: "Assume a perfectly homogeneous B1 field (b1_inh_scale = inf, no B1 dephasing). Faster simulation, useful for exploratory analysis.",
        button_gen_chemex_input: "Generate the ChemEx input files for the fitted CEST peaks.",
        button_save_chemex_input: "Save the generated ChemEx input files.",
        button_run_chemex: "Run the ChemEx fit (Bloch-McConnell simulation) on the generated input.",
        button_download_cest: "Download the CEST fitting results.",

        /** Assignment transfer */
        button_minimize_assignment_area: "Expand or collapse the assignment transfer tool.",
        assignment_cutoff_h: "Maximum 1H chemical shift distance (ppm) between an assignment and a peak for them to be matched.",
        assignment_cutoff_hetero: "Maximum heteronucleus chemical shift distance (ppm) between an assignment and a peak for them to be matched.",
        assignment_shift_h: "Global offset (ppm) added to the incoming 1H assignments to correct a calibration mismatch.",
        assignment_shift_hetero: "Global offset (ppm) added to the incoming heteronucleus assignments to correct a calibration mismatch.",
        assignment_transfer_file: "Assignment file (.list, .tab or .txt) with Assignment, w1 and w2 columns.",
        button_load_assignment: "Load an assignment file and transfer its assignments to the current peak list with the Hungarian method.",
        button_retry_assignment: "Run the assignment transfer again with the current cutoffs and shifts.",
        clear_unmatched_assignments: "Remove the existing assignment of peaks that were not matched by the transfer.",

        /** Plot controls */
        plot_font_size: "Font size of the plot labels (12-72).",
        plot_scale_up_factor: "Resolution factor of the downloaded plot (1-10). Larger values give a higher resolution image.",
        ratio_spectrum_a: "Numerator spectrum A of the ratio heatmap (original spectrum index, starting from 0).",
        ratio_spectrum_b: "Denominator spectrum B of the ratio heatmap (original spectrum index, starting from 0).",
        button_clear_ratio_heatmap: "Remove the ratio heatmap from the plot.",
        ratio_colormap: "Colormap used for the ratio heatmap and for spectra drawn with the Colormap option.",
        ratio_range_min: "Lower limit of the colormap range.",
        ratio_range_max: "Upper limit of the colormap range.",
        baseline_method: "Baseline correction method for the current spectrum: None, Parametric or Polynomial.",
        baseline_order: "Polynomial order of the baseline (0-4).",
        button_apply_baseline: "Apply the selected baseline correction to the current spectrum.",
        automatic_pc: "Run automatic phase correction on the current spectrum.",
        button_apply_ps: "Apply the phase correction (P0 and P1 from the cross sections) to the whole 2D spectrum. Needs imaginary data to be kept during processing.",
        peak_colormap: "Property used to color-code the peaks. Solid uses a single color.",
        show_peak_label: "Show a label next to each visible peak.",
        labels: "Peak property shown as the peak label.",
        peak_label_size: "Font size of the peak labels.",
        min_distance: "Minimum distance (pixels) between a peak label and its peak.",
        max_distance: "Maximum distance (pixels) between a peak label and its peak.",
        repulsive_force: "Strength of the repulsive force that pushes overlapping peak labels apart.",
        allow_brush_to_remove: "Brush (drag a rectangle) on the plot to remove all peaks inside it.",
        allow_click_to_add_peak: "Click on the plot to add a peak at that position.",
        "select_plot_1d=projection": "Show the 1D projections along both dimensions next to the 2D plot.",
        "select_plot_1d=cross_section": "Show 1D cross sections (slices) through a selected point of the 2D plot.",
        pause_cursor: "Select the cross section at the cursor position when the cursor stays still on the plot for 3 seconds.",
        right_click: "Right-click on the plot to select the cross section at that position.",
        enable_magnifying_glass: "Show a magnifying glass lens that follows the cursor over the plot.",
        magnifying_glass_size: "Diameter of the magnifying glass, as a percentage (10-40) of the plot size.",
        magnifying_glass_ratio: "Magnification factor of the magnifying glass (2-30).",

        /** Pseudo-3D peak profile window */
        chemex_input_pb: "Population of the minor (excited) state B used in the ChemEx simulation (fraction).",
        chemex_slider_pb: "Population of the minor (excited) state B used in the ChemEx simulation (fraction).",
        chemex_input_kex: "Exchange rate k_ex (s-1) used in the ChemEx simulation.",
        chemex_slider_kex: "Exchange rate k_ex (s-1) used in the ChemEx simulation.",
        chemex_input_csa: "Chemical shift anisotropy (ppm) of the observed nucleus used in the ChemEx simulation.",
        chemex_slider_csa: "Chemical shift anisotropy (ppm) of the observed nucleus used in the ChemEx simulation.",
        chemex_input_dw: "Chemical shift difference between state B and state A (ppm) used in the ChemEx simulation.",
        chemex_slider_dw: "Chemical shift difference between state B and state A (ppm) used in the ChemEx simulation.",
        btn_fit_single_peak: "Run the ChemEx fit for this peak only, starting from the parameters above.",
        btn_reset_single_peak_params: "Reset the parameters above to their initial guess values."
    };

    /**
     * Contour controls in the 2D spectra list exist for positive and negative contours
     * (their ids contain "_negative" for the latter), so generate both variants from one description.
     */
    [
        ["contour0", "Lowest {sign} contour level. Click Recalculate to apply a new value."],
        ["reduce_contour", "Insert a new lower {sign} contour level (the current lowest level divided by the logarithmic scale). Faster than a full recalculation."],
        ["logarithmic_scale", "Ratio between two adjacent {sign} contour levels in logarithmic mode (at least 1.05). Click Recalculate to apply a new value."],
        ["number_of_contours", "Number of {sign} contour levels in linear mode (10-50). Click Recalculate to apply a new value."],
        ["contour-slider", "Slide to change the lowest {sign} contour level that is displayed."],
        ["contour_color", "Color used to draw the {sign} contours of this spectrum."]
    ].forEach(([key, text]) => {
        TIPS_2D[key] = text.replace("{sign}", "positive");
        TIPS_2D[key + "_negative"] = text.replace("{sign}", "negative");
    });
    /** The negative number_of_contours control is called number_of_negative_contours */
    TIPS_2D["number_of_negative_contours"] = TIPS_2D["number_of_contours_negative"];
    TIPS_2D["contour_colormap"] = "Draw the positive contours of this spectrum with the colormap (by log of the contour level) instead of a solid color.";
    TIPS_2D["ref1"] = "Reference offset (ppm) added to the direct dimension of this spectrum.";
    TIPS_2D["ref2"] = "Reference offset (ppm) added to the indirect dimension of this spectrum.";
    TIPS_2D["remove_t1_noise"] = "Remove t1 noise (streaks along the indirect dimension) when picking peaks.";

    /** Tooltips for buttons without an id, keyed by their visible text */
    const TEXT_COMMON = {
        "+": "Expand this section or spectrum.",
        "-": "Collapse this section or spectrum.",
        "Reset all Zoom": "Reset the view to show the whole spectrum.",
        "Zoom Back": "Go back to the previous zoom level.",
        "Zoom out 120%": "Zoom out from the current view (to 120% of the visible range).",
        "Clear": "Clear all messages in the log.",
        "Download": "Save the log as a text file.",
        "Remove me": "Remove this spectrum from the list and from the plot.",
        "Download ft1": "Download this spectrum as an nmrPipe .ft1 file.",
        "Download ft2": "Download this spectrum as an nmrPipe .ft2 file.",
        "Download diff.ft2": "Download the difference between the experimental and the reconstructed spectrum as an .ft2 file.",
        "DEEP Picker": "Pick peaks with the DEEP Picker neural network.",
        "Simple Picker": "Pick peaks as local intensity maxima above the lowest contour level.",
        "Peak Fitting": "Fit the picked peaks inside the visible spectral window with the selected line shape.",
        "Download picked peaks": "Download the picked peaks of this spectrum as a text file.",
        "Download fitted peaks": "Download the fitted peaks of this spectrum as a text file."
    };

    const TEXT_1D = {
        "Download plot": "Download the current 1D plot as a vector SVG file.",
        "Fill plot size and zoom": "Fill the box on the right with the current plot size and zoom level, so it can be saved or reused later.",
        "Apply plot size and zoom": "Set the plot size and zoom level from the text on the left.",
        "Apply": "Apply the font size to the plot."
    };

    const TEXT_2D = {
        "Download plot": "Download the current 2D plot as an image. Use the resolution factor to increase the image quality.",
        "Spectrum ratio": "Draw the ratio heatmap A / B of the two selected spectra below the contours.",
        "Clear ratio": "Remove the ratio heatmap from the plot.",
        "Apply Baseline": "Apply the selected baseline correction to the current spectrum.",
        "Automatic PC": "Run automatic phase correction on the current spectrum.",
        "Apply PC": "Apply the phase correction to the whole 2D spectrum.",
        "Flip Indirect": "Flip the indirect dimension of the frequency-domain spectrum without re-processing.",
        "Run Gaussian pseudo-3D fitting of all spectra": "Fit all experimental spectra of the series with Gaussian line shapes.",
        "Run Voigt pseudo-3D fitting of all spectra": "Fit all experimental spectra of the series with Voigt line shapes.",
        "Download pseudo-3D fitted peaks": "Download the pseudo-3D fitted peaks as a .tab file.",
        "Run DOSY fitting": "Fit the intensity decay of every pseudo-3D peak to obtain diffusion constants.",
        "Pre-analysis": "Fit multiple Voigt line shapes to every CEST profile to find exchange related dips.",
        "Upload offset file": "Load the CEST saturation offsets from a file.",
        "Gen Chemex input": "Generate the ChemEx input files for the fitted CEST peaks.",
        "Save input": "Save the generated ChemEx input files.",
        "Run Chemex": "Run the ChemEx fit on the generated input.",
        "Download CEST results": "Download the CEST fitting results.",
        "Load assignment file": "Load an assignment file and transfer its assignments to the current peak list.",
        "Re-run transfer": "Run the assignment transfer again with the current cutoffs and shifts.",
        "Search": "Search the peak table for the text on the left and jump to the first matching peak."
    };

    /** Page is determined by the frequency-domain upload form */
    function detect_page() {
        if (document.getElementById("ft1_file_form")) return "1d";
        if (document.getElementById("ft2_file_form")) return "2d";
        return null;
    }

    function normalize(text) {
        return (text || "").replace(/\s+/g, " ").trim();
    }

    /** Candidate keys for an element, most specific first */
    function keys_of(el) {
        const keys = [];
        if ((el.type === "radio") && el.name) {
            keys.push(el.name + "=" + el.value);
        }
        if (el.id) {
            keys.push(el.id);
            /** Controls in the spectra list have ids like "scale1-0": remove the spectrum index */
            const base = el.id.replace(/-\d+$/, "").replace(/_negative$/, "");
            if (base !== el.id) {
                keys.push(base);
            }
        }
        return keys;
    }

    function lookup(el, page) {
        const maps = [page === "1d" ? TIPS_1D : TIPS_2D, TIPS_COMMON];
        for (const key of keys_of(el)) {
            for (const map of maps) {
                if (Object.prototype.hasOwnProperty.call(map, key) && map[key]) {
                    return map[key];
                }
            }
        }
        /** Fall back to the visible text for buttons */
        if (el.tagName === "BUTTON" || (el.tagName === "INPUT" && (el.type === "button" || el.type === "submit"))) {
            const text = normalize(el.tagName === "BUTTON" ? el.textContent : el.value);
            const text_maps = [page === "1d" ? TEXT_1D : TEXT_2D, TEXT_COMMON];
            for (const map of text_maps) {
                if (Object.prototype.hasOwnProperty.call(map, text)) {
                    return map[text];
                }
            }
        }
        return null;
    }

    function apply_tooltips(root) {
        const page = detect_page();
        if (!page) return;
        const scope = root || document;

        /** Controls first, so that labels can copy their titles afterwards */
        scope.querySelectorAll("button, input, select, textarea").forEach((el) => {
            if (el.hasAttribute("title") && el.getAttribute("title") !== "") return;
            const tip = lookup(el, page);
            if (tip) {
                el.setAttribute("title", tip);
            }
        });

        scope.querySelectorAll("label").forEach((label) => {
            if (label.hasAttribute("title") && label.getAttribute("title") !== "") return;
            let control = null;
            const target_id = label.getAttribute("for");
            if (target_id) {
                control = document.getElementById(target_id);
            }
            else {
                control = label.querySelector("button, input, select, textarea");
            }
            if (control && control.getAttribute("title")) {
                label.setAttribute("title", control.getAttribute("title"));
            }
        });
    }

    let pending = null;
    function schedule_apply() {
        if (pending !== null) return;
        pending = setTimeout(() => {
            pending = null;
            apply_tooltips(document);
        }, 50);
    }

    function init() {
        apply_tooltips(document);
        /** Controls are added to the page later (spectra list, peak profile window, ...) */
        const observer = new MutationObserver(schedule_apply);
        observer.observe(document.body, { childList: true, subtree: true });
    }

    if (document.readyState === "loading") {
        document.addEventListener("DOMContentLoaded", init);
    }
    else {
        init();
    }

    window.apply_tooltips = apply_tooltips;
})();
