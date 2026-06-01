
class ldwmath {
    constructor() {
        this.PI = 3.14159265359;
    };


    /**
     * This function calculate the intersects between a ray with a line segment in 2D or 3D space.
     * @param {*} rayOrigin array of 2 values
     * @param {*} rayDirection  array of 2  values [0,1] or [1.0]
     * @param {*} lineStart  array of 2  values
     * @param {*} lineEnd  array of 2 values
     * @returns null if no intersection, else the intersection point
     */
    rayIntersectsLine(rayOrigin, rayDirection, lineStart, lineEnd) {

        // Calculate the direction vector of the line
        const lineDirection = [
            lineEnd[0] - lineStart[0],
            lineEnd[1] - lineStart[1]
        ];

        // Calculate the denominator for the intersection equations
        const denominator = rayDirection[0] * lineDirection[1] - rayDirection[1] * lineDirection[0];

        // If the denominator is 0, the ray and line are parallel (or coincident)
        if (denominator === 0) {
            return null;
        }

        // Calculate the t and u parameters for the intersection equations
        const t = ((lineStart[0] - rayOrigin[0]) * lineDirection[1] - (lineStart[1] - rayOrigin[1]) * lineDirection[0]) / denominator;
        const u = ((lineStart[0] - rayOrigin[0]) * rayDirection[1] - (lineStart[1] - rayOrigin[1]) * rayDirection[0]) / denominator;

        // Check if the intersection point lies on both the ray and the line segment
        if (t >= 0 && u >= 0 && u <= 1) {
            // Calculate the intersection point
            const intersectionPoint = [
                rayOrigin[0] + t * rayDirection[0],
                rayOrigin[1] + t * rayDirection[1]
            ];
            return intersectionPoint;
        }

        // No intersection
        return null;
    }

    /**
     * This function calculate the left,right,top and bottom edges of a polygon and center point (mean of all points)
     * @param {*} polygon array of 2D points
     */
    edgeAndCenter(polygon) {
        let minX = Number.POSITIVE_INFINITY;
        let maxX = Number.NEGATIVE_INFINITY;
        let minY = Number.POSITIVE_INFINITY;
        let maxY = Number.NEGATIVE_INFINITY;
        let sumX = 0;
        let sumY = 0;
        for (let i = 0; i < polygon.length; i++) {
            if (polygon[i][0] < minX) {
                minX = polygon[i][0];
            }
            if (polygon[i][0] > maxX) {
                maxX = polygon[i][0];
            }
            if (polygon[i][1] < minY) {
                minY = polygon[i][1];
            }
            if (polygon[i][1] > maxY) {
                maxY = polygon[i][1];
            }
            sumX += polygon[i][0];
            sumY += polygon[i][1];
        }
        return {
            left: minX,
            right: maxX,
            top: maxY,
            bottom: minY,
            center_x: sumX / polygon.length,
            center_y: sumY / polygon.length
        };
    }

    /**
     * Fits a 1D quadratic curve: y = ax^2 + bx + c
     * @param {number[]} y_values - Array of y values, assumed to be at x = 0, 1, ..., n-1
     * @returns {number[]|null} coefficients [a, b, c]
     */
    fitQuadratic1D(y_values) {
        const n = y_values.length;
        if (n < 3) return null; // Need at least 3 points for 3 coefficients

        const size = 3;
        const A = Array.from({ length: size }, () => new Array(size).fill(0));
        const B = new Array(size).fill(0);

        for (let x = 0; x < n; x++) {
            const y = y_values[x];
            const x2 = x * x;

            // Term map corresponding to variables: [a, b, c] for a*x^2 + b*x + c
            const terms = [x2, x, 1];

            for (let r = 0; r < size; r++) {
                for (let c = 0; c < size; c++) {
                    A[r][c] += terms[r] * terms[c];
                }
                B[r] += terms[r] * y;
            }
        }

        return this.solveLinearSystem(A, B);
    }

    /**
     * Evaluates a 1D quadratic curve: y = ax^2 + bx + c
     * @param {number} n - Number of points (x = 0, 1, ..., n-1)
     * @param {number[]} coeffs - Coefficients [a, b, c]
     * @returns {number[]} Evaluated y values
     */
    evaluateQuadratic1D(n, coeffs) {
        const y_fitted = new Array(n);
        for (let x = 0; x < n; x++) {
            y_fitted[x] = coeffs[0] * x * x + coeffs[1] * x + coeffs[2];
        }
        return y_fitted;
    }

