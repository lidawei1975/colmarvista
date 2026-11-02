describe('Multiple Frequency Domain Spectra Drag and Drop', () => {
    it('drags and drops multiple spectra files onto #file_area and processes all of them', () => {
        cy.visit('/index.html');

        const mockSpectrum1 = `# F1LEFT = 100.0 ppm. F1RIGHT = 0.0 ppm.
# F2LEFT = 10.0 ppm. F2RIGHT = 0.0 ppm.
# NROWS = 4
# NCOLS = 4
# row = 0
100
200
300
400
# row = 1
100
200
300
400
# row = 2
100
200
300
400
# row = 3
100
200
300
400`;

        const file1 = {
            contents: Cypress.Buffer.from(mockSpectrum1),
            fileName: 'spectrum_1.txt',
            mimeType: 'text/plain'
        };
        const file2 = {
            contents: Cypress.Buffer.from(mockSpectrum1),
            fileName: 'spectrum_2.txt',
            mimeType: 'text/plain'
        };

        // Drag and drop 2 spectral files simultaneously onto #file_area
        cy.get('#file_area').selectFile([file1, file2], { action: 'drag-drop' });

        // Verify #userfile input holds both dropped files
        cy.get('#userfile').should(($input) => {
            expect($input[0].files).to.have.length(2);
            expect($input[0].files[0].name).to.equal('spectrum_1.txt');
            expect($input[0].files[1].name).to.equal('spectrum_2.txt');
        });

        // Trigger processing
        cy.get('#button_ft2_process').click({ force: true });

        // Verify both spectra were parsed and stored in hsqc_spectra
        cy.window().should((win) => {
            expect(win.hsqc_spectra).to.be.an('array').with.lengthOf(2);
            expect(win.hsqc_spectra[0].filename).to.equal('spectrum_1.txt');
            expect(win.hsqc_spectra[1].filename).to.equal('spectrum_2.txt');
        });

        // Verify UI entries exist for both spectra
        cy.get('#spectrum-0').should('exist');
        cy.get('#spectrum-1').should('exist');
    });
});

