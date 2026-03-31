/**
 * This is a web worker that will be used to run the web assembly code
 */


importScripts('webdp.js');
importScripts('webdp1d_cpp.js');

const cppModulePromise = webdp1d_cpp({
    print: function (text) {
        postMessage({ stdout: text });
    },
    printErr: function (text) {
        postMessage({ stdout: text });
    }
});

const api = {
    version: Module.cwrap("version", "number", []),
    deep: Module.cwrap("deep", "number", []),
    simple_picking: Module.cwrap("simple_picking", "number", []),
    fid: Module.cwrap("fid", "number", []),
    phasing: Module.cwrap("phasing", "number", []),
    voigt_fit: Module.cwrap("voigt_fit", "number", []),
    peak_match: Module.cwrap("peak_match", "number", []),
    spin_optimization: Module.cwrap("spin_optimization", "number",[]),
};

/**
 * Redirect the stdout and stderr to postMessage
 */
Module['print'] = function (text) {
    postMessage({ stdout: text });
};
out = Module['print'];
err = Module['print'];

function runProcessFidLegacy(e) {
    console.log('Falling back to legacy process_fid workflow');

    Module['FS_createDataFile']('/', 'acquisition_file', e.data.file_data[0], true, true, true);
    Module['FS_createDataFile']('/', 'acquisition_file2', e.data.file_data[1], true, true, true);
    Module['FS_createDataFile']('/', 'fid_file', e.data.file_data[2], true, true, true);

    let apodization_indirect = e.data.apodization_indirect;
    let content = ' -aqseq '.concat(e.data.acquisition_seq, ' -negative ', e.data.neg_imaginary);
    content = content.concat(' -zf '.concat(e.data.zf_direct, ' -zf-indirect ', e.data.zf_indirect));
    content = content.concat(' -apod '.concat(e.data.apodization_direct));
    content = content.concat(' -apod-indirect '.concat(apodization_indirect));
    content = content.concat(' -poly '.concat(e.data.polynomial));
    content = content.concat(' -in fid_file acquisition_file acquisition_file2 none');

    if (e.data.water_suppression === true) {
        content = content.concat(' -water yes ');
    }
    else {
        content = content.concat(' -water no ');
    }

    if (e.data.auto_direct === false && e.data.auto_indirect === false) {
        if (e.data.delete_direct === true) {
            content = content.concat(' -di yes ');
        }
        else {
            content = content.concat(' -di no ');
        }

        if (e.data.delete_indirect === true) {
            content = content.concat(' -di-indirect yes ');
        }
        else {
            content = content.concat(' -di-indirect no ');
        }

        if (e.data.pseudo3d_process === 'first_only') {
            content = content.concat(' -first-only yes ');
        }
        else {
            content = content.concat(' -first-only no ');
        }

        content = content.concat(' -phase-in phase-correction.txt ');
        content = content.concat(' -ext '.concat(e.data.extract_direct_from, ' ', e.data.extract_direct_to));
        content = content.concat(' -out test.ft2');

        let phase_correction = e.data.phase_correction_direct_p0.toString();
        phase_correction = phase_correction.concat(' ', e.data.phase_correction_direct_p1.toString());
        phase_correction = phase_correction.concat(' ', e.data.phase_correction_indirect_p0.toString());
        phase_correction = phase_correction.concat(' ', e.data.phase_correction_indirect_p1.toString());
        Module['FS_createDataFile']('/', 'phase-correction.txt', phase_correction, true, true, true);

        Module['FS_createDataFile']('/', 'arguments_fid_2d.txt', content, true, true, true);
        postMessage({ stdout: "Running fid function" });
        api.fid();
    }
    else {
        content = content.concat(' -first-only yes -out test0.ft2');
        content = content.concat(' -phase-in none -di no -di-indirect no');
        Module['FS_createDataFile']('/', 'arguments_fid_2d.txt', content, true, true, true);

        postMessage({ stdout: "Running automatic phase correction." });
        api.fid();

        content = ' -in test0.ft2 -out none -out-phase phase-correction.txt';
        if (e.data.auto_direct === true) {
            content = content.concat(' -user no ');
        }
        else {
            content = content.concat(' -user yes -user-phase '.concat(e.data.phase_correction_direct_p0.toString(), ' ', e.data.phase_correction_direct_p1.toString()));
        }
        if (e.data.auto_indirect === true) {
            content = content.concat(' -user-indirect no ');
        }
        else {
            content = content.concat(' -user-indirect yes -user-phase-indirect '.concat(e.data.phase_correction_indirect_p0.toString(), ' ', e.data.phase_correction_indirect_p1.toString()));
        }
        Module['FS_createDataFile']('/', 'arguments_phase_2d.txt', content, true, true, true);
        api.phasing();
        FS.unlink('arguments_phase_2d.txt');

        let phase_correction = FS.readFile('phase-correction.txt', { encoding: 'utf8' });
        let phase_correction_values = phase_correction.trim().split(/\s+/);
        let c = 0.5;
        if (Math.abs(parseFloat(phase_correction_values[3])) > 20.0) {
            c = 1.0;
        }

        let apodization_indirect_values = apodization_indirect.trim().split(/\s+/);
        let c_index = apodization_indirect_values.indexOf('c');
        if (c_index >= 0 && c_index + 1 < apodization_indirect_values.length) {
            apodization_indirect_values[c_index + 1] = c.toString();
            apodization_indirect = apodization_indirect_values.join(' ');
        }

        if (e.data.pseudo3d_process === 'first_only') {
            content = ' -first-only yes ';
        }
        else {
            content = ' -first-only no ';
        }
        content = content.concat('  -aqseq '.concat(e.data.acquisition_seq, ' -negative ', e.data.neg_imaginary));
        content = content.concat(' -zf '.concat(e.data.zf_direct, ' -zf-indirect ', e.data.zf_indirect));
        content = content.concat(' -apod '.concat(e.data.apodization_direct));
        content = content.concat(' -apod-indirect '.concat(apodization_indirect));
        content = content.concat(' -ext '.concat(e.data.extract_direct_from, ' ', e.data.extract_direct_to));
        content = content.concat(' -poly '.concat(e.data.polynomial));
        content = content.concat(' -out test.ft2');
        content = content.concat(' -in fid_file acquisition_file acquisition_file2 none');
        content = content.concat(' -phase-in phase-correction.txt ');

        if (e.data.delete_direct === true) {
            content = content.concat(' -di yes ');
        }
        else {
            content = content.concat(' -di no ');
        }

        if (e.data.delete_indirect === true) {
            content = content.concat(' -di-indirect yes ');
        }
        else {
            content = content.concat(' -di-indirect no ');
        }

        if (e.data.water_suppression === true) {
            content = content.concat(' -water yes ');
        }
        else {
            content = content.concat(' -water no ');
        }

        FS.unlink('test0.ft2');
        FS.unlink('arguments_fid_2d.txt');
        Module['FS_createDataFile']('/', 'arguments_fid_2d.txt', content, true, true, true);
        postMessage({ stdout: "Running fid function with automatic phase correction" });
        api.fid();
    }

    FS.unlink('acquisition_file');
    FS.unlink('acquisition_file2');
    FS.unlink('fid_file');
    FS.unlink('arguments_fid_2d.txt');
    const file_data = FS.readFile('test.ft2', { encoding: 'binary' });
    const phasing_data = FS.readFile('phase-correction.txt', { encoding: 'utf8' });
    FS.unlink('test.ft2');
    FS.unlink('phase-correction.txt');

    let pseudo3d_files = [];
    if (e.data.pseudo3d_process === 'all_planes') {
        let pseudo3d_information = JSON.parse(FS.readFile('pseudo3d.json', { encoding: 'utf8' }));
        for (let i = 1; i < pseudo3d_information.spectra; i++) {
            pseudo3d_files.push(FS.readFile('test_'.concat(i, '.ft2'), { encoding: 'binary' }));
            FS.unlink('test_'.concat(i, '.ft2'));
        }
        FS.unlink('pseudo3d.json');
    }

    postMessage({
        webassembly_job: e.data.webassembly_job,
        file_data: file_data,
        file_type: 'full',
        pseudo3d_files: pseudo3d_files,
        phasing_data: phasing_data,
        apodization_indirect: apodization_indirect,
        processing_flag: e.data.processing_flag,
        spectrum_index: e.data.spectrum_index,
        pseudo3d_children: e.data.pseudo3d_children,
    });
}

