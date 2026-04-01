importScripts('websmile.js');

const api = {
    nusPipe: Module.cwrap("nuspipe", "number", []),
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
    console.log('Message received from main script to nuspipe worker');

    if (e.data.spectrum_data )
    {
        console.log('Spectrum data received by Smile worker');

        /**
         * Write a file named "nuslist"
         */
        Module['FS_createDataFile']('/', 'nuslist', e.data.nuslist_as_string, true, true, true);

        /**
         * apodization_direct: "SP begin 0.5 end 0.875 pow 2 elb 0 c 0.5"
         * We need to extract the values of begin, end, pow, and elb
        */
        let apodization_direct = e.data.apodization_direct;
        let apodization_direct_values = apodization_direct.split(/\s+/);
        let begin = apodization_direct_values[2];
        let end = apodization_direct_values[4];
        let pow = apodization_direct_values[6];
        let elb = apodization_direct_values[8];

        /**
         * Get the last number in the nuslist_as_string. Need trim() because there might be a space at the end of the string
         * This number+1 (becaused 0 based) is the number of points in the indirect dimension after NUS reconstruction. *2 because the data is complex
         */
        let nuslist_as_string = e.data.nuslist_as_string;
        let nuslist_as_string_values = nuslist_as_string.trim().split(/\s+/);
        let xT = (parseInt(nuslist_as_string_values[nuslist_as_string_values.length - 1])+1);

        /**
         * write the command file "arguments_nus_pipe.txt"
         */
        let command = "-in test_direct.ft2 -fn SMILE -nDim 2 -maxIter 2048 -nSigma 2.5 -report 1 -sample nuslist ";
        command = command.concat(" -xApod SP -xQ1 ", begin, " -xQ2 ", end, " -xQ3 ", pow, " -xELB ", elb, " ");
        command = command.concat(" -xGLB 0.0 -xT ", xT);
        command = command.concat(" -xP0 ", e.data.phase_correction_indirect_p0, " -xP1 ", e.data.phase_correction_indirect_p1);
        command = command.concat(" -out test_nus.ft2 -ov");
        Module['FS_createDataFile']('/', 'arguments_nus_pipe.txt', command, true, true, true);
        console.log(command);

        /**
         * Save the spectrum data to the virtual file system
         *  spectrum_data: arrayBuffer,
        */
        Module['FS_createDataFile']('/', 'test_direct.ft2', e.data.spectrum_data, true, true, true);


        /**
         * Call the nusPipe function
         */
        postMessage({ stdout: 'Calling nusPipe function' });
        api.nusPipe();

        /**
         * Read the output file "34.ft2" and send it back to the main thread
         */
        let output = FS.readFile('test_nus.ft2', { encoding: 'binary' });
        console.log('Output file read from virtual file system');

        /**
         * Remove the files from the virtual file system
         */
        Module['FS_unlink']('test_direct.ft2');
        Module['FS_unlink']('arguments_nus_pipe.txt');
        Module['FS_unlink']('test_nus.ft2');
        Module['FS_unlink']('nuslist');

        postMessage({
            spectrum_data: output,
            /**
             * pass through the other parameters
             */
            spectrum_index: e.data.spectrum_index,
            processing_flag: e.data.processing_flag,
        });
    }

    console.log('Smile worker finished processing the spectrum data');
}