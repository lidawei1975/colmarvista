
/**
 * Constructor for plotit object.
 * @param {*} input 
 */
function plotit(input) {
    this.show_peak = 1;


    this.xscales = new Array();
    this.yscales = new Array();


    this.xscale = [input.x_ppm_start, input.x_ppm_start + input.x_ppm_step * input.n_direct];
    this.yscale = [input.y_ppm_start, input.y_ppm_start + input.y_ppm_step * input.n_indirect];

    

    this.HEIGHT = input.HEIGHT;
    this.WIDTH = input.WIDTH;
    this.MARGINS = input.MARGINS;
    this.PointData = input.PointData;
    this.drawto = input.drawto;
    this.drawto_legend = input.drawto_legend;
    this.drawto_peak = input.drawto_peak;
    this.size = input.size;
    this.data1 = [];  //peaks that match compound
    this.data2 = [];  //remove it??

    this.inter_window_channel = input.inter_window_channel; //for inter-window coupling


    this.left = -1000;
    this.righ = 1000;
    this.top = 1000;
    this.bottom = -1000;

    this.drawto_contour = input.drawto_contour;

    this.x_ppm_start = input.x_ppm_start;
    this.x_ppm_step = input.x_ppm_step;
    this.y_ppm_start = input.y_ppm_start;
    this.y_ppm_step = input.y_ppm_step;

    /**
     * Flag to draw horizontal and vertical cross section. IF not set in input, default is off
     */
    this.horizontal = input.horizontal ? input.horizontal : false;
    this.vertical = input.vertical ? input.vertical : false;

    this.spectral_order = [];

    this.peak_level = 0.0;

    this.allow_brush_to_remove = false; //default is false

    this.peak_color = "#FF0000"; //default color is red
    this.peak_color_scale = d3.scaleSequential(d3.interpolateRdBu); //default color scale is Red-Blue. 
    this.peak_color_flag = 'SOLID'; //default is solid, can be a color-map, depending on some peak properties
    this.peak_size = 6;
    this.peak_thickness = 5;

    this.font_size = 24; //default font size is 24 for peak labels

    /**
     * Init cross section plot
     * At this time, height is 200, width is the same as the main plot
     * data is empty
     * x_domain is this.xcale
     * y_domain is [0,1]
     */
    this.current_spectral_index = -1;
    this.b_show_cross_section = false;
    this.b_show_projection = false; 
    this.x_cross_section_plot = new cross_section_plot(this);
    this.x_cross_section_plot.init( this.WIDTH, 200, this.xscale, [0, 1],{ top: 10, right: this.MARGINS.right, bottom: 10, left: this.MARGINS.left }, "cross_section_svg_x","horizontal");
    this.y_cross_section_plot = new cross_section_plot(this);
    this.y_cross_section_plot.init(200, this.HEIGHT,[0, 1], this.yscale, { top: this.MARGINS.top, right: 10, bottom: this.MARGINS.bottom, left: 10 }, "cross_section_svg_y",'vertical');

    this.lastCallTime_zoom_x = Date.now();
    this.lastCallTime_zoom_y = Date.now();

    this.predicted_peaks = [];

    this.zoom_on_call_function = null;


    this.hline_ppm = null;
    this.vline_ppm = null;
    this.cross_line_timeout = null;
    this.cross_line_pause_flag = document.getElementById("pause_cursor").checked;

    this.magnifying_glass = false;
    this.magnifying_glass_ratio = 4.0; //default is 2.0
    this.magnifying_glass_size = 10; //default is 10% of the plot size
};

plotit.prototype.enable_magnifying_glass = function (flag,ratio, size) {
    this.magnifying_glass = flag ? flag : false; //default is false
    this.magnifying_glass_ratio = ratio ? ratio : 4.0; //default is 4.0
    this.magnifying_glass_size = size ? size : 10; //default is 10% of the plot size
};



/**
 * Set a on call function for zoom event
 */
plotit.prototype.set_zoom_on_call_function = function (func) {
    if(zoom_on_call_function === null) {
        this.zoom_on_call_function = func;
    }
    else {
        console.log("zoom_on_call_function is already set. Can't set it again");
    }
    
};

/**
 * Called when user resize the plot
 * @param {*} input 
 */
plotit.prototype.update = function (input) {

    var self = this;

    this.HEIGHT = input.HEIGHT;
    this.WIDTH = input.WIDTH;


    this.xRange.range([this.MARGINS.left, this.WIDTH - this.MARGINS.right]);
    this.yRange.range([this.HEIGHT - this.MARGINS.bottom, this.MARGINS.top]);


    this.xAxis.scale(this.xRange);
    this.yAxis.scale(this.yRange);


    /**
     * Update brush extent
     */
    this.brush = d3.brush()
    .extent([[0, 0], [this.WIDTH, this.HEIGHT]])
    .on("end", this.brushend.bind(this));

    this.brush_element.call(this.brush);


    this.lineFunc.x(function (d) { return self.xRange(d[0]); })
        .y(function (d) { return self.yRange(d[1]); })
        .curve(d3.curveBasis);


    this.xAxis_svg.attr('transform', 'translate(0,' + (this.HEIGHT - this.MARGINS.bottom) + ')').call(this.xAxis);
    this.yAxis_svg.attr('transform', 'translate(' + (this.MARGINS.left) + ',0)').call(this.yAxis);



    this.vis.selectAll('.xlabel').attr("x", this.WIDTH / 2).attr("y", this.HEIGHT);
    this.vis.selectAll('.ylabel').attr("y", this.HEIGHT / 2).attr("transform", "rotate(-90 12," + this.HEIGHT / 2 + ")");




    this.rect
        .attr("x", this.MARGINS.left)
        .attr("y", this.MARGINS.top)
        .attr("width", this.WIDTH - this.MARGINS.right - this.MARGINS.left)
        .attr("height", this.HEIGHT - this.MARGINS.bottom - this.MARGINS.top);


    /**
     * Update webgl contour. No need to update view
     */
    // this.contour_plot.setCamera_ppm(this.xscale[0], this.xscale[1], this.yscale[0], this.yscale[1]);
    this.contour_plot.drawScene();

    /**
     * Update peaks if there is any
     */
    this.reset_axis();

    this.x_cross_section_plot.resize_x(this.WIDTH);
    this.y_cross_section_plot.resize_y(this.HEIGHT);

};


/**
 * When zoom or resize, we need to reset the axis
 */
plotit.prototype.reset_axis = function () {

    let self = this;

    this.xAxis_svg.call(this.xAxis);
    this.yAxis_svg.call(this.yAxis);
    this.vis.selectAll(".xaxis>.tick>text")
        .each(function () {
            d3.select(this).style("font-size", "20px");
        });
    this.vis.selectAll(".yaxis>.tick>text")
        .each(function () {
            d3.select(this).style("font-size", "20px");
        });

    /**
     * Reset the position of peaks
     */
    this.vis.selectAll('.peak')
        .attr('cx', function (d) {
            return self.xRange(d.X_PPM);
        })
        .attr('cy', function (d) {
            return self.yRange(d.Y_PPM);
        });

    /**
     * Also need to reset the position of peak text
     */
    this.vis.selectAll('.peak_text')
        .attr('x', function (d) {
            d.x = self.xRange(d.X_TEXT_PPM);
            return d.x;
        })
        .attr('y', function (d) {
            d.y = self.yRange(d.Y_TEXT_PPM);
            return d.y;
        });

    /**
     * Reset peak_line as well
     */
    this.vis.selectAll('.peak_line')
        .attr('x2', function (d) {
            return self.xRange(d.X_PPM);
        })
        .attr('y2', function (d) {
            return self.yRange(d.Y_PPM);
        })
        .attr('x1', function (d) {
            if(Math.abs(d.x - self.xRange(d.X_PPM)) > Math.abs(d.y - self.yRange(d.Y_PPM)))
            {
                if(d.x > self.xRange(d.X_PPM))
                {
                    return d.x - d.text_width/2;
                }
                else
                {
                    return d.x + d.text_width/2;
                }
            }
            else
            {
                return d.x;
            }
        })
        .attr('y1', function (d) {
            if(Math.abs(d.x - self.xRange(d.X_PPM)) > Math.abs(d.y - self.yRange(d.Y_PPM)))
            {
                return d.y;
            }
            else
            {
                if(d.y > self.yRange(d.Y_PPM))
                {
                    return d.y - 0.5*self.font_size;
                }
                else
                {
                    return d.y + 0.5*self.font_size;
                }
            }
        });

    /**
     * Reset position of predicted peaks, if any
     */
    self.x = d3.scaleLinear().range([self.MARGINS.left, self.WIDTH - self.MARGINS.right])
    .domain(self.xscale);
    self.y = d3.scaleLinear().range([self.HEIGHT - self.MARGINS.bottom, self.MARGINS.top])
        .domain(self.yscale);

    self.line = d3.line()
    .x((d) => self.x(d[0]))
    .y((d) => self.y(d[1]));

    for(let i=0;i<this.predicted_peaks.length;i++) {
        this.vis.selectAll('.predicted_peak_'+i)
        .attr("d", self.line(this.predicted_peaks[i]));
    }


    /**
     * Reset vline and hline
     */
    this.vis.selectAll(".hline").attr("d", self.lineFunc(self.hline_data));
    this.vis.selectAll(".vline").attr("d", self.lineFunc(self.vline_data));

    if(this.zoom_on_call_function) {
        this.zoom_on_call_function();
    }
};



