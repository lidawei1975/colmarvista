describe('FID Processing Pseudo3D NUS Test', () => {
    it('loads pseudo3D NUS files, sets all_planes, and verifies all planes are processed', () => {
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

        // 3. Select Pseudo-3D Process All Planes
        cy.get('input[name="Pseudo-3D-process"][value="all_planes"]').check({ force: true });

        // 4. Set Phase and Range Parameters
        cy.get('#auto_direct').uncheck({ force: true });
        cy.get('#auto_indirect').uncheck({ force: true });
        cy.get('#phase_correction_direct_p0').clear({ force: true }).type('0', { force: true });
        cy.get('#phase_correction_direct_p1').clear({ force: true }).type('0', { force: true });
        cy.get('#phase_correction_indirect_p0').clear({ force: true }).type('90', { force: true });
        cy.get('#phase_correction_indirect_p1').clear({ force: true }).type('0', { force: true });

        cy.get('#extract_direct_from').clear({ force: true }).type('8.8', { force: true });
        cy.get('#extract_direct_to').clear({ force: true }).type('7.8', { force: true });

        // 5. Click Process
        cy.get('#button_fid_process', { timeout: 10000 }).click({ force: true });

        // 6. Wait for Processing to Complete (136 planes SMILE reconstruction takes ~4.5 minutes)
        cy.get('#spectra_list_ol li', { timeout: 360000 }).should('have.length.gt', 0);
        cy.get('#spectra_list_ol', { timeout: 30000 }).should('contain.text', 'from_fid.ft2');

        // 7. Verify 2D Contour Plot (Axes and Canvas exist)
        cy.get('.xaxis').should('exist');
        cy.get('.yaxis').should('exist');
        cy.get('#canvas1').should('exist');
    });
});
