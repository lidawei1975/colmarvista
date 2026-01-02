var my_contour_worker;

try {
    my_contour_worker = new Worker('./js/contour_3d.js');
}
catch (err) {
    console.log(err);
    if (typeof (my_contour_worker) === "undefined") {
        alert("Failed to load WebWorker, probably due to browser incompatibility. Please use a modern browser, if you run this program locally, please read the instructions titled 'How to run COLMAR Viewer locally'");
    }
}

function get_data_new(triangle_2d, z_shift) {
    var data = new Float32Array(triangle_2d.length * 3);

    for (let i = 0; i < triangle_2d.length; i++) {
        data[i * 3] = triangle_2d[i][1];
        data[i * 3 + 1] = triangle_2d[i][0];
        data[i * 3 + 2] = triangle_2d[i][2] + z_shift;
    }
    return data;
}


/**
 * The class for the contour plot
 */
var main_plot = null;
/**
 * Some math tools
 */
const mathTool = new ldwmath();
/**
 * Number of surface points and contour vertices (3 vertices per triangle)
 * (size of data array is 3 * n_surface_points and 3 * n_contour_points, because each vertex has 3 coordinates)
 */
var n_surface_points = 0;
var n_contour_points = 0;

/**
 * coordinates and colors will be defined as global variables in the onmessage function
 * my_contour_worker.onmessage
 */

$(document).ready(function () {


    fetch('navbar.html')
        .then(response => response.text())
        .then(data => {
            document.getElementById('navbar-placeholder').innerHTML = data;
        });

    /**
     * Resize observer for the big plot
     */
    plot_div_resize_observer.observe(document.getElementById("canvas_container"));

    document.getElementById('ft2_file_form').addEventListener('submit', function (e) {
        e.preventDefault();
        var file = document.getElementById('userfile').files[0];
        var reader = new FileReader();
        reader.onload = function (e) {
            var spe = process_ft_file(e.target.result, "test.ft2", 0);

            /**
             * Rescale spe.raw_data to [0,250], using spe.spectral_max and spe.spectral_min
             */
            let new_spectrum_data = new Float32Array(spe.raw_data.length);
            for (let i = 0; i < spe.raw_data.length; i++) {
                new_spectrum_data[i] = 255 * spe.raw_data[i] / spe.spectral_max;
            }

            let minimal_level = spe.noise_level * 2.5 * 250 / spe.spectral_max;

            let levels = [minimal_level];

            /**
             * Get radio group name "contour_type" 
             */
            let contour_type = document.querySelector('input[name="contour_type"]:checked').value;

            if (contour_type == "Logarithmic") {
                let n_levels = Math.log(250 / minimal_level) / Math.log(1.4);
                for (let i = 0; i < n_levels - 1; i++) {
                    levels.push(levels[i] * 1.4);
                }
            }
            else if (contour_type == "Linear") {
                let scale = 15;
                let minimal_level2 = minimal_level * scale;
                let n_levels = Math.floor(250 / minimal_level2);
                for (let i = 2; i < scale; i++) {
                    levels.push(minimal_level * i);
                }
                for (let i = 1; i < n_levels; i++) {
                    levels.push(minimal_level2 * i);
                }
            }
            else // "Logarithmic and Linear"
            {
                /**
                 * First 10 levels are logarithmic at 1.4 then linear
                 */
                for (let i = 1; i < 10; i++) {
                    levels.push(minimal_level * Math.pow(1.4, i));
                }
                let current_level = levels[9];
                let n_levels = Math.floor(250 / current_level);
                for (let i = 2; i < n_levels; i++) {
                    levels.push(current_level * i);
                }
            }

            /**
             * Calculate contour lines and surface triangles
             */
            let line_thickness = 400 / spe.n_direct;

            /**
             * Get user options from radio group name "plot_type"
             */
            let plot_type = document.querySelector('input[name="plot_type"]:checked').value;
            let plot_type_int = 0;

            /**
             * Convert to integer. 0: smooth surface, 1: terrace surface
             */
            if (plot_type == "terrace") {
                plot_type_int = 1;
            }
            else {
                plot_type_int = 0;
            }


            my_contour_worker.postMessage({
                n_direct: spe.n_direct,
                n_indirect: spe.n_indirect,
                levels: levels,
                new_spectrum_data: new_spectrum_data,
                line_thickness: line_thickness,
                plot_type_int: plot_type_int
            });
        };
        reader.readAsArrayBuffer(file);
    });
});


