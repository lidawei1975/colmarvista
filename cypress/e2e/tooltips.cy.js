/**
 * Every user-input control (button, input, select, textarea) on the 1D and 2D pages
 * must have a tooltip (title), either from the HTML / JS or from js/tooltips.js.
 */
const collect_missing = (win) => {
    const missing = [];
    win.document.querySelectorAll('button, input, select, textarea').forEach((el) => {
        if (el.type === 'hidden' || el.hidden) return;
        if (!el.getAttribute('title')) {
            missing.push(el.tagName.toLowerCase() + '#' + (el.id || '(no id)') + ' [' + (el.type || '') + '] ' + (el.innerText || el.value || '').trim().slice(0, 40));
        }
    });
    return missing;
};

describe('Tooltips on all user input controls', () => {
    it('1D page: all static controls have a tooltip', () => {
        cy.visit('/index_1d.html');
        cy.get('#button_fid_process');
        cy.window().then((win) => {
            const missing = collect_missing(win);
            cy.task('log', 'Missing tooltips 1D: ' + JSON.stringify(missing, null, 1));
            expect(missing, '1D controls without tooltip: ' + JSON.stringify(missing)).to.have.length(0);
        });
    });

    it('2D page: static controls and spectra list controls have a tooltip', () => {
        cy.visit('/index.html');
        cy.get('#button_fid_process');
        cy.window().then((win) => {
            const missing = collect_missing(win);
            cy.task('log', 'Missing tooltips 2D static: ' + JSON.stringify(missing, null, 1));
            expect(missing, '2D controls without tooltip: ' + JSON.stringify(missing)).to.have.length(0);
        });

        cy.get('#fid_file').selectFile('cypress/fixtures/test_data_2d/ser', { force: true });
        cy.get('#acquisition_file').selectFile('cypress/fixtures/test_data_2d/acqus', { force: true });
        cy.get('#acquisition_file2').selectFile('cypress/fixtures/test_data_2d/acqu2s', { force: true });
        cy.get('#button_fid_process').click({ force: true });
        cy.get('#spectra_list_ol li', { timeout: 60000 }).should('have.length.gt', 0);
        /** The tooltips are applied shortly after the list is built */
        cy.wait(500);
        cy.window().then((win) => {
            const missing = collect_missing(win);
            cy.task('log', 'Missing tooltips 2D dynamic: ' + JSON.stringify(missing, null, 1));
            expect(missing, 'controls without tooltip').to.have.length(0);
        });
    });
});

