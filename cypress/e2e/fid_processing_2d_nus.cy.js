describe('FID Processing 2D NUS Test', () => {
    it('loads NUS files, sets processing parameters, and verifies 2D contour plot and 1D projections', () => {
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

        // 3. Set Phase and Range Parameters
        // - Set auto direct dimension phase
        cy.get('#auto_direct').check({ force: true });

        // - Set phase at 90,0 for indirect dimension (disable auto_indirect first)
        cy.get('#auto_indirect').uncheck({ force: true });
        cy.get('#phase_correction_indirect_p0').clear({ force: true }).type('90', { force: true });
        cy.get('#phase_correction_indirect_p1').clear({ force: true }).type('0', { force: true });

        // - Extract direct dimension from 8.8 to 7.8 ppm
        cy.get('#extract_direct_from').clear({ force: true }).type('8.8', { force: true });
        cy.get('#extract_direct_to').clear({ force: true }).type('7.8', { force: true });

        // 4. Click Process
        cy.get('#button_fid_process', { timeout: 10000 }).click({ force: true });

        // 5. Wait for Processing to Complete
        // Processing NUS can take a bit longer (e.g. 60-90 seconds)
        cy.get('#spectra_list_ol li', { timeout: 120000 }).should('have.length.gt', 0);
        cy.get('#spectra_list_ol', { timeout: 30000 }).should('contain.text', 'from_fid.ft2');

        // 6. Verify 2D Contour Plot (Axes and Canvas exist)
        cy.get('.xaxis').should('exist');
        cy.get('.yaxis').should('exist');
        cy.get('#canvas1').should('exist');

        // 7. Verify 1D Projections exist and have path lines rendered
        cy.get('#cross_section_svg_x path', { timeout: 30000 }).should('have.length.gt', 0);
        cy.get('#cross_section_svg_y path', { timeout: 30000 }).should('have.length.gt', 0);
    });
});
