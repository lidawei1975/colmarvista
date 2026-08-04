"use strict";

/**
 * Marching Cubes Algorithm - Optimized Version
 * Fixes: Memory overflows, GC pressure, and inner-loop redefinitions.
 */
const MarchingCubes = (function () {
    console.log("MarchingCubes Module v2.2 (Optimized) Loaded");

    // --- Lookup Tables ---
    // Loaded from js/marching_cubes_tables.js to prevent truncation
    if (typeof MC_TABLES === 'undefined') {
        console.error("MC_TABLES not found! Make sure js/marching_cubes_tables.js is included.");
    }
    const edgeTable = MC_TABLES.edgeTable;
    const triTable = MC_TABLES.triTable;
    // Position Offsets (Paul Bourke Standard: Z is 'up' in ring)
    // 0-3: y=0 ring. 4-7: y=1 ring.
    // v0:000, v1:100, v2:101, v3:001
    // v4:010, v5:110, v6:111, v7:011
    const posOffsets = [
        [0, 0, 0], [1, 0, 0], [1, 0, 1], [0, 0, 1],
        [0, 1, 0], [1, 1, 0], [1, 1, 1], [0, 1, 1]
    ];
    // Edge connections must match the Tables!
    // Edge 0(v0-v1), 1(v1-v2), 2(v2-v3), 3(v3-v0)
    // Edge 4(v4-v5), 5(v5-v6), 6(v6-v7), 7(v7-v4)
    // Edge 8(v0-v4), 9(v1-v5), 10(v2-v6), 11(v3-v7)
    const edgeEnds = new Int32Array([
        0, 1, 1, 2, 2, 3, 3, 0,
        4, 5, 5, 6, 6, 7, 7, 4,
        0, 4, 1, 5, 2, 6, 3, 7
    ]);

    // Validate triTable completeness and consistency with edgeTable
    const expectedTriTableSize = 256 * 16;
    if (triTable.length < expectedTriTableSize) {
        console.warn(`⚠️ triTable incomplete: ${triTable.length} / ${expectedTriTableSize} entries.`);
    }

    // Consistency Check: Ensure triTable only uses edges defined in edgeTable
    (function checkTables() {
        console.log("Checking Marching Cubes Table Consistency...");
        let errors = 0;
        for (let i = 0; i < 256; i++) {
            const edges = edgeTable[i];
            const offset = i * 16;
            for (let j = 0; j < 16; j++) {
                const edgeIdx = triTable[offset + j];
                if (edgeIdx === -1) break; // End of list

                if (!((edges >> edgeIdx) & 1)) {
                    if (errors < 5) {
                        console.error(`Table Mismatch at Case ${i} (edgeTable=0x${edges.toString(16)}): triTable uses edge ${edgeIdx}, but bit is 0!`);
                    }
                    errors++;
                }
            }
        }
        if (errors > 0) {
            console.error(`Found ${errors} consistency errors in Marching Cubes tables! This creates artifacts.`);
        } else {
            console.log("Marching Cubes Tables are CONSISTENT.");
        }
    })();

    /**
     * Optimized Trilinear Interpolation
     */
    function upsample_grid(data, dims, scale) {
        const nx = dims.x, ny = dims.y, nz = dims.z;
        const nqx = Math.max(1, Math.floor(nx * scale));
        const nqy = Math.max(1, Math.floor(ny * scale));
        const nqz = Math.max(1, Math.floor(nz * scale));

        const dataq = new Float32Array(nqx * nqy * nqz);
        const invScale = 1.0 / scale;

        for (let k = 0; k < nqz; k++) {
            const z_old = k * invScale;
            const z0 = Math.floor(z_old);
            const z1 = Math.min(z0 + 1, nz - 1);
            const zd = z_old - z0;
            const offZ0 = z0 * ny * nx;
            const offZ1 = z1 * ny * nx;

            for (let j = 0; j < nqy; j++) {
                const y_old = j * invScale;
                const y0 = Math.floor(y_old);
                const y1 = Math.min(y0 + 1, ny - 1);
                const yd = y_old - y0;
                const offY00 = offZ0 + y0 * nx;
                const offY10 = offZ0 + y1 * nx;
                const offY01 = offZ1 + y0 * nx;
                const offY11 = offZ1 + y1 * nx;

                for (let i = 0; i < nqx; i++) {
                    const x_old = i * invScale;
                    const x0 = Math.floor(x_old);
                    const x1 = Math.min(x0 + 1, nx - 1);
                    const xd = x_old - x0;

                    const v000 = data[offY00 + x0], v100 = data[offY00 + x1];
                    const v010 = data[offY10 + x0], v110 = data[offY10 + x1];
                    const v001 = data[offY01 + x0], v101 = data[offY01 + x1];
                    const v011 = data[offY11 + x0], v111 = data[offY11 + x1];

                    const c00 = v000 + xd * (v100 - v000);
                    const c10 = v010 + xd * (v110 - v010);
                    const c01 = v001 + xd * (v101 - v001);
                    const c11 = v011 + xd * (v111 - v011);

                    const c0 = c00 + yd * (c10 - c00);
                    const c1 = c01 + yd * (c11 - c01);

                    dataq[(k * nqy + j) * nqx + i] = c0 + zd * (c1 - c0);
                }
            }
        }
        return { data: dataq, dims: { x: nqx, y: nqy, z: nqz } };
    }

    /**
     * Compute Marching Cubes Isosurface
     */
    function compute(data, dims, isoLevel) {
        const width = dims.x, height = dims.y, depth = dims.z;

        // Validate inputs
        if (!data || !dims || isNaN(isoLevel)) {
            throw new Error('Invalid input: data, dims, and isoLevel are required');
        }
        if (width < 2 || height < 2 || depth < 2) {
            throw new Error('Grid dimensions must be at least 2x2x2');
        }
        if (data.length !== width * height * depth) {
            throw new Error(`Data size mismatch: expected ${width * height * depth}, got ${data.length}`);
        }

        const sliceStride = width * height;
        const rowStride = width;

        const CHUNK_SIZE = 120000; // Floats per chunk (approx 13k triangles)
        const MAX_TRIANGLES = 10000000; // 10M triangles max (~400MB) to prevent memory exhaustion
        const vertsChunks = [new Float32Array(CHUNK_SIZE)];
        const normsChunks = [new Float32Array(CHUNK_SIZE)];
        const chunkSizes = []; // Track actual size of each chunk
        let chunkIdx = 0;
        let activeChunk = 0;
        let triangleCount = 0;

        const vertList = new Float32Array(12 * 3);
        const gridVal = new Float32Array(8);

        // Diagnostics
        let cubesProcessed = 0, cubesWithTriangles = 0;
        const sampleCubes = [];

        // Process grid cells
        for (let z = 0; z < depth - 1; z++) {
            const zOff = z * sliceStride;
            const znOff = (z + 1) * sliceStride;

            for (let y = 0; y < height - 1; y++) {
                const yOff = y * rowStride;
                const ynOff = (y + 1) * rowStride;

                for (let x = 0; x < width - 1; x++) {
                    cubesProcessed++;

                    // Map grid values to Paul Bourke Vertex Order:
                    // v0(x,y,z), v1(x+1,y,z), v2(x+1,y,z+1), v3(x,y,z+1)
                    // v4(x,y+1,z), v5(x+1,y+1,z), v6(x+1,y+1,z+1), v7(x,y+1,z+1)

                    // v0: x, y, z
                    gridVal[0] = data[zOff + yOff + x];
                    // v1: x+1, y, z
                    gridVal[1] = data[zOff + yOff + x + 1];
                    // v2: x+1, y, z+1
                    gridVal[2] = data[znOff + yOff + x + 1];
                    // v3: x, y, z+1
                    gridVal[3] = data[znOff + yOff + x];

                    // v4: x, y+1, z
                    gridVal[4] = data[zOff + ynOff + x];
                    // v5: x+1, y+1, z
                    gridVal[5] = data[zOff + ynOff + x + 1];
                    // v6: x+1, y+1, z+1
                    gridVal[6] = data[znOff + ynOff + x + 1];
                    // v7: x, y+1, z+1
                    gridVal[7] = data[znOff + ynOff + x];

                    let cubeIndex = 0;
                    // Note: For NMR/Gaussian data, "Solid" is High Value.
                    // We set bits for values > isoLevel to enclose the high-density region.
                    // (Standard MC often uses <, which would enclose the low-density region).
                    if (gridVal[0] > isoLevel) cubeIndex |= 1;
                    if (gridVal[1] > isoLevel) cubeIndex |= 2;
                    if (gridVal[2] > isoLevel) cubeIndex |= 4;
                    if (gridVal[3] > isoLevel) cubeIndex |= 8;
                    if (gridVal[4] > isoLevel) cubeIndex |= 16;
                    if (gridVal[5] > isoLevel) cubeIndex |= 32;
                    if (gridVal[6] > isoLevel) cubeIndex |= 64;
                    if (gridVal[7] > isoLevel) cubeIndex |= 128;

                    const edges = edgeTable[cubeIndex];
                    if (edges === 0) continue;

                    cubesWithTriangles++;

                    // DEBUG first cube with triangles
                    if (cubesWithTriangles === 1) {
                        console.log(`First cube: pos=[${x},${y},${z}], cubeIndex=${cubeIndex}, edges=0x${edges.toString(16)} (${edges.toString(2).padStart(12, '0')})`);
                        console.log(`  Grid values:`, Array.from(gridVal).map(v => v.toFixed(1)));
                        console.log(`  isoLevel=${isoLevel.toFixed(1)}`);
                    }

                    // Sample first few cubes for debugging
                    if (sampleCubes.length < 5) {
                        sampleCubes.push({
                            pos: [x, y, z],
                            cubeIndex,
                            edges: edges.toString(16),
                            values: Array.from(gridVal).map(v => v.toFixed(2))
                        });
                    }

                    // Interpolate ALL 12 edges unconditionally (don't trust edgeTable)
                    const interpolatedEdges = [];
                    for (let i = 0; i < 12; i++) {
                        const v1Idx = edgeEnds[i * 2];
                        const v2Idx = edgeEnds[i * 2 + 1];
                        const val1 = gridVal[v1Idx];
                        const val2 = gridVal[v2Idx];
                        const p1 = posOffsets[v1Idx];
                        const p2 = posOffsets[v2Idx];

                        let mu = (isoLevel - val1) / (val2 - val1);
                        if (isNaN(mu) || !isFinite(mu)) mu = 0.5;
                        mu = Math.max(0, Math.min(1, mu)); // Clamp to [0,1]

                        vertList[i * 3] = x + p1[0] + mu * (p2[0] - p1[0]);
                        vertList[i * 3 + 1] = y + p1[1] + mu * (p2[1] - p1[1]);
                        vertList[i * 3 + 2] = z + p1[2] + mu * (p2[2] - p1[2]);

                        if (edges & (1 << i)) interpolatedEdges.push(i); // Track what edgeTable said
                    }

                    if (cubesWithTriangles === 1) {
                        console.log(`  Interpolated edges:`, interpolatedEdges);
                        console.log(`  vertList sample:`, Array.from(vertList.slice(0, 30)).map(v => v.toFixed(2)));
                    }

                    // Build triangles
                    let triIdx = cubeIndex << 4;
                    let maxTriPerCube = 0;
                    while (triIdx < triTable.length && triTable[triIdx] !== -1) {
                        if (++maxTriPerCube > 10) {
                            console.error(`Too many triangles for one cube at [${x},${y},${z}]!`);
                            console.error(`cubeIndex: ${cubeIndex}, triIdx: ${triIdx}`);
                            throw new Error(`Invalid triangle count at cube [${x},${y},${z}], cubeIndex=${cubeIndex}`);
                        }

                        // Check triangle limit to prevent memory exhaustion
                        if (++triangleCount > MAX_TRIANGLES) {
                            // Compute min/max without spread operator to avoid stack overflow
                            let dMin = Infinity, dMax = -Infinity;
                            for (let i = 0; i < data.length; i++) {
                                if (data[i] < dMin) dMin = data[i];
                                if (data[i] > dMax) dMax = data[i];
                            }
                            console.error(`Marching Cubes: Triangle limit exceeded (${MAX_TRIANGLES}).`);
                            console.error(`IsoLevel: ${isoLevel.toFixed(3)}, Data range: [${dMin.toFixed(3)}, ${dMax.toFixed(3)}]`);
                            console.error(`Grid: ${width}×${height}×${depth}, Cubes processed: ${cubesProcessed}, Cubes with triangles: ${cubesWithTriangles}`);
                            console.error(`Sample cubes with triangles:`, sampleCubes);
                            throw new Error(`Too many triangles generated (>${MAX_TRIANGLES}). Check isoLevel value.`);
                        }

                        // Check chunk capacity (9 floats for 3 vertices)
                        if (chunkIdx + 9 >= CHUNK_SIZE) {
                            chunkSizes.push(chunkIdx); // Save current chunk size
                            activeChunk++;
                            vertsChunks[activeChunk] = new Float32Array(CHUNK_SIZE);
                            normsChunks[activeChunk] = new Float32Array(CHUNK_SIZE);
                            chunkIdx = 0;
                        }

                        const e0 = triTable[triIdx], e1 = triTable[triIdx + 1], e2 = triTable[triIdx + 2];
                        const ax = vertList[e0 * 3], ay = vertList[e0 * 3 + 1], az = vertList[e0 * 3 + 2];
                        const bx = vertList[e1 * 3], by = vertList[e1 * 3 + 1], bz = vertList[e1 * 3 + 2];
                        const cx = vertList[e2 * 3], cy = vertList[e2 * 3 + 1], cz = vertList[e2 * 3 + 2];

                        // DEBUG first triangle
                        if (triangleCount === 1) {
                            console.log(`First triangle: triIdx=${triIdx}, edges e0=${e0} e1=${e1} e2=${e2}`);
                            console.log(`  A=[${ax.toFixed(2)}, ${ay.toFixed(2)}, ${az.toFixed(2)}]`);
                            console.log(`  B=[${bx.toFixed(2)}, ${by.toFixed(2)}, ${bz.toFixed(2)}]`);
                            console.log(`  C=[${cx.toFixed(2)}, ${cy.toFixed(2)}, ${cz.toFixed(2)}]`);
                        }

                        // Normal
                        const ux = bx - ax, uy = by - ay, uz = bz - az;
                        const vx = cx - ax, vy = cy - ay, vz = cz - az;
                        let nx = uy * vz - uz * vy, ny = uz * vx - ux * vz, nz = ux * vy - uy * vx;
                        const l = Math.sqrt(nx * nx + ny * ny + nz * nz);
                        if (l > 0) { nx /= l; ny /= l; nz /= l; }

                        if (triangleCount === 1) {
                            console.log(`  Normal before normalize: [${(uy * vz - uz * vy).toFixed(3)}, ${(uz * vx - ux * vz).toFixed(3)}, ${(ux * vy - uy * vx).toFixed(3)}] length=${l.toFixed(3)}`);
                            console.log(`  Normal after normalize: [${nx.toFixed(3)}, ${ny.toFixed(3)}, ${nz.toFixed(3)}]`);
                            console.log(`  Writing to chunk ${activeChunk} at index ${chunkIdx}`);
                        }

                        const v = vertsChunks[activeChunk], n = normsChunks[activeChunk];
                        v[chunkIdx] = ax; v[chunkIdx + 1] = ay; v[chunkIdx + 2] = az;
                        n[chunkIdx] = nx; n[chunkIdx + 1] = ny; n[chunkIdx + 2] = nz;
                        chunkIdx += 3;
                        v[chunkIdx] = bx; v[chunkIdx + 1] = by; v[chunkIdx + 2] = bz;
                        n[chunkIdx] = nx; n[chunkIdx + 1] = ny; n[chunkIdx + 2] = nz;
                        chunkIdx += 3;
                        v[chunkIdx] = cx; v[chunkIdx + 1] = cy; v[chunkIdx + 2] = cz;
                        n[chunkIdx] = nx; n[chunkIdx + 1] = ny; n[chunkIdx + 2] = nz;
                        chunkIdx += 3;

                        triIdx += 3;
                    }
                }
            }
        }

        // Final Merge
        chunkSizes.push(chunkIdx); // Save final chunk size
        const totalSize = chunkSizes.reduce((sum, size) => sum + size, 0);

        console.log(`Marching Cubes merge: chunkSizes=${chunkSizes}, totalSize=${totalSize}, activeChunk=${activeChunk}`);
        console.log(`First chunk data (first 18 floats):`, vertsChunks[0].slice(0, 18));
        console.log(`First chunk normals (first 18 floats):`, normsChunks[0].slice(0, 18));

        // Safety check before allocation
        const maxSafeSize = 200000000; // ~800MB limit for Float32Array
        if (totalSize > maxSafeSize) {
            throw new Error(`Result too large: ${triangleCount} triangles (${(totalSize * 4 / 1048576).toFixed(1)}MB). ` +
                `Reduce grid size or adjust isoLevel.`);
        }

        const percentWithTriangles = (cubesWithTriangles / cubesProcessed * 100).toFixed(1);
        console.log(`Marching Cubes: Generated ${triangleCount} triangles (${(totalSize * 4 / 1048576).toFixed(2)}MB)`);
        console.log(`Processed ${cubesProcessed} cubes, ${cubesWithTriangles} (${percentWithTriangles}%) generated triangles`);

        const finalVerts = new Float32Array(totalSize);
        const finalNorms = new Float32Array(totalSize);
        let offset = 0;
        for (let i = 0; i <= activeChunk; i++) {
            const size = chunkSizes[i];
            finalVerts.set(vertsChunks[i].subarray(0, size), offset);
            finalNorms.set(normsChunks[i].subarray(0, size), offset);
            offset += size;
        }

        return { vertices: finalVerts, normals: finalNorms };
    }

    return { compute, upsample: upsample_grid };
})();