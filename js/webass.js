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
     * If the message is file_data with only 1 file, this is the 2nd step of normal processing (indirect dimension)
     * after NUS reconstruction. Save the file to the virtual file system and run fid (-process indirect) function
     */
    if (e.data.webassembly_job === "nus_step2") {
        console.log('File data received for indirect processing');

        Module['FS_createDataFile']('/', 'test_smile.ft2', e.data.file_data[0], true, true, true);
        let content = ' -first-only yes ';
        content = content.concat(' -zf-indirect ',e.data.zf_indirect);
        content = content.concat(' -apod-indirect ',e.data.apodization_indirect);
        content = content.concat(' -in test_smile.ft2 ');
        content = content.concat(' -process indirect ');
        content = content.concat(' -phase-in phase-correction.txt -di yes -di-indirect yes');
        content = content.concat(' -out test.ft2');

        /**
         * Write a file named "arguments_fid_2d.txt" to the virtual file system
         */
        Module['FS_createDataFile']('/', 'arguments_fid_2d.txt', content, true, true, true);

        /**
         * Write a file named "phase-correction.txt" to the virtual file system.
         * first two numbers are for direct dimension, which will be ignored
         */
        let phase_correction = '0 0 ';
        phase_correction=phase_correction.concat(e.data.phase_correction_indirect_p0.toString());
        phase_correction=phase_correction.concat(' ', e.data.phase_correction_indirect_p1.toString());
        Module['FS_createDataFile']('/', 'phase-correction.txt', phase_correction, true, true, true);

        console.log(content);

        postMessage({ stdout: "Running fid function to process indirect dimension of NUS spectrum" });
        api.fid();
        console.log('Finished running fid for indirect dimension of NUS spectrum');

        FS.unlink('test_smile.ft2');
        FS.unlink('arguments_fid_2d.txt');
        const phasing_data = FS.readFile('phase-correction.txt', { encoding: 'utf8' });
        FS.unlink('phase-correction.txt');
        const file_data = FS.readFile('test.ft2', { encoding: 'binary' });
        FS.unlink('test.ft2');
        console.log('File data read from virtual file system, type of file_data:', typeof file_data, ' and length:', file_data.length);
        postMessage({
            webassembly_job: e.data.webassembly_job,
            file_data: file_data,
            file_type: 'indirect', //direct,indirect,full
            phasing_data: phasing_data,
            processing_flag: e.data.processing_flag, //passthrough the processing flag
            spectrum_index: e.data.spectrum_index //for reprocessing only
        });
    }

    /**
     * If the message is file_data with 4 file, save them to the virtual file system and run direct dimension only processing.
     * (This is a NUS spectrum with 4 files: acquisition_file, acquisition_file2, fid_file and nuslist)
     */
    if (e.data.webassembly_job === "nus_step1") {
        console.log('File data received for NUS processing');
        /**
         * Save the file data to the virtual file system
         */
        Module['FS_createDataFile']('/', 'acquisition_file', e.data.file_data[0], true, true, true);
        Module['FS_createDataFile']('/', 'acquisition_file2', e.data.file_data[1], true, true, true);
        Module['FS_createDataFile']('/', 'fid_file', e.data.file_data[2], true, true, true);
        Module['FS_createDataFile']('/', 'nuslist', e.data.file_data[3], true, true, true);

        let direct_phase_correction_p0 = e.data.phase_correction_direct_p0;
        let direct_phase_correction_p1 = e.data.phase_correction_direct_p1;

        /**
         * If e.data.auto_direct is true, we will run automatic phase correction for direct dimension
         */
        if(e.data.auto_direct === true)
        {
            /**
             * Portend this is NOT a NUS spectrum, but a normal spectrum.
             * For phasing purpose, do NOT use ext
             */
            let content = ' -first-only yes -aqseq '.concat(e.data.acquisition_seq,' -negative ',e.data.neg_imaginary);
            content = content.concat(' -zf '.concat(e.data.zf_direct));
            content = content.concat(' -apod '.concat(e.data.apodization_direct));
            content = content.concat(' -in fid_file acquisition_file acquisition_file2 none');
            content = content.concat(' -nus nuslist'); //to fill in zeros for not sampled points
            content = content.concat(' -process full -di no -di-indirect no');
            content = content.concat(' -out test0.ft2');
            Module['FS_createDataFile']('/', 'arguments_fid_2d.txt', content, true, true, true);
            console.log(content);

            /**
             * Write a file named "phase-correction.txt" to the virtual file system.
             * leave direct phase correction as 0 0 (for automatic phase correction)
             * and indirect phase correction from user input (this is required for NUS processing)
             */
            let phase_correction = '0 0 ';
            phase_correction=phase_correction.concat(e.data.phase_correction_indirect_p0.toString());
            phase_correction=phase_correction.concat(' ', e.data.phase_correction_indirect_p1.toString());
            Module['FS_createDataFile']('/', 'phase-correction.txt', phase_correction, true, true, true);

            /**
             * Call fid function
             */
            postMessage({ stdout: "Running fid function to process NUS spectrum as normal for phasing estimation" });
            api.fid();
            console.log('Finished running fid for direct dimension of NUS spectrum');

            /**
             * Remove files from virtual file system. Keep FID, because we will use them in final processing
             */
            FS.unlink('arguments_fid_2d.txt');
            FS.unlink('phase-correction.txt');

            /**
             * Write a file named "arguments_phase_2d.txt" to the virtual file system
             */
            content = ' -in test0.ft2 -out none -out-phase phase-correction.txt';
            content = content.concat(' -user no ');
            content = content.concat(' -user-indirect yes -user-phase-indirect 0 0'); //because we already applied phase correction for indirect dimension above
            Module['FS_createDataFile']('/', 'arguments_phase_2d.txt', content, true, true, true);

            console.log(content);

            /**
             * Call phasing function
             */
            postMessage({ stdout: "Running phasing function to estimate phase correction for direct dimension" });
            api.phasing();
            console.log('Finished running phasing for direct dimension of NUS spectrum');

            FS.unlink('arguments_phase_2d.txt');
            FS.unlink('test0.ft2');

            /**
             * At this time, first two numbers in phase-correction.txt are estimated phase correction for direct dimension
             * last two numbers are 0 and 0, because test0.ft2 has already has indirect phase correction applied.
             * Update direct phase correction values
             */
            let phase_correction_values = FS.readFile('phase-correction.txt', { encoding: 'utf8' }).trim().split(/\s+/);
            direct_phase_correction_p0 = parseFloat(phase_correction_values[0]);
            direct_phase_correction_p1 = parseFloat(phase_correction_values[1]);

            FS.unlink('phase-correction.txt');
        }

        /**
         * Write file named 'phase-correction.txt' to the virtual file system, with direct phase correction values
         * and indirect phase correction values as 0 0, because they are not used in this step.
         */
        let phase_correction = direct_phase_correction_p0.toString();
        phase_correction=phase_correction.concat(' ', direct_phase_correction_p1.toString());
        phase_correction=phase_correction.concat(' 0 0');
        Module['FS_createDataFile']('/', 'phase-correction.txt', phase_correction, true, true, true);


        /**
         * Write a file named "arguments_fid_2d.txt" to the virtual file system
         */
        let content = ' -first-only yes -aqseq '.concat(e.data.acquisition_seq,' -negative ',e.data.neg_imaginary);
        content = content.concat(' -zf '.concat(e.data.zf_direct));
        content = content.concat(' -apod '.concat(e.data.apodization_direct));
        content = content.concat(' -in fid_file acquisition_file acquisition_file2 none');
        content = content.concat(' -nus nuslist');
        content = content.concat(' -ext '.concat(e.data.extract_direct_from, ' ', e.data.extract_direct_to));
        content = content.concat(' -process direct -di yes -di-indirect no');
        content = content.concat(' -out test_direct.ft2');
        Module['FS_createDataFile']('/', 'arguments_fid_2d.txt', content, true, true, true);
        console.log(content);

        /**
         * Call fid function
         */
        postMessage({ stdout: "Running fid function to process direct dimension of NUS spectrum." });
        api.fid();
        console.log('Finished running fid for direct dimension of NUS spectrum');

        FS.unlink('acquisition_file');
        FS.unlink('acquisition_file2');
        FS.unlink('fid_file');
        FS.unlink('nuslist');
        FS.unlink('arguments_fid_2d.txt');
        FS.unlink('phase-correction.txt');
        const file_data = FS.readFile('test_direct.ft2', { encoding: 'binary' });
        console.log('File data read from virtual file system, type of file_data:', typeof file_data, ' and length:', file_data.length);
        FS.unlink('test_direct.ft2');
        postMessage({
            webassembly_job: e.data.webassembly_job,
            file_data: file_data,
            file_type: 'direct', //direct,direct-smile,full
            phasing_data: phase_correction,
            processing_flag: e.data.processing_flag, //passthrough the processing flag
            spectrum_index: e.data.spectrum_index //for reprocessing only
        });
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

            if (options.applyExtraction === true) {
                if (!processor.extract_region(options.extractFrom, options.extractTo)) {
                    throw new Error('extract_region failed');
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

        const normalizeExtractFraction = function (value, fallbackValue) {
            const parsed = toFloat(value, fallbackValue);
            // UI provides percentages (0-100), while class API expects normalized [0,1].
            const normalized = parsed / 100.0;
            return Math.max(0.0, Math.min(1.0, normalized));
        };

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
                applyExtraction: false,
                extractFrom: 0,
                extractTo: 1
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

            // Extract region after phase correction
            if (!processor.extract_region(
                normalizeExtractFraction(e.data.extract_direct_from, 0),
                normalizeExtractFraction(e.data.extract_direct_to, 100)
            )) {
                throw new Error('extract_region failed');
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
     * Pure JavaScript phase correction: apply direct + indirect phase rotation.
     *
     * Component convention used here:
     *   raw_data    -> RR (real direct, real indirect)
     *   raw_data_ri -> RI (real direct, imag indirect)
     *   raw_data_ir -> IR (imag direct, real indirect)
     *   raw_data_ii -> II (imag direct, imag indirect)
     */
    else if (e.data.webassembly_job === "apply_phase_correction") {
        console.log('Spectrum data and phase correction received (pure JS)');
        
        try {
            const spectrumUint8 = new Uint8Array(e.data.spectrum_data);
            const inputFloat32 = new Float32Array(spectrumUint8.buffer);
            const outputFloat32 = new Float32Array(inputFloat32.length);
            outputFloat32.set(inputFloat32);

            const headerFloat32 = outputFloat32.subarray(0, 512);
            
            // Extract header information (nmrPipe ft2 format)
            const n_direct = Math.abs(Math.round(headerFloat32[99]));   // FSIZE (direct)
            const n_indirect = Math.abs(Math.round(headerFloat32[219])); // NDSIZE (indirect)
            const datatype_direct = Math.round(headerFloat32[55]);  // FDTYPE: 0=complex, 1=real
            const datatype_indirect = Math.round(headerFloat32[56]); // FDTYPE indirect
            
            const p0_direct = e.data.phase_correction[0][0];
            const p1_direct = e.data.phase_correction[0][1];
            const p0_indirect = e.data.phase_correction[1][0];
            const p1_indirect = e.data.phase_correction[1][1];
            
            const b_auto = (p0_direct === 0 && p1_direct === 0 && p0_indirect === 0 && p1_indirect === 0);

            // Data block order per indirect row in the packed buffer:
            // [RR] [RI if present] [IR if present] [II if RI and IR are present]
            const has_ri = (datatype_direct === 0);
            const has_ir = (datatype_indirect === 0);

            const points_per_slice = n_direct * (1 + (has_ri ? 1 : 0) + (has_ir ? 1 : 0) + (has_ri && has_ir ? 1 : 0));
            const spectrum_data = outputFloat32.subarray(512);

            const rr_offset = 0;
            const ri_offset = has_ri ? n_direct : -1;
            const ir_offset = has_ir ? (n_direct + (has_ri ? n_direct : 0)) : -1;
            const ii_offset = (has_ri && has_ir) ? (n_direct + n_direct + n_direct) : -1;

            // Apply phase correction in two steps per point.
            // In this packed layout, the second block pairs with RR for direct phasing,
            // and the third block pairs with RR for indirect phasing.
            for (let ind = 0; ind < n_indirect; ind++) {
                const slice_offset = ind * points_per_slice;

                const indirect_phase_rad = (p0_indirect + p1_indirect * (ind / n_indirect)) * Math.PI / 180.0;
                const cos_indirect = Math.cos(indirect_phase_rad);
                const sin_indirect = Math.sin(indirect_phase_rad);

                for (let f = 0; f < n_direct; f++) {
                    const direct_phase_rad = (p0_direct + p1_direct * (f / n_direct)) * Math.PI / 180.0;
                    const cos_direct = Math.cos(direct_phase_rad);
                    const sin_direct = Math.sin(direct_phase_rad);

                    const rr_idx = slice_offset + rr_offset + f;
                    const ri_idx = (ri_offset >= 0) ? (slice_offset + ri_offset + f) : -1;
                    const ir_idx = (ir_offset >= 0) ? (slice_offset + ir_offset + f) : -1;
                    const ii_idx = (ii_offset >= 0) ? (slice_offset + ii_offset + f) : -1;

                    let rr = spectrum_data[rr_idx];
                    let ri = (ri_idx >= 0) ? spectrum_data[ri_idx] : 0;
                    let ir = (ir_idx >= 0) ? spectrum_data[ir_idx] : 0;
                    let ii = (ii_idx >= 0) ? spectrum_data[ii_idx] : 0;

                    // Direct rotation.
                    {
                        const rr_d = rr * cos_direct - ri * sin_direct;
                        const ri_d = rr * sin_direct + ri * cos_direct;
                        const ir_d = ir * cos_direct - ii * sin_direct;
                        const ii_d = ir * sin_direct + ii * cos_direct;
                        rr = rr_d;
                        ri = ri_d;
                        ir = ir_d;
                        ii = ii_d;
                    }

                    // Indirect rotation.
                    {
                        const rr_i = rr * cos_indirect - ir * sin_indirect;
                        const ir_i = rr * sin_indirect + ir * cos_indirect;
                        const ri_i = ri * cos_indirect - ii * sin_indirect;
                        const ii_i = ri * sin_indirect + ii * cos_indirect;
                        rr = rr_i;
                        ir = ir_i;
                        ri = ri_i;
                        ii = ii_i;
                    }

                    spectrum_data[rr_idx] = rr;
                    if (ri_idx >= 0) {
                        spectrum_data[ri_idx] = ri;
                    }
                    if (ir_idx >= 0) {
                        spectrum_data[ir_idx] = ir;
                    }
                    if (ii_idx >= 0) {
                        spectrum_data[ii_idx] = ii;
                    }
                }
            }

            // Convert back to Uint8Array for transmission
            const outputUint8 = new Uint8Array(outputFloat32.buffer);
            const phase_correction_str = b_auto ? "" : e.data.phase_correction.map(x => x.join(' ')).join(' ');
            
            postMessage({
                webassembly_job: e.data.webassembly_job,
                file_data: outputUint8,
                automatic_pc: b_auto,
                phase_correction: phase_correction_str,
                spectrum_name: e.data.spectrum_name,
                spectrum_index: e.data.spectrum_index
            });
            
        } catch (error) {
            postMessage({
                error: "Pure JS phase correction failed: " + error.message,
                spectrum_index: e.data.spectrum_index,
                spectrum_name: e.data.spectrum_name
            });
        }
    }


    /**
     * initial_peaks and all_files are received, run pseudo-3D fitting using api.voigt_fit
     * 
     */
    else if (e.data.webassembly_job === "pseudo3d_fitting") {
        console.log('Initial peaks and all files received');

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




