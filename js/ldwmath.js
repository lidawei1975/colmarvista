
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
    rayIntersectsLine(rayOrigin, rayDirection, lineStart, lineEnd)
    {

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
     * Estimate noise level of a spectrum.
     * Calculate RMSD of 1024 segment, and get the median value
     * @param {*} x_dim: x dimension of the spectrum
     * @param {Float32Array} spectrum: the spectrum data in 1D array
     * @returns 
     */
    estimate_noise_level_1d(x_dim,spectrum){
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
        console.log("Noise level is " + noise_level + " using variance estimation.");

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

        console.log("Final noise level is estimated to be " + noise_level);

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
    estimate_noise_level(x_dim,y_dim,spectrum)
    {
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
        console.log("Noise level is " + noise_level + " using variance estimation.");

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

        console.log("Final noise level is estimated to be " + noise_level);

        return noise_level;

    }

    /**
     * Find max and min of a Float32Array
     */
    find_max_min(data)
    {
        let max = data[0];
        let min = data[0];
        for(let i=1;i<data.length;i++)
        {
            if(data[i] > max)
            {
                max = data[i];
            }
            if(data[i] < min)
            {
                min = data[i];
            }
        }
        return [max,min];
    }


    /**
     * Concat two float32 arrays into one
     * @returns the concatenated array
     */
    Float32Concat(first, second)
    {
        var firstLength = first.length,
        result = new Float32Array(firstLength + second.length);

        result.set(first);
        result.set(second, firstLength);

        return result;
    }

    Uint8Concat(first, second)
    {
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
}