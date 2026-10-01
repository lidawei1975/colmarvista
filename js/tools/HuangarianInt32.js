/**
 * Optimized Hungarian Algorithm using Int32Arrays for 200x200 scales.
 * @param {Int32Array} flatMatrix - A flat (N * N) Int32Array representing the cost matrix.
 * @param {number} n - The dimension of the square matrix (e.g., 200).
 * @returns {Int32Array} Flat array of size N where index = row, value = assigned column.
 */
function solveHungarianInt32(flatMatrix, n) {
    // Allocation of fast, fixed-size typed arrays
    const u = new Int32Array(n + 1);
    const v = new Int32Array(n + 1);
    const p = new Int32Array(n + 1);
    const way = new Int32Array(n + 1);
    
    // minv tracks the minimum delta; use a large integer for "Infinity"
    // Since max cost is 65536, 2_000_000_000 is perfectly safe and fits in Int32
    const INF = 2000000000; 
    const minv = new Int32Array(n + 1);
    
    // Using Uint8Array as a fast boolean mask for CPU cache efficiency
    const used = new Uint8Array(n + 1);

    for (let i = 1; i <= n; ++i) {
        p[0] = i;
        let j0 = 0;
        
        minv.fill(INF);
        used.fill(0);
        
        do {
            used[j0] = 1;
            let i0 = p[j0];
            let delta = INF;
            let j1 = 0;
            
            for (let j = 1; j <= n; ++j) {
                if (used[j] === 0) {
                    // Fast flat array index lookup: (row * n) + col
                    // Adjusted for 0-indexed matrix vs 1-indexed algorithm pointers
                    let cur = flatMatrix[(i0 - 1) * n + (j - 1)] - u[i0] - v[j];
                    
                    if (cur < minv[j]) {
                        minv[j] = cur;
                        way[j] = j0;
                    }
                    if (minv[j] < delta) {
                        delta = minv[j];
                        j1 = j;
                    }
                }
            }
            
            for (let j = 0; j <= n; ++j) {
                if (used[j] === 1) {
                    u[p[j]] += delta;
                    v[j] -= delta;
                } else {
                    minv[j] -= delta;
                }
            }
            j0 = j1;
        } while (p[j0] !== 0);

        do {
            let j1 = way[j0];
            p[j0] = p[j1];
            j0 = j1;
        } while (j0 !== 0);
    }

    // Build the final result matching array
    const matchRowToCol = new Int32Array(n);
    for (let j = 1; j <= n; ++j) {
        if (p[j] > 0) {
            matchRowToCol[p[j] - 1] = j - 1;
        }
    }
    return matchRowToCol;
}
