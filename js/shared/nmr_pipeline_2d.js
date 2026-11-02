/**
 * NMRPipeline2D (Shared Dual-Execution Engine)
 * 
 * Provides a unified API for 2D NMR processing operations:
 * - FID processing (Bruker, Magritek, Sparky, NUS)
 * - Phase correction & Apodization
 * - 2D Peak Picking & DEEP Picker
 * - 2D Peak Fitting
 * 
 * Configured by execution mode:
 * - 'backend': Dispatches requests to CodeIgniter PHP backend (SPIN), handles polling,
 *              and saves session files on the server disk for user_job_id resumption.
 * - 'webass':  Dispatches jobs to WebWorker running WebAssembly (webdp1d_cpp.wasm / smile.wasm)
 *              for high-speed, client-side, offline execution.
 */

class NMRPipeline2D {
    constructor(config = {}) {
        this.mode = config.mode || 'webass'; // 'backend' or 'webass'
        this.baseUrl = config.baseUrl || '';
        this.serverName = config.serverName || 'colmarm';
        this.userJobId = config.userJobId || null;
        this.worker = config.worker || (typeof webassembly_worker !== 'undefined' ? webassembly_worker : null);
        this.onStatus = config.onStatus || function (msg) { console.log('[NMRPipeline2D]', msg); };
        this.onError = config.onError || function (err) { console.error('[NMRPipeline2D Error]', err); };
    }

    setMode(mode) {
        if (mode === 'backend' || mode === 'webass') {
            this.mode = mode;
        } else {
            console.warn('[NMRPipeline2D] Unknown mode:', mode);
        }
    }

    setUserJobId(jobId) {
        this.userJobId = jobId;
    }

    setWorker(worker) {
        this.worker = worker;
    }

    // =========================================================================
    // 1. FID PROCESSING
    // =========================================================================

    /**
     * Process Raw 2D FID data
     * @param {Object} params - Contains formElement or formData or { fid_file, acqus_file, ... }
     * @returns {Promise<Object>} Processed spectrum result
     */
    async processFID(params) {
        if (this.mode === 'backend') {
            return await this._processFIDBackend(params);
        } else {
            return await this._processFIDWebAss(params);
        }
    }

    async _processFIDBackend(params) {
        const self = this;
        return new Promise((resolve, reject) => {
            let fd = params.formData;
            if (!fd && params.formElement) {
                fd = new FormData(params.formElement);
            }
            if (!fd) {
                fd = new FormData();
                if (params.fid_file) fd.append('fid_file', params.fid_file);
                if (params.acqus_file) fd.append('acqus_file', params.acqus_file);
                if (params.acqu2s_file) fd.append('acqu2s_file', params.acqu2s_file);
                if (params.user_job_id) fd.append('user_job_id', params.user_job_id);
            }
            self._appendCsrf(fd);

            const oReq = new XMLHttpRequest();
            const endpoint = self.baseUrl + (self.serverName ? '/' + self.serverName : '') + '/run_fid';
            oReq.open('POST', endpoint, true);

            oReq.onload = function () {
                if (oReq.status === 200) {
                    try {
                        const resp = JSON.parse(oReq.responseText);
                        resolve(resp);
                    } catch (e) {
                        resolve(oReq.responseText);
                    }
                } else {
                    reject(new Error(`2D FID Processing failed: ${oReq.statusText}`));
                }
            };
            oReq.onerror = () => reject(new Error('Network error during 2D FID processing'));
            oReq.send(fd);
        });
    }

    async _processFIDWebAss(params) {
        const self = this;
        return new Promise((resolve, reject) => {
            if (!self.worker) {
                reject(new Error('WebAssembly worker not available'));
                return;
            }

            const WEBASSEMBLY_JOB_KEY = "#sym:webassembly_job ";
            const handleMessage = function (e) {
                const job = e.data[WEBASSEMBLY_JOB_KEY] || e.data.webassembly_job;
                if (job === 'process_fid' || job === 'fid_processing_2d') {
                    self.worker.removeEventListener('message', handleMessage);
                    if (e.data.error) {
                        reject(new Error(e.data.error));
                    } else {
                        resolve(e.data);
                    }
                }
            };

            self.worker.addEventListener('message', handleMessage);
            self.worker.postMessage(Object.assign({}, params, {
                [WEBASSEMBLY_JOB_KEY]: 'process_fid'
            }));
        });
    }

    // =========================================================================
    // 2. PEAK PICKING
    // =========================================================================

    /**
     * Pick Peaks in 2D Spectrum
     * @param {Object} params
     * @returns {Promise<Object>} Picked peaks result
     */
    async peakPicking(params = {}) {
        if (this.mode === 'backend') {
            return await this._peakPickingBackend(params);
        } else {
            return await this._peakPickingWebAss(params);
        }
    }

