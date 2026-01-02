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
    });
});
