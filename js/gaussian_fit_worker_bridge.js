(function (globalScope) {
    'use strict';

    function toFloatOr(value, fallback) {
        var parsed = parseFloat(value);
        return Number.isFinite(parsed) ? parsed : fallback;
    }

    function toIntOr(value, fallback) {
        var parsed = parseInt(value, 10);
        return Number.isFinite(parsed) ? parsed : fallback;
    }

    function pushAll(vec, arr) {
        for (var i = 0; i < arr.length; i++) {
            vec.push_back(arr[i]);
        }
    }

    function runRegionFit(ModuleApi, cfg) {
        var surface = Array.isArray(cfg.surface) ? cfg.surface : [];
        var xx = Array.isArray(cfg.x) ? cfg.x : [];
        var yy = Array.isArray(cfg.y) ? cfg.y : [];
        var aas = Array.isArray(cfg.amp) ? cfg.amp : [];
        var sx = Array.isArray(cfg.sigmax) ? cfg.sigmax : [];
        var sy = Array.isArray(cfg.sigmay) ? cfg.sigmay : [];
        var gx = Array.isArray(cfg.gammax) ? cfg.gammax : [];
        var gy = Array.isArray(cfg.gammay) ? cfg.gammay : [];
        var ori = Array.isArray(cfg.originalNdx) ? cfg.originalNdx : [];
        var cannotMove = Array.isArray(cfg.cannotMove) ? cfg.cannotMove : [];

        var nspect = toIntOr(cfg.nspectra, 0);
        if (nspect <= 0) {
            return { ok: false, reason: 'invalid_nspectra' };
        }

        var surfaceVec = new ModuleApi.VectorDouble();
        var xVec = new ModuleApi.VectorDouble();
        var yVec = new ModuleApi.VectorDouble();
        var aVec = new ModuleApi.VectorDouble();
        var sxVec = new ModuleApi.VectorDouble();
        var syVec = new ModuleApi.VectorDouble();
        var gxVec = new ModuleApi.VectorDouble();
        var gyVec = new ModuleApi.VectorDouble();
        var originalNdxVec = new ModuleApi.VectorInt();
        var cannotMoveVec = new ModuleApi.VectorInt();

        try {
            pushAll(surfaceVec, surface);
            pushAll(xVec, xx);
            pushAll(yVec, yy);
            pushAll(aVec, aas);
            pushAll(sxVec, sx);
            pushAll(syVec, sy);
            pushAll(gxVec, gx);
            pushAll(gyVec, gy);
            pushAll(originalNdxVec, ori);
            pushAll(cannotMoveVec, cannotMove);

            var fitter = new ModuleApi.gaussian_fit();
            try {
                var peakShape = toIntOr(cfg.peakShape, 1);
                var maxround = toIntOr(cfg.maxround, 20);
                var clusterId = toIntOr(cfg.clusterId, 0);
                fitter.set_everything_wasm(peakShape, maxround, clusterId);

                var okInit = fitter.init(
                    toIntOr(cfg.xstart, 0),
                    toIntOr(cfg.ystart, 0),
                    toIntOr(cfg.xdim, 0),
                    toIntOr(cfg.ydim, 0),
                    nspect,
                    surfaceVec,
                    xVec,
                    yVec,
                    aVec,
                    sxVec,
                    syVec,
                    gxVec,
                    gyVec,
                    originalNdxVec,
                    cannotMoveVec,
                    toFloatOr(cfg.medianWidthX, 3.0),
                    toFloatOr(cfg.medianWidthY, 3.0)
                );

                if (!okInit) {
                    return { ok: false, reason: 'init_failed' };
                }

                var paras = cfg.peakParas || {};
                fitter.set_peak_paras(
                    toFloatOr(paras.wx, 6.0),
                    toFloatOr(paras.wy, 6.0),
                    toFloatOr(paras.noise, 1.0),
                    toFloatOr(paras.minHeight, 3.0),
                    toFloatOr(paras.tooNearCutoff, 0.2),
                    toFloatOr(paras.xppmStep, 1.0),
                    toFloatOr(paras.yppmStep, 1.0),
                    toFloatOr(paras.removalCutoff, 0.1)
                );

                fitter.peak_sign = (toIntOr(cfg.peakSign, 1) === -1) ? -1 : 1;

                if (!fitter.run(1)) {
                    return { ok: false, reason: 'run_failed' };
                }

                var peaks = [];
                var nround = fitter.get_nround();
                for (var i = 0; i < fitter.npeak; i++) {
                    var sx0 = fitter.sigmax.get(i);
                    var sy0 = fitter.sigmay.get(i);
                    var gx0 = fitter.gammax.get(i);
                    var gy0 = fitter.gammay.get(i);

                    var ampRow = [];
                    for (var k = 0; k < nspect; k++) {
                        ampRow.push(fitter.amp.get(i * nspect + k));
                    }

                    var hv = PeakShapeUtils.convertAmpToHeightVolume(
                        ampRow.length > 0 ? ampRow[0] : 0.0,
                        sx0,
                        sy0,
                        gx0,
                        gy0,
                        peakShape
                    );

                    peaks.push({
                        originalNdx: fitter.original_ndx.get(i),
                        xAxis1: fitter.x.get(i) + fitter.xstart + 1.0,
                        yAxis1: fitter.y.get(i) + fitter.ystart + 1.0,
                        xAxis0: fitter.x.get(i) + fitter.xstart,
                        yAxis0: fitter.y.get(i) + fitter.ystart,
                        height: hv.height,
                        volume: hv.volume,
                        ampRow: ampRow,
                        dheight: fitter.err.get(i),
                        sigmax: sx0,
                        sigmay: sy0,
                        gammax: gx0,
                        gammay: gy0,
                        nround: nround,
                        clusterId: clusterId
                    });
                }

                return {
                    ok: true,
                    nround: nround,
                    peaks: peaks
                };
            }
            finally {
                fitter.delete();
            }
        }
        finally {
            surfaceVec.delete();
            xVec.delete();
            yVec.delete();
            aVec.delete();
            sxVec.delete();
            syVec.delete();
            gxVec.delete();
            gyVec.delete();
            originalNdxVec.delete();
            cannotMoveVec.delete();
        }
    }

    globalScope.GaussianFitWorkerBridge = {
        runRegionFit: runRegionFit,
        toFloatOr: toFloatOr,
        toIntOr: toIntOr
    };
})(typeof self !== 'undefined' ? self : this);
