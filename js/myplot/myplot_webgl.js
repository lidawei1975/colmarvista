"use strict";


class webgl_contour_plot {

    constructor(canvas_id) {

        this.canvas = document.querySelector("#" + canvas_id);
        this.gl = this.canvas.getContext("webgl");
        if (!this.gl) {
            alert("No WebGL");
        }
        /**
         * camera define zoom and pan of the camera. We don't need rotation for this application
         */
        this.camera = {
            x: 0,
            y: 0,
            zoom_x: 1,
            zoom_y: 1,
        };


        /**
         * wheel zoom global variables
         */
        this.viewProjectionMat;
        /**
         * Pan the camera by tracking mouse click and mouse move
         */
        this.startInvViewProjMat;
        this.startCamera;
        this.startPos;
        this.startClipPos;
        this.startMousePos;

        let vertex_shader_2d = `
            attribute vec2 a_position;
            uniform mat3 u_matrix;
            void main() {
            // Multiply the position by the matrix.
            gl_Position = vec4((u_matrix * vec3(a_position, 1)).xy, 0, 1);
            }
            `;

        let fragment_shader_2d = `
            precision mediump float;
            uniform vec4 u_color;
            void main() {
            gl_FragColor = u_color;
            }
            `;

        // setup GLSL program
        this.program = webglUtils.createProgramFromSources(this.gl, [vertex_shader_2d, fragment_shader_2d]);

        // look up where the vertex data needs to go.
        this.positionLocation = this.gl.getAttribLocation(this.program, "a_position");

        // lookup uniforms
        this.colorLocation = this.gl.getUniformLocation(this.program, "u_color");
        this.matrixLocation = this.gl.getUniformLocation(this.program, "u_matrix");

        // Create a buffer to put positions in
        this.positionBuffer = this.gl.createBuffer();
        // Bind it to ARRAY_BUFFER (think of it as ARRAY_BUFFER = positionBuffer)
        this.gl.bindBuffer(this.gl.ARRAY_BUFFER, this.positionBuffer);

        /**
         * Tell it to use our program (pair of shaders)
         * For our simple 2d program, we will only use one program. 
         * So we don't need to call gl.useProgram(program) every time we draw
         */
        this.gl.useProgram(this.program);

        // Turn on the attribute
        this.gl.enableVertexAttribArray(this.positionLocation);


        // Bind the position buffer.
        this.gl.bindBuffer(this.gl.ARRAY_BUFFER, this.positionBuffer);

        /**
         * Tell the attribute how to get data out of positionBuffer (ARRAY_BUFFER)
         * In our case, the data will not change, so we will use STATIC_DRAW in load_file() call
         * and we only need to call vertexAttribPointer once when initializing the program
         */
        var size = 2;          // 2 components per iteration
        var type = this.gl.FLOAT;   // the data is 32bit floats
        var normalize = false; // don't normalize the data
        var stride = 0;        // 0 = move forward size * sizeof(type) each iteration to get the next position
        var offset = 0;        // start at the beginning of the buffer
        this.gl.vertexAttribPointer(this.positionLocation, size, type, normalize, stride, offset);

        this.polygon_length = [];

        /**
         * Flag to determine where to put magnified region.
         */
        this.magnification_region_x = 0; //0: left, 1: right
        this.magnification_region_y = 1; //0: bottom, 1: top

        this.levels_length = [];
        this.contour_lbs = [];
        this.spectral_order = [];
        this.contour_lbs_negative = [];
        this.levels_length_negative = [];
        this.colors = [];
        this.spectral_information = {};
    };

    /**
     * Set buffer data and draw the scene
     * @param {Float32Array} points
     */
    set_data(spectral_information, points, points_start, polygon_length, levels_length, colors, contour_lbs, points_start_n, polygon_length_n, levels_length_n, colors_n, contour_lbs_n) {

        this.spectral_information = spectral_information;

        this.colors = colors;
        this.polygon_length = polygon_length;
        this.levels_length = levels_length;
        this.contour_lbs = contour_lbs;
        this.points_start = points_start;

        this.colors_negative = colors_n;
        this.polygon_length_negative = polygon_length_n;
        this.levels_length_negative = levels_length_n;
        this.contour_lbs_negative = contour_lbs_n;
        this.points_start_negative = points_start_n;

        this.gl.bindBuffer(this.gl.ARRAY_BUFFER, this.positionBuffer);
        this.gl.bufferData(this.gl.ARRAY_BUFFER, points, this.gl.STATIC_DRAW);
    };


