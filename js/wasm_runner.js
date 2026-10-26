/**
 * wasm_runner.js
 *
 * Ephemeral WebAssembly worker runner (used by the 2D page, index.html).
 *
 * Problem
 * -------
 * A long-lived Worker that hosts an Emscripten module keeps the module's linear memory
 * (which can only grow, never shrink) alive for the whole browser session, even when the
 * page is idle.
 *
 * Approach
 * --------
 *  1. The compiled WebAssembly.Module is cached on the MAIN thread. It is compiled once with
 *     WebAssembly.compileStreaming(fetch(url)), so the bytecode compilation latency is paid
 *     only once per page load (a compiled Module is just code; it owns no linear memory).
 *  2. A brand new Worker is spawned only when a task is submitted. The cached Module and the
 *     task data are sent to it in a single postMessage. Inside the worker the Emscripten
 *     `instantiateWasm` hook calls WebAssembly.instantiate(module, imports), which is the point
 *     where the linear memory is created, on demand.
 *  3. The task is wrapped in a Promise. worker.terminate() is called synchronously inside the
 *     worker's onmessage (final message) and onerror handlers, so the whole linear memory is
 *     released by the browser/OS after every task.
 *  4. Tasks are executed one at a time by default (maxConcurrent = 1) so that submitting a
 *     batch (for example baseline correction of many planes) never holds several linear
 *     memories at once.
 *
 * Worker side contract (see webass_2d.js and webass_smile.js):
 *  - the first message carries the cached Module under MODULE_KEY (null if unavailable, in which
 *    case the worker falls back to fetching and compiling the .wasm itself);
 *  - messages that only report progress ({stdout: ...} or a progress job) are "intermediate";
 *    every other message (result or {error: ...}) is final and ends the task.
 */