/**
 * Oncall function for brush end event for zooming
 * @param {event} e 
 */
plotit.prototype.brushend = function (e) {

    /**
     * if e.selection is null, then it is a click event or clear brush event
     */
    if (!e.selection) {
        return;
    }

    let self = this;

    /**
     * IF allow_brush_to_remove is true, then do not zoom.
     * Remove all peaks within the brush
     * Remove the brush and return
     */
    if(this.allow_brush_to_remove && self.spectrum != null && self.peak_flag ==='picked') {
        this.vis.select(".brush").call(this.brush.move, null);
        let brush_x_ppm_start = self.xRange.invert(e.selection[0][0]);
        let brush_x_ppm_end   = self.xRange.invert(e.selection[1][0]);
        let brush_y_ppm_start = self.yRange.invert(e.selection[1][1]);
        let brush_y_ppm_end   = self.yRange.invert(e.selection[0][1]);

        /**
         * Make sure brush_x_ppm_start < brush_x_ppm_end and brush_y_ppm_start < brush_y_ppm_end
         * Their order depends on the direction of the brush operation by the user
         */
        if(brush_x_ppm_start > brush_x_ppm_end) {
            [brush_x_ppm_start, brush_x_ppm_end] = [brush_x_ppm_end, brush_x_ppm_start];
        }
        if(brush_y_ppm_start > brush_y_ppm_end) {
            [brush_y_ppm_start, brush_y_ppm_end] = [brush_y_ppm_end, brush_y_ppm_start];
        }

        /**
         * Remove all peaks within the brush.
         * This step can't be undone !!
         */
        self.spectrum.picked_peaks_object.filter_by_columns_range(
            ["X_PPM","Y_PPM"],
            [brush_x_ppm_start,brush_y_ppm_start],
            [brush_x_ppm_end,brush_y_ppm_end],false);

        /**
         * Redraw peaks
         */
        self.draw_peaks();

        return;
    }

    this.xscales.push(this.xscale);
    this.yscales.push(this.yscale);
    this.xscale = [self.xRange.invert(e.selection[0][0]), self.xRange.invert(e.selection[1][0])];
    this.yscale = [self.yRange.invert(e.selection[1][1]), self.yRange.invert(e.selection[0][1])];
    /**
     * scale is in unit of ppm.
     */
    this.xRange.domain(this.xscale);
    this.yRange.domain(this.yscale);

    /**
     * Update webgl contour. No change of view is needed here
     */
    this.contour_plot.setCamera_ppm(this.xscale[0], this.xscale[1], this.yscale[0], this.yscale[1]);
    this.contour_plot.drawScene();


    this.reset_axis();

    this.x_cross_section_plot.zoom_x(this.xscale);
    this.y_cross_section_plot.zoom_y(this.yscale);

    this.vis.select(".brush").call(this.brush.move, null);

    this.send_scales_to_other_window();
};

plotit.prototype.send_scales_to_other_window = function () {

    /**
     * Get plot_group number (from 1 to 10)
     */
    let peak_group = document.getElementById("plot_group").value;

    /**
     * Send this.xscale and this.yscale through the channel to let other windows know
     */
        if(this.inter_window_channel) {
            this.inter_window_channel.postMessage({
                type: 'zoom',
                peak_group: peak_group,
                xscale: this.xscale,
                yscale: this.yscale
            });
        }
    }

plotit.prototype.zoom_to = function (x_scale, y_scale) {
    this.xscales.push(this.xscale);
    this.yscales.push(this.yscale);
    this.xscale = x_scale;
    this.yscale = y_scale;
    this.xRange.domain(this.xscale);
    this.yRange.domain(this.yscale);
    this.contour_plot.setCamera_ppm(this.xscale[0], this.xscale[1], this.yscale[0], this.yscale[1]);
    this.contour_plot.drawScene();
    this.reset_axis();
    this.x_cross_section_plot.zoom_x(this.xscale);
    this.y_cross_section_plot.zoom_y(this.yscale);
    /**
     * No need to send scales to other window, because this function is only called when receive a message from other window
     */
}

plotit.prototype.zoom_x = function (x_ppm) {
    
    let self = this;
    this.xscale = x_ppm;
    /**
     * Save the current time. Update stack of xscales and yscales only when the time difference is greater than 1s
     */
    if (Date.now() - self.lastCallTime_zoom_x > 1000) {
        this.xscales.push(this.xscale);
        this.yscales.push(this.yscale);
        self.lastCallTime_zoom_x = Date.now();
    }
    this.xRange.domain(this.xscale);
    this.contour_plot.setCamera_ppm(this.xscale[0], this.xscale[1], this.yscale[0], this.yscale[1]);
    this.contour_plot.drawScene();
    this.reset_axis();
    this.send_scales_to_other_window();
};

plotit.prototype.zoom_y = function (y_ppm) {
    let self = this;
    this.yscale = y_ppm;
    /**
     * Save the current time. Update stack of xscales and yscales only when the time difference is greater than 1s
     */
    if (Date.now() - self.lastCallTime_zoom_y > 1000) {
        this.xscales.push(this.xscale);
        this.yscales.push(this.yscale);
        self.lastCallTime_zoom_y = Date.now();
    }
    this.yRange.domain(this.yscale);
    this.contour_plot.setCamera_ppm(this.xscale[0], this.xscale[1], this.yscale[0], this.yscale[1]);
    this.contour_plot.drawScene();
    this.reset_axis();
    this.send_scales_to_other_window();
};



plotit.prototype.popzoom = function () {

    if (this.xscales.length > 0) {
        this.xscale = this.xscales.pop();
        this.yscale = this.yscales.pop();
        this.xRange.domain(this.xscale);
        this.yRange.domain(this.yscale);

        /**
        * Update webgl contour. No need to update view
        */
        this.contour_plot.setCamera_ppm(this.xscale[0], this.xscale[1], this.yscale[0], this.yscale[1]);
        this.contour_plot.drawScene();

        this.reset_axis();
        this.x_cross_section_plot.zoom_x(this.xscale);
        this.y_cross_section_plot.zoom_y(this.yscale);
        this.send_scales_to_other_window();
    }
};

plotit.prototype.resetzoom = function (x,y) {
    /**
     * Clear the zoom stack
     */
    this.xscales = [];
    this.yscales = [];
    this.xscales.push(x);
    this.yscales.push(y);
    this.popzoom()
};


