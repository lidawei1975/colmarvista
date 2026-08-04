describe('3D Contour Color Pickers Test', () => {
    it('verifies the existence and default values of the 4 contour color pickers', () => {
        // Visit the 3D NMR spect viewer page
        cy.visit('/index_3d.html');

        // Verify the Global Controls section exists
        cy.contains('Global Controls:').should('exist');

        // Verify the Positive Experimental color picker exists and has default blue
        cy.get('#color_exp_pos')
            .should('exist')
            .should('have.value', '#0000ff');

        // Verify the Negative Experimental color picker exists and has default green
        cy.get('#color_exp_neg')
            .should('exist')
            .should('have.value', '#00ff00');

        // Verify the Positive Theoretical color picker exists and has default red
        cy.get('#color_theo_pos')
            .should('exist')
            .should('have.value', '#ff0000');

        // Verify the Negative Theoretical color picker exists and has default black
        cy.get('#color_theo_neg')
            .should('exist')
            .should('have.value', '#000000');

        // Verify the Peak Symbol color picker exists and has default cyan
        cy.get('#color_peak_symbol')
            .should('exist')
            .should('have.value', '#00ffff');
    });
});
