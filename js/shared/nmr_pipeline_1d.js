/**
 * NMRPipeline1D (Shared Dual-Execution Engine)
 * 
 * Provides a unified API for 1D NMR processing operations:
 * - FID processing (Bruker, Magritek, JCAMP-DX)
 * - Phase correction (Entropy-based / manual)
 * - Baseline estimation
 * - Peak picking & Voigt deconvolution
 * 
 * Configured by execution mode:
 * - 'backend': Dispatches requests to CodeIgniter PHP backend, handles polling,
 *              saves session files on the server disk for user_job_id resumption.
 * - 'webass':  Dispatches jobs to WebWorker running WebAssembly (webdp1d_cpp.wasm)
 *              for high-speed, client-side, offline execution.
 */

class NMRPipeline1D {
    constructor(config = {}) {
        this.mode = config.mode || 'webass'; // 'backend' or 'webass'
        this.baseUrl = config.baseUrl || '';
        this.serverName = config.serverName || 'colmar1d';
        this.userJobId = config.userJobId || null;
        this.worker = config.worker || (typeof webassembly_1d_worker_2 !== 'undefined' ? webassembly_1d_worker_2 : null);
        this.onStatus = config.onStatus || function (msg) { console.log('[NMRPipeline1D]', msg); };
        this.onError = config.onError || function (err) { console.error('[NMRPipeline1D Error]', err); };
    }

