describe('3D Spectrum Information Section Test', () => {
    it('verifies 3D Spectrum Information section exists above Standard Orthogonal Views and correctly displays Nuclear, Hz, and PPM Range', () => {
        cy.visit('/index_3d.html');

        // 1. Verify that container_spectrum_info exists inside main_plot_area
        cy.get('#main_plot_area').should('exist');
        cy.get('#container_spectrum_info').should('exist');
        cy.get('#container_original_views').should('exist');

        // 2. Verify section positioning: container_spectrum_info is immediately above container_original_views
        cy.get('#main_plot_area').children().then(($children) => {
            const specInfoIndex = $children.index($children.filter('#container_spectrum_info'));
            const origViewsIndex = $children.index($children.filter('#container_original_views'));
            expect(specInfoIndex).to.be.greaterThan(-1);
            expect(origViewsIndex).to.be.greaterThan(specInfoIndex);
        });

        // 3. Verify section title and headers
        cy.get('#container_spectrum_info h2').should('contain.text', '3D Spectrum Information');
        cy.get('#container_spectrum_info h4').should('contain.text', '1. Nuclear, Hz and PPM Range of Each Dimension');

        // 4. Verify table headers (10 headers including Shift Calibration and 2nd Parallel Axis)
        cy.get('#table_spectrum_info_3d th').should('have.length', 10);
        cy.get('#table_spectrum_info_3d th').eq(0).should('contain.text', 'Dimension');
        cy.get('#table_spectrum_info_3d th').eq(1).should('contain.text', 'Axis');
        cy.get('#table_spectrum_info_3d th').eq(2).should('contain.text', 'Nuclear (Nucleus)');
        cy.get('#table_spectrum_info_3d th').eq(3).should('contain.text', 'Spectral Width (Hz)');
        cy.get('#table_spectrum_info_3d th').eq(4).should('contain.text', 'Spectrometer Freq (MHz)');
        cy.get('#table_spectrum_info_3d th').eq(5).should('contain.text', 'PPM Range');
        cy.get('#table_spectrum_info_3d th').eq(6).should('contain.text', 'Hz Range');
        cy.get('#table_spectrum_info_3d th').eq(7).should('contain.text', 'Points');
        cy.get('#table_spectrum_info_3d th').eq(8).should('contain.text', 'Shift Calibration');
        cy.get('#table_spectrum_info_3d th').eq(9).should('contain.text', '2nd Parallel Axis');

        // 5. Test dynamic update with simulated 3D spectrum metadata
        cy.window().then((win) => {
            win.last_fid_nuclei = {
                x: '1H',
                y: '15N',
                z: '13C'
            };

            const mockPlane = {
                n_direct: 1024,
                x_ppm_start: 11.712,
                x_ppm_step: -0.013675,
                x_ppm_width: 14.003,
                frq1: 850.164,
                sw1: 11904.76,

                n_indirect: 128,
                y_ppm_start: 135.154,
                y_ppm_step: -0.27345,
                y_ppm_width: 35.002,
                frq2: 86.156,
                sw2: 2067.82,

                n_indirect2: 32,
                z_ppm_start: 175.845,
                z_ppm_step: -0.41945,
                z_ppm_width: 13.003,
                frq3: 213.810,
                sw3: 2779.32
            };

            win.spectra_3d = new Array(32).fill(mockPlane);

            // Trigger update
            win.update_3d_spectrum_info();
        });

        // 6. Verify populated values in the table
        // Direct Dimension (x)
        cy.get('#spec_info_nuc_x').should('contain.text', '1H');
        cy.get('#spec_info_sw_hz_x').should('contain.text', '11,904.76 Hz');
        cy.get('#spec_info_frq_x').should('contain.text', '850.164 MHz');
        cy.get('#spec_info_ppm_range_x').should('contain.text', '11.712').and('contain.text', 'ppm');
        cy.get('#spec_info_hz_range_x').should('contain.text', 'Hz').and('contain.text', 'SW: 11,904.8 Hz');
        cy.get('#spec_info_points_x').should('contain.text', '1,024');

        // Indirect Dimension 1 (y)
        cy.get('#spec_info_nuc_y').should('contain.text', '15N');
        cy.get('#spec_info_sw_hz_y').should('contain.text', '2,067.82 Hz');
        cy.get('#spec_info_frq_y').should('contain.text', '86.156 MHz');
        cy.get('#spec_info_ppm_range_y').should('contain.text', '135.154').and('contain.text', 'ppm');
        cy.get('#spec_info_hz_range_y').should('contain.text', 'Hz').and('contain.text', 'SW: 2,067.8 Hz');
        cy.get('#spec_info_points_y').should('contain.text', '128');

        // Indirect Dimension 2 / Planes (z)
        cy.get('#spec_info_nuc_z').should('contain.text', '13C');
        cy.get('#spec_info_sw_hz_z').should('contain.text', '2,779.32 Hz');
        cy.get('#spec_info_frq_z').should('contain.text', '213.810 MHz');
        cy.get('#spec_info_ppm_range_z').should('contain.text', '175.845').and('contain.text', 'ppm');
        cy.get('#spec_info_hz_range_z').should('contain.text', 'Hz').and('contain.text', 'SW: 2,779.3 Hz');
        cy.get('#spec_info_points_z').should('contain.text', '32');

        // 7. Test Secondary Axis Modal and Configuration for Indirect 1 (y)
        cy.get('#btn_open_sec_axis_y').click();
        cy.get('#modal_secondary_axis').should('be.visible');
        cy.get('#sec_axis_modal_title').should('contain.text', 'Indirect 1 (y)');
        cy.get('#sec_axis_nuclear').clear().type('13CO');
        cy.get('#sec_axis_start_ppm').clear().type('185.0');
        cy.get('#sec_axis_end_ppm').clear().type('165.0');
        cy.get('#sec_axis_preview_box').should('contain.text', '13CO');

        // Click Apply 2nd Axis
        cy.contains('button', 'Apply 2nd Axis').click();
        cy.get('#modal_secondary_axis').should('not.be.visible');

        // Verify sub-row for y is now visible and populated
        cy.get('#row_dim_y_sec').should('be.visible');
        cy.get('#spec_info_nuc_y_sec').should('contain.text', '13CO');
        cy.get('#spec_info_ppm_range_y_sec').should('contain.text', '185.000 to 165.000 ppm');
        cy.get('#btn_open_sec_axis_y').should('contain.text', 'Edit (13CO)');

        // 8. Test Reset State
        cy.window().then((win) => {
            win.reset_3d_dataset_state();
        });
        cy.get('#spec_info_nuc_x').should('contain.text', '-');
        cy.get('#spec_info_sw_hz_x').should('contain.text', '-');
        cy.get('#spec_info_ppm_range_x').should('contain.text', '-');
        cy.get('#spec_info_points_x').should('contain.text', '-');
        cy.get('#row_dim_y_sec').should('not.be.visible');
        cy.get('#btn_open_sec_axis_y').should('contain.text', '+ 2nd Axis');
    });
});

