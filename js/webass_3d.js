// webass_3d.js

importScripts('webdp1d_cpp.js');

const WEBASSEMBLY_JOB_KEY = "#sym:webassembly_job ";

let ModulePromise = webdp1d_cpp({
    print: (text) => {
        postMessage({ stdout: text });
    },
    printErr: (text) => {
        postMessage({ stdout: text });
    }
});

function vectorUCharToUint8Array(vector) {
    const result = new Uint8Array(vector.size());
    for (let i = 0; i < vector.size(); i++) {
        result[i] = vector.get(i);
    }
    return result;
}

function bytesToVectorUChar(Module, bytes) {
    const v = new Module.VectorUChar();
    for (let i = 0; i < bytes.length; i++) {
        v.push_back(bytes[i]);
    }
    return v;
}

function parseIndirectPhaseText(fullPhaseText) {
    const parts = String(fullPhaseText || '').trim().split(/\s+/).map(function (v) {
        const n = parseFloat(v);
        return Number.isFinite(n) ? n : 0.0;
    });
    const i1p0 = parts.length > 2 ? parts[2] : 0.0;
    const i1p1 = parts.length > 3 ? parts[3] : 0.0;
    const i2p0 = parts.length > 4 ? parts[4] : 0.0;
    const i2p1 = parts.length > 5 ? parts[5] : 0.0;
    return '0 0 ' + i1p0 + ' ' + i1p1 + ' ' + i2p0 + ' ' + i2p1;
}

function finalizeAndPostResult(Module, fidInstance, job) {
    console.log('[webass_3d] prepare_header_for_nmrpipe');
    fidInstance.prepare_header_for_nmrpipe();

    const nx = fidInstance.get_ndata_direct();
    const nz = fidInstance.get_ndata_indirect1();
    const ny = fidInstance.get_ndata_indirect2();

    const headerPtr = fidInstance.get_nmrpipe_header_data();
    const rrrPtr = fidInstance.get_data_of_rrr();

    const headerF32 = new Float32Array(Module.HEAPF32.subarray(headerPtr >> 2, (headerPtr >> 2) + 512));

    const dimorder1 = headerF32[24] || 2;
    const dimorder2 = headerF32[25] || 1;
    const data_types = [headerF32[55], headerF32[51], headerF32[52], headerF32[53]];
    const datatype_direct = data_types[dimorder1 - 1];
    const datatype_indirect = data_types[dimorder2 - 1];

    let data_size_per_point = 1;
    if (datatype_direct === 0 && datatype_indirect === 1) {
        data_size_per_point = 2;
    } else if (datatype_direct === 1 && datatype_indirect === 0) {
        data_size_per_point = 2;
    } else if (datatype_direct === 0 && datatype_indirect === 0) {
        data_size_per_point = 4;
    }

    const n = nx * ny * nz * data_size_per_point;
    const rrrF32 = new Float32Array(Module.HEAPF32.subarray(rrrPtr >> 2, (rrrPtr >> 2) + n));

    postMessage({ stdout: '[webass_3d] extracting ft3 file...' });
    let ft3Bytes = null;
    try {
        if (typeof fidInstance.serialize_ft3_to_internal_buffer === 'function') {
            if (fidInstance.serialize_ft3_to_internal_buffer()) {
                const ptr = fidInstance.get_ft3_buffer_ptr();
                const size = fidInstance.get_ft3_buffer_size();
                ft3Bytes = new Uint8Array(Module.HEAPU8.slice(ptr, ptr + size));
                postMessage({ stdout: '[webass_3d] extracted ft3 file of ' + ft3Bytes.length + ' bytes (zero-copy).' });
            } else {
                postMessage({ stdout: '[webass_3d] serialize_ft3_to_internal_buffer failed.' });
            }
        } else {
            const outVec = new Module.VectorUChar();
            try {
                if (fidInstance.write_ft3_to_buffer && fidInstance.write_ft3_to_buffer(outVec)) {
                    ft3Bytes = vectorUCharToUint8Array(outVec);
                    postMessage({ stdout: '[webass_3d] extracted ft3 file of ' + ft3Bytes.length + ' bytes (fallback).' });
                }
            } finally {
                outVec.delete();
            }
        }
    } catch (e) {
        console.error(e);
        postMessage({ stdout: '[webass_3d] error extracting ft3: ' + e.message });
    }

    postMessage({ stdout: '[webass_3d] posting result payload header=' + headerF32.length + ', rrr=' + rrrF32.length });

    const transferables = [headerF32.buffer, rrrF32.buffer];
    if (ft3Bytes) {
        transferables.push(ft3Bytes.buffer);
    }

    postMessage({
        [WEBASSEMBLY_JOB_KEY]: job,
        success: true,
        dims: { nx, ny, nz },
        headerF32: headerF32,
        rrrF32: rrrF32,
        ft3Bytes: ft3Bytes
    }, transferables);
    console.log('[webass_3d] process_fid_3d finished successfully');
}

