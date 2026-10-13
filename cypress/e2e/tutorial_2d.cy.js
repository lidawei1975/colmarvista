describe('2D Tutorial Interactive Test', () => {
    it('verifies 2D tutorial launches, can be dismissed, and steps through processing and interaction', () => {
        // 1. Visit index.html
        cy.visit('/index.html');

        // 2. Tutorial button should exist and be visible
        cy.get('#start_tutorial').should('be.visible').and('contain.text', 'Tutorial');

        // 3. Click Tutorial button to launch
        cy.get('#start_tutorial').click();

        // 4. Welcome step tooltip should appear with Welcome message and close button
        cy.get('.tutorial-tooltip', { timeout: 5000 }).should('be.visible');
        cy.get('.tutorial-tooltip').should('contain.text', 'Welcome');
        cy.get('.tutorial-close').should('be.visible');

        // 5. Test close button
        cy.get('.tutorial-close').click();
        cy.get('.tutorial-tooltip').should('not.exist');

        // 6. Launch tutorial again
        cy.get('#start_tutorial').click();
        cy.get('.tutorial-tooltip', { timeout: 5000 }).should('be.visible');

        // 7. Click Next on Welcome step
        cy.get('.tutorial-tooltip button').contains('Next').click();

        // 8. Step 1: Input files step
        cy.get('.tutorial-tooltip').should('contain.text', 'Step 1');
        cy.get('#input_files').should('have.class', 'tutorial-highlight');

        // 9. Upload test files into fid_file, acquisition_file, and acquisition_file2
        cy.get('#fid_file').selectFile('cypress/fixtures/test_data_2d/ser', { force: true });
        cy.get('#acquisition_file').selectFile('cypress/fixtures/test_data_2d/acqus', { force: true });
        cy.get('#acquisition_file2').selectFile('cypress/fixtures/test_data_2d/acqu2s', { force: true });

        // 10. Tutorial should auto-advance to Step 2 (button_fid_process)
        cy.get('.tutorial-tooltip', { timeout: 10000 }).should('contain.text', 'Step 2');
        cy.get('#button_fid_process').should('have.class', 'tutorial-highlight');

        // 11. Click process button
        cy.get('#button_fid_process').click({ force: true });

        // 12. Tutorial should show Processing message
        cy.get('.tutorial-tooltip', { timeout: 10000 }).should('contain.text', 'Processing');

        // 13. Wait for processing to complete and advance to Zoom step (Step 3 in text)
        cy.get('.tutorial-tooltip', { timeout: 60000 }).should('contain.text', 'Zoom');

        // 14. Advance through remaining steps (Cross-section, Download ft2, Complete)
        cy.get('.tutorial-tooltip button').contains('Next').click();
        cy.get('.tutorial-tooltip').should('contain.text', 'cross-section');

        cy.get('.tutorial-tooltip button').contains('Next').click();
        cy.get('.tutorial-tooltip').should('contain.text', 'Download');

        // Prepare window:alert stub for completion alert
        cy.window().then((win) => {
            cy.stub(win, 'alert').as('alertStub');
        });

        cy.get('.tutorial-tooltip button').contains('Next').click();
        cy.get('.tutorial-tooltip').should('contain.text', 'Tutorial Complete');

        cy.get('.tutorial-tooltip button').contains('Next').click();
        cy.get('@alertStub').should('have.been.calledWith', 'Tutorial Completed!');
    });
});