my_contour_worker.onmessage = (e) => {
    if (e.data.message) {
        document.getElementById("contour_message").innerText = e.data.message;
    }
    else if (e.data.workerResult) {
        document.getElementById("contour_message").innerText = "";

        let workerResult = e.data.workerResult;

        n_surface_points = workerResult.triangle_surface.length;
        n_contour_points = workerResult.triangle_contour.length;

        /**
         * Create 3 cylinders for the x,y,z axis
         */
        let x_axis_triangle = [];
        let y_axis_triangle = [];
        let z_axis_triangle = [];

        /**
         * Create a polygon to simulate a circle with 36 vertices
         * These vertices are named as in yz plane, but are used 3 times to create a circle in yz, xz, xy planes
         */
        let x_axis_y = new Array(37);
        let x_axis_z = new Array(37);
        for (let angle_i = 0; angle_i <= 36; angle_i += 1) {
            x_axis_y[angle_i] = 0.5 * Math.cos(angle_i / 18 * Math.PI);
            x_axis_z[angle_i] = 0.5 * Math.sin(angle_i / 18 * Math.PI);
        }


        for (let i = 0; i < 36; i++) {
            /**
             * x axis cylinder
             */
            let p1 = [0, x_axis_y[i], x_axis_z[i]];
            let p2 = [0, x_axis_y[i + 1], x_axis_z[i + 1]];
            let p3 = [workerResult.n_direct, x_axis_y[i], x_axis_z[i]];
            let p4 = [workerResult.n_direct, x_axis_y[i + 1], x_axis_z[i + 1]];
            x_axis_triangle.push(p1);
            x_axis_triangle.push(p2);
            x_axis_triangle.push(p3);
            x_axis_triangle.push(p2);
            x_axis_triangle.push(p3);
            x_axis_triangle.push(p4);

            /**
             * y axis cylinder
             */
            p1 = [x_axis_y[i], 0, x_axis_z[i]];
            p2 = [x_axis_y[i + 1], 0, x_axis_z[i + 1]];
            p3 = [x_axis_y[i], workerResult.n_indirect, x_axis_z[i]];
            p4 = [x_axis_y[i + 1], workerResult.n_indirect, x_axis_z[i + 1]];
            y_axis_triangle.push(p1);
            y_axis_triangle.push(p2);
            y_axis_triangle.push(p3);
            y_axis_triangle.push(p2);
            y_axis_triangle.push(p3);
            y_axis_triangle.push(p4);

            /**
             * Z axis cylinder
             */
            p1 = [x_axis_y[i], x_axis_z[i], 0];
            p2 = [x_axis_y[i + 1], x_axis_z[i + 1], 0];
            p3 = [x_axis_y[i], x_axis_z[i], 255];
            p4 = [x_axis_y[i + 1], x_axis_z[i + 1], 255];
            z_axis_triangle.push(p1);
            z_axis_triangle.push(p2);
            z_axis_triangle.push(p3);
            z_axis_triangle.push(p2);
            z_axis_triangle.push(p3);
            z_axis_triangle.push(p4);
        }


        /**
         * Convert workerResult.triangle_surface to Float32Array
         */
        let total_size = workerResult.triangle_surface.length * 3 + workerResult.triangle_contour.length * 3;
        total_size += x_axis_triangle.length * 3 + y_axis_triangle.length * 3 + z_axis_triangle.length * 3;
        window.coordinates = new Float32Array(total_size);
        window.colors = new Uint8Array(total_size);
        let normals = null;
        if (workerResult.plot_type_int == 1) {
            normals = new Float32Array(workerResult.triangle_surface.length * 3);
        }

        /**
         * Get color from the color picker with id "color_surface"
         * "#ff0000" is red, "#00ff00" is green, "#0000ff" is blue
        */
        let color = document.getElementById("color_surface").value;
        let color_rgb = mathTool.hexToDec(color);

        for (let i = 0; i < workerResult.triangle_surface.length; i++) {
            coordinates[i * 3] = workerResult.triangle_surface[i][0];
            coordinates[i * 3 + 1] = workerResult.triangle_surface[i][1];
            coordinates[i * 3 + 2] = workerResult.triangle_surface[i][2];

            if (workerResult.plot_type_int == 1) {
                normals[i * 3] = workerResult.triangle_normals[i][0];
                normals[i * 3 + 1] = workerResult.triangle_normals[i][1];
                normals[i * 3 + 2] = workerResult.triangle_normals[i][2];
            }

            window.colors[i * 3] = color_rgb[0];
            window.colors[i * 3 + 1] = color_rgb[1];
            window.colors[i * 3 + 2] = color_rgb[2];
        }


        /**
         * number of vertices of the surface
         */
        let n = workerResult.triangle_surface.length * 3;
        /**
         * Get color from the color picker with id "color_contour"
         */
        let color_line = document.getElementById("color_contour").value;
        let color_rgb_line = mathTool.hexToDec(color_line);

        for (let i = 0; i < workerResult.triangle_contour.length; i++) {
            /**
             * Shift z value by 1 to separate the surface and contour lines
             * (make sure the contour lines are above the surface to ensure visibility)
             */
            coordinates[n + i * 3] = workerResult.triangle_contour[i][0];
            coordinates[n + i * 3 + 1] = workerResult.triangle_contour[i][1];
            coordinates[n + i * 3 + 2] = workerResult.triangle_contour[i][2] + 1;


            window.colors[n + i * 3] = color_rgb_line[0];
            window.colors[n + i * 3 + 1] = color_rgb_line[1];
            window.colors[n + i * 3 + 2] = color_rgb_line[2];
        }

        /**
         * number of vertices of the surface and contour lines
        */
        n += workerResult.triangle_contour.length * 3;

        for (let i = 0; i < x_axis_triangle.length; i++) {
            coordinates[n + i * 3] = x_axis_triangle[i][0];
            coordinates[n + i * 3 + 1] = x_axis_triangle[i][1];
            coordinates[n + i * 3 + 2] = x_axis_triangle[i][2];

            /**
             * Red color for the x axis
             */
            window.colors[n + i * 3] = 200;
            window.colors[n + i * 3 + 1] = 0;
            window.colors[n + i * 3 + 2] = 0;
        }

        n += x_axis_triangle.length * 3;

        for (let i = 0; i < y_axis_triangle.length; i++) {
            coordinates[n + i * 3] = y_axis_triangle[i][0];
            coordinates[n + i * 3 + 1] = y_axis_triangle[i][1];
            coordinates[n + i * 3 + 2] = y_axis_triangle[i][2];

            /**
             * Blue color for the y axis
             */
            window.colors[n + i * 3] = 0;
            window.colors[n + i * 3 + 1] = 0;
            window.colors[n + i * 3 + 2] = 200;
        }

        n += y_axis_triangle.length * 3;

        for (let i = 0; i < z_axis_triangle.length; i++) {
            coordinates[n + i * 3] = z_axis_triangle[i][0];
            coordinates[n + i * 3 + 1] = z_axis_triangle[i][1];
            coordinates[n + i * 3 + 2] = z_axis_triangle[i][2];

            /**
             * Green color for the z axis
             */
            window.colors[n + i * 3] = 0;
            window.colors[n + i * 3 + 1] = 200;
            window.colors[n + i * 3 + 2] = 0;
        }


        /**
         * Resize container to default 900X900 first
         */
        document.getElementById('canvas_container').style.width = "900px";
        document.getElementById('canvas_container').style.height = "900px";
        main_plot = new webgl_contour_plot_3d('canvas1', coordinates, normals, colors, workerResult.n_direct, workerResult.n_indirect, workerResult.plot_type_int);
        resize_main_plot(document.getElementById('canvas_container').clientWidth, document.getElementById('canvas_container').clientHeight);

        /**
         * After first draw, need to resize to set correct viewport
         */
        main_plot.drawScene();
        create_event_listener(main_plot);

        document.getElementById("contour_message").innerText = "";

        document.getElementById("file_area").style.display = "none";

    }
}


