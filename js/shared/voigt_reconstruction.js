/**
 * NMR 1D Voigt Reconstruction Tools (Shared Module)
 * Debounced summation of fitted Voigt profiles for reconstructed spectrum display.
 */
let zoomPanTimeout; // to debounce zoom and pan events
function update_reconstructed_peaks_debounced(index) {
    clearTimeout(zoomPanTimeout);

    // Set a new timeout
    zoomPanTimeout = setTimeout(() => {
        let targetIndex = index;
        if (targetIndex === undefined) {
            targetIndex = (typeof current_spectrum_index_of_peaks !== 'undefined' && current_spectrum_index_of_peaks >= 0)
                ? current_spectrum_index_of_peaks : 1;
        }
        update_reconstructed_peaks(targetIndex);
    }, 100);
}

function update_reconstructed_peaks(index) {
    if (!main_plot || !all_spectra) return;

    // Resolve which spectrum contains recon_peaks
    let targetIndex = index;
    if (targetIndex === undefined || !all_spectra[targetIndex] || !all_spectra[targetIndex].recon_peaks) {
        if (typeof current_spectrum_index_of_peaks !== 'undefined' && current_spectrum_index_of_peaks >= 0 && all_spectra[current_spectrum_index_of_peaks] && all_spectra[current_spectrum_index_of_peaks].recon_peaks) {
            targetIndex = current_spectrum_index_of_peaks;
        } else if (all_spectra[1] && all_spectra[1].recon_peaks) {
            targetIndex = 1;
        } else {
            const foundIdx = all_spectra.findIndex(s => s && s.recon_peaks && s.recon_peaks.length > 0);
            if (foundIdx >= 0) targetIndex = foundIdx;
        }
    }

    if (targetIndex === undefined || !all_spectra[targetIndex]) return;
    index = targetIndex;

    main_plot.update_reconstructed_peaks([]);

    if (main_plot.peak_type !== "fitted") {
        return;
    }

    /**
     * If picked peaks, do nothing
     */
    if (typeof current_flag_of_peaks !== 'undefined' && current_flag_of_peaks === 'picked') {
        return;
    }

    const domain = main_plot.get_visible_region();
    if (!domain || domain.length < 2) return;
    const min_ppm = Math.min(domain[0], domain[1]);
    const max_ppm = Math.max(domain[0], domain[1]);
    const ppm_span = max_ppm - min_ppm;
    const plot_width = main_plot.true_width || main_plot.width || 1600;

    let median_peak_width_pixel = 0;
    if (all_spectra[index].fitted_peaks_object && typeof all_spectra[index].fitted_peaks_object.get_column_by_header === "function") {
        const all_peak_widths = all_spectra[index].fitted_peaks_object.get_column_by_header("XW").sort((a, b) => a - b);
        const median_peak_width = all_peak_widths[all_peak_widths.length >> 1] * Math.abs(all_spectra[index].x_ppm_step);
        median_peak_width_pixel = ppm_span > 0 ? (median_peak_width / ppm_span * plot_width) : 0;
    } else if (all_spectra[index].median_fwhh) {
        median_peak_width_pixel = ppm_span > 0 ? (all_spectra[index].median_fwhh / ppm_span * plot_width) : 0;
    }

    const reference = all_spectra[index].x_ppm_ref || 0.0;
    if (all_spectra[index].recon_peaks && all_spectra[index].recon_peaks_center) {
        let filtered_peaks_recon = all_spectra[index].recon_peaks.filter((value, i) => {
            const center = all_spectra[index].recon_peaks_center[i] + reference;
            return center >= min_ppm && center <= max_ppm;
        });

        // Always render visible peak profiles when zoomed in or when count is reasonable
        if (median_peak_width_pixel > 1.0 || filtered_peaks_recon.length <= 300) {
            main_plot.update_reconstructed_peaks(filtered_peaks_recon);
        }
    }
}