(function (global) {
    'use strict';

    const MODULE_KEY = '__wasm_module__';
    const JOB_KEY = '#sym:webassembly_job ';

    /**
     * Default classification of worker messages that do NOT end a task.
     */
    function defaultIsIntermediate(data) {
        if (!data) {
            return false;
        }
        if (typeof data.stdout !== 'undefined') {
            return true;
        }
        return data[JOB_KEY] === 'pseudo3d_progress';
    }

    function makeCancelledError(reason) {
        const err = new Error(reason || 'WebAssembly task cancelled');
        err.cancelled = true;
        return err;
    }

    class EphemeralWasmRunner {
        /**
         * @param {Object} options
         * @param {string} options.workerUrl Worker script (a fresh worker is created for each task)
         * @param {string} options.wasmUrl .wasm file compiled once and cached on the main thread
         * @param {string} [options.label] Used in log messages
         * @param {number} [options.maxConcurrent=1] Maximum number of simultaneously alive workers
         * @param {function} [options.isIntermediate] data => boolean, true if the message does not end the task
         */
        constructor(options) {
            this.workerUrl = options.workerUrl;
            this.wasmUrl = options.wasmUrl;
            this.label = options.label || 'wasm';
            this.maxConcurrent = options.maxConcurrent || 1;
            this.isIntermediate = options.isIntermediate || defaultIsIntermediate;

            this._modulePromise = null;
            this._queue = [];
            this._active = new Set();
        }

        /**
         * Fetch the wasm binary bytes via XMLHttpRequest as an ArrayBuffer.
         * Used on file:// protocol or as a fallback when fetch() fails or returns status 0.
         * Under Chrome's --allow-file-access-from-files, XHR from the main thread succeeds.
         */
        _loadBinaryViaXhr(url) {
            return new Promise((resolve, reject) => {
                try {
                    const xhr = new XMLHttpRequest();
                    xhr.open('GET', url, true);
                    xhr.responseType = 'arraybuffer';
                    xhr.onload = function () {
                        // Under file://, xhr.status is 0 on success. Under http(s), xhr.status is 200.
                        const ok = (xhr.status === 200 || (xhr.status === 0 && xhr.response && xhr.response.byteLength > 0));
                        if (ok) {
                            resolve(xhr.response);
                        } else {
                            reject(new Error('XHR failed with status ' + xhr.status + ' for ' + url));
                        }
                    };
                    xhr.onerror = function () {
                        reject(new Error('XHR network error loading ' + url));
                    };
                    xhr.send(null);
                } catch (e) {
                    reject(e);
                }
            });
        }

        /**
         * Compile (once) and return the cached WebAssembly.Module on the MAIN thread.
         *  - On file:// protocol, uses XMLHttpRequest to load bytes directly from the local filesystem
         *    (supported on the main thread via --allow-file-access-from-files).
         *  - On http(s)://, attempts WebAssembly.compileStreaming first for fast streaming compilation,
         *    falling back to fetch/ArrayBuffer, and finally XHR.
         * Bytecode is compiled only once per page session; the worker never loads or fetches .wasm itself.
         */
        getModule() {
            if (!this._modulePromise) {
                this._modulePromise = (async () => {
                    const isFileProto = typeof location !== 'undefined' && location.protocol === 'file:';

                    // 1. On file://, avoid compileStreaming/fetch because Chromium rejects
                    // compileStreaming without HTTP Content-Type and fetch() on file:// fails or returns status 0.
                    // Directly use main-thread XMLHttpRequest which works under --allow-file-access-from-files.
                    if (isFileProto) {
                        const buffer = await this._loadBinaryViaXhr(this.wasmUrl);
                        return await WebAssembly.compile(buffer);
                    }

                    // 2. On http(s), try streaming compilation first (fastest, compiles while downloading).
                    if (typeof WebAssembly.compileStreaming === 'function') {
                        try {
                            return await WebAssembly.compileStreaming(fetch(this.wasmUrl));
                        }
                        catch (err) {
                            console.warn('[' + this.label + '] compileStreaming failed, falling back to ArrayBuffer compile:', err);
                        }
                    }

                    // 3. Fallback to fetch + WebAssembly.compile.
                    try {
                        const response = await fetch(this.wasmUrl);
                        if (response.ok) {
                            return await WebAssembly.compile(await response.arrayBuffer());
                        }
                    }
                    catch (fetchErr) {
                        console.warn('[' + this.label + '] fetch failed, falling back to XHR:', fetchErr);
                    }

                    // 4. Final fallback to XHR + compile.
                    const buffer = await this._loadBinaryViaXhr(this.wasmUrl);
                    return await WebAssembly.compile(buffer);
                })();
                this._modulePromise.catch(() => {
                    // Do not cache a failure, the next task retries.
                    this._modulePromise = null;
                });
            }
            return this._modulePromise;
        }

        /**
         * Start compiling now (no worker and no linear memory is created).
         */
        preload() {
            return this.getModule().then(() => true, () => false);
        }

        /**
         * Run one task in a fresh worker.
         *
         * @param {Object} message Task message. It is shallow-copied, the caller's object is not modified.
         * @param {Transferable[]} [transferList]
         * @param {Object} [options]
         * @param {function} [options.onMessage] Called with every worker message event (intermediate and final)
         * @returns {Promise<any>} Resolves with the data of the final message once the worker is terminated.
         *                         Rejects on worker error/crash, or with err.cancelled === true if terminateAll() was called.
         */
        run(message, transferList, options) {
            return new Promise((resolve, reject) => {
                this._queue.push({
                    message: message,
                    transferList: transferList || [],
                    options: options || {},
                    resolve: resolve,
                    reject: reject,
                    worker: null,
                    cancelled: false
                });
                this._pump();
            });
        }

        /**
         * Terminate the running worker(s) immediately and reject all queued tasks as cancelled.
         */
        terminateAll(reason) {
            const err = makeCancelledError(reason);
            const queued = this._queue;
            this._queue = [];
            for (const task of queued) {
                task.cancelled = true;
                task.reject(err);
            }
            const active = Array.from(this._active);
            this._active.clear();
            for (const task of active) {
                task.cancelled = true;
                this._terminateWorker(task);
                task.reject(err);
            }
        }

        /**
         * Returns an object with the small subset of the Worker API used by the page
         * (postMessage / onmessage / onerror / terminate), so that existing call sites such as
         * webassembly_worker.postMessage(msg, transferList) keep working unchanged while each
         * call is executed as an ephemeral task.
         */
        createWorkerFacade() {
            const runner = this;
            const facade = {
                onmessage: null,
                onerror: null,
                postMessage: function (message, transferList) {
                    return runner.run(message, transferList, {
                        onMessage: function (event) {
                            if (typeof facade.onmessage === 'function') {
                                facade.onmessage(event);
                            }
                        }
                    }).catch(function (err) {
                        if (err && err.cancelled) {
                            return null;
                        }
                        const text = (err && err.message) ? err.message : String(err);
                        console.error('[' + runner.label + '] worker task failed:', err);
                        if (typeof facade.onerror === 'function') {
                            facade.onerror({ message: text, error: err });
                        }
                        else if (typeof facade.onmessage === 'function') {
                            facade.onmessage({
                                data: {
                                    error: runner.label + ' worker error: ' + text,
                                    spectrum_index: message ? message.spectrum_index : undefined
                                }
                            });
                        }
                        return null;
                    });
                },
                terminate: function () {
                    runner.terminateAll('terminated');
                }
            };
            return facade;
        }

        /* ------------------------------ internals ------------------------------ */

        _pump() {
            while (this._active.size < this.maxConcurrent && this._queue.length > 0) {
                this._start(this._queue.shift());
            }
        }

        async _start(task) {
            // Reserve the slot before awaiting so that the concurrency limit is respected.
            this._active.add(task);

            let module = null;
            try {
                module = await this.getModule();
            }
            catch (err) {
                console.error('[' + this.label + '] Failed to compile WebAssembly module on main thread:', err);
                this._active.delete(task);
                task.reject(new Error('Failed to load and compile WebAssembly module: ' + (err && err.message ? err.message : String(err))));
                this._pump();
                return;
            }
            if (task.cancelled) {
                return;
            }

            let worker;
            try {
                worker = new Worker(this.workerUrl);
            }
            catch (err) {
                this._active.delete(task);
                task.reject(err);
                this._pump();
                return;
            }
            task.worker = worker;

            worker.onmessage = (event) => {
                if (task.cancelled) {
                    return;
                }
                if (this.isIntermediate(event.data)) {
                    this._dispatch(task, event);
                    return;
                }
                /**
                 * Final message: terminate first, so the linear memory is released right away,
                 * then hand the result over.
                 */
                this._finish(task);
                this._dispatch(task, event);
                task.resolve(event.data);
            };

            worker.onerror = (event) => {
                if (task.cancelled) {
                    return;
                }
                if (event && typeof event.preventDefault === 'function') {
                    event.preventDefault();
                }
                this._finish(task);
                task.reject(new Error((event && event.message) ? event.message : 'Worker error'));
            };

            const payload = Object.assign({}, task.message);
            payload[MODULE_KEY] = module;
            try {
                worker.postMessage(payload, task.transferList);
            }
            catch (err) {
                this._finish(task);
                task.reject(err);
            }
        }

        _dispatch(task, event) {
            const handler = task.options.onMessage;
            if (typeof handler === 'function') {
                try {
                    handler(event);
                }
                catch (err) {
                    console.error('[' + this.label + '] message handler threw:', err);
                }
            }
        }

        _terminateWorker(task) {
            if (task.worker) {
                task.worker.onmessage = null;
                task.worker.onerror = null;
                task.worker.terminate();
                task.worker = null;
            }
        }

        _finish(task) {
            this._terminateWorker(task);
            this._active.delete(task);
            this._pump();
        }
    }

    global.EphemeralWasmRunner = EphemeralWasmRunner;
    global.EPHEMERAL_WASM_MODULE_KEY = MODULE_KEY;
})(typeof self !== 'undefined' ? self : this);