plotit.prototype.zoomout = function () {
    this.xscales.push(this.xscale);
    this.yscales.push(this.yscale);

    var m1 = this.xscale[0];
    var m2 = this.xscale[1];
    var c = 0.1 * (m1 - m2);
    m1 = m1 + c;
    m2 = m2 - c;
    this.xscale = [m1, m2];

    m1 = this.yscale[0];
    m2 = this.yscale[1];
    c = 0.1 * (m1 - m2);
    m1 = m1 + c;
    m2 = m2 - c;
    this.yscale = [m1, m2];

    this.xRange.domain(this.xscale);
    this.yRange.domain(this.yscale);

    /**
     * Because of nice. The domain may be changed. So we need to update xscale and yscale
     */
    this.xscale = this.xRange.domain();
    this.yscale = this.yRange.domain();

    /**
     * Update webgl contour. No need to update view
     */
    this.contour_plot.setCamera_ppm(this.xscale[0], this.xscale[1], this.yscale[0], this.yscale[1]);
    this.contour_plot.drawScene();
    this.reset_axis();

    this.x_cross_section_plot.zoom_x(this.xscale);
    this.y_cross_section_plot.zoom_y(this.yscale);
    this.send_scales_to_other_window();

};



/**
 * Draw the plot, including the contour plot using webgl
 */

plotit.prototype.draw = function () {
    var self = this;

    this.vis = d3.select(this.drawto);


    this.xRange = d3.scaleLinear().range([this.MARGINS.left, this.WIDTH - this.MARGINS.right])
        .domain(this.xscale);

    this.yRange = d3.scaleLinear().range([this.HEIGHT - this.MARGINS.bottom, this.MARGINS.top])
        .domain(this.yscale);

    /**
     * Because of nice. The domain may be changed. So we need to update xscale and yscale
     */
    this.xscale = this.xRange.domain();
    this.yscale = this.yRange.domain();


    this.xAxis = d3.axisBottom(this.xRange);
    this.yAxis = d3.axisLeft(this.yRange);


    this.lineFunc = d3.line()
        .x(function (d) { return self.xRange(d[0]); })
        .y(function (d) { return self.yRange(d[1]); })
        .curve(d3.curveBasis);


    this.vis.selectAll('.xaxis').remove();
    this.vis.selectAll('.yaxis').remove();


    this.xAxis_svg = this.vis.append('svg:g')
        .attr('class', 'xaxis')
        .attr('transform', 'translate(0,' + (this.HEIGHT - this.MARGINS.bottom) + ')');

    this.yAxis_svg = this.vis.append('svg:g')
        .attr('class', 'yaxis')
        .attr('transform', 'translate(' + (this.MARGINS.left) + ',0)');

    /**
     * Place holder vline and hline, not visible
     */
    this.hline_data = [[0.1,-1000],[0,-1000]];
    this.vline_data = [[-1000,0],[-1000,1]];
    this.vis.selectAll(".hline").attr("d", self.lineFunc(self.hline_data));
    this.vis.selectAll(".vline").attr("d", self.lineFunc(self.vline_data));
    
    this.reset_axis();

    this.vis.append("text")
        .attr("class", "xlabel")
        .attr("text-anchor", "center")
        .attr("x", this.WIDTH / 2)
        .attr("y", this.HEIGHT - 20)
        .style("font-size", "22px")
        .attr("font-family", "Arial, Helvetica, sans-serif")
        .text("Chemical Shift (ppm)");

    this.vis.append("text")
        .attr("class", "ylabel")
        .attr("text-anchor", "center")
        .attr("y", this.HEIGHT / 2 + 10)
        .attr("x", 6)
        .attr("cx", 0).attr("cy", 0)
        .attr("transform", "rotate(-90 12," + this.HEIGHT / 2 + ")")
        .style("font-size", "22px")
        .attr("font-family", "Arial, Helvetica, sans-serif")
        .text("Chemical Shift (ppm)");


    this.rect = this.vis.append("defs").append("clipPath")
        .attr("id", "clip")
        .append("rect")
        .attr("x", this.MARGINS.left)
        .attr("y", this.MARGINS.top)
        .attr("width", this.WIDTH - this.MARGINS.right - this.MARGINS.left)
        .attr("height", this.HEIGHT - this.MARGINS.bottom - this.MARGINS.top);

    this.brush = d3.brush()
        .extent([[0, 0], [this.WIDTH, this.HEIGHT]])
        .on("end", this.brushend.bind(this));

    this.brush_element = this.vis.append("g")
        .attr("class", "brush")
        .call(this.brush);

    /**
     * Tool tip for mouse move
     */
    this.vis.on("mousemove", function (event) {

        if (self.cross_line_timeout) {
            clearTimeout(self.cross_line_timeout);
        }

        /**
         * Get the spectral index of the current spectral data
         * that we need to show the cross section, projection, and tool tip
        */
        let spe_index = self.current_spectral_index;
        if (spe_index < 0) {
            return;
        }

        /**
         * Show current ppm at the top-right corner of the plot in a span element with id "infor" (child of tooldiv)
        */
        tooldiv.style.opacity = 1.0;
        let coordinates = [event.offsetX, event.offsetY];
        let x_ppm = self.xRange.invert(coordinates[0]);
        let y_ppm = self.yRange.invert(coordinates[1]);
        let y_pos = Math.floor((y_ppm - hsqc_spectra[spe_index].y_ppm_ref - hsqc_spectra[spe_index].y_ppm_start) / hsqc_spectra[spe_index].y_ppm_step);
        let x_pos = Math.floor((x_ppm - hsqc_spectra[spe_index].x_ppm_ref - hsqc_spectra[spe_index].x_ppm_start) / hsqc_spectra[spe_index].x_ppm_step);
        let data_height = 0.0; //default value if out of range
        let signal_to_noise = 0.0; //default value if out of range
        if (x_pos >= 0 && x_pos < hsqc_spectra[spe_index].n_direct && y_pos >= 0 && y_pos < hsqc_spectra[spe_index].n_indirect) {
            data_height = hsqc_spectra[spe_index].raw_data[y_pos * hsqc_spectra[spe_index].n_direct + x_pos];
            signal_to_noise = data_height / hsqc_spectra[spe_index].noise_level;
        }

        if (self.hline_ppm !== null && self.vline_ppm !== null) {
            let x_distance = x_ppm - self.vline_ppm;
            let y_distance = y_ppm - self.hline_ppm;

            document.getElementById("infor").innerHTML
                = "x: " + x_ppm.toFixed(3) + " ppm, y: " + y_ppm.toFixed(2) + " ppm, Inten: " + data_height.toExponential(2) + " ,S/N: " + signal_to_noise.toFixed(2) + "<br>"
                + "x: " + x_distance.toFixed(3) + " ppm  " + (x_distance * hsqc_spectra[spe_index].frq1).toFixed(3) + " Hz"
                + ", y: " + y_distance.toFixed(3) + " ppm  " + (y_distance * hsqc_spectra[spe_index].frq2).toFixed(3) + " Hz";
        }
        else {
            document.getElementById("infor").innerHTML
                = "x_ppm: " + x_ppm.toFixed(3) + ", y_ppm: " + y_ppm.toFixed(2) + ", Inten: " + data_height.toExponential(2) + " ,S/N: " + signal_to_noise.toFixed(2);
        }


        if (self.magnifying_glass == true) {
            let coordinates = [event.offsetX, event.offsetY];
            let x_ppm = self.xRange.invert(coordinates[0]);
            let y_ppm = self.yRange.invert(coordinates[1]);
            // console.log("x_ppm: " + x_ppm + ", y_ppm: " + y_ppm);
            self.contour_plot.drawScene(0, true, [x_ppm, y_ppm], self.magnifying_glass_ratio, self.magnifying_glass_size / 100.0);
        }

        /**
         * Show h and v line only when mouse stops moving for 2.5 seconds
         * if pause on cursor is true
         */
        if (self.cross_line_pause_flag == true) {
            self.cross_line_timeout = setTimeout(function () {
                self.setup_cross_line(event);
            }, 2500);
        }
    });
    this.vis.on("mouseleave", function (d) {
        tooldiv.style.opacity = 0.0;
        document.activeElement.blur();
        if (self.cross_line_timeout) {
            clearTimeout(self.cross_line_timeout);
        }
        /**
         * Clear the magnifying glass
         */
        self.contour_plot.drawScene(0, false, [0, 0], 5, 0.4);
    });

    /**
     * Allow right click to set cross section by default
     */
    this.allow_right_click(document.getElementById("right_click").checked);

    /**
     * Draw contour on the canvas, which is a background layer
     */
    this.contour_plot = new webgl_contour_plot(this.drawto_contour);

    if(self.b_show_projection) {
        self.show_projection();    
    }
};

