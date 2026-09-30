describe('Pseudo3D Process First Only then Reprocess All Planes', () => {
    it('processes 1st plane only, then reprocesses to all planes, verifying all 6 spectra appear with 6th plane collapsed', () => {
        cy.visit('/index.html');

        // 1. Upload all 4 files for pseudo 3D
        cy.get('#fid_file', { timeout: 10000 })
            .selectFile('cypress/fixtures/test_data_pseudo3d/ser', { force: true });
        cy.get('#acquisition_file', { timeout: 10000 })
            .selectFile('cypress/fixtures/test_data_pseudo3d/acqus', { force: true });
        cy.get('#acquisition_file2', { timeout: 10000 })
            .selectFile('cypress/fixtures/test_data_pseudo3d/acqu2s', { force: true });
        cy.get('#acquisition_file3', { timeout: 10000 })
            .selectFile('cypress/fixtures/test_data_pseudo3d/acqu3s', { force: true });

        // 2. Process First Plane Only
        cy.get('input[name="Pseudo-3D-process"][value="first_only"]').check({ force: true });
        cy.get('#button_fid_process', { timeout: 10000 }).click({ force: true });

        // 3. Verify only spectrum 0 appears
        cy.get('#spectrum-0', { timeout: 60000 }).should('exist');
        cy.get('#spectrum-1').should('not.exist');

        // 4. Click Reprocess on spectrum 0
        cy.get('#spectrum-0').contains('button', 'Reprocess').click();

        // 5. Select Process All Planes
        cy.get('input[name="Pseudo-3D-process"][value="all_planes"]').check({ force: true });

        // 6. Click Reprocess button
        cy.get('#button_fid_process', { timeout: 10000 }).click({ force: true });

        // 7. Verify all 6 spectra appear in the list (0 through 5)
        cy.get('#spectrum-0', { timeout: 60000 }).should('exist');
        cy.get('#spectrum-1', { timeout: 60000 }).should('exist');
        cy.get('#spectrum-2', { timeout: 60000 }).should('exist');
        cy.get('#spectrum-3', { timeout: 60000 }).should('exist');
        cy.get('#spectrum-4', { timeout: 60000 }).should('exist');
        cy.get('#spectrum-5', { timeout: 60000 }).should('exist');

        // Verify order in spectra_list_ol
        cy.get('#spectra_list_ol > li').then(($lis) => {
            const ids = $lis.toArray().map(li => li.id);
            expect(ids).to.deep.equal([
                'spectrum-0',
                'spectrum-1',
                'spectrum-2',
                'spectrum-3',
                'spectrum-4',
                'spectrum-5'
            ]);
        });

        // 8. Verify spectrum 5 is default collapsed
        cy.get('#minimize-5').should('have.text', '+');

        // 9. Verify spectrum 5 state in hsqc_spectra
        cy.window().then((win) => {
            expect(win.hsqc_spectra).to.exist;
            expect(win.hsqc_spectra.length).to.equal(6);
            expect(win.hsqc_spectra[5].visible).to.be.false;
            expect(win.hsqc_spectra[5].contour_calculated).to.be.false;
            expect(win.hsqc_spectra[5].default_collapsed).to.be.true;
        });

        // 10. Uncollapse spectrum 5 and verify contour calculation
        cy.get('#minimize-5').click();
        cy.get('#minimize-5').should('have.text', '-');

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

