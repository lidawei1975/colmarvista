describe('Ephemeral webdp1d_cpp.wasm worker (2D)', () => {
    it('compiles the module once, spawns one worker per job, and terminates every worker after use', () => {
        const tracker = { workers: [], compileStreamingUrls: [] };

        cy.visit('/index.html', {
            onBeforeLoad(win) {
                // Track every Worker created by the page and whether it was terminated.
                const NativeWorker = win.Worker;
                win.Worker = function (url, options) {
                    const worker = new NativeWorker(url, options);
                    const record = { url: String(url), terminated: false };
                    const nativeTerminate = worker.terminate.bind(worker);
                    worker.terminate = function () {
                        record.terminated = true;
                        return nativeTerminate();
                    };
                    tracker.workers.push(record);
                    return worker;
                };
                win.Worker.prototype = NativeWorker.prototype;

                // Track WebAssembly compilations done on the main thread.
                if (typeof win.WebAssembly.compileStreaming === 'function') {
                    const nativeCompileStreaming = win.WebAssembly.compileStreaming.bind(win.WebAssembly);
                    win.WebAssembly.compileStreaming = function (source) {
                        return Promise.resolve(source).then((response) => {
                            tracker.compileStreamingUrls.push(response.url);
                            return nativeCompileStreaming(Promise.resolve(response));
                        });
                    };
                }
            }
        });

        const wasm2dWorkers = () => tracker.workers.filter((w) => w.url.indexOf('webass_2d.js') >= 0);

        // The module is compiled on page load, but no webass_2d worker (and no linear memory) exists yet.
        cy.window().then((win) => {
            expect(win.wasm_2d_runner, 'ephemeral runner').to.exist;
            expect(wasm2dWorkers().length, 'webass_2d workers before any job').to.equal(0);
        });

        // Job 1: process the FID
        cy.get('#fid_file', { timeout: 10000 }).selectFile('cypress/fixtures/test_data_2d/ser', { force: true });
        cy.get('#acquisition_file', { timeout: 10000 }).selectFile('cypress/fixtures/test_data_2d/acqus', { force: true });
        cy.get('#acquisition_file2', { timeout: 10000 }).selectFile('cypress/fixtures/test_data_2d/acqu2s', { force: true });
        cy.get('#button_fid_process', { timeout: 10000 }).click({ force: true });
        cy.get('#spectra_list_ol li', { timeout: 120000 }).should('have.length.gt', 0);
        cy.get('#spectra_list_ol', { timeout: 30000 }).should('contain.text', 'from_fid.ft2');

        // Job 1 finished: its worker must already be terminated.
        cy.window({ timeout: 30000 }).should((win) => {
            expect(wasm2dWorkers().length, 'workers after job 1').to.equal(1);
            expect(wasm2dWorkers().every((w) => w.terminated), 'job 1 worker terminated').to.be.true;
            expect(win.wasm_2d_runner._active.size, 'active workers after job 1').to.equal(0);
        });

        // Job 2: DEEP Picker on the first spectrum
        cy.get('#run_deep_picker-0').click();
        cy.get('#show_peaks-0', { timeout: 120000 }).should('be.checked');

        cy.window({ timeout: 30000 }).should((win) => {
            expect(wasm2dWorkers().length, 'a fresh worker was spawned for job 2').to.equal(2);
            expect(wasm2dWorkers().every((w) => w.terminated), 'all workers terminated').to.be.true;
            expect(win.wasm_2d_runner._active.size, 'active workers after job 2').to.equal(0);

            // The bytecode was compiled only once for both jobs.
            const wasmCompiles = tracker.compileStreamingUrls.filter((u) => u.indexOf('webdp1d_cpp.wasm') >= 0);
            expect(wasmCompiles.length, 'webdp1d_cpp.wasm compileStreaming calls').to.equal(1);
        });
    });
});

