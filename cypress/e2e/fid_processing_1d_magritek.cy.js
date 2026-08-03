describe('1D Magritek FID Processing Test', () => {
    it('loads Magritek acqu.par and data.1d files and processes them', () => {
        // 1. Visit the page
        cy.visit('/index_1d.html');

        // 2. Upload Files (acqu.par for parameter, data.1d for FID)
        cy.get('#fid_file').selectFile('cypress/fixtures/test_data_1d_megritek/data.1d', { force: true });
        cy.get('#acquisition_file').selectFile('cypress/fixtures/test_data_1d_megritek/acqu.par', { force: true });

        // 3. Click Process
        cy.get('#button_fid_process').click({ force: true });

        // 4. Verify Plot renders
        cy.get('#plot_1d', { timeout: 15000 }).should('be.visible');

        // 5. Verify X-Axis exists
        cy.get('.xaxis').should('exist');

        // 6. Verify Spectral Data is Drawn
        cy.get('#plot_1d path').should('have.length.gt', 0);

        // 7. Verify Auto Phase Correction finishes
        cy.get('#button_auto_pc', { timeout: 60000 }).should('be.enabled');
    });
});
