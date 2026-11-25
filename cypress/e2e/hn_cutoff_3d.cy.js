describe('3D HN Cutoff Axis Detection & Filtering', () => {
    beforeEach(() => {
        cy.visit('/index_3d.html');
    });

    function buildSyntheticCube(win, { nx, ny, nz, xStart, xStep, yStart, yStep, zStart, zStep, frq1, frq2, frq3, labels, fillVal = 1.0 }) {
        const totalBytes = 2048 + nz * ny * nx * 4;
        const master = new ArrayBuffer(totalBytes);
        const header = new Float32Array(master, 0, 512);
        header[1] = 1.0;
        header[2] = 2.0;
        header[9] = 3.0; // FDDIMCOUNT
        header[15] = nz; // FDF3SIZE
        header[99] = nx; // FDSIZE
        header[219] = ny; // FDSPECNUM
        header[24] = 2; // dimorder1
        header[25] = 1; // dimorder2
        header[26] = 3; // dimorder3
        header[55] = 1; // real
        header[56] = 1; // real
        header[51] = 1; // real
        header[119] = frq1;
        header[218] = frq2;
        header[10] = frq3;

        const writeLabel = (wordIdx, text) => {
            const bytes = new TextEncoder().encode(String(text || '').slice(0, 8));
            new Uint8Array(master, wordIdx * 4, 8).set(bytes);
        };
        writeLabel(16, labels.x);
        writeLabel(18, labels.y);
        writeLabel(20, labels.z);

        win.master_3d_buffer = master;
        win.last_fid_nuclei = { x: labels.x, y: labels.y, z: labels.z };
        win.spectra_3d = [];

        for (let z = 0; z < nz; z++) {
            const s = win.eval('new spectrum()');
            s.n_direct = nx;
            s.n_indirect = ny;
            s.n_indirect2 = nz;
            s.datatype_direct = 1;
            s.datatype_indirect = 1;
            s.datatype_indirect2 = 1;
            s.frq1 = frq1;
            s.frq2 = frq2;
            s.frq3 = frq3;
            s.x_ppm_start = xStart;
            s.x_ppm_step = xStep;
            s.x_ppm_width = Math.abs(nx * xStep);
            s.y_ppm_start = yStart;
            s.y_ppm_step = yStep;
            s.y_ppm_width = Math.abs(ny * yStep);
            s.z_ppm_start = zStart;
            s.z_ppm_step = zStep;
            s.z_ppm_width = Math.abs(nz * zStep);
            s.noise_level = 0.01;
            s.levels = [0.05, 0.1];
            s.header = new Float32Array(master, 0, 512);
            s.raw_data = new Float32Array(master, 2048 + z * ny * nx * 4, ny * nx);
            s.raw_data.fill(fillVal);
            win.spectra_3d.push(s);
        }
    }

    it('detects HN axis via HN label, direct dim fallback, skips when no 15N, and respects manual override', () => {
        cy.window().then((win) => {
            // Default UI state: checked and X/Y/Z options only (no 'auto' option)
            expect(optionVals).to.deep.equal(['x', 'y', 'z']);

            buildSyntheticCube(win, {
                nx: 12, ny: 4, nz: 12,
                xStart: 10.0, xStep: -1.0,
                yStart: 130.0, yStep: -10.0,
                zStart: 10.0, zStep: -1.0,
                frq1: 850.0, frq2: 86.0, frq3: 850.0,
                labels: { x: '1H', y: '15N', z: 'HN' }
            });
            let res = win.detect_hn_dimension_3d(win.spectra_3d[0]);
            expect(res.axis).to.equal('z');
            expect(res.reason).to.equal('hn_label');
            win.auto_configure_hn_cutoff_ui(win.spectra_3d[0]);
            expect(selectEl.value).to.equal('z');
            buildSyntheticCube(win, {
                nx: 12, ny: 12, nz: 4,
                xStart: 10.0, xStep: -1.0,
                yStart: 10.0, yStep: -1.0,
                zStart: 130.0, zStep: -10.0,
                frq1: 850.0, frq2: 850.0, frq3: 86.0,
                labels: { x: '1H', y: 'HN', z: '15N' }
            });
            res = win.detect_hn_dimension_3d(win.spectra_3d[0]);
            expect(res.axis).to.equal('y');
            expect(res.reason).to.equal('hn_label');

            // 3. 15N-NOESY without explicit HN label -> falls back to direct dimension (x)
            buildSyntheticCube(win, {
                nx: 12, ny: 12, nz: 4,
                xStart: 10.0, xStep: -1.0,
                yStart: 10.0, yStep: -1.0,
                zStart: 130.0, zStep: -10.0,
                frq1: 850.0, frq2: 850.0, frq3: 86.0,
                labels: { x: '1H', y: '1H', z: '15N' }
            });
            res = win.detect_hn_dimension_3d(win.spectra_3d[0]);
            expect(res.axis).to.equal('x');
            expect(res.reason).to.equal('direct_dim');

            // 4. 13C-NOESY (no 15N, only 13C) -> skips HN cutoff in Auto mode
            buildSyntheticCube(win, {
                nx: 12, ny: 4, nz: 12,
                xStart: 10.0, xStep: -1.0,
                yStart: 60.0, yStep: -10.0,
                zStart: 10.0, zStep: -1.0,
                frq1: 850.0, frq2: 213.8, frq3: 850.0,
                labels: { x: '1H', y: '13C', z: '1H' }
            });
            res = win.detect_hn_dimension_3d(win.spectra_3d[0]);
            expect(res.axis).to.be.null;
            expect(res.reason).to.equal('no_15n');

            // 5. Manual override still targets the chosen axis even without 15N
            res = win.resolve_hn_cutoff_axis_3d('y', win.spectra_3d[0]);
            expect(res.axis).to.equal('y');
            expect(res.reason).to.equal('manual');

            // 6. Frequency-ratio fallback when labels are blank and 15N is on X
            buildSyntheticCube(win, {
                nx: 4, ny: 12, nz: 12,
                xStart: 130.0, xStep: -10.0,
                yStart: 10.0, yStep: -1.0,
                zStart: 10.0, zStep: -1.0,
                frq1: 86.0, frq2: 850.0, frq3: 850.0,
                labels: { x: '', y: '', z: '' }
            });
            expect(win.get_3d_dim_nucleus_type('x', win.spectra_3d[0])).to.equal('15N');
            expect(win.get_3d_dim_nucleus_type('y', win.spectra_3d[0])).to.equal('1H');
            expect(win.get_3d_dim_nucleus_type('z', win.spectra_3d[0])).to.equal('1H');
        });
    });

    it('zeroes only the HN (Z) band in FT3 buffer while preserving indirect 1H (X) 4.5-5.5 ppm', () => {
        cy.window().then((win) => {
            const nx = 12, ny = 4, nz = 12;
            buildSyntheticCube(win, {
                nx, ny, nz,
                xStart: 10.0, xStep: -1.0, // x=5 is 5.0 ppm (indirect 1H)
                yStart: 130.0, yStep: -10.0,
                zStart: 10.0, zStep: -1.0, // z=5 is 5.0 ppm (HN direct)
                frq1: 850.0, frq2: 86.0, frq3: 850.0,
                labels: { x: '1H', y: '15N', z: 'HN' },
                fillVal: 2.5
            });

            let postedMsg = null;
            win.get_or_create_web_worker_3d = () => ({
                postMessage(msg) {
                    postedMsg = msg;
                }
            });

            win.auto_configure_hn_cutoff_ui(win.spectra_3d[0]);

                expect(postedMsg.hnCutoffEnabled).to.be.true;
                expect(postedMsg.hnCutoffAxis).to.equal('z');
                expect(win.last_3d_hn_cutoff.axis).to.equal('z');

                const floatView = new Float32Array(postedMsg.ft3Bytes.buffer, postedMsg.ft3Bytes.byteOffset, postedMsg.ft3Bytes.byteLength / 4);
                const idx = (z, y, x) => 512 + (z * ny + y) * nx + x;

                // z=5 (5.0 ppm HN) must be zeroed everywhere
                expect(floatView[idx(5, 1, 2)]).to.equal(0.0);
                expect(floatView[idx(5, 1, 5)]).to.equal(0.0);
                // z=4 (6.0 ppm) and z=6 (4.0 ppm) must NOT be zeroed, even at x=5 (5.0 ppm indirect 1H)!
                expect(floatView[idx(4, 1, 5)]).to.equal(2.5);
                expect(floatView[idx(6, 1, 5)]).to.equal(2.5);
                expect(floatView[idx(2, 1, 5)]).to.equal(2.5);
            });
        });
    });

    it('skips buffer zeroing for 13C-only 3D spectra in Auto mode and supports manual Y override', () => {
        cy.window().then((win) => {
            const nx = 12, ny = 12, nz = 4;
            buildSyntheticCube(win, {
                nx, ny, nz,
                xStart: 10.0, xStep: -1.0,
                yStart: 10.0, yStep: -1.0,
                zStart: 60.0, zStep: -10.0,
                frq1: 850.0, frq2: 850.0, frq3: 213.8,
                labels: { x: '1H', y: '1H', z: '13C' },
                fillVal: 3.0
            });

            let postedMsg = null;
            win.get_or_create_web_worker_3d = () => ({
                postMessage(msg) {
                    postedMsg = msg;
                }
            });

            // Auto-configure unchecks HN cutoff for 13C-only spectrum
            win.auto_configure_hn_cutoff_ui(win.spectra_3d[0]);
            expect(win.document.getElementById('check_hn_cutoff').checked).to.be.false;
                const idx = (z, y, x) => 512 + (z * ny + y) * nx + x;
                expect(floatView[idx(1, 5, 5)]).to.equal(3.0);

                // Manual Y override re-enables checkbox and zeroes only y in [4.5, 5.5]
                win.document.getElementById('check_hn_cutoff').checked = true;
                win.document.getElementById('select_hn_cutoff_dim').value = 'y';
                return win.run_peak_fit_3d_workflow();
                expect(postedMsg.hnCutoffAxis).to.equal('y');
                const floatView = new Float32Array(postedMsg.ft3Bytes.buffer, postedMsg.ft3Bytes.byteOffset, postedMsg.ft3Bytes.byteLength / 4);
                const idx = (z, y, x) => 512 + (z * ny + y) * nx + x;
                expect(floatView[idx(1, 5, 2)]).to.equal(0.0); // y=5 (5.0 ppm) zeroed
                expect(floatView[idx(1, 2, 5)]).to.equal(3.0); // y=2 (8.0 ppm), x=5 (5.0 ppm) preserved
            });
        });
    });

    it('filters peak list strings by the target axis (X, Y, or Z)', () => {
        cy.window().then((win) => {
            buildSyntheticCube(win, {
                nx: 12, ny: 4, nz: 12,
                xStart: 10.0, xStep: -1.0,
                yStart: 130.0, yStep: -10.0,
                zStart: 10.0, zStep: -1.0,
                frq1: 850.0, frq2: 86.0, frq3: 850.0,
                labels: { x: '1H', y: '15N', z: 'HN' }
            });

            const peakText = [
                'X_Center Y_Center Z_Center X_Center_ppm Y_Center_ppm Z_Center_ppm Height',
                '5.000 1.000 1.800 5.000 120.000 8.200 1000.0',
                '7.900 1.000 5.000 2.100 120.000 5.000 900.0',
                '7.500 2.000 1.500 2.500 110.000 8.500 800.0'
            ].join('\n');

            // Z axis filter removes peak 2 (Z=5.0), keeps peak 1 (X=5.0 H-alpha, Z=8.2 HN)
            const filteredZ = win.filter_peaks_string_by_hn_cutoff(peakText, 4.5, 5.5, 'z');
            expect(filteredZ).to.include('5.000 1.000 1.800');
            expect(filteredZ).to.not.include('7.900 1.000 5.000');
            expect(filteredZ).to.include('7.500 2.000 1.500');

            // X axis filter removes peak 1 (X=5.0), keeps peak 2 (X=2.1)
            const filteredX = win.filter_peaks_string_by_hn_cutoff(peakText, 4.5, 5.5, 'x');
            expect(filteredX).to.not.include('5.000 1.000 1.800');
            expect(filteredX).to.include('7.900 1.000 5.000');

            // Index-only fallback along Z
            const indexOnlyText = [
                'Peak Amplitude X_Center Y_Center Z_Center',
                '1 1000.0 5.000 1.000 1.800',
                '2 900.0 7.900 1.000 5.000'
            ].join('\n');
            const filteredIdxZ = win.filter_peaks_string_by_hn_cutoff(indexOnlyText, 4.5, 5.5, 'z');
            expect(filteredIdxZ).to.include('1 1000.0 5.000');
            expect(filteredIdxZ).to.not.include('2 900.0 7.900');
        });
    });
});

