describe('Pseudo3D Test Data and Deep Picker Test', () => {
    it('processes pseudo3D with 6 planes, verifies 6th plane is default collapsed without contour calculation, runs DP on 1st spectrum cleanly, and uncollapses 6th plane to trigger contour calculation', () => {
        cy.visit('/index.html');

        // 1. Upload all 4 files for pseudo 3D (ser, acqus, acqu2s, acqu3s)
        cy.get('#fid_file', { timeout: 10000 })
            .selectFile('cypress/fixtures/test_data_pseudo3d/ser', { force: true });
        cy.get('#acquisition_file', { timeout: 10000 })
            .selectFile('cypress/fixtures/test_data_pseudo3d/acqus', { force: true });
        cy.get('#acquisition_file2', { timeout: 10000 })
            .selectFile('cypress/fixtures/test_data_pseudo3d/acqu2s', { force: true });
        cy.get('#acquisition_file3', { timeout: 10000 })
            .selectFile('cypress/fixtures/test_data_pseudo3d/acqu3s', { force: true });

        // 2. Select All Planes
        cy.get('input[name="Pseudo-3D-process"][value="all_planes"]').check({ force: true });

        // 3. Process FID
        cy.get('#button_fid_process', { timeout: 10000 }).click({ force: true });

        // 4. Verify that spectrum 0 and spectrum 5 (6th spectrum) both appear in the list
        cy.get('#spectrum-0', { timeout: 60000 }).should('exist');
        cy.get('#spectrum-5', { timeout: 60000 }).should('exist');

        // Verify spectrum 5 is default collapsed
        cy.get('#minimize-5').should('have.text', '+');

        // Verify spectrum 5 state in hsqc_spectra
        cy.window().then((win) => {
            expect(win.hsqc_spectra).to.exist;
            expect(win.hsqc_spectra.length).to.equal(6);
            expect(win.hsqc_spectra[5].visible).to.be.false;
            expect(win.hsqc_spectra[5].contour_calculated).to.be.false;
            expect(win.hsqc_spectra[5].default_collapsed).to.be.true;
        });

        // 5. Run DEEP Picker on 1st spectrum (spectrum 0)
        cy.get('#run_deep_picker-0').click();

        // 6. Verify DEEP Picker completes and show_peaks-0 is checked without error
        cy.get('#show_peaks-0', { timeout: 40000 }).should('be.checked');

        // 7. Click minimize button on 6th spectrum to uncollapse it and trigger contour calculation
        cy.get('#minimize-5').click();
        cy.get('#minimize-5').should('have.text', '-');

        // 8. Verify contour calculation triggers and completes for spectrum 5
        cy.window().then((win) => {
            expect(win.hsqc_spectra[5].visible).to.be.true;
        });

        // Wait for contour calculation to complete on spectrum 5
        cy.window().then({ timeout: 40000 }, (win) => {
            return new Cypress.Promise((resolve) => {
                const interval = setInterval(() => {
                    if (win.hsqc_spectra[5].contour_calculated === true) {
                        clearInterval(interval);
                        resolve();
                    }
                }, 500);
            });
        });

        cy.window().then((win) => {
            expect(win.hsqc_spectra[5].contour_calculated).to.be.true;
            expect(win.main_plot.levels_length[5].length).to.be.greaterThan(0);
        });
    });
});