plotit.prototype.setup_cross_line = function (event)
{
    let self = this;
    let coordinates = [event.offsetX, event.offsetY];
    let x_ppm = self.xRange.invert(coordinates[0]);
    let y_ppm = self.yRange.invert(coordinates[1]);
        /**
     * Send the cross line to other window
     */
    if(this.inter_window_channel) {
        this.inter_window_channel.postMessage({
            type: 'cross_line',
            y_ppm: y_ppm,
            x_ppm: x_ppm,
            peak_group: document.getElementById("plot_group").value
        });
    }
    self.setup_cross_line_from_ppm(x_ppm, y_ppm);
}

plotit.prototype.setup_cross_line_from_ppm = function (x_ppm, y_ppm)
{
    let self = this;

    let x_ppm_start = hsqc_spectra[self.current_spectral_index].x_ppm_start + hsqc_spectra[self.current_spectral_index].x_ppm_ref;
    let x_ppm_end = x_ppm_start + hsqc_spectra[self.current_spectral_index].x_ppm_step * hsqc_spectra[self.current_spectral_index].n_direct;
    let y_ppm_start = hsqc_spectra[self.current_spectral_index].y_ppm_start + hsqc_spectra[self.current_spectral_index].y_ppm_ref;
    let y_ppm_end = y_ppm_start + hsqc_spectra[self.current_spectral_index].y_ppm_step * hsqc_spectra[self.current_spectral_index].n_indirect;

    /**
     * Add a horizontal line at the current y ppm, from x_ppm_start to x_ppm_end
     * This line is subject to zoom, pan, resize, etc
     */
    self.hline_data = [[x_ppm_start, y_ppm], [x_ppm_end, y_ppm]];
    self.vis.selectAll(".hline").remove();
    self.vis.append("path")
        .attr("class", "hline")
        .attr("clip-path", "url(#clip)")
        .attr("d", self.lineFunc(self.hline_data))
        .attr("stroke-width", 1)
        .attr("stroke", "green");

    /**
     * Add a vertical line at the current x ppm, from y_ppm_start to y_ppm_end
     * This line is subject to zoom, pan, resize, etc
     */
    self.vline_data = [[x_ppm, y_ppm_start], [x_ppm, y_ppm_end]];
    self.vis.selectAll(".vline").remove();
    self.vis.append("path")
        .attr("class", "vline")
        .attr("clip-path", "url(#clip)")
        .attr("d", self.lineFunc(self.vline_data))
        .attr("stroke-width", 1)
        .attr("stroke", "green");

    /**
     * Keep a copy of the current hline,vline ppm values
     */
    self.hline_ppm = y_ppm;
    self.vline_ppm = x_ppm;


    if (self.b_show_cross_section)
    {
        /**
         * Show cross section along x-axis (direct dimension).
         * 1. Find the closest point in the data hsqc_spectra[spe_index].raw_data (1D Float32 array with size hsqc_spectra[spe_index].n_direct*hsqc_spectra[spe_index].n_indirect)
         * Along direct dimension, ppm are from hsqc_spectra[spe_index].x_ppm_start to hsqc_spectra[spe_index].x_ppm_start + hsqc_spectra[spe_index].x_ppm_step * hsqc_spectra[spe_index].n_direct
         * Along indirect dimension, ppm are from hsqc_spectra[spe_index].y_ppm_start to hsqc_spectra[spe_index].y_ppm_start + hsqc_spectra[spe_index].y_ppm_step * hsqc_spectra[spe_index].n_indirect
         * So, x_ppm ==> x_ppm_start + x_ppm_step * x_pos, y_ppm ==> y_ppm_start + y_ppm_step * y_pos.
         * So, x_pos = (x_ppm - x_ppm_start)/x_ppm_step, y_pos = (y_ppm - y_ppm_start)/y_ppm_step
         */
        let current_vis_x_ppm_start = self.xscale[0];
        let current_vis_x_ppm_end = self.xscale[1];

        /**
         * However, current_vis_x_ppm_start and current_vis_x_ppm_end must both 
         * be within the range of hsqc_spectra[self.current_spectral_index].x_ppm_start to hsqc_spectra[self.current_spectral_index].x_ppm_start + hsqc_spectra[self.current_spectral_index].x_ppm_step * hsqc_spectra[self.current_spectral_index].n_direct
         */
        if (current_vis_x_ppm_start > hsqc_spectra[self.current_spectral_index].x_ppm_start + hsqc_spectra[self.current_spectral_index].x_ppm_ref) {
            current_vis_x_ppm_start = hsqc_spectra[self.current_spectral_index].x_ppm_start + hsqc_spectra[self.current_spectral_index].x_ppm_ref;
        }
        if (current_vis_x_ppm_end < hsqc_spectra[self.current_spectral_index].x_ppm_start + hsqc_spectra[self.current_spectral_index].x_ppm_ref + hsqc_spectra[self.current_spectral_index].x_ppm_step * hsqc_spectra[self.current_spectral_index].n_direct) {
            current_vis_x_ppm_end = hsqc_spectra[self.current_spectral_index].x_ppm_start + hsqc_spectra[self.current_spectral_index].x_ppm_ref + hsqc_spectra[self.current_spectral_index].x_ppm_step * hsqc_spectra[self.current_spectral_index].n_direct;
        }

        let y_pos = Math.floor((y_ppm - hsqc_spectra[self.current_spectral_index].y_ppm_ref - hsqc_spectra[self.current_spectral_index].y_ppm_start) / hsqc_spectra[self.current_spectral_index].y_ppm_step);

        /**
         * if y_pos is out of range, do nothing and return
         */
        if (y_pos > 0 && y_pos < hsqc_spectra[self.current_spectral_index].n_indirect) {
            /**
             * Get ppm values for the data, which is an array stats from hsqc_spectra[self.current_spectral_index].x_ppm_start + x_pos_start * hsqc_spectra[self.current_spectral_index].x_ppm_step
             * to hsqc_spectra[self.current_spectral_index].x_ppm_start + x_pos_end * hsqc_spectra[self.current_spectral_index].x_ppm_step
             */
            let data_ppm = [];
            for (let i = 0; i < hsqc_spectra[self.current_spectral_index].n_direct; i++) {
                data_ppm.push(hsqc_spectra[self.current_spectral_index].x_ppm_start + hsqc_spectra[self.current_spectral_index].x_ppm_ref + i * hsqc_spectra[self.current_spectral_index].x_ppm_step);
            }

            /**
             * Get the data from hsqc_spectra[self.current_spectral_index].raw_data, at row y_pos, from column x_pos_start to x_pos_end
             */
            let data_height = hsqc_spectra[self.current_spectral_index].raw_data.slice(y_pos * hsqc_spectra[self.current_spectral_index].n_direct, (y_pos + 1) * hsqc_spectra[self.current_spectral_index].n_direct);
            let data_height_i = [];
            /**
             * If hsqc_spectra[self.current_spectral_index].raw_data_ri is not empty 
             *  then use it to get the data_height_i
             * if hsqc_spectra[self.current_spectral_index].spectrum_origin == -2 (from fid), also require current_reprocess_spectrum_index is not -1 
             */
            if (hsqc_spectra[self.current_spectral_index].raw_data_ri.length > 0 && (hsqc_spectra[self.current_spectral_index].spectrum_origin != -2 || current_reprocess_spectrum_index != -1)) {
                data_height_i = hsqc_spectra[self.current_spectral_index].raw_data_ri.slice(y_pos * hsqc_spectra[self.current_spectral_index].n_direct, (y_pos + 1) * hsqc_spectra[self.current_spectral_index].n_direct);
            }

            /**
             * Get the maximum and minimum of the data_height
             */
            let data_max = 0.0;
            let data_min = 0.0;
            for (let i = 0; i < data_ppm.length; i++) {
                if (data_height[i] > data_max) {
                    data_max = data_height[i];
                }
                if (data_height[i] < data_min) {
                    data_min = data_height[i];
                }
            }
            /**
             * Draw cross section line plot on the cross_section_svg_x
             */
            self.x_cross_section_plot.zoom(self.xscale, [data_min, data_max]);
            self.x_cross_section_plot.update_data([hsqc_spectra[self.current_spectral_index].x_ppm_start + hsqc_spectra[self.current_spectral_index].x_ppm_ref, hsqc_spectra[self.current_spectral_index].x_ppm_step, hsqc_spectra[self.current_spectral_index].n_direct],
                [data_ppm, data_height, data_height_i]);
        }

        /**
         * Show cross section along y-axis (indirect dimension).
         * 1. Find the closest point in the data hsqc_spectra[self.current_spectral_index].raw_data (1D Float32 array with size hsqc_spectra[self.current_spectral_index].n_direct*hsqc_spectra[self.current_spectral_index].n_indirect)
         * Along direct dimension, ppm are from hsqc_spectra[self.current_spectral_index].x_ppm_start to hsqc_spectra[self.current_spectral_index].x_ppm_start + hsqc_spectra[self.current_spectral_index].x_ppm_step * hsqc_spectra[self.current_spectral_index].n_direct
         * Along indirect dimension, ppm are from hsqc_spectra[self.current_spectral_index].y_ppm_start to hsqc_spectra[self.current_spectral_index].y_ppm_start + hsqc_spectra[self.current_spectral_index].y_ppm_step * hsqc_spectra[self.current_spectral_index].n_indirect
         * So, x_ppm ==> x_ppm_start + x_ppm_step * x_pos, y_ppm ==> y_ppm_start + y_ppm_step * y_pos.
         * So, x_pos = (x_ppm - x_ppm_start)/x_ppm_step, y_pos = (y_ppm - y_ppm_start)/y_ppm_step
         */
        let current_vis_y_ppm_start = self.yscale[0];
        let current_vis_y_ppm_end = self.yscale[1];

        /**
         * However, current_vis_y_ppm_start and current_vis_y_ppm_end must both 
         * be within the range of hsqc_spectra[self.current_spectral_index].y_ppm_start to hsqc_spectra[self.current_spectral_index].y_ppm_start + hsqc_spectra[self.current_spectral_index].y_ppm_step * hsqc_spectra[self.current_spectral_index].n_indirect
         */
        if (current_vis_y_ppm_start > hsqc_spectra[self.current_spectral_index].y_ppm_start + hsqc_spectra[self.current_spectral_index].y_ppm_ref) {
            current_vis_y_ppm_start = hsqc_spectra[self.current_spectral_index].y_ppm_start + hsqc_spectra[self.current_spectral_index].y_ppm_ref;
        }
        if (current_vis_y_ppm_end < hsqc_spectra[self.current_spectral_index].y_ppm_start + hsqc_spectra[self.current_spectral_index].y_ppm_ref + hsqc_spectra[self.current_spectral_index].y_ppm_step * hsqc_spectra[self.current_spectral_index].n_indirect) {
            current_vis_y_ppm_end = hsqc_spectra[self.current_spectral_index].y_ppm_start + hsqc_spectra[self.current_spectral_index].y_ppm_ref + hsqc_spectra[self.current_spectral_index].y_ppm_step * hsqc_spectra[self.current_spectral_index].n_indirect;
        }

        let x_pos = Math.floor((x_ppm - hsqc_spectra[self.current_spectral_index].x_ppm_ref - hsqc_spectra[self.current_spectral_index].x_ppm_start) / hsqc_spectra[self.current_spectral_index].x_ppm_step);

        /**
         * if x_pos is out of range, do nothing and return
         */
        if (x_pos >= 0 && x_pos < hsqc_spectra[self.current_spectral_index].n_direct)
        {
            /**
             * Get ppm values for the data, which is an array stats from hsqc_spectra[self.current_spectral_index].y_ppm_start + y_pos_start * hsqc_spectra[self.current_spectral_index].y_ppm_step
             * to hsqc_spectra[self.current_spectral_index].y_ppm_start + y_pos_end * hsqc_spectra[self.current_spectral_index].y_ppm_step
             */
            let data_ppm = [];
            for (let i = 0; i < hsqc_spectra[self.current_spectral_index].n_indirect; i++) {
                data_ppm.push(hsqc_spectra[self.current_spectral_index].y_ppm_start + hsqc_spectra[self.current_spectral_index].y_ppm_ref + i * hsqc_spectra[self.current_spectral_index].y_ppm_step);
            }

            /**
             * Get the data from hsqc_spectra[self.current_spectral_index].raw_data, at column x_pos, from row y_pos_start to y_pos_end
             * Along direct dimension, ppm are from hsqc_spectra[self.current_spectral_index].x_ppm_start to hsqc_spectra[self.current_spectral_index].x_ppm_start + hsqc_spectra[self.current_spectral_index].x_ppm_step * hsqc_spectra[self.current_spectral_index].n_direct
             * Along indirect dimension, ppm are from hsqc_spectra[self.current_spectral_index].y_ppm_start to hsqc_spectra[self.current_spectral_index].y_ppm_start + hsqc_spectra[self.current_spectral_index].y_ppm_step * hsqc_spectra[self.current_spectral_index].n_indirect
             * So, x_ppm ==> x_ppm_start + x_ppm_step * x_pos, y_ppm ==> y_ppm_start + y_ppm_step * y_pos.
             * So, x_pos = (x_ppm - x_ppm_start)/x_ppm_step, y_pos = (y_ppm - y_ppm_start)/y_ppm_step
             */
            let data_height = [];
            for (let i = 0; i < hsqc_spectra[self.current_spectral_index].n_indirect; i++) {
                data_height.push(hsqc_spectra[self.current_spectral_index].raw_data[i * hsqc_spectra[self.current_spectral_index].n_direct + x_pos]);
            }
            let data_height_i = [];
            /**
             * If hsqc_spectra[self.current_spectral_index].raw_data_ir is not empty 
             * then use it to get the data_height_i
             * if hsqc_spectra[self.current_spectral_index].spectrum_origin == -2 (from fid), also require current_reprocess_spectrum_index is not -1 
             */
            if (hsqc_spectra[self.current_spectral_index].raw_data_ir.length > 0 && (hsqc_spectra[self.current_spectral_index].spectrum_origin != -2 || current_reprocess_spectrum_index != -1)) {
                for (let i = 0; i < hsqc_spectra[self.current_spectral_index].n_indirect; i++) {
                    data_height_i.push(hsqc_spectra[self.current_spectral_index].raw_data_ir[i * hsqc_spectra[self.current_spectral_index].n_direct + x_pos]);
                }
            }

            /**
             * Get max and min of data_height
             */
            let data_max = 0.0;
            let data_min = 0.0;
            for (let i = 0; i < data_ppm.length; i++) {
                if (data_height[i] > data_max) {
                    data_max = data_height[i];
                }
                if (data_height[i] < data_min) {
                    data_min = data_height[i];
                }
            }
            /**
             * Draw cross section line plot on the cross_section_svg_y
             */
            self.y_cross_section_plot.zoom([data_min, data_max], self.yscale);
            self.y_cross_section_plot.update_data([hsqc_spectra[self.current_spectral_index].y_ppm_start + hsqc_spectra[self.current_spectral_index].y_ppm_ref, hsqc_spectra[self.current_spectral_index].y_ppm_step, hsqc_spectra[self.current_spectral_index].n_indirect],
                [data_ppm, data_height, data_height_i]);
        }
    } //end of show cross section
} //end of cross section