    setMode(mode) {
        if (mode === 'backend' || mode === 'webass') {
            this.mode = mode;
        } else {
            console.warn('[NMRPipeline1D] Unknown mode:', mode);
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
     * Process Raw FID data
     * @param {Object} params - Contains formElement or formData or { fid_file, acquisition_file, ... }
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
                reject(new Error('No FormData or formElement provided for backend FID processing.'));
                return;
            }

            self._appendCsrf(fd);

            const oReq = new XMLHttpRequest();
            oReq.open('POST', self.baseUrl + '/index.php/' + self.serverName + '/run_fid', true);
            oReq.setRequestHeader('X-Requested-With', 'XMLHttpRequest');

            oReq.onload = function () {
                if (oReq.status === 200) {
                    try {
                        const result = JSON.parse(oReq.responseText);
                        const pid_fid = result.pid_fid;
                        if (result.user_job_id) {
                            self.userJobId = result.user_job_id;
                        }

                        // Poll server for FID processing completion
                        const pollInterval = setInterval(() => {
                            const pollData = { pid_fid: pid_fid, user_job_id: self.userJobId };
                            const csrf = self._getCsrf();
                            if (csrf) pollData[csrf.name] = csrf.value;

                            $.ajax({
                                url: self.baseUrl + '/index.php/' + self.serverName + '/check_fid_status',
                                dataType: 'text',
                                data: pollData,
                                type: 'POST',
                                success: function (response) {
                                    try {
                                        const res = JSON.parse(response);
                                        if (res.status) {
                                            self.onStatus(res.status);
                                        }
                                        if (res.status && res.status.toLowerCase().indexOf('done') !== -1) {
                                            clearInterval(pollInterval);
                                            resolve(res);
                                        }
                                    } catch (e) {
                                        clearInterval(pollInterval);
                                        reject(e);
                                    }
                                },
                                error: function (xhr, status, error) {
                                    clearInterval(pollInterval);
                                    reject(new Error(error || status));
                                }
                            });
                        }, 2000);
                    } catch (e) {
                        reject(e);
                    }
                } else {
                    reject(new Error(`Server returned HTTP ${oReq.status}: ${oReq.statusText}`));
                }
            };

            oReq.onerror = function () {
                reject(new Error('Network error during FID upload.'));
            };

            oReq.send(fd);
        });
    }

    async _processFIDWebAss(params) {
        const self = this;
        return new Promise((resolve, reject) => {
            if (!self.worker) {
                reject(new Error('WebAssembly worker not available for client-side processing.'));
                return;
            }

            const WEBASSEMBLY_JOB_KEY = "#sym:webassembly_job ";
            const handleMessage = function (e) {
                const job = e.data[WEBASSEMBLY_JOB_KEY] || e.data.webassembly_job;
                if (job === 'fid_processor_1d') {
                    self.worker.removeEventListener('message', handleMessage);
                    if (e.data.error) {
                        reject(new Error(e.data.error));
                    } else {
                        resolve(e.data);
                    }
                }
            };

            self.worker.addEventListener('message', handleMessage);

            const jobPayload = Object.assign({}, params, {
                [WEBASSEMBLY_JOB_KEY]: 'fid_processor_1d'
            });
            self.worker.postMessage(jobPayload);
        });
    }

    // =========================================================================
    // 2. PHASE CORRECTION (Entropy Phasing)
    // =========================================================================

    /**
     * Run entropy-based phase correction
     */
    async runEntropyPhasing(params = {}) {
        if (this.mode === 'backend') {
            return await this._runEntropyPhasingBackend(params);
        } else {
            return await this._runEntropyPhasingWebAss(params);
        }
    }

    async _runEntropyPhasingBackend(params) {
        const self = this;
        return new Promise((resolve, reject) => {
            const fd = new FormData();
            fd.append('user_job_id', self.userJobId || params.user_job_id);
            fd.append('pc_method', '3'); // Entropy method
            self._appendCsrf(fd);

            const oReq = new XMLHttpRequest();
            oReq.open('POST', self.baseUrl + '/index.php/' + self.serverName + '/apply_phase_correction', true);
            oReq.setRequestHeader('X-Requested-With', 'XMLHttpRequest');
            oReq.onload = function () {
                if (oReq.status === 200) {
                    try {
                        const result = JSON.parse(oReq.responseText);
                        resolve(result);
                    } catch (e) {
                        reject(e);
                    }
                } else {
                    reject(new Error(`Phase correction error: ${oReq.statusText}`));
                }
            };
            oReq.onerror = () => reject(new Error('Network error during phase correction'));
            oReq.send(fd);
        });
    }

    async _runEntropyPhasingWebAss(params) {
        const self = this;
        return new Promise((resolve, reject) => {
            if (!self.worker) {
                reject(new Error('WebAssembly worker not available'));
                return;
            }

            const WEBASSEMBLY_JOB_KEY = "#sym:webassembly_job ";
            const handleMessage = function (e) {
                const job = e.data[WEBASSEMBLY_JOB_KEY] || e.data.webassembly_job;
                if (job === 'phase_correction_1d') {
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
                [WEBASSEMBLY_JOB_KEY]: 'phase_correction_1d'
            }));
        });
    }

    // =========================================================================
    // 3. BASELINE ESTIMATION
    // =========================================================================

    /**
     * Run baseline estimation
     */
    async estimateBaseline(params = {}) {
        if (this.mode === 'backend') {
            return await this._estimateBaselineBackend(params);
        } else {
            return await this._estimateBaselineWebAss(params);
        }
    }

    async _estimateBaselineBackend(params) {
        const self = this;
        return new Promise((resolve, reject) => {
            const fd = new FormData();
            fd.append('user_job_id', self.userJobId || params.user_job_id);
            fd.append('smooth_parameter', params.smooth_parameter || '1e10');
            fd.append('positive_parameter', params.positive_parameter || '1.25');
            self._appendCsrf(fd);

            const oReq = new XMLHttpRequest();
            oReq.open('POST', self.baseUrl + '/index.php/' + self.serverName + '/estimate_baseline', true);
            oReq.setRequestHeader('X-Requested-With', 'XMLHttpRequest');

            oReq.onload = function () {
                if (oReq.status === 200) {
                    try {
                        const result = JSON.parse(oReq.responseText);
                        const pid_baseline = result.pid_baseline;

                        const pollInterval = setInterval(() => {
                            const pollData = { pid_baseline: pid_baseline, user_job_id: self.userJobId };
                            const csrf = self._getCsrf();
                            if (csrf) pollData[csrf.name] = csrf.value;

                            $.ajax({
                                url: self.baseUrl + '/index.php/' + self.serverName + '/check_estimate_baseline_status',
                                dataType: 'text',
                                data: pollData,
                                type: 'POST',
                                success: function (response) {
                                    try {
                                        const res = JSON.parse(response);
                                        if (res.status && res.status.toLowerCase().indexOf('done') !== -1) {
                                            clearInterval(pollInterval);

                                            // Fetch binary baseline arraybuffer
                                            const binReq = new XMLHttpRequest();
                                            const binFd = new FormData();
                                            binFd.append('user_job_id', self.userJobId);
                                            self._appendCsrf(binFd);

                                            binReq.open('POST', self.baseUrl + '/index.php/' + self.serverName + '/get_binary_baseline', true);
                                            binReq.setRequestHeader('X-Requested-With', 'XMLHttpRequest');
                                            binReq.responseType = 'arraybuffer';
                                            binReq.onload = function () {
                                                if (binReq.status === 200) {
                                                    const baseline_data = new Float32Array(binReq.response);
                                                    resolve({ baseline_data: baseline_data, status: 'done' });
                                                } else {
                                                    reject(new Error('Failed to download binary baseline'));
                                                }
                                            };
                                            binReq.send(binFd);
                                        }
                                    } catch (e) {
                                        clearInterval(pollInterval);
                                        reject(e);
                                    }
                                },
                                error: function (xhr, s, err) {
                                    clearInterval(pollInterval);
                                    reject(new Error(err || s));
                                }
                            });
                        }, 2000);
                    } catch (e) {
                        reject(e);
                    }
                } else {
                    reject(new Error(`Estimate baseline failed: ${oReq.statusText}`));
                }
            };
            oReq.onerror = () => reject(new Error('Network error during baseline estimation'));
            oReq.send(fd);
        });
    }

    async _estimateBaselineWebAss(params) {
        const self = this;
        return new Promise((resolve, reject) => {
            if (!self.worker) {
                reject(new Error('WebAssembly worker not available'));
                return;
            }

            const WEBASSEMBLY_JOB_KEY = "#sym:webassembly_job ";
            const handleMessage = function (e) {
                const job = e.data[WEBASSEMBLY_JOB_KEY] || e.data.webassembly_job;
                if (job === 'baseline_correction_1d') {
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
                [WEBASSEMBLY_JOB_KEY]: 'baseline_correction_1d'
            }));
        });
    }

    // =========================================================================
    // 4. DECONVOLUTION (DEEP Picker & Voigt Fitting)
    // =========================================================================

    /**
     * Run Spectrum Deconvolution
     */
    async deconvolute(params = {}) {
        if (this.mode === 'backend') {
            return await this._deconvoluteBackend(params);
        } else {
            return await this._deconvoluteWebAss(params);
        }
    }

    async _deconvoluteBackend(params) {
        const self = this;
        return new Promise((resolve, reject) => {
            let fd = params.formData;
            if (!fd && params.formElement) {
                fd = new FormData(params.formElement);
            }
            if (!fd) {
                fd = new FormData();
                fd.append('user_job_id', self.userJobId || params.user_job_id);
                fd.append('scale1', params.scale1 || '8.0');
                fd.append('nround', params.nround || '3');
                fd.append('picking_method', params.picking_method || 'DEEP_auto');
                fd.append('fitting_function', params.fitting_function || 'voigt');
            }
            self._appendCsrf(fd);

            const oReq = new XMLHttpRequest();
            oReq.open('POST', self.baseUrl + '/index.php/' + self.serverName + '/deconvolution', true);
            oReq.setRequestHeader('X-Requested-With', 'XMLHttpRequest');

            oReq.onload = function () {
                if (oReq.status === 200) {
                    try {
                        const result = JSON.parse(oReq.responseText);
                        const pid_deconvolution = result.pid_deconvolution;

                        const pollInterval = setInterval(() => {
                            const pollData = { pid_deconvolution: pid_deconvolution, user_job_id: self.userJobId };
                            const csrf = self._getCsrf();
                            if (csrf) pollData[csrf.name] = csrf.value;

                            $.ajax({
                                url: self.baseUrl + '/index.php/' + self.serverName + '/check_deconvolution_status',
                                dataType: 'text',
                                data: pollData,
                                type: 'POST',
                                success: function (response) {
                                    try {
                                        const res = JSON.parse(response);
                                        if (res.status) {
                                            self.onStatus(res.status);
                                        }
                                        if (res.status && res.status.toLowerCase().indexOf('done') !== -1) {
                                            clearInterval(pollInterval);
                                            resolve(res);
                                        }
                                    } catch (e) {
                                        clearInterval(pollInterval);
                                        reject(e);
                                    }
                                },
                                error: function (xhr, s, err) {
                                    clearInterval(pollInterval);
                                    reject(new Error(err || s));
                                }
                            });
                        }, 2000);
                    } catch (e) {
                        reject(e);
                    }
                } else {
                    reject(new Error(`Deconvolution failed: ${oReq.statusText}`));
                }
            };
            oReq.onerror = () => reject(new Error('Network error during deconvolution'));
            oReq.send(fd);
        });
    }

    async _deconvoluteWebAss(params) {
        const self = this;
        return new Promise((resolve, reject) => {
            if (!self.worker) {
                reject(new Error('WebAssembly worker not available'));
                return;
            }

            const WEBASSEMBLY_JOB_KEY = "#sym:webassembly_job ";
            const handleMessage = function (e) {
                const job = e.data[WEBASSEMBLY_JOB_KEY] || e.data.webassembly_job;
                if (job === 'peak_fitter_1d' || job === 'peak_picker_1d') {
                    self.worker.removeEventListener('message', handleMessage);
                    if (e.data.error) {
                        reject(new Error(e.data.error));
                    } else {
                        resolve(e.data);
                    }
                }
            };

            self.worker.addEventListener('message', handleMessage);
            const jobType = params.jobType || 'peak_picker_1d';
            self.worker.postMessage(Object.assign({}, params, {
                [WEBASSEMBLY_JOB_KEY]: jobType
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
    module.exports = { NMRPipeline1D };
}