    /**
     * Draw the scene.
     * @param {number} flag - 0: draw the contour plot, 1: draw and return the image data
     */
    drawScene(flag = 0, flag_glass = false, center = [], mag_scale = 10.0, mag_size = 0.2) {


        this.gl.viewport(0, 0, this.gl.canvas.width, this.gl.canvas.height);

        // Clear the canvas. Set background color to white
        this.gl.clearColor(1, 1, 1, 1);
        this.gl.clear(this.gl.COLOR_BUFFER_BIT);

        // Ratio heatmap goes below the contours
        this._draw_ratio_heatmap(this.x_ppm, this.x2_ppm, this.y_ppm, this.y2_ppm);

        let number_of_spectra = this.levels_length.length;
        /**
         * Draw the contour plot
         * One spectrum at a time
         * # of spectra = this.levels_length.length = this.colors.length = this.spectral_information.length = this.contour_lbs.length = this.polygon_length.length
         */
        for (var nn = 0; nn < number_of_spectra; nn++) {
            let n = this.spectral_order[nn];
            /**
             * setCamera first, using saved this.x_ppm, this.x2_ppm, this.y_ppm, this.y2_ppm
             * and this.spec_information
             */
            let x = (this.x_ppm - this.spectral_information[n].x_ppm_start - this.spectral_information[n].x_ppm_ref) / this.spectral_information[n].x_ppm_step;
            let x2 = (this.x2_ppm - this.spectral_information[n].x_ppm_start - this.spectral_information[n].x_ppm_ref) / this.spectral_information[n].x_ppm_step;
            let y = (this.y_ppm - this.spectral_information[n].y_ppm_start - this.spectral_information[n].y_ppm_ref) / this.spectral_information[n].y_ppm_step;
            let y2 = (this.y2_ppm - this.spectral_information[n].y_ppm_start - this.spectral_information[n].y_ppm_ref) / this.spectral_information[n].y_ppm_step;
            this.setCamera(x, x2, y, y2);

            /**
             * Update the matrix according to the translation and scale defined in camera
             * this also depends on setCamera_ppm() and setCamera() functions
             */
            const projectionMat = m3.projection(this.gl.canvas.width, this.gl.canvas.height);
            const zoomScale_x = 1 / this.camera.zoom_x;
            const zoomScale_y = 1 / this.camera.zoom_y;

            let cameraMat = m3.identity();
            cameraMat = m3.translate(cameraMat, this.camera.x, this.camera.y);
            cameraMat = m3.scale(cameraMat, zoomScale_x, zoomScale_y);

            let viewMat = m3.inverse(cameraMat);
            this.viewProjectionMat = m3.multiply(projectionMat, viewMat);

            // Set the matrix. This matrix changes when zooming and panning
            this.gl.uniformMatrix3fv(this.matrixLocation, false, this.viewProjectionMat);


            /**
             * Draw the positive contour plot, one level at a time
             */
            let is_spec_visible = (typeof hsqc_spectra === 'undefined' || !hsqc_spectra[n] || hsqc_spectra[n].visible !== false);
            if (is_spec_visible) {
                for (var m = this.contour_lbs[n]; m < this.levels_length[n].length; m++) {
                    let i_start = 0;
                    if (m > 0) {
                        i_start = this.levels_length[n][m - 1];
                    }
                    let i_stop = this.levels_length[n][m];
                    /**
                     * Draw the contour plot, one polygon at a time
                     */
                    for (var i = i_start; i < i_stop; i++) {
                        this.gl.uniform4fv(this.colorLocation, this.colors[n]);
                        var primitiveType = this.gl.LINE_STRIP;
                        let point_start = 0;
                        if (i > 0) {
                            point_start = this.polygon_length[n][i - 1];
                        }
                        let count = this.polygon_length[n][i] - point_start;
                        let overlay_offset = this.points_start[n] / 2;
                        this.gl.drawArrays(primitiveType, point_start + overlay_offset, count);
                    }
                }
            }

            /**
             * Draw the negative contour plot, one level at a time only if negative contour is available
             */
            if (n >= this.contour_lbs_negative.length) {
                continue;
            }
            if (is_spec_visible) {
                for (var m = this.contour_lbs_negative[n]; m < this.levels_length_negative[n].length; m++) {
                    let i_start = 0;
                    if (m > 0) {
                        i_start = this.levels_length_negative[n][m - 1];
                    }
                    let i_stop = this.levels_length_negative[n][m];
                    /**
                     * Draw the contour plot, one polygon at a time
                     */
                    for (var i = i_start; i < i_stop; i++) {
                        this.gl.uniform4fv(this.colorLocation, this.colors_negative[n]);
                        var primitiveType = this.gl.LINE_STRIP;
                        let point_start = 0;
                        if (i > 0) {
                            point_start = this.polygon_length_negative[n][i - 1];
                        }
                        let count = this.polygon_length_negative[n][i] - point_start;
                        let overlay_offset = this.points_start_negative[n] / 2;
                        this.gl.drawArrays(primitiveType, point_start + overlay_offset, count);
                    }
                }
            }
        }

        if (flag_glass == true) {
            this.magnification_glass(center, mag_scale, mag_size);
        }

        if (flag == 1) {
            return this.gl.canvas.toDataURL();
        }
        return;
    };