plotit.prototype.get_phase_correction = function () {
    let self = this;
    let phase_direct = self.x_cross_section_plot.get_phase_correction();
    let phase_indirect = self.y_cross_section_plot.get_phase_correction();
    self.x_cross_section_plot.clear_phase_correction();
    self.y_cross_section_plot.clear_phase_correction();
    return [phase_direct, phase_indirect];
}

plotit.prototype.show_projection = function () {

    let self = this;

    self.b_show_projection = true;

    /**
    * Get the spectral index of the current spectral data
    */
    let spe_index = self.current_spectral_index;
    /**
     * data is an array of 2 numbers, [x_ppm, x_height]
     */
    let ppm =[];
    for(let i = 0; i < hsqc_spectra[spe_index].n_direct; i++)
    {
        ppm.push(hsqc_spectra[spe_index].x_ppm_start + hsqc_spectra[spe_index].x_ppm_ref + i * hsqc_spectra[spe_index].x_ppm_step);
    }
    self.x_cross_section_plot.zoom(self.xscale,[hsqc_spectra[spe_index].projection_direct_min, hsqc_spectra[spe_index].projection_direct_max]);
    self.x_cross_section_plot.update_data([hsqc_spectra[spe_index].x_ppm_start + hsqc_spectra[spe_index].x_ppm_ref,hsqc_spectra[spe_index].x_ppm_step,hsqc_spectra[spe_index].n_direct],
        [ppm,hsqc_spectra[spe_index].projection_direct,[]]);
    /**
     * data2 is an array of 2 numbers, [y_height,y_ppm]
     */
    let ppm2 =[];
    for(let i = 0; i < hsqc_spectra[spe_index].n_indirect; i++)
    {
        ppm2.push(hsqc_spectra[spe_index].y_ppm_start + hsqc_spectra[spe_index].y_ppm_ref + i * hsqc_spectra[spe_index].y_ppm_step);
    }
    self.y_cross_section_plot.zoom([hsqc_spectra[spe_index].projection_indirect_min, hsqc_spectra[spe_index].projection_indirect_max],self.yscale);
    self.y_cross_section_plot.update_data([hsqc_spectra[spe_index].y_ppm_start + hsqc_spectra[spe_index].y_ppm_ref,hsqc_spectra[spe_index].y_ppm_step,hsqc_spectra[spe_index].n_indirect],
        [ppm2,hsqc_spectra[spe_index].projection_indirect,[]]);
}