self.onmessage = async function (event) {
    const job = event.data[WEBASSEMBLY_JOB_KEY] || event.data.webassembly_job;
    const Module = await ModulePromise;

    console.log('[webass_3d] Received job:', job);
    postMessage({ stdout: '[webass_3d] Received job: ' + job });

    if (job === "process_fid_3d") {
        try {
            const cfg = event.data.cfg;
            const textInputs = event.data.textInputs;
            const fidBytes = new Uint8Array(event.data.fidBytes);
            const isNus = !!(textInputs && textInputs.nuslist && textInputs.nuslist.trim().length > 0);
            const forceNusFullProcess = !!(cfg && (cfg.debugNusRunFullProcess || cfg.nusDirectDimAutoPhase));
            const useNusStepPipeline = isNus && !forceNusFullProcess;

            console.log('[webass_3d] process_fid_3d config:', cfg);
            console.log('[webass_3d] textInputs lengths:', {
                pulse: textInputs && textInputs.pulse ? textInputs.pulse.length : 0,
                acqus: textInputs && textInputs.acqus ? textInputs.acqus.length : 0,
                acqu2s: textInputs && textInputs.acqu2s ? textInputs.acqu2s.length : 0,
                acqu3s: textInputs && textInputs.acqu3s ? textInputs.acqu3s.length : 0,
                nuslist: textInputs && textInputs.nuslist ? textInputs.nuslist.length : 0,
                fidBytes: fidBytes.length,
                isNus: isNus,
                forceNusFullProcess: forceNusFullProcess,
                useNusStepPipeline: useNusStepPipeline
            });
            postMessage({ stdout: '[webass_3d] Starting fid_3d. fidBytes=' + fidBytes.length + ', isNus=' + isNus + ', forceNusFullProcess=' + forceNusFullProcess });

            const applyCommonConfig = function (fidInstance, useDirectApodization, phaseTextToUse, zfDirectToUse, deleteImageFlags) {
                console.log('[webass_3d] run_zf', zfDirectToUse, cfg.zfIndirect1, cfg.zfIndirect2);
                postMessage({ stdout: '[webass_3d] run_zf(' + zfDirectToUse + ', ' + cfg.zfIndirect1 + ', ' + cfg.zfIndirect2 + ')' });
                fidInstance.run_zf(zfDirectToUse, cfg.zfIndirect1, cfg.zfIndirect2);

                console.log('[webass_3d] set_up_apodization_from_string');
                postMessage({ stdout: '[webass_3d] set_up_apodization_from_string(...)' });
                fidInstance.set_up_apodization_from_string(
                    useDirectApodization ? (cfg.apodDirect || 'none') : 'none',
                    cfg.apodIndirect1 || 'none',
                    cfg.apodIndirect2 || 'none'
                );

                if (cfg.extPpm && cfg.extPpm.length >= 2) {
                    console.log('[webass_3d] extract_region_ppm', cfg.extPpm);
                    postMessage({ stdout: '[webass_3d] extract_region_ppm(' + cfg.extPpm[0] + ', ' + cfg.extPpm[1] + ')' });
                    fidInstance.extract_region_ppm(cfg.extPpm[0], cfg.extPpm[1]);
                } else if (cfg.extNorm && cfg.extNorm.length >= 2) {
                    console.log('[webass_3d] extract_region', cfg.extNorm);
                    postMessage({ stdout: '[webass_3d] extract_region(' + cfg.extNorm[0] + ', ' + cfg.extNorm[1] + ')' });
                    fidInstance.extract_region(cfg.extNorm[0], cfg.extNorm[1]);
                }

                if (phaseTextToUse) {
                    console.log('[webass_3d] read_phase_correction_from_string');
                    postMessage({ stdout: '[webass_3d] read_phase_correction_from_string(...)' });
                    fidInstance.read_phase_correction_from_string(phaseTextToUse);
                }

                if (cfg.tdPolyOrder && cfg.tdPolyOrder.length === 3) {
                    console.log('[webass_3d] set_time_domain_polynorminal_order', cfg.tdPolyOrder);
                    fidInstance.set_time_domain_polynorminal_order(
                        cfg.tdPolyOrder[0],
                        cfg.tdPolyOrder[1],
                        cfg.tdPolyOrder[2]
                    );
                }

                if (cfg.frqPolyOrder && cfg.frqPolyOrder.length === 3) {
                    console.log('[webass_3d] set_frq_domain_polynorminal_order', cfg.frqPolyOrder);
                    fidInstance.set_frq_domain_polynorminal_order(
                        cfg.frqPolyOrder[0],
                        cfg.frqPolyOrder[1],
                        cfg.frqPolyOrder[2]
                    );
                }

                if (cfg.inverse && cfg.inverse.length === 3) {
                    console.log('[webass_3d] set_inverse', cfg.inverse);
                    fidInstance.set_inverse(cfg.inverse[0], cfg.inverse[1], cfg.inverse[2]);
                }

                const deleteImage = (deleteImageFlags && deleteImageFlags.length === 3)
                    ? deleteImageFlags
                    : [1, 1, 1];
                console.log('[webass_3d] set_delete_image', deleteImage);
                postMessage({ stdout: '[webass_3d] set_delete_image(' + deleteImage[0] + ', ' + deleteImage[1] + ', ' + deleteImage[2] + ')' });
                fidInstance.set_delete_image(deleteImage[0], deleteImage[1], deleteImage[2]);
            };

            const fid = new Module.fid_3d();
            try {
                let delImg = cfg.deleteImage ? [...cfg.deleteImage] : [1, 1, 1];
                if (cfg && (cfg.nusDirectDimAutoPhase || cfg.normalDirectDimAutoPhase)) {
                    delImg[0] = 0; // force keep direct dimension imag data
                }
                applyCommonConfig(fid, true, cfg.phaseText, cfg.zfDirect, useNusStepPipeline ? [delImg[0], 0, 0] : delImg);

                console.log('[webass_3d] read_bruker_files_as_strings');
                postMessage({ stdout: '[webass_3d] read_bruker_files_as_strings(...)' });
                const ok_params = fid.read_bruker_files_as_strings(
                    textInputs.pulse || "",
                    textInputs.acqus || "",
                    textInputs.acqu2s || "",
                    textInputs.acqu3s || "",
                    textInputs.nuslist || "",
                    false, // simulate_nus: should be false for real compressed NUS data
                    false  // nus_ser_inflated: always false for web uploads
                );
                if (!ok_params) {
                    throw new Error('read_bruker_files_as_strings failed. Check if Bruker parameter files (acqus, acqu2s, acqu3s) are valid and if direct dimension TD is even.');
                }

                let ok_fid = false;
                if (typeof fid.read_bruker_fid_data_bytes_raw === 'function') {
                    const ptr = Module._malloc(fidBytes.length);
                    Module.HEAPU8.set(fidBytes, ptr);
                    try {
                        console.log('[webass_3d] read_bruker_fid_data_bytes_raw with bytes:', fidBytes.length);
                        postMessage({ stdout: '[webass_3d] read_bruker_fid_data_bytes_raw(' + fidBytes.length + ' bytes)' });
                        ok_fid = fid.read_bruker_fid_data_bytes_raw(ptr, fidBytes.length);
                    } finally {
                        Module._free(ptr);
                    }
                } else {
                    const v = bytesToVectorUChar(Module, fidBytes);
                    try {
                        console.log('[webass_3d] read_bruker_fid_data_bytes with bytes:', fidBytes.length);
                        postMessage({ stdout: '[webass_3d] read_bruker_fid_data_bytes(' + fidBytes.length + ' bytes)' });
                        ok_fid = fid.read_bruker_fid_data_bytes(v);
                    } finally {
                        v.delete();
                    }
                }
                if (!ok_fid) {
                    throw new Error('read_bruker_fid_data_bytes/raw failed. Verify the ser/fid file size matches the dimensions in the parameter files.');
                }

                if (!useNusStepPipeline) {
                    console.log('[webass_3d] full_process');
                    postMessage({ stdout: isNus ? '[webass_3d] full_process() [NUS debug mode]' : '[webass_3d] full_process()' });
                    fid.full_process();
                    finalizeAndPostResult(Module, fid, job);
                } else {
                    console.log('[webass_3d] direct_only_process for NUS step1');
                    postMessage({ stdout: '[webass_3d] NUS step1: direct_only_process()' });
                    fid.direct_only_process();
                    const nIndirect1 = fid.get_ndata_indirect1();
                    const nIndirect2 = fid.get_ndata_indirect2();
                    postMessage({ stdout: '[webass_3d] NUS step1 dims indirect1=' + nIndirect1 + ', indirect2=' + nIndirect2 });

                    let halfFt3Bytes;
                    if (typeof fid.serialize_ft3_to_internal_buffer === 'function') {
                        if (fid.serialize_ft3_to_internal_buffer()) {
                            const ptr = fid.get_ft3_buffer_ptr();
                            const size = fid.get_ft3_buffer_size();
                            halfFt3Bytes = new Uint8Array(Module.HEAPU8.slice(ptr, ptr + size));
                        } else {
                            throw new Error("serialize_ft3_to_internal_buffer failed");
                        }
                    } else {
                        const halfVec = new Module.VectorUChar();
                        try {
                            const ok = fid.write_ft3_to_buffer(halfVec);
                            if (!ok) {
                                throw new Error("write_ft3_to_buffer failed");
                            }
                            halfFt3Bytes = vectorUCharToUint8Array(halfVec);
                        } finally {
                            halfVec.delete();
                        }
                    }

                    postMessage({ stdout: '[webass_3d] NUS step1 output half.ft3 bytes=' + halfFt3Bytes.length });
                    postMessage({
                        [WEBASSEMBLY_JOB_KEY]: 'process_fid_3d_nus_half_ready',
                        halfFt3Bytes: halfFt3Bytes,
                        ndataIndirect1: nIndirect1,
                        ndataIndirect2: nIndirect2,
                        cfg: cfg,
                        nuslistText: textInputs.nuslist || ''
                    }, [halfFt3Bytes.buffer]);
                }
            } finally {
                fid.delete();
                console.log('[webass_3d] fid_3d instance deleted');
            }
        } catch (err) {
            console.error('[webass_3d] process_fid_3d failed', err);
            postMessage({ [WEBASSEMBLY_JOB_KEY]: job, error: err.toString() });
        }
    }
    else if (job === 'process_fid_3d_nus_step3') {
        try {
            const cfg = event.data.cfg || {};
            const smileFt3Bytes = new Uint8Array(event.data.smileFt3Bytes || []);

            const applyCommonConfig = function (fidInstance, phaseTextToUse) {
                fidInstance.run_zf(1, cfg.zfIndirect1, cfg.zfIndirect2);
                fidInstance.set_up_apodization_from_string(
                    'none',
                    cfg.apodIndirect1 || 'none',
                    cfg.apodIndirect2 || 'none'
                );
                if (cfg.extPpm && cfg.extPpm.length >= 2) {
                    fidInstance.extract_region_ppm(cfg.extPpm[0], cfg.extPpm[1]);
                } else if (cfg.extNorm && cfg.extNorm.length >= 2) {
                    fidInstance.extract_region(cfg.extNorm[0], cfg.extNorm[1]);
                }
                if (phaseTextToUse) {
                    fidInstance.read_phase_correction_from_string(phaseTextToUse);
                }
                if (cfg.tdPolyOrder && cfg.tdPolyOrder.length === 3) {
                    fidInstance.set_time_domain_polynorminal_order(
                        cfg.tdPolyOrder[0],
                        cfg.tdPolyOrder[1],
                        cfg.tdPolyOrder[2]
                    );
                }
                if (cfg.frqPolyOrder && cfg.frqPolyOrder.length === 3) {
                    fidInstance.set_frq_domain_polynorminal_order(
                        cfg.frqPolyOrder[0],
                        cfg.frqPolyOrder[1],
                        cfg.frqPolyOrder[2]
                    );
                }
                if (cfg.inverse && cfg.inverse.length === 3) {
                    fidInstance.set_inverse(cfg.inverse[0], cfg.inverse[1], cfg.inverse[2]);
                }
                const delImg = cfg.deleteImage || [1, 1, 1];
                fidInstance.set_delete_image(delImg[0], delImg[1], delImg[2]);
            };

            const fidIndirect = new Module.fid_3d();
            let finalFt3Bytes;
            try {
                const indirectPhaseText = parseIndirectPhaseText(cfg.phaseText);
                applyCommonConfig(fidIndirect, indirectPhaseText);

                if (typeof fidIndirect.read_ft3_from_buffer !== 'function') {
                    throw new Error('fid_3d.read_ft3_from_buffer is not available in this WebAssembly build');
                }
                if (typeof fidIndirect.write_ft3_to_buffer !== 'function') {
                    throw new Error('fid_3d.write_ft3_to_buffer is not available in this WebAssembly build');
                }

                let read_ok = false;
                if (typeof fidIndirect.read_ft3_from_buffer_raw === 'function') {
                    const ptr = Module._malloc(smileFt3Bytes.length);
                    Module.HEAPU8.set(smileFt3Bytes, ptr);
                    try {
                        read_ok = fidIndirect.read_ft3_from_buffer_raw(ptr, smileFt3Bytes.length);
                    } finally {
                        Module._free(ptr);
                    }
                } else {
                    if (typeof fidIndirect.read_ft3_from_buffer !== 'function') {
                        throw new Error('fid_3d.read_ft3_from_buffer is not available in this WebAssembly build');
                    }
                    const inVec = bytesToVectorUChar(Module, smileFt3Bytes);
                    try {
                        read_ok = fidIndirect.read_ft3_from_buffer(inVec);
                    } finally {
                        inVec.delete();
                    }
                }
                if (!read_ok) {
                    throw new Error('read_ft3_from_buffer failed');
                }

                console.log('[webass_3d] indirect_only_process for NUS step3');
                postMessage({ stdout: '[webass_3d] NUS step3: indirect_only_process()' });
                if (!fidIndirect.indirect_only_process()) {
                    throw new Error('indirect_only_process failed');
                }

                if (typeof fidIndirect.serialize_ft3_to_internal_buffer === 'function') {
                    if (fidIndirect.serialize_ft3_to_internal_buffer()) {
                        const ptr = fidIndirect.get_ft3_buffer_ptr();
                        const size = fidIndirect.get_ft3_buffer_size();
                        finalFt3Bytes = new Uint8Array(Module.HEAPU8.slice(ptr, ptr + size));
                    } else {
                        throw new Error('serialize_ft3_to_internal_buffer failed');
                    }
                } else {
                    if (typeof fidIndirect.write_ft3_to_buffer !== 'function') {
                        throw new Error('fid_3d.write_ft3_to_buffer is not available in this WebAssembly build');
                    }
                    const outVec = new Module.VectorUChar();
                    try {
                        if (!fidIndirect.write_ft3_to_buffer(outVec)) {
                            throw new Error('write_ft3_to_buffer failed');
                        }
                        finalFt3Bytes = vectorUCharToUint8Array(outVec);
                    } finally {
                        outVec.delete();
                    }
                }
            } finally {
                fidIndirect.delete();
            }

            const fidFinal = new Module.fid_3d();
            try {
                let final_ok = false;
                const bytesToLoad = finalFt3Bytes || new Uint8Array();
                if (typeof fidFinal.read_ft3_from_buffer_raw === 'function') {
                    const ptr = Module._malloc(bytesToLoad.length);
                    Module.HEAPU8.set(bytesToLoad, ptr);
                    try {
                        final_ok = fidFinal.read_ft3_from_buffer_raw(ptr, bytesToLoad.length);
                    } finally {
                        Module._free(ptr);
                    }
                } else {
                    const finalVec = bytesToVectorUChar(Module, bytesToLoad);
                    try {
                        final_ok = fidFinal.read_ft3_from_buffer(finalVec);
                    } finally {
                        finalVec.delete();
                    }
                }
                if (!final_ok) {
                    throw new Error('read_ft3_from_buffer failed for final output');
                }
                finalizeAndPostResult(Module, fidFinal, 'process_fid_3d');
            } finally {
                fidFinal.delete();
            }
        } catch (err) {
            console.error('[webass_3d] process_fid_3d_nus_step3 failed', err);
            postMessage({ [WEBASSEMBLY_JOB_KEY]: job, error: err.toString() });
        }
    }
};