function create_event_listener() {
    /**
 * Add event listener for range sliders rotation_x, rotation_y, rotation_z
 */
    document.getElementById('rotation_x').addEventListener('input', function () {
        main_plot.rotation_x = this.value;
        main_plot.drawScene();
    });

    document.getElementById('rotation_z').addEventListener('input', function () {
        main_plot.rotation_z = this.value;
        main_plot.drawScene();
    });

    document.getElementById('scale_y').addEventListener('input', function () {
        main_plot.scale_y = this.value;
        main_plot.drawScene();
    });


    document.getElementById('scale_z').addEventListener('input', function () {
        main_plot.scale_z = this.value;
        main_plot.drawScene();
    });


    /**
     * Drag event listener for canvas1
     */
    document.getElementById('canvas1').addEventListener('mousedown', function (e) {
        main_plot.dragging = true;
        main_plot.lastX = e.offsetX;
        main_plot.lastY = e.offsetY;
    });

    document.getElementById('canvas1').addEventListener('mousemove', function (e) {
        if (main_plot.dragging) {
            let dx = e.offsetX - main_plot.lastX;
            let dy = e.offsetY - main_plot.lastY;
            main_plot.lastX = e.offsetX;
            main_plot.lastY = e.offsetY;

            main_plot.drag(dx, dy);

            main_plot.drawScene();
        }
    });

    document.getElementById('canvas1').addEventListener('mouseup', function (e) {
        main_plot.dragging = false;
    });

    /**
     * Mouse wheel event listener for canvas1
     * main_plot.fov is the field of view of the camera, min: 0.05, max: 5
     */
    document.getElementById('canvas1').addEventListener('wheel', function (e) {
        let delta = e.deltaY;
        if (delta > 0) {
            main_plot.fov *= 1.1;
        } else {
            main_plot.fov *= 0.9;
        }
        if (main_plot.fov < 0.01) {
            main_plot.fov = 0.01;
        }
        if (main_plot.fov > 5) {
            main_plot.fov = 5;
        }
        main_plot.drawScene();
    });



    /**
     * Add event listener for light_tilt and light_orientation
     */
    document.getElementById('light_tilt').addEventListener('input', function () {
        main_plot.light_tilt = this.value;
        main_plot.drawScene();
    });

    document.getElementById('light_orientation').addEventListener('input', function () {
        main_plot.light_orientation = this.value;
        main_plot.drawScene();
    });
}