plotit.prototype.redraw_contour = function ()
{
    /**
     * Update webgl contour data.
     */
    this.contour_plot.set_data(
        this.spectral_information, /**spectral information */
        this.points, /** actual contour line data in Float32array */
        /**
         * Positive contour data
         */
        this.points_start,
        this.polygon_length,
        this.levels_length,
        this.colors,
        this.contour_lbs,
        /**
         * Negative contour data
         */
        this.points_start_negative,
        this.polygon_length_negative,
        this.levels_length_negative,
        this.colors_negative,
        this.contour_lbs_negative
        );

    this.contour_plot.spectral_order = this.spectral_order;

    this.contour_plot.setCamera_ppm(this.xscale[0], this.xscale[1], this.yscale[0], this.yscale[1]);
    this.contour_plot.drawScene();
}

plotit.prototype.update_cross_section = function (spe_index,flag) {
    /**
     * Only need to update when current cross section is the same as the spectral_index
     */
    if(this.current_spectral_index === spe_index) {
        if(flag === 0) {
            let ppm =[];
            for(let i = 0; i < hsqc_spectra[spe_index].n_direct; i++)
            {
                ppm.push(hsqc_spectra[spe_index].x_ppm_start + hsqc_spectra[spe_index].x_ppm_ref + i * hsqc_spectra[spe_index].x_ppm_step);
            }
            this.x_cross_section_plot.update_data0([hsqc_spectra[spe_index].x_ppm_start + hsqc_spectra[spe_index].x_ppm_ref,hsqc_spectra[spe_index].x_ppm_step,hsqc_spectra[spe_index].n_direct],ppm);
        }
        else if(flag === 1) {
            let ppm2 =[];
            for(let i = 0; i < hsqc_spectra[spe_index].n_indirect; i++)
            {
                ppm2.push(hsqc_spectra[spe_index].y_ppm_start + hsqc_spectra[spe_index].y_ppm_ref + i * hsqc_spectra[spe_index].y_ppm_step);
            }
            this.y_cross_section_plot.update_data0([hsqc_spectra[spe_index].y_ppm_start + hsqc_spectra[spe_index].y_ppm_ref,hsqc_spectra[spe_index].y_ppm_step,hsqc_spectra[spe_index].n_indirect],ppm2);
        }
    }
};

/**
 * Redraw contour plot with new order of spectra
 */
plotit.prototype.redraw_contour_order = function ()
{
    this.contour_plot.spectral_order = this.spectral_order;
    this.contour_plot.drawScene();   
}

/**
 * Set lowest visible peak level
 */
plotit.prototype.set_peak_level = function (level) {
    this.peak_level = level;
}

/**
 * Set peaks for the plot
 */
plotit.prototype.add_peaks = function (spectrum,flag,properties,peak_color_flag) {
    this.spectrum = spectrum;
    this.peak_flag = flag;
    this.peak_properties = properties;
    this.peak_color_flag = peak_color_flag;
    this.draw_peaks();
}

/**
 * Add peak labels to the plot. Only show the labels for the peaks that are visible
 * That is, this function need to be called after any zoom, pan, resize or contour level change to be valid
 */
