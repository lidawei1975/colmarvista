describe('FID Processing 2D Test', () => {
    it('loads SER, acqus, and acqu2s files and processes them', () => {
        // 1. Visit the page
        cy.visit('/index.html');

        // 2. Upload Files
        // The user must place 'ser', 'acqus', and 'acqu2s' in cypress/fixtures/test_data_2d/
        cy.get('#fid_file', { timeout: 10000 }).selectFile('cypress/fixtures/test_data_2d/ser', { force: true });
        cy.get('#acquisition_file', { timeout: 10000 }).selectFile('cypress/fixtures/test_data_2d/acqus', { force: true });
        cy.get('#acquisition_file2', { timeout: 10000 }).selectFile('cypress/fixtures/test_data_2d/acqu2s', { force: true });

        cy.get('#auto_direct').check({ force: true });
        cy.get('#ann_auto_direct').check({ force: true });
        cy.get('#phase_correction_direct_p0').clear({ force: true }).type('0', { force: true });
        cy.get('#phase_correction_direct_p1').clear({ force: true }).type('0', { force: true });

        // - Set phase at 90,0 for indirect dimension (disable auto_indirect first)
        cy.get('#auto_indirect').check({ force: true });
        cy.get('#phase_correction_indirect_p0').clear({ force: true }).type('0', { force: true });
        cy.get('#phase_correction_indirect_p1').clear({ force: true }).type('0', { force: true });

        // 3. Click Process
        cy.get('#button_fid_process', { timeout: 10000 }).click({ force: true });

        // 4. Wait for Processing to Complete
        // We check for the spectra list to be populated.
        // Initially empty, should have at least 1 item after processing.
        cy.get('#spectra_list_ol li', { timeout: 60000 }).should('have.length.gt', 0);

        // 5. Verify Axes exist
        cy.get('.xaxis').should('exist');
        cy.get('.yaxis').should('exist');

        // 6. Verify Canvas is present
        cy.get('#canvas1').should('exist');

        // 7. Verify Spectra List is populated with the new spectrum
        // The processed file is typically named "from_fid.ft2"
        cy.get('#spectra_list_ol', { timeout: 30000 }).should('contain.text', 'from_fid.ft2');

        // 8. Verify Indirect Phase Parameters, Spectrum Noise Level, and Peak Sparsity
        cy.get('#phase_correction_indirect_p0').should('have.value', '90');
        cy.get('#phase_correction_indirect_p1').should('have.value', '0');

        cy.window().then((win) => {
            expect(win.hsqc_spectra).to.exist;
            expect(win.hsqc_spectra.length).to.be.greaterThan(0);

            const spectrum = win.hsqc_spectra[0];
            expect(spectrum).to.exist;
            expect(spectrum.raw_data).to.exist;
            expect(spectrum.noise_level).to.exist;

            // Verify indirect phase parameters in process configuration
            expect(spectrum.fid_process_parameters.phase_correction_indirect_p0).to.equal(90);
            expect(spectrum.fid_process_parameters.phase_correction_indirect_p1).to.equal(0);

            // Assert noise level is around 7.7e3 (+-30%, i.e. between 5390 and 10010)
            expect(spectrum.noise_level).to.be.within(7.7e3 * 0.7, 7.7e3 * 1.3);

            // Assert sparse peaks: data points where abs(val) > 10 * noise_level should be < 1% of total points
            const threshold = 10 * spectrum.noise_level;
            const totalPoints = spectrum.raw_data.length;
            let peakPointsCount = 0;

            for (let i = 0; i < totalPoints; i++) {
                if (Math.abs(spectrum.raw_data[i]) > threshold) {
                    peakPointsCount++;
                }
            }

            const peakRatio = peakPointsCount / totalPoints;
            expect(peakRatio).to.be.lessThan(0.01);
        });

        // 9. Test standalone baseline correction
        cy.get('#baseline_method').select('POLYNORMIAL');
        cy.get('#baseline_order_container').should('be.visible');
        cy.get('#baseline_order').select('3');
        cy.get('#button_apply_baseline').should('not.be.disabled').click();

        // Wait for the message indicating completion
        cy.get('#webassembly_message', { timeout: 30000 }).should('contain.text', 'Baseline correction complete!');
    });
});
