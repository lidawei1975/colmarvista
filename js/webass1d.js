/**
 * This is a web worker that will be used to run the web assembly code
 */


importScripts('webdp1d.js');

const api = {
    deep: Module.cwrap("deep_1d", "number", []),
    voigt_fit: Module.cwrap("voigt_fit", "number", []),
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
     * If the message contains both spectrum_data and picked_peaks, call voigt_fit function
     */
    if (e.data.webassembly_job === "peak_fitter") {
        console.log('Spectrum data and picked peaks received');
        /**
         * Save the spectrum data and picked peaks to the virtual file system
         */
        Module['FS_createDataFile']('/', 'test.ft1', e.data.spectrum_data, true, true, true);
        Module['FS_createDataFile']('/', 'peaks.tab', e.data.picked_peaks, true, true, true);

        /**
         * Write a file named "argument_voigt_fit.txt" to the virtual file system
         * save -noise_level, -scale and -scale2 
         */
        let content = ' -in test.ft1 -peak_in peaks.tab -out fitted.tab -folder . -noise_level '.concat(e.data.noise_level,' -scale ',e.data.scale,' -scale2 ',e.data.scale2);
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
        

        console.log(content);

        Module['FS_createDataFile']('/', 'arguments_vf1d.txt', content, true, true, true);

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
        FS.unlink('test.ft1');
        FS.unlink('peaks.tab');
        FS.unlink('argument_voigt_fit.txt');
        let peaks_tab = FS.readFile('fitted.tab', { encoding: 'utf8' });
        FS.unlink('fitted.tab');

        /**
         * If the flag is 0, read the file recon_voigt_hsqc.ft2 
         * else read the file recon_gaussian_hsqc.ft2
        */
        let filename;
        if(e.data.flag === 0)
        {
            filename='recon_voigt_test.ft1';
        }
        else if(e.data.flag === 1)
        {
            filename='recon_gaussian_test.ft1';
        }
       

        const file_data = FS.readFile(filename, { encoding: 'binary' });
        console.log('File data read from virtual file system, type of file_data:', typeof file_data, ' and length:', file_data.length);
        FS.unlink(filename);
        postMessage({
            webassembly_job: e.data.webassembly_job,
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
        Module['FS_createDataFile']('/', 'test.ft1', e.data.spectrum_data, true, true, true);

        /**
         * Write a file named "arguments_dp.txt" to the virtual file system
         * save -noise_level, -scale and -scale2
         */
        
        let content = ' -in test.ft1 -out peaks.tab -noise_level '.concat(e.data.noise_level,
            ' -scale ',e.data.scale,' -scale2 ',e.data.scale2);
        Module['FS_createDataFile']('/', 'arguments_dp.txt', content, true, true, true);
        

        console.log('Spectrum data saved to virtual file system');
        /**
         * Run deep function
         */
       
        postMessage({ stdout: "Running deep function" });
        api.deep();
        console.log('Finished running web assembly code');
        /**
         * Remove the input file from the virtual file system
         * Read file peaks.json, parse it and send it back to the main script
         */
        FS.unlink('test.ft1');
        let peaks_tab = FS.readFile('peaks.tab', { encoding: 'utf8' });
        FS.unlink('peaks.tab');
        FS.unlink('arguments_dp.txt');
       
        postMessage({
            webassembly_job: e.data.webassembly_job,
            picked_peaks_tab: peaks_tab,
            spectrum_index: e.data.spectrum_index,
            scale: e.data.scale,
            scale2: e.data.scale2
        });
    }

}