    /**
     * Magnification glass tool
     * IMPORTANT: Not meant to be called directly. 
     * Use drawScene() instead, because all webGl drawing needs to be done un-interrupted
     */
    magnification_glass(cursor_position, magnifying_factor, magnification_glass_size) {
        /**
         * Test magnification glass tool here.
         * At cursor_position (init is ppm), we will zoom in magnifying_factor
         */
        /**
         * Step 1: get canvas location in pixel from ppm (cursor_position)
         */
        let x_pixel = (cursor_position[0] - this.x_ppm) * this.gl.canvas.width / (this.x2_ppm - this.x_ppm);
        let y_pixel = (cursor_position[1] - this.y_ppm) * this.gl.canvas.height / (this.y2_ppm - this.y_ppm);

        /**
         * If x_pixel - 1.1 * magnification_glass_size * this.gl.canvas.width  < 0, 
         * move viewing area to the right of the cursor
         */
        if (x_pixel - 1.1 * magnification_glass_size * this.gl.canvas.width < 0) {
            this.magnification_region_x = 1;
        }
        if (x_pixel + 1.1 * magnification_glass_size * this.gl.canvas.width > this.gl.canvas.width) {
            this.magnification_region_x = 0;
        }
        if (y_pixel - 1.1 * magnification_glass_size * this.gl.canvas.height < 0) {
            this.magnification_region_y = 1;
        }
        if (y_pixel + 1.1 * magnification_glass_size * this.gl.canvas.height > this.gl.canvas.height) {
            this.magnification_region_y = 0;
        }

        /**
         * Get magnification glass view center ppm
         */
        let x_ppm_center, y_ppm_center, x_scissor, y_scissor;
        let x_width_scissor = magnification_glass_size * this.gl.canvas.width;
        let y_height_scissor = magnification_glass_size * this.gl.canvas.height;

        if (this.magnification_region_x == 0) {
            x_ppm_center = -0.6 * magnification_glass_size * (this.x2_ppm - this.x_ppm) + cursor_position[0];
            x_scissor = x_pixel - magnification_glass_size * this.gl.canvas.width * 1.1;
        }
        else {
            x_ppm_center = +0.6 * magnification_glass_size * (this.x2_ppm - this.x_ppm) + cursor_position[0];
            x_scissor = x_pixel + magnification_glass_size * this.gl.canvas.width * 0.1;
        }
        if (this.magnification_region_y == 0) {
            y_ppm_center = -0.6 * magnification_glass_size * (this.y2_ppm - this.y_ppm) + cursor_position[1];
            y_scissor = y_pixel - magnification_glass_size * this.gl.canvas.height * 1.1;
        }
        else {
            y_ppm_center = +0.6 * magnification_glass_size * (this.y2_ppm - this.y_ppm) + cursor_position[1];
            y_scissor = y_pixel + magnification_glass_size * this.gl.canvas.height * 0.1;
        }

        this.gl.enable(this.gl.SCISSOR_TEST);
        this.gl.scissor(x_scissor, y_scissor, x_width_scissor, y_height_scissor);
        this.gl.clearColor(0.9, 0.9, 0.9, 1.0); // set background color to Gray
        this.gl.clear(this.gl.COLOR_BUFFER_BIT);
        this._draw_ratio_heatmap(
            cursor_position[0] + (this.x_ppm - x_ppm_center) / magnifying_factor,
            cursor_position[0] + (this.x2_ppm - x_ppm_center) / magnifying_factor,
            cursor_position[1] + (this.y_ppm - y_ppm_center) / magnifying_factor,
            cursor_position[1] + (this.y2_ppm - y_ppm_center) / magnifying_factor);

        // console.log("x_scissor: " + x_scissor + " y_scissor: " + y_scissor + " x_width_scissor: " + x_width_scissor + " y_height_scissor: " + y_height_scissor);
        // console.log("x_ppm_center: " + x_ppm_center + " y_ppm_center: " + y_ppm_center);

        /**
         * Step 3, get new ppm range, centered at cursor_position and zoom in by a factor of magnifying_factor
         * keep in mind this.x_ppm > this.x2_ppm and this.y_ppm > this.y2_ppm (NMR convention)
         */
        let x_ppm_new = cursor_position[0] + (this.x_ppm - x_ppm_center) / magnifying_factor;
        let x2_ppm_new = cursor_position[0] + (this.x2_ppm - x_ppm_center) / magnifying_factor;
        let y_ppm_new = cursor_position[1] + (this.y_ppm - y_ppm_center) / magnifying_factor;
        let y2_ppm_new = cursor_position[1] + (this.y2_ppm - y_ppm_center) / magnifying_factor;



        /**
         * Draw the contour plot again, but only the center part
         */
        let number_of_spectra = this.levels_length.length;
        for (var nn = 0; nn < number_of_spectra; nn++) {
            let n = this.spectral_order[nn];
            /**
             * setCamera first, using saved this.x_ppm, this.x2_ppm, this.y_ppm, this.y2_ppm
             * and this.spec_information
             */
            let x = (x_ppm_new - this.spectral_information[n].x_ppm_start - this.spectral_information[n].x_ppm_ref) / this.spectral_information[n].x_ppm_step;
            let x2 = (x2_ppm_new - this.spectral_information[n].x_ppm_start - this.spectral_information[n].x_ppm_ref) / this.spectral_information[n].x_ppm_step;
            let y = (y_ppm_new - this.spectral_information[n].y_ppm_start - this.spectral_information[n].y_ppm_ref) / this.spectral_information[n].y_ppm_step;
            let y2 = (y2_ppm_new - this.spectral_information[n].y_ppm_start - this.spectral_information[n].y_ppm_ref) / this.spectral_information[n].y_ppm_step;
            this.setCamera(x, x2, y, y2);

            /**
             * Update the matrix according to the translation and scale defined in camera
             * this also depends on setCamera_ppm() and setCamera() functions
             */
            const projectionMat = m3.projection(this.gl.canvas.width, this.gl.canvas.height);
            const zoomScale_x = 1 / this.camera.zoom_x;
            const zoomScale_y = 1 / this.camera.zoom_y;

            let cameraMat = m3.identity();
            cameraMat = m3.translate(cameraMat, this.camera.x, this.camera.y);
            cameraMat = m3.scale(cameraMat, zoomScale_x, zoomScale_y);

            let viewMat = m3.inverse(cameraMat);
            this.viewProjectionMat = m3.multiply(projectionMat, viewMat);

            // Set the matrix. This matrix changes when zooming and panning
            this.gl.uniformMatrix3fv(this.matrixLocation, false, this.viewProjectionMat);


            /**
             * Draw the positive contour plot, one level at a time
             */
            let is_spec_visible = (typeof hsqc_spectra === 'undefined' || !hsqc_spectra[n] || hsqc_spectra[n].visible !== false);
            if (is_spec_visible) {
                for (var m = this.contour_lbs[n]; m < this.levels_length[n].length; m++) {
                    let i_start = 0;
                    if (m > 0) {
                        i_start = this.levels_length[n][m - 1];
                    }
                    let i_stop = this.levels_length[n][m];
                    /**
                     * Draw the contour plot, one polygon at a time
                     */
                    for (var i = i_start; i < i_stop; i++) {
                        this.gl.uniform4fv(this.colorLocation, this.colors[n]);
                        var primitiveType = this.gl.LINE_STRIP;
                        let point_start = 0;
                        if (i > 0) {
                            point_start = this.polygon_length[n][i - 1];
                        }
                        let count = this.polygon_length[n][i] - point_start;
                        let overlay_offset = this.points_start[n] / 2;
                        this.gl.drawArrays(primitiveType, point_start + overlay_offset, count);
                    }
                }
            }

            /**
             * Draw the negative contour plot, one level at a time only if negative contour is available
             */
            if (n >= this.contour_lbs_negative.length) {
                continue;
            }
            if (is_spec_visible) {
                for (var m = this.contour_lbs_negative[n]; m < this.levels_length_negative[n].length; m++) {
                    let i_start = 0;
                    if (m > 0) {
                        i_start = this.levels_length_negative[n][m - 1];
                    }
                    let i_stop = this.levels_length_negative[n][m];
                    /**
                     * Draw the contour plot, one polygon at a time
                     */
                    for (var i = i_start; i < i_stop; i++) {
                        this.gl.uniform4fv(this.colorLocation, this.colors_negative[n]);
                        var primitiveType = this.gl.LINE_STRIP;
                        let point_start = 0;
                        if (i > 0) {
                            point_start = this.polygon_length_negative[n][i - 1];
                        }
                        let count = this.polygon_length_negative[n][i] - point_start;
                        let overlay_offset = this.points_start_negative[n] / 2;
                        this.gl.drawArrays(primitiveType, point_start + overlay_offset, count);
                    }
                }
            }
        }
        /**
         * Disable the scissor test.
         */
        this.gl.disable(this.gl.SCISSOR_TEST);
    }