    /**
     * Estimate noise level of a 1D spectrum.
     * Calculate RMSD of each 32-element segment after subtracting fitted 1D quadratic curve.
     * @param {*} x_dim: x dimension of the spectrum
     * @param {Float32Array} spectrum: the spectrum data in 1D array
     * @returns {number} estimated noise level
     */
    estimate_noise_level_1d(x_dim, spectrum) {
        let n_segment_x = Math.floor(x_dim / 32);

        if (n_segment_x === 0) {
            // Fallback: calculate variance of the entire spectrum
            let mean = 0.0;
            for (let i = 0; i < spectrum.length; i++) {
                mean += spectrum[i];
            }
            mean /= spectrum.length;
            let variance = 0.0;
            for (let i = 0; i < spectrum.length; i++) {
                variance += (spectrum[i] - mean) * (spectrum[i] - mean);
            }
            variance /= spectrum.length;
            return Math.sqrt(variance);
        }

        let variances = [];      // variance of each segment
        let maximal_values = []; // maximal value of each segment

        /**
         * loop through each segment, and calculate variance after quadratic curve subtraction
         */
        for (let i = 0; i < n_segment_x; i++) {
            let t = [];
            for (let m = 0; m < 32; m++) {
                t.push(spectrum[i * 32 + m]);
            }

            // Run 2nd order polynomial fitting
            const coeffs = this.fitQuadratic1D(t);
            let residuals = new Array(t.length);

            if (coeffs) {
                const z_fitted = this.evaluateQuadratic1D(t.length, coeffs);
                for (let k = 0; k < t.length; k++) {
                    residuals[k] = t[k] - z_fitted[k];
                }
            } else {
                // Fallback to subtracting the mean if fitting fails
                let mean_of_t = 0.0;
                for (let k = 0; k < t.length; k++) {
                    mean_of_t += t[k];
                }
                mean_of_t /= t.length;
                for (let k = 0; k < t.length; k++) {
                    residuals[k] = t[k] - mean_of_t;
                }
            }

            // Calculate maximum absolute residual for peak filtering
            let max_of_t = 0.0;
            for (let k = 0; k < residuals.length; k++) {
                if (Math.abs(residuals[k]) > max_of_t) {
                    max_of_t = Math.abs(residuals[k]);
                }
            }

            // Calculate variance of the residuals
            let mean_res = 0.0;
            for (let k = 0; k < residuals.length; k++) {
                mean_res += residuals[k];
            }
            mean_res /= residuals.length;

            let variance_of_t = 0.0;
            for (let k = 0; k < residuals.length; k++) {
                variance_of_t += (residuals[k] - mean_res) * (residuals[k] - mean_res);
            }
            variance_of_t /= residuals.length;

            variances.push(variance_of_t);
            maximal_values.push(max_of_t);
        }

        /**
         * Sort the variances and get the median value
         */
        let variances_sorted = [...variances]; // Copy of variances array
        variances_sorted.sort((a, b) => a - b); // Sort in ascending order
        let noise_level = Math.sqrt(variances_sorted[Math.floor(variances_sorted.length / 2)]);

        /**
        * Loop through maximal_values and remove the ones that are larger than 10.0 * noise_level
        * Also remove the corresponding variance as well
        */
        for (let i = maximal_values.length - 1; i >= 0; i--) {
            if (maximal_values[i] > 10.0 * noise_level) {
                maximal_values.splice(i, 1);  // Remove the element at index i
                variances.splice(i, 1);       // Remove corresponding variance
            }
        }

        /**
         * Sort the variances again and get the new median value
         */
        variances_sorted = [...variances];  // Copy the updated variances array
        variances_sorted.sort((a, b) => a - b);  // Sort in ascending order
        noise_level = Math.sqrt(variances_sorted[Math.floor(variances_sorted.length / 2)]);

        return noise_level;
    }

