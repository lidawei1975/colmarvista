describe('Reprocess Memory Leak Test', () => {
    it('measures memory across multiple reprocessing cycles', () => {
        cy.visit('/index.html');

        // 1. Upload initial files
        cy.get('#fid_file', { timeout: 10000 }).selectFile('cypress/fixtures/test_data_2d/ser', { force: true });
        cy.get('#acquisition_file', { timeout: 10000 }).selectFile('cypress/fixtures/test_data_2d/acqus', { force: true });
        cy.get('#acquisition_file2', { timeout: 10000 }).selectFile('cypress/fixtures/test_data_2d/acqu2s', { force: true });

        // Check auto direct and ANN auto direct (default behavior in index.html)
        cy.get('#auto_direct').check({ force: true });
        cy.get('#ann_auto_direct').check({ force: true });
        cy.get('#auto_indirect').check({ force: true });

        // Click Process
        cy.get('#button_fid_process', { timeout: 10000 }).click({ force: true });

        // Wait for initial processing to complete
        cy.get('#spectra_list_ol li', { timeout: 60000 }).should('have.length.gt', 0);
        cy.get('#webassembly_message', { timeout: 30000 }).should('have.text', '');

        // Now record initial memory and reprocess multiple times
        const memoryStats = [];

        const measureMemory = (label) => {
            return cy.window().then((win) => {
                let jsHeap = null;
                if (win.performance && win.performance.memory) {
                    jsHeap = {
                        usedJSHeapSize: Math.round(win.performance.memory.usedJSHeapSize / 1024 / 1024 * 100) / 100,
                        totalJSHeapSize: Math.round(win.performance.memory.totalJSHeapSize / 1024 / 1024 * 100) / 100,
                    };
                }
                let tfMemory = null;
                if (win.tf) {
                    tfMemory = win.tf.memory();
                }
                const stat = {
                    label: label,
                    jsHeap: jsHeap,
                    tfMemory: tfMemory,
                    spectraCount: win.hsqc_spectra ? win.hsqc_spectra.length : 0,
                    mainPlotPointsLength: win.main_plot && win.main_plot.points ? win.main_plot.points.length : 0,
                    mainPlotLevelsLength: win.main_plot && win.main_plot.levels_length ? win.main_plot.levels_length.length : 0,
                    mainPlotPolygonLength: win.main_plot && win.main_plot.polygon_length ? win.main_plot.polygon_length.length : 0,
                };
                memoryStats.push(stat);
                cy.task('log', JSON.stringify(stat));
            });
        };

        measureMemory('initial_processing');

        // Click Reprocess on the spectrum list item once to enter reprocess mode
        cy.get('#spectra_list_ol li').first().find('button').contains('Reprocess').click({ force: true });
        cy.get('#button_fid_process').should('have.value', 'Reprocess');

        // Reprocess 3 times with ANN re-enabled
        for (let i = 1; i <= 3; i++) {
            cy.get('#ann_auto_direct').check({ force: true });
            // Click the main Reprocess button
            cy.get('#button_fid_process').click({ force: true });

            // Wait for processing to complete
            cy.get('#webassembly_message', { timeout: 60000 }).should('contain.text', 'Processing time domain spectra');
            cy.get('#webassembly_message', { timeout: 60000 }).should('have.text', '');

            measureMemory(`reprocess_cycle_${i}`);
        }

        cy.then(() => {
            console.log('ALL STATS:', JSON.stringify(memoryStats, null, 2));

            // Verify spectrum validity
            const lastStat = memoryStats[memoryStats.length - 1];
            expect(lastStat.spectraCount).to.equal(1);
            expect(lastStat.mainPlotPointsLength).to.be.greaterThan(0);

            // Verify that heap memory does not continuously grow unboundedly between cycle 2 and 3
            if (memoryStats.length >= 4 && memoryStats[2].jsHeap && memoryStats[3].jsHeap) {
                const heapDiff = memoryStats[3].jsHeap.usedJSHeapSize - memoryStats[2].jsHeap.usedJSHeapSize;
                expect(heapDiff).to.be.lessThan(25); // MB
            }
        });
    });
});

