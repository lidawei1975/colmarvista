describe('3D Model 04 Equivariance Auto-Phase Tests', () => {
    beforeEach(() => {
        cy.visit('/index_3d.html');
    });

    it('verifies NUS3DPhasePipeline is defined and exposes Model 04 methods', () => {
        cy.window().then((win) => {
            expect(win.NUS3DPhasePipeline, 'NUS3DPhasePipeline').to.exist;
            expect(win.NUS3DPhasePipeline.loadModel, 'loadModel').to.be.a('function');
            expect(win.NUS3DPhasePipeline.runFromFt3, 'runFromFt3').to.be.a('function');
            expect(win.NUS3DPhasePipeline.weightedRansacFit, 'weightedRansacFit').to.be.a('function');
            expect(win.NUS3DPhasePipeline.extractSignalTokensModel04, 'extractSignalTokensModel04').to.be.a('function');
        });
    });

    it('loads Model 04 TFJS GraphModel and runs inference on test cube batch', () => {
        cy.window().then(async (win) => {
            const tf = win.tf;
            expect(tf, 'TensorFlow.js').to.exist;

            const model = await win.NUS3DPhasePipeline.loadModel(tf, 'js/model04_tfjs/model.json');
            expect(model, 'loaded GraphModel').to.exist;

            // Create batch of 3 test cubes: [3, 16, 16, 128, 2]
            const batchSize = 3;
            const dummyData = new Float32Array(batchSize * 16 * 16 * 128 * 2);
            for (let i = 0; i < dummyData.length; i++) {
                dummyData[i] = (Math.random() - 0.5) * 0.1;
            }
            const inputTensor = tf.tensor(dummyData, [batchSize, 16, 16, 128, 2], 'float32');
            const predTensor = model.execute(inputTensor);

            expect(predTensor.shape).to.deep.equal([batchSize, 2]);
            const preds = await predTensor.array();

            for (let b = 0; b < batchSize; b++) {
                const phiDeg = preds[b][0];
                const stdDeg = preds[b][1];
                expect(Number.isFinite(phiDeg), `batch ${b} phi finite`).to.be.true;
                expect(Number.isFinite(stdDeg), `batch ${b} std finite`).to.be.true;
                expect(stdDeg, `batch ${b} std positive`).to.be.greaterThan(0);
            }

            inputTensor.dispose();
            predTensor.dispose();
        });
    });

    it('verifies revised W-RANSAC accommodates negative peaks and computes correct P0/P1', () => {
        cy.window().then((win) => {
            const wransac = win.NUS3DPhasePipeline.weightedRansacFit;

            // Generate synthetic line: P0 = 35.0 deg, P1 = -50.0 deg
            // x_norm in [-1, +1]
            const trueP0 = 35.0;
            const trueP1 = -50.0;
            const N = 10;
            const xCoords = new Float64Array(N);
            const yPhases = new Float64Array(N);
            const weights = new Float64Array(N);

            for (let i = 0; i < N; i++) {
                const x = -0.8 + (1.6 * i) / (N - 1);
                xCoords[i] = x;
                let phi = trueP0 + trueP1 * x;

                // Make token 3 and 7 negative peaks (pi / 180° shift from NN)
                if (i === 3 || i === 7) {
                    phi += 180.0;
                }

                // Wrap into [-180, 180]
                phi = ((phi + 180.0) % 360.0);
                if (phi < 0) phi += 360.0;
                phi -= 180.0;

                yPhases[i] = phi;
                weights[i] = 1.0;
            }

            const res = wransac(xCoords, yPhases, weights, {
                cutoffDeg: 5.0,
                nIter: 1000,
                nPiMax: 4
            });

            expect(res.p0, 'estimated P0').to.be.closeTo(trueP0, 2.0);
            expect(res.p1, 'estimated P1').to.be.closeTo(trueP1, 2.0);
            expect(res.numInliers, 'num inliers').to.be.at.least(8);
        });
    });
});