    estimate_noise_level_1d_old(x_dim, spectrum) {
        let n_segment_x = Math.floor(x_dim / 1024);
        let variances = [];      // variance of each segment
        let maximal_values = []; // maximal value of each segment

        /**
         * loop through each segment, and calculate variance
         */
        for (let i = 0; i < n_segment_x; i++) {
            let t = [];
            for (let m = 0; m < 1024; m++) {
                t.push(spectrum[i * 1024 + m]);
            }

            /**
             * calculate variance of this segment. Subtract the mean value of this segment first
             * also calculate the max value of this segment
             */
            let max_of_t = 0.0;
            let mean_of_t = 0.0;
            for (let k = 0; k < t.length; k++) {
                mean_of_t += t[k];
                if (Math.abs(t[k]) > max_of_t) {
                    max_of_t = Math.abs(t[k]);
                }
            }
            mean_of_t /= t.length;

            let variance_of_t = 0.0;
            for (let k = 0; k < t.length; k++) {
                variance_of_t += (t[k] - mean_of_t) * (t[k] - mean_of_t);
            }
            variance_of_t /= t.length;
            variances.push(variance_of_t);
            maximal_values.push(max_of_t);
        }

        /**
         * Sort the variances and get the median value
         */
        let variances_sorted = [...variances]; // Copy of variances array
        variances_sorted.sort((a, b) => a - b); // Sort in ascending order
        let noise_level = Math.sqrt(variances_sorted[Math.floor(variances_sorted.length / 2)]);

        /**
        * Loop through maximal_values and remove the ones that are larger than 10.0 * noise_level
        * Also remove the corresponding variance as well
        */
        for (let i = maximal_values.length - 1; i >= 0; i--) {
            if (maximal_values[i] > 10.0 * noise_level) {
                maximal_values.splice(i, 1);  // Remove the element at index i
                variances.splice(i, 1);       // Remove corresponding variance
            }
        }

        /**
         * Sort the variances again and get the new median value
         */
        variances_sorted = [...variances];  // Copy the updated variances array
        variances_sorted.sort((a, b) => a - b);  // Sort in ascending order
        noise_level = Math.sqrt(variances_sorted[Math.floor(variances_sorted.length / 2)]);

        return noise_level;
    }


    /**
     * Estimate noise level of a spectrum.
     * Calculate RMSD of each 16*16 segment after subtracting fitted 2D quadratic surface.
     * @param {*} x_dim: x dimension of the spectrum
     * @param {*} y_dim: y dimension of the spectrum
     * @param {Float32Array} spectrum: the spectrum data, row major. y*x_dim + x to access the element at (x,y)
     * @returns {number} estimated noise level
     */
    estimate_noise_level(x_dim, y_dim, spectrum) {
        let n_segment_x = Math.floor(x_dim / 16);
        let n_segment_y = Math.floor(y_dim / 16);

        if (n_segment_x === 0 || n_segment_y === 0) {
            // Fallback: calculate variance of the entire spectrum
            let mean = 0.0;
            for (let i = 0; i < spectrum.length; i++) {
                mean += spectrum[i];
            }
            mean /= spectrum.length;
            let variance = 0.0;
            for (let i = 0; i < spectrum.length; i++) {
                variance += (spectrum[i] - mean) * (spectrum[i] - mean);
            }
            variance /= spectrum.length;
            return Math.sqrt(variance);
        }

        let variances = [];      // variance of each segment
        let maximal_values = []; // maximal value of each segment

        /**
         * loop through each segment, and calculate variance after quadratic surface subtraction
         */
        for (let i = 0; i < n_segment_x; i++) {
            for (let j = 0; j < n_segment_y; j++) {
                let t = [];
                let points = [];

                for (let m = 0; m < 16; m++) {
                    for (let n = 0; n < 16; n++) {
                        const val = spectrum[(j * 16 + m) * x_dim + i * 16 + n];
                        t.push(val);
                        points.push({ x: n, y: m, z: val });
                    }
                }

                // Run 2nd order polynomial fitting
                const coeffs = this.fitQuadraticSurface2D(points);
                let residuals = new Array(t.length);

                if (coeffs) {
                    const z_fitted = this.evaluateQuadraticSurface2D(points, coeffs);
                    for (let k = 0; k < t.length; k++) {
                        residuals[k] = t[k] - z_fitted[k];
                    }
                } else {
                    // Fallback to subtracting the mean if fitting fails
                    let mean_of_t = 0.0;
                    for (let k = 0; k < t.length; k++) {
                        mean_of_t += t[k];
                    }
                    mean_of_t /= t.length;
                    for (let k = 0; k < t.length; k++) {
                        residuals[k] = t[k] - mean_of_t;
                    }
                }

                // Calculate maximum absolute residual for peak filtering
                let max_of_t = 0.0;
                for (let k = 0; k < residuals.length; k++) {
                    if (Math.abs(residuals[k]) > max_of_t) {
                        max_of_t = Math.abs(residuals[k]);
                    }
                }

                // Calculate variance of the residuals
                let mean_res = 0.0;
                for (let k = 0; k < residuals.length; k++) {
                    mean_res += residuals[k];
                }
                mean_res /= residuals.length;

                let variance_of_t = 0.0;
                for (let k = 0; k < residuals.length; k++) {
                    variance_of_t += (residuals[k] - mean_res) * (residuals[k] - mean_res);
                }
                variance_of_t /= residuals.length;

                variances.push(variance_of_t);
                maximal_values.push(max_of_t);
            }
        }

        /**
         * Sort the variances and get the median value
         */
        let variances_sorted = [...variances]; // Copy of variances array
        variances_sorted.sort((a, b) => a - b); // Sort in ascending order
        let noise_level = Math.sqrt(variances_sorted[Math.floor(variances_sorted.length / 2)]);

        /**
         * Loop through maximal_values and remove the ones that are larger than 10.0 * noise_level
         * Also remove the corresponding variance as well
         */
        for (let i = maximal_values.length - 1; i >= 0; i--) {
            if (maximal_values[i] > 10.0 * noise_level) {
                maximal_values.splice(i, 1);  // Remove the element at index i
                variances.splice(i, 1);       // Remove corresponding variance
            }
        }

        /**
         * Sort the variances again and get the new median value
         */
        variances_sorted = [...variances];  // Copy the updated variances array
        variances_sorted.sort((a, b) => a - b);  // Sort in ascending order
        noise_level = Math.sqrt(variances_sorted[Math.floor(variances_sorted.length / 2)]);

        return noise_level;
    }

