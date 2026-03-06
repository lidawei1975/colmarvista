"use strict";

/**
 * A dedicated WebGL renderer for true 3D isosurfaces.
 * Independent of the 2D contour plotter.
 */
class IsoSurfaceRenderer {
    constructor(canvas_id) {
        this.canvas = document.getElementById(canvas_id);
        if (!this.canvas) {
            console.error("Canvas element not found: " + canvas_id);
            return;
        }

        this.gl = this.canvas.getContext("webgl");
        if (!this.gl) {
            alert("WebGL not supported");
            return;
        }

        // --- Interaction State ---
        this.isDragging = false;
        this.lastMouseX = 0;
        this.lastMouseY = 0;

        // Orbit angles (in degrees)
        this.rotationX = 30;
        this.rotationY = -45;
        this.distance = 3.0; // Zoom level (3.0 to fit unit cube comfortably)

        // Panning (Camera space offset)
        this.panX = 0;
        this.panY = 0;

        // Target (Pivot Point)
        this.target = { x: 0, y: 0, z: 0 };


        this.setupInteraction();

        // --- Shader Source ---
        // Simple Gouraud shading
        const vsSource = `
            attribute vec4 a_position;
            attribute vec3 a_normal;
            
            uniform mat4 u_projection;
            uniform mat4 u_view;
            uniform mat4 u_world;
            
            varying vec3 v_normal;
            varying vec3 v_surfaceToLight;
            
            void main() {
                // Transform position
                gl_Position = u_projection * u_view * u_world * a_position;
                
                // DEBUG: Bypass matrices to test drawing in NDC directly
                // gl_Position = vec4(a_position.xyz, 1.0);
                
                // Transform normal (assume uniform scaling for now, so world matrix is fine)
                // For correct normals with non-uniform scale, use inverse-transpose of world matrix.
                // Here we keep it simple as our volume is usually normalized to unit box.
                v_normal = mat3(u_world) * a_normal; 
                
                // Simple directional light from "headlight" (camera position)
                // In view space, camera is at 0,0,0
                vec3 worldPos = (u_world * a_position).xyz;
                // v_surfaceToLight = normalize(vec3(0,0,10) - worldPos); // Static light pos
            }
        `;

        const fsSource = `
            precision mediump float;
            
            varying vec3 v_normal;
            
            uniform vec4 u_color;
            uniform vec3 u_lightDir; // Direction TO light
            
            void main() {
                vec3 normal = normalize(v_normal);
                vec3 light = normalize(u_lightDir);
                
                // Ambient
                float ambient = 0.5;
                
                // Diffuse - two-sided lighting
                float diff = max(abs(dot(normal, light)), 0.0);
                
                gl_FragColor = vec4(u_color.rgb * (ambient + diff), u_color.a);
            }
        `;

        // Initialize Program
        this.programInfo = webglUtils.createProgramInfo(this.gl, [vsSource, fsSource]);

        if (!this.programInfo || !this.programInfo.program) {
            console.error("Failed to create shader program!");
            return;
        }

        // Verify program is valid
        this.gl.validateProgram(this.programInfo.program);
        if (!this.gl.getProgramParameter(this.programInfo.program, this.gl.VALIDATE_STATUS)) {
            console.error("Program validation failed:", this.gl.getProgramInfoLog(this.programInfo.program));
        } else {
            console.log("Shader program created and validated successfully");
        }

        // Buffers
        this.buffers = null;
        this.objectData = []; // Array of { bufferInfo, color, mode }
    }

