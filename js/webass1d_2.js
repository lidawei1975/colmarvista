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

    else if (event.data.webassembly_job == "generate_voigt_profiles") {
        const obj = new Module.voigt_profile();


        for(let i = 0; i < event.data.peaks.length; ++i) {
            obj.generate_voigt_profiles(
                0.01, //extend until y drops below 0.01 of central peak height
                event.data.step, //step size
                event.data.peaks[i][0], //center ppm
                event.data.peaks[i][1], //height
                event.data.peaks[i][2], //sigma in ppm
                event.data.peaks[i][3]); //gamma in ppm

            /**
             * Get profile as a float32 array
             */
            const profile_size = obj.get_size_of_profile();
            const profile_ptr = obj.get_data_of_profile(0); // Get the pointer to the profile data
            const profile_data = new Float32Array(Module.HEAPF32.buffer, profile_ptr, profile_size);    
            /**
             * Because of symmetry, profile_size is always odd, so we can get the center index
             */
            const length_of_half = Math.floor((profile_size-1) / 2);
            /**
             * Get corresponding ppm values for the profile, using JS code, not C++ code
             */
            let profile_ppm = new Float32Array(profile_size);
            profile_ppm[length_of_half] = event.data.peaks[i][0]; // Center ppm value
            for(let j = 0; j < length_of_half; ++j) {
                profile_ppm[j] = event.data.peaks[i][0] - (length_of_half - j) * event.data.step;
                profile_ppm[profile_size - 1 - j] = event.data.peaks[i][0] + (length_of_half - j) * event.data.step;
            }

            self.postMessage({
                webassembly_job: event.data.webassembly_job,
                profile_index: i, // Index of the profile
                profile_ppm: profile_ppm,
                profile_data: profile_data,
            });
        }
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

        const spectrum_header = new Module.VectorFloat();
        for (let i = 0; i < event.data.spectrum_header.length; ++i) {
            spectrum_header.push_back(event.data.spectrum_header[i]);
        }

        /**
         * Create a empty Module.VectorFloat() as imaginary part of the spectrum data, which we do not need but c++ need to have 3 parameters
         */
        const spectrum_data_imaginary = new Module.VectorFloat(); // Empty imaginary part, we do not need it in 1D spectrum picking

        obj.init_mod(event.data.mod); //DNN model 1 or model 2 

        obj.read_first_spectrum_from_buffer(spectrum_header, spectrum_data,spectrum_data_imaginary); // Read the first spectrum from buffer

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

        
        /**
         * Need to convert event.data.spectrum_data (Float32Array) to webassembly VectorFloat
         */
        const spectrum_data = new Module.VectorFloat();
        for (let i = 0; i < event.data.spectrum_data.length; ++i) {
            spectrum_data.push_back(event.data.spectrum_data[i]);
        }

        const spectrum_header = new Module.VectorFloat();
        for (let i = 0; i < event.data.spectrum_header.length; ++i) {
            spectrum_header.push_back(event.data.spectrum_header[i]);
        }

        /**
         * Create a empty Module.VectorFloat() as imaginary part of the spectrum data, which we do not need but c++ need to have 3 parameters
         */
        const spectrum_data_imaginary = new Module.VectorFloat(); // Empty imaginary part, we do not need it in 1D spectrum picking

        // Read the first spectrum from buffer
        obj.read_first_spectrum_from_buffer(spectrum_header, spectrum_data, spectrum_data_imaginary);
        obj.prepare_to_read_additional_spectrum_from_buffer(false); // false means no negative peak picking


        // Set the picked peaks from the tab string
        obj.peak_reading_from_string(event.data.picked_peaks,0/**type is .tab */);

        // Run the peak fitting algorithm
        obj.peak_fitting(event.data.spectrum_begin, event.data.spectrum_end);

        // Get the fitted peaks as a long string in NMRPipe tab format
        const fitted_peaks_tab = obj.output_as_string(-1); // -1 means normal run without error estimation
        // const fitted_peaks_json = obj.output_json_as_string(true); // true means with individual peaks

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
            // recon_json: fitted_peaks_json,
            spectrum_origin: event.data.spectrum_index,
            scale: event.data.scale,
            scale2: event.data.scale2,
            recon_spectrum: float32_recon,
        });

        // Clean up the object to free memory
        obj.delete(); // Clean up the object to free memory
    }
    /**
     * This is part of 2D VF workflow. Fitting of one region (correlated peaks) only, not the full 2D spectrum.
     */
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

    /**
     * 1D FID processing job
     */
    else if(event.data.webassembly_job === "fid_processor_1d") {
         const nspect = 1; // Assuming single spectrum for now

        const obj = new Module.spectrum_phasing_1d(); //spectrum_phasing_1d has fid_1d as its base class for FID processing

        /**
         * Passed variables:
         *                 
         *      acquisition_string: acquisition_string,
                fid_data: fid_data, //Uint8Array
                apodization_string: apodization_string,
                zf_direct: zf_direct,
                phase_correction_direct_p0: phase_correction_direct_p0,
                phase_correction_direct_p1: phase_correction_direct_p1,
                auto_direct: auto_direct,
                delete_imaginary: delete_imaginary,
                pseudo_2d_process: pseudo_2d_process,
         */

        
        obj.set_up_apodization_from_string(event.data.apodization_string);
        obj.read_bruker_files_as_strings(event.data.acquisition_string);

        const fid_data = new Module.VectorFloat();
        if(obj.get_fid_data_type() === 2) {
            /**
             * Double (float64) data type in e.data.fid_data,
             * convert every 8 bytes to a float32 number.
             * Remember that e.data.fid_data is Uint8Array, need to view it as a float64 array.
             */
            const fid_data_double = new Float64Array(event.data.fid_buffer);
            for (let i = 0; i < fid_data_double.length; ++i) {
                fid_data.push_back(fid_data_double[i]);
            }
        }
        else if(obj.get_fid_data_type() === 0) {
            /**
             * Int (int32) data type in e.data.fid_data,
             * convert every 4 bytes to a int32 number.
             */
            const fid_data_int = new Int32Array(event.data.fid_buffer);
            for (let i = 0; i < fid_data_int.length; ++i) {
                fid_data.push_back(fid_data_int[i]);
            }
        }

        obj.set_fid_data(fid_data);
        obj.run_zf(event.data.zf_direct); // Zero filling
        obj.run_fft_and_rm_bruker_filter(); // FFT and remove Bruker filter. This is the main processing step

        let p0= event.data.phase_correction_direct_p0;
        let p1= event.data.phase_correction_direct_p0 + event.data.phase_correction_direct_p1;

        /**
         * Automatic phase correction part.
         */
        if(event.data.auto_direct) {
            obj.set_up_parameters(5, 10, 3,true,true);
            obj.auto_phase_correction();
            const v = obj.get_phase_correction(); // Get the phase correction parameters as a vector of float32
            
            p0 = v.get(0);
            p1 = v.get(1);
        }
        else {
            obj.phase_spectrum(p0, p1); // Apply the phase correction parameters provided by the user
        }
        
        
        obj.write_nmrpipe_ft1(""); // Generate nmrPipe FT1 file header (internal data), Empty name "" means do not actually write to a file

        let fid_json = obj.write_json_as_string(); // Get the spectrum header information as JSON string

        /**
         * get_spectrum_header_data will return address of the header data in the heap
         * header_ptr, header_size, header_data are reinterpret_cast<uintptr_t> float * pointer.
         */
        const header_ptr = obj.get_data_of_header();
        const header_size = 512; //nmrPipe header size is 512 float32.
        const header_data = new Float32Array(Module.HEAPF32.buffer, header_ptr, header_size);
        const data_of_real_ptr = obj.get_data_of_real(); // Get the real part of the spectrum data
        const data_of_read_size = obj.get_ndata_frq(); // Get the size of the real part data, imaginary part has the same size
        const real_spectrum_data = new Float32Array(Module.HEAPF32.buffer, data_of_real_ptr, data_of_read_size);
        const data_of_imag_ptr = obj.get_data_of_imag(); // Get the imaginary part of the spectrum data
        const image_spectrum_data = new Float32Array(Module.HEAPF32.buffer, data_of_imag_ptr, data_of_read_size);

        self.postMessage({
            /**
             * Passthrough the webassembly job type, spectrum index, and peak assignment
             */
            webassembly_job: event.data.webassembly_job,
            fid_json: fid_json,
            spectrum_header : header_data,
            real_spectrum_data: real_spectrum_data,
            image_spectrum_data: image_spectrum_data,
            p0: p0,
            p1: p1 - p0, // p1 from C++ code is PC at the right end, so p1 is p1 - p0 in traditional NMRPipe format
        });

        obj.delete(); // Clean up the object to free memory
    }
    

    else {
        // Handle other jobs or errors
        self.postMessage({ error: 'Unknown webassembly job type' });
    }
};