    /**
     * Estimate noise level of a spectrum.
     * Calculate RMSD of each 32*32 segment, and get the median value
     * @param {*} x_dim: x dimension of the spectrum
     * @param {*} y_dim: y dimension of the spectrum
     * @param {Float32Array} spectrum: the spectrum data, row major. y*x_dim + x to access the element at (x,y)
     * @returns 
     */
    estimate_noise_level_old(x_dim, y_dim, spectrum) {
        let n_segment_x = Math.floor(x_dim / 32);
        let n_segment_y = Math.floor(y_dim / 32);

        let variances = [];      // variance of each segment
        let maximal_values = []; // maximal value of each segment

        /**
         * loop through each segment, and calculate variance
         */
        for (let i = 0; i < n_segment_x; i++) {
            for (let j = 0; j < n_segment_y; j++) {
                let t = [];
                for (let m = 0; m < 32; m++) {
                    for (let n = 0; n < 32; n++) {
                        t.push(spectrum[(j * 32 + m) * x_dim + i * 32 + n]);
                    }
                }

                /**
                 * calculate variance of this segment. Subtract the mean value of this segment first
                 * also calculate the max value of this segment
                 */
                let max_of_t = 0.0;
                let mean_of_t = 0.0;
                for (let k = 0; k < t.length; k++) {
                    mean_of_t += t[k];
                    if (Math.abs(t[k]) > max_of_t) {
                        max_of_t = Math.abs(t[k]);
                    }
                }
                mean_of_t /= t.length;

                let variance_of_t = 0.0;
                for (let k = 0; k < t.length; k++) {
                    variance_of_t += (t[k] - mean_of_t) * (t[k] - mean_of_t);
                }
                variance_of_t /= t.length;
                variances.push(variance_of_t);
                maximal_values.push(max_of_t);
            }
        }

        /**
         * Sort the variances and get the median value
         */
        let variances_sorted = [...variances]; // Copy of variances array
        variances_sorted.sort((a, b) => a - b); // Sort in ascending order
        let noise_level = Math.sqrt(variances_sorted[Math.floor(variances_sorted.length / 2)]);

        /**
         * Loop through maximal_values and remove the ones that are larger than 10.0 * noise_level
         * Also remove the corresponding variance as well
         */
        for (let i = maximal_values.length - 1; i >= 0; i--) {
            if (maximal_values[i] > 10.0 * noise_level) {
                maximal_values.splice(i, 1);  // Remove the element at index i
                variances.splice(i, 1);       // Remove corresponding variance
            }
        }

        /**
         * Sort the variances again and get the new median value
         */
        variances_sorted = [...variances];  // Copy the updated variances array
        variances_sorted.sort((a, b) => a - b);  // Sort in ascending order
        noise_level = Math.sqrt(variances_sorted[Math.floor(variances_sorted.length / 2)]);

        return noise_level;

    }

    /**
     * Find max and min of a Float32Array
     */
    find_max_min(data) {
        let max = data[0];
        let min = data[0];
        for (let i = 1; i < data.length; i++) {
            if (data[i] > max) {
                max = data[i];
            }
            if (data[i] < min) {
                min = data[i];
            }
        }
        return [max, min];
    }


    /**
     * Concat two float32 arrays into one
     * @returns the concatenated array
     */
    Float32Concat(first, second) {
        var firstLength = first.length,
            result = new Float32Array(firstLength + second.length);

        result.set(first);
        result.set(second, firstLength);

        return result;
    }

    Uint8Concat(first, second) {
        var firstLength = first.length,
            result = new Uint8Array(firstLength + second.length);

        result.set(first);
        result.set(second, firstLength);

        return result;
    }

