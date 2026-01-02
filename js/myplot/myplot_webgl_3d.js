"use strict";


class webgl_contour_plot_3d {

    constructor(canvas_id, points, normals, colors, x_dim, y_dim, flag = 0) {

        this.canvas = document.querySelector("#" + canvas_id);
        this.gl = this.canvas.getContext("webgl");
        if (!this.gl) {
            alert("No WebGL");
        }

        if (flag == 0) {
            let vertex_shader_2d = `
                    attribute vec4 a_position;
                    attribute vec4 a_color;
                    uniform mat4 u_matrix;
                    varying vec4 v_color;
                    void main() {
                    // Multiply the position by the matrix.
                    gl_Position = u_matrix * a_position;
                    v_color = a_color;
                    }
                `;

            let fragment_shader_2d = `
                    precision mediump float;
                    varying vec4 v_color;
                    void main() {
                    gl_FragColor = v_color;
                    }
                `;

            // setup GLSL program
            this.program = webglUtils.createProgramFromSources(this.gl, [vertex_shader_2d, fragment_shader_2d]);
        }
        else //flag=1, add lighting effect
        {
            let vertex_shader_2d = `
            attribute vec4 a_position;
            attribute vec4 a_color;
            attribute vec3 a_normal;
            uniform mat4 u_matrix;
            uniform mat4 u_normal_matrix;
            varying vec4 v_color;
            varying vec3 v_normal;
            void main() {
            // Multiply the position by the matrix.
            gl_Position = u_matrix * a_position;
            v_normal = mat3(u_normal_matrix) * a_normal;
            v_color = a_color;
            }
            `;

            let fragment_shader_2d = `
                    precision mediump float;
                    varying vec3 v_normal;
                    uniform vec3 u_reverseLightDirection;
                    uniform vec4 u_color;
                    varying vec4 v_color;

                    void main() {
                    vec3 normal = normalize(v_normal);
                    float light = dot(normal, u_reverseLightDirection);
                    gl_FragColor = v_color;
                    gl_FragColor.rgb *= light;
                    }
                `;

            // setup GLSL program
            this.program = webglUtils.createProgramFromSources(this.gl, [vertex_shader_2d, fragment_shader_2d]);
        }

        // look up where the vertex data needs to go.
        this.positionLocation = this.gl.getAttribLocation(this.program, "a_position");

        // lookup uniforms
        this.colorLocation = this.gl.getAttribLocation(this.program, "a_color");
        this.matrixLocation = this.gl.getUniformLocation(this.program, "u_matrix");
        if (flag == 1) {
            this.normalLocation = this.gl.getAttribLocation(this.program, "a_normal");
            this.reverseLightDirectionLocation = this.gl.getUniformLocation(this.program, "u_reverseLightDirection");
            this.normalMatrixLocation = this.gl.getUniformLocation(this.program, "u_normal_matrix");
        }

        // Create a buffer to put positions in
        this.positionBuffer = this.gl.createBuffer();
        //bind the buffer
        this.gl.bindBuffer(this.gl.ARRAY_BUFFER, this.positionBuffer);
        //NEXT, need to set data
        this.gl.bufferData(this.gl.ARRAY_BUFFER, points, this.gl.STATIC_DRAW);


        // Create a buffer to put colors in
        this.colorBuffer = this.gl.createBuffer();
        //bind the buffer
        this.gl.bindBuffer(this.gl.ARRAY_BUFFER, this.colorBuffer);
        this.gl.bufferData(this.gl.ARRAY_BUFFER, colors, this.gl.STATIC_DRAW);

        if (flag == 1) {
            /**
             * Buffer for normals of the triangles
             */
            this.normalBuffer = this.gl.createBuffer();
            this.gl.bindBuffer(this.gl.ARRAY_BUFFER, this.normalBuffer);
            this.gl.bufferData(this.gl.ARRAY_BUFFER, normals, this.gl.STATIC_DRAW);
        }

        this.data_length = points.length / 3;

        this.drawing_flag = flag;

        this.rotation_x = -45;
        this.rotation_y = 0;
        this.rotation_z = 0;

        this.translation_x = -x_dim / 2;
        this.translation_y = -y_dim / 2;
        this.translation_z = -100000;

        /**
         * Relative scale of y,z axis compared to x axis
         * Overall scale is controlled by fov
         */
        this.scale_z = 1;
        this.scale_y = 1;


        this.fov = x_dim / this.gl.canvas.clientWidth;

        /**
         * Light direction in world frame. 
         * tilt is the angle between the light direction and the x-y plane
         * rotation is the angle between the projection of light direction on x-y plane and x axis
         */
        this.light_tilt = 0;
        this.light_orientation = 120;


        /**
         * x_axis_in_spe_frame and y_axis_in_spe_frame are the vectors in the spectrum frame for 
         * [1,0,0] and [0,1,0] in the world frame, respectively.
         * The scale 800 means moving 800 units in the spectrum frame is equivalent to moving 1 unit in the world frame.
         * (Size of world frame is 2*2*2 (clip space of webgl: -1 to 1 for x, y, z) and size of spectrum frame is roughly 900*900
         */
        this.x_axis_in_spe_frame = [800, 0, 0, 1];
        this.y_axis_in_spe_frame = [0, 800, 0, 1];

        this.dragging = false;

    };