plotit.prototype.update_peak_labels = function(flag,min_dis,max_dis,repulsive_force,font_size,color,label) {
    let self = this;

    self.font_size = font_size;

    /**
     * In case of new simulation, stop the old one
     */
    if( this.sim != null)
    {
        this.sim.stop();
    }

    /**
     * A custom force to move text at relative (+20,-20) to the peak location.
     * @returns 
     */
    function text_force() {
        var strength = 0.1;
        
        function force(alpha)
        {
            for (var i = 0; i < nodes.length; ++i) {
                let node = nodes[i];
                let distance1 = (self.xRange(node.X_PPM) - node.x);
                let distance2 = (self.yRange(node.Y_PPM) - node.y);
                let distance = Math.sqrt(distance1*distance1+distance2*distance2);
                let force_amplitude = 0;
                if(distance > max_dis)
                {
                    force_amplitude = (distance - max_dis) * strength * alpha / distance;
                }
                else if(distance < min_dis)
                {
                    force_amplitude = (distance - min_dis) * strength * alpha / distance
                }
                let force_x = distance1 * force_amplitude;
                let force_y = distance2 * force_amplitude;

                node.vx += force_x;
                node.vy += force_y;
            }
        }

        force.initialize = function(_) {
            nodes = _;
          };

        return force;
    };


    function avoid_peaks()
    {
        let nodes;
        var strength = repulsive_force;

        /**
         * Require all nodes to avoid all peaks. Brute force method
         * @param {*} alpha 
         */
        function force(alpha) {
            for (let j=0;j<nodes.length;j++)
            {
                let node = nodes[j];
                for (let i=0;i<nodes.length;i++)
                {
                    if(i===j){
                        continue;
                    }
                    let peak = nodes[i];
                    let distance1 = self.xRange(peak.X_PPM) - node.x;
                    let distance2 = self.yRange(peak.Y_PPM) - node.y;
                    let distance_square = distance1*distance1+distance2*distance2;
                    if(distance_square < 40000)
                    {                        
                        let force_amplitude = strength * alpha;
                        let force_x = distance1 * force_amplitude/distance_square;
                        let force_y = distance2 * force_amplitude/distance_square;

                        node.vx -= force_x;
                        node.vy -= force_y;
                    }
                }
            }

        }

        force.initialize = _ => nodes = _;
        return force;
    }

    function boundary_force()
    {
        let nodes;
        var strength = 10.0;

        /**
         * Require all nodes to avoid all peaks. Brute force method
         * @param {*} alpha 
         */
        function force(alpha)
        {
            for (let j=0;j<nodes.length;j++)
            {
                let node = nodes[j];
                /**
                 * if node is out of boundary, then apply a force to move it back
                 */
                if(node.x < self.MARGINS.left)
                {
                    node.vx += strength * alpha;
                }
                if(node.x > self.WIDTH - self.MARGINS.right)
                {
                    node.vx -= strength * alpha;
                }
                if(node.y < self.MARGINS.top)
                {
                    node.vy += strength * alpha;
                }
                if(node.y > self.HEIGHT - self.MARGINS.bottom)
                {
                    node.vy -= strength * alpha;
                }
            }
        }

        function strength(_) {
            if (!arguments.length) return strength;
            strength = _;
            return force;
        }

        force.initialize = _ => nodes = _;
        return force;
    }

    /**
     * Get a subset of peaks that are visible. 
     * shallow copy of self.new_peaks
     */
    let visible_peaks = this.new_peaks.filter(function (d) {
        return d.X_PPM <= self.xscale[0]
            && d.X_PPM >= self.xscale[1]
            && d.Y_PPM <= self.yscale[0]
            && d.Y_PPM >= self.yscale[1]
            && (typeof d.HEIGHT === "undefined" || d.HEIGHT > self.peak_level);
    });

    /**
     * Make a deep copy of visible_peaks to this.visible_peaks
     */
    this.visible_peaks=JSON.parse(JSON.stringify(visible_peaks));

     /**
     * Init new_peaks[i].x and y property for the force simulation
     */
     for(let i=0;i<self.visible_peaks.length;i++)
     {
         self.visible_peaks[i].x = self.xRange(self.visible_peaks[i].X_PPM) + 20 * Math.random() - 10.0;
         self.visible_peaks[i].y = self.yRange(self.visible_peaks[i].Y_PPM) + 20 * Math.random() - 10.0;  
     }

    self.vis.selectAll('.peak_text').remove();
    self.vis.selectAll('.peak_line').remove();

    if(flag==false)
    {
        return;
    }

    const peak_text_drag = d3.drag()
        .on("start", function () {
        })
        .on("drag", function (event,d) {
            /**
             * Update the x and y of the peak_text
             */
            d3.select(this).attr('x', event.x).attr('y', event.y);
            d.x = event.x;
            d.y = event.y;
            d.X_TEXT_PPM = self.xRange.invert(event.x);
            d.Y_TEXT_PPM = self.yRange.invert(event.y);
            /**
             * Also update the x1 and y1 of the peak_line_svg,
             */
        })
        .on("end", function (event,d) {
            /**
             * Start the simulation again
             */
            d.X_TEXT_PPM = self.xRange.invert(event.x);
            d.Y_TEXT_PPM = self.yRange.invert(event.y);
            self.sim.stop();
            self.sim.alpha(1.0).alphaMin(0.1).restart();
        });

    this.peaks_text_svg = self.vis.selectAll('.peak_text')
        .data(self.visible_peaks)
        .enter()
        .append('text')
        .attr('class', 'peak_text')
        .attr('font-size',font_size)
        .style('fill', color)
        .text(function (d) {
            if(typeof d[label] === "number")
            {
                if(Number.isInteger(d[label]) && d[label] < 1000 )
                {
                    return d[label].toFixed(0);
                }
                else if(d[label] > 1000)
                {
                    return d[label].toExponential(2);
                }
                else if(d[label] < 0.01)
                {
                    return d[label].toExponential(2);
                }
                else
                {
                    return d[label].toFixed(2);
                }
            }
            else{
                return d[label];
            }
        })
        .attr('x', function (d) {
            return self.xRange(d.X_PPM);
        })
        .attr('y', function (d) {
            return self.yRange(d.Y_PPM);
        })
        .attr("clip-path", "url(#clip)");
        
    /**
     * Update pos using dx,dy and save text length (width) to visible_peaks as well
     * to be used in drawing of line
     */
    this.peaks_text_svg
        .attr('dx', function (d) {
            /**
             * Save the text width to d.text_width. to be used in the tick function
             * to update line position
             */
            d.text_width = this.getComputedTextLength();
            return -this.getComputedTextLength()/2;
        })
        .attr('dy', function () {
            return 0.5*font_size;
        });

    /**
     * Also add a line between peak and peak_text
     */
    this.peak_line_svg = self.vis.selectAll('.peak_line')
        .data(self.visible_peaks)
        .enter()
        .append('line')
        .attr('class','peak_line')
        .attr('stroke',color)
        /**
         * x1 and y1 is the peak label position
         */
        .attr('x1', function (d) {
            return d.x;
        })
        .attr('y1', function (d) {
            return d.y;
        })
        .attr('x2', function(d) {
            /**
             * x2 and y2 is the peak position
             */
            return self.xRange(d.X_PPM);
        })
        .attr('y2', function (d) {
            return self.yRange(d.Y_PPM);
        })
        .attr("clip-path", "url(#clip)");
    
    self.peaks_text_svg.call(peak_text_drag);

    /**
     * Add a force simulation
     */

    this.sim = d3.forceSimulation(self.visible_peaks)
        .force("near_peak", text_force())
        .force("inter_collide", d3.forceCollide().radius(40).strength(1).iterations(1))
        .force('exclude',d3.forceManyBody().strength(-10))
        .force("avoid", avoid_peaks())
        .force("boundary", boundary_force())
        .stop();
    ;


    this.sim.on("tick", () => {
        console.log(this.sim.alpha());
        self.peaks_text_svg
            .attr("x", d => d.x)
            .attr("y", d => d.y)
            .attr('dx', function (d) {
                return -this.getComputedTextLength()/2;
            })
            .attr('dy', function () {
                return 0.5*font_size
            });

            /**
             * Need to update X_TEXT_PPM and Y_TEXT_PPM, so that reset_axis will work properly
             */
        this.visible_peaks.forEach(peak => {
            peak.X_TEXT_PPM = self.xRange.invert(peak.x);
            peak.Y_TEXT_PPM = self.yRange.invert(peak.y);
        });

        self.peak_line_svg
        .attr('x1', function (d) {
            if(Math.abs(d.x - self.xRange(d.X_PPM)) > Math.abs(d.y - self.yRange(d.Y_PPM)))
            {
                if(d.x > self.xRange(d.X_PPM))
                {
                    return d.x - d.text_width/2;
                }
                else
                {
                    return d.x + d.text_width/2;
                }
            }
            else
            {
                return d.x;
            }
        })
        .attr('y1', function (d) {
            if(Math.abs(d.x - self.xRange(d.X_PPM)) > Math.abs(d.y - self.yRange(d.Y_PPM)))
            {
                return d.y;
            }
            else
            {
                if(d.y > self.yRange(d.Y_PPM))
                {
                    return d.y - 0.5*font_size;
                }
                else
                {
                    return d.y + 0.5*font_size;
                }
            }
        })
    });

    this.sim.on("end", () => {
        console.log("end");
    });

    this.sim.alphaMin(0.1).restart();

}


/**
 * Draw peaks on the plot
 */