    setupInteraction() {
        // Prevent context menu on right click
        this.canvas.addEventListener('contextmenu', e => e.preventDefault());

        this.canvas.addEventListener('mousedown', (e) => {
            this.isDragging = true;
            this.lastMouseX = e.clientX;
            this.lastMouseY = e.clientY;
            this.mouseButton = e.button; // 0: Left, 2: Right
        });

        window.addEventListener('mouseup', () => {
            this.isDragging = false;
            this.mouseButton = -1;
        });

        window.addEventListener('mousemove', (e) => {
            if (!this.isDragging) return;
            const deltaX = e.clientX - this.lastMouseX;
            const deltaY = e.clientY - this.lastMouseY;
            this.lastMouseX = e.clientX;
            this.lastMouseY = e.clientY;

            if (this.mouseButton === 2) {
                // Right Click: Pan
                // Scale pan speed by distance to keep it feeling consistent
                const panSpeed = 0.002 * this.distance;
                this.panX += deltaX * panSpeed;
                this.panY -= deltaY * panSpeed; // Y is inverted in screen space vs 3D
            } else {
                // Left Click: Rotate
                this.rotationY += deltaX * 0.5;
                this.rotationX += deltaY * 0.5;
            }

            this.requestRender();
        });

        this.canvas.addEventListener('wheel', (e) => {
            e.preventDefault();
            const zoomSpeed = 0.001;
            this.distance += e.deltaY * zoomSpeed * this.distance;
            this.distance = Math.max(0.1, this.distance);
            this.requestRender();
        });

        // Touch support (basic)
        this.canvas.addEventListener('touchstart', (e) => {
            if (e.touches.length === 1) {
                this.isDragging = true;
                this.lastMouseX = e.touches[0].clientX;
                this.lastMouseY = e.touches[0].clientY;
                this.mouseButton = 0; // Treat as rotate
            }
        }, { passive: false });

        this.canvas.addEventListener('touchmove', (e) => {
            if (this.isDragging && e.touches.length === 1) {
                e.preventDefault();
                const deltaX = e.touches[0].clientX - this.lastMouseX;
                const deltaY = e.touches[0].clientY - this.lastMouseY;
                this.lastMouseX = e.touches[0].clientX;
                this.lastMouseY = e.touches[0].clientY;

                this.rotationY += deltaX * 0.5;
                this.rotationX += deltaY * 0.5;
                this.requestRender();
            }
        }, { passive: false });

        window.addEventListener('touchend', () => {
            this.isDragging = false;
        });
    }

    resetView() {
        this.rotationX = 30;
        this.rotationY = -45;
        this.distance = 3.0;
        this.panX = 0;
        this.panY = 0;
        this.target = { x: 0, y: 0, z: 0 };
        this.requestRender();
    }

    centerView(x, y, z) {
        // Set the pivot point to the requested coordinates
        this.target = { x: x, y: y, z: z };

        // Reset pan so the target is exactly in the center of the screen
        this.panX = 0;
        this.panY = 0;

        this.requestRender();
    }


    getViewCenter() {
        if (!this.invViewMatrix) return this.target;

        // We want the point P_world that maps to (0, 0, -distance) in View Space.
        // P_world = InvView * (0, 0, -distance, 1)

        let v_view = [0, 0, -this.distance, 1];

        // m4.multiply_vec(matrix, vec) 
        // Note: m4.js multiply_vec logic:
        // b0 * a00 + b1 * a10 ...
        // It computes Vector * Matrix? Or Matrix * Vector?
        // Let's check m4.js again.
        // b0*a00 + b1*a10...
        // a00, a10, a20, a30 is Column 0.
        // So this computes v[0]*Col0 + v[1]*Col1 ...
        // This is Matrix * Vector? No.
        // If v is row vector: v * M = v[0]*Row0 + ...
        // If v is col vector: M * v = v[0]*Col0 + ...

        // m4.js is column-major storage.
        // a00, a10, a20, a30 are indices 0, 4, 8, 12?
        // m4.js: "var a10 = a[1 * 4 + 0]" which is index 4.
        // Yes, a10 is Row 1 Col 0 (if naming convention is RowCol).
        // Standard Math Convention: M_10 is Row 1, Col 0.
        // In column-major array: Index 1 is Row 1, Col 0.
        // So a[1] is M_10.

        // In m4.multiply_vec:
        // var a10 = a[4]. (Index 4 is M_01: Row 0, Col 1).
        // Wait.
        // Standard Column Major:
        // 0 4 8 12
        // 1 5 9 13
        // ...

        // m4 code: var a10 = a[4].
        // If a[4] is M_01 (Row 0 Col 1).
        // Then variable name `a10` is confusing or means "1st index of 2nd col".

        // The computation: b0 * a00 + b1 * a10 + ...
        // = b0 * a[0] + b1 * a[4] + ...
        // = b0 * M_00 + b1 * M_01 + ...
        // This is Row 0 of M dotted with b?
        // No, this is: b0 * Col0_Element ?
        // b0 * M_00 + b1 * M_01 ...
        // This looks like Row 0 computation for M*v if M was Row Major??

        // Let's look at output res[0]:
        // b0*a00 + b1*a10 ...
        // If m4 represents matrix as:
        // [ m00, m01, m02, m03,    (Row 0)
        //   m10, m11, ... ]
        // Then a[4] is m10 (Row 1 Col 0).
        // Then b0 * m00 + b1 * m10 ... is Column 0 dotted with b.
        // This would be (v * M)[0].

        // BUT m4.projection returns:
        // 2/w, 0, 0, 0, ...
        // 0, -2/h, 0, 0...
        // This looks row-major visual layout in code?
        // But passed to WebGL (column major expected).
        // So WebGL reads [2/w, 0, 0, 0] as Column 0.
        // Thus M_00 = 2/w.

        // So m4.js matrices are Column Major.
        // And multiply_vec does a transform.
        // I will trust m4.transformPoint if it exists, but simpler:
        // Just implement the multiplication manually using standard indices.
        // InvView * v.

        let m = this.invViewMatrix;
        let v = v_view;

        // x = m00*v0 + m10*v1 + m20*v2 + m30*v3  (Row 0 dot v)
        // In column-major array 'm':
        // Row 0 is indices 0, 4, 8, 12.
        // Row 1 is indices 1, 5, 9, 13.

        let x = m[0] * v[0] + m[4] * v[1] + m[8] * v[2] + m[12] * v[3];
        let y = m[1] * v[0] + m[5] * v[1] + m[9] * v[2] + m[13] * v[3];
        let z = m[2] * v[0] + m[6] * v[1] + m[10] * v[2] + m[14] * v[3];
        let w = m[3] * v[0] + m[7] * v[1] + m[11] * v[2] + m[15] * v[3];

        return {
            x: x / w,
            y: y / w,
            z: z / w
        };
    }

