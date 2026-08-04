describe('FID Processing 3D NUS Test', () => {
    it('loads 3D NUS files, enables automatic phase & FLATT, sets ppm range and F1 P0, processes 3D spectrum, verifies 2D/1D plots and sparse peaks on xy planes', () => {
        // 1. Visit 3D Spectrum page
        cy.visit('/index_3d.html');

        // 2. Upload 3D NUS Input Files
        cy.get('#fid_file', { timeout: 10000 })
            .selectFile('cypress/fixtures/test_data_3d_nus/ser', { force: true });
        cy.get('#acquisition_file', { timeout: 10000 })
            .selectFile('cypress/fixtures/test_data_3d_nus/acqus', { force: true });
        cy.get('#acquisition_file2', { timeout: 10000 })
            .selectFile('cypress/fixtures/test_data_3d_nus/acqu2s', { force: true });
        cy.get('#acquisition_file3', { timeout: 10000 })
            .selectFile('cypress/fixtures/test_data_3d_nus/acqu3s', { force: true });
        cy.get('#nuslist_file', { timeout: 10000 })
            .selectFile('cypress/fixtures/test_data_3d_nus/nuslist', { force: true });

        // 3. Configure Processing Parameters
        // Check Automatic phase correction
        cy.get('#normal_direct_dim_auto_phase_3d').check({ force: true });

        // Check Direct dimension FLATT baseline correction for NUS
        cy.get('#nus_flatt_baseline_3d').check({ force: true });

        // Set Direct dimension extract range (from 11.3 to 5.2 ppm)
        cy.get('#extract_direct_from').clear({ force: true }).type('11.3', { force: true });
        cy.get('#extract_direct_to').clear({ force: true }).type('5.2', { force: true });

        // Set Indirect dimension 1 (F1) P0 to 90
        cy.get('#phase_correction_indirect1_p0').clear({ force: true }).type('90', { force: true });

        // 4. Click Upload and Process 3D FID
        cy.get('#button_fid_process_3d', { timeout: 10000 }).click({ force: true });

        // 5. Wait for Processing to Complete (~4+ minutes for 3D NUS reconstruction)
        // flex-container is assigned to #main_plot_area, so checking its visibility confirms completion
        cy.get('#main_plot_area', { timeout: 360000 }).should('be.visible');

        // 6. Verify 3 2D Contour Plot Canvases (xy, xz, zy planes)
        cy.get('#canvas1').should('exist');
        cy.get('#canvas_xz').should('exist');
        cy.get('#canvas_yz').should('exist');

        // 7. Verify 3 1D Cross Section Trace SVGs (along z, y, x)
        cy.get('#trace_z_svg').should('exist');
        cy.get('#trace_y_svg').should('exist');
        cy.get('#trace_x_svg').should('exist');

        // 8. Verify Sparse Peaks on each xy plane
        cy.window().then((win) => {
            expect(win.spectra_3d).to.exist;
            expect(win.spectra_3d.length).to.be.greaterThan(0);

            win.spectra_3d.forEach((plane, index) => {
                expect(plane.raw_data).to.exist;
                const totalPoints = plane.raw_data.length;
                expect(totalPoints).to.be.greaterThan(0);

                const nDirect = plane.n_direct || Math.sqrt(totalPoints);
                const nIndirect = plane.n_indirect || (totalPoints / nDirect);

                // Define noise threshold (6x noise level, standard 2D plot lowest contour multiplier)
                const threshold = (plane.noise_level && plane.noise_level > 0)
                    ? plane.noise_level * 6
                    : plane.spectral_max * 0.1;

                let peakPointsCount = 0;
                let localMaximaCount = 0;

                for (let r = 0; r < nIndirect; r++) {
                    for (let c = 0; c < nDirect; c++) {
                        const idx = r * nDirect + c;
                        const val = Math.abs(plane.raw_data[idx]);

                        if (val > threshold) {
                            peakPointsCount++;

                            // Check if this point is a 2D local maximum relative to 8-neighbors
                            if (r > 0 && r < nIndirect - 1 && c > 0 && c < nDirect - 1) {
                                const isMax =
                                    val >= Math.abs(plane.raw_data[(r - 1) * nDirect + (c - 1)]) &&
                                    val >= Math.abs(plane.raw_data[(r - 1) * nDirect + c]) &&
                                    val >= Math.abs(plane.raw_data[(r - 1) * nDirect + (c + 1)]) &&
                                    val >= Math.abs(plane.raw_data[r * nDirect + (c - 1)]) &&
                                    val >= Math.abs(plane.raw_data[r * nDirect + (c + 1)]) &&
                                    val >= Math.abs(plane.raw_data[(r + 1) * nDirect + (c - 1)]) &&
                                    val >= Math.abs(plane.raw_data[(r + 1) * nDirect + c]) &&
                                    val >= Math.abs(plane.raw_data[(r + 1) * nDirect + (c + 1)]);

                                if (isMax) {
                                    localMaximaCount++;
                                }
                            }
                        }
                    }
                }

                // Assertion 1: High-intensity peak points ratio < 5% of total grid points
                const peakRatio = peakPointsCount / totalPoints;
                expect(peakRatio).to.be.lessThan(0.05);

                // Assertion 2: Local maxima peaks count per xy plane is sparse (<= 50)
                expect(localMaximaCount).to.be.at.most(50);
            });
        });
    });
});
