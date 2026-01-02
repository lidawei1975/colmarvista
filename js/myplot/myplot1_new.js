
/**
 * GLOBAL VARIABLES AND DIRECT DOM ELEMENT REFERENCES
 * 
 * Other classes and libraries required.
 * - d3: Used for visualization (lines 58, 158, etc.)
 * - cross_section_plot: Constructor (lines 79, 81)
 * - webgl_contour_plot: Constructor (line 762)
 * - fitting_plot: Constructor (line 1798)
 * 
 * 
 * Global Variables:
 * - hsqc_spectra: Global spectra state
 * - current_reprocess_spectrum_index: State variable
 * - tooldiv: Tooltip element 
 * - zoom_on_call_function: global on-call function
 * 
 * Direct DOM References:
 * - document.getElementById("pause_cursor") 
 * - document.getElementById("plot_group") 
 * - document.getElementById("infor")
 * - document.getElementById("right_click") 
 * - document.getElementById("peak_information_div") 
 * - document.getElementById("pseudo3d_fitting_plot")
 * - document.activeElement
 * 
 * 
 * Class varibles that are actually DOM elements
 * xAxis_svg, $yAxis_svg, $vis, $rect, $brush_element
 */

/**
 * Constructor for plotit object.
 * @param {*} input 
 */