    /**
     * Set the geometry data to render.
     * @param {Array} meshes - Array of mesh objects { vertices: Float32Array, normals: Float32Array, color: [r,g,b,a], mode: "TRIANGLES"|"LINES" }
     */
    updateGeometry(meshes) {
        // Cleanup old buffers
        if (this.objectData) {
            this.objectData.forEach(obj => {
                if (obj.positionBuffer) this.gl.deleteBuffer(obj.positionBuffer);
                if (obj.normalBuffer) this.gl.deleteBuffer(obj.normalBuffer);
            });
        }
        this.objectData = [];

        meshes.forEach((mesh, idx) => {
            // Debug: Check vertex ranges
            let minX = Infinity, maxX = -Infinity;
            for (let i = 0; i < mesh.vertices.length; i += 3) {
                minX = Math.min(minX, mesh.vertices[i]);
                maxX = Math.max(maxX, mesh.vertices[i]);
            }
            console.log(`Mesh ${idx} bounds X[${minX.toFixed(3)}, ${maxX.toFixed(3)}] Verts: ${mesh.vertices.length / 3}`);

            // Raw WebGL Buffer Creation
            const posBuffer = this.gl.createBuffer();
            this.gl.bindBuffer(this.gl.ARRAY_BUFFER, posBuffer);
            this.gl.bufferData(this.gl.ARRAY_BUFFER, mesh.vertices, this.gl.STATIC_DRAW);

            const normBuffer = this.gl.createBuffer();
            this.gl.bindBuffer(this.gl.ARRAY_BUFFER, normBuffer);
            this.gl.bufferData(this.gl.ARRAY_BUFFER, mesh.normals, this.gl.STATIC_DRAW);

            this.objectData.push({
                positionBuffer: posBuffer,
                normalBuffer: normBuffer,
                vertexCount: mesh.vertices.length / 3,
                color: mesh.color,
                mode: mesh.mode === 'LINES' ? this.gl.LINES : this.gl.TRIANGLES
            });
        });

        console.log(`Total objects to render: ${this.objectData.length}`);
        this.requestRender();
    }

    resize() {
        webglUtils.resizeCanvasToDisplaySize(this.canvas);
        this.gl.viewport(0, 0, this.canvas.width, this.canvas.height);
        console.log("Canvas resized - internal:", this.canvas.width, "x", this.canvas.height,
            "display:", this.canvas.clientWidth, "x", this.canvas.clientHeight);
        console.log("Canvas style:", window.getComputedStyle(this.canvas).display,
            "visibility:", window.getComputedStyle(this.canvas).visibility,
            "opacity:", window.getComputedStyle(this.canvas).opacity,
            "z-index:", window.getComputedStyle(this.canvas).zIndex);
    }

