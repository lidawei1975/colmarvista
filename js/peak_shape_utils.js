(function (globalScope) {
    'use strict';

    function erfcApprox(x) {
        var z = Math.abs(x);
        var t = 1.0 / (1.0 + 0.5 * z);
        var p = 0.17087277;
        p = -0.82215223 + t * p;
        p = 1.48851587 + t * p;
        p = -1.13520398 + t * p;
        p = 0.27886807 + t * p;
        p = -0.18628806 + t * p;
        p = 0.09678418 + t * p;
        p = 0.37409196 + t * p;
        p = 1.00002368 + t * p;
        var ans = t * Math.exp(-z * z - 1.26551223 + t * p);
        return x >= 0 ? ans : (2.0 - ans);
    }

    function voigtAtZero(sigma, gamma) {
        var s = Math.abs(Number(sigma));
        var g = Math.abs(Number(gamma));
        if (!Number.isFinite(s) || !Number.isFinite(g)) {
            return 0.0;
        }
        var tiny = 1e-12;
        if (s < tiny && g < tiny) {
            return 0.0;
        }
        if (s < tiny) {
            return 1.0 / (Math.PI * Math.max(g, tiny));
        }
        if (g < tiny) {
            return 1.0 / (s * Math.sqrt(2.0 * Math.PI));
        }
        var a = g / (s * Math.sqrt(2.0));
        return Math.exp(a * a) * erfcApprox(a) / (s * Math.sqrt(2.0 * Math.PI));
    }

    // Shared enum mapping: 0=Gaussian, 1=Voigt, 3=Voigt-Lorentz.
    function convertAmpToHeightVolume(amp, sx, sy, gx, gy, peakShape) {
        var a = Number.isFinite(amp) ? amp : 0.0;
        var sxv = Number.isFinite(sx) ? Math.abs(sx) : 0.0;
        var syv = Number.isFinite(sy) ? Math.abs(sy) : 0.0;
        var gxv = Number.isFinite(gx) ? Math.abs(gx) : 0.0;
        var gyv = Number.isFinite(gy) ? Math.abs(gy) : 0.0;

        if (peakShape === 0) {
            return {
                height: a,
                volume: a * 2.0 * Math.PI * sxv * syv
            };
        }
        if (peakShape === 3) {
            return {
                height: a * voigtAtZero(sxv, gxv),
                volume: a
            };
        }
        return {
            height: a * voigtAtZero(sxv, gxv) * voigtAtZero(syv, gyv),
            volume: a
        };
    }

    function describeAmpMeaningByShape(peakShape) {
        if (peakShape === 0) {
            return 'input amp is HEIGHT seed (Gaussian); internal amp remains height';
        }
        if (peakShape === 3) {
            return 'input amp is HEIGHT seed; C++ init converts to volume-like amp (Voigt-Lorentz)';
        }
        return 'input amp is HEIGHT seed; C++ init converts to volume-like amp (Voigt)';
    }

    globalScope.PeakShapeUtils = {
        convertAmpToHeightVolume: convertAmpToHeightVolume,
        describeAmpMeaningByShape: describeAmpMeaningByShape,
        voigtAtZero: voigtAtZero
    };
})(typeof self !== 'undefined' ? self : this);
