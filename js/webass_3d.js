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

self.onmessage = async function(event) {
    const job = event.data[WEBASSEMBLY_JOB_KEY] || event.data.webassembly_job;
    const Module = await ModulePromise;

    console.log('[webass_3d] Received job:', job);
    postMessage({ stdout: '[webass_3d] Received job: ' + job });

    if (job === "process_fid_3d") {
        try {
            const cfg = event.data.cfg;
            const textInputs = event.data.textInputs;
            const fidBytes = new Uint8Array(event.data.fidBytes);
            const mode = event.data.mode;

            console.log('[webass_3d] process_fid_3d config:', cfg);
            console.log('[webass_3d] textInputs lengths:', {
                pulse: textInputs && textInputs.pulse ? textInputs.pulse.length : 0,
                acqus: textInputs && textInputs.acqus ? textInputs.acqus.length : 0,
                acqu2s: textInputs && textInputs.acqu2s ? textInputs.acqu2s.length : 0,
                acqu3s: textInputs && textInputs.acqu3s ? textInputs.acqu3s.length : 0,
                nuslist: textInputs && textInputs.nuslist ? textInputs.nuslist.length : 0,
                fidBytes: fidBytes.length,
                mode: mode
            });
            postMessage({ stdout: '[webass_3d] Starting fid_3d. fidBytes=' + fidBytes.length + ', mode=' + mode });

            const fid = new Module.fid_3d();
            try {
                console.log('[webass_3d] run_zf', cfg.zfDirect, cfg.zfIndirect1, cfg.zfIndirect2);
                postMessage({ stdout: '[webass_3d] run_zf(' + cfg.zfDirect + ', ' + cfg.zfIndirect1 + ', ' + cfg.zfIndirect2 + ')' });
                fid.run_zf(cfg.zfDirect, cfg.zfIndirect1, cfg.zfIndirect2);

                console.log('[webass_3d] set_up_apodization_from_string');
                postMessage({ stdout: '[webass_3d] set_up_apodization_from_string(...)' });
                fid.set_up_apodization_from_string(
                    cfg.apodDirect || 'none',
                    cfg.apodIndirect1 || 'none',
                    cfg.apodIndirect2 || 'none'
                );

                if (cfg.extPpm && cfg.extPpm.length >= 2) {
                    console.log('[webass_3d] extract_region_ppm', cfg.extPpm);
                    postMessage({ stdout: '[webass_3d] extract_region_ppm(' + cfg.extPpm[0] + ', ' + cfg.extPpm[1] + ')' });
                    fid.extract_region_ppm(cfg.extPpm[0], cfg.extPpm[1]);
                } else if (cfg.extNorm && cfg.extNorm.length >= 2) {
                    console.log('[webass_3d] extract_region', cfg.extNorm);
                    postMessage({ stdout: '[webass_3d] extract_region(' + cfg.extNorm[0] + ', ' + cfg.extNorm[1] + ')' });
                    fid.extract_region(cfg.extNorm[0], cfg.extNorm[1]);
                }

                if (cfg.phaseText) {
                    console.log('[webass_3d] read_phase_correction_from_string');
                    postMessage({ stdout: '[webass_3d] read_phase_correction_from_string(...)' });
                    fid.read_phase_correction_from_string(cfg.phaseText);
                }

                if (cfg.tdPolyOrder && cfg.tdPolyOrder.length === 3) {
                    console.log('[webass_3d] set_time_domain_polynorminal_order', cfg.tdPolyOrder);
                    fid.set_time_domain_polynorminal_order(
                        cfg.tdPolyOrder[0],
                        cfg.tdPolyOrder[1],
                        cfg.tdPolyOrder[2]
                    );
                }

                if (cfg.frqPolyOrder && cfg.frqPolyOrder.length === 3) {
                    console.log('[webass_3d] set_frq_domain_polynorminal_order', cfg.frqPolyOrder);
                    fid.set_frq_domain_polynorminal_order(
                        cfg.frqPolyOrder[0],
                        cfg.frqPolyOrder[1],
                        cfg.frqPolyOrder[2]
                    );
                }

                if (cfg.inverse && cfg.inverse.length === 3) {
                    console.log('[webass_3d] set_inverse', cfg.inverse);
                    fid.set_inverse(cfg.inverse[0], cfg.inverse[1], cfg.inverse[2]);
                }

                // Always delete imaginary components in 3D processing.
                console.log('[webass_3d] set_delete_image (forced)', [1, 1, 1]);
                postMessage({ stdout: '[webass_3d] set_delete_image(1, 1, 1) [forced]' });
                fid.set_delete_image(1, 1, 1);

                console.log('[webass_3d] read_bruker_files_as_strings');
                postMessage({ stdout: '[webass_3d] read_bruker_files_as_strings(...)' });
                fid.read_bruker_files_as_strings(
                    textInputs.pulse || "",
                    textInputs.acqus || "",
                    textInputs.acqu2s || "",
                    textInputs.acqu3s || "",
                    textInputs.nuslist || "",
                    !!cfg.nusSerInflated
                );

                const v = new Module.VectorUChar();
                for (let i = 0; i < fidBytes.length; i++) v.push_back(fidBytes[i]);
                console.log('[webass_3d] read_bruker_fid_data_bytes with bytes:', fidBytes.length);
                postMessage({ stdout: '[webass_3d] read_bruker_fid_data_bytes(' + fidBytes.length + ' bytes)' });
                fid.read_bruker_fid_data_bytes(v);
                v.delete();

                if (mode === "full") {
                    console.log('[webass_3d] full_process');
                    postMessage({ stdout: '[webass_3d] full_process()' });
                    fid.full_process();
                } else if (mode === "direct-only") {
                    console.log('[webass_3d] direct_only_process');
                    postMessage({ stdout: '[webass_3d] direct_only_process()' });
                    fid.direct_only_process();
                } else if (mode === "indirect-only") {
                    console.log('[webass_3d] indirect_only_process');
                    postMessage({ stdout: '[webass_3d] indirect_only_process()' });
                    fid.indirect_only_process();
                } else {
                    throw new Error("Unsupported mode: " + mode);
                }

                console.log('[webass_3d] prepare_header_for_nmrpipe');
                fid.prepare_header_for_nmrpipe();

                const nx = fid.get_ndata_frq();
                const nz = fid.get_ndata_frq_indirect1();
                const ny = fid.get_ndata_frq_indirect2();
                const n = nx * ny * nz;
                console.log('[webass_3d] output dims:', { nx, ny, nz, n });
                postMessage({ stdout: '[webass_3d] output dims nx=' + nx + ', ny=' + ny + ', nz=' + nz });

                const headerPtr = fid.get_nmrpipe_header_data();
                const rrrPtr = fid.get_data_of_rrr();
                console.log('[webass_3d] heap ptrs', { headerPtr, rrrPtr });

                const headerF32 = new Float32Array(Module.HEAPF32.subarray(headerPtr >> 2, (headerPtr >> 2) + 512));
                const rrrF32 = new Float32Array(Module.HEAPF32.subarray(rrrPtr >> 2, (rrrPtr >> 2) + n));

                postMessage({ stdout: '[webass_3d] posting result payload header=' + headerF32.length + ', rrr=' + rrrF32.length });

                postMessage({
                    [WEBASSEMBLY_JOB_KEY]: job,
                    success: true,
                    dims: { nx, ny, nz },
                    headerF32: headerF32,
                    rrrF32: rrrF32
                });
                console.log('[webass_3d] process_fid_3d finished successfully');
            } finally {
                fid.delete();
                console.log('[webass_3d] fid_3d instance deleted');
            }
        } catch (err) {
            console.error('[webass_3d] process_fid_3d failed', err);
            postMessage({ [WEBASSEMBLY_JOB_KEY]: job, error: err.toString() });
        }
    }
};