    /**
     * Convert an RGB array to a hexadecimal string
     */
    rgbToHex(rgb) {
        return "#" + ((1 << 24) + (Math.round(rgb[0] * 255) << 16) + (Math.round(rgb[1] * 255) << 8) + Math.round(rgb[2] * 255)).toString(16).slice(1);
    }

    /**
     * Convert a hexadecimal string to an RGB array
     */
    hexToRgb(hex) {
        let r = parseInt(hex.substring(1, 3), 16) / 255;
        let g = parseInt(hex.substring(3, 5), 16) / 255;
        let b = parseInt(hex.substring(5, 7), 16) / 255;
        return [r, g, b, 1.0];
    }

    hexToDec(hex) {
        let r = parseInt(hex.substring(1, 3), 16);
        let g = parseInt(hex.substring(3, 5), 16);
        let b = parseInt(hex.substring(5, 7), 16);
        return [r, g, b];
    }

    /**
     * Get median of an array of numbers
     */
    get_median(arr) {
        if (arr.length === 0) return null; // Handle empty array case
        const sorted = [...arr].sort((a, b) => a - b);
        const mid = Math.floor(sorted.length / 2);
        return sorted.length % 2 !== 0 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
    }

    /**
     * Solves a linear system A * x = B using Gaussian Elimination with partial pivoting.
     * @param {number[][]} A - NxN coefficient matrix
     * @param {number[]} B - N-dimensional right-hand side vector
     * @returns {number[]|null} Solutions vector, or null if system is singular.
    */
    solveLinearSystem(A, B) {
        const n = B.length;
        for (let i = 0; i < n; i++) {
            // Pivot selection
            let maxRow = i;
            for (let k = i + 1; k < n; k++) {
                if (Math.abs(A[k][i]) > Math.abs(A[maxRow][i])) {
                    maxRow = k;
                }
            }

            // Swap rows
            const tempA = A[i]; A[i] = A[maxRow]; A[maxRow] = tempA;
            const tempB = B[i]; B[i] = B[maxRow]; B[maxRow] = tempB;

            if (Math.abs(A[i][i]) < 1e-12) return null; // Singular matrix

            // Elimination
            for (let k = i + 1; k < n; k++) {
                const factor = A[k][i] / A[i][i];
                B[k] -= factor * B[i];
                for (let j = i; j < n; j++) {
                    A[k][j] -= factor * A[i][j];
                }
            }
        }

        // Back substitution
        const x = new Array(n);
        for (let i = n - 1; i >= 0; i--) {
            let sum = 0;
            for (let j = i + 1; j < n; j++) {
                sum += A[i][j] * x[j];
            }
            x[i] = (B[i] - sum) / A[i][i];
        }
        return x;
    }

    /**
     * Fits a 2D-domain quadratic surface: z = ax^2 + by^2 + cx + dy + e
     * @param {Array<{x: number, y: number, z: number}>} points - Coordinate dataset
     * @returns {array} - coefficients a,b,c,d,e
     */
    fitQuadraticSurface2D(points) {
        const n = points.length;
        if (n < 5) return null; // Needs at least 5 points to fit 5 coefficients

        const size = 5;
        const A = Array.from({ length: size }, () => new Array(size).fill(0));
        const B = new Array(size).fill(0);

        for (let i = 0; i < n; i++) {
            const { x, y, z } = points[i];
            const x2 = x * x;
            const y2 = y * y;

            // Term map corresponding to variables: [a, b, c, d, e]
            const terms = [x2, y2, x, y, 1];

            for (let r = 0; r < size; r++) {
                for (let c = 0; c < size; c++) {
                    A[r][c] += terms[r] * terms[c];
                }
                B[r] += terms[r] * z;
            }
        }

        const coeffs = this.solveLinearSystem(A, B);
        if (!coeffs) return null;

        return coeffs;
    }

    /**
     * Calculates the z-coordinates of the quadratic surface at the given x,y coordinates.
     * @param {Array<{x: number, y: number}>} points - Array of points to evaluate
     * @param {number[]} coeffs - Coefficients [a, b, c, d, e]
     * @returns {number[]} Array of z-coordinates
     */
    evaluateQuadraticSurface2D(points, coeffs) {
        let z_values = new Array(points.length);
        for (let i = 0; i < points.length; i++) {
            z_values[i] = coeffs[0] * points[i].x * points[i].x + coeffs[1] * points[i].y * points[i].y + coeffs[2] * points[i].x + coeffs[3] * points[i].y + coeffs[4];
        }
        return z_values;
    }
}