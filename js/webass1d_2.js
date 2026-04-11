// worker.js

// Import Emscripten factory function
importScripts('peak_shape_utils.js');
importScripts('gaussian_fit_worker_bridge.js');
importScripts('webdp1d_cpp.js');

const WEBASSEMBLY_JOB_KEY = "#sym:webassembly_job ";

function getWebassemblyJob(data) {
    if (!data) {
        return undefined;
    }
    return data[WEBASSEMBLY_JOB_KEY] || data.webassembly_job;
}

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
    const webassembly_job = getWebassemblyJob(event.data);
    // Wait for the module to be ready
    const Module = await ModulePromise;

    if (webassembly_job == "test") {
        const obj = new Module.spectrum_pick_1d();
        const result = obj.say_hello(event.data.name);
        self.postMessage({ stdout: result });
        obj.delete(); // Clean up the object to free memory
    }

    else if (webassembly_job == "generate_voigt_profiles") {
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
                [WEBASSEMBLY_JOB_KEY]: webassembly_job,
                profile_index: i, // Index of the profile
                profile_ppm: profile_ppm,
                profile_data: profile_data,
            });
        }
        obj.delete(); // Clean up the object to free memory
    }

    else if (webassembly_job === "nus_step2") {
        try {
            const toInt = function (value, fallbackValue) {
                const parsed = parseInt(value, 10);
                return Number.isFinite(parsed) ? parsed : fallbackValue;
            };
            const toFloat = function (value, fallbackValue) {
                const parsed = parseFloat(value);
                return Number.isFinite(parsed) ? parsed : fallbackValue;
            };
            const encodeBytes = function (input) {
                if (input instanceof Uint8Array) {
                    return input;
                }
                return new Uint8Array(input);
            };
            const convertVectorUCharToUint8Array = function (vector) {
                const result = new Uint8Array(vector.size());
                for (let i = 0; i < vector.size(); i++) {
                    result[i] = vector.get(i);
                }
                return result;
            };

            const inputBytes = encodeBytes(event.data.file_data[0]);
            if (inputBytes.length <= 512 * 4) {
                throw new Error('Invalid nmrPipe payload for nus_step2');
            }

            const nmrpipeBytesVec = new Module.VectorUChar();
            const processor = new Module.fid_2d();

            let file_data;
            const phase_correction = '0 0 ' + toFloat(event.data.phase_correction_indirect_p0, 0).toString() + ' ' + toFloat(event.data.phase_correction_indirect_p1, 0).toString();

            try {
                processor.set_first_only(true);
                if (!processor.run_zf(1, toInt(event.data.zf_indirect, 1))) {
                    throw new Error('run_zf failed');
                }
                if (!processor.set_up_apodization_from_string('none', String(event.data.apodization_indirect))) {
                    throw new Error('set_up_apodization_from_string failed');
                }
                if (!processor.read_phase_correction_from_string(phase_correction)) {
                    throw new Error('read_phase_correction_from_string failed');
                }
                for (let i = 0; i < inputBytes.length; i++) {
                    nmrpipeBytesVec.push_back(inputBytes[i]);
                }
                if (!processor.read_nmrpipe_file_from_buffer(nmrpipeBytesVec)) {
                    throw new Error('read_nmrpipe_file_from_buffer failed');
                }
                postMessage({ stdout: "Running indirect_only_process for NUS spectrum" });
                if (!processor.indirect_only_process(true)) {
                    throw new Error('indirect_only_process failed');
                }

                const outputVec = new Module.VectorUChar();
                try {
                    if (!processor.write_nmrpipe_ft2_to_buffer(outputVec)) {
                        throw new Error('write_nmrpipe_ft2_to_buffer failed');
                    }
                    file_data = convertVectorUCharToUint8Array(outputVec);
                }
                finally {
                    outputVec.delete();
                }
            }
            finally {
                processor.delete();
                nmrpipeBytesVec.delete();
            }

            postMessage({
                [WEBASSEMBLY_JOB_KEY]: webassembly_job,
                file_data: file_data,
                file_type: 'indirect',
                phasing_data: phase_correction,
                processing_flag: event.data.processing_flag,
                spectrum_index: event.data.spectrum_index
            });
        }
        catch (error) {
            const errorText = error && error.message ? error.message : String(error);
            postMessage({ error: "nus_step2: " + errorText });
        }
    }

    else if (webassembly_job === "nus_step1") {
        try {
            const toBool = function (value) {
                if (typeof value === 'boolean') {
                    return value;
                }
                if (typeof value === 'string') {
                    const normalized = value.trim().toLowerCase();
                    return normalized === 'yes' || normalized === 'true' || normalized === '1';
                }
                return Boolean(value);
            };
            const toInt = function (value, fallbackValue) {
                const parsed = parseInt(value, 10);
                return Number.isFinite(parsed) ? parsed : fallbackValue;
            };
            const toFloat = function (value, fallbackValue) {
                const parsed = parseFloat(value);
                return Number.isFinite(parsed) ? parsed : fallbackValue;
            };
            const encodeBytes = function (input) {
                if (input instanceof Uint8Array) {
                    return input;
                }
                return new Uint8Array(input);
            };
            const convertVectorUCharToUint8Array = function (vector) {
                const result = new Uint8Array(vector.size());
                for (let i = 0; i < vector.size(); i++) {
                    result[i] = vector.get(i);
                }
                return result;
            };

            const acqusText = new TextDecoder('utf-8').decode(encodeBytes(event.data.file_data[0]));
            const acqu2sText = new TextDecoder('utf-8').decode(encodeBytes(event.data.file_data[1]));
            const fidBytes = encodeBytes(event.data.file_data[2]);
            const nusListText = new TextDecoder('utf-8').decode(encodeBytes(event.data.file_data[3]));

            const fidBytesVec = new Module.VectorUChar();
            for (let i = 0; i < fidBytes.length; i++) {
                fidBytesVec.push_back(fidBytes[i]);
            }

            const acquisitionSeq = String(event.data.acquisition_seq);
            const negativeImaginary = toBool(event.data.neg_imaginary);
            const zfDirect = toInt(event.data.zf_direct, 1);
            const apodizationDirect = String(event.data.apodization_direct);

            let direct_phase_correction_p0 = toFloat(event.data.phase_correction_direct_p0, 0);
            let direct_phase_correction_p1 = toFloat(event.data.phase_correction_direct_p1, 0);
            const indirect_phase_correction_p0 = toFloat(event.data.phase_correction_indirect_p0, 0);
            const indirect_phase_correction_p1 = toFloat(event.data.phase_correction_indirect_p1, 0);

            if (event.data.auto_direct === true) {
                const estimator = new Module.spectrum_phasing();
                try {
                    if (!estimator.read_bruker_files_as_strings('', acqusText, acqu2sText)) {
                        throw new Error('read_bruker_files_as_strings failed');
                    }
                    if (!estimator.read_bruker_fid_data_bytes(fidBytesVec)) {
                        throw new Error('read_bruker_fid_data_bytes failed');
                    }
                    if (!estimator.read_nus_list_from_string(nusListText)) {
                        throw new Error('read_nus_list_from_string failed');
                    }
                    if (!estimator.set_aqseq(acquisitionSeq)) {
                        throw new Error('set_aqseq failed');
                    }
                    estimator.set_negative(negativeImaginary);
                    estimator.set_first_only(true);
                    if (!estimator.run_zf(zfDirect, 1)) {
                        throw new Error('run_zf failed');
                    }
                    if (!estimator.set_up_apodization_from_string(apodizationDirect, 'none')) {
                        throw new Error('set_up_apodization_from_string failed');
                    }
                    const initialPhase = '0 0 ' + indirect_phase_correction_p0.toString() + ' ' + indirect_phase_correction_p1.toString();
                    if (!estimator.read_phase_correction_from_string(initialPhase)) {
                        throw new Error('read_phase_correction_from_string failed');
                    }
                    if (!estimator.full_process(false, false)) {
                        throw new Error('full_process failed');
                    }
                    estimator.set_user_phase_correction_indirect(0, 0);
                    postMessage({ stdout: "Running automatic phase correction for NUS direct dimension" });
                    if (!estimator.auto_phase_correction_v2()) {
                        throw new Error('auto_phase_correction_v2 failed');
                    }
                    const phaseValues = estimator.save_phase_correction_result_as_string().trim().split(/\s+/).map(function (item) { return parseFloat(item); });
                    if (phaseValues.length >= 2 && Number.isFinite(phaseValues[0]) && Number.isFinite(phaseValues[1])) {
                        direct_phase_correction_p0 = phaseValues[0];
                        direct_phase_correction_p1 = phaseValues[1];
                    }
                }
                finally {
                    estimator.delete();
                }
            }

            const phase_correction = direct_phase_correction_p0.toString() + ' ' + direct_phase_correction_p1.toString() + ' 0 0';
            const processor = new Module.fid_2d();
            let file_data;
            try {
                if (!processor.read_nus_list_from_string(nusListText)) {
                    throw new Error('read_nus_list_from_string failed');
                }
                if (!processor.set_aqseq(acquisitionSeq)) {
                    throw new Error('set_aqseq failed');
                }
                if (!processor.extract_region_ppm(toFloat(event.data.extract_direct_from, 8.8), toFloat(event.data.extract_direct_to, 7.0))) {
                    throw new Error('extract_region_ppm failed');
                }
                processor.set_negative(negativeImaginary);
                processor.set_first_only(true);
                if (!processor.run_zf(zfDirect, 1)) {
                    throw new Error('run_zf failed');
                }
                if (!processor.set_up_apodization_from_string(apodizationDirect, 'none')) {
                    throw new Error('set_up_apodization_from_string failed');
                }
                if (!processor.read_phase_correction_from_string(phase_correction)) {
                    throw new Error('read_phase_correction_from_string failed');
                }
                if (!processor.read_bruker_files_as_strings('', acqusText, acqu2sText)) {
                    throw new Error('read_bruker_files_as_strings failed');
                }
                if (!processor.read_bruker_fid_data_bytes(fidBytesVec)) {
                    throw new Error('read_bruker_fid_data_bytes failed');
                }
                postMessage({ stdout: "Running direct_only_process for NUS spectrum" });
                if (!processor.direct_only_process(true)) {
                    throw new Error('direct_only_process failed');
                }

                const outputVec = new Module.VectorUChar();
                try {
                    if (!processor.write_nmrpipe_intermediate_to_buffer(outputVec)) {
                        throw new Error('write_nmrpipe_intermediate_to_buffer failed');
                    }
                    file_data = convertVectorUCharToUint8Array(outputVec);
                }
                finally {
                    outputVec.delete();
                }
            }
            finally {
                processor.delete();
                fidBytesVec.delete();
            }

            postMessage({
                [WEBASSEMBLY_JOB_KEY]: webassembly_job,
                file_data: file_data,
                file_type: 'direct',
                phasing_data: phase_correction,
                processing_flag: event.data.processing_flag,
                spectrum_index: event.data.spectrum_index
            });
        }
        catch (error) {
            const errorText = error && error.message ? error.message : String(error);
            postMessage({ error: "nus_step1: " + errorText });
        }
    }

    else if (webassembly_job == "peak_picker") {

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
            [WEBASSEMBLY_JOB_KEY]: webassembly_job,
            picked_peaks_tab: peaks_tab,
            spectrum_index: event.data.spectrum_index,
            scale: event.data.scale,
            scale2: event.data.scale2
        });

        // Clean up the object to free memory
        obj.delete(); // Clean up the object to free memory
    }
    else if (webassembly_job === "peak_fitter") {

        // This is for peak fitting job
        console.log('Peak fitting job received');
        Module.shared_data_1d.n_verbose = 1;
        const obj = new Module.spectrum_fit_1d();

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
            [WEBASSEMBLY_JOB_KEY]: webassembly_job,
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

    else if (webassembly_job === "process_fid") {
        try {
            const toBool = function (value) {
                if (typeof value === 'boolean') {
                    return value;
                }
                if (typeof value === 'string') {
                    const normalized = value.trim().toLowerCase();
                    return normalized === 'yes' || normalized === 'true' || normalized === '1';
                }
                return Boolean(value);
            };

            const toInt = function (value, fallbackValue) {
                const parsed = parseInt(value, 10);
                return Number.isFinite(parsed) ? parsed : fallbackValue;
            };

            const toFloat = function (value, fallbackValue) {
                const parsed = parseFloat(value);
                return Number.isFinite(parsed) ? parsed : fallbackValue;
            };

            const updateIndirectApodizationFromPhase = function (apodization, phaseString) {
                const phaseValues = phaseString.trim().split(/\s+/);
                if (phaseValues.length < 4) {
                    return apodization;
                }
                let c = 0.5;
                if (Math.abs(parseFloat(phaseValues[3])) > 20.0) {
                    c = 1.0;
                }
                const apodizationParts = apodization.trim().split(/\s+/);
                const cIndex = apodizationParts.indexOf('c');
                if (cIndex >= 0 && cIndex + 1 < apodizationParts.length) {
                    apodizationParts[cIndex + 1] = c.toString();
                    return apodizationParts.join(' ');
                }
                return apodization;
            };

            const encodeBytes = function (input) {
                if (input instanceof Uint8Array) {
                    return input;
                }
                return new Uint8Array(input);
            };

            const convertVectorUCharToUint8Array = function (vector) {
                const result = new Uint8Array(vector.size());
                for (let i = 0; i < vector.size(); i++) {
                    result[i] = vector.get(i);
                }
                return result;
            };

            const initializeFromBrukerInput = function (processor, acqusText, acqu2sText, fidBytesVec) {
                if (!processor.read_bruker_files_as_strings('', acqusText, acqu2sText)) {
                    throw new Error('read_bruker_files_as_strings failed');
                }
                if (!processor.read_bruker_fid_data_bytes(fidBytesVec)) {
                    throw new Error('read_bruker_fid_data_bytes failed');
                }
            };

            const configureCommon = function (processor, options) {
                if (!processor.set_aqseq(options.acquisitionSeq)) {
                    throw new Error('set_aqseq failed');
                }
                if (options.applyExtraction === true) {
                    if (!processor.extract_region_ppm(options.extractFrom, options.extractTo)) {
                        throw new Error('extract_region_ppm failed');
                    }
                }
                processor.set_negative(options.negativeImaginary);
                processor.set_first_only(options.firstOnly);
                if (!processor.run_zf(options.zfDirect, options.zfIndirect)) {
                    throw new Error('run_zf failed');
                }
                if (!processor.set_up_apodization_from_string(options.apodizationDirect, options.apodizationIndirect)) {
                    throw new Error('set_up_apodization_from_string failed');
                }
                if (options.waterSuppression === true) {
                    processor.water_suppression();
                }
                if (!processor.full_process(options.deleteDirect, options.deleteIndirect)) {
                    throw new Error('full_process failed');
                }
                const polynomialOrder = toInt(options.polynomial, 0);
                if (polynomialOrder > 0) {
                    if (!processor.polynorminal_baseline(polynomialOrder)) {
                        throw new Error('polynorminal_baseline failed');
                    }
                }
            };

            const acquisitionText = new TextDecoder('utf-8').decode(encodeBytes(event.data.file_data[0]));
            const acquisitionText2 = new TextDecoder('utf-8').decode(encodeBytes(event.data.file_data[1]));
            const fidBytes = encodeBytes(event.data.file_data[2]);

            const fidBytesVec = new Module.VectorUChar();
            for (let i = 0; i < fidBytes.length; i++) {
                fidBytesVec.push_back(fidBytes[i]);
            }

            const acquisitionSeq = String(event.data.acquisition_seq);
            const negativeImaginary = toBool(event.data.neg_imaginary);
            const zfDirect = toInt(event.data.zf_direct, 1);
            const zfIndirect = toInt(event.data.zf_indirect, 1);
            const processAllPlanes = event.data.pseudo3d_process === 'all_planes';
            const useAutoPhase = event.data.auto_direct === true || event.data.auto_indirect === true;

            let apodization_indirect = event.data.apodization_indirect;
            let phasing_data = [
                toFloat(event.data.phase_correction_direct_p0, 0),
                toFloat(event.data.phase_correction_direct_p1, 0),
                toFloat(event.data.phase_correction_indirect_p0, 0),
                toFloat(event.data.phase_correction_indirect_p1, 0)
            ];

            const processor = new Module.spectrum_phasing();
            let file_data;
            let pseudo3d_files = [];
            try {
                initializeFromBrukerInput(processor, acquisitionText, acquisitionText2, fidBytesVec);
                configureCommon(processor, {
                    acquisitionSeq: acquisitionSeq,
                    negativeImaginary: negativeImaginary,
                    firstOnly: processAllPlanes === false,
                    zfDirect: zfDirect,
                    zfIndirect: zfIndirect,
                    apodizationDirect: event.data.apodization_direct,
                    apodizationIndirect: apodization_indirect,
                    waterSuppression: event.data.water_suppression === true,
                    deleteDirect: event.data.delete_direct === true,
                    deleteIndirect: event.data.delete_indirect === true,
                    polynomial: event.data.polynomial,
                    applyExtraction: true,
                    extractFrom: toFloat(event.data.extract_direct_from, 8.8),
                    extractTo: toFloat(event.data.extract_direct_to, 7.0)
                });

                if (useAutoPhase) {
                    if (event.data.auto_direct === false) {
                        processor.set_user_phase_correction(phasing_data[0], phasing_data[1]);
                    }
                    if (event.data.auto_indirect === false) {
                        processor.set_user_phase_correction_indirect(phasing_data[2], phasing_data[3]);
                    }
                    postMessage({ stdout: "Running automatic phase correction." });
                    if (!processor.auto_phase_correction_v2()) {
                        throw new Error('auto_phase_correction_v2 failed');
                    }
                    const phaseString = processor.save_phase_correction_result_as_string().trim();
                    const parsedPhaseValues = phaseString.split(/\s+/).map(function (item) { return parseFloat(item); });
                    if (parsedPhaseValues.length >= 4 && parsedPhaseValues.every(Number.isFinite)) {
                        phasing_data = parsedPhaseValues.slice(0, 4);
                    }
                    apodization_indirect = updateIndirectApodizationFromPhase(apodization_indirect, phaseString);
                }
                else {
                    processor.set_user_phase_correction(phasing_data[0], phasing_data[1]);
                    processor.set_user_phase_correction_indirect(phasing_data[2], phasing_data[3]);
                }

                const outputVec = new Module.VectorUChar();
                try {
                    if (!processor.write_nmrpipe_ft2_to_buffer(outputVec)) {
                        throw new Error('write_nmrpipe_ft2_to_buffer failed');
                    }
                    file_data = convertVectorUCharToUint8Array(outputVec);
                }
                finally {
                    outputVec.delete();
                }

                if (processAllPlanes) {
                    postMessage({ stdout: "Pseudo-3D all-planes export is under development. Returning first plane only." });
                }
            }
            finally {
                processor.delete();
                fidBytesVec.delete();
            }

            postMessage({
                [WEBASSEMBLY_JOB_KEY]: webassembly_job,
                file_data: file_data,
                file_type: 'full',
                pseudo3d_files: pseudo3d_files,
                phasing_data: phasing_data.join(' '),
                apodization_indirect: apodization_indirect,
                processing_flag: event.data.processing_flag,
                spectrum_index: event.data.spectrum_index,
                pseudo3d_children: event.data.pseudo3d_children,
            });
        }
        catch (error) {
            const errorText = error && error.message ? error.message : String(error);
            postMessage({ error: "process_fid: " + errorText });
        }
    }

    /**
     * 2D peak fitting job using the high-level spectrum_fit C++ class.
     *
     * Mirrors the workflow of spectrum_fit.cpp main():
     *   1. initflags_fit(maxround, removal_cutoff, too_near_cutoff, i_method)
     *   2. init_all_spectra_from_buffers(VectorVectorUChar) — one VectorUChar per spectrum file
     *   3. set_scale / set_noise_level / set_peak_width (optional)
     *   4. peak_reading_from_string(tab_string, 0) — type 0 = .tab format
     *   5. peak_fitting()
     *   6. print_peaks_as_string() → returned to main thread
     *
     * Input (event.data):
     *   spectrum_buffers   : Array of Uint8Array  — one ft2 per spectrum (at least one)
     *   picked_peaks_tab   : string               — NMRPipe .tab formatted peak list
     *   maxround           : int                  — max fitting iterations (default 50)
     *   removal_cutoff     : float                — combine/remove cutoff (default 0.0)
     *   too_near_cutoff    : float                — too-near cutoff (default 0.1)
     *   i_method           : int                  — 1=Gaussian, 2=Voigt, 3=Voigt-Lorentz
     *   scale              : float                — noise scale factor (default 5.5)
     *   scale2             : float                — noise floor scale (default 3.0)
     *   noise_level        : float                — 0 → auto-estimate from spectrum
     *   wx                 : float                — max FWHH direct dim ppm (0 = auto)
     *   wy                 : float                — max FWHH indirect dim ppm (0 = auto)
     *   spectrum_index     : int                  — passthrough for main thread bookkeeping
     */
    else if (webassembly_job === "peak_fitter_v2_spectrum_fit") {
        try {
            const toFloatOr = function (v, fallback) {
                const p = parseFloat(v);
                return Number.isFinite(p) ? p : fallback;
            };
            const toIntOr = function (v, fallback) {
                const p = parseInt(v, 10);
                return Number.isFinite(p) ? p : fallback;
            };

            const maxround = toIntOr(event.data.maxround, 50);
            const removalCutoff = toFloatOr(event.data.removal_cutoff, 0.0);
            const tooNearCutoff = toFloatOr(event.data.too_near_cutoff, 0.1);
            const iMethod = toIntOr(event.data.i_method, 2); // 2 = Voigt
            const scale = toFloatOr(event.data.scale, 5.5);
            const scale2 = toFloatOr(event.data.scale2, 3.0);
            const noiseLevel = toFloatOr(event.data.noise_level, 0.0);
            const wx = toFloatOr(event.data.wx, 0.0);
            const wy = toFloatOr(event.data.wy, 0.0);
            const pickedPeaksTab = String(event.data.picked_peaks_tab || '');

            const buffers = Array.isArray(event.data.spectrum_buffers) ? event.data.spectrum_buffers : [];
            if (buffers.length === 0) {
                throw new Error('peak_fitter_v2_spectrum_fit: no spectrum_buffers provided');
            }
            if (!pickedPeaksTab) {
                throw new Error('peak_fitter_v2_spectrum_fit: picked_peaks_tab is empty');
            }

            const obj = new Module.spectrum_fit();
            try {
                /**
                 * Step 1: Set fitting flags — matches x.initflags_fit(maxround, removal_cutoff, too_near_cutoff, i_method)
                 */
                obj.initflags_fit(maxround, removalCutoff, tooNearCutoff, iMethod);

                /**
                 * Step 2: Set scale — matches x.set_scale(user, user2)
                 */
                obj.set_scale(scale, scale2);

                /**
                 * Step 3: Load spectra from buffers.
                 * C++ signature: init_all_spectra_from_buffers(const std::vector<unsigned char> &nmrpipe_bytes, int nspectra_in)
                 * Takes a single flat byte buffer containing all spectra data concatenated.
                 */
                const buffersVec = new Module.VectorUChar();
                try {
                    for (let b = 0; b < buffers.length; b++) {
                        const uint8 = new Uint8Array(
                            buffers[b].buffer !== undefined ? buffers[b].buffer : buffers[b],
                            buffers[b].byteOffset || 0,
                            buffers[b].byteLength
                        );
                        for (let i = 0; i < uint8.length; i++) {
                            buffersVec.push_back(uint8[i]);
                        }
                    }

                    if (!obj.init_all_spectra_from_buffers(buffersVec, buffers.length)) {
                        throw new Error('peak_fitter_v2_spectrum_fit: init_all_spectra_from_buffers failed');
                    }
                } finally {
                    buffersVec.delete();
                }

                /**
                 * Step 4: Optional per-spectrum overrides — matches if (noise_level > 1e-20) / if (wx > 0 || wy > 0)
                 */
                if (noiseLevel > 1e-20) {
                    obj.set_noise_level(noiseLevel);
                }
                if (wx > 0.0 || wy > 0.0) {
                    obj.set_peak_width(wx, wy);
                }

                /**
                 * Step 5: Load input peaks — matches x.peak_reading(peak_file) but from string
                 */
                if (!obj.peak_reading_pipe_string(pickedPeaksTab)) {
                    throw new Error('peak_fitter_v2_spectrum_fit: peak_reading_pipe_string failed (no valid peaks?)');
                }

                /**
                 * Step 6: Run fitting — matches x.peak_fitting()
                 */
                obj.peak_fitting();

                /**
                 * Step 7: Retrieve results as NMRPipe .tab string — matches x.print_peaks(outfname, ...)
                 */
                const fittedPeaksTab = obj.print_peaks("", false, "", true);

                self.postMessage({
                    [WEBASSEMBLY_JOB_KEY]: webassembly_job,
                    fitted_peaks_tab: fittedPeaksTab,
                    spectrum_index: event.data.spectrum_index,
                });
            } finally {
                obj.delete();
            }
        }
        catch (err) {
            self.postMessage({
                error: 'peak_fitter_v2_spectrum_fit: ' + (err && err.message ? err.message : String(err)),
                spectrum_index: event.data.spectrum_index,
            });
        }
    }

    else if (webassembly_job === "pseudo3d_fitting") {
        try {
            const toFloatOr = function (value, fallback) {
                const parsed = parseFloat(value);
                return Number.isFinite(parsed) ? parsed : fallback;
            };
            const describeAmpMeaningByShape = PeakShapeUtils.describeAmpMeaningByShape;

            const regions = Array.isArray(event.data.regions) ? event.data.regions : [];
            if (regions.length === 0) {
                throw new Error('No pre-partitioned pseudo3D regions provided from main thread');
            }

            const peakComments = Array.isArray(event.data.peak_comments) ? event.data.peak_comments : [];
            const peakXppm = Array.isArray(event.data.peak_xppm) ? event.data.peak_xppm : [];
            const peakYppm = Array.isArray(event.data.peak_yppm) ? event.data.peak_yppm : [];

            const defaultNoise = toFloatOr(event.data.noise_level, 1.0);
            const defaultScale2 = toFloatOr(event.data.scale2, 3.0);
            const defaultPeakShape = event.data.flag === 0 ? 1 : 0;
            const defaultMaxround = parseInt(event.data.maxround, 10) || 20;

            const fittedRows = [];
            let completedRegions = 0;
            postMessage({ [WEBASSEMBLY_JOB_KEY]: "pseudo3d_progress", done: completedRegions, total: regions.length });

            for (let clusterId = 0; clusterId < regions.length; clusterId++) {
                const region = regions[clusterId];
                if (!region) {
                    completedRegions++;
                    postMessage({ [WEBASSEMBLY_JOB_KEY]: "pseudo3d_progress", done: completedRegions, total: regions.length });
                    continue;
                }

                const nspect = parseInt(region.nspectra, 10) || 0;
                if (nspect <= 0) {
                    completedRegions++;
                    postMessage({ [WEBASSEMBLY_JOB_KEY]: "pseudo3d_progress", done: completedRegions, total: regions.length });
                    continue;
                }

                const peakShape = parseInt(region.peakShape, 10) || defaultPeakShape;
                const maxround = parseInt(region.maxround, 10) || defaultMaxround;
                const localClusterId = parseInt(region.clusterLocalIndex, 10);
                const resolvedClusterId = Number.isFinite(localClusterId) ? localClusterId : clusterId;

                const xx = region.x || [];
                const yy = region.y || [];
                const aas = region.amp || [];
                const sx = region.sigmax || [];
                const sy = region.sigmay || [];
                const gx = region.gammax || [];
                const gy = region.gammay || [];
                const ori = region.originalNdx || [];
                const cannotMove = region.cannotMove || [];

                const peakCount = xx.length;
                const ampMeaning = describeAmpMeaningByShape(peakShape);
                console.log("[pseudo3d][partition " + clusterId + "] peakShape=" + peakShape + ", nspect=" + nspect + ", npeak=" + peakCount + ", meaning: " + ampMeaning);

                const fitResult = GaussianFitWorkerBridge.runRegionFit(Module, {
                    clusterId: resolvedClusterId,
                    maxround: maxround,
                    peakShape: peakShape,
                    peakSign: parseInt(region.peakSign, 10),
                    xstart: parseInt(region.xstart, 10) || 0,
                    ystart: parseInt(region.ystart, 10) || 0,
                    xdim: parseInt(region.xdim, 10) || 0,
                    ydim: parseInt(region.ydim, 10) || 0,
                    nspectra: nspect,
                    surface: region.surface || [],
                    x: xx,
                    y: yy,
                    amp: aas,
                    sigmax: sx,
                    sigmay: sy,
                    gammax: gx,
                    gammay: gy,
                    originalNdx: ori,
                    cannotMove: cannotMove,
                    medianWidthX: toFloatOr(region.medianWidthX, 3.0),
                    medianWidthY: toFloatOr(region.medianWidthY, 3.0),
                    peakParas: region.peakParas || {
                        wx: 6.0,
                        wy: 6.0,
                        noise: defaultNoise,
                        minHeight: defaultNoise * defaultScale2,
                        tooNearCutoff: 0.2,
                        xppmStep: 1.0,
                        yppmStep: 1.0,
                        removalCutoff: 0.1
                    }
                });

                if (fitResult.ok) {
                    for (let i = 0; i < fitResult.peaks.length; i++) {
                        const peak = fitResult.peaks[i];
                        fittedRows.push({
                            originalNdx: peak.originalNdx,
                            xAxis1: peak.xAxis1,
                            yAxis1: peak.yAxis1,
                            height: peak.height,
                            volume: peak.volume,
                            dheight: peak.dheight,
                            sigmax: peak.sigmax,
                            sigmay: peak.sigmay,
                            gammax: peak.gammax,
                            gammay: peak.gammay,
                            nround: peak.nround,
                            clusterId: resolvedClusterId,
                            allSpectraHeights: peak.ampRow,
                        });
                    }
                }

                completedRegions++;
                postMessage({ [WEBASSEMBLY_JOB_KEY]: "pseudo3d_progress", done: completedRegions, total: regions.length });
            }

            if (fittedRows.length === 0) {
                throw new Error('No fitted peaks returned from partitioned class fitting');
            }

            fittedRows.sort(function (a, b) {
                return a.originalNdx - b.originalNdx;
            });

            let zColumns = '';
            let zFormats = '';
            const nspectraForRatio = Array.isArray(event.data.all_spectra_indices) ? event.data.all_spectra_indices.length : 0;
            for (let i = 0; i < nspectraForRatio; i++) {
                zColumns += ' Z_A' + i.toString();
                zFormats += ' %7.4f';
            }

            let peaksTab = 'VARS INDEX X_AXIS Y_AXIS X_PPM Y_PPM HEIGHT VOLUME DHEIGHT ASS CLUSTID SIGMAX SIGMAY GAMMAX GAMMAY NROUND' + zColumns + '\n';
            peaksTab += 'FORMAT %5d %9.3f %9.3f %10.6f %10.6f %+e %+e %+e %s %4d %f %f %f %f %4d' + zFormats + '\n';

            for (let i = 0; i < fittedRows.length; i++) {
                const row = fittedRows[i];
                const comment = String(peakComments[row.originalNdx] || ('peaks' + (row.originalNdx + 1).toString()));
                const xppm = toFloatOr(peakXppm[row.originalNdx], row.xAxis1);
                const yppm = toFloatOr(peakYppm[row.originalNdx], row.yAxis1);

                const relativeHeights = [];
                if (nspectraForRatio > 0) {
                    for (let k = 0; k < nspectraForRatio; k++) {
                        const h = (row.allSpectraHeights && k < row.allSpectraHeights.length) ? Number(row.allSpectraHeights[k]) : 0.0;
                        relativeHeights.push(Number.isFinite(h) ? h : 0.0);
                    }
                    if (Math.abs(relativeHeights[0]) < Number.EPSILON) {
                        for (let k = 0; k < relativeHeights.length; k++) {
                            relativeHeights[k] = 0.0;
                        }
                    }
                    else {
                        for (let k = 1; k < relativeHeights.length; k++) {
                            relativeHeights[k] = relativeHeights[k] / relativeHeights[0];
                        }
                        relativeHeights[0] = 1.0;
                    }
                }

                peaksTab += [
                    (i + 1).toString(),
                    row.xAxis1.toFixed(3),
                    row.yAxis1.toFixed(3),
                    xppm.toFixed(6),
                    yppm.toFixed(6),
                    Number(row.height).toExponential(6),
                    Number(row.volume).toExponential(6),
                    Number(row.dheight).toExponential(6),
                    comment,
                    row.clusterId.toString(),
                    Number(row.sigmax).toFixed(6),
                    Number(row.sigmay).toFixed(6),
                    Number(row.gammax).toFixed(6),
                    Number(row.gammay).toFixed(6),
                    row.nround.toString()
                ].concat(relativeHeights.map(function (v) { return Number(v).toFixed(4); })).join(' ') + '\n';
            }

            postMessage({
                [WEBASSEMBLY_JOB_KEY]: webassembly_job,
                pseudo3d_fitted_peaks_tab: peaksTab,
                all_spectra_indices: event.data.all_spectra_indices,
            });
            return;
        }
        catch (err) {
            self.postMessage({ error: "pseudo3d_fitting: " + (err && err.message ? err.message : String(err)) });
        }
    }

    /**
     * v2 peak fitting region job: wasm only.
     * Main thread prepares partitioned regions and submits one job per region.
     */
    else if (webassembly_job === "peak_fitter_region_v2") {
        try {
            const fitResult = GaussianFitWorkerBridge.runRegionFit(Module, {
                clusterId: event.data.cluster_counter,
                maxround: event.data.maxround,
                peakShape: event.data.peak_shape,
                peakSign: event.data.peak_sign,
                xstart: event.data.min1,
                ystart: event.data.min2,
                xdim: event.data.size1,
                ydim: event.data.size2,
                nspectra: event.data.nspect,
                surface: Array.from(event.data.spect_parts || []),
                x: Array.from(event.data.xx || []),
                y: Array.from(event.data.yy || []),
                amp: Array.from(event.data.aas || []),
                sigmax: Array.from(event.data.sx || []),
                sigmay: Array.from(event.data.sy || []),
                gammax: Array.from(event.data.gx || []),
                gammay: Array.from(event.data.gy || []),
                originalNdx: Array.from(event.data.ori_index || []),
                cannotMove: Array.from(event.data.region_peak_cannot_move_flag || []),
                medianWidthX: event.data.median_width_x,
                medianWidthY: event.data.median_width_y,
                peakParas: {
                    wx: event.data.wx * 1.5,
                    wy: event.data.wy * 1.5,
                    noise: event.data.noise_level,
                    minHeight: event.data.noise_level * event.data.user_scale2,
                    tooNearCutoff: event.data.too_near_cutoff,
                    xppmStep: event.data.step1,
                    yppmStep: event.data.step2,
                    removalCutoff: event.data.removal_cutoff
                }
            });

            if (!fitResult.ok) {
                throw new Error("runRegionFit failed: " + fitResult.reason);
            }

            const nspect = event.data.nspect;
            const npeak = fitResult.peaks.length;
            let p1 = new Float32Array(npeak);
            let p2 = new Float32Array(npeak);
            let group = new Int32Array(npeak);
            let nround = new Int32Array(npeak);
            let p_intensity = new Float32Array(npeak);
            let p_volume = new Float32Array(npeak);
            let sigmax = new Float32Array(npeak);
            let sigmay = new Float32Array(npeak);
            let peak_index = new Int32Array(npeak);
            let err = new Float32Array(npeak);
            let gammax = new Float32Array(npeak);
            let gammay = new Float32Array(npeak);
            let p_intensity_all_spectra = new Float32Array(npeak * nspect);

            for (let i = 0; i < npeak; i++) {
                const peak = fitResult.peaks[i];
                p1[i] = peak.xAxis0;
                p2[i] = peak.yAxis0;
                group[i] = event.data.cluster_counter;
                nround[i] = peak.nround;
                p_intensity[i] = peak.height;
                p_volume[i] = peak.volume;
                sigmax[i] = peak.sigmax;
                sigmay[i] = peak.sigmay;
                peak_index[i] = peak.originalNdx;
                err[i] = peak.dheight;
                gammax[i] = peak.gammax;
                gammay[i] = peak.gammay;
                for (let k = 0; k < nspect; k++) {
                    p_intensity_all_spectra[i * nspect + k] = peak.ampRow[k] || 0.0;
                }
            }

            self.postMessage({
                [WEBASSEMBLY_JOB_KEY]: "peak_fitter_v2",
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

        }
        catch (err) {
            self.postMessage({
                [WEBASSEMBLY_JOB_KEY]: webassembly_job,
                spectrum_index: event.data.spectrum_index,
                cluster_counter: event.data.cluster_counter,
                total_jobs: event.data.total_jobs,
                error: "peak_fitter_region_v2: " + err.message
            });
        }
    }

    else if (webassembly_job === "generate_recon_spectrum_v2") {
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

            const peakShape = event.data.peak_shape || "voigt";
            let ok = false;

            if (peakShape === "gaussian") {
                if (typeof Module.generate_spectrum_gaussian === "function") {
                    ok = Module.generate_spectrum_gaussian(
                        inten, sigmax, sigmay, centerx, centery,
                        spectrum2d, event.data.xdim_local, event.data.ydim_local
                    );
                } else if (typeof Module.gaussian_fit === "function") {
                    const obj = new Module.gaussian_fit();
                    if (typeof obj.generate_spectrum_gaussian === "function") {
                        ok = obj.generate_spectrum_gaussian(
                            inten, sigmax, sigmay, centerx, centery,
                            spectrum2d, event.data.xdim_local, event.data.ydim_local
                        );
                    }
                    obj.delete();
                }
            } else {
                // Default to Voigt
                if (typeof Module.generate_spectrum_voigt === "function") {
                    ok = Module.generate_spectrum_voigt(
                        inten, sigmax, sigmay, gammax, gammay, centerx, centery,
                        spectrum2d, event.data.xdim_local, event.data.ydim_local
                    );
                } else if (typeof Module.gaussian_fit === "function") {
                    const obj = new Module.gaussian_fit();
                    if (typeof obj.generate_spectrum_voigt === "function") {
                        ok = obj.generate_spectrum_voigt(
                            inten, sigmax, sigmay, gammax, gammay, centerx, centery,
                            spectrum2d, event.data.xdim_local, event.data.ydim_local
                        );
                    }
                    obj.delete();
                }
            }

            if (!ok) {
                throw new Error(`generate_spectrum_${peakShape} failed or binding not found`);
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
                [WEBASSEMBLY_JOB_KEY]: "generate_recon_spectrum_v2",
                spectrum_index: event.data.spectrum_index,
                recon_raw_data: recon,
            }, [recon.buffer]);
        }
        catch (err) {
            self.postMessage({
                [WEBASSEMBLY_JOB_KEY]: webassembly_job,
                spectrum_index: event.data.spectrum_index,
                error: "generate_recon_spectrum_v2: " + err.message
            });
        }
    }

    /**
     * 1D FID processing job
     */
    else if (webassembly_job === "fid_processor_1d") {
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
            [WEBASSEMBLY_JOB_KEY]: webassembly_job,
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

    else if (webassembly_job === "baseline_correction") {

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
            [WEBASSEMBLY_JOB_KEY]: webassembly_job,
            spectrum_index: event.data.spectrum_index,
            baseline: baseline,
        });

        // Clean up the object to free memory
        obj.delete(); // Clean up the object to free memory
    }

    else if (webassembly_job === "peak_picker_2d") {

        const obj = new Module.spectrum_pick();

        /**
         * Set scale and model selection parameters
         * flag: 0 = DEEP Picker (model 2, target_width=6), 1 = DEEP Picker (model 1, target_width=12)
         */
        obj.set_scale(event.data.scale, event.data.scale2);
        obj.set_scale_negative(event.data.scale_negative, event.data.scale2_negative);
        obj.set_model_selection(2); // 2 = DEEP Picker (model 2, target_width=6)

        /**
         * Convert the buffer into a VectorUChar object.
         * C++ signature: read_nmrpipe_file_from_buffer(vector<unsigned char> nmrpipe_bytes)
         */
        const spectrum_uint8 = new Uint8Array(event.data.spectrum_data.buffer,
            event.data.spectrum_data.byteOffset,
            event.data.spectrum_data.byteLength);

        const nmrpipe_bytes = new Module.VectorUChar();
        for (let i = 0; i < spectrum_uint8.length; i++) {
            nmrpipe_bytes.push_back(spectrum_uint8[i]);
        }

        if (obj.read_nmrpipe_file_from_buffer(nmrpipe_bytes)) {

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
                [WEBASSEMBLY_JOB_KEY]: webassembly_job,
                picked_peaks_tab: peaks_tab,
                spectrum_index: event.data.spectrum_index,
                scale: event.data.scale,
                scale2: event.data.scale2
            });
        }
        else {
            self.postMessage({ error: 'peak_picker_2d: init_from_buffer failed' });
        }

        nmrpipe_bytes.delete();
        obj.delete();
    }

    else if (webassembly_job === "assignment") {
        self.postMessage({
            [WEBASSEMBLY_JOB_KEY]: "assignment",
            error: "assignment: Assignment transfer is under development."
        });
    }

    else if (webassembly_job === "spin_optimization") {
        self.postMessage({
            [WEBASSEMBLY_JOB_KEY]: "spin_optimization",
            error: "spin_optimization: Spin optimization is under development."
        });
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


