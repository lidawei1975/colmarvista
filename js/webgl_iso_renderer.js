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
        this.requestRender();
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
        this.gl.disable(this.gl.DEPTH_TEST);
        this.gl.disable(this.gl.CULL_FACE); // Disable culling to see both sides
        this.gl.disable(this.gl.BLEND);
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
        // Apply Panning (in screen space / camera space)
        // We translate the world relative to camera by (panX, panY). 
        // Or conceptually, move camera by (-panX, -panY).
        // Since we are building the VIEW matrix (World -> Camera),
        // Translating geometry by (panX, panY, -distance) works.
        view = m4.translate(view, this.panX, this.panY, -this.distance);

        view = m4.xRotate(view, degToRad(this.rotationX));
        view = m4.yRotate(view, degToRad(this.rotationY));

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