function plotit(input) {

    this.xscales = new Array();
    this.yscales = new Array();


    this.xscale = [input.x_ppm_start, input.x_ppm_start + input.x_ppm_step * input.n_direct];
    this.yscale = [input.y_ppm_start, input.y_ppm_start + input.y_ppm_step * input.n_indirect];



    this.HEIGHT = input.HEIGHT;
    this.WIDTH = input.WIDTH;
    this.MARGINS = input.MARGINS;
    this.fontsize = input.fontsize ? input.fontsize : 24; //default fontsize is 24
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
    this.peak_level_negative = 0.0;

    this.allow_brush_to_remove = false; //default is false

    this.peak_color = "#FF0000"; //default color is red
    this.peak_color_scale = d3.scaleSequential(d3.interpolateRdBu); //default color scale is Red-Blue. 
    this.peak_color_flag = 'SOLID'; //default is solid, can be a color-map, depending on some peak properties
    this.peak_size = 4;
    this.peak_thickness = 1;
    this.filled_peaks = true; //default is true, can be false if we want to show only the outline of the peaks

    this.new_peaks = []; //a deep copy of peaks from one spectrum, 
    this.visible_peaks = []; //visible peaks in the current plot, used for peak labels
    this.$peaks_text_svg = null; //svg element for peak labels
    this.peak_fontsize = 24; //default font size is 24 for peak labels

    /**
     * Init cross section plot
     * At this time, height is 200, width is the same as the main plot
     * data is empty
     * x_domain is this.xcale
     * y_domain is [0,1]
     */
    this.current_spectral_index = 0;
    this.b_show_cross_section = false;
    this.b_show_projection = false;
    this.x_cross_section_plot = new cross_section_plot(this);
    this.x_cross_section_plot.init(this.WIDTH, 200, this.xscale, [0, 1], { top: 10, right: this.MARGINS.right, bottom: 10, left: this.MARGINS.left }, "cross_section_svg_x", "horizontal");
    this.y_cross_section_plot = new cross_section_plot(this);
    this.y_cross_section_plot.init(200, this.HEIGHT, [0, 1], this.yscale, { top: this.MARGINS.top, right: 10, bottom: this.MARGINS.bottom, left: 10 }, "cross_section_svg_y", 'vertical');

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

plotit.prototype.enable_magnifying_glass = function (flag, ratio, size) {
    this.magnifying_glass = flag ? flag : false; //default is false
    this.magnifying_glass_ratio = ratio ? ratio : 4.0; //default is 4.0
    this.magnifying_glass_size = size ? size : 10; //default is 10% of the plot size
};



/**
 * Set a on call function for zoom event
 */
plotit.prototype.set_zoom_on_call_function = function (func) {
    if (zoom_on_call_function === null) {
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

    this.HEIGHT = input.HEIGHT ? input.HEIGHT : this.HEIGHT; //if input.HEIGHT is not provided, keep the old value
    this.WIDTH = input.WIDTH ? input.WIDTH : this.WIDTH; //if input.WIDTH is not provided, keep the old value
    this.MARGINS = input.MARGINS ? input.MARGINS : this.MARGINS; //if input.MARGINS is not provided, keep the old value
    this.fontsize = input.fontsize ? input.fontsize : this.fontsize; //if input.fontsize is not provided, keep the old value


    this.xRange.range([this.MARGINS.left, this.WIDTH - this.MARGINS.right]);
    this.yRange.range([this.HEIGHT - this.MARGINS.bottom, this.MARGINS.top]);



    /**
     * thickness of the axis line is 5% of the fontsize, round to integer
     * and make sure it is at least 1 pixel
     */
    let thickness = Math.round(this.fontsize * 0.05);
    if (thickness < 1) {
        thickness = 1;
    }

    this.xAxis.scale(this.xRange).tickSizeInner(6 * thickness);
    this.yAxis.scale(this.yRange).tickSizeInner(6 * thickness);


    /**
     * Update brush extent
     */
    this.brush = d3.brush()
        .extent([[this.MARGINS.left, this.MARGINS.top], [this.WIDTH - this.MARGINS.right, this.HEIGHT - this.MARGINS.bottom]])
        .on("end", this.brushend.bind(this));

    this.$brush_element.call(this.brush);


    this.lineFunc.x(function (d) { return self.xRange(d[0]); })
        .y(function (d) { return self.yRange(d[1]); })
        .curve(d3.curveBasis);


    this.$xAxis_svg.attr('transform', 'translate(0,' + (this.HEIGHT - this.MARGINS.bottom) + ')').call(this.xAxis);
    this.$yAxis_svg.attr('transform', 'translate(' + (this.MARGINS.left) + ',0)').call(this.yAxis);

    this.$xAxis_svg.select(".domain").style("stroke-width", thickness + "px");
    this.$xAxis_svg.selectAll(".tick line").style("stroke-width", thickness + "px");

    this.$yAxis_svg.select(".domain").style("stroke-width", thickness + "px");
    this.$yAxis_svg.selectAll(".tick line").style("stroke-width", thickness + "px");


    // Update X Label Group Position
    const xLabelX = this.MARGINS.left + (this.WIDTH - this.MARGINS.left - this.MARGINS.right) / 2;
    const xLabelY = this.HEIGHT - this.MARGINS.bottom / 2 + this.fontsize / 2 + 15;

    this.$vis.select('.x-label-group')
        .attr("transform", `translate(${xLabelX}, ${xLabelY})`);

    this.$vis.selectAll('.xlabel')
        .attr("font-size", this.fontsize + "px");

    // Update Y Label Group Position
    const yLabelX = this.MARGINS.left / 2 - this.fontsize / 2 - 15;
    const yLabelY = this.HEIGHT / 2;

    this.$vis.select('.y-label-group')
        .attr("transform", `translate(${yLabelX}, ${yLabelY}) rotate(-90)`);

    this.$vis.selectAll('.ylabel')
        .attr("font-size", this.fontsize + "px");



    this.$rect
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

    this.x_cross_section_plot.resize_x(this.WIDTH, { top: 10, right: this.MARGINS.right, bottom: 10, left: this.MARGINS.left });
    this.y_cross_section_plot.resize_y(this.HEIGHT, { top: this.MARGINS.top, right: 10, bottom: this.MARGINS.bottom, left: 10 });

};


/**
 * When zoom or resize, we need to reset the axis
 */
plotit.prototype.reset_axis = function () {

    let self = this;

    /**
     * Estimate the number of ticks based on the width of the plot and the fontsize
     */
    const estimatedTickWidth = self.fontsize * 4; // Approximate label length
    const maxTicks = Math.floor((this.WIDTH - this.MARGINS.left - this.MARGINS.right) / estimatedTickWidth);
    this.xAxis.ticks(maxTicks);

    /**
     * Estimate the number of ticks based on the height of the plot and the fontsize
     */
    const estimatedTickHeight = self.fontsize * 2; // Approximate label height
    const maxTicksY = Math.floor((this.HEIGHT - this.MARGINS.top - this.MARGINS.bottom) / estimatedTickHeight);
    this.yAxis.ticks(maxTicksY);

    this.$xAxis_svg.call(this.xAxis);
    this.$yAxis_svg.call(this.yAxis);
    this.$vis.selectAll(".xaxis>.tick>text")
        .each(function () {
            d3.select(this).style("font-size", self.fontsize + "px");
        });
    this.$vis.selectAll(".yaxis>.tick>text")
        .each(function () {
            d3.select(this).style("font-size", self.fontsize + "px");
        });



    /**
     * Reset the position of peaks
     */
    this.$vis.selectAll('.peak')
        .attr('cx', function (d) {
            return self.xRange(d.X_PPM);
        })
        .attr('cy', function (d) {
            return self.yRange(d.Y_PPM);
        });

    /**
     * Also need to reset the position of peak text
     */
    this.$vis.selectAll('.peak_text')
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
    this.$vis.selectAll('.peak_line')
        .attr('x2', function (d) {
            return self.xRange(d.X_PPM);
        })
        .attr('y2', function (d) {
            return self.yRange(d.Y_PPM);
        })
        .attr('x1', function (d) {
            if (Math.abs(d.x - self.xRange(d.X_PPM)) > Math.abs(d.y - self.yRange(d.Y_PPM))) {
                if (d.x > self.xRange(d.X_PPM)) {
                    return d.x - d.text_width / 2;
                }
                else {
                    return d.x + d.text_width / 2;
                }
            }
            else {
                return d.x;
            }
        })
        .attr('y1', function (d) {
            if (Math.abs(d.x - self.xRange(d.X_PPM)) > Math.abs(d.y - self.yRange(d.Y_PPM))) {
                return d.y;
            }
            else {
                if (d.y > self.yRange(d.Y_PPM)) {
                    return d.y - 0.5 * self.peak_fontsize;
                }
                else {
                    return d.y + 0.5 * self.peak_fontsize;
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

    for (let i = 0; i < this.predicted_peaks.length; i++) {
        this.$vis.selectAll('.predicted_peak_' + i)
            .attr("d", self.line(this.predicted_peaks[i]));
    }


    /**
     * Reset vline and hline
     */
    this.$vis.selectAll(".hline").attr("d", self.lineFunc(self.hline_data));
    this.$vis.selectAll(".vline").attr("d", self.lineFunc(self.vline_data));

    if (this.zoom_on_call_function) {
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
    if (this.allow_brush_to_remove && self.spectrum != null && self.peak_flag === 'picked') {
        this.$vis.select(".brush").call(this.brush.move, null);
        let brush_x_ppm_start = self.xRange.invert(e.selection[0][0]);
        let brush_x_ppm_end = self.xRange.invert(e.selection[1][0]);
        let brush_y_ppm_start = self.yRange.invert(e.selection[1][1]);
        let brush_y_ppm_end = self.yRange.invert(e.selection[0][1]);

        /**
         * Make sure brush_x_ppm_start < brush_x_ppm_end and brush_y_ppm_start < brush_y_ppm_end
         * Their order depends on the direction of the brush operation by the user
         */
        if (brush_x_ppm_start > brush_x_ppm_end) {
            [brush_x_ppm_start, brush_x_ppm_end] = [brush_x_ppm_end, brush_x_ppm_start];
        }
        if (brush_y_ppm_start > brush_y_ppm_end) {
            [brush_y_ppm_start, brush_y_ppm_end] = [brush_y_ppm_end, brush_y_ppm_start];
        }

        /**
         * Remove all peaks within the brush.
         * This step can't be undone !!
         */
        self.spectrum.picked_peaks_object.filter_by_columns_range(
            ["X_PPM", "Y_PPM"],
            [brush_x_ppm_start, brush_y_ppm_start],
            [brush_x_ppm_end, brush_y_ppm_end], false);

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

    this.$vis.select(".brush").call(this.brush.move, null);

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
    if (this.inter_window_channel) {
        this.inter_window_channel.postMessage({
            type: '2d_zoom',
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

plotit.prototype.resetzoom = function (x, y) {
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

    this.$vis = d3.select(this.drawto);


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


    this.$vis.selectAll('.xaxis').remove();
    this.$vis.selectAll('.yaxis').remove();


    this.$xAxis_svg = this.$vis.append('svg:g')
        .attr('class', 'xaxis')
        .attr('transform', 'translate(0,' + (this.HEIGHT - this.MARGINS.bottom) + ')');

    this.$yAxis_svg = this.$vis.append('svg:g')
        .attr('class', 'yaxis')
        .attr('transform', 'translate(' + (this.MARGINS.left) + ',0)');

    /**
     * Place holder vline and hline, not visible
     */
    this.hline_data = [[0.1, -1000], [0, -1000]];
    this.vline_data = [[-1000, 0], [-1000, 1]];
    this.$vis.selectAll(".hline").attr("d", self.lineFunc(self.hline_data));
    this.$vis.selectAll(".vline").attr("d", self.lineFunc(self.vline_data));

    this.reset_axis();

    // X Label
    const xLabelX = this.MARGINS.left + (this.WIDTH - this.MARGINS.left - this.MARGINS.right) / 2;
    const xLabelY = this.HEIGHT - this.MARGINS.bottom / 2 + this.fontsize / 2 + 15;

    this.$xLabelGroup = this.$vis.append("g")
        .attr("class", "x-label-group")
        .attr("transform", `translate(${xLabelX}, ${xLabelY})`)
        .call(d3.drag().on("drag", function (event) {
            const transform = d3.select(this).attr("transform");
            // Parse existing translate. Regex matched integers/floats
            const match = /translate\(([^,]+),([^)]+)\)/.exec(transform);
            if (match) {
                let x = parseFloat(match[1]);
                let y = parseFloat(match[2]);
                // Add delta
                x += event.dx;
                y += event.dy;
                d3.select(this).attr("transform", `translate(${x},${y})`);
            }
        }));

    this.$xLabelGroup.append("text")
        .attr("class", "xlabel")
        .attr("text-anchor", "middle")
        .attr("font-size", this.fontsize + "px")
        .attr("font-family", "Arial, Helvetica, sans-serif")
        .text("Chemical Shift (ppm)")
        .on("click", function (event) {
            let e = event || d3.event;
            self.handleLabelClick(e, this, false);
        });

    // Y Label
    const yLabelX = this.MARGINS.left / 2 - this.fontsize / 2 - 15;
    const yLabelY = this.HEIGHT / 2;

    this.$yLabelGroup = this.$vis.append("g")
        .attr("class", "y-label-group")
        .attr("transform", `translate(${yLabelX}, ${yLabelY}) rotate(-90)`)
        .call(d3.drag().on("drag", function (event) {
            const transform = d3.select(this).attr("transform");
            // Parse existing translate.
            const match = /translate\(([^,]+),([^)]+)\)/.exec(transform);
            if (match) {
                let x = parseFloat(match[1]);
                let y = parseFloat(match[2]);
                x += event.dx;
                y += event.dy;
                // Maintain rotation
                d3.select(this).attr("transform", `translate(${x},${y}) rotate(-90)`);
            }
        }));

    this.$yLabelGroup.append("text")
        .attr("class", "ylabel")
        .attr("text-anchor", "middle")
        .attr("font-size", this.fontsize + "px")
        .attr("font-family", "Arial, Helvetica, sans-serif")
        .text("Chemical Shift (ppm)")
        .on("click", function (event) {
            let e = event || d3.event;
            self.handleLabelClick(e, this, true);
        });


    this.$rect = this.$vis.append("defs").append("clipPath")
        .attr("id", "clip")
        .append("rect")
        .attr("x", this.MARGINS.left)
        .attr("y", this.MARGINS.top)
        .attr("width", this.WIDTH - this.MARGINS.right - this.MARGINS.left)
        .attr("height", this.HEIGHT - this.MARGINS.bottom - this.MARGINS.top);

    this.brush = d3.brush()
        .extent([[this.MARGINS.left, this.MARGINS.top], [this.WIDTH - this.MARGINS.right, this.HEIGHT - this.MARGINS.bottom]])
        .on("end", this.brushend.bind(this));

    this.$brush_element = this.$vis.append("g")
        .attr("class", "brush")
        .call(this.brush);

    /**
     * Tool tip for mouse move
     */
    this.$vis.on("mousemove", function (event) {

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
    this.$vis.on("mouseleave", function (d) {
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

    if (self.b_show_projection) {
        self.show_projection();
    }
};

plotit.prototype.setup_cross_line = function (event) {
    let self = this;
    let coordinates = [event.offsetX, event.offsetY];
    let x_ppm = self.xRange.invert(coordinates[0]);
    let y_ppm = self.yRange.invert(coordinates[1]);

    /**
     * Send the cross line to other window
     */
    if (this.inter_window_channel) {
        this.inter_window_channel.postMessage({
            type: 'cross_line',
            y_ppm: y_ppm,
            x_ppm: x_ppm,
            peak_group: document.getElementById("plot_group").value
        });
    }

    let x_ppm_start = hsqc_spectra[0].x_ppm_start + hsqc_spectra[0].x_ppm_ref;
    let x_ppm_end = x_ppm_start + hsqc_spectra[0].x_ppm_step * hsqc_spectra[0].n_direct;
    let y_ppm_start = hsqc_spectra[0].y_ppm_start + hsqc_spectra[0].y_ppm_ref;
    let y_ppm_end = y_ppm_start + hsqc_spectra[0].y_ppm_step * hsqc_spectra[0].n_indirect;

    /**
     * Add a horizontal line at the current y ppm, from x_ppm_start to x_ppm_end
     * This line is subject to zoom, pan, resize, etc
     */
    self.hline_data = [[x_ppm_start, y_ppm], [x_ppm_end, y_ppm]];
    self.$vis.selectAll(".hline").remove();
    self.$vis.append("path")
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
    self.$vis.selectAll(".vline").remove();
    self.$vis.append("path")
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

    /**
     * We are in reprocess mode, so we need to show the cross section of current reprocess spectrum only, for manual phase correction
     */
    if (self.b_show_cross_section && (hsqc_spectra[self.current_spectral_index].spectrum_origin == -2 || hsqc_spectra[self.current_spectral_index].spectrum_origin == -1) && (current_reprocess_spectrum_index == self.current_spectral_index || hsqc_spectra.length == 1)) {
        self.setup_cross_line_from_ppm(x_ppm, y_ppm, self.current_spectral_index, 1/**flag for phase correction */);
    }
    /**
     * else, show cross section of all spectra (except removed spectra)
     * Loop through all spectra and show cross section
     */
    else if (self.b_show_cross_section) {
        this.x_cross_section_plot.clear_data();
        this.y_cross_section_plot.clear_data();
        for (let i = 0; i < hsqc_spectra.length; i++) {
            if (hsqc_spectra[i].spectrum_origin > -3) //-4: unknown, -3: removed. -2: from fid, -1: from ft2
            {
                self.setup_cross_line_from_ppm(x_ppm, y_ppm, i, 0);
            }
        }
    }

};


plotit.prototype.setup_cross_line_from_ppm = function (x_ppm, y_ppm, spectrum_index, flag_manual_phase_correction) {
    let self = this;

    if (flag_manual_phase_correction || self.b_show_cross_section) {
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
         * be within the range of hsqc_spectra[spectrum_index].x_ppm_start to hsqc_spectra[spectrum_index].x_ppm_start + hsqc_spectra[spectrum_index].x_ppm_step * hsqc_spectra[spectrum_index].n_direct
         */
        if (current_vis_x_ppm_start > hsqc_spectra[spectrum_index].x_ppm_start + hsqc_spectra[spectrum_index].x_ppm_ref) {
            current_vis_x_ppm_start = hsqc_spectra[spectrum_index].x_ppm_start + hsqc_spectra[spectrum_index].x_ppm_ref;
        }
        if (current_vis_x_ppm_end < hsqc_spectra[spectrum_index].x_ppm_start + hsqc_spectra[spectrum_index].x_ppm_ref + hsqc_spectra[spectrum_index].x_ppm_step * hsqc_spectra[spectrum_index].n_direct) {
            current_vis_x_ppm_end = hsqc_spectra[spectrum_index].x_ppm_start + hsqc_spectra[spectrum_index].x_ppm_ref + hsqc_spectra[spectrum_index].x_ppm_step * hsqc_spectra[spectrum_index].n_direct;
        }

        let y_pos = Math.floor((y_ppm - hsqc_spectra[spectrum_index].y_ppm_ref - hsqc_spectra[spectrum_index].y_ppm_start) / hsqc_spectra[spectrum_index].y_ppm_step);

        /**
         * if y_pos is out of range, do nothing and return
         */
        if (y_pos > 0 && y_pos < hsqc_spectra[spectrum_index].n_indirect) {
            /**
             * Get ppm values for the data, which is an array stats from hsqc_spectra[spectrum_index].x_ppm_start + x_pos_start * hsqc_spectra[spectrum_index].x_ppm_step
             * to hsqc_spectra[spectrum_index].x_ppm_start + x_pos_end * hsqc_spectra[spectrum_index].x_ppm_step
             */
            let data_ppm = [];
            for (let i = 0; i < hsqc_spectra[spectrum_index].n_direct; i++) {
                data_ppm.push(hsqc_spectra[spectrum_index].x_ppm_start + hsqc_spectra[spectrum_index].x_ppm_ref + i * hsqc_spectra[spectrum_index].x_ppm_step);
            }

            /**
             * Get the data from hsqc_spectra[spectrum_index].raw_data, at row y_pos, from column x_pos_start to x_pos_end
             */
            let data_height = hsqc_spectra[spectrum_index].raw_data.slice(y_pos * hsqc_spectra[spectrum_index].n_direct, (y_pos + 1) * hsqc_spectra[spectrum_index].n_direct);
            let data_height_i = [];
            /**
             * If hsqc_spectra[spectrum_index].raw_data_ri is not empty 
             *  then use it to get the data_height_i
             */
            if (hsqc_spectra[spectrum_index].raw_data_ri.length > 0 && flag_manual_phase_correction == 1) {
                data_height_i = hsqc_spectra[spectrum_index].raw_data_ri.slice(y_pos * hsqc_spectra[spectrum_index].n_direct, (y_pos + 1) * hsqc_spectra[spectrum_index].n_direct);
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
            if (flag_manual_phase_correction == 1) {
                self.x_cross_section_plot.zoom(self.xscale, [data_min, data_max]);
                self.x_cross_section_plot.update_data([hsqc_spectra[spectrum_index].x_ppm_start + hsqc_spectra[spectrum_index].x_ppm_ref, hsqc_spectra[spectrum_index].x_ppm_step, hsqc_spectra[spectrum_index].n_direct],
                    [data_ppm, data_height, data_height_i]);
            }
            else {
                self.x_cross_section_plot.zoom(self.xscale, [data_min, data_max]);
                self.x_cross_section_plot.add_data([data_ppm, data_height], spectrum_index);
            }
        }

        /**
         * Show cross section along y-axis (indirect dimension).
         * 1. Find the closest point in the data hsqc_spectra[spectrum_index].raw_data (1D Float32 array with size hsqc_spectra[spectrum_index].n_direct*hsqc_spectra[spectrum_index].n_indirect)
         * Along direct dimension, ppm are from hsqc_spectra[spectrum_index].x_ppm_start to hsqc_spectra[spectrum_index].x_ppm_start + hsqc_spectra[spectrum_index].x_ppm_step * hsqc_spectra[spectrum_index].n_direct
         * Along indirect dimension, ppm are from hsqc_spectra[spectrum_index].y_ppm_start to hsqc_spectra[spectrum_index].y_ppm_start + hsqc_spectra[spectrum_index].y_ppm_step * hsqc_spectra[spectrum_index].n_indirect
         * So, x_ppm ==> x_ppm_start + x_ppm_step * x_pos, y_ppm ==> y_ppm_start + y_ppm_step * y_pos.
         * So, x_pos = (x_ppm - x_ppm_start)/x_ppm_step, y_pos = (y_ppm - y_ppm_start)/y_ppm_step
         */
        let current_vis_y_ppm_start = self.yscale[0];
        let current_vis_y_ppm_end = self.yscale[1];

        /**
         * However, current_vis_y_ppm_start and current_vis_y_ppm_end must both 
         * be within the range of hsqc_spectra[spectrum_index].y_ppm_start to hsqc_spectra[spectrum_index].y_ppm_start + hsqc_spectra[spectrum_index].y_ppm_step * hsqc_spectra[spectrum_index].n_indirect
         */
        if (current_vis_y_ppm_start > hsqc_spectra[spectrum_index].y_ppm_start + hsqc_spectra[spectrum_index].y_ppm_ref) {
            current_vis_y_ppm_start = hsqc_spectra[spectrum_index].y_ppm_start + hsqc_spectra[spectrum_index].y_ppm_ref;
        }
        if (current_vis_y_ppm_end < hsqc_spectra[spectrum_index].y_ppm_start + hsqc_spectra[spectrum_index].y_ppm_ref + hsqc_spectra[spectrum_index].y_ppm_step * hsqc_spectra[spectrum_index].n_indirect) {
            current_vis_y_ppm_end = hsqc_spectra[spectrum_index].y_ppm_start + hsqc_spectra[spectrum_index].y_ppm_ref + hsqc_spectra[spectrum_index].y_ppm_step * hsqc_spectra[spectrum_index].n_indirect;
        }

        let x_pos = Math.floor((x_ppm - hsqc_spectra[spectrum_index].x_ppm_ref - hsqc_spectra[spectrum_index].x_ppm_start) / hsqc_spectra[spectrum_index].x_ppm_step);

        /**
         * if x_pos is out of range, do nothing and return
         */
        if (x_pos >= 0 && x_pos < hsqc_spectra[spectrum_index].n_direct) {
            /**
             * Get ppm values for the data, which is an array stats from hsqc_spectra[spectrum_index].y_ppm_start + y_pos_start * hsqc_spectra[spectrum_index].y_ppm_step
             * to hsqc_spectra[spectrum_index].y_ppm_start + y_pos_end * hsqc_spectra[spectrum_index].y_ppm_step
             */
            let data_ppm = [];
            for (let i = 0; i < hsqc_spectra[spectrum_index].n_indirect; i++) {
                data_ppm.push(hsqc_spectra[spectrum_index].y_ppm_start + hsqc_spectra[spectrum_index].y_ppm_ref + i * hsqc_spectra[spectrum_index].y_ppm_step);
            }

            /**
             * Get the data from hsqc_spectra[spectrum_index].raw_data, at column x_pos, from row y_pos_start to y_pos_end
             * Along direct dimension, ppm are from hsqc_spectra[spectrum_index].x_ppm_start to hsqc_spectra[spectrum_index].x_ppm_start + hsqc_spectra[spectrum_index].x_ppm_step * hsqc_spectra[spectrum_index].n_direct
             * Along indirect dimension, ppm are from hsqc_spectra[spectrum_index].y_ppm_start to hsqc_spectra[spectrum_index].y_ppm_start + hsqc_spectra[spectrum_index].y_ppm_step * hsqc_spectra[spectrum_index].n_indirect
             * So, x_ppm ==> x_ppm_start + x_ppm_step * x_pos, y_ppm ==> y_ppm_start + y_ppm_step * y_pos.
             * So, x_pos = (x_ppm - x_ppm_start)/x_ppm_step, y_pos = (y_ppm - y_ppm_start)/y_ppm_step
             */
            let data_height = [];
            for (let i = 0; i < hsqc_spectra[spectrum_index].n_indirect; i++) {
                data_height.push(hsqc_spectra[spectrum_index].raw_data[i * hsqc_spectra[spectrum_index].n_direct + x_pos]);
            }
            let data_height_i = [];
            /**
             * If hsqc_spectra[spectrum_index].raw_data_ir is not empty 
             * then use it to get the data_height_i
             */
            if (hsqc_spectra[spectrum_index].raw_data_ir.length > 0) {
                for (let i = 0; i < hsqc_spectra[spectrum_index].n_indirect; i++) {
                    data_height_i.push(hsqc_spectra[spectrum_index].raw_data_ir[i * hsqc_spectra[spectrum_index].n_direct + x_pos]);
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
            if (flag_manual_phase_correction == 1) {
                self.y_cross_section_plot.zoom([data_min, data_max], self.yscale);
                self.y_cross_section_plot.update_data([hsqc_spectra[spectrum_index].y_ppm_start + hsqc_spectra[spectrum_index].y_ppm_ref, hsqc_spectra[spectrum_index].y_ppm_step, hsqc_spectra[spectrum_index].n_indirect],
                    [data_ppm, data_height, data_height_i]);
            }
            else {
                self.y_cross_section_plot.zoom([data_min, data_max], self.yscale);
                self.y_cross_section_plot.add_data([data_ppm, data_height], spectrum_index);
            }
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
     * Clear the cross section plot
     */
    self.x_cross_section_plot.clear_data();
    self.y_cross_section_plot.clear_data();

    /**
     * Loop all spectrum, except unknown and removed
     */
    for (let spe_index = 0; spe_index < hsqc_spectra.length; spe_index++) {
        if (hsqc_spectra[spe_index].spectrum_origin > -3) //-4: unknown, -3: removed. -2: from fid, -1: from ft2
        {

            /**
             * data is an array of 2 numbers, [x_ppm, x_height]
             */
            let ppm = [];
            for (let i = 0; i < hsqc_spectra[spe_index].n_direct; i++) {
                ppm.push(hsqc_spectra[spe_index].x_ppm_start + hsqc_spectra[spe_index].x_ppm_ref + i * hsqc_spectra[spe_index].x_ppm_step);
            }
            self.x_cross_section_plot.zoom(self.xscale, [hsqc_spectra[spe_index].projection_direct_min, hsqc_spectra[spe_index].projection_direct_max]);
            self.x_cross_section_plot.add_data([ppm, hsqc_spectra[spe_index].projection_direct], spe_index);


            /**
             * data2 is an array of 2 numbers, [y_height,y_ppm]
             */
            let ppm2 = [];
            for (let i = 0; i < hsqc_spectra[spe_index].n_indirect; i++) {
                ppm2.push(hsqc_spectra[spe_index].y_ppm_start + hsqc_spectra[spe_index].y_ppm_ref + i * hsqc_spectra[spe_index].y_ppm_step);
            }
            self.y_cross_section_plot.zoom([hsqc_spectra[spe_index].projection_indirect_min, hsqc_spectra[spe_index].projection_indirect_max], self.yscale);
            self.y_cross_section_plot.add_data([ppm2, hsqc_spectra[spe_index].projection_indirect], spe_index);
        }
    }
}

plotit.prototype.redraw_1d = function () {
    if (this.x_cross_section_plot !== null) {
        this.x_cross_section_plot.redraw();
    }
    if (this.y_cross_section_plot !== null) {
        this.y_cross_section_plot.redraw();
    }
}

plotit.prototype.redraw_contour = function () {
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

plotit.prototype.update_cross_section = function (spe_index, flag) {
    /**
     * Only need to update when current cross section is the same as the spectral_index
     */
    if (this.current_spectral_index === spe_index) {
        if (flag === 0) {
            let ppm = [];
            for (let i = 0; i < hsqc_spectra[spe_index].n_direct; i++) {
                ppm.push(hsqc_spectra[spe_index].x_ppm_start + hsqc_spectra[spe_index].x_ppm_ref + i * hsqc_spectra[spe_index].x_ppm_step);
            }
            this.x_cross_section_plot.update_ppm([hsqc_spectra[spe_index].x_ppm_start + hsqc_spectra[spe_index].x_ppm_ref, hsqc_spectra[spe_index].x_ppm_step, hsqc_spectra[spe_index].n_direct], ppm, spe_index);
        }
        else if (flag === 1) {
            let ppm2 = [];
            for (let i = 0; i < hsqc_spectra[spe_index].n_indirect; i++) {
                ppm2.push(hsqc_spectra[spe_index].y_ppm_start + hsqc_spectra[spe_index].y_ppm_ref + i * hsqc_spectra[spe_index].y_ppm_step);
            }
            this.y_cross_section_plot.update_ppm([hsqc_spectra[spe_index].y_ppm_start + hsqc_spectra[spe_index].y_ppm_ref, hsqc_spectra[spe_index].y_ppm_step, hsqc_spectra[spe_index].n_indirect], ppm2, spe_index);
        }
    }
};

/**
 * Redraw contour plot with new order of spectra
 */
plotit.prototype.redraw_contour_order = function () {
    this.contour_plot.spectral_order = this.spectral_order;
    this.contour_plot.drawScene();
}

/**
 * Set lowest visible peak level
 */
plotit.prototype.set_peak_level = function (level) {
    this.peak_level = level;
}

plotit.prototype.set_peak_level_negative = function (level) {
    this.peak_level_negative = level;
}

/**
 * Set peaks for the plot
 */
plotit.prototype.add_peaks = function (spectrum, flag, properties, peak_color_flag) {
    this.spectrum = spectrum;
    this.peak_flag = flag;
    this.peak_properties = properties;
    this.peak_color_flag = peak_color_flag;
    this.draw_peaks();
};

/**
 * This function is called when the user changed ASS column of the shown peak object to update this.new_peaks
 * @param {int} index: index of the peak
 * @param {string} assignment: new assignment
 * @returns 
 */
plotit.prototype.update_peak_ass_property = function (index, assignment) {
    let self = this;
    for (let i = 0; i < self.new_peaks.length; i++) {
        const obj = self.new_peaks[i];

        if (obj && obj['INDEX'] == index) {
            obj['ASS'] = assignment;
        }
    }

    /**
     * Need to update this.visible_peaks as well, which is a deep copy of sub array of this.new_peaks
     * note: it is possible this.visible_peaks does NOT include index
     */
    for (let i = 0; i < self.visible_peaks.length; i++) {
        const obj = self.visible_peaks[i];
        if (obj && obj['INDEX'] == index) {
            obj['ASS'] = assignment;
        }
    }

    /**
     * Update text on the plot
     */
    if (this.$peaks_text_svg !== null) {
        this.$peaks_text_svg
            .text(function (d) {
                if (typeof d[self.text_label] === "number") {
                    if (Number.isInteger(d[self.text_label]) && d[self.text_label] < 1000) {
                        return d[self.text_label].toFixed(0);
                    }
                    else if (d[self.text_label] > 1000) {
                        return d[self.text_label].toExponential(2);
                    }
                    else if (d[self.text_label] < 0.01) {
                        return d[self.text_label].toExponential(2);
                    }
                    else {
                        return d[self.text_label].toFixed(2);
                    }
                }
                else {
                    return d[self.text_label];
                }
            })
            .attr('dx', function (d) {
                /**
                 * Save the text width to d.text_width. to be used in the tick function
                 * to update line position
                 */
                d.text_width = this.getComputedTextLength();
                return -this.getComputedTextLength() / 2;
            });
    }

}

/**
 * Add peak labels to the plot. Only show the labels for the peaks that are visible
 * That is, this function need to be called after any zoom, pan, resize or contour level change to be valid
 */
plotit.prototype.update_peak_labels = function (flag, min_dis, max_dis, repulsive_force, peak_fontsize, color, label) {
    let self = this;

    self.peak_fontsize = peak_fontsize;
    self.text_label = label;

    /**
     * In case of new simulation, stop the old one
     */
    if (this.sim != null) {
        this.sim.stop();
    }

    /**
     * A custom force to move text at relative (+20,-20) to the peak location.
     * @returns 
     */
    function text_force() {
        var strength = 0.1;

        function force(alpha) {
            for (var i = 0; i < nodes.length; ++i) {
                let node = nodes[i];
                let distance1 = (self.xRange(node.X_PPM) - node.x);
                let distance2 = (self.yRange(node.Y_PPM) - node.y);
                let distance = Math.sqrt(distance1 * distance1 + distance2 * distance2);
                let force_amplitude = 0;
                if (distance > max_dis) {
                    force_amplitude = (distance - max_dis) * strength * alpha / distance;
                }
                else if (distance < min_dis) {
                    force_amplitude = (distance - min_dis) * strength * alpha / distance
                }
                let force_x = distance1 * force_amplitude;
                let force_y = distance2 * force_amplitude;

                node.vx += force_x;
                node.vy += force_y;
            }
        }

        force.initialize = function (_) {
            nodes = _;
        };

        return force;
    };


    function avoid_peaks() {
        let nodes;
        var strength = repulsive_force;

        /**
         * Require all nodes to avoid all peaks. Brute force method
         * @param {*} alpha 
         */
        function force(alpha) {
            for (let j = 0; j < nodes.length; j++) {
                let node = nodes[j];
                for (let i = 0; i < nodes.length; i++) {
                    if (i === j) {
                        continue;
                    }
                    let peak = nodes[i];
                    let distance1 = self.xRange(peak.X_PPM) - node.x;
                    let distance2 = self.yRange(peak.Y_PPM) - node.y;
                    let distance_square = distance1 * distance1 + distance2 * distance2;
                    if (distance_square < 40000) {
                        let force_amplitude = strength * alpha;
                        let force_x = distance1 * force_amplitude / distance_square;
                        let force_y = distance2 * force_amplitude / distance_square;

                        node.vx -= force_x;
                        node.vy -= force_y;
                    }
                }
            }

        }

        force.initialize = _ => nodes = _;
        return force;
    }

    function boundary_force() {
        let nodes;
        var strength = 10.0;
        var buffer = 30.0;

        /**
         * Require all nodes to avoid all peaks. Brute force method
         * @param {*} alpha 
         */
        function force(alpha) {
            for (let j = 0; j < nodes.length; j++) {
                let node = nodes[j];
                /**
                 * if node is out of boundary, then apply a force to move it back
                 * Linear soft core repulsion with a buffer of 10 pixels
                 */
                if (node.x < self.MARGINS.left + buffer) {
                    node.vx -= strength * alpha * (node.x - self.MARGINS.left - buffer);
                }
                if (node.x > self.WIDTH - self.MARGINS.right - buffer) {
                    node.vx -= strength * alpha * (node.x - self.WIDTH + self.MARGINS.right + buffer);
                }
                if (node.y < self.MARGINS.top + buffer) {
                    node.vy -= strength * alpha * (node.y - self.MARGINS.top - buffer);
                }
                if (node.y > self.HEIGHT - self.MARGINS.bottom - buffer) {
                    node.vy -= strength * alpha * (node.y - self.HEIGHT + self.MARGINS.bottom + buffer);
                }
            }
        }

        function strength(_) {
            if (!arguments.length) return strength;
            strength = _;
            return force;
        }

        function buffer(_) {
            if (!arguments.length) return buffer;
            buffer = _;
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
            && (typeof d.HEIGHT === "undefined" || d.HEIGHT > self.peak_level || d.HEIGHT < self.peak_level_negative);
    });

    /**
     * Make a deep copy of visible_peaks to this.visible_peaks
     */
    this.visible_peaks = JSON.parse(JSON.stringify(visible_peaks));

    /**
    * Init new_peaks[i].x and y property for the force simulation
    */
    for (let i = 0; i < self.visible_peaks.length; i++) {
        self.visible_peaks[i].x = self.xRange(self.visible_peaks[i].X_PPM) + 20 * Math.random() - 10.0;
        self.visible_peaks[i].y = self.yRange(self.visible_peaks[i].Y_PPM) + 20 * Math.random() - 10.0;
    }

    self.$vis.selectAll('.peak_text').remove();
    self.$vis.selectAll('.peak_line').remove();
    self.$peaks_text_svg = null;

    if (flag == false) {
        return;
    }

    const peak_text_drag = d3.drag()
        .on("start", function () {
        })
        .on("drag", function (event, d) {
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
        .on("end", function (event, d) {
            /**
             * Start the simulation again
             */
            d.X_TEXT_PPM = self.xRange.invert(event.x);
            d.Y_TEXT_PPM = self.yRange.invert(event.y);
            self.sim.stop();
            self.sim.alpha(1.0).alphaMin(0.1).restart();
        });

    this.$peaks_text_svg = self.$vis.selectAll('.peak_text')
        .data(self.visible_peaks)
        .enter()
        .append('text')
        .attr('class', 'peak_text')
        .attr('font-size', peak_fontsize)
        .style('fill', function () {
            return self.peak_color;
        })
        .text(function (d) {
            if (typeof d[label] === "number") {
                if (Number.isInteger(d[label]) && d[label] < 1000) {
                    return d[label].toFixed(0);
                }
                else if (d[label] > 1000) {
                    return d[label].toExponential(2);
                }
                else if (d[label] < 0.01) {
                    return d[label].toExponential(2);
                }
                else {
                    return d[label].toFixed(2);
                }
            }
            else {
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
    this.$peaks_text_svg
        .attr('dx', function (d) {
            /**
             * Save the text width to d.text_width. to be used in the tick function
             * to update line position
             */
            d.text_width = this.getComputedTextLength();
            return -this.getComputedTextLength() / 2;
        })
        .attr('dy', function () {
            return 0.5 * peak_fontsize;
        });

    /**
     * Also add a line between peak and peak_text
     */
    this.$peak_line_svg = self.$vis.selectAll('.peak_line')
        .data(self.visible_peaks)
        .enter()
        .append('line')
        .attr('class', 'peak_line')
        .attr('stroke', color)
        /**
         * x1 and y1 is the peak label position
         */
        .attr('x1', function (d) {
            return d.x;
        })
        .attr('y1', function (d) {
            return d.y;
        })
        .attr('x2', function (d) {
            /**
             * x2 and y2 is the peak position
             */
            return self.xRange(d.X_PPM);
        })
        .attr('y2', function (d) {
            return self.yRange(d.Y_PPM);
        })
        .attr("clip-path", "url(#clip)");

    self.$peaks_text_svg.call(peak_text_drag);

    /**
     * Add a force simulation
     */

    this.sim = d3.forceSimulation(self.visible_peaks)
        .force("near_peak", text_force())
        .force("inter_collide", d3.forceCollide().radius(40).strength(1).iterations(1))
        .force('exclude', d3.forceManyBody().strength(-10))
        .force("avoid", avoid_peaks())
        .force("boundary", boundary_force())
        .stop();
    ;


    this.sim.on("tick", () => {
        console.log(this.sim.alpha());
        self.$peaks_text_svg
            .attr("x", d => d.x)
            .attr("y", d => d.y)
            .attr('dx', function (d) {
                return -this.getComputedTextLength() / 2;
            })
            .attr('dy', function () {
                return 0.5 * peak_fontsize
            });

        /**
         * Need to update X_TEXT_PPM and Y_TEXT_PPM, so that reset_axis will work properly
         */
        this.visible_peaks.forEach(peak => {
            peak.X_TEXT_PPM = self.xRange.invert(peak.x);
            peak.Y_TEXT_PPM = self.yRange.invert(peak.y);
        });

        self.$peak_line_svg
            .attr('x1', function (d) {
                if (Math.abs(d.x - self.xRange(d.X_PPM)) > Math.abs(d.y - self.yRange(d.Y_PPM))) {
                    if (d.x > self.xRange(d.X_PPM)) {
                        return d.x - d.text_width / 2;
                    }
                    else {
                        return d.x + d.text_width / 2;
                    }
                }
                else {
                    return d.x;
                }
            })
            .attr('y1', function (d) {
                if (Math.abs(d.x - self.xRange(d.X_PPM)) > Math.abs(d.y - self.yRange(d.Y_PPM))) {
                    return d.y;
                }
                else {
                    if (d.y > self.yRange(d.Y_PPM)) {
                        return d.y - 0.5 * peak_fontsize;
                    }
                    else {
                        return d.y + 0.5 * peak_fontsize;
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
    if (typeof self.peak_flag === 'undefined' || self.peak_flag === null) {
        return;
    }

    /**
     * Remove all peaks if there is any
     */
    self.$vis.selectAll('.peak').remove();

    /**
     * Filter peaks based on peak level
     */
    if (self.peak_flag === 'picked') {
        this.new_peaks = self.spectrum.picked_peaks_object.get_selected_columns(self.peak_properties);
    }
    else {
        this.new_peaks = self.spectrum.fitted_peaks_object.get_selected_columns(self.peak_properties);
    }

    for (let i = 0; i < self.new_peaks.length; i++) {
        self.new_peaks[i].radius = 10.0;
    }


    /**
     * Draw peaks, red circles without fill
     */
    this.$peaks_svg = self.$vis.selectAll('.peak')
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
        .attr('visibility', function (d) {
            if (typeof d.HEIGHT === "undefined" || d.HEIGHT > self.peak_level || d.HEIGHT < self.peak_level_negative) {
                return "visible";
            }
            else {
                return "hidden";
            }
        })
        .attr("clip-path", "url(#clip)")
        .attr('r', self.peak_size)
        .attr('stroke', function () {
            return self.peak_color;
        })
        .attr('fill', function () {
            if (self.filled_peaks === true) {
                return self.peak_color;
            }
            else {
                return 'none';
            }
        })
        .attr('stroke-width', self.peak_thickness);
};

/**
 * Function to allow clicking on peaks, to pop up a window with peak information
 * @param {boolean} flag: true to allow clicking on peaks, false to disable
 * 
 */
plotit.prototype.allow_hover_on_peaks = function (flag) {
    let self = this;
    let timeout_id = null;

    if (flag === true) {
        self.$vis.selectAll('.peak').on('mouseover', function (event, d) {
            /**
             * Show a window with peak information
             * 1. get current cursor position (relative to the window, not the plot)
             */
            let x = event.clientX + 20;
            let y = event.clientY + 20;
            /**
             * Move the div #peak_information_div to the cursor position as absolute position
             * set display to block. 
             */
            let peak_information_div = document.getElementById('peak_information_div');

            peak_information_div.style.left = x + 'px';
            peak_information_div.style.top = y + 'px';

            /**
             * self.pseudo3d_plane_y_value is something line Z_A0, Z_A1, Z_A2 ....
             * and Z_A1_STD, Z_A2_STD, Z_A3_STD .... (no Z_A0_STD!)
             * Separate them into two arrays
             * self.pseudo3d_plane_y_value is the first one
             * self.pseudo3d_plane_y_std_value is the second one
             */
            let pseudo3d_plane_y_value = [];
            let pseudo3d_plane_y_std_value = [];
            for (let i = 0; i < self.pseudo3d_plane_y_value.length; i++) {
                if (self.pseudo3d_plane_y_value[i].endsWith('_STD')) {
                    pseudo3d_plane_y_std_value.push(self.pseudo3d_plane_y_value[i]);
                }
                else {
                    pseudo3d_plane_y_value.push(self.pseudo3d_plane_y_value[i]);
                }
            }


            /**
             * Generate a data array of {x,y} pair for the fitting plot where
             * x is this.pseudo3d_plane_value
             * y is d[this.pseudo3d_plane_y_value]
             */

            let data = [];
            if (pseudo3d_plane_y_std_value.length === pseudo3d_plane_y_value.length - 1) {
                data = [{
                    x: 0,
                    y: Math.log(d[pseudo3d_plane_y_value[0]]),
                    y_std: 0,
                }];
                for (let i = 1; i < self.pseudo3d_plane_value.length; i++) {
                    let y_value = Math.log(d[pseudo3d_plane_y_value[i]]);
                    let y_value_std = Math.log(d[pseudo3d_plane_y_value[i]] + d[pseudo3d_plane_y_std_value[i - 1]]) - y_value;
                    data.push({ x: self.pseudo3d_plane_value[i], y: y_value, y_std: y_value_std });
                }
            }
            /**
             * Else, there is no STD value. 
             */
            else {
                data = [{
                    x: 0,
                    y: Math.log(d[pseudo3d_plane_y_value[0]]),
                }];
                for (let i = 1; i < self.pseudo3d_plane_value.length; i++) {
                    let y_value = Math.log(d[pseudo3d_plane_y_value[i]]);
                    data.push({ x: self.pseudo3d_plane_value[i], y: y_value });
                }
            }

            let slope = d.DOSY * self.pseudo3d_slope_factor; // slope of the line, negative because DOSY is in ms and we want to plot it in log scale

            const data2 = [
                { x: 0, y: 0 },
                { x: data[data.length - 1].x, y: slope * data[data.length - 1].x } // line end point
            ];


            /**
             * Remove (if any) previous drawing
             */
            document.getElementById("pseudo3d_fitting_plot").innerHTML = "";


            const plot = new fitting_plot('#pseudo3d_fitting_plot', {
                width: 400,
                height: 300,
                xLabel: self.pseudo3d_x_label,
                yLabel: self.pseudo3d_y_label,
            });

            plot.draw_scatter(data);
            plot.draw_line(data2);

            /**
           * If d.DOSY_STD is defined, then add two lines with slope = (d.DOSY+-d.DOSY_STD) * self.pseudo3d_slope_factor
           */
            if (typeof d.DOSY_STD !== "undefined") {
                const data3 = [
                    { x: 0, y: 0 },
                    { x: data[data.length - 1].x, y: (slope + d.DOSY_STD * self.pseudo3d_slope_factor) * data[data.length - 1].x } // line end point
                ];
                const data4 = [
                    { x: 0, y: 0 },
                    { x: data[data.length - 1].x, y: (slope - d.DOSY_STD * self.pseudo3d_slope_factor) * data[data.length - 1].x } // line end point
                ];
                plot.draw_line(data3);
                plot.draw_line(data4);
            }


            peak_information_div.style.display = 'block';
            clearTimeout(timeout_id); // clear the timeout if any
        })
            .on('mouseout', function () {
                /**
                 * Hide the div #peak_information_div after 5 seconds
                 */
                timeout_id = setTimeout(function () {
                    let peak_information_div = document.getElementById('peak_information_div');
                    peak_information_div.style.display = 'none';
                }, 5000);
            });
    }
    else {
        self.$vis.selectAll('.peak').on('mouseover', null);
        self.$vis.selectAll('.peak').on('mouseout', null);
    }
};

/**
 * Function to allow right click on plot to set up cross line location
 * @param {*} flag: true to allow right click, false to disable.
 * For both case, we will disable the default right click menu
 */
plotit.prototype.allow_right_click = function (flag) {
    let self = this;
    if (flag === true) {
        self.$vis.on('contextmenu', function (event) {
            event.preventDefault();
            self.setup_cross_line(event);
        });
    }
    else {
        self.$vis.on('contextmenu', function (event) {
            event.preventDefault();
        });
    }
};


/**
 * Redraw peaks on the plot.
 * Only update peak color, size, thickness, and visibility
 * Will not change the peak position
 */
plotit.prototype.redraw_peaks = function () {
    let self = this;
    self.$vis.selectAll('.peak')
        .attr('r', self.peak_size)
        .attr('stroke', function (d) {
            if (self.peak_color_flag === "SOLID") {
                return self.peak_color;
            }
            else {
                if (d[self.peak_color_flag] >= self.peak_color_flag_limit[0] && d[self.peak_color_flag] <= self.peak_color_flag_limit[1]) {
                    let scaled_value = (d[self.peak_color_flag] - self.peak_color_flag_limit[0]) / (self.peak_color_flag_limit[1] - self.peak_color_flag_limit[0]);
                    return self.peak_color_scale(scaled_value);
                }
                else if (d[self.peak_color_flag] < self.peak_color_flag_limit[0]) {
                    return self.peak_color_scale(0);
                }
                else // d[self.peak_color_flag] > self.peak_color_flag_limit[1]
                {
                    return self.peak_color_scale(1);
                }

            }

        })
        .attr('visibility', function (d) {
            if (typeof d.HEIGHT === "undefined" || d.HEIGHT > self.peak_level || d.HEIGHT < self.peak_level_negative) {
                return "visible";
            }
            else {
                return "hidden";
            }
        })
        .attr('fill', function () {
            if (self.filled_peaks === true) {
                return self.peak_color;
            }
            else {
                return 'none';
            }
        })
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
        .on('drag', function (event, d) {
            d3.select(this)
                .attr('cx', event.x)
                .attr('cy', event.y);
        })
        .on('end', function (event, d) {
            /**
             * Get new coordinates of the peak
             */
            d.X_PPM = self.xRange.invert(event.x);
            d.Y_PPM = self.yRange.invert(event.y);
            /**
             * Check amplitude of the spectrum at the peak position
             * if less than lowest contour level, remove the peak
             */
            let y_pos = Math.floor((d.Y_PPM - self.spectrum.y_ppm_ref - self.spectrum.y_ppm_start) / self.spectrum.y_ppm_step);
            let x_pos = Math.floor((d.X_PPM - self.spectrum.x_ppm_ref - self.spectrum.x_ppm_start) / self.spectrum.x_ppm_step);
            let data_height = 0.0; //default value if out of range
            if (x_pos >= 0 && x_pos < self.spectrum.n_direct && y_pos >= 0 && y_pos < self.spectrum.n_indirect) {
                data_height = self.spectrum.raw_data[y_pos * self.spectrum.n_direct + x_pos];
            }

            /**
             * Update the peak in the picked peaks
             */
            if (self.peak_flag === 'picked') {
                self.spectrum.picked_peaks_object.update_row(d.INDEX, d.X_PPM, d.Y_PPM);
            }


        });

    if (flag === true && self.peak_flag === 'picked') {
        self.$vis.selectAll('.peak').call(self.peak_drag);
    }
    else {
        self.$vis.selectAll('.peak').on('.drag', null);
    }
}

/**
 * Allow click to add peaks
 */
plotit.prototype.allow_click_to_add_peak = function (flag) {

    let self = this;

    if (flag === true && self.peak_flag === 'picked') {
        self.$vis.on('click', function (event) {
            let coordinates = d3.pointer(event);
            let x_ppm = self.xRange.invert(coordinates[0]);
            let y_ppm = self.yRange.invert(coordinates[1]);
            /**
                 * Get amplitude of the spectrum at the peak position
                 */
            let y_pos = Math.floor((y_ppm - self.spectrum.y_ppm_ref - self.spectrum.y_ppm_start) / self.spectrum.y_ppm_step);
            let x_pos = Math.floor((x_ppm - self.spectrum.x_ppm_ref - self.spectrum.x_ppm_start) / self.spectrum.x_ppm_step);
            let data_height = 0.0; //default value if out of range
            if (x_pos >= 0 && x_pos < self.spectrum.n_direct && y_pos >= 0 && y_pos < self.spectrum.n_indirect) {
                data_height = self.spectrum.raw_data[y_pos * self.spectrum.n_direct + x_pos];
            }
            let new_peak = {
                X_PPM: x_ppm,
                Y_PPM: y_ppm,
                HEIGHT: data_height,
            };
            if (self.spectrum != null && (new_peak.HEIGHT > self.peak_level || new_peak.HEIGHT < self.peak_level_negative)) {
                self.spectrum.picked_peaks_object.add_row(new_peak);
                self.draw_peaks();
            }
        });
    }
    else {
        self.$vis.on('click', null);
    }
};

/**
 * Remove peaks from the plot
 */
plotit.prototype.remove_picked_peaks = function () {
    let self = this;
    self.spectrum = null;
    self.$vis.selectAll('.peak').remove();
    self.$vis.selectAll('.peak_text').remove();
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
plotit.prototype.add_predicted_peaks = function (peaks, flag_valid, index) {
    let self = this;

    if (index >= self.predicted_peaks.length) {
        /**
         * Add empty array to self.predicted_peaks to reach length of index+1
         */
        for (let i = self.predicted_peaks.length; i <= index; i++) {
            self.predicted_peaks.push([]);
        }
    }
    self.predicted_peaks[index] = peaks;

    self.x = d3.scaleLinear().range([self.MARGINS.left, self.WIDTH - self.MARGINS.right])
        .domain(self.xscale);
    self.y = d3.scaleLinear().range([self.HEIGHT - self.MARGINS.bottom, self.MARGINS.top])
        .domain(self.yscale);

    self.$vis.selectAll('.predicted_peak_' + index).remove();

    self.line = d3.line()
        .x((d) => self.x(d[0]))
        .y((d) => self.y(d[1]));

    self.$vis.append('path')
        .attr('class', 'predicted_peak_' + index)
        .attr("d", self.line(peaks))
        .attr('fill', 'none')
        .attr('stroke', (flag_valid === true) ? 'green' : 'purple')
        .attr('stroke-width', 3);
}

plotit.prototype.handleLabelClick = function (event, target, isRotated) {
    // Prevent event bubbling so dragging doesn't start immediately or cause issues
    if (event && event.stopPropagation) event.stopPropagation();

    const textNode = d3.select(target);
    // If already editing, ignore
    if (textNode.style("display") === "none") return;

    const currentText = textNode.text();
    const fontSize = parseFloat(textNode.attr("font-size"));

    // Hide the text node
    textNode.style("display", "none");

    // Append foreign object to the PARENT group
    const parentGroup = d3.select(target.parentNode);

    // Calculate appropriate dimensions for input
    // Approximate width based on characters
    const inputWidth = (currentText.length + 10) * (fontSize * 0.6);
    const inputHeight = fontSize + 10;

    const foreignObject = parentGroup.append("foreignObject")
        .attr("width", inputWidth)
        .attr("height", inputHeight)
        // Center the input relative to the group origin (0,0) since text-anchor is middle
        .attr("x", -inputWidth / 2)
        .attr("y", -fontSize) // approximate vertical alignment
        .style("overflow", "visible");

    const input = foreignObject.append("xhtml:input")
        .attr("type", "text")
        .attr("value", currentText)
        .style("font-size", fontSize + "px")
        .style("width", "100%")
        .style("height", "100%")
        .style("border", "1px dashed #333")
        .style("background", "rgba(255,255,255,0.8)")
        .style("text-align", "center")
        .style("color", "black");

    // Focus and select all text
    const inputNode = input.node();
    inputNode.focus();
    inputNode.select();

    let isClosed = false;

    // Save on Enter or Blur
    const saveAndClose = () => {
        if (isClosed) return;
        isClosed = true;
        const newText = inputNode.value;
        textNode.text(newText);
        textNode.style("display", null);
        foreignObject.remove();
    };

    const cancelAndClose = () => {
        if (isClosed) return;
        isClosed = true;
        textNode.style("display", null);
        foreignObject.remove();
    }

    input.on("mousedown", function (event) {
        let e = event || d3.event;
        e.stopPropagation();
    });

    input.on("keydown", function (event) {
        let e = event || d3.event;
        if (e.keyCode === 13) { // Enter
            saveAndClose();
        }
        if (e.keyCode === 27) { // Escape
            cancelAndClose();
        }
    });

    input.on("blur", function () {
        saveAndClose();
    });
};