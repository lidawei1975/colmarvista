describe('FID Processing 2D Test', () => {
    it('loads SER, acqus, and acqu2s files and processes them', () => {
        // 1. Visit the page
        cy.visit('/index.html');

        // 2. Upload Files
        // The user must place 'ser', 'acqus', and 'acqu2s' in cypress/fixtures/test_data_2d/
        cy.get('#fid_file', { timeout: 10000 }).selectFile('cypress/fixtures/test_data_2d/ser', { force: true });
        cy.get('#acquisition_file', { timeout: 10000 }).selectFile('cypress/fixtures/test_data_2d/acqus', { force: true });
        cy.get('#acquisition_file2', { timeout: 10000 }).selectFile('cypress/fixtures/test_data_2d/acqu2s', { force: true });

        // 3. Click Process
        cy.get('#button_fid_process', { timeout: 10000 }).click({ force: true });

        // 4. Wait for Processing to Complete
        // We check for the spectra list to key populated.
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
    });
});