onmessage = async function (e) {
    console.log('Message received from main script');
    
    /**
     * NUS step2 with class-based bindings.
     * Input is one FT2 buffer from NUS reconstruction, then run indirect-only processing.
     */
    if (e.data.webassembly_job === "nus_step2") {
        console.log('File data received for indirect processing');

        try {
            const ModuleCpp = await cppModulePromise;

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

            const inputBytes = encodeBytes(e.data.file_data[0]);
            if (inputBytes.length <= 512 * 4) {
                throw new Error('Invalid nmrPipe payload for nus_step2');
            }

            const nmrpipeBytesVec = new ModuleCpp.VectorUChar();
            const processor = new ModuleCpp.fid_2d();

            let file_data;
            const phase_correction = '0 0 ' + toFloat(e.data.phase_correction_indirect_p0, 0).toString() + ' ' + toFloat(e.data.phase_correction_indirect_p1, 0).toString();

            try {
                processor.set_first_only(true);
                if (!processor.run_zf(1, toInt(e.data.zf_indirect, 1))) {
                    throw new Error('run_zf failed');
                }
                if (!processor.set_up_apodization_from_string('none', String(e.data.apodization_indirect))) {
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

                const outputVec = new ModuleCpp.VectorUChar();
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
                webassembly_job: e.data.webassembly_job,
                file_data: file_data,
                file_type: 'indirect',
                phasing_data: phase_correction,
                processing_flag: e.data.processing_flag,
                spectrum_index: e.data.spectrum_index
            });
        }
        catch (error) {
            const errorText = error && error.message ? error.message : String(error);
            postMessage({ stdout: "Class-based nus_step2 failed: " + errorText });
        }
    }

    /**
     * NUS step1 with class-based bindings.
     * Input is Bruker files + nus list, then run direct-only processing.
     */
    if (e.data.webassembly_job === "nus_step1") {
        console.log('File data received for NUS processing');

        try {
            const ModuleCpp = await cppModulePromise;

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

            const acqusText = new TextDecoder('utf-8').decode(encodeBytes(e.data.file_data[0]));
            const acqu2sText = new TextDecoder('utf-8').decode(encodeBytes(e.data.file_data[1]));
            const fidBytes = encodeBytes(e.data.file_data[2]);
            const nusListText = new TextDecoder('utf-8').decode(encodeBytes(e.data.file_data[3]));

            const fidBytesVec = new ModuleCpp.VectorUChar();
            for (let i = 0; i < fidBytes.length; i++) {
                fidBytesVec.push_back(fidBytes[i]);
            }

            const acquisitionSeq = String(e.data.acquisition_seq);
            const negativeImaginary = toBool(e.data.neg_imaginary);
            const zfDirect = toInt(e.data.zf_direct, 1);
            const apodizationDirect = String(e.data.apodization_direct);

            let direct_phase_correction_p0 = toFloat(e.data.phase_correction_direct_p0, 0);
            let direct_phase_correction_p1 = toFloat(e.data.phase_correction_direct_p1, 0);
            const indirect_phase_correction_p0 = toFloat(e.data.phase_correction_indirect_p0, 0);
            const indirect_phase_correction_p1 = toFloat(e.data.phase_correction_indirect_p1, 0);

            if (e.data.auto_direct === true) {
                const estimator = new ModuleCpp.spectrum_phasing();
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

            const processor = new ModuleCpp.fid_2d();
            let file_data;
            try {
                if (!processor.read_nus_list_from_string(nusListText)) {
                    throw new Error('read_nus_list_from_string failed');
                }
                if (!processor.set_aqseq(acquisitionSeq)) {
                    throw new Error('set_aqseq failed');
                }

                if (!processor.extract_region_ppm(
                    toFloat(e.data.extract_direct_from, 8.8),
                    toFloat(e.data.extract_direct_to, 7.0)
                )) {
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

                const outputVec = new ModuleCpp.VectorUChar();
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
                webassembly_job: e.data.webassembly_job,
                file_data: file_data,
                file_type: 'direct',
                phasing_data: phase_correction,
                processing_flag: e.data.processing_flag,
                spectrum_index: e.data.spectrum_index
            });
        }
        catch (error) {
            const errorText = error && error.message ? error.message : String(error);
            postMessage({ stdout: "Class-based nus_step1 failed: " + errorText });
        }
    }

    /**
     * Class-based full FID processing using webdp1d_cpp bindings.
     */
    if (e.data.webassembly_job === "process_fid") {
        console.log('File data received');

        try {

        const ModuleCpp = await cppModulePromise;

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

        const acquisitionText = new TextDecoder('utf-8').decode(encodeBytes(e.data.file_data[0]));
        const acquisitionText2 = new TextDecoder('utf-8').decode(encodeBytes(e.data.file_data[1]));
        const fidBytes = encodeBytes(e.data.file_data[2]);

        const fidBytesVec = new ModuleCpp.VectorUChar();
        for (let i = 0; i < fidBytes.length; i++) {
            fidBytesVec.push_back(fidBytes[i]);
        }

        const acquisitionSeq = String(e.data.acquisition_seq);
        const negativeImaginary = toBool(e.data.neg_imaginary);
        const zfDirect = toInt(e.data.zf_direct, 1);
        const zfIndirect = toInt(e.data.zf_indirect, 1);
        const processAllPlanes = e.data.pseudo3d_process === 'all_planes';
        const useAutoPhase = e.data.auto_direct === true || e.data.auto_indirect === true;

        let apodization_indirect = e.data.apodization_indirect;
        let phasing_data = [
            toFloat(e.data.phase_correction_direct_p0, 0),
            toFloat(e.data.phase_correction_direct_p1, 0),
            toFloat(e.data.phase_correction_indirect_p0, 0),
            toFloat(e.data.phase_correction_indirect_p1, 0)
        ];

        const processor = new ModuleCpp.spectrum_phasing();
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
                apodizationDirect: e.data.apodization_direct,
                apodizationIndirect: apodization_indirect,
                waterSuppression: e.data.water_suppression === true,
                deleteDirect: e.data.delete_direct === true,
                deleteIndirect: e.data.delete_indirect === true,
                polynomial: e.data.polynomial,
                applyExtraction: true,
                extractFrom: toFloat(e.data.extract_direct_from, 8.8),
                extractTo: toFloat(e.data.extract_direct_to, 7.0)
            });

            // Apply phase correction: automatic (if enabled) or manual (if provided)
            if (useAutoPhase) {
                // Apply manual phase overrides if auto is disabled for those dimensions
                if (e.data.auto_direct === false) {
                    processor.set_user_phase_correction(phasing_data[0], phasing_data[1]);
                }
                if (e.data.auto_indirect === false) {
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
            } else {
                // Apply manual phase corrections if no auto phase correction
                processor.set_user_phase_correction(phasing_data[0], phasing_data[1]);
                processor.set_user_phase_correction_indirect(phasing_data[2], phasing_data[3]);
            }

            const outputVec = new ModuleCpp.VectorUChar();
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
                let pseudo3dSpectraCount = 1;
                try {
                    const pseudo3dJsonString = processor.write_pseudo3d_json_as_string();
                    const parsedPseudo3d = JSON.parse(pseudo3dJsonString);
                    if (Number.isFinite(parsedPseudo3d.spectra)) {
                        pseudo3dSpectraCount = Math.max(1, parseInt(parsedPseudo3d.spectra, 10));
                    }
                }
                catch (_err) {
                    pseudo3dSpectraCount = 1;
                }

                if (pseudo3dSpectraCount > 1) {
                    postMessage({ stdout: "Pseudo-3D all-planes detected, but current class bindings do not expose per-plane ft2 export. Returning first plane only." });
                }
            }
        }
        finally {
            processor.delete();
            fidBytesVec.delete();
        }

        postMessage({
            webassembly_job: e.data.webassembly_job,
            file_data: file_data,
            file_type: 'full',
            pseudo3d_files: pseudo3d_files,
            phasing_data: phasing_data.join(' '),
            apodization_indirect: apodization_indirect,
            processing_flag: e.data.processing_flag,
            spectrum_index: e.data.spectrum_index,
            pseudo3d_children: e.data.pseudo3d_children,
        });
        }
        catch (error) {
            const errorText = error && error.message ? error.message : String(error);
            postMessage({ stdout: "Class-based process_fid failed, switching to legacy workflow: " + errorText });
            runProcessFidLegacy(e);
        }
    }

    /**
     * If the message contains both spectrum_data and picked_peaks, call voigt_fit function
     */
    else if (e.data.webassembly_job === "peak_fitter") {
        console.log('Spectrum data and picked peaks received');
        /**
         * Save the spectrum data and picked peaks to the virtual file system
         */
        Module['FS_createDataFile']('/', 'hsqc.ft2', e.data.spectrum_data, true, true, true);
        Module['FS_createDataFile']('/', 'peaks.tab', e.data.picked_peaks, true, true, true);

        /**
         * Write a file named "argument_voigt_fit.txt" to the virtual file system
         * save -noise_level, -scale and -scale2 
         */
        let content = ' -peak_in peaks.tab -out fitted.json fitted.tab -noise_level '.concat(e.data.noise_level,' -scale ',e.data.scale,' -scale2 ',e.data.scale2);
        content = content.concat(' -combine ', e.data.combine_peak_cutoff);
        content = content.concat(' -maxround ', e.data.maxround);
        

        /**
         * If flag is 0, add -method voigt to the content
         * else if flag is 1, add -method gaussian
         * else, add -method voigt_lorentz
         */
        if (e.data.flag === 0) {
            content = content.concat(' -method voigt ');
        }
        else if (e.data.flag === 1){
            content = content.concat(' -method gaussian ');
        }
        else {
            content = content.concat(' -method voigt-lorentz ');
        }

        console.log(content);

        Module['FS_createDataFile']('/', 'argument_voigt_fit.txt', content, true, true, true);

        console.log('Spectrum data and picked peaks saved to virtual file system');
        /**
         * Run voigt_fit function
         */
        postMessage({ stdout: "Running voigt_fit function" });
        api.voigt_fit();
        console.log('Finished running web assembly code');
        /**
         * Remove the input files from the virtual file system
         * Read file peaks.json, parse it and send it back to the main script
         */
        FS.unlink('hsqc.ft2');
        FS.unlink('peaks.tab');
        FS.unlink('argument_voigt_fit.txt');
        let peaks = JSON.parse(FS.readFile('fitted.json', { encoding: 'utf8' }));
        let peaks_tab = FS.readFile('fitted.tab', { encoding: 'utf8' });
        FS.unlink('fitted.json');
        FS.unlink('fitted.tab');

        /**
         * If the flag is 0, read the file recon_voigt_hsqc.ft2 
         * else read the file recon_gaussian_hsqc.ft2
        */
        let filename;
        if(e.data.flag === 0)
        {
            filename='recon_voigt_hsqc.ft2';
        }
        else if(e.data.flag === 1)
        {
            filename='recon_gaussian_hsqc.ft2';
        }
        else
        {
            filename='recon_voigt_lorentz_hsqc.ft2';
        }

        const file_data = FS.readFile(filename, { encoding: 'binary' });
        console.log('File data read from virtual file system, type of file_data:', typeof file_data, ' and length:', file_data.length);
        FS.unlink(filename);
        postMessage({
            webassembly_job: e.data.webassembly_job,
            fitted_peaks: peaks,
            fitted_peaks_tab: peaks_tab, //peaks_tab is a very long string with multiple lines (in nmrPipe tab format)
            spectrum_origin: e.data.spectrum_index, //pass through the spectrum index of the original spectrum (run peak fitting and recon on)
            recon_spectrum: file_data,
            scale: e.data.scale,
            scale2: e.data.scale2
        });
    }


    /**
     * initial_peaks and all_files are received, run pseudo-3D fitting using api.voigt_fit
     * 
     */
    else if (e.data.webassembly_job === "pseudo3d_fitting") {
        console.log('Initial peaks and all files received');

        // Prefer class-based pseudo3D fitting when recon/error outputs are not requested.
        if (e.data.with_recon !== true && e.data.with_error !== true) {
            try {
                const ModuleCpp = await cppModulePromise;

                const toFloatOr = function (value, fallback) {
                    const parsed = parseFloat(value);
                    return Number.isFinite(parsed) ? parsed : fallback;
                };

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

                const convertAmpToHeightVolumePseudo = function (amp, sx, sy, gx, gy, peakShape) {
                    const a = Number.isFinite(amp) ? amp : 0.0;
                    const sxv = Number.isFinite(sx) ? Math.abs(sx) : 0.0;
                    const syv = Number.isFinite(sy) ? Math.abs(sy) : 0.0;
                    const gxv = Number.isFinite(gx) ? Math.abs(gx) : 0.0;
                    const gyv = Number.isFinite(gy) ? Math.abs(gy) : 0.0;

                    // Internal amp meaning from C++ gaussian_fit depends on peak shape.
                    // pseudo3D mapping currently uses 1=Gaussian, 2=Voigt (3 supported if provided).
                    //   shape 1: amp is already HEIGHT
                    //   shape 2: amp is volume-like, HEIGHT = amp*voigt(0,sx,gx)*voigt(0,sy,gy)
                    //   shape 3: amp is volume-like, HEIGHT = amp*voigt(0,sx,gx)
                    if (peakShape === 1) {
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

                const regions = Array.isArray(e.data.regions) ? e.data.regions : [];
                if (regions.length === 0) {
                    throw new Error('No pre-partitioned pseudo3D regions provided from main thread');
                }

                const peakComments = Array.isArray(e.data.peak_comments) ? e.data.peak_comments : [];
                const peakXppm = Array.isArray(e.data.peak_xppm) ? e.data.peak_xppm : [];
                const peakYppm = Array.isArray(e.data.peak_yppm) ? e.data.peak_yppm : [];

                const defaultNoise = toFloatOr(e.data.noise_level, 1.0);
                const defaultScale2 = toFloatOr(e.data.scale2, 3.0);
                const defaultPeakShape = e.data.flag === 0 ? 2 : 1; // 2: voigt, 1: gaussian
                const defaultMaxround = parseInt(e.data.maxround, 10) || 20;

                const fittedRows = [];
                let completedRegions = 0;
                postMessage({ webassembly_job: "pseudo3d_progress", done: completedRegions, total: regions.length });
                for (let clusterId = 0; clusterId < regions.length; clusterId++) {
                    const region = regions[clusterId];
                    if (!region) {
                        completedRegions++;
                        postMessage({ webassembly_job: "pseudo3d_progress", done: completedRegions, total: regions.length });
                        continue;
                    }

                    const nspect = parseInt(region.nspectra, 10) || 0;
                    if (nspect <= 0) {
                        completedRegions++;
                        postMessage({ webassembly_job: "pseudo3d_progress", done: completedRegions, total: regions.length });
                        continue;
                    }

                    const surfaceVec = new ModuleCpp.VectorDouble();
                    const xVec = new ModuleCpp.VectorDouble();
                    const yVec = new ModuleCpp.VectorDouble();
                    const aVec = new ModuleCpp.VectorDouble();
                    const sxVec = new ModuleCpp.VectorDouble();
                    const syVec = new ModuleCpp.VectorDouble();
                    const gxVec = new ModuleCpp.VectorDouble();
                    const gyVec = new ModuleCpp.VectorDouble();
                    const originalNdxVec = new ModuleCpp.VectorInt();
                    const cannotMoveVec = new ModuleCpp.VectorInt();

                    try {
                        const surface = region.surface || [];
                        const xx = region.x || [];
                        const yy = region.y || [];
                        const aas = region.amp || [];
                        const sx = region.sigmax || [];
                        const sy = region.sigmay || [];
                        const gx = region.gammax || [];
                        const gy = region.gammay || [];
                        const ori = region.originalNdx || [];
                        const cannotMove = region.cannotMove || [];

                        for (let i = 0; i < surface.length; i++) {
                            surfaceVec.push_back(surface[i]);
                        }
                        for (let i = 0; i < xx.length; i++) {
                            xVec.push_back(xx[i]);
                        }
                        for (let i = 0; i < yy.length; i++) {
                            yVec.push_back(yy[i]);
                        }
                        for (let i = 0; i < aas.length; i++) {
                            // region.amp uses peak-major flattening: [peak0_s0, peak0_s1, ..., peak1_s0, ...].
                            aVec.push_back(aas[i]);
                        }
                        for (let i = 0; i < sx.length; i++) {
                            sxVec.push_back(sx[i]);
                        }
                        for (let i = 0; i < sy.length; i++) {
                            syVec.push_back(sy[i]);
                        }
                        for (let i = 0; i < gx.length; i++) {
                            gxVec.push_back(gx[i]);
                        }
                        for (let i = 0; i < gy.length; i++) {
                            gyVec.push_back(gy[i]);
                        }
                        for (let i = 0; i < ori.length; i++) {
                            originalNdxVec.push_back(ori[i]);
                        }
                        for (let i = 0; i < cannotMove.length; i++) {
                            cannotMoveVec.push_back(cannotMove[i]);
                        }

                        const fitter = new ModuleCpp.gaussian_fit();
                        try {
                            const peakShape = parseInt(region.peakShape, 10) || defaultPeakShape;
                            const maxround = parseInt(region.maxround, 10) || defaultMaxround;
                            const localClusterId = parseInt(region.clusterLocalIndex, 10);
                            fitter.set_everything_wasm(peakShape, maxround, Number.isFinite(localClusterId) ? localClusterId : clusterId);

                            const okInit = fitter.init(
                                parseInt(region.xstart, 10) || 0,
                                parseInt(region.ystart, 10) || 0,
                                parseInt(region.xdim, 10) || 0,
                                parseInt(region.ydim, 10) || 0,
                                nspect,
                                surfaceVec,
                                xVec,
                                yVec,
                                aVec,
                                sxVec,
                                syVec,
                                gxVec,
                                gyVec,
                                originalNdxVec,
                                cannotMoveVec,
                                toFloatOr(region.medianWidthX, 3.0),
                                toFloatOr(region.medianWidthY, 3.0)
                            );

                            if (!okInit) {
                                continue;
                            }

                            const paras = region.peakParas || {};
                            fitter.set_peak_paras(
                                toFloatOr(paras.wx, 6.0),
                                toFloatOr(paras.wy, 6.0),
                                toFloatOr(paras.noise, defaultNoise),
                                toFloatOr(paras.minHeight, defaultNoise * defaultScale2),
                                toFloatOr(paras.tooNearCutoff, 0.2),
                                toFloatOr(paras.xppmStep, 1.0),
                                toFloatOr(paras.yppmStep, 1.0),
                                toFloatOr(paras.removalCutoff, 0.1)
                            );

                            // Match the legacy worker order/inputs: set sign before running the fit.
                            fitter.peak_sign = (parseInt(region.peakSign, 10) === -1) ? -1 : 1;

                            if (!fitter.run(1)) {
                                continue;
                            }

                            const nround = fitter.get_nround();
                            for (let i = 0; i < fitter.npeak; i++) {
                                const originalNdx = fitter.original_ndx.get(i);
                                const sx0 = fitter.sigmax.get(i);
                                const sy0 = fitter.sigmay.get(i);
                                const gx0 = fitter.gammax.get(i);
                                const gy0 = fitter.gammay.get(i);
                                const amp0 = fitter.amp.get(i * nspect);
                                // fitter.amp is internal fitted amp (shape-dependent meaning above).
                                // Convert to explicit HEIGHT and VOLUME for output table.
                                const hv = convertAmpToHeightVolumePseudo(amp0, sx0, sy0, gx0, gy0, peakShape);
                                let allSpectraHeights = [];
                                for (let k = 0; k < nspect; k++) {
                                    // Keep raw fitted amp per spectrum.
                                    // For non-Gaussian shapes this is volume-like, not apex height.
                                    allSpectraHeights.push(fitter.amp.get(i * nspect + k));
                                }

                                fittedRows.push({
                                    originalNdx: originalNdx,
                                    xAxis1: fitter.x.get(i) + fitter.xstart + 1.0,
                                    yAxis1: fitter.y.get(i) + fitter.ystart + 1.0,
                                    height: hv.height,
                                    volume: hv.volume,
                                    dheight: fitter.err.get(i),
                                    sigmax: sx0,
                                    sigmay: sy0,
                                    gammax: gx0,
                                    gammay: gy0,
                                    nround: nround,
                                    clusterId: Number.isFinite(localClusterId) ? localClusterId : clusterId,
                                    allSpectraHeights: allSpectraHeights,
                                });
                            }
                        }
                        finally {
                            fitter.delete();
                        }
                    }
                    finally {
                        surfaceVec.delete();
                        xVec.delete();
                        yVec.delete();
                        aVec.delete();
                        sxVec.delete();
                        syVec.delete();
                        gxVec.delete();
                        gyVec.delete();
                        originalNdxVec.delete();
                        cannotMoveVec.delete();
                    }

                    completedRegions++;
                    postMessage({ webassembly_job: "pseudo3d_progress", done: completedRegions, total: regions.length });
                }

                if (fittedRows.length === 0) {
                    throw new Error('No fitted peaks returned from partitioned class fitting');
                }

                fittedRows.sort(function (a, b) {
                    return a.originalNdx - b.originalNdx;
                });

                let zColumns = '';
                let zFormats = '';
                const nspectraForRatio = Array.isArray(e.data.all_spectra_indices) ? e.data.all_spectra_indices.length : 0;
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
                        // Z_A* columns are normalized from per-spectrum fitted amp values.
                        for (let k = 0; k < nspectraForRatio; k++) {
                            const h = (row.allSpectraHeights && k < row.allSpectraHeights.length)
                                ? Number(row.allSpectraHeights[k])
                                : 0.0;
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
                    webassembly_job: e.data.webassembly_job,
                    pseudo3d_fitted_peaks_tab: peaksTab,
                    fitted_err: [],
                    recon_files: [],
                    all_spectra_indices: e.data.all_spectra_indices,
                });
                return;
            }
            catch (classError) {
                postMessage({ stdout: 'Class-based pseudo3D fitting failed, falling back to legacy voigt_fit path: ' + (classError && classError.message ? classError.message : String(classError)) });
            }
        }

        Module['FS_createDataFile']('/', 'peaks.tab',e.data.initial_peaks, true, true, true);

        /**
         * Save all files in e.data.all_files to the virtual file system,
         * name them as test1.ft2, test2.ft2, test3.ft2, ...
         */
        for (let i = 0; i < e.data.all_files.length; i++) {
            Module['FS_createDataFile']('/', 'test'.concat(i + 1, '.ft2'), e.data.all_files[i], true, true, true);
        }

        /**
         * Write a file named "arguments_pseudo_3D.txt" to the virtual file system
         * save -noise_level, -scale and -scale2
         * "-recon yes -folder . " means save recon files in the current folder
         */
        let content = ' -v 0 -peak_in peaks.tab -out fitted.tab -noise_level '.concat(e.data.noise_level,' -scale ',e.data.scale,' -scale2 ',e.data.scale2);
        content = content.concat(' -maxround ', e.data.maxround);

        /**
         * If with_recon is true, add -recon yes to the content
         */
        if (e.data.with_recon === true) {
            content = content.concat(' -recon yes -recon yes -folder . ');
        }
        else {
            content = content.concat(' -recon no ');
        }

        /**
         * If with_error is true, add -n_err 10 to the content
         */
        if (e.data.with_error === true) {
            content = content.concat(' -n_err 10 ');
        }

        /**
         * If flag is 0, add -method voigt to the content
         * else add -method gaussian
         */
        if (e.data.flag === 0) {
            content = content.concat(' -method voigt ');
        }
        else {
            content = content.concat(' -method gaussian ');
        }
        /**
         * Add "-in test1.ft2 test2.ft2 test3.ft2 ..." to the content
         */
        content = content.concat(' -in ');
        for (let i = 0; i < e.data.all_files.length; i++) {
            content = content.concat(' test'.concat(i + 1, '.ft2 '));
        }

        console.log(content);

        Module['FS_createDataFile']('/', 'argument_voigt_fit.txt', content, true, true, true);
        console.log('Initial peaks and spectral files saved to virtual file system');


        /**
         * Run voigt_fit function
         */
        postMessage({ stdout: "Running pseudo-3D fitting" });
        api.voigt_fit();
        console.log('Finished running web assembly code');
        /**
         * Remove the input file from the virtual file system
         * Read file peaks.json, parse it and send it back to the main script
         */
        FS.unlink('peaks.tab');
        FS.unlink('argument_voigt_fit.txt');
        for(let i=0; i<e.data.all_files.length; i++)   {
            FS.unlink('test'.concat(i+1, '.ft2'));
        }

        let peaks_tab = FS.readFile('fitted.tab', { encoding: 'utf8' });
        FS.unlink('fitted.tab');

        /**
         * If e.data.with_error is true, we also need to read and send back the following files:
         * fitted_err_0.tab fitted_err_1.tab fitted_err_2.tab ... fitted_err_9.tab (because -n_err 10)
         */
        let fitted_err = [];
        if (e.data.with_error === true) {
            for (let i = 0; i < 10; i++) {
                fitted_err.push(FS.readFile('fitted_err_'.concat(i, '.tab'), { encoding: 'utf8' }));
                FS.unlink('fitted_err_'.concat(i, '.tab'));
            }
        }

        /**
         * Read all recon files and send them back to the main script
         */
        let recon_files = [];
        if (e.data.with_recon === true) 
        {   
            /**
             * Recon file name depends on the flag
             */
            let recon_file_name_part;
            if (e.data.flag === 0) {
                recon_file_name_part = 'voigt_test';
            }
            else {
                recon_file_name_part = 'gaussian_test';
            }

            for (let i = 0; i < e.data.all_files.length; i++) {
                recon_files.push(FS.readFile('recon_'.concat(recon_file_name_part,i + 1, '.ft2'), { encoding: 'binary' }));
                FS.unlink('recon_'.concat(recon_file_name_part,i + 1, '.ft2'));
                FS.unlink('diff_'.concat(recon_file_name_part,i + 1, '.ft2'));
            }
        }

        /**
         * Read the file recon_voigt_hsqc.ft2 
         */
        postMessage({
            webassembly_job: e.data.webassembly_job,
            pseudo3d_fitted_peaks_tab: peaks_tab, //peaks_tab is a very long string with multiple lines (in nmrPipe tab format)
            fitted_err: fitted_err,
            recon_files: recon_files, //recon_files is a list of binary files. empty if with_recon is false
            all_spectra_indices: e.data.all_spectra_indices, //pass through the all_spectra_indices
        });
    }

    /**
     * assignment and fitted_peaks_tab are received. Run api.peak_match to transfer the assignment to the fitted peaks
     */
    else if(e.data.webassembly_job === "assignment") {
        console.log('Assignment and fitted peaks tab received');
        /**
         * Save the assignment to the virtual file system
         */
        Module['FS_createDataFile']('/', 'assignment.list', e.data.assignment, true, true, true);

        /**
         * Save the fitted_peaks_tab to the virtual file system
         */
        Module['FS_createDataFile']('/', 'fitted_peaks_tab.tab', e.data.fitted_peaks_tab, true, true, true);

        /**
         * Write a file named "arguments_peak_match.txt" to the virtual file system
         */
        let content = ' -in2 fitted_peaks_tab.tab -in1 assignment.list -out assigned.tab -out-ass assignment.txt';
        Module['FS_createDataFile']('/', 'arguments_peak_match.txt', content, true, true, true);
        console.log(content);

        console.log('Assignment and fitted peaks tab saved to virtual file system');
        /**
         * Run peak_match function
         */
        postMessage({ stdout: "Running peak_match function" });
        api.peak_match();
        console.log('Finished running web assembly code of assignment transfer');
        /**
         * Remove the input files from the virtual file system
         * Read file matched_peaks.tab, parse it and send it back to the main script
         */
        FS.unlink('assignment.list');
        FS.unlink('fitted_peaks_tab.tab');
        FS.unlink('arguments_peak_match.txt');
        let matched_peaks_tab = FS.readFile('assigned.tab', { encoding: 'utf8' });
        let assignment = FS.readFile('assignment.txt',{ encoding: 'utf8' });
        FS.unlink('assigned.tab');
        FS.unlink('assignment.txt');
        postMessage({
            matched_peaks_tab: matched_peaks_tab,
            assignment: assignment,
            webassembly_job: e.data.webassembly_job,
        });
    }

    /**
     * Run spin optimization
     */
    else if(e.data.webassembly_job === "spin_optimization")
    {
        console.log('spin optimization data received');
        /**
         * Save the spectrum data to the virtual file system
         */
        Module['FS_createDataFile']('/', 'test.ft2', e.data.spectrum_file, true, true, true);

       /**
        * Save the peaks to the virtual file system
        * fitted_peaks_tab is a very long string with multiple lines (in nmrPipe tab format)
        */
        Module['FS_createDataFile']('/', 'fitted.tab', e.data.fitted_peaks_file, true, true, true);

        /**
         * Write a file named "arguments_spin_optimization.txt" to the virtual file system
         */
        let content = ' -in test.ft2 -peak-in fitted.tab -out spin_system.txt -b0 '.concat(e.data.b0);
        Module['FS_createDataFile']('/', 'arguments_spin_optimization.txt', content, true, true, true);

        /**
         * Run spin_optimization function
         */
        postMessage({ stdout: "Running spin optimization function" });
        api.spin_optimization();
        console.log('Finished running spin optimization');

        /**
         * Remove the input files from the virtual file system
         * Read file spin_system.txt, parse it and send it back to the main script
         */
        FS.unlink('test.ft2');
        FS.unlink('fitted.tab');
        FS.unlink('arguments_spin_optimization.txt');
        let spin_system = FS.readFile('spin_system.txt', { encoding: 'utf8' });
        FS.unlink('spin_system.txt');
        postMessage({
            webassembly_job: e.data.webassembly_job,
            spin_system: spin_system,//long string with multiple lines
        });
    }

}




