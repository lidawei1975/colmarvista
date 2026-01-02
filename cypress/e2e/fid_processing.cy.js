describe('FID Processing Test', () => {
    it('loads FID and acqus files and processes them', () => {
        // 1. Visit the page
        cy.visit('/index_1d.html');

        // 2. Upload Files
        // Note: We use .selectFile with force: true because the input might be hidden or styled customly
        // The user must place 'fid' and 'acqus' in cypress/fixtures/test_data/
        cy.get('#fid_file').selectFile('cypress/fixtures/test_data/fid', { force: true });
        cy.get('#acquisition_file').selectFile('cypress/fixtures/test_data/acqus', { force: true });

        // 3. Click Process
        cy.get('#button_fid_process').click({ force: true });

        // 4. Wait for Processing
        // We wait for the 'Processing...' tutorial step or button re-enable.
        // Better check: The plot should become visible
        cy.get('#plot_1d', { timeout: 15000 }).should('be.visible');

        // 5. Verify X-Axis exists (implies SVG rendered)
        cy.get('.xaxis').should('exist');

        // 6. Verify Spectral Data is Drawn
        // Check for path elements inside the plot which represent the spectrum lines
        cy.get('#plot_1d path').should('have.length.gt', 0);

        // 7. Wait for Phase Correction to Finish
        // We know phase correction is done when the 'Auto Phase Correction' button becomes enabled
        // This is controlled by disable_enable_phase_baseline_buttons(true) in the app
        cy.get('#button_auto_pc', { timeout: 60000 }).should('be.enabled');

        // --- Deep Picker Flow ---

        // 7. Set scale1-0 to 50
        cy.get('#scale1-0').clear().type('50');

        // 8. Click Run DEEP Picker
        // Note: The button might be disabled initially? Checking.
        cy.get('#run_deep_picker-0').click();

        // 9. Wait for Processing to Finish
        // The user says "show_peaks-0" should be enabled after finish.
        // We give it a generous timeout because ML picking can take time.
        cy.get('#show_peaks-0', { timeout: 30000 }).should('be.enabled');

        // 10. Show Peaks
        cy.get('#show_peaks-0').check({ force: true }); // It's a checkbox

        // 11. Verify Peaks on Plot
        // Assuming peaks are rendered as text labels or circles/paths on top of the spectrum
        // We just check that the SVG DOM increased in complexity
        cy.get('#plot_1d g').should('have.length.gt', 5);

        // --- Peak Fitting Flow ((Voigt Fitter) ---

        // 12. Set Max Round to 5 (Speed up test)
        // ID is maxround-0 for the first spectrum
        cy.get('#maxround-0').clear().type('5');

        // 13. Click Peak Fitting
        // ID is run_voigt_fitter-0
        cy.get('#run_voigt_fitter-0').click();

        // 14. Wait for Reconstructed Spectrum
        // User says: "once finished, it should add a reconstruced spectrum to the list"
        // We look for the text "Reconstructed spectrum" which is added as a title for the new spectrum
        // Giving it time as fitting can be slow
        cy.contains('Reconstructed spectrum', { timeout: 60000 }).should('be.visible');

        // 15. Verify Plot Complexity Increases
        // The reconstructed spectrum adds more lines (paths) to the plot
        cy.get('#plot_1d path').should('have.length.gt', 1);
    });
});
