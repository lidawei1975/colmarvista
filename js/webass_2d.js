/**
 * worker.js (webass_2d.js)
 * 
 * DESIGN NOTE: NUS 2D Direct Dimension Automatic Phase Correction Workflow
 * ------------------------------------------------------------------------
 * When a Non-Uniformly Sampled (NUS) 2D spectrum requires automatic direct-dimension
 * phase correction, the system employs a multi-step pipeline that reuses standard
 * processing components:
 * 
 * Step 1: Prep Processing
 * - If it's a NUS spectrum (length 4) and auto direct phasing is requested (auto_direct or ann_auto_direct),
 *   the system first runs a full standard 2D processing job (job: "process_fid") on the raw files 
 *   WITHOUT NUS reconstruction, preserving the artifacts.
 * - During this prep run, entropy-based auto phasing is skipped on the worker (auto_direct/auto_indirect 
 *   are forced to false) and imaginary data is retained (delete_direct is forced to false) so that 
 *   the full raw frequency/imaginary dataset is available.
 * 
 * Step 2: ANN Inference
 * - Once the prep run completes, the main thread receives the intermediate full spectrum and runs 
 *   TensorFlow.js ANN-based phase correction (NUS2DPhasePipeline) to predict the correct direct 
 *   p0 and p1 phase values.
 * 
 * Step 3: Reconstruction & Final Processing
 * - The predicted phase values are written back to the HTML UI phase inputs, and the auto-phasing 
 *   checkboxes are unchecked.
 * - The main thread automatically triggers the standard NUS processing pipeline again. Since the 
 *   auto-phasing checkboxes are now false, it runs the standard NUS pipeline using the newly obtained 
 *   direct phase values:
 *     (a) Direct-only processing ("nus_step1")
 *     (b) SMILE NUS reconstruction (webass_smile.js / nuspipe)
 *     (c) Indirect-only processing ("nus_step2")
 * 
 * Benefits:
 * - This design ensures that the exact same NUS reconstruction and indirect dimension processing 
 *   code path is reused for both:
 *     (1) Auto-phased NUS spectra after phases are predicted and loaded.
 *     (2) Manually-phased NUS spectra where the user inputs the phase values directly.
 */