function update_color(flag) {
    if (flag === 0) {
        /**
         * Get color from the color picker with id "color_surface"
         * "#ff0000" is red, "#00ff00" is green, "#0000ff" is blue
         */
        let color = document.getElementById("color_surface").value;
        let color_rgb = mathTool.hexToDec(color);
        /**
         * Change the color of the surface to the new color
         */
        for (let i = 0; i < n_surface_points; i++) {
            window.colors[i * 3] = color_rgb[0];
            window.colors[i * 3 + 1] = color_rgb[1];
            window.colors[i * 3 + 2] = color_rgb[2];
        }
        main_plot.update_colors(window.colors);
        main_plot.drawScene();
    }
    else {
        /**
         * Get color from the color picker with id "color_contour"
         */
        let color = document.getElementById("color_contour").value;
        let color_rgb = mathTool.hexToDec(color);
        /**
         * Change the color of the contour lines to the new color
         */
        for (let i = n_surface_points; i < n_surface_points + n_contour_points; i++) {
            window.colors[i * 3] = color_rgb[0];
            window.colors[i * 3 + 1] = color_rgb[1];
            window.colors[i * 3 + 2] = color_rgb[2];
        }
        main_plot.update_colors(window.colors);
        main_plot.drawScene();
    }
};

function process_ft_file(arrayBuffer, file_name, spectrum_type) {

    document.getElementById("contour_message").innerText = "Processing file " + file_name;

    let result = new spectrum();

    result.spectrum_origin = spectrum_type;

    result.header = new Float32Array(arrayBuffer, 0, 512);

    result.n_indirect = result.header[219]; //size of indirect dimension of the input spectrum
    result.n_direct = result.header[99]; //size of direct dimension of the input spectrum

    result.tp = result.header[221];

    /**
     * if transposed, set result.error and return
     */
    if (result.tp !== 0) {
        result.error = "Transposed data, please un-transpose the data before loading";
        return result;
    }

    /**
     * Datatype of the direct and indirect dimension
     * 0: complex
     * 1: real
     */
    result.datatype_direct = result.header[55];
    result.datatype_indirect = result.header[56];

    /**
     * We only read real at this moment
     */
    if (result.datatype_direct !== 1 || result.datatype_indirect !== 1) {
        result.error = "Only real data is supported";
        return result;
    }

    result.direct_ndx = result.header[24]; //must be 2
    result.indirect_ndx = result.header[25]; //must be 1 or 3
    /**
     * direct_ndx must be 1, otherwise set error and return
     */
    if (result.direct_ndx !== 2) {
        result.error = "Direct dimension must be the second dimension";
        return result;
    }
    /**
     * indirect_ndx must be 1 or 3, otherwise set error and return
     */
    if (result.indirect_ndx !== 1 && result.indirect_ndx !== 3) {
        result.error = "Indirect dimension must be the first or third dimension";
        return result;
    }

    /**
     * result.sw, result.frq,result.ref are the spectral width, frequency and reference of the direct dimension
     * All are array of length 4
     */
    result.sw = [];
    result.frq = [];
    result.ref = [];

    result.sw[0] = result.header[229];
    result.sw[1] = result.header[100];
    result.sw[2] = result.header[11];
    result.sw[3] = result.header[29];

    result.frq[0] = result.header[218];
    result.frq[1] = result.header[119];
    result.frq[2] = result.header[10];
    result.frq[3] = result.header[28];

    result.ref[0] = result.header[249];
    result.ref[1] = result.header[101];
    result.ref[2] = result.header[12];
    result.ref[3] = result.header[30];

    /**
     * Get ppm_start, ppm_width, ppm_step for both direct and indirect dimensions
     */
    result.sw1 = result.sw[result.direct_ndx - 1];
    result.sw2 = result.sw[result.indirect_ndx - 1];
    result.frq1 = result.frq[result.direct_ndx - 1];
    result.frq2 = result.frq[result.indirect_ndx - 1];
    result.ref1 = result.ref[result.direct_ndx - 1];
    result.ref2 = result.ref[result.indirect_ndx - 1];


    result.x_ppm_start = (result.ref1 + result.sw1) / result.frq1;
    result.x_ppm_width = result.sw1 / result.frq1;
    result.y_ppm_start = (result.ref2 + result.sw2) / result.frq2;
    result.y_ppm_width = result.sw2 / result.frq2;
    result.x_ppm_step = -result.x_ppm_width / result.n_direct;
    result.y_ppm_step = -result.y_ppm_width / result.n_indirect;

    /**
     * shift by half of the bin size because the contour plot is defined by the center of each bin
     */
    result.x_ppm_start -= result.x_ppm_width / result.n_direct / 2;
    result.y_ppm_start -= result.y_ppm_width / result.n_indirect / 2;

    result.x_ppm_ref = 0.0;
    result.y_ppm_ref = 0.0;


    let data_size = arrayBuffer.byteLength / 4 - 512;

    result.raw_data = new Float32Array(arrayBuffer, 512 * 4, data_size);

    /**
     * Keep original file name
     */
    result.filename = file_name;


    result.noise_level = mathTool.estimate_noise_level(result.n_direct, result.n_indirect, result.raw_data);

    /**
     * Get max and min of z (z is sorted)
     */
    [result.spectral_max, result.spectral_min] = mathTool.find_max_min(result.raw_data);

    /**
     * In case of reconstructed spectrum from fitting or from NUS, noise_level is usually 0.
     * In that case, we define noise_level as spectral_max/power(1.5,40)
     */
    if (result.noise_level <= Number.MIN_VALUE) {
        result.noise_level = result.spectral_max / Math.pow(1.5, 40);
    }

    document.getElementById("contour_message").innerText = "Finished processing file " + file_name;

    return result;
}


var plot_div_resize_observer = new ResizeObserver(entries => {
    for (let entry of entries) {
        const cr = entry.contentRect;
        resize_main_plot(cr.width, cr.height);
    }
});


function resize_main_plot(canvas_width, canvas_height) {

    console.log("new width is ", canvas_width, " new height is ", canvas_height);

    if (main_plot !== null) {
        document.getElementById('canvas1').style.width = canvas_width.toString() + "px";
        document.getElementById('canvas1').style.height = canvas_height.toString() + "px";
        document.getElementById('canvas1').setAttribute("height", canvas_height.toString());
        document.getElementById('canvas1').setAttribute("width", canvas_width.toString());
        main_plot.drawScene();
    }

}



function download_figure() {

    var dataUrl = main_plot.drawScene(1); //draw the scene with download flag set to 1

    /**
     * Download the image
     */
    const a = document.createElement('a');
    a.href = dataUrl;
    a.download = 'nmr_plot.png';
    a.click();
}