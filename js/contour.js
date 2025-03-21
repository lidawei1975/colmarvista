    importScripts('https://d3js.org/d3.v7.min.js');

    onmessage = (e) => {

        if(e.data.remove_spectrum)
        {
            postMessage({remove_spectrum: e.data.remove_spectrum});
        }
        else if(e.data.spectrum.levels.length === 0)
        {
            /**
             * if levels are empty, we received an empty spectrum
             * return an object will empty data
             */
            let workerResult = {};
            workerResult.polygon_length = [];
            workerResult.levels_length = [];
            workerResult.spectrum_type = e.data.spectrum.spectrum_type;
            workerResult.spectrum_index = e.data.spectrum.spectrum_index;
            workerResult.contour_sign = e.data.spectrum.contour_sign;
            workerResult.spectrum_origin = e.data.spectrum.spectrum_origin;
            workerResult.points = new Float32Array([]);
            postMessage(workerResult);
        }
        else
        {
            postMessage({ message: "Calculating contour" });
            let workerResult = {};
            process_spectrum_data(e.data.response_value, e.data.spectrum, workerResult);
            postMessage(workerResult);
        }
    };


    function process_spectrum_data(response_value, spectrum, workerResult) {

        /**
         * if spectrum.contour_sign === 1 (negative contour), we need to *-1 to the levels and the response_value
         * BUG is d3.contours() does not work with negative values properly !!
         */
        if (spectrum.contour_sign === 1) {
            for (let i = 0; i < spectrum.levels.length; i++) {
                spectrum.levels[i] = -spectrum.levels[i];
            }
            for (let i = 0; i < response_value.length; i++) {
                response_value[i] = -response_value[i];
            }
        }


        let polygons = d3.contours().size([spectrum.n_direct, spectrum.n_indirect]).thresholds(spectrum.levels)(response_value);
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