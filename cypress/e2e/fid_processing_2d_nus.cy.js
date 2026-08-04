describe('FID Processing 2D NUS Test', () => {
    it('loads NUS files, sets processing parameters, and verifies 2D contour plot, 1D projections, noise level, and sparse peaks', () => {
        // 1. Visit the page
        cy.visit('/index.html');

        // 2. Upload Files
        cy.get('#fid_file', { timeout: 10000 })
            .selectFile('cypress/fixtures/test_data_2d_nus/ser', { force: true });
        cy.get('#acquisition_file', { timeout: 10000 })
            .selectFile('cypress/fixtures/test_data_2d_nus/acqus', { force: true });
        cy.get('#acquisition_file2', { timeout: 10000 })
            .selectFile('cypress/fixtures/test_data_2d_nus/acqu2s', { force: true });
        cy.get('#nuslist_file', { timeout: 10000 })
            .selectFile('cypress/fixtures/test_data_2d_nus/nuslist', { force: true });

        // 3. Set Phase and Range Parameters (with known phase correction values)
        cy.get('#auto_direct').check({ force: true });
        cy.get('#ann_auto_direct').uncheck({ force: true });
        cy.get('#phase_correction_direct_p0').clear({ force: true }).type('0', { force: true });
        cy.get('#phase_correction_direct_p1').clear({ force: true }).type('0', { force: true });

        // - Set phase at 90,0 for indirect dimension (disable auto_indirect first)
        cy.get('#auto_indirect').uncheck({ force: true });
        cy.get('#phase_correction_indirect_p0').clear({ force: true }).type('90', { force: true });
        cy.get('#phase_correction_indirect_p1').clear({ force: true }).type('0', { force: true });

        // - Extract direct dimension from 8.8 to 7.8 ppm
        cy.get('#extract_direct_from').clear({ force: true }).type('8.8', { force: true });
        cy.get('#extract_direct_to').clear({ force: true }).type('5.2', { force: true });

        // 4. Click Process
        cy.get('#button_fid_process', { timeout: 10000 }).click({ force: true });

        // 5. Wait for Processing to Complete
        cy.get('#spectra_list_ol li', { timeout: 600000 }).should('have.length.gt', 0);
        cy.get('#spectra_list_ol', { timeout: 30000 }).should('contain.text', 'from_fid.ft2');

        // 6. Verify 2D Contour Plot (Axes and Canvas exist)
        cy.get('.xaxis').should('exist');
        cy.get('.yaxis').should('exist');
        cy.get('#canvas1').should('exist');

        // 7. Verify 1D Projections exist and have path lines rendered
        cy.get('#cross_section_svg_x path', { timeout: 30000 }).should('have.length.gt', 0);
        cy.get('#cross_section_svg_y path', { timeout: 30000 }).should('have.length.gt', 0);

        // 8. Verify 2D Frequency Spectrum Noise Level and Peak Sparsity
        cy.window().then((win) => {
            expect(win.hsqc_spectra).to.exist;
            expect(win.hsqc_spectra.length).to.be.greaterThan(0);

            const spectrum = win.hsqc_spectra[0];
            expect(spectrum).to.exist;
            expect(spectrum.raw_data).to.exist;
            expect(spectrum.noise_level).to.exist;

            // Assert noise level is around 11 (+-30%, i.e. between 7.7 and 14.3)
            expect(spectrum.noise_level).to.be.within(11 * 0.7, 11 * 1.3);

            // Assert sparse peaks: data points where abs(val) > 10 * noise_level should be < 5% of total points
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
