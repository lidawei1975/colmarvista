/**
 * This is a web worker that will be used to run the web assembly code
 */


importScripts('webdp.js');

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

onmessage = function (e) {
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
     * If the message is file_data with 3 files, save them to the virtual file system and run fid and phasing functions
     * return the processed data to the main script as file_data
     */
    if (e.data.webassembly_job === "process_fid") {
        console.log('File data received');
        /**
         * Save the file data to the virtual file system
         */
        Module['FS_createDataFile']('/', 'acquisition_file', e.data.file_data[0], true, true, true);
        Module['FS_createDataFile']('/', 'acquisition_file2', e.data.file_data[1], true, true, true);
        Module['FS_createDataFile']('/', 'fid_file', e.data.file_data[2], true, true, true);    
        console.log('File data saved to virtual file system');

        let apodization_indirect = e.data.apodization_indirect;

        /**
         * Write a file named "arguments_fid_phasing.txt" to the virtual file system
         * C++ program will read it to get "command line arguments"
         */
        let content = ' -aqseq '.concat(e.data.acquisition_seq,' -negative ',e.data.neg_imaginary);
        content = content.concat(' -zf '.concat(e.data.zf_direct,' -zf-indirect ',e.data.zf_indirect));
        content = content.concat(' -apod '.concat(e.data.apodization_direct));
        content = content.concat(' -apod-indirect '.concat(apodization_indirect));
        content = content.concat(' -poly '.concat(e.data.polynomial));
        content = content.concat(' -in fid_file acquisition_file acquisition_file2 none');

        /**
         * Water suppression ?
         */
        if(e.data.water_suppression === true)
        {
            content = content.concat(' -water yes ');
        }
        else
        {
            content = content.concat(' -water no ');
        }

        /**
         * If both auto_direct and auto_indirect are false, add -phase-in phase-correction.txt to the content
         * and write a file named "phase-correction.txt" to the virtual file system. 
         * Later, we will skip the automatic phase correction program called "phasing"
         * 
         * Otherwise, add -phase-in none to the content. User input phase correction will be read by
         * another program called "phasing", which will run one dimension or both dimensions phase correction
         */
        if (e.data.auto_direct === false && e.data.auto_indirect === false) {

            /**
             * if e.data.delete_direct === true, delete the direct dimension " -di yes ", otherwise "-di no "
             */
            if(e.data.delete_direct === true)
            {
                content = content.concat(' -di yes ');
            }
            else
            {
                content = content.concat(' -di no ');
            }

            /**
             * if e.data.delete_indirect === true, delete the indirect dimension " -di-indirect yes ", otherwise "-di-indirect no "
             */
            if(e.data.delete_indirect === true)
            {
                content = content.concat(' -di-indirect yes ');
            }
            else
            {
                content = content.concat(' -di-indirect no ');
            }

            if(e.data.pseudo3d_process === 'first_only')
            {   
                content = content.concat(' -first-only yes ');
            }
            else
            {
                content = content.concat(' -first-only no ');
            }

            content = content.concat(' -phase-in phase-correction.txt ');
            content = content.concat(' -ext '.concat(e.data.extract_direct_from, ' ', e.data.extract_direct_to));
            content = content.concat(' -out test.ft2');
            let phase_correction = e.data.phase_correction_direct_p0.toString();
            phase_correction=phase_correction.concat(' ', e.data.phase_correction_direct_p1.toString());
            phase_correction=phase_correction.concat(' ', e.data.phase_correction_indirect_p0.toString());
            phase_correction=phase_correction.concat(' ', e.data.phase_correction_indirect_p1.toString());
            Module['FS_createDataFile']('/', 'phase-correction.txt', phase_correction, true, true, true);

            Module['FS_createDataFile']('/', 'arguments_fid_2d.txt', content, true, true, true);
            console.log(content);
    
            /**
             * Run fid_phase function
             */
            postMessage({ stdout: "Running fid function" });
            api.fid();
            console.log('Finished running fid');
        }
        else
        {
            content = content.concat(' -first-only yes -out test0.ft2');
            /**
             * To run automatic phase correction, we need to set -phase-in none and keep -di no and -di-indirect no
             */
            content = content.concat(' -phase-in none -di no -di-indirect no');
            Module['FS_createDataFile']('/', 'arguments_fid_2d.txt', content, true, true, true);
            console.log(content);
    
            /**
             * Run fid_phase function
             */
            postMessage({ stdout: "Running automatic phase correction." });
            api.fid();
            console.log('Finished running fid');
       
            /**
             * Step 1, run phasing program, which will generate a file named "phase-correction.txt"
             */
            content = ' -in test0.ft2 -out none -out-phase phase-correction.txt';
            if(e.data.auto_direct === true)
            {
                content = content.concat(' -user no ');
            }
            else 
            {
                content = content.concat(' -user yes -user-phase '.concat(e.data.phase_correction_direct_p0.toString(),' ',e.data.phase_correction_direct_p1.toString()));
            }
            if(e.data.auto_indirect === true)
            {
                content = content.concat(' -user-indirect no ');
            }
            else 
            {
                content = content.concat(' -user-indirect yes -user-phase-indirect '.concat(e.data.phase_correction_indirect_p0.toString(),' ',e.data.phase_correction_indirect_p1.toString()));
            }
            Module['FS_createDataFile']('/', 'arguments_phase_2d.txt', content, true, true, true);
            console.log(content);
            api.phasing();
            console.log('Finished running phasing');
            FS.unlink('arguments_phase_2d.txt');

            /**
             * Check phase-correction.txt file and get the last number (indirect phase correction p1)
             */
            let phase_correction = FS.readFile('phase-correction.txt', { encoding: 'utf8' });
            let phase_correction_values = phase_correction.trim().split(/\s+/);
            /**
             * If indirect p1 is not 0, set indirect c parameter to 1.0
             * Otherwise, set it to 0.5
             */
            let c = 0.5;
            if (Math.abs(parseFloat(phase_correction_values[3])) > 20.0) {
                c = 1.0;
            }

            
            /**
             * Replace the c value in apodization_indirect with the new c value
             * apodization_indirect example: "SP begin 0.5 end 0.875 pow 2 elb 0 c 0.5"
             */
            let apodization_indirect_values = apodization_indirect.trim().split(/\s+/);
            /**
             * Find location of c in apodization_indirect_values
             */
            let c_index = apodization_indirect_values.indexOf('c');
            /**
             * Replace the value of c with the new value
             */
            apodization_indirect_values[c_index + 1] = c.toString();
            /**
             * Join the array back to a string
             */
            apodization_indirect = apodization_indirect_values.join(' ');

            /**
             * Step 2, run "fid" function again, with the new phase correction and write the new data to test.ft2
             * For pseudo-3D, include -first-only yes or no according to the user input in e.data.pseudo3d_process
             */
            if(e.data.pseudo3d_process === 'first_only')
            {   
                content = ' -first-only yes ';
            }
            else
            {
                content = ' -first-only no ';
            }
            content = content.concat('  -aqseq '.concat(e.data.acquisition_seq,' -negative ',e.data.neg_imaginary));
            content = content.concat(' -zf '.concat(e.data.zf_direct,' -zf-indirect ',e.data.zf_indirect));
            content = content.concat(' -apod '.concat(e.data.apodization_direct));
            content = content.concat(' -apod-indirect '.concat(apodization_indirect));
            content = content.concat(' -ext '.concat(e.data.extract_direct_from, ' ', e.data.extract_direct_to));
            content = content.concat(' -poly '.concat(e.data.polynomial));
            content = content.concat(' -out test.ft2');
            content = content.concat(' -in fid_file acquisition_file acquisition_file2 none');
            content = content.concat(' -phase-in phase-correction.txt ');
            /**
             * if e.data.delete_direct === true, delete the direct dimension " -di yes ", otherwise "-di no "
             */
            if(e.data.delete_direct === true)
            {
                content = content.concat(' -di yes ');
            }
            else
            {
                content = content.concat(' -di no ');
            }

            /**
             * if e.data.delete_indirect === true, delete the indirect dimension " -di-indirect yes ", otherwise "-di-indirect no "
             */
            if(e.data.delete_indirect === true)
            {
                content = content.concat(' -di-indirect yes ');
            }
            else
            {
                content = content.concat(' -di-indirect no ');
            }

            if(e.data.water_suppression === true)
            {
                content = content.concat(' -water yes ');
            }
            else
            {
                content = content.concat(' -water no ');
            }



            FS.unlink('test0.ft2');
            FS.unlink('arguments_fid_2d.txt');
            Module['FS_createDataFile']('/', 'arguments_fid_2d.txt', content, true, true, true);
            console.log(content);
            postMessage({ stdout: "Running fid function with automatic phase correction" });
            api.fid();
            console.log('Finished running fid with automatic phase correction');
        }
       


        /**
         * Remove the input files from the virtual file system
         * Read file test.ft2 from the virtual file system and send it back to the main script
         * And read the file phase-correction.txt and send it back to the main script
         * If auto, new phase correction will be saved in the file
         * IF not auto, the same phase correction (from input) will be saved in the file
         */
        FS.unlink('acquisition_file');
        FS.unlink('acquisition_file2');
        FS.unlink('fid_file');
        FS.unlink('arguments_fid_2d.txt');
        const file_data = FS.readFile('test.ft2', { encoding: 'binary' });
        const phasing_data = FS.readFile('phase-correction.txt', { encoding: 'utf8' });
        console.log('File data read from virtual file system, type of file_data:', typeof file_data, ' and length:', file_data.length);
        FS.unlink('test.ft2');
        FS.unlink('phase-correction.txt');

        let pseudo3d_files = [];
        if(e.data.pseudo3d_process === 'all_planes')
        {
            /**
             * Read a file "pseudo3d.json" from the virtual file system and convert to a JSON object
             */
            let pseudo3d_information = JSON.parse(FS.readFile('pseudo3d.json', { encoding: 'utf8' }));
            /**
             * Read additional files from the virtual file system, and send them back to the main script
             * File names are test1.ft2, test2.ft2, test3.ft2, ... upto test{N-1}.ft2
             * where N === pseudo3d_information.spectra  
             */
            
            for (let i = 1; i < pseudo3d_information.spectra; i++) {
                pseudo3d_files.push(FS.readFile('test_'.concat(i, '.ft2'), { encoding: 'binary' }));
                FS.unlink('test_'.concat(i, '.ft2'));
            }
            FS.unlink('pseudo3d.json');
        }

        postMessage({
            webassembly_job: e.data.webassembly_job,
            file_data: file_data,
            file_type: 'full', //direct,indirect,full
            pseudo3d_files: pseudo3d_files,
            phasing_data: phasing_data,
            apodization_indirect: apodization_indirect, //auto phasing may change the c value in apodization_indirect
            processing_flag: e.data.processing_flag, //passthrough the processing flag
            spectrum_index: e.data.spectrum_index, //for reprocessing only pass through the spectrum index
            pseudo3d_children: e.data.pseudo3d_children, //for reprocessing only pass through the pseudo3d_children
        });
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
     * If the message contains spectrum_data, scale, scale2 without picked_peaks call deep function
     */
    else if (e.data.webassembly_job === "peak_picker" )
    {
        console.log('Spectrum data received');
        /**
         * Save the spectrum data to the virtual file system
         */
        Module['FS_createDataFile']('/', 'test.ft2', e.data.spectrum_data, true, true, true);

        /**
         * Write a file named "arguments_dp.txt" to the virtual file system
         * save -noise_level, -scale and -scale2
         */
        if(e.data.flag === 0)
        {
            let content = ' -negative yes -out peaks.json peaks.tab -noise_level '.concat(e.data.noise_level,
                ' -scale ',e.data.scale,' -scale2 ',e.data.scale2,
                ' -scale_negative ',e.data.scale_negative,
                ' -scale2_negative ',e.data.scale2_negative,
                ' -t1_noise ',e.data.remove_t1_noise);
            Module['FS_createDataFile']('/', 'arguments_dp.txt', content, true, true, true);
        }
        else 
        {
            let content = ' -out peaks.json peaks.tab -noise_level '.concat(e.data.noise_level,' -scale ',e.data.scale);   
            Module['FS_createDataFile']('/', 'arguments_simple_picking.txt', content, true, true, true);
        }

        console.log('Spectrum data saved to virtual file system');
        /**
         * Run deep function
         */
        if(e.data.flag === 0){
            postMessage({ stdout: "Running deep function" });
            api.deep();
        }
        else{
            postMessage({ stdout: "Running simple picking" });
            api.simple_picking();
        }
        console.log('Finished running web assembly code');
        /**
         * Remove the input file from the virtual file system
         * Read file peaks.json, parse it and send it back to the main script
         */
        FS.unlink('test.ft2');
        let r=FS.readFile('peaks.json', {encoding: 'utf8'});
        let peaks=JSON.parse(r);
        let peaks_tab = FS.readFile('peaks.tab', { encoding: 'utf8' });
        FS.unlink('peaks.json');
        FS.unlink('peaks.tab');
        if(e.data.flag === 0){
            FS.unlink('arguments_dp.txt');
        }
        else {
            FS.unlink('arguments_simple_picking.txt');
        }
        postMessage({
            webassembly_job: e.data.webassembly_job,
            peaks: peaks,
            picked_peaks_tab: peaks_tab,
            spectrum_index: e.data.spectrum_index,
            scale: e.data.scale,
            scale2: e.data.scale2
        });
    }

    /**
     * With spectrum_data and phase_correction, run fid function to apply phase correction only
     */
    else if (e.data.webassembly_job === "apply_phase_correction") {
        console.log('Spectrum data and phase correction received');
        /**
         * Save the spectrum data to the virtual file system
         */
        Module['FS_createDataFile']('/', 'input.ft2', e.data.spectrum_data, true, true, true);
        console.log('Spectrum data saved to virtual file system, size is:', e.data.spectrum_data.length);
        
        /**
         * Write a file named "arguments_fid_2d.txt" to the virtual file system
         */
        let content = ' -in input.ft2 -out test.ft2 ';
        
        
        let b_auto = false;
        /**
         * If all are 0, add "-phase-in none " to the content
         */
        if(e.data.phase_correction[0][0] === 0 && e.data.phase_correction[0][1] === 0 && e.data.phase_correction[1][0] === 0 && e.data.phase_correction[1][1] === 0)
        {
            content = content.concat(' -user no ');
            content = content.concat(' -out-phase phase-correction.txt');
            b_auto = true;
            Module['FS_createDataFile']('/', 'arguments_phase_2d.txt', content, true, true, true);
            postMessage({ stdout: "Running phase function to apply automatic phase correction" });
            api.phasing();
            console.log('Finished running phase for phase correction');
            FS.unlink('arguments_phase_2d.txt');
        }
        else
        {
            content = content.concat(' -phase-in phase-correction.txt ');
            content = content.concat(' -di no -di-indirect no -process other -nus none -water no -poly -1');
            let phase_correction_string = e.data.phase_correction.map(x => x.join(' ')).join(' ');
            Module['FS_createDataFile']('/', 'phase-correction.txt', phase_correction_string, true, true, true);
            b_auto = false;

            Module['FS_createDataFile']('/', 'arguments_fid_2d.txt', content, true, true, true);
            postMessage({ stdout: "Running fid function to apply phase correction or run automatic phase correction" });
            api.fid();
            console.log('Finished running fid for phase correction');
            FS.unlink('arguments_fid_2d.txt');
        }

        /**
         * Remove the input files from the virtual file system
         */
        FS.unlink('input.ft2');
        const file_data = FS.readFile('test.ft2', { encoding: 'binary' });
        console.log('File data read from virtual file system length:', file_data.length);
        FS.unlink('test.ft2');

        let phase_correction = FS.readFile('phase-correction.txt', { encoding: 'utf8' });
        FS.unlink('phase-correction.txt');

       
        if(b_auto === false)
        {
            FS.unlink('fid-information.json');
        }
        
        postMessage({
            webassembly_job: e.data.webassembly_job,
            file_data: file_data,
            automatic_pc: b_auto,
            phase_correction: phase_correction,
            spectrum_name: e.data.spectrum_name, //pass through the spectrum name
            spectrum_index: e.data.spectrum_index //pass through the spectrum index
        });
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
         */
        let content = ' -v 0 -recon no -peak_in peaks.tab -out fitted.tab -noise_level '.concat(e.data.noise_level,' -scale ',e.data.scale,' -scale2 ',e.data.scale2);
        content = content.concat(' -maxround ', e.data.maxround);

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
         * Read the file recon_voigt_hsqc.ft2 
         */
        postMessage({
            webassembly_job: e.data.webassembly_job,
            pseudo3d_fitted_peaks_tab: peaks_tab, //peaks_tab is a very long string with multiple lines (in nmrPipe tab format)
            fitted_err: fitted_err,
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