    /**
     * Create (lazily) the program used to draw the ratio heatmap.
     * The heatmap is a single textured quad. Spectra A and B are float textures and the
     * log2 ratio, noise mask and diverging blue-white-red colormap are computed in the fragment shader.
     */
    _init_heatmap_program() {
        if (this.heatmap_program) {
            return;
        }
        const gl = this.gl;
        const vs = `
            attribute vec2 a_position;
            uniform mat3 u_matrix;
            uniform vec2 u_size;
            varying vec2 v_uv;
            void main() {
                v_uv = a_position / u_size;
                gl_Position = vec4((u_matrix * vec3(a_position, 1)).xy, 0, 1);
            }`;
        const fs = `
            precision highp float;
            uniform sampler2D u_tex_a;
            uniform sampler2D u_tex_b;
            uniform vec2 u_size;
            uniform float u_threshold;
            uniform float u_range;
            varying vec2 v_uv;

            // Manual bilinear interpolation (float textures are sampled with NEAREST)
            float bilerp(sampler2D tex, vec2 p) {
                vec2 q = p - 0.5;
                vec2 i0 = floor(q);
                vec2 f = q - i0;
                vec2 s = 1.0 / u_size;
                float v00 = texture2D(tex, (i0 + vec2(0.5, 0.5)) * s).r;
                float v10 = texture2D(tex, (i0 + vec2(1.5, 0.5)) * s).r;
                float v01 = texture2D(tex, (i0 + vec2(0.5, 1.5)) * s).r;
                float v11 = texture2D(tex, (i0 + vec2(1.5, 1.5)) * s).r;
                return mix(mix(v00, v10, f.x), mix(v01, v11, f.x), f.y);
            }

            void main() {
                vec2 p = v_uv * u_size;
                float a = abs(bilerp(u_tex_a, p));
                float b = abs(bilerp(u_tex_b, p));
                if (max(a, b) < u_threshold) discard;
                float eps = 0.5 * u_threshold;
                float t = clamp(log2((a + eps) / (b + eps)) / u_range, -1.0, 1.0); // -1 (blue) .. +1 (red)
                vec3 red = vec3(0.70, 0.09, 0.17);
                vec3 blue = vec3(0.13, 0.40, 0.67);
                vec3 c = t >= 0.0 ? mix(vec3(1.0), red, t) : mix(vec3(1.0), blue, -t);
                gl_FragColor = vec4(c, 1.0);
            }`;
        this.heatmap_program = webglUtils.createProgramFromSources(gl, [vs, fs]);
        this.heatmap_loc = {
            position: gl.getAttribLocation(this.heatmap_program, "a_position"),
            matrix: gl.getUniformLocation(this.heatmap_program, "u_matrix"),
            size: gl.getUniformLocation(this.heatmap_program, "u_size"),
            tex_a: gl.getUniformLocation(this.heatmap_program, "u_tex_a"),
            tex_b: gl.getUniformLocation(this.heatmap_program, "u_tex_b"),
            threshold: gl.getUniformLocation(this.heatmap_program, "u_threshold"),
            range: gl.getUniformLocation(this.heatmap_program, "u_range"),
        };
        this.heatmap_buffer = gl.createBuffer();
    }

