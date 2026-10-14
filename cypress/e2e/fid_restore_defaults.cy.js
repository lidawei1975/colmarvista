describe('Restore FID processing parameters to default on new processing', () => {
    it('restores defaults except for apodization, zero filling, and negative imaginary data', () => {
        cy.visit('/index.html');

        // 1. Customize parameters prior to first processing
        const customApodDirect = 'SP off 0.4 end 0.95 pow 2 elb 0 c 0.5';
        const customApodIndirect = 'SP off 0.45 end 0.96 pow 2 elb 0 c 0.5';

        cy.get('#apodization_direct').clear({ force: true }).type(customApodDirect, { force: true });
        cy.get('#zf_direct').select('4', { force: true });
        cy.get('#apodization_indirect').clear({ force: true }).type(customApodIndirect, { force: true });
        cy.get('#zf_indirect').select('4', { force: true });
        cy.get('#neg_imaginary').check({ force: true });

        // Set non-default values for parameters that SHOULD be restored later
        cy.get('#water_suppression').check({ force: true });
        cy.get('#delete_imaginary').check({ force: true });
        cy.get('#extract_direct_from').clear({ force: true }).type('12.5', { force: true });
        cy.get('#extract_direct_to').clear({ force: true }).type('0.5', { force: true });
        cy.get('#phase_correction_direct_p0').clear({ force: true }).type('33', { force: true });
        cy.get('#phase_correction_direct_p1').clear({ force: true }).type('12', { force: true });
        cy.get('#auto_direct').uncheck({ force: true });
        cy.get('#ann_auto_direct').uncheck({ force: true });
        cy.get('#all_planes').check({ force: true });

        // 2. Upload Bruker files and process first spectrum
        cy.get('#fid_file').selectFile('cypress/fixtures/test_data_2d/ser', { force: true });
        cy.get('#acquisition_file').selectFile('cypress/fixtures/test_data_2d/acqus', { force: true });
        cy.get('#acquisition_file2').selectFile('cypress/fixtures/test_data_2d/acqu2s', { force: true });

        cy.get('#button_fid_process').click({ force: true });

        // Wait for first processing to complete
        cy.get('#spectra_list_ol li', { timeout: 60000 }).should('have.length.gt', 0);
        cy.get('#webassembly_message', { timeout: 30000 }).should('have.text', '');

        // Verify that right after processing, phases are visible in the form (-90 when neg_imaginary is checked)
        cy.get('#phase_correction_indirect_p0').should('have.value', '-90');

        // 3. Select new files to initiate a NEW FID processing
        cy.get('#fid_file').selectFile('cypress/fixtures/test_data_2d/ser', { force: true });
        cy.get('#acquisition_file').selectFile('cypress/fixtures/test_data_2d/acqus', { force: true });
        cy.get('#acquisition_file2').selectFile('cypress/fixtures/test_data_2d/acqu2s', { force: true });

        // 4. Verify that parameters ARE restored to default EXCEPT apodization, zero filling, and negative imaginary
        // Preserved:
        cy.get('#apodization_direct').should('have.value', customApodDirect);
        cy.get('#zf_direct').should('have.value', '4');
        cy.get('#apodization_indirect').should('have.value', customApodIndirect);
        cy.get('#zf_indirect').should('have.value', '4');
        cy.get('#neg_imaginary').should('be.checked');

        // Restored to defaults:
        cy.get('#water_suppression').should('not.be.checked');
        cy.get('#delete_imaginary').should('not.be.checked');
        cy.get('#extract_direct_from').should('have.value', '1000');
        cy.get('#extract_direct_to').should('have.value', '-1000');
        cy.get('#phase_correction_direct_p0').should('have.value', '0');
        cy.get('#phase_correction_direct_p1').should('have.value', '0');
        cy.get('#auto_direct').should('be.checked');
        cy.get('#ann_auto_direct').should('be.checked');
        cy.get('#phase_correction_indirect_p0').should('have.value', '0');
        cy.get('#phase_correction_indirect_p1').should('have.value', '0');
        cy.get('#auto_indirect').should('be.checked');
        cy.get('#delete_imaginary_indirect').should('not.be.checked');
        cy.get('#first_only').should('be.checked');
        cy.get('#all_planes').should('not.be.checked');

        // 5. Test "Edit FID processing" mode and quitting it
        cy.get('.button_edit_fid').first().click();
        cy.get('.button_edit_fid').first().should('contain.text', 'Quit');

        // Modify water_suppression during edit
        cy.get('#water_suppression').check({ force: true });
        cy.get('#water_suppression').should('be.checked');

        // Quit edit
        cy.get('.button_edit_fid').first().click();
        cy.get('.button_edit_fid').first().should('have.text', 'Edit FID processing');

        // Defaults should be restored while keeping apodization, zero filling, and negative imaginary
        cy.get('#water_suppression').should('not.be.checked');
        cy.get('#apodization_direct').should('have.value', customApodDirect);
        cy.get('#zf_direct').should('have.value', '4');
        cy.get('#apodization_indirect').should('have.value', customApodIndirect);
        cy.get('#zf_indirect').should('have.value', '4');
        cy.get('#neg_imaginary').should('be.checked');
    });
});

