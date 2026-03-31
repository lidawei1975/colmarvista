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


        for (let i = 0; i < event.data.peaks.length; ++i) {
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
            const length_of_half = Math.floor((profile_size - 1) / 2);
            /**
             * Get corresponding ppm values for the profile, using JS code, not C++ code
             */
            let profile_ppm = new Float32Array(profile_size);
            profile_ppm[length_of_half] = event.data.peaks[i][0]; // Center ppm value
            for (let j = 0; j < length_of_half; ++j) {
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

        /**
         * n_verbose is a global variable (static base class member variable) in Module, which is used to control the verbosity of the output.
         */
        Module.shared_data_1d.n_verbose = 1;

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

        obj.read_first_spectrum_from_buffer(spectrum_header, spectrum_data, spectrum_data_imaginary); // Read the first spectrum from buffer

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
    else if (event.data.webassembly_job === "peak_fitter") {
        // This is for peak fitting job
        console.log('Peak fitting job received');
        Module.shared_data_1d.n_verbose = 1;
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
        if (event.data.flag === 1) {
            fit_type = 1; // Gaussian
        }
        else if (event.data.flag === 0) {
            fit_type = 2; // Voigt
        }
        else if (event.data.flag === 2) {
            fit_type = 3; // Lorentzian
        }

        obj.init_fit(fit_type, event.data.maxround, event.data.peak_combine_cutoff);

        obj.init_error(2/**ZF */, 0/**round in error est, 0 means not run at all*/);


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
        obj.peak_reading_from_string(event.data.picked_peaks, 0/**type is .tab */);

        // Run the peak fitting algorithm
        obj.peak_fitting(event.data.spectrum_begin, event.data.spectrum_end);

        // Get the fitted peaks as a long string in NMRPipe tab format
        const fitted_peaks_tab = obj.output_as_string(-1); // -1 means normal run without error estimation
        const fitted_peaks_json = obj.output_json_as_string(true); // true means with individual peaks

        // get size of reconstructed spectrum in float32
        const size = obj.get_size_of_recon();
        const ptr = obj.get_data_of_recon(0);
        // const float32_recon = new Float32Array(Module.HEAPF32.buffer, ptr, size);

        const vec = obj.spe_recon; //exposed vector of float32

        const float32_recon = new Float32Array(vec.size());
        for (let i = 0; i < vec.size(); ++i) {
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

    /**
     * v2 peak fitting region job: wasm only.
     * Main thread prepares partitioned regions and submits one job per region.
     */
    else if (event.data.webassembly_job === "peak_fitter_region_v2") {
        try {
            const obj = new Module.gaussian_fit();

            const erfcApprox = function (x) {
                const z = Math.abs(x);
                const t = 1.0 / (1.0 + 0.5 * z);
                let p = 0.17087277;
                p = -0.82215223 + t * p;
                p = 1.48851587 + t * p;
                p = -1.13520398 + t * p;
                p = 0.27886807 + t * p;
                p = -0.18628806 + t * p;
                p = 0.09678418 + t * p;
                p = 0.37409196 + t * p;
                p = 1.00002368 + t * p;
                const ans = t * Math.exp(-z * z - 1.26551223 + t * p);
                return x >= 0 ? ans : (2.0 - ans);
            };

            const voigtAtZero = function (sigma, gamma) {
                const s = Math.abs(Number(sigma));
                const g = Math.abs(Number(gamma));
                if (!Number.isFinite(s) || !Number.isFinite(g)) {
                    return 0.0;
                }
                const tiny = 1e-12;
                if (s < tiny && g < tiny) {
                    return 0.0;
                }
                if (s < tiny) {
                    return 1.0 / (Math.PI * Math.max(g, tiny));
                }
                if (g < tiny) {
                    return 1.0 / (s * Math.sqrt(2.0 * Math.PI));
                }
                const a = g / (s * Math.sqrt(2.0));
                return Math.exp(a * a) * erfcApprox(a) / (s * Math.sqrt(2.0 * Math.PI));
            };

            const convertAmpToHeightVolume = function (amp, sx, sy, gx, gy, peakShape) {
                const a = Number.isFinite(amp) ? amp : 0.0;
                const sxv = Number.isFinite(sx) ? Math.abs(sx) : 0.0;
                const syv = Number.isFinite(sy) ? Math.abs(sy) : 0.0;
                const gxv = Number.isFinite(gx) ? Math.abs(gx) : 0.0;
                const gyv = Number.isFinite(gy) ? Math.abs(gy) : 0.0;

                // Internal amp meaning from C++ gaussian_fit depends on peak shape.
                // v2 mapping: 0=Gaussian, 1=Voigt, 3=Voigt-Lorentz.
                //   shape 0: amp is already HEIGHT
                //   shape 1: amp is volume-like, HEIGHT = amp*voigt(0,sx,gx)*voigt(0,sy,gy)
                //   shape 3: amp is volume-like, HEIGHT = amp*voigt(0,sx,gx)
                if (peakShape === 0) {
                    return {
                        height: a,
                        volume: a * 2.0 * Math.PI * sxv * syv
                    };
                }
                if (peakShape === 3) {
                    return {
                        height: a * voigtAtZero(sxv, gxv),
                        volume: a
                    };
                }
                return {
                    height: a * voigtAtZero(sxv, gxv) * voigtAtZero(syv, gyv),
                    volume: a
                };
            };

            obj.set_everything_wasm(event.data.peak_shape, event.data.maxround, event.data.cluster_counter);

            const spect_parts = new Module.VectorDouble();
            for (let i = 0; i < event.data.spect_parts.length; ++i) {
                spect_parts.push_back(event.data.spect_parts[i]);
            }

            const aas = new Module.VectorDouble();
            // event.data.aas carries region.amp from main thread.
            // Layout: [peak0_s0, peak0_s1, ..., peak1_s0, ...].
            for (let i = 0; i < event.data.aas.length; ++i) {
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

            obj.init(
                event.data.min1, event.data.min2,
                event.data.size1, event.data.size2,
                event.data.nspect,
                spect_parts, xx, yy, aas, sx, sy, gx, gy,
                ori_index, region_peak_cannot_move_flag,
                event.data.median_width_x, event.data.median_width_y
            );

            obj.set_peak_paras(
                event.data.wx * 1.5,
                event.data.wy * 1.5,
                event.data.noise_level,
                event.data.noise_level * event.data.user_scale2,
                event.data.too_near_cutoff,
                event.data.step1,
                event.data.step2,
                event.data.removal_cutoff
            );

            obj.peak_sign = event.data.peak_sign;
            obj.run(1);

            const nspect = event.data.nspect;
            let p1 = new Float32Array(obj.npeak);
            let p2 = new Float32Array(obj.npeak);
            let group = new Int32Array(obj.npeak);
            let nround = new Int32Array(obj.npeak);
            let p_intensity = new Float32Array(obj.npeak);
            let p_volume = new Float32Array(obj.npeak);
            let sigmax = new Float32Array(obj.sigmax.size());
            let sigmay = new Float32Array(obj.sigmay.size());
            let peak_index = new Int32Array(obj.original_ndx.size());
            let err = new Float32Array(obj.err.size());
            let gammax = new Float32Array(obj.gammax.size());
            let gammay = new Float32Array(obj.gammay.size());
            let p_intensity_all_spectra = new Float32Array(obj.npeak * nspect);

            for (let i = 0; i < obj.npeak; i++) {
                p1[i] = obj.x.get(i) + obj.xstart;
                p2[i] = obj.y.get(i) + obj.ystart;
                group[i] = event.data.cluster_counter;
                nround[i] = obj.get_nround();
                const sx0 = obj.sigmax.get(i);
                const sy0 = obj.sigmay.get(i);
                const gx0 = obj.gammax.get(i);
                const gy0 = obj.gammay.get(i);
                const amp0 = obj.amp.get(i * nspect);
                // obj.amp is C++ internal fitted amp (shape-dependent meaning above).
                // Convert it into explicit table HEIGHT and VOLUME columns.
                const hv = convertAmpToHeightVolume(amp0, sx0, sy0, gx0, gy0, event.data.peak_shape);
                p_intensity[i] = hv.height;
                p_volume[i] = hv.volume;
                sigmax[i] = obj.sigmax.get(i);
                sigmay[i] = obj.sigmay.get(i);
                peak_index[i] = obj.original_ndx.get(i);
                err[i] = obj.err.get(i);
                gammax[i] = obj.gammax.get(i);
                gammay[i] = obj.gammay.get(i);
                for (let j = i * nspect; j < (i + 1) * nspect; j++) {
                    // Keep raw internal fitted amp for all spectra.
                    // For non-Gaussian shapes this is volume-like, not direct apex height.
                    p_intensity_all_spectra[j] = obj.amp.get(j);
                }
            }

            self.postMessage({
                webassembly_job: "peak_fitter_v2",
                spectrum_index: event.data.spectrum_index,
                cluster_counter: event.data.cluster_counter,
                total_jobs: event.data.total_jobs,
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
                p_volume: p_volume,
                peak_shape: event.data.peak_shape,
                p_intensity_all_spectra: p_intensity_all_spectra,
            });

            obj.delete();
        }
        catch (err) {
            self.postMessage({
                webassembly_job: event.data.webassembly_job,
                spectrum_index: event.data.spectrum_index,
                cluster_counter: event.data.cluster_counter,
                total_jobs: event.data.total_jobs,
                error: "peak_fitter_region_v2: " + err.message
            });
        }
    }

    else if (event.data.webassembly_job === "generate_recon_spectrum_v2") {
        try {
            const inten = new Module.VectorDouble();
            const sigmax = new Module.VectorDouble();
            const sigmay = new Module.VectorDouble();
            const gammax = new Module.VectorDouble();
            const gammay = new Module.VectorDouble();
            const centerx = new Module.VectorDouble();
            const centery = new Module.VectorDouble();

            for (let i = 0; i < event.data.inten.length; i++) {
                inten.push_back(event.data.inten[i]);
                sigmax.push_back(event.data.sigmax[i]);
                sigmay.push_back(event.data.sigmay[i]);
                gammax.push_back(event.data.gammax[i]);
                gammay.push_back(event.data.gammay[i]);
                centerx.push_back(event.data.centerx[i]);
                centery.push_back(event.data.centery[i]);
            }

            const vector2DNames = [
                "VectorVectorDouble",
                "VectorDoubleVector",
                "VectorVectorFloat64"
            ];

            let Spectrum2DClass = null;
            for (let i = 0; i < vector2DNames.length; i++) {
                if (typeof Module[vector2DNames[i]] === "function") {
                    Spectrum2DClass = Module[vector2DNames[i]];
                    break;
                }
            }

            if (Spectrum2DClass === null) {
                const moduleKeys = Object.keys(Module);
                for (let i = 0; i < moduleKeys.length; i++) {
                    const k = moduleKeys[i];
                    if (!/vector.*vector.*double/i.test(k)) {
                        continue;
                    }
                    if (typeof Module[k] === "function") {
                        Spectrum2DClass = Module[k];
                        break;
                    }
                }
            }

            if (Spectrum2DClass === null) {
                throw new Error("cannot find registered vector<vector<double>> type in wasm bindings");
            }

            const spectrum2d = new Spectrum2DClass();

            let ok = false;
            if (typeof Module.generate_spectrum_voigt === "function") {
                ok = Module.generate_spectrum_voigt(
                    inten,
                    sigmax,
                    sigmay,
                    gammax,
                    gammay,
                    centerx,
                    centery,
                    spectrum2d,
                    event.data.xdim_local,
                    event.data.ydim_local
                );
            }
            else if (typeof Module.gaussian_fit === "function") {
                const obj = new Module.gaussian_fit();
                if (typeof obj.generate_spectrum_voigt !== "function") {
                    obj.delete();
                    throw new Error("generate_spectrum_voigt is not exposed on gaussian_fit");
                }
                ok = obj.generate_spectrum_voigt(
                    inten,
                    sigmax,
                    sigmay,
                    gammax,
                    gammay,
                    centerx,
                    centery,
                    spectrum2d,
                    event.data.xdim_local,
                    event.data.ydim_local
                );
                obj.delete();
            }
            else {
                throw new Error("generate_spectrum_voigt binding is not found");
            }

            if (!ok) {
                throw new Error("generate_spectrum_voigt returned false");
            }

            const ydim = event.data.ydim_local;
            const xdim = event.data.xdim_local;
            const recon = new Float32Array(xdim * ydim);

            let yLimit = Math.min(ydim, spectrum2d.size());
            for (let y = 0; y < yLimit; y++) {
                const row = spectrum2d.get(y);
                const xLimit = Math.min(xdim, row.size());
                for (let x = 0; x < xLimit; x++) {
                    recon[y * xdim + x] = row.get(x);
                }
            }

            self.postMessage({
                webassembly_job: "generate_recon_spectrum_v2",
                spectrum_index: event.data.spectrum_index,
                recon_raw_data: recon,
            }, [recon.buffer]);
        }
        catch (err) {
            self.postMessage({
                webassembly_job: event.data.webassembly_job,
                spectrum_index: event.data.spectrum_index,
                error: "generate_recon_spectrum_v2: " + err.message
            });
        }
    }

    /**
     * 1D FID processing job
     */
    else if (event.data.webassembly_job === "fid_processor_1d") {
        const nspect = 1; // Assuming single spectrum for now

        Module.shared_data_1d.n_verbose = 1;

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
        let js_fid_data = null; // Reference to the underlying JS TypedArray for signal processing

        if (obj.get_fid_data_type() === 2) {
            /**
             * Double (float64) data type in e.data.fid_data,
             * convert every 8 bytes to a float32 number.
             * Remember that e.data.fid_data is Uint8Array, need to view it as a float64 array.
             */
            const fid_data_double = new Float64Array(event.data.fid_buffer);
            js_fid_data = fid_data_double;
            for (let i = 0; i < fid_data_double.length; ++i) {
                fid_data.push_back(fid_data_double[i]);
            }
        }
        else if (obj.get_fid_data_type() === 0) {
            /**
             * Int (int32) data type in e.data.fid_data,
             * convert every 4 bytes to a int32 number.
             */
            const fid_data_int = new Int32Array(event.data.fid_buffer);
            js_fid_data = fid_data_int;
            for (let i = 0; i < fid_data_int.length; ++i) {
                fid_data.push_back(fid_data_int[i]);
            }
        }

        obj.set_fid_data(fid_data);
        let reduced_fid_size = 0;

        if (event.data.reduced_fid_size > 0) {
            console.log('Reducing FID size to ' + event.data.reduced_fid_size);
            obj.reduce_fid_size(event.data.reduced_fid_size);
            reduced_fid_size = event.data.reduced_fid_size;
        }

        obj.run_zf(event.data.zf_direct); // Zero filling
        obj.run_fft_and_rm_bruker_filter(); // FFT and remove Bruker filter. This is the main processing step

        let p0 = event.data.phase_correction_direct_p0;
        let p1 = event.data.phase_correction_direct_p0 + event.data.phase_correction_direct_p1;

        /**
         * Automatic phase correction part.
         */
        if (event.data.auto_direct_2 || event.data.auto_direct_3) {
            /**
             * Only run Entropy minimization based automatic phase correction part.
             */
            obj.set_up_parameters(0/**n_iter, 0 means not run */, 10/** n_peak used */, 3/**n_dis, 1=500,2=1000 */, true/**b_end */, false/**b_smooth_baseline */);
            obj.auto_phase_correction();
            const v = obj.get_phase_correction(); // Get the phase correction parameters as a vector of float32

            p0 = v.get(0);
            p1 = v.get(1);
        }
        else if (event.data.auto_direct) {
            obj.set_up_parameters(5/**n_iter, 0 means not run */, 10/** n_peak used */, 3/**n_dis, 1=500,2=1000 */, true/**b_end */, false/**b_smooth_baseline */);
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
            reduced_fid_size: reduced_fid_size, // The reduced FID size after auto reduction or manual reduction
            auto_direct: event.data.auto_direct,
            auto_direct_2: event.data.auto_direct_2, // need to know which auto pc method was used, if _2: need to run tfjs code in main thread.
            fid_json: fid_json,
            spectrum_header: header_data,
            real_spectrum_data: real_spectrum_data,
            image_spectrum_data: image_spectrum_data,
            reprocess: event.data.reprocess, // reprocess is a boolean flag to indicate whether this is a reprocessing job
            spectrum_index: event.data.spectrum_index, // spectrum index is the index of the spectrum in the list of spectra
            p0: p0,
            p1: p1 - p0, // p1 from C++ code is PC at the right end, so p1 is p1 - p0 in traditional NMRPipe format
        });

        obj.delete(); // Clean up the object to free memory
    }

    else if (event.data.webassembly_job === "baseline_correction") {

        console.log('Baseline correction job received');
        Module.shared_data_1d.n_verbose = 1;
        const obj = new Module.spectrum_baseline_1d();


        // for baseline, these values are ignored, but need to call  init.
        obj.init(5.5, 3.0, 0.0);


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

        /**
         * Main function to do baseline correction
         * work(a0,b0,n_water,method,outfname_baseline);
         */
        obj.work(event.data.a0, event.data.b0, event.data.n_water, 0 /** 0 only at this time */, "none" /** no file output */);

        const baseline_size = event.data.spectrum_data.length; //baseline has same size as original spectrum
        const baseline_ptr = obj.get_data_of_baseline(0); // Get the pointer to the baseline data
        const baseline = new Float32Array(Module.HEAPF32.buffer, baseline_ptr, baseline_size);

        self.postMessage({
            webassembly_job: event.data.webassembly_job,
            spectrum_index: event.data.spectrum_index,
            baseline: baseline,
        });

        // Clean up the object to free memory
        obj.delete(); // Clean up the object to free memory
    }


    /**
     * 2D Peak Picking using JS-driven spectrum_pick class (webdp1d_cpp module).
     * Follows the C++ workflow:
     *   spectrum_pick x;
     *   x.set_scale(user_scale, user_scale2);
     *   x.set_scale_negative(user_scale_negative, user_scale2_negative);
     *   x.set_model_selection(model_selection);
     *   if (x.read_first_spectrum_from_buffer(spectrum_vec)) {
     *       if (noise_level > 1e-20) x.set_noise_level(noise_level);
     *       if (b_auto_ppp) x.adjust_ppp_of_spectrum(target_width);
     *       x.ann_peak_picking(debug_flag1, t1_flag, b_negative);
     *       peaks_tab = x.print_peaks_as_string();
     *   }
     */
    else if (event.data.webassembly_job === "peak_picker_2d") {

        const obj = new Module.spectrum_pick();

        /**
         * Set scale and model selection parameters
         * flag: 0 = DEEP Picker (model 2, target_width=6), 1 = DEEP Picker (model 1, target_width=12)
         */
        obj.set_scale(event.data.scale, event.data.scale2);
        obj.set_scale_negative(event.data.scale_negative, event.data.scale2_negative);
        obj.set_model_selection(2); // 2 = DEEP Picker (model 2, target_width=6)

        /**
         * Convert the Uint8Array ft2 binary into separate header and data VectorFloat objects.
         * NMRPipe .ft2 format: first 512 float32s are the header, the rest is spectrum data.
         * C++ signature: read_first_spectrum_from_buffer(vector<float> header, vector<float> data)
         */
        const HEADER_SIZE = 512; // NMRPipe header is always 512 float32 words
        const spectrum_float32 = new Float32Array(event.data.spectrum_data.buffer,
            event.data.spectrum_data.byteOffset,
            event.data.spectrum_data.byteLength / 4);

        const header_vec = new Module.VectorFloat();
        for (let i = 0; i < HEADER_SIZE; i++) {
            header_vec.push_back(spectrum_float32[i]);
        }

        const data_vec = new Module.VectorFloat();
        for (let i = HEADER_SIZE; i < spectrum_float32.length; i++) {
            data_vec.push_back(spectrum_float32[i]);
        }

        if (obj.read_first_spectrum_from_buffer(header_vec, data_vec)) {

            /**
             * Set noise level if provided
             */
            if (event.data.noise_level > 1e-20) {
                obj.set_noise_level(event.data.noise_level);
            }

            obj.adjust_ppp_of_spectrum(6.0); // 6.0 is the default value for target_width for model 2 (see above)

            /**
             * The main working function for peak picking
             * flag: 0: run special case using line angle, 1: not run. 2: inertia based method
             * flag_t1_noise: 0: not run, 1: run (column by column noise estimation)
             * b_negative: true: also pick negative peaks (false: not pick negative peaks
            */
            const t1_flag = 1 ? 0 : (event.data.remove_t1_noise === "yes");
            obj.ann_peak_picking(0, t1_flag, true);

            /**
             * Retrieve picked peaks as NMRPipe tab format string
             */
            const peaks_tab = obj.print_peaks_as_string();

            self.postMessage({
                webassembly_job: event.data.webassembly_job,
                picked_peaks_tab: peaks_tab,
                spectrum_index: event.data.spectrum_index,
                scale: event.data.scale,
                scale2: event.data.scale2
            });
        }
        else {
            self.postMessage({ error: 'peak_picker_2d: init_from_buffer failed' });
        }

        header_vec.delete();
        data_vec.delete();
        obj.delete();
    }

    else {
        // Handle other jobs or errors
        self.postMessage({ error: 'Unknown webassembly job type' });
    }
};

/**
 * Detect the end of the FID signal.
 * 
 * Algorithm:
 * 1. Skip first 150 points.
 * 2. Use moving max and moving min (window size = min(256, N/1024)) to extract envelope.
 * 3. Rough signal end: where envelope drops below 1% of max amplitude (A0).
 * 4. Noise estimation:
 *    - Region: from rough signal end to N.
 *    - Method: Split into segments of length 32. Calculate StdDev (RMSD) for each.
 *    - Noise Level = Median of these StdDevs.
 * 5. Final cutoff: where envelope drops below max(2 * Noise, 0.001 * A0).
 * 
 * @param {Float32Array} fid_data - The FID data.
 * @returns {number} The index where the signal ends.
 */