    render() {
        this.resize();

        console.log("IsoSurfaceRenderer.render() called. Canvas size:",
            this.canvas.width, "x", this.canvas.height,
            "Objects:", this.objectData.length);

        this.gl.clearColor(0.9, 0.9, 0.9, 1.0); // Light Gray background
        this.gl.enable(this.gl.DEPTH_TEST);
        this.gl.depthFunc(this.gl.LEQUAL);

        this.gl.disable(this.gl.CULL_FACE); // Disable culling to see both sides

        this.gl.enable(this.gl.BLEND);
        this.gl.blendFunc(this.gl.SRC_ALPHA, this.gl.ONE_MINUS_SRC_ALPHA);

        this.gl.clear(this.gl.COLOR_BUFFER_BIT | this.gl.DEPTH_BUFFER_BIT);

        // Check if clear worked
        const pixels = new Uint8Array(4);
        this.gl.readPixels(this.canvas.width / 2, this.canvas.height / 2, 1, 1, this.gl.RGBA, this.gl.UNSIGNED_BYTE, pixels);
        console.log("Center pixel after clear (should be ~230,230,230):", pixels);

        this.gl.enable(this.gl.DEPTH_TEST);
        this.gl.enable(this.gl.BLEND);
        this.gl.blendFunc(this.gl.SRC_ALPHA, this.gl.ONE_MINUS_SRC_ALPHA);

        const degToRad = (d) => d * Math.PI / 180;

        let aspect = this.canvas.clientWidth / this.canvas.clientHeight;
        if (isNaN(aspect) || !isFinite(aspect) || aspect === 0) {
            console.warn("Invalid aspect ratio:", aspect, "Canvas:", this.canvas.clientWidth, "x", this.canvas.clientHeight);
            aspect = 1.0;
        }
        console.log("Aspect Ratio:", aspect);

        const projection = m4.perspective(degToRad(60), aspect, 0.1, 100);

        // Camera Orbit
        // Move camera back by 'distance', then rotate around origin
        let view = m4.identity();

        // 1. Move camera back and apply screen-space pan
        view = m4.translate(view, this.panX, this.panY, -this.distance);

        // 2. Rotate camera (orbit)
        view = m4.xRotate(view, degToRad(this.rotationX));
        view = m4.yRotate(view, degToRad(this.rotationY));

        // 3. Translate world to center the Pivot Point (Target) at origin
        // This ensures rotation happens around the target
        view = m4.translate(view, -this.target.x, -this.target.y, -this.target.z);



        console.log("View Matrix:", view);
        console.log("Projection Matrix:", projection);

        console.log("Camera: distance=" + this.distance.toFixed(2),
            "rotX=" + this.rotationX.toFixed(0),
            "rotY=" + this.rotationY.toFixed(0));

        // Center the object?
        // Assume object is normalized to -0.5 to 0.5 range or similar before passing in?
        // Or we can center it via world matrix. 
        // For now, assume data is centered.
        const world = m4.identity();

        this.gl.useProgram(this.programInfo.program);

        // Set shared uniforms
        const lightDir = [0.5, 0.7, 1.0];
        console.log("Setting uniforms: proj/view/world matrices, lightDir:", lightDir);
        console.log("Projection matrix:", projection);
        console.log("View matrix:", view);

        webglUtils.setUniforms(this.programInfo.uniformSetters, {
            u_projection: projection,
            u_view: view,
            u_world: world,
            u_lightDir: lightDir
        });

        // Verify WebGL state
        console.log("WebGL state: depth test enabled:", this.gl.getParameter(this.gl.DEPTH_TEST),
            "cull face:", this.gl.getParameter(this.gl.CULL_FACE));

        // DEBUG: Reset rotation to look straight on
        // this.rotationX = 0;
        // this.rotationY = 0;

        // Look up attribute locations once
        const posLoc = this.gl.getAttribLocation(this.programInfo.program, "a_position");
        const normLoc = this.gl.getAttribLocation(this.programInfo.program, "a_normal");

        this.objectData.forEach((obj, idx) => {
            // console.log(`Drawing object ${idx}: mode=${obj.mode}, count=${obj.vertexCount}`);

            if (posLoc !== -1) {
                this.gl.bindBuffer(this.gl.ARRAY_BUFFER, obj.positionBuffer);
                this.gl.enableVertexAttribArray(posLoc);
                this.gl.vertexAttribPointer(posLoc, 3, this.gl.FLOAT, false, 0, 0);
            }

            if (normLoc !== -1 && obj.normalBuffer) {
                this.gl.bindBuffer(this.gl.ARRAY_BUFFER, obj.normalBuffer);
                this.gl.enableVertexAttribArray(normLoc);
                this.gl.vertexAttribPointer(normLoc, 3, this.gl.FLOAT, false, 0, 0);
            }

            webglUtils.setUniforms(this.programInfo.uniformSetters, {
                u_color: obj.color
            });

            this.gl.drawArrays(obj.mode, 0, obj.vertexCount);
        });

        console.log("Render complete");
    }

    requestRender() {
        if (!this.renderRequested) {
            this.renderRequested = true;
            requestAnimationFrame(() => {
                this.render();
                this.renderRequested = false;
            });
        }
    }
}