plotit.prototype.draw_peaks = function () {
    
    let self = this;
    if(typeof self.peak_flag ===  'undefined' || self.peak_flag === null)
    {
        return;
    }
    
    /**
     * Remove all peaks if there is any
     */
    self.vis.selectAll('.peak').remove();

    /**
     * Filter peaks based on peak level
     */
    this.new_peaks;
    if(self.peak_flag === 'picked') {
        this.new_peaks = self.spectrum.picked_peaks_object.get_selected_columns(self.peak_properties);
    }
    else{
        this.new_peaks = self.spectrum.fitted_peaks_object.get_selected_columns(self.peak_properties);
    }
    
    for(let i=0;i<self.new_peaks.length;i++)
    {
        self.new_peaks[i].radius = 10.0;
    }
    

    
    /**
     * Draw peaks, red circles without fill
     */
    this.peaks_svg=self.vis.selectAll('.peak')
        .data(self.new_peaks)
        .enter()
        .append('circle')
        .attr('class', 'peak')
        .attr('cx', function (d) {
            return self.xRange(d.X_PPM);
        })
        .attr('cy', function (d) {
            return self.yRange(d.Y_PPM);
        })
        .attr('visibility',function(d) {
            if(typeof d.HEIGHT === "undefined" || d.HEIGHT>self.peak_level)
            {
                return "visible";
            }
            else{
                return "hidden";
            }
        })
        .attr("clip-path", "url(#clip)")
        .attr('r', self.peak_size)
        .attr('stroke', function(){
            return self.peak_color;
        })
        .attr('fill', 'none')
        .attr('stroke-width', self.peak_thickness);
};

plotit.prototype.allow_right_click = function(flag) {
    let self = this;
    if(flag === true) {
        self.vis.on('contextmenu', function (event) {
            event.preventDefault();
            self.setup_cross_line(event);
        });
    }
    else {
        self.vis.on('contextmenu', function(event) {
            event.preventDefault();
        });
    }
};



plotit.prototype.redraw_peaks = function () {
    let self = this;
    self.vis.selectAll('.peak')
        .attr('r', self.peak_size)
        .attr('stroke', function(d){
            if(self.peak_color_flag === "SOLID"){
                return self.peak_color;
            }
            else {
                if(d[self.peak_color_flag]>=self.peak_color_flag_limit[0] && d[self.peak_color_flag]<=self.peak_color_flag_limit[1])
                {
                    let scaled_value = (d[self.peak_color_flag] - self.peak_color_flag_limit[0]) / (self.peak_color_flag_limit[1] - self.peak_color_flag_limit[0]);
                    return self.peak_color_scale(scaled_value);
                }
                else if(d[self.peak_color_flag] < self.peak_color_flag_limit[0])
                {
                    return self.peak_color_scale(0);
                }
                else // d[self.peak_color_flag] > self.peak_color_flag_limit[1]
                {
                    return self.peak_color_scale(1);
                }
                
            }
            
        })
        .attr('visibility',function(d) {
            if(typeof d.HEIGHT === "undefined" || d.HEIGHT>self.peak_level)
            {
                return "visible";
            }
            else{
                return "hidden";
            }
        })
        .attr('fill', 'none')
        .attr('stroke-width', self.peak_thickness);
}

/**
 * Allow peak dragging
 */
plotit.prototype.allow_peak_dragging = function (flag) {

    let self = this;

    this.peak_drag = d3.drag()
    .on('start', function (d) {
        d3.select(this).raise().classed('active', true);
        
    })
    .on('drag', function (event,d) {
        d3.select(this)
            .attr('cx', event.x)
            .attr('cy', event.y);
    })
    .on('end', function (event,d) {
        /**
         * Get new coordinates of the peak
         */
        d.X_PPM = self.xRange.invert(event.x);
        d.Y_PPM = self.yRange.invert(event.y);
        /**
         * Check amplitude of the spectrum at the peak position
         * if less than lowest contour level, remove the peak
         */
        let y_pos= Math.floor((d.Y_PPM - self.spectrum.y_ppm_ref - self.spectrum.y_ppm_start)/self.spectrum.y_ppm_step);
        let x_pos = Math.floor((d.X_PPM - self.spectrum.x_ppm_ref - self.spectrum.x_ppm_start)/self.spectrum.x_ppm_step);
        let data_height = 0.0; //default value if out of range
        if(x_pos>=0 && x_pos<self.spectrum.n_direct && y_pos>=0 && y_pos<self.spectrum.n_indirect) {
            data_height = self.spectrum.raw_data[y_pos *  self.spectrum.n_direct + x_pos];
        }
        
        // if(data_height < self.peak_level) {
        //     if(self.peak_flag === 'picked') {
        //         /**
        //          * Remove the peak from the picked peaks
        //          */
        //         self.spectrum.picked_peaks_object.remove_row(d.INDEX);
        //     }
        //     d3.select(this).remove();
        // }
        // else
        {
            /**
             * Update the peak in the picked peaks
             */
            if(self.peak_flag === 'picked') {
                self.spectrum.picked_peaks_object.update_row(d.INDEX, d.X_PPM, d.Y_PPM);
            }
        }

    });

    if(flag===true){
        self.vis.selectAll('.peak').call(self.peak_drag);
    }
    else{
        self.vis.selectAll('.peak').on('.drag',null);
    }
}

/**
 * Allow click to add peaks
 */
plotit.prototype.allow_click_to_add_peak = function (flag) {

    let self = this;

    if(flag === true) {
        self.vis.on('click', function (event) {
            let coordinates = d3.pointer(event);
            let x_ppm = self.xRange.invert(coordinates[0]);
            let y_ppm = self.yRange.invert(coordinates[1]);
            /**
                 * Get amplitude of the spectrum at the peak position
                 */
            let y_pos= Math.floor((y_ppm - self.spectrum.y_ppm_ref - self.spectrum.y_ppm_start)/self.spectrum.y_ppm_step);
            let x_pos = Math.floor((x_ppm - self.spectrum.x_ppm_ref - self.spectrum.x_ppm_start)/self.spectrum.x_ppm_step);
            let data_height = 0.0; //default value if out of range
            if(x_pos>=0 && x_pos<self.spectrum.n_direct && y_pos>=0 && y_pos<self.spectrum.n_indirect) {
                data_height = self.spectrum.raw_data[y_pos *  self.spectrum.n_direct + x_pos];
            }
            let new_peak = {
                X_PPM: x_ppm,
                Y_PPM: y_ppm,
                HEIGHT: data_height,
            };
            if(self.spectrum != null && new_peak.HEIGHT > self.peak_level)
            {
                self.spectrum.picked_peaks_object.add_row(new_peak);
                self.draw_peaks();
            }
        });
    }
    else {
        self.vis.on('click', null);
    }
};

/**
 * Remove peaks from the plot
 */
plotit.prototype.remove_picked_peaks = function () {
    let self = this;
    self.spectrum = null;
    self.vis.selectAll('.peak').remove();
    self.vis.selectAll('.peak_text').remove();
};

/**
 * Get current visible region
 */
plotit.prototype.get_visible_region = function () {
    return [this.xscale[1], this.xscale[0], this.yscale[1], this.yscale[0]];
}


/**
 * Modify predicted peaks (from spin simulation) to the plot
 * @param {Array} peaks: array of peaks, each peak object has the following properties:
 * [0]: ppm coordinate in x-axis
 * [1]: profile 
 * degeneracy: degeneracy of the peak (1,2,3,4,5. etc from spin simulation)
 * @param {Number} index: index of the predicted peaks to be modified in the array
 */
plotit.prototype.add_predicted_peaks = function (peaks,flag_valid, index) {
    let self = this;

    if(index >= self.predicted_peaks.length) {
        /**
         * Add empty array to self.predicted_peaks to reach length of index+1
         */
        for(let i = self.predicted_peaks.length; i <= index; i++) {
            self.predicted_peaks.push([]);
        }
    }
    self.predicted_peaks[index] = peaks;

    self.x = d3.scaleLinear().range([self.MARGINS.left, self.WIDTH - self.MARGINS.right])
        .domain(self.xscale);
    self.y = d3.scaleLinear().range([self.HEIGHT - self.MARGINS.bottom, self.MARGINS.top])
        .domain(self.yscale);

    self.vis.selectAll('.predicted_peak_'+index).remove();

    self.line = d3.line()
        .x((d) => self.x(d[0]))
        .y((d) => self.y(d[1]));

    self.vis.append('path')
        .attr('class', 'predicted_peak_'+index)
        .attr("d", self.line(peaks))
        .attr('fill', 'none')
        .attr('stroke', (flag_valid === true) ? 'green' : 'purple')
        .attr('stroke-width', 3);
}