    radToDeg(r) {
        return r * 180 / Math.PI;
    };

    degToRad(d) {
        return d * Math.PI / 180;
    };

    drag(dx, dy) {
        /**
         * Convert the movement to the range of slip space scale (-1 to 1)
         * y axis is reversed in webgl drawing
         */
        dx = dx / this.gl.canvas.width * 2;
        dy = -dy / this.gl.canvas.height * 2;

        let scale = Math.sqrt(this.y_axis_in_spe_frame[0] * this.y_axis_in_spe_frame[0]
            + this.y_axis_in_spe_frame[1] * this.y_axis_in_spe_frame[1] * this.scale_y * this.scale_y
            + this.y_axis_in_spe_frame[2] * this.y_axis_in_spe_frame[2] * this.scale_z * this.scale_z);


        scale = Math.abs(this.y_axis_in_spe_frame[2] * this.scale_z) / scale;
        scale = 1 - scale * scale;
        // console.log("scale: ", scale);

        // if(scale<0.1){
        //     scale = 0.1;
        // }

        dy = dy / scale;


        let dx_in_spe_frame = this.x_axis_in_spe_frame[0] * dx + this.y_axis_in_spe_frame[0] * dy;
        let dy_in_spe_frame = this.x_axis_in_spe_frame[1] * dx + this.y_axis_in_spe_frame[1] * dy

        this.translation_x += dx_in_spe_frame;
        this.translation_y += dy_in_spe_frame;

        this.drawScene();
    }


    /**
     * Update the color buffer.
     * @param {Uint8Array} colors 
     */
    update_colors(colors) {
        this.gl.bindBuffer(this.gl.ARRAY_BUFFER, this.colorBuffer);
        this.gl.bufferData(this.gl.ARRAY_BUFFER, colors, this.gl.STATIC_DRAW);
    }