    /**
     * Upload two spectra (A and B) as float textures. The ratio is computed per fragment
     * in the shader from bilinearly interpolated A and B, so the heatmap is smooth when zoomed in.
     * Displayed value is log2((|A|+eps)/(|B|+eps)), clamped to [-log2_range, +log2_range].
     * Points where both interpolated |A| and |B| are below the threshold are not drawn (noise).
     * Red: A > B, Blue: A < B.
     *
     * @param {Float32Array} dataA - raw data of spectrum A (n_indirect rows of n_direct)
     * @param {Float32Array} dataB - raw data of spectrum B
     * @param {number} n_direct
     * @param {number} n_indirect
     * @param {number} index_a - spectrum index whose ppm axes are used to position the heatmap
     * @param {number} threshold - noise threshold (absolute intensity)
     * @param {number} log2_range - color scale saturates at +/- this log2 ratio
     * @returns {boolean} true on success
     */
    set_ratio_heatmap(dataA, dataB, n_direct, n_indirect, index_a, threshold, log2_range = 2.0) {
        const gl = this.gl;
        const max_size = gl.getParameter(gl.MAX_TEXTURE_SIZE);
        if (n_direct > max_size || n_indirect > max_size) {
            return false;
        }
        // Float textures (sampled with NEAREST, interpolation is done in the shader)
        if (!gl.getExtension("OES_texture_float")) {
            return false;
        }
        // Float fragment precision is needed for raw intensities
        const hp = gl.getShaderPrecisionFormat(gl.FRAGMENT_SHADER, gl.HIGH_FLOAT);
        if (!hp || hp.precision === 0) {
            return false;
        }
        this._init_heatmap_program();

        const upload = (tex, data) => {
            gl.bindTexture(gl.TEXTURE_2D, tex);
            gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1);
            gl.texImage2D(gl.TEXTURE_2D, 0, gl.LUMINANCE, n_direct, n_indirect, 0, gl.LUMINANCE, gl.FLOAT, data);
            gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
            gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
            gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
            gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
        };
        if (!this.heatmap_texture_a) {
            this.heatmap_texture_a = gl.createTexture();
            this.heatmap_texture_b = gl.createTexture();
        }
        upload(this.heatmap_texture_a, dataA);
        upload(this.heatmap_texture_b, dataB);

