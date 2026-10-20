/**
 * NMR 1D Voigt Reconstruction Tools (Shared Module)
 * Debounced summation of fitted Voigt profiles for reconstructed spectrum display.
 */
let zoomPanTimeout; // to debounce zoom and pan events
function update_reconstructed_peaks_debounced(index) {
    clearTimeout(zoomPanTimeout);

    // Set a new timeout
    zoomPanTimeout = setTimeout(() => {
        console.log("Zoom or pan stopped. Running function.");
        update_reconstructed_peaks(index !== undefined ? index : 1);
    }, 100);
}

function update_reconstructed_peaks(index) {
    if (!main_plot || !all_spectra || !all_spectra[index]) return;
    main_plot.update_reconstructed_peaks([]);

    /**
     * If picked peaks, do nothing
     */
    if (typeof current_flag_of_peaks !== 'undefined' && current_flag_of_peaks === 'picked') {
        return;
    }

    const [x_ppm_visible_start, x_ppm_visible_end] = main_plot.get_visible_region();
    const plot_width = main_plot.true_width;
    let median_peak_width_pixel = 0;

    if (all_spectra[index].fitted_peaks_object && typeof all_spectra[index].fitted_peaks_object.get_column_by_header === "function") {
        const all_peak_widths = all_spectra[index].fitted_peaks_object.get_column_by_header("XW").sort((a, b) => a - b);
        const median_peak_width = all_peak_widths[all_peak_widths.length >> 1] * Math.abs(all_spectra[index].x_ppm_step);
        median_peak_width_pixel = median_peak_width / (x_ppm_visible_end - x_ppm_visible_start) * plot_width;
    } else if (all_spectra[index].median_fwhh) {
        median_peak_width_pixel = all_spectra[index].median_fwhh / (x_ppm_visible_end - x_ppm_visible_start) * plot_width;
    }

    const reference = all_spectra[index].x_ppm_ref || 0.0;
    if (median_peak_width_pixel > 4 && all_spectra[index].recon_peaks && all_spectra[index].recon_peaks_center) {
        let filtered_peaks_recon = all_spectra[index].recon_peaks.filter((value, i) =>
            (all_spectra[index].recon_peaks_center[i] + reference >= x_ppm_visible_start) &&
            (all_spectra[index].recon_peaks_center[i] + reference <= x_ppm_visible_end)
        );
        main_plot.update_reconstructed_peaks(filtered_peaks_recon);
    }
}
