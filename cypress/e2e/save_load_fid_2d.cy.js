describe('2D Session Save and Load with Raw FID Data', () => {
    it('saves session with FID data, reloads it, and reprocesses', () => {
        cy.visit('/index.html');

        // Check save_fid_data checkbox exists and has tooltip
        cy.get('#save_fid_data').should('exist').and('not.be.checked');
        cy.get('#save_fid_data').should('have.attr', 'title');

        // Upload Bruker test files
        cy.get('#fid_file').selectFile('cypress/fixtures/test_data_2d/ser', { force: true });
        cy.get('#acquisition_file').selectFile('cypress/fixtures/test_data_2d/acqus', { force: true });
        cy.get('#acquisition_file2').selectFile('cypress/fixtures/test_data_2d/acqu2s', { force: true });

        // Set phase correction parameters
        cy.get('#auto_direct').check({ force: true });
        cy.get('#ann_auto_direct').check({ force: true });
        cy.get('#auto_indirect').check({ force: true });

        // Click Process
        cy.get('#button_fid_process').click({ force: true });

        // Wait for processing to complete
        cy.get('#spectra_list_ol li', { timeout: 60000 }).should('have.length.gt', 0);
        cy.get('#webassembly_message', { timeout: 30000 }).should('have.text', '');

        // Verify initial spectrum has origin -2 and raw file_data
        cy.window().then((win) => {
            const spec = win.hsqc_spectra[0];
            expect(spec.spectrum_origin).to.equal(-2);
            expect(spec.fid_process_parameters).to.exist;
            expect(spec.fid_process_parameters.file_data).to.have.length(3);

            // Test copy without FID data
            const copyNoFid = spec.create_shallow_copy_wo_float32(false);
            expect(copyNoFid.spectrum_origin).to.equal(-1);
            expect(copyNoFid.fid_file_lengths).to.be.undefined;
            expect(copyNoFid.fid_process_parameters.file_data).to.be.undefined;

            // Test copy with FID data
            const copyWithFid = spec.create_shallow_copy_wo_float32(true);
            expect(copyWithFid.spectrum_origin).to.equal(-2);
            expect(copyWithFid.fid_file_lengths).to.have.length(3);
            expect(copyWithFid.fid_file_lengths[0]).to.be.gt(0);
            expect(copyWithFid.fid_file_lengths[1]).to.be.gt(0);
            expect(copyWithFid.fid_file_lengths[2]).to.be.gt(0);
        });

        // Now test full binary serialization & reload with FID data
        cy.get('#save_fid_data').check({ force: true });

        let savedBuffer = null;
        cy.window().then((win) => {
            // Spy on URL.createObjectURL to grab the binary Blob
            cy.stub(win.URL, 'createObjectURL').callsFake((blob) => {
                return blob.arrayBuffer().then((buf) => {
                    savedBuffer = buf;
                    return 'blob:mock-url';
                });
            });

            // Trigger save_to_file
            win.save_to_file();
        });

        // Wait until savedBuffer is captured
        cy.wrap(null).should(() => {
            expect(savedBuffer).to.not.be.null;
            expect(savedBuffer.byteLength).to.be.gt(10000);
        });

        // Now reload the saved buffer into the application
        cy.window().then((win) => {
            return win.loadBinaryAndJsonWithLength(savedBuffer);
        });

        // Wait for reloaded spectrum to be added to list
        cy.get('#spectra_list_ol li', { timeout: 30000 }).should('have.length.gt', 0);

        // Verify the reloaded spectrum preserved FID data and spectrum_origin = -2
        cy.window().then((win) => {
            const reloaded = win.hsqc_spectra[0];
            expect(reloaded.spectrum_origin).to.equal(-2);
            expect(reloaded.fid_process_parameters).to.exist;
            expect(reloaded.fid_process_parameters.file_data).to.have.length(3);
            expect(reloaded.fid_process_parameters.file_data[0]).to.be.instanceOf(win.Uint8Array);
            expect(reloaded.fid_process_parameters.file_data[0].length).to.be.gt(0);
        });

        // Verify "Edit FID processing" button exists on the reloaded spectrum
        cy.get('#spectra_list_ol li').first().find('button').contains('Edit FID processing').should('exist');

        // Click "Edit FID processing"
        cy.get('#spectra_list_ol li').first().find('button').contains('Edit FID processing').click({ force: true });

        // Button should switch to "Reprocess" and form options should be visible
        cy.get('#button_fid_process').should('have.value', 'Reprocess');

        // Adjust a parameter and click Reprocess
        cy.get('#ann_auto_direct').check({ force: true });
        cy.get('#button_fid_process').click({ force: true });

        // Wait for reprocessing to finish
        cy.get('#webassembly_message', { timeout: 30000 }).should('have.text', '');
        cy.get('#spectra_list_ol li').should('have.length', 1);

        // Verify the reprocessed spectrum still has valid data
        cy.window().then((win) => {
            const spec = win.hsqc_spectra[0];
            expect(spec.spectrum_origin).to.equal(-2);
            expect(spec.raw_data).to.exist;
            expect(spec.raw_data.length).to.be.gt(0);
        });
    });
});