// Import Emscripten factory function
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

    if (webassembly_job === "nus_step2") {
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
                const result = new Uint8Array(Number(vector.size()));
                for (let i = 0; i < Number(vector.size()); i++) {
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

                const addressVal = Number(processor.write_nmrpipe_ft2_to_buffer());
                if (addressVal === 0) {
                    throw new Error('write_nmrpipe_ft2_to_buffer failed');
                }
                const size = processor.get_ft2_size_in_float32();
                file_data = new Uint8Array(Module.HEAPF32.buffer, addressVal, size * 4).slice();
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
                const result = new Uint8Array(Number(vector.size()));
                for (let i = 0; i < Number(vector.size()); i++) {
                    result[i] = vector.get(i);
                }
                return result;
            };

            const acqusText = new TextDecoder('utf-8').decode(encodeBytes(event.data.file_data[0]));
            const acqu2sText = new TextDecoder('utf-8').decode(encodeBytes(event.data.file_data[1]));
            const acqu3sText = event.data.acqu3s_content || "";
            const fidBytes = encodeBytes(event.data.file_data[2]);
            const nusListText = new TextDecoder('utf-8').decode(encodeBytes(event.data.file_data[3]));

            const fidBytesVec = new Module.VectorUChar();
            for (let i = 0; i < fidBytes.length; i++) {
                fidBytesVec.push_back(fidBytes[i]);
            }

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
                    if (!estimator.read_bruker_files_as_strings('', acqusText, acqu2sText, acqu3sText)) {
                        throw new Error('read_bruker_files_as_strings failed');
                    }
                    if (!estimator.read_bruker_fid_data_bytes(fidBytesVec)) {
                        throw new Error('read_bruker_fid_data_bytes failed');
                    }
                    if (!estimator.read_nus_list_from_string(nusListText)) {
                        throw new Error('read_nus_list_from_string failed');
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
                if (!processor.read_bruker_files_as_strings('', acqusText, acqu2sText, acqu3sText)) {
                    throw new Error('read_bruker_files_as_strings failed');
                }
                if (!processor.read_bruker_fid_data_bytes(fidBytesVec)) {
                    throw new Error('read_bruker_fid_data_bytes failed');
                }
                postMessage({ stdout: "Running direct_only_process for NUS spectrum" });
                if (!processor.direct_only_process(true)) {
                    throw new Error('direct_only_process failed');
                }
                if (event.data.nus_flatt_baseline) {
                    postMessage({ stdout: "Executing FLATT baseline correction along F2 (direct) traces" });
                    processor.flatt_baseline_direct();
                }

                const addressVal = Number(processor.write_nmrpipe_ft2_to_buffer());
                if (addressVal === 0) {
                    throw new Error('write_nmrpipe_ft2_to_buffer failed');
                }
                const size = processor.get_ft2_size_in_float32();
                file_data = new Uint8Array(Module.HEAPF32.buffer, addressVal, size * 4).slice();
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
                const result = new Uint8Array(Number(vector.size()));
                for (let i = 0; i < Number(vector.size()); i++) {
                    result[i] = vector.get(i);
                }
                return result;
            };

            const initializeFromBrukerInput = function (processor, acqusText, acqu2sText, acqu3sText, fidBytesVec) {
                if (!processor.read_bruker_files_as_strings('', acqusText, acqu2sText, acqu3sText)) {
                    throw new Error('read_bruker_files_as_strings failed');
                }
                if (!processor.read_bruker_fid_data_bytes(fidBytesVec)) {
                    throw new Error('read_bruker_fid_data_bytes failed');
                }
            };

            const configureCommon = function (processor, options) {
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
            };

            const acquisitionText = new TextDecoder('utf-8').decode(encodeBytes(event.data.file_data[0]));
            const acquisitionText2 = new TextDecoder('utf-8').decode(encodeBytes(event.data.file_data[1]));
            const acqu3sText = event.data.acqu3s_content || "";
            const fidBytes = encodeBytes(event.data.file_data[2]);
            let nusListText = "";
            if (event.data.file_data.length === 4) {
                nusListText = new TextDecoder('utf-8').decode(encodeBytes(event.data.file_data[3]));
            }

            const fidBytesVec = new Module.VectorUChar();
            for (let i = 0; i < fidBytes.length; i++) {
                fidBytesVec.push_back(fidBytes[i]);
            }

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
                initializeFromBrukerInput(processor, acquisitionText, acquisitionText2, acqu3sText, fidBytesVec);
                if (nusListText) {
                    if (!processor.read_nus_list_from_string(nusListText)) {
                        throw new Error('read_nus_list_from_string failed');
                    }
                }
                configureCommon(processor, {
                    negativeImaginary: negativeImaginary,
                    firstOnly: processAllPlanes === false,
                    zfDirect: zfDirect,
                    zfIndirect: zfIndirect,
                    apodizationDirect: event.data.apodization_direct,
                    apodizationIndirect: apodization_indirect,
                    waterSuppression: event.data.water_suppression === true,
                    deleteDirect: event.data.delete_direct === true,
                    deleteIndirect: event.data.delete_indirect === true,
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

                const polynomialOrder = toInt(event.data.polynomial, -2);
                if (polynomialOrder !== -2) {
                    if (!processor.polynorminal_baseline(polynomialOrder, true, 1e7, 1.5, 5)) {
                        throw new Error('polynorminal_baseline failed');
                    }
                }

                const addressVal = Number(processor.write_nmrpipe_ft2_to_buffer());
                if (addressVal === 0) {
                    throw new Error('write_nmrpipe_ft2_to_buffer failed');
                }
                const size = processor.get_ft2_size_in_float32();
                file_data = new Uint8Array(Module.HEAPF32.buffer, addressVal, size * 4).slice();

                if (processAllPlanes) {
                    const numPlanes = processor.get_nspectra();
                    postMessage({ stdout: "Exporting all " + numPlanes + " planes of Pseudo-3D spectrum..." });
                    for (let i = 1; i < numPlanes; i++) {
                        const planeAddressVal = Number(processor.write_nmrpipe_ft2_to_buffer_index(i));
                        if (planeAddressVal === 0) {
                            throw new Error('write_nmrpipe_ft2_to_buffer_index failed for plane ' + i);
                        }
                        const planeSize = processor.get_ft2_size_in_float32();
                        const planeData = new Uint8Array(Module.HEAPF32.buffer, planeAddressVal, planeSize * 4).slice();
                        pseudo3d_files.push(planeData);
                    }
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
                nus_auto_phase_prep: event.data.nus_auto_phase_prep,
            });
        }
        catch (error) {
            const errorText = error && error.message ? error.message : String(error);
            postMessage({ error: "process_fid: " + errorText });
        }
    }

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
            const toIntOr = function (value, fallback) {
                const parsed = parseInt(value, 10);
                return Number.isFinite(parsed) ? parsed : fallback;
            };

            const allFiles = Array.isArray(event.data.all_files) ? event.data.all_files : [];
            const initialPeaksTab = String(event.data.initial_peaks || '');
            if (allFiles.length === 0) {
                throw new Error('pseudo3d_fitting: no all_files provided');
            }
            if (!initialPeaksTab) {
                throw new Error('pseudo3d_fitting: initial_peaks is empty');
            }

            const maxround = toIntOr(event.data.maxround, 50);
            const removalCutoff = toFloatOr(event.data.removal_cutoff, 0.0);
            const tooNearCutoff = toFloatOr(event.data.too_near_cutoff, 0.1);
            const scale = toFloatOr(event.data.scale, 5.5);
            const scale2 = toFloatOr(event.data.scale2, 3.0);
            const noiseLevel = toFloatOr(event.data.noise_level, 0.0);
            const wx = toFloatOr(event.data.wx, 0.0);
            const wy = toFloatOr(event.data.wy, 0.0);

            // Keep method mapping aligned with UI flags and peak_fitter_v2_spectrum_fit.
            let iMethod = toIntOr(event.data.i_method, 2); // 1=Gaussian, 2=Voigt, 3=Voigt-Lorentz
            if (event.data.flag === 1) {
                iMethod = 1;
            }
            else if (event.data.flag === 0) {
                iMethod = 2;
            }
            else if (event.data.flag === 2) {
                iMethod = 3;
            }

            const total = allFiles.length + 3;
            let done = 0;
            postMessage({ [WEBASSEMBLY_JOB_KEY]: "pseudo3d_progress", done: done, total: total });

            const obj = new Module.spectrum_fit();
            try {
                obj.initflags_fit(maxround, removalCutoff, tooNearCutoff, iMethod);
                obj.set_scale(scale, scale2);

                const buffersVec = new Module.VectorUChar();
                try {
                    for (let b = 0; b < allFiles.length; b++) {
                        let uint8;
                        const source = allFiles[b];
                        if (source instanceof Uint8Array) {
                            uint8 = source;
                        }
                        else if (source instanceof ArrayBuffer) {
                            uint8 = new Uint8Array(source);
                        }
                        else if (source && source.buffer !== undefined && source.byteLength !== undefined) {
                            uint8 = new Uint8Array(source.buffer, source.byteOffset || 0, source.byteLength);
                        }
                        else {
                            throw new Error('pseudo3d_fitting: invalid spectrum buffer at index ' + b.toString());
                        }

                        for (let i = 0; i < uint8.length; i++) {
                            buffersVec.push_back(uint8[i]);
                        }

                        done++;
                        postMessage({ [WEBASSEMBLY_JOB_KEY]: "pseudo3d_progress", done: done, total: total });
                    }

                    if (!obj.init_all_spectra_from_buffers(buffersVec, allFiles.length)) {
                        throw new Error('pseudo3d_fitting: init_all_spectra_from_buffers failed');
                    }
                }
                finally {
                    buffersVec.delete();
                }

                if (noiseLevel > 1e-20) {
                    obj.set_noise_level(noiseLevel);
                }
                if (wx > 0.0 || wy > 0.0) {
                    obj.set_peak_width(wx, wy);
                }

                if (!obj.peak_reading_pipe_string(initialPeaksTab)) {
                    throw new Error('pseudo3d_fitting: peak_reading_pipe_string failed');
                }

                done++;
                postMessage({ [WEBASSEMBLY_JOB_KEY]: "pseudo3d_progress", done: done, total: total });

                obj.peak_fitting();
                const fittedPeaksTab = obj.print_peaks("", false, "", true);
                if (!fittedPeaksTab) {
                    throw new Error('pseudo3d_fitting: print_peaks returned empty result');
                }

                done++;
                postMessage({ [WEBASSEMBLY_JOB_KEY]: "pseudo3d_progress", done: done, total: total });

                postMessage({
                    [WEBASSEMBLY_JOB_KEY]: webassembly_job,
                    pseudo3d_fitted_peaks_tab: fittedPeaksTab,
                    all_spectra_indices: event.data.all_spectra_indices,
                });
                return;
            }
            finally {
                obj.delete();
            }
        }
        catch (err) {
            self.postMessage({ error: "pseudo3d_fitting: " + (err && err.message ? err.message : String(err)) });
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

            let yLimit = Math.min(ydim, Number(spectrum2d.size()));
            for (let y = 0; y < yLimit; y++) {
                const row = spectrum2d.get(y);
                const xLimit = Math.min(xdim, Number(row.size()));
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

    else if (webassembly_job === "baseline_correction") {
        try {
            const encodeBytes = function (input) {
                if (input instanceof Uint8Array) {
                    return input;
                }
                return new Uint8Array(input);
            };

            const inputBytes = encodeBytes(event.data.file_data);
            if (inputBytes.length <= 512 * 4) {
                throw new Error('Invalid nmrPipe payload for baseline_correction');
            }

            const polyOrder = parseInt(event.data.polynomial_order, 10);

            const nmrpipeBytesVec = new Module.VectorUChar();
            for (let i = 0; i < inputBytes.length; i++) {
                nmrpipeBytesVec.push_back(inputBytes[i]);
            }

            const fid = new Module.fid_2d();
            let file_data;
            try {
                const successRead = fid.read_nmrpipe_file_from_buffer(nmrpipeBytesVec);
                if (!successRead) {
                    throw new Error("Failed to read NMRPipe file from buffer.");
                }

                const successProcess = fid.other_process(true, true);
                if (!successProcess) {
                    throw new Error("Other process failed.");
                }

                const traceByTrace = true;
                const flattA = 1e7;         // default regularizer parameter 'a'
                const flattB = 1.5;         // default asymmetric constraint penalty 'b'
                const regionFlag = 5;       // -region-flag 5

                const successBaseline = fid.polynorminal_baseline(polyOrder, traceByTrace, flattA, flattB, regionFlag);
                if (!successBaseline) {
                    throw new Error("Baseline correction failed.");
                }

                const addressVal = Number(fid.write_nmrpipe_ft2_to_buffer());
                if (addressVal === 0) {
                    throw new Error("Failed to export FT2 spectrum to buffer.");
                }

                const sizeInFloat32 = fid.get_ft2_size_in_float32();
                file_data = new Uint8Array(Module.HEAPF32.buffer, addressVal, sizeInFloat32 * 4).slice();
            } finally {
                fid.delete();
                nmrpipeBytesVec.delete();
            }

            self.postMessage({
                [WEBASSEMBLY_JOB_KEY]: webassembly_job,
                file_data: file_data,
                spectrum_index: event.data.spectrum_index,
                polynomial_order: polyOrder
            });
        } catch (error) {
            const errorText = error && error.message ? error.message : String(error);
            self.postMessage({ error: "baseline_correction: " + errorText });
        }
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
