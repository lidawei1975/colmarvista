// worker.js

// Import Emscripten factory function
importScripts('webdp1d_cpp.js');


/**
 * Redirect the stdout and stderr to postMessage
 */
let ModulePromise = webdp1d_cpp({
  print: (text) => {
    // This captures C++ stdout
    // Forward it to main thread
    postMessage({ stdout: text });
  },
  printErr: (text) => {
    // This captures C++ stderr
    postMessage({ stdout: text });
  }
});

self.onmessage = async function (event) {
    // Wait for the module to be ready
    const Module = await ModulePromise;

    // === EXAMPLE ===
    // For example, create a class instance
    



    if (event.data.webassembly_job == "test") {
        const obj = new Module.spectrum_pick_1d();
        const result = obj.say_hello(event.data.name);
        self.postMessage({ stdout: result });
    }
    else if (event.data.webassembly_job == "peak_picker") {

        const obj = new Module.spectrum_pick_1d();
        obj.init(event.data.scale,
            event.data.scale2,
            event.data.noise_level);

        /**
         * Need to convert event.data.spectrum_data (Float32Array) to webassembly VectorFloat
         */
        const spectrum_data = new Module.VectorFloat();
        for (let i = 0; i < event.data.spectrum_data.length; ++i) {
            spectrum_data.push_back(event.data.spectrum_data[i]);
        }

        obj.init_mod(event.data.mod); //DNN model 1 or model 2 

        obj.read_first_spectrum_from_buffer(spectrum_data); //float32  array of spectral file (.ft1 format)

        obj.adjust_ppp_of_spectrum(6.0);  //set desired median peak width to 6.0 (model 2) or 12.0 (model 1)

        obj.spectrum_pick_1d_work(false); // run the peak picking algorithm, false mean no negative peak picking

        // Get the picked peaks as a long string in NMRPipe tab format
        const peaks_tab = obj.print_peaks_as_string();

        self.postMessage({ peaks_tab: peaks_tab });

        self.postMessage({
            webassembly_job: event.data.webassembly_job,
            picked_peaks_tab: peaks_tab,
            spectrum_index: event.data.spectrum_index,
            scale: event.data.scale,
            scale2: event.data.scale2
        });
    }
    else if( event.data.webassembly_job === "peak_fitter" ) {
        // This is for peak fitting job
        console.log('Peak fitting job received');
        const obj = new Module.spectrum_fit_1d();

        /**
         *  Here it is list of functions that can be used
         *  .function("init", &spectrum_fit_1d::init)
            .function("init_fit", &spectrum_fit_1d::init_fit)  //int (1: gaussian, 2: voigt, 3: lorentzian), int round, float to_near_cutoff
            .function("init_error", &spectrum_fit_1d::init_error)
            .function("read_first_spectrum_from_buffer",&spectrum_fit_1d::read_first_spectrum_from_buffer)
            .function("peak_reading_from_string", &spectrum_fit_1d::peak_reading_from_string)
            .function("peak_fitting", &spectrum_fit_1d::peak_fitting)
            .function("output_as_string", &spectrum_fit_1d::output_as_string)
            .function("output_json_as_string", &spectrum_fit_1d::output_json_as_string);
         */

        // Initialize the object with scale and scale2
        obj.init(event.data.scale, event.data.scale2, event.data.noise_level);

        let fit_type = 0; // Default fit type
        if(event.data.flag ===0){
            fit_type = 1; // Gaussian
        }
        else if(event.data.flag ===1){
            fit_type = 2; // Voigt
        }
        else if(event.data.flag ===2){
            fit_type = 3; // Lorentzian
        }

        obj.init_fit(fit_type, event.data.maxround, event.data.peak_combine_cutoff);

        obj.init_error(2/**ZF */,1/**round, must >=5 to active */);

        
        // Read the spectrum data from the buffer
        const spectrum_data = new Module.VectorFloat();
        for (let i = 0; i < event.data.spectrum_data.length; ++i) {
            spectrum_data.push_back(event.data.spectrum_data[i]);
        }

        // Read the first spectrum from buffer
        obj.read_first_spectrum_from_buffer(spectrum_data);
        obj.prepare_to_read_additional_spectrum_from_buffer(false); // false means no negative peak picking


        // Set the picked peaks from the tab string
        obj.peak_reading_from_string(event.data.picked_peaks,0/**type is .tab */);

        // Run the peak fitting algorithm
        obj.peak_fitting(event.data.spectrum_begin, event.data.spectrum_end);

        // Get the fitted peaks as a long string in NMRPipe tab format
        const fitted_peaks_tab = obj.output_as_string(-1); // -1 means normal run without error estimation
        const fitted_peaks_json = obj.output_json_as_string(true); // true means with individual peaks

        self.postMessage({
            webassembly_job: event.data.webassembly_job,
            fitted_peaks_tab: fitted_peaks_tab,
            recon_json: fitted_peaks_json,
            spectrum_origin: event.data.spectrum_index,
            scale: event.data.scale,
            scale2: event.data.scale2
        });
    }
};