    async _peakPickingBackend(params) {
        const self = this;
        return new Promise((resolve, reject) => {
            let fd = params.formData;
            if (!fd && params.formElement) {
                fd = new FormData(params.formElement);
            }
            if (!fd) {
                fd = new FormData();
                fd.append('user_job_id', self.userJobId || params.user_job_id);
                if (params.threshold) fd.append('threshold', params.threshold);
                if (params.snr) fd.append('snr', params.snr);
            }
            self._appendCsrf(fd);

            const oReq = new XMLHttpRequest();
            const endpoint = self.baseUrl + '/' + self.serverName + '/peak_picking';
            oReq.open('POST', endpoint, true);

            oReq.onload = function () {
                if (oReq.status === 200) {
                    try {
                        const resp = JSON.parse(oReq.responseText);
                        resolve(resp);
                    } catch (e) {
                        resolve(oReq.responseText);
                    }
                } else {
                    reject(new Error(`2D Peak Picking failed: ${oReq.statusText}`));
                }
            };
            oReq.onerror = () => reject(new Error('Network error during 2D peak picking'));
            oReq.send(fd);
        });
    }

    async _peakPickingWebAss(params) {
        const self = this;
        return new Promise((resolve, reject) => {
            if (!self.worker) {
                reject(new Error('WebAssembly worker not available'));
                return;
            }

            const WEBASSEMBLY_JOB_KEY = "#sym:webassembly_job ";
            const handleMessage = function (e) {
                const job = e.data[WEBASSEMBLY_JOB_KEY] || e.data.webassembly_job;
                if (job === 'peak_picking_2d') {
                    self.worker.removeEventListener('message', handleMessage);
                    if (e.data.error) {
                        reject(new Error(e.data.error));
                    } else {
                        resolve(e.data);
                    }
                }
            };

            self.worker.addEventListener('message', handleMessage);
            self.worker.postMessage(Object.assign({}, params, {
                [WEBASSEMBLY_JOB_KEY]: 'peak_picking_2d'
            }));
        });
    }

    // =========================================================================
    // 3. PEAK FITTING
    // =========================================================================

    /**
     * Fit 2D Peaks
     * @param {Object} params
     * @returns {Promise<Object>} Peak fit result
     */
    async peakFit(params = {}) {
        if (this.mode === 'backend') {
            return await this._peakFitBackend(params);
        } else {
            return await this._peakFitWebAss(params);
        }
    }

    async _peakFitBackend(params) {
        const self = this;
        return new Promise((resolve, reject) => {
            let fd = params.formData;
            if (!fd && params.formElement) {
                fd = new FormData(params.formElement);
            }
            if (!fd) {
                fd = new FormData();
                fd.append('user_job_id', self.userJobId || params.user_job_id);
            }
            self._appendCsrf(fd);

            const oReq = new XMLHttpRequest();
            const endpoint = self.baseUrl + '/' + self.serverName + '/peakfit';
            oReq.open('POST', endpoint, true);

            oReq.onload = function () {
                if (oReq.status === 200) {
                    try {
                        const resp = JSON.parse(oReq.responseText);
                        resolve(resp);
                    } catch (e) {
                        resolve(oReq.responseText);
                    }
                } else {
                    reject(new Error(`2D Peak Fitting failed: ${oReq.statusText}`));
                }
            };
            oReq.onerror = () => reject(new Error('Network error during 2D peak fitting'));
            oReq.send(fd);
        });
    }

    async _peakFitWebAss(params) {
        const self = this;
        return new Promise((resolve, reject) => {
            if (!self.worker) {
                reject(new Error('WebAssembly worker not available'));
                return;
            }

            const WEBASSEMBLY_JOB_KEY = "#sym:webassembly_job ";
            const handleMessage = function (e) {
                const job = e.data[WEBASSEMBLY_JOB_KEY] || e.data.webassembly_job;
                if (job === 'peak_fit_2d') {
                    self.worker.removeEventListener('message', handleMessage);
                    if (e.data.error) {
                        reject(new Error(e.data.error));
                    } else {
                        resolve(e.data);
                    }
                }
            };

            self.worker.addEventListener('message', handleMessage);
            self.worker.postMessage(Object.assign({}, params, {
                [WEBASSEMBLY_JOB_KEY]: 'peak_fit_2d'
            }));
        });
    }

    // =========================================================================
    // HELPER METHODS
    // =========================================================================

    _getCsrf() {
        if (typeof document !== 'undefined') {
            const elem = document.getElementsByName("csrf_test_name")[0];
            if (elem) {
                return { name: elem.name, value: elem.value };
            }
        }
        return null;
    }

    _appendCsrf(formData) {
        const csrf = this._getCsrf();
        if (csrf && formData && !formData.has(csrf.name)) {
            formData.append(csrf.name, csrf.value);
        }
    }
}

// Export for CommonJS if in Node environment, or expose globally in browser
if (typeof module !== 'undefined' && module.exports) {
    module.exports = { NMRPipeline2D };
}
if (typeof window !== 'undefined') {
    window.NMRPipeline2D = NMRPipeline2D;
}

