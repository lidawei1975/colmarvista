describe('Check spectrum card height and styling', () => {
    it('inspects spectrum-0 and spectrum-5 heights and DOM order', () => {
        cy.visit('/index.html');

        cy.get('#fid_file', { timeout: 10000 })
            .selectFile('cypress/fixtures/test_data_pseudo3d/ser', { force: true });
        cy.get('#acquisition_file', { timeout: 10000 })
            .selectFile('cypress/fixtures/test_data_pseudo3d/acqus', { force: true });
        cy.get('#acquisition_file2', { timeout: 10000 })
            .selectFile('cypress/fixtures/test_data_pseudo3d/acqu2s', { force: true });
        cy.get('#acquisition_file3', { timeout: 10000 })
            .selectFile('cypress/fixtures/test_data_pseudo3d/acqu3s', { force: true });

        cy.get('input[name="Pseudo-3D-process"][value="all_planes"]').check({ force: true });
        cy.get('#button_fid_process', { timeout: 10000 }).click({ force: true });

        cy.get('#spectrum-0', { timeout: 60000 }).should('exist');
        cy.get('#spectrum-5', { timeout: 60000 }).should('exist');

        cy.get('#spectra_list_ol > li').then(($lis) => {
            const ids = $lis.toArray().map(li => li.id);
            cy.task('log', `DOM ORDER OF SPECTRA: ${JSON.stringify(ids)}`);
        });

        cy.get('#minimize-0').click();

        cy.get('#spectrum-0 div').first().then(($div0) => {
            const h0 = $div0.height();
            const cssHeight0 = $div0.css('height');
            const cssOverflow0 = $div0.css('overflow');
            cy.task('log', `Spectrum 0 (manually collapsed): height=${h0}, cssHeight=${cssHeight0}, cssOverflow=${cssOverflow0}`);
        });

        cy.get('#spectrum-5 div').first().then(($div5) => {
            const h5 = $div5.height();
            const cssHeight5 = $div5.css('height');
            const cssOverflow5 = $div5.css('overflow');
            cy.task('log', `Spectrum 5 (initial state): height=${h5}, cssHeight=${cssHeight5}, cssOverflow=${cssOverflow5}`);
        });

        cy.get('#spectrum-5').then(($li5) => {
            const liHeight = $li5.height();
            cy.task('log', `Spectrum 5 li height=${liHeight}`);
            cy.task('log', `Spectrum 5 outer HTML: ${$li5.prop('outerHTML')}`);
        });
    });
});

