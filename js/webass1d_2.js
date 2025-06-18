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

    if (event.data.webassembly_job == "test") {
        const obj = new Module.spectrum_pick_1d();
        const result = obj.say_hello(event.data.name);
        self.postMessage({ stdout: result });
        obj.delete(); // Clean up the object to free memory
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

        self.postMessage({
            webassembly_job: event.data.webassembly_job,
            picked_peaks_tab: peaks_tab,
            spectrum_index: event.data.spectrum_index,
            scale: event.data.scale,
            scale2: event.data.scale2
        });

        // Clean up the object to free memory
        obj.delete(); // Clean up the object to free memory
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
            .function("output_json_as_string", &spectrum_fit_1d::output_json_as_string)
            .function("get_size_of_recon", &spectrum_fit_1d::get_size_of_recon)
            .function("get_data_of_recon", &spectrum_fit_1d::get_data_of_recon)
            ;
         */

        // Initialize the object with scale and scale2
        obj.init(event.data.scale, event.data.scale2, event.data.noise_level);

        let fit_type = 0; // Default fit type
        if(event.data.flag ===1){
            fit_type = 1; // Gaussian
        }
        else if(event.data.flag ===0){
            fit_type = 2; // Voigt
        }
        else if(event.data.flag ===2){
            fit_type = 3; // Lorentzian
        }

        obj.init_fit(fit_type, event.data.maxround, event.data.peak_combine_cutoff);

        obj.init_error(2/**ZF */,0/**round in error est, 0 means not run at all*/);

        
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

        // get size of reconstructed spectrum in float32
        const size = obj.get_size_of_recon();
        const ptr = obj.get_data_of_recon(0);
        // const float32_recon = new Float32Array(Module.HEAPF32.buffer, ptr, size);

        const vec=obj.spe_recon; //exposed vector of float32

        const float32_recon = new Float32Array(vec.size());
        for (let i = 0; i < vec.size(); ++i)
        {
            float32_recon[i] = vec.get(i);
        }

        self.postMessage({
            webassembly_job: event.data.webassembly_job,
            fitted_peaks_tab: fitted_peaks_tab,
            recon_json: fitted_peaks_json,
            spectrum_origin: event.data.spectrum_index,
            scale: event.data.scale,
            scale2: event.data.scale2,
            recon_spectrum: float32_recon,
        });

        // Clean up the object to free memory
        obj.delete(); // Clean up the object to free memory
    }
    else if( event.data.webassembly_job === "gaussian_fitting" ){

        const nspect = 1; // Assuming single spectrum for now

        const obj = new Module.gaussian_fit();

        /**
         * List of functions that can be used
         *  .function("init", &gaussian_fit::init)
            .function("set_everything", &gaussian_fit::set_everything)
            .function("set_peak_paras", &gaussian_fit::set_peak_parameters)
            .function("run", &gaussian_fit::run)
            .function("run_with_error_estimation", &gaussian_fit::run_with_error_estimation)
            .function("get_nround", &gaussian_fit::get_nround)

        * And list of properties that can be used (public variables in C++)

            
            .property("amp", &gaussian_fit::amp)
            .property("sigmax", &gaussian_fit::sigmax)
            .property("sigmay", &gaussian_fit::sigmay)
            .property("gammax", &gaussian_fit::gammax)
            .property("gammay", &gaussian_fit::gammay)
            .property("x", &gaussian_fit::x)
            .property("y", &gaussian_fit::y)
            .property("err", &gaussian_fit::err)
            .property("original_ndx", &gaussian_fit::original_ndx)
         */

        obj.set_everything_wasm(event.data.peak_shape, event.data.maxround, event.data.cluster_counter);

        /**
         * Need to convert event.data.spect_parts (JS array) to webassembly VectorFloat
         * convert event.data.xx (JS array) to webassembly VectorFloat
         * convert event.data.yy (JS array) to webassembly VectorFloat
         * convert event.data.aas (JS array) to webassembly VectorFloat
         * convert event.data.sx (JS array) to webassembly VectorFloat
         * convert event.data.sy (JS array) to webassembly VectorFloat
         * convert event.data.gx (JS array) to webassembly VectorFloat
         * convert event.data.gy (JS array) to webassembly VectorFloat
         * convert event.data.ori_index (JS array) to webassembly VectorInt
         */
        const spect_parts = new Module.VectorDouble();
        for (let i = 0; i < event.data.spect_parts.length; ++i) {
            spect_parts.push_back(event.data.spect_parts[i]);
        }

        const aas = new Module.VectorDouble();
        for(let i = 0; i < event.data.aas.length; ++i)
        {
            aas.push_back(event.data.aas[i]);
        }

        const xx = new Module.VectorDouble();
        const yy = new Module.VectorDouble();
        const sx = new Module.VectorDouble();
        const sy = new Module.VectorDouble();
        const gx = new Module.VectorDouble();
        const gy = new Module.VectorDouble();
        const ori_index = new Module.VectorInt();
        const region_peak_cannot_move_flag = new Module.VectorInt();
        for (let i = 0; i < event.data.xx.length; ++i) {
            xx.push_back(event.data.xx[i]);
            yy.push_back(event.data.yy[i]);
            sx.push_back(event.data.sx[i]);
            sy.push_back(event.data.sy[i]);
            gx.push_back(event.data.gx[i]);
            gy.push_back(event.data.gy[i]);
            ori_index.push_back(event.data.ori_index[i]);
            region_peak_cannot_move_flag.push_back(event.data.region_peak_cannot_move_flag[i]);
        }
        

        obj.init(event.data.min1, event.data.min2, event.data.size1, event.data.size2, event.data.nspect,
            spect_parts, xx, yy, aas, sx, sy, gx, gy, ori_index,region_peak_cannot_move_flag,
            event.data.median_width_x, event.data.median_width_y);
        obj.set_peak_paras(
            event.data.wx * 1.5, event.data.wy * 1.5,
            event.data.noise_level, event.data.noise_level * event.data.user_scale2,
            event.data.too_near_cutoff, event.data.step1, event.data.step2, event.data.removal_cutoff
        );
        obj.peak_sign = event.data.peak_sign; // 1 means positive peak fitting, -1 means negative peak fitting
        obj.run(1); //1 means first run without error estimation

        /**
         * Collect the results from the object
         */
        let p1 = new Float32Array(obj.npeak);
        let p2 = new Float32Array(obj.npeak);
        let group = new Int32Array(obj.npeak);
        let nround = new Int32Array(obj.npeak);
        let p_intensity = new Float32Array(obj.npeak);
        let sigmax = new Float32Array(obj.sigmax.size());
        let sigmay = new Float32Array(obj.sigmay.size());
        let peak_index = new Int32Array(obj.original_ndx.size());
        let err = new Float32Array(obj.err.size());
        let gammax = new Float32Array(obj.gammax.size());
        let gammay = new Float32Array(obj.gammay.size());
        let p_intensity_all_spectra = new Float32Array(obj.npeak * nspect);
        for (let i = 0; i < obj.npeak; i++)
        {
            p1[i] = obj.x.get(i) + obj.xstart;  
            p2[i] = obj.y.get(i) + obj.ystart;
            group[i] = event.data.cluster_counter;
            nround[i] = obj.get_nround();
            p_intensity[i] = obj.amp.get(i*nspect); // first spectrum intensity
            // Collecting sigmax and sigmay
            sigmax[i] = obj.sigmax.get(i);
            sigmay[i] = obj.sigmay.get(i);
            peak_index[i] = obj.original_ndx.get(i);
            err[i] = obj.err.get(i);
            gammax[i] = obj.gammax.get(i);
            gammay[i] = obj.gammay.get(i);
            for(let j=i*nspect; j<(i+1)*nspect; j++){
                p_intensity_all_spectra[j] = obj.amp.get(j)
            }
        }
        self.postMessage({
            /**
             * Passthrough the webassembly job type, spectrum index, and peak assignment
             */
            webassembly_job: event.data.webassembly_job,
            spectrum_index: event.data.spectrum_index,
            peak_assignment: event.data.peak_assignment, 

            /**
             * This is the output of the peak fitter
             */
            p1: p1,
            p2: p2,
            group: group,
            nround: nround,
            p_intensity: p_intensity,
            sigmax: sigmax,
            sigmay: sigmay,
            peak_index: peak_index,
            err: err,
            gammax: gammax,
            gammay: gammay,
            p_intensity_all_spectra: p_intensity_all_spectra,
        });

        obj.delete(); // Clean up the object to free memory
    }

    else {
        // Handle other jobs or errors
        self.postMessage({ error: 'Unknown webassembly job type' });
    }
};