    /**
     * Draw the scene.
     * @param {number} flag 0: draw the contour plot, 1: draw and return the image data
     */
    drawScene(flag = 0) {

        this.gl.viewport(0, 0, this.gl.canvas.width, this.gl.canvas.height);

        // Clear the canvas. Set background color to white
        this.gl.clearColor(1, 1, 1, 1);
        this.gl.clear(this.gl.COLOR_BUFFER_BIT | this.gl.DEPTH_BUFFER_BIT);

        // Turn on culling. By default backfacing triangles
        // will be culled.
        // this.gl.enable(this.gl.CULL_FACE);

        // Enable the depth buffer
        this.gl.enable(this.gl.DEPTH_TEST);

        this.gl.useProgram(this.program);


        this.gl.enableVertexAttribArray(this.positionLocation);
        // Bind the position buffer.
        this.gl.bindBuffer(this.gl.ARRAY_BUFFER, this.positionBuffer);

        /**
         * Tell the attribute how to get data out of positionBuffer (ARRAY_BUFFER)
         * In our case, the data will not change, so we will use STATIC_DRAW in load_file() call
         * and we only need to call vertexAttribPointer once when initializing the program
         */
        var size = 3;          // 3 components per iteration
        var type = this.gl.FLOAT;   // the data is 32bit floats
        var normalize = false; // don't normalize the data
        var stride = 0;        // 0 = move forward size * sizeof(type) each iteration to get the next position
        var offset = 0;        // start at the beginning of the buffer
        this.gl.vertexAttribPointer(this.positionLocation, size, type, normalize, stride, offset);


        // Turn on the color attribute
        this.gl.enableVertexAttribArray(this.colorLocation);
        // Bind the color buffer.
        this.gl.bindBuffer(this.gl.ARRAY_BUFFER, this.colorBuffer);
        // Tell the attribute how to get data out of colorBuffer (ARRAY_BUFFER)
        var size = 3;                 // 3 components per iteration
        var type = this.gl.UNSIGNED_BYTE;  // the data is 8bit unsigned values
        var normalize = true;         // normalize the data (convert from 0-255 to 0-1)
        var stride = 0;               // 0 = move forward size * sizeof(type) each iteration to get the next position
        var offset = 0;               // start at the beginning of the buffer
        this.gl.vertexAttribPointer(this.colorLocation, size, type, normalize, stride, offset);

        if (this.drawing_flag == 1) {
            // Turn on the normal attribute
            this.gl.enableVertexAttribArray(this.normalLocation);

            // Bind the normal buffer.
            this.gl.bindBuffer(this.gl.ARRAY_BUFFER, this.normalBuffer);

            // Tell the attribute how to get data out of normalBuffer (ARRAY_BUFFER)
            var size = 3;          // 3 components per iteration
            var type = this.gl.FLOAT;   // the data is 32bit floating point values
            var normalize = false; // normalize the data (convert from 0-255 to 0-1)
            var stride = 0;        // 0 = move forward size * sizeof(type) each iteration to get the next position
            var offset = 0;        // start at the beginning of the buffer
            this.gl.vertexAttribPointer(this.normalLocation, size, type, normalize, stride, offset)
        }



        var translation = [this.translation_x, this.translation_y, this.translation_z];
        var rotation = [this.degToRad(this.rotation_x), this.degToRad(this.rotation_y), this.degToRad(this.rotation_z)];

        /**
         * Compute the matrix.
         * Remember that the order of the operations is reversed.
         */
        var fieldOfViewRadians = this.degToRad(this.fov);
        var aspect = this.gl.canvas.clientWidth / this.gl.canvas.clientHeight;
        var zNear = 80000;
        var zFar = 110000;
        var matrix = m4.perspective(fieldOfViewRadians, aspect, zNear, zFar);

        /**
         * Translate the object to -100000 before apply perspective
         */
        matrix = m4.translate(matrix, 0, 0, translation[2]);



        /**
         * Operations to rotate the object, using current center as pivot
         * Z rotation first, followed by X rotation (remember that the order of the operations is reversed)
         */
        matrix = m4.xRotate(matrix, rotation[0]);
        matrix = m4.zRotate(matrix, rotation[2]);

        /**
         * Scale y,z axis, using current center as pivot
         */
        matrix = m4.scale(matrix, 1, this.scale_y, this.scale_z);

        /**
         * Translate along original X and Y axis first.
         */
        matrix = m4.translate(matrix, translation[0], translation[1], 0);


        /**
         * Get projected coordinates of spectrum center in world frame
         */
        let spectrum_center = m4.multiply_vec(matrix, [0, 0, 0, 1]);
        // console.log("spectrum_center: ", spectrum_center);

        /**
         * Get the inverse of the matrix
         */
        let inverse_matrix = m4.inverse(matrix);

        /**
         * inverse_matrix * [ 1 , 0, 0, 0] = vector in spectrum frame for x axis in world frame
         * inverse_matrix * [ 0 , 1, 0, 0] = vector in spectrum frame for y axis in world frame
         */
        let spectrum_center_move_x = [...spectrum_center];
        spectrum_center_move_x[0] += spectrum_center[3];
        let spectrum_center_move_y = [...spectrum_center];
        spectrum_center_move_y[1] += spectrum_center[3];

        this.x_axis_in_spe_frame = m4.multiply_vec(inverse_matrix, spectrum_center_move_x);
        this.y_axis_in_spe_frame = m4.multiply_vec(inverse_matrix, spectrum_center_move_y);


        // console.log("x_axis_in_spe_frame: ", this.x_axis_in_spe_frame);
        // console.log("y_axis_in_spe_frame: ", this.y_axis_in_spe_frame);

        this.gl.uniformMatrix4fv(this.matrixLocation, false, matrix);

        if (this.drawing_flag == 1) {
            /**
             * We also need a matrix to rotate the normal vectors
             */
            let normal_matrix = m4.identity();
            normal_matrix = m4.xRotate(normal_matrix, rotation[0]);
            normal_matrix = m4.zRotate(normal_matrix, rotation[2]);
            normal_matrix = m4.scale(normal_matrix, 1, this.scale_y, this.scale_z);

            /**
             * With aspect ratio change, we need to do these steps to make sure the normal vectors are rotated correctly
             */
            normal_matrix = m4.inverse(normal_matrix);
            normal_matrix = m4.transpose(normal_matrix);

            this.gl.uniformMatrix4fv(this.normalMatrixLocation, false, normal_matrix);

            /**
             * Calculate the light direction in world frame using this.light_tilt and this.light_rotation
             */
            let light_direction = [Math.cos(this.degToRad(this.light_tilt)) * Math.cos(this.degToRad(this.light_orientation)),
            Math.cos(this.degToRad(this.light_tilt)) * Math.sin(this.degToRad(this.light_orientation)),
            Math.sin(this.degToRad(this.light_tilt))];

            // console.log("light_direction: ", light_direction);

            this.gl.uniform3fv(this.reverseLightDirectionLocation, m4.normalize(light_direction));
        }

        // Draw all the triangles
        var primitiveType = this.gl.TRIANGLES;
        var offset = 0;
        var count = this.data_length;
        this.gl.drawArrays(primitiveType, offset, count);

        if (flag == 1) {
            return this.gl.canvas.toDataURL();
        }
    };

};



