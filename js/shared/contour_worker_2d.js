/**
 * contour_worker_2d.js
 * 
 * Unified 2D Marching Squares Web Worker for both COLMARvista and SPIN.
 * Calculates iso-contour line vertices using D3's marching squares algorithm.
 */

importScripts('https://d3js.org/d3.v7.min.js');

onmessage = (e) => {
    // 1. Remove spectrum message (COLMARvista multi-spectra removal)
    if (e.data && e.data.remove_spectrum) {
        postMessage({ remove_spectrum: e.data.remove_spectrum });
        return;
    }

    // 2. Remove simulated spectrum message (SPIN query/simulation)
    if (e.data && e.data.spectrum && e.data.spectrum.spectrum_type === "remove_simulated") {
        postMessage({ message: "remove_simulated" });
        return;
    }

    // 3. Simulated contour passthrough (SPIN pre-computed contours)
    if (e.data && e.data.spectrum && e.data.spectrum.spectrum_type === "simulated") {
        let workerResult = {
            points: e.data.response_value,
            spectrum_type: e.data.spectrum.spectrum_type,
            spectrum_index: e.data.spectrum.spectrum_index,
            contour_sign: e.data.spectrum.contour_sign,
            levels_length: e.data.spectrum.levels_length,
            polygon_length: e.data.spectrum.polygon_length,
        };
        postMessage(workerResult);
        return;
    }

    // 4. Empty spectrum handling
    if (!e.data || !e.data.spectrum || !e.data.spectrum.levels || e.data.spectrum.levels.length === 0) {
        let workerResult = {
            polygon_length: [],
            levels_length: [],
            spectrum_type: e.data && e.data.spectrum ? e.data.spectrum.spectrum_type : null,
            spectrum_index: e.data && e.data.spectrum ? e.data.spectrum.spectrum_index : null,
            contour_sign: e.data && e.data.spectrum ? e.data.spectrum.contour_sign : null,
            spectrum_origin: e.data && e.data.spectrum ? e.data.spectrum.spectrum_origin : null,
            points: new Float32Array([])
        };
        postMessage(workerResult);
        return;
    }

    // 5. Standard contour calculation
    let specType = e.data.spectrum.spectrum_type || "contour";
    postMessage({
        message: "Calculating " + specType,
        spectrum_type: e.data.spectrum.spectrum_type,
        spectrum_index: e.data.spectrum.spectrum_index,
        contour_sign: e.data.spectrum.contour_sign
    });

    let workerResult = {};
    process_spectrum_data(e.data.response_value, e.data.spectrum, workerResult);
    postMessage(workerResult, (workerResult.points && workerResult.points.buffer) ? [workerResult.points.buffer] : []);
};

function process_spectrum_data(response_value, spectrum, workerResult) {
    /**
     * If spectrum.contour_sign === 1 (negative contour), invert levels and response values
     * because d3.contours() does not properly handle negative values.
     */
    if (spectrum.contour_sign === 1) {
        for (let i = 0; i < spectrum.levels.length; i++) {
            spectrum.levels[i] = -spectrum.levels[i];
        }
        for (let i = 0; i < response_value.length; i++) {
            response_value[i] = -response_value[i];
        }
    }

    let polygons = d3.contours()
        .size([spectrum.n_direct, spectrum.n_indirect])
        .thresholds(spectrum.levels)(response_value);

    let polygon_2d = [];
    workerResult.polygon_length = [];
    workerResult.levels_length = [];

    for (let m = 0; m < polygons.length; m++) {
        for (let i = 0; i < polygons[m].coordinates.length; i++) {
            for (let j = 0; j < polygons[m].coordinates[i].length; j++) {
                let coors2 = polygons[m].coordinates[i][j];
                polygon_2d = polygon_2d.concat(coors2);
                workerResult.polygon_length.push(polygon_2d.length);
            }
        }
        workerResult.levels_length.push(workerResult.polygon_length.length);
    }

    let polygon_1d = new Array(polygon_2d.length * 2);
    for (let i = 0; i < polygon_2d.length; i++) {
        polygon_1d[i * 2] = polygon_2d[i][0];
        polygon_1d[i * 2 + 1] = polygon_2d[i][1];
    }
    workerResult.points = new Float32Array(polygon_1d);

    workerResult.spectrum_type = spectrum.spectrum_type;
    workerResult.spectrum_index = spectrum.spectrum_index;
    workerResult.contour_sign = spectrum.contour_sign;
    workerResult.spectrum_origin = spectrum.spectrum_origin;
}

