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

    if (job === "process_fid_3d") {
        try {
            const cfg = event.data.cfg;
            const textInputs = event.data.textInputs;
            const fidBytes = new Uint8Array(event.data.fidBytes);
            const mode = event.data.mode;

            const fid = new Module.fid_3d();
            try {
                fid.run_zf(cfg.zfDirect, cfg.zfIndirect1, cfg.zfIndirect2);
                fid.set_up_apodization_from_string(
                    cfg.apodDirect || 'none',
                    cfg.apodIndirect1 || 'none',
                    cfg.apodIndirect2 || 'none'
                );

                if (cfg.extPpm && cfg.extPpm.length >= 2) {
                    fid.extract_region_ppm(cfg.extPpm[0], cfg.extPpm[1]);
                } else if (cfg.extNorm && cfg.extNorm.length >= 2) {
                    fid.extract_region(cfg.extNorm[0], cfg.extNorm[1]);
                }

                if (cfg.phaseText) {
                    fid.read_phase_correction_from_string(cfg.phaseText);
                }

                if (cfg.tdPolyOrder && cfg.tdPolyOrder.length === 3) {
                    fid.set_time_domain_polynorminal_order(
                        cfg.tdPolyOrder[0],
                        cfg.tdPolyOrder[1],
                        cfg.tdPolyOrder[2]
                    );
                }

                if (cfg.frqPolyOrder && cfg.frqPolyOrder.length === 3) {
                    fid.set_frq_domain_polynorminal_order(
                        cfg.frqPolyOrder[0],
                        cfg.frqPolyOrder[1],
                        cfg.frqPolyOrder[2]
                    );
                }

                if (cfg.inverse && cfg.inverse.length === 3) {
                    fid.set_inverse(cfg.inverse[0], cfg.inverse[1], cfg.inverse[2]);
                }

                if (cfg.deleteImage && cfg.deleteImage.length === 3) {
                    fid.set_delete_image(cfg.deleteImage[0], cfg.deleteImage[1], cfg.deleteImage[2]);
                }

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
                fid.read_bruker_fid_data_bytes(v);
                v.delete();

                if (mode === "full") {
                    fid.full_process();
                } else if (mode === "direct-only") {
                    fid.direct_only_process();
                } else if (mode === "indirect-only") {
                    fid.indirect_only_process();
                } else {
                    throw new Error("Unsupported mode: " + mode);
                }

                fid.prepare_header_for_nmrpipe();

                const nx = fid.get_ndata_frq();
                const ny = fid.get_ndata_frq_indirect1();
                const nz = fid.get_ndata_frq_indirect2();
                const n = nx * ny * nz;

                const headerPtr = fid.get_nmrpipe_header_data();
                const rrrPtr = fid.get_data_of_rrr();

                const headerF32 = new Float32Array(Module.HEAPF32.subarray(headerPtr >> 2, (headerPtr >> 2) + 512));
                const rrrF32 = new Float32Array(Module.HEAPF32.subarray(rrrPtr >> 2, (rrrPtr >> 2) + n));

                postMessage({
                    [WEBASSEMBLY_JOB_KEY]: job,
                    success: true,
                    dims: { nx, ny, nz },
                    headerF32: headerF32,
                    rrrF32: rrrF32
                });
            } finally {
                fid.delete();
            }
        } catch (err) {
            postMessage({ [WEBASSEMBLY_JOB_KEY]: job, error: err.toString() });
        }
    }
};
