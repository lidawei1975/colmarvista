importScripts('smile.js');

function getNusPipe() {
    if (typeof Module.cwrap !== 'function') {
        throw new Error('SMILE Module.cwrap is not available yet');
    }
    return Module.cwrap("nuspipe", "number", [], {});
}

function postRuntimeDiagnostics(contextLabel, spectrumData) {
    const bytes = spectrumData instanceof Uint8Array ? spectrumData : new Uint8Array(spectrumData || 0);
    const byteLength = bytes.byteLength || 0;
    const headerFloatCount = Math.min(512, Math.floor(byteLength / 4));
    const headerF32 = headerFloatCount > 0
        ? new Float32Array(bytes.buffer, bytes.byteOffset, headerFloatCount)
        : new Float32Array(0);

    const nDirect = headerF32.length > 99 ? Math.round(headerF32[99]) : NaN;
    const nIndirect1 = headerF32.length > 219 ? Math.round(headerF32[219]) : NaN;
    const nIndirect2 = headerF32.length > 99 ? Math.round(headerF32[99]) : NaN;

    postMessage({
        stdout: '[smile-diag] ' + contextLabel
            + ' bytes=' + byteLength
            + ', Module.cwrap=' + typeof Module.cwrap
            + ', Module._nuspipe=' + typeof Module._nuspipe
            + ', header55=' + (headerF32.length > 55 ? headerF32[55] : NaN)
            + ', header56=' + (headerF32.length > 56 ? headerF32[56] : NaN)
            + ', header99=' + (headerF32.length > 99 ? headerF32[99] : NaN)
            + ', header219=' + (headerF32.length > 219 ? headerF32[219] : NaN)
            + ', nDirect~=' + nDirect
            + ', nIndirect1~=' + nIndirect1
            + ', nIndirect2~=' + nIndirect2
    });
}

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

    if (e.data.spectrum_data && e.data.smile_mode === 'nus_3d') {
        console.log('3D spectrum data received by Smile worker');
        postRuntimeDiagnostics('3d-before-fs-write', e.data.spectrum_data);

        Module['FS_createDataFile']('/', 'nuslist', e.data.nuslist_as_string || '', true, true, true);
        Module['FS_createDataFile']('/', 'half.ft3', e.data.spectrum_data, true, true, true);

        const default3dCommand = "-in half.ft3 -fn SMILE -nDim 3 -sample nuslist -report 2 -nThread 1  -maxMem 2.0 -xApod SP -xQ1 0.50 -xQ2 0.896 -xQ3 3.684 -xELB 0.0 -xGLB 0.0 -yApod SP -yQ1 0.50 -yQ2 0.896 -yQ3 3.684 -yELB 0.0 -yGLB 0.0 -xT 100 -xP0 90.0 -xP1 0. -yT 90 -yP0 0.0 -yP1 0.0 -yAlt -out smile.ft3 -ov";
        const command = (typeof e.data.smile_command === 'string' && e.data.smile_command.trim().length > 0)
            ? e.data.smile_command
            : default3dCommand;

        Module['FS_createDataFile']('/', 'arguments_nus_pipe.txt', command, true, true, true);
        console.log(command);
        postMessage({ stdout: 'nusPipe command: ' + command });

        postMessage({ stdout: 'Calling nusPipe function for 3D NUS reconstruction' });
        try {
            const nusPipeFn = getNusPipe();
            postMessage({ stdout: '[smile-diag] 3d nuspipe typeof=' + typeof nusPipeFn });
            nusPipeFn();
        } catch (err) {
            postMessage({
                error: '3D nusPipe failed: ' + (err && err.message ? err.message : String(err))
            });
            try {
                Module['FS_unlink']('half.ft3');
                Module['FS_unlink']('arguments_nus_pipe.txt');
                Module['FS_unlink']('nuslist');
            } catch (_) {}
            return;
        }

        let output = FS.readFile('smile.ft3', { encoding: 'binary' });
        console.log('3D SMILE output file read from virtual file system');
        postRuntimeDiagnostics('3d-after-nuspipe-output', output);

        Module['FS_unlink']('half.ft3');
        Module['FS_unlink']('arguments_nus_pipe.txt');
        Module['FS_unlink']('smile.ft3');
        Module['FS_unlink']('nuslist');

        postMessage({
            spectrum_data: output,
            file_type: 'smile_3d'
        });

        console.log('Smile worker finished processing the 3D spectrum data');
        return;
    }

    if (e.data.spectrum_data )
    {
        console.log('Spectrum data received by Smile worker');
        postRuntimeDiagnostics('2d-before-fs-write', e.data.spectrum_data);

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
        try {
            const nusPipeFn = getNusPipe();
            postMessage({ stdout: '[smile-diag] 2d nuspipe typeof=' + typeof nusPipeFn });
            nusPipeFn();
        } catch (err) {
            postMessage({
                error: '2D nusPipe failed: ' + (err && err.message ? err.message : String(err))
            });
            try {
                Module['FS_unlink']('test_direct.ft2');
                Module['FS_unlink']('arguments_nus_pipe.txt');
                Module['FS_unlink']('nuslist');
            } catch (_) {}
            return;
        }

        /**
         * Read the output file "34.ft2" and send it back to the main thread
         */
        let output = FS.readFile('test_nus.ft2', { encoding: 'binary' });
        console.log('Output file read from virtual file system');
        postRuntimeDiagnostics('2d-after-nuspipe-output', output);

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