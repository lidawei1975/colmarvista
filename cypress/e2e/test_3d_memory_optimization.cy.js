describe('3D Memory Optimization & Master Buffer Tests', () => {
    beforeEach(() => {
        cy.visit('/index_3d.html');
    });

    it('verifies that no WASM workers are spawned on page load (ephemeral on-demand worker)', () => {
        cy.window().then((win) => {
            expect(win.web_worker_3d, 'web_worker_3d before any job').to.be.null;
            expect(win.web_worker_smile_3d, 'web_worker_smile_3d before any job').to.be.null;

            // Creating worker on-demand works
            const worker = win.get_or_create_web_worker_3d();
            expect(worker, 'spawned worker').to.exist;
            expect(win.web_worker_3d, 'active web_worker_3d reference').to.equal(worker);

            // Releasing worker terminates and nulls it out
            win.release_web_worker_3d();
            expect(win.web_worker_3d, 'web_worker_3d after release').to.be.null;
        });
    });

    it('verifies LRU contour cache bounds memory to MAX_CACHED_CONTOUR_SLICES (20 slices)', () => {
        cy.window().then((win) => {
            win.spectra_3d = [];
            for (let i = 0; i < 25; i++) {
                win.spectra_3d.push({
                    cached_contour_pos: { points: new Float32Array([1, 2, 3]) },
                    cached_contour_neg: { points: new Float32Array([4, 5, 6]) }
                });
                win.touch_contour_lru(i);
            }

            expect(win.lru_contour_slices.length, 'LRU size').to.be.at.most(20);
            // Slices 0 through 4 should have been evicted and their cached contour nullified
            for (let i = 0; i < 5; i++) {
                expect(win.spectra_3d[i].cached_contour_pos, `slice ${i} pos contour evicted`).to.be.null;
                expect(win.spectra_3d[i].cached_contour_neg, `slice ${i} neg contour evicted`).to.be.null;
            }
            // Slices 5 through 24 should remain cached
            expect(win.spectra_3d[24].cached_contour_pos, 'latest slice 24 remains cached').to.not.be.null;
        });
    });

    it('verifies Option A in create_ft3_buffer makes a fast clone without detaching master_3d_buffer', () => {
        cy.window().then((win) => {
            const nx = 64;
            const ny = 64;
            const nz = 4;
            const totalBytes = 2048 + nz * (nx * ny * 4);
            const master = new ArrayBuffer(totalBytes);
            new Float32Array(master, 0, 512).fill(1.0); // mock header
            win.master_3d_buffer = master;

            win.spectra_3d = [];
            for (let i = 0; i < nz; i++) {
                const s = win.eval('new spectrum()');
                s.n_direct = nx;
                s.n_indirect = ny;
                s.datatype_direct = 1;
                s.datatype_indirect = 1;
                s.header = new Float32Array(master, 0, 512);
                s.raw_data = new Float32Array(master, 2048 + i * nx * ny * 4, nx * ny);
                win.spectra_3d.push(s);
            }

            const clonedBuffer = win.create_ft3_buffer();
            expect(clonedBuffer).to.exist;
            expect(clonedBuffer.byteLength).to.equal(totalBytes);
            // Verify original master buffer is intact (NOT detached)
            expect(win.master_3d_buffer.byteLength, 'master_3d_buffer remains active and non-detached').to.equal(totalBytes);
            expect(clonedBuffer, 'clonedBuffer is a separate buffer instance').to.not.equal(win.master_3d_buffer);
        });
    });

    it('verifies zero-copy volume view in extract_3d_data directly shares master_3d_buffer', () => {
        cy.window().then((win) => {
            const nx = 32;
            const ny = 32;
            const nz = 4;
            const totalBytes = 2048 + nz * (nx * ny * 4);
            const master = new ArrayBuffer(totalBytes);
            win.master_3d_buffer = master;

            win.spectra_3d = [];
            for (let i = 0; i < nz; i++) {
                const s = win.eval('new spectrum()');
                s.n_direct = nx;
                s.n_indirect = ny;
                s.datatype_direct = 1;
                s.datatype_indirect = 1;
                s.spectral_min = -1.0;
                s.spectral_max = 10.0;
                s.noise_level = 0.5;
                s.header = new Float32Array(master, 0, 512);
                s.raw_data = new Float32Array(master, 2048 + i * nx * ny * 4, nx * ny);
                // Fill some test values
                s.raw_data[0] = 5.0;
                win.spectra_3d.push(s);
            }

            win.extract_3d_data();
        });

        // extract_3d_data uses a 50ms setTimeout
        cy.wait(150);

        cy.window().then((win) => {
            expect(win.current_volume_data).to.exist;
            expect(win.current_volume_data.data).to.exist;
            // The volumeData buffer MUST be identical to master_3d_buffer (0 extra memory allocation)
            expect(win.current_volume_data.data.buffer, 'zero-copy view directly on master_3d_buffer').to.equal(win.master_3d_buffer);
            expect(win.current_volume_data.data[0], 'data point value').to.equal(5.0);
            expect(win.current_volume_data.min).to.equal(-1.0);
            expect(win.current_volume_data.max).to.equal(10.0);

            // Verify toggle_visualize_3d(false) cleans up current_volume_data
            win.toggle_visualize_3d(false);
            expect(win.current_volume_data, 'volume data freed on hide').to.be.null;

            // Verify reset_3d_dataset_state frees master_3d_buffer and spectra
            win.reset_3d_dataset_state();
            expect(win.master_3d_buffer, 'master buffer freed on reset').to.be.null;
            expect(win.spectra_3d.length, 'spectra array cleared').to.equal(0);
        });
    });
});

