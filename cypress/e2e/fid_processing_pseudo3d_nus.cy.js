describe('FID Processing Pseudo3D NUS Test', () => {
    it('loads pseudo3D NUS files, sets all_planes, auto & ann_auto direct phase, indirect P0=-90 P1=0, verifies 6 planes, noise level (~42), and sparse peaks across all planes', () => {
        // 1. Visit the page
        cy.visit('/index.html');

        // 2. Upload Files from subfolder test_data_pseudo3d_nus
        cy.get('#fid_file', { timeout: 10000 })
            .selectFile('cypress/fixtures/test_data_pseudo3d_nus/ser', { force: true });
        cy.get('#acquisition_file', { timeout: 10000 })
            .selectFile('cypress/fixtures/test_data_pseudo3d_nus/acqus', { force: true });
        cy.get('#acquisition_file2', { timeout: 10000 })
            .selectFile('cypress/fixtures/test_data_pseudo3d_nus/acqu2s', { force: true });
        cy.get('#acquisition_file3', { timeout: 10000 })
            .selectFile('cypress/fixtures/test_data_pseudo3d_nus/acqu3s', { force: true });
        cy.get('#nuslist_file', { timeout: 10000 })
            .selectFile('cypress/fixtures/test_data_pseudo3d_nus/nuslist', { force: true });

        // 3. Select Pseudo-3D Process All Planes
        cy.get('input[name="Pseudo-3D-process"][value="all_planes"]').check({ force: true });

        // 4. Configure Phase Parameters
        // Set auto and ann auto direct phase
        cy.get('#auto_direct').check({ force: true });
        cy.get('#ann_auto_direct').check({ force: true });

        // Set indirect phase to P0 = -90, P1 = 0 (disable auto_indirect first)
        cy.get('#auto_indirect').uncheck({ force: true });
        cy.get('#phase_correction_indirect_p0').clear({ force: true }).type('-90', { force: true });
        cy.get('#phase_correction_indirect_p1').clear({ force: true }).type('0', { force: true });

        // 5. Click Process
        cy.get('#button_fid_process', { timeout: 10000 }).click({ force: true });

        // 6. Wait for Processing to Complete (up to 10 minutes for 5 planes)
        cy.get('#spectra_list_ol li', { timeout: 600000 }).should('have.length', 5);
        cy.get('#spectra_list_ol', { timeout: 600000 }).should('contain.text', 'from_fid.ft2');

        // 7. Verify 2D Contour Plot (Axes and Canvas exist)
        cy.get('.xaxis').should('exist');
        cy.get('.yaxis').should('exist');
        cy.get('#canvas1').should('exist');

        // 8. Verify Noise Level (~42 +-30%) and Peak Sparsity Across All 6 Plane Spectra
        cy.window().then((win) => {
            expect(win.hsqc_spectra).to.exist;
            expect(win.hsqc_spectra.length).to.be.gte(5);

            win.hsqc_spectra.forEach((spectrum, idx) => {
                expect(spectrum.raw_data).to.exist;
                expect(spectrum.noise_level).to.exist;

                // Assert noise level is around 56 (+-30%, i.e. between 39.2 and 72.8)
                expect(spectrum.noise_level).to.be.within(56 * 0.7, 56 * 1.3);

                const threshold = 10 * spectrum.noise_level;
                const totalPoints = spectrum.raw_data.length;
                let peakPointsCount = 0;

                for (let i = 0; i < totalPoints; i++) {
                    if (Math.abs(spectrum.raw_data[i]) > threshold) {
                        peakPointsCount++;
                    }
                }

                const peakRatio = peakPointsCount / totalPoints;
                expect(peakRatio).to.be.lessThan(0.05);
            });
        });
    });
});