        this.ratio_heatmap = {
            n_direct: n_direct, n_indirect: n_indirect, index: index_a,
            threshold: threshold, log2_range: log2_range
        };
        return true;
    }

    clear_ratio_heatmap() {
        this.ratio_heatmap = null;
    }

    /**
     * Draw the ratio heatmap (if any). Must be called after clear and before the contours.
     * Restores the contour program state afterwards.
     * IMPORTANT: not meant to be called directly. Use drawScene() instead.
     */
    _draw_ratio_heatmap(x_ppm, x2_ppm, y_ppm, y2_ppm) {
        const hm = this.ratio_heatmap;
        if (!hm || !this.heatmap_texture_a || !this.heatmap_texture_b) {
            return;
        }
        const info = this.spectral_information[hm.index];
        if (!info) {
            return;
        }
        const gl = this.gl;

        // Camera for the spectrum that defines the heatmap geometry
        let x = (x_ppm - info.x_ppm_start - info.x_ppm_ref) / info.x_ppm_step;
        let x2 = (x2_ppm - info.x_ppm_start - info.x_ppm_ref) / info.x_ppm_step;
        let y = (y_ppm - info.y_ppm_start - info.y_ppm_ref) / info.y_ppm_step;
        let y2 = (y2_ppm - info.y_ppm_start - info.y_ppm_ref) / info.y_ppm_step;
        this.setCamera(x, x2, y, y2);
        const projectionMat = m3.projection(gl.canvas.width, gl.canvas.height);
        let cameraMat = m3.identity();
        cameraMat = m3.translate(cameraMat, this.camera.x, this.camera.y);
        cameraMat = m3.scale(cameraMat, 1 / this.camera.zoom_x, 1 / this.camera.zoom_y);
        const mat = m3.multiply(projectionMat, m3.inverse(cameraMat));

        // Quad covering all data points. d3.contours() places grid value i at coordinate i + 0.5,
        // so pixel i spans [i, i + 1] and the quad spans [0, n].
        const x0 = 0, x1 = hm.n_direct, y0 = 0, y1 = hm.n_indirect;
        const quad = new Float32Array([x0, y0, x1, y0, x0, y1, x0, y1, x1, y0, x1, y1]);

        gl.useProgram(this.heatmap_program);
        gl.bindBuffer(gl.ARRAY_BUFFER, this.heatmap_buffer);
        gl.bufferData(gl.ARRAY_BUFFER, quad, gl.DYNAMIC_DRAW);
        gl.enableVertexAttribArray(this.heatmap_loc.position);
        gl.vertexAttribPointer(this.heatmap_loc.position, 2, gl.FLOAT, false, 0, 0);
        gl.uniformMatrix3fv(this.heatmap_loc.matrix, false, mat);
        gl.uniform2f(this.heatmap_loc.size, hm.n_direct, hm.n_indirect);
        gl.uniform1f(this.heatmap_loc.threshold, hm.threshold);
        gl.uniform1f(this.heatmap_loc.range, hm.log2_range);
        gl.activeTexture(gl.TEXTURE0);
        gl.bindTexture(gl.TEXTURE_2D, this.heatmap_texture_a);
        gl.uniform1i(this.heatmap_loc.tex_a, 0);
        gl.activeTexture(gl.TEXTURE1);
        gl.bindTexture(gl.TEXTURE_2D, this.heatmap_texture_b);
        gl.uniform1i(this.heatmap_loc.tex_b, 1);
        gl.activeTexture(gl.TEXTURE0);
        gl.drawArrays(gl.TRIANGLES, 0, 6);

        // Restore contour program state
        if (this.heatmap_loc.position !== this.positionLocation) {
            gl.disableVertexAttribArray(this.heatmap_loc.position);
        }
        gl.useProgram(this.program);
        gl.bindBuffer(gl.ARRAY_BUFFER, this.positionBuffer);
        gl.enableVertexAttribArray(this.positionLocation);
        gl.vertexAttribPointer(this.positionLocation, 2, gl.FLOAT, false, 0, 0);
    }

    /**
     * Directly set this.camera position by calling this function.
     * This is useful when we want to zoom to a specific location, 
     * such as when webgl is overlaid as a background of a SVG plot and 
     * all the zooming and panning is handled by the SVG plot
     */
    setCamera(x, x2, y, y2) {
        /**
         * make sure x2 > x and y2 > y. Swap if not
         */
        if (x2 <= x) {
            let tmp = x2;
            x2 = x;
            x = tmp;
        }
        if (y2 <= y) {
            let tmp = y2;
            y2 = y;
            y = tmp;
        }

        this.camera = {
            x: x,
            y: y,
            zoom_x: this.canvas.clientWidth / (x2 - x),
            zoom_y: this.canvas.clientHeight / (y2 - y)
        };

    };


    /**
     * Set the camera according to ppm
     * Later in drawScene(), we will use this information to set the camera
     */
    setCamera_ppm(x_ppm, x2_ppm, y_ppm, y2_ppm) {
        this.x_ppm = x_ppm;
        this.x2_ppm = x2_ppm;
        this.y_ppm = y_ppm;
        this.y2_ppm = y2_ppm;
    }

    /**
     * Update ppm information
     */
    update_ppm(ref1, ref2) {
        this.x_ppm_start += ref1;
        this.y_ppm_start += ref2;
    }
};



