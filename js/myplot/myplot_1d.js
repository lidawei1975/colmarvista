
/**
 * Helper functions
 */

function lttb(data, threshold) {
    if (threshold >= data.length || threshold === 0) {
        return data; // Nothing to do
    }

    const sampled = [];
    const every = (data.length - 2) / (threshold - 2);

    let a = 0;  // Initially a is the first point in the triangle
    let maxAreaPoint;
    let maxArea;
    let area;
    let nextA;

    sampled.push(data[a]); // Always add the first point

    for (let i = 0; i < threshold - 2; i++) {
        let avgX = 0;
        let avgY = 0;
        let avgRangeStart = Math.floor((i + 1) * every) + 1;
        let avgRangeEnd = Math.floor((i + 2) * every) + 1;
        avgRangeEnd = avgRangeEnd < data.length ? avgRangeEnd : data.length;

        let avgRangeLength = avgRangeEnd - avgRangeStart;

        for (let j = avgRangeStart; j < avgRangeEnd; j++) {
            avgX += data[j][0];
            avgY += data[j][1];
        }
        avgX /= avgRangeLength;
        avgY /= avgRangeLength;

        let rangeOffs = Math.floor((i + 0) * every) + 1;
        let rangeTo = Math.floor((i + 1) * every) + 1;

        maxArea = -1;

        for (let j = rangeOffs; j < rangeTo; j++) {
            area = Math.abs(
                (data[a][0] - avgX) * (data[j][1] - data[a][1]) -
                (data[a][0] - data[j][0]) * (avgY - data[a][1])
            ) * 0.5;
            if (area > maxArea) {
                maxArea = area;
                maxAreaPoint = data[j];
                nextA = j;
            }
        }

        sampled.push(maxAreaPoint);
        a = nextA;
    }

    sampled.push(data[data.length - 1]); // Always add the last point

    return sampled;
}


function downsampleData(data, threshold, xDomain)
{
    const visible = data.filter(d => d[0] >= xDomain[0] && d[0] <= xDomain[1]);
    if (visible.length <= threshold) return visible;
    return lttb(visible, threshold);
}


class myplot_1d {
    constructor() {

        // test d3 exist
        if (!d3) throw Error('d3 library not set');
        this.margin = ({ top: 10, right: 10, bottom: 80, left: 120 });
        
        this.baseline_exist = false;
        /**
         * Default lineGenerator width of the experimental spectrum, reconstructed spectrum, and simulated spectrum
         */
        this.exp_line_width = 1.0;

        this.peaks_symbol = null; //this.peaks_symbol is an array of [x,y] pairs. X is ppm, Y is intensity
    }

    /**
     * 
     * @param {int} width  width of the plot SVG element
     * @param {int} height height of the plot SVG element
     * This function will init the plot and add the experimental spectrum only
     */
    init(width, height) {

        let self = this; // to use this inside some functions
        
        this.width = width;
        this.height = height;


        this.vis = d3.select("#plot_1d").insert("svg", ":first-child")
            .attr("id", "main_plot")
            .attr("xmlns", "http://www.w3.org/2000/svg")
            .attr("width", this.width)
            .attr("height", this.height);

        /**
         * Default (initial) x is from 12 ppm to 0 ppm
         */
        this.xscale = d3.scaleLinear()
            .domain([0,12])
            .range([this.width - this.margin.right, this.margin.left])
            .nice();

        /**
         * Default (init) y is from 0 to 1
         */
        this.yscale = d3.scaleLinear()
            .domain([0,1])
            .range([this.height - this.margin.bottom, this.margin.top])
            .nice();

        this.true_width = this.width - this.margin.left - this.margin.right;
        this.true_height = this.height - this.margin.top - this.margin.bottom;
        /**
        * Define x axis object
        */
        this.xAxis = d3.axisBottom(this.xscale).ticks(this.true_width / 100.0);

        /**
         * Add x axis to the plot
         */
        this.xAxis_element
            = this.vis.append('svg:g')
                .attr('class', 'xaxis')
                .attr('transform', 'translate(0,' + (this.height - this.margin.bottom) + ')')
                .style("stroke-width", 3.5)
                .call(this.xAxis);

        /**
         * Add x label to the plot
         */
        this.xLabel
            = this.vis.append("text")
                .attr("class", "x-label")
                .attr("text-anchor", "center")
                .attr("x", this.width / 2)
                .attr("y", this.height - 10)
                .attr("font-size", "1.5em")
                .text("Proton Chemical Shift (ppm)");

        /**
         * Define y axis object. Add y axis to the plot and y label
        */
        this.yAxis = d3.axisLeft(this.yscale).ticks(this.true_height / 100.0).tickFormat(d3.format(".1e"));

        this.yAxis_element
            = this.vis.append('svg:g')
                .attr('class', 'yaxis')
                .attr('transform', 'translate(' + (this.margin.left) + ',0)')
                .style("stroke-width", 3.5)
                .call(this.yAxis);

        this.yLabel
            = this.vis.append("text")
                .attr("class", "y-label")
                .attr("text-anchor", "center")
                .attr("y", this.height / 2)
                .attr("x", 16)
                .attr("cx", 0).attr("cy", 0)
                .attr("transform", "rotate(-90 30," + this.height / 2 + ")")
                .attr("font-size", "1.5em")
                .text("Intensity");

        /**
         * Because d3 des not support axis font size. We have to use css to change the font size of the axis
         */
        d3.selectAll(".yaxis>.tick>text")
            .each(function () {
                d3.select(this).style("font", "italic 2.0em sans-serif");
            });

        d3.selectAll(".xaxis>.tick>text")
            .each(function () {
                d3.select(this).style("font", "italic 2.0em sans-serif");
            });


        /**
         * Define lineGenerator object
         * this.lineGenerator is a function that will convert data (ppm,amp) to path (screen coordinates)
        */
        this.lineGenerator = d3.line()
            .x((d) => this.xscale(d[0]))
            .y((d) => this.yscale(d[1]))
            ;


        /**
         * Define clip space for the plot. 
        */
        this.$clip_space = this.vis.append("defs").append("clipPath")
            .attr("id", "clip")
            .append("rect")
            .attr("transform", "translate(" + this.margin.left + "," + this.margin.top + ")")
            .attr("width", width - this.margin.left - this.margin.right)
            .attr("height", height - this.margin.top - this.margin.bottom);

        this.lineCounter = 0; // Counter for lineGenerator IDs
        this.allLines = {}; // Object to store all lines with their IDs

        this.handleMouseMoveHandler = this.handleMouseMove.bind(this);
        // window.addEventListener('mousemove', self.handleMouseMoveHandler);
        /**
         * mousemove event to show the tooltip and pan the plot
         */
        this.vis.on('mousemove', (e) => { self.handleMouseMoveHandler(e); });

        /**
         * mouse drag event to pan the plot
         */
        this.vis.on('mousedown', (e) => {
            e.preventDefault();
            // console.log('mousedown');
            // console.log(e.clientX, e.clientY);
            this.click_event = true;
            this.mouse_is_down = true;

            this.handleMouseUpHandler = this.handleMouseUp.bind(this);
            this.vis.on('mouseup', (e) => { self.handleMouseUpHandler(e); });
            // window.addEventListener('mouseup', self.handleMouseUpHandler);
            self.startMousePos = [e.clientX, e.clientY];
        });

        /**
         * mouse wheel event to zoom the plot
         */
        this.vis.on('wheel', (e) => {
            e.preventDefault();
            var delta = e.deltaY;
            if (delta > 0) {
                delta = 1.1;
            }
            else {
                delta = 0.9;
            }

            /**
             * Get the ppm and amp of the mouse position
             */
            let bound = document.getElementById('main_plot').getBoundingClientRect();
            let ppm = self.xscale.invert(e.clientX - bound.left);
            let amp = self.yscale.invert(e.clientY - bound.top);


            /**
            * left side of the Y axis or shift key is pressed, Y zoom only
            */
            if (e.clientX - bound.left < self.margin.left || e.shiftKey == true) {
                /**
                 * Get top and bottom of the visible range
                 * We need to zoom in/out around the mouse position
                 * So, we need to calculate the new top and bottom of the visible range
                 * Note: Y axis is inverted
                 * So, top is smaller than bottom
                 */
                let top = self.yscale.domain()[0];
                let bottom = self.yscale.domain()[1];
                let new_top = amp - (amp - top) * delta;
                let new_bottom = amp + (bottom - amp) * delta;
                this.yscale.domain([new_top, new_bottom]);
            }
            /**
             * Right side of the Y axis, X zoom only
             */
            else if (e.clientX - bound.left > self.margin.left && e.clientX - bound.left < self.width - self.margin.right) {
                /**
                 * Get left and right of the visible range
                 * We need to zoom in/out around the mouse position
                 * So, we need to calculate the new left and right of the visible range
                 */
                let left = self.xscale.domain()[0];
                let right = self.xscale.domain()[1];
                let new_left = ppm - (ppm - left) * delta;
                let new_right = ppm + (right - ppm) * delta;
                this.xscale.domain([new_left, new_right]);
            }

            this.redraw();
        });

    }


    add_data(data,color) {
        /**
         * Redefine x and y scales, according to the data only if this is the 1st time add_data is called
         */
        if (this.lineCounter == 0) {
            this.xscale.domain([data[data.length - 1][0], data[0][0]]);
            this.yscale.domain(d3.extent(data, d => d[1]));
            // NO need to update this.lineGenerator, it will be updated because this.xscale and this.yscale are functions used by lineGenerator
        }

        const lineId = `line${this.lineCounter++}`;
        this.allLines[lineId] = data; // Store original data

        const downsampled = downsampleData(data, this.true_width, this.xscale.domain());

        this.vis.append("path")
            .datum(downsampled)
            .attr("class", "lineGenerator")
            .attr("id", lineId)
            .attr("clip-path", "url(#clip)")
            .attr("fill", "none")
            .attr("stroke", color)
            .attr("stroke-width", 2)
            .attr("d", this.lineGenerator);
    }

    update_spectrum_color(index, color) {
        const lineId = `line${index}`;
        if (this.allLines[lineId]) {
            this.vis.select(`#${lineId}`)
                .attr("stroke", color);
        }
    }

   

    resize(width, height) {

        /**
         * Set DOM element width and height
         */
        document.getElementById('main_plot').setAttribute("width", width);
        document.getElementById('main_plot').setAttribute("height", height);
        /**
         * Set width and height of the main_plot object. this.width and this.height will be used to calculate 
         * the range of x and y axes to redraw the plot
         */
        this.width = width;
        this.height = height;
        this.true_width = this.width - this.margin.left - this.margin.right;
        this.true_height = this.height - this.margin.top - this.margin.bottom;
        this.xscale.range([this.width - this.margin.right, this.margin.left]);
        this.yscale.range([this.height - this.margin.bottom, this.margin.top]);

        /**
         * Reset width and height of the clip space according to the new width and height of the main_plot object
         */
        this.$clip_space
            .attr("transform", "translate(" + this.margin.left + "," + this.margin.top + ")")
            .attr("width", width - this.margin.left - this.margin.right)
            .attr("height", height - this.margin.top - this.margin.bottom);


        /**
         * Redraw x and y axes and labels
        */
        this.xAxis = d3.axisBottom(this.xscale).ticks(this.true_width / 100.0);
        this.xAxis_element
            .attr('transform', 'translate(0,' + (this.height - this.margin.bottom) + ')')
            .call(this.xAxis);

        this.xLabel
            .attr("x", this.width / 2)
            .attr("y", this.height - 10);

        this.yAxis = d3.axisLeft(this.yscale).ticks(this.true_height / 100.0).tickFormat(d3.format(".1e"));
        this.yAxis_element
            .attr('transform', 'translate(' + (this.margin.left) + ',0)')
            .call(this.yAxis);

        this.yLabel
            .attr("y", this.height / 2)
            .attr("x", 16)
            .attr("transform", "rotate(-90 30," + this.height / 2 + ")");

        /**
         * Redraw the plot
         */
        this.redraw();
    }


    handleMouseMove(e) {
        var self = this;

        /**
         * With this.click_event, we can differentiate between click and drag
         */
        this.click_event = false;

        /**
         * If the mouse is down, we need to pan the plot
         */
        if (this.mouse_is_down == true) {
            /**
             * Convert deltaX and deltaY to ppm and intensity
             */
            let delta_ppm = this.xscale.invert(e.clientX) - this.xscale.invert(this.startMousePos[0]);
            let delta_intensity = this.yscale.invert(e.clientY) - this.yscale.invert(this.startMousePos[1]);

            /**
             * Update self.xscale and self.yscale
             */
            self.xscale.domain([self.xscale.domain()[0] - delta_ppm, self.xscale.domain()[1] - delta_ppm]);
            self.yscale.domain([self.yscale.domain()[0] - delta_intensity, self.yscale.domain()[1] - delta_intensity]);

            /**
             * Update self.startMousePos
             */
            self.startMousePos = [e.clientX, e.clientY];

            /**
             * Redraw the plot
             */
            self.redraw();
        }
        /**
         * If the mouse is not down, we need to show the tooltip
         */
        else {
            let bound = document.getElementById('main_plot').getBoundingClientRect();
            let px = e.clientX - bound.left;
            let py = e.clientY - bound.top;
            if (px > self.margin.left && px < self.width - self.margin.right
                && py > self.margin.top && py < self.height - self.margin.bottom) {
                let ppm = self.xscale.invert(px);
                let amp = self.yscale.invert(py);

                tooldiv.style("opacity", .9);
                tooldiv.html(ppm.toFixed(4) + " " + amp.toExponential(1) + " ")
                    .style("left", (e.pageX + 12) + "px")
                    .style("top", (e.pageY + 12) + "px");
            }
            else {
                tooldiv.style("opacity", 0);
            }
        }
        e.preventDefault();
    }

    handleMouseUp(e) {
        e.preventDefault();
        var self = this;
        this.vis.on('mouseup', null);

        if (this.click_event === true) {

            let bound = document.getElementById('main_plot').getBoundingClientRect();
            /**
             * Only call parent function if the user clicks on the plot, not on the axes
             */
            if (e.clientX - bound.left > self.margin.left && e.clientX - bound.left < self.width - self.margin.right
                && e.clientY - bound.top > self.margin.top && e.clientY - bound.top < self.height - self.margin.bottom) {
                /**
                 * Call parent function with the ppm and intensity of the clicked point
                 */
                var ppm = self.xscale.invert(e.clientX - bound.left);
                var amp = self.yscale.invert(e.clientY - bound.top);
                // console.log(ppm,amp);
                // user_click_on_plot(ppm, amp); //user_click_on_plot is defined out of this class (to revise later!!)
            }
        }
        this.mouse_is_down = false;
    }

    median(values) {

        if (values.length === 0) {
            throw new Error('Input array is empty');
        }

        // Sorting values, preventing original array
        // from being mutated.
        values = [...values].sort((a, b) => a - b);

        const half = Math.floor(values.length / 2);

        return (values.length % 2
            ? values[half]
            : (values[half - 1] + values[half]) / 2
        );

    }


    /**
     * 
     * @param {array} spectrum_recon spectrum_recon is an array of [x,y] pairs. X: chemical shift, Y: intensity
     * @param {array} experimental_peaks //array of peaks, each peak is an array of ppm and intensity
     * @param {array} peak_centers //array of peak centers, each peak center is one number.
     * This function will add the reconstructed spectrum and peaks to the plot
     */

    show_recon(spectrum_recon, experimental_peaks, peak_params, peak_centers) {

        if (!Array.isArray(spectrum_recon) || !Array.isArray(experimental_peaks)) {
            throw new Error('colmar_1d_double_zoom function show_recon all arguments must be array');
        }

        var self = this;

        this.recon_exist = true;
        this.data_recon = spectrum_recon;
        this.experimental_peaks = experimental_peaks;
        this.experimental_peak_params = peak_params;
        this.experimental_peaks_centers = peak_centers;
        this.experimental_peaks_show = new Array(experimental_peaks.length);
        this.experimental_peaks_line = new Array(this.experimental_peaks.length);

        /**
         * Get median of the peak width of the experimental spectrum
         * for each peak, peak width is estimated as (sigma+gamma)*2.5
         */
        let peak_width = [];
        for (var i = 0; i < this.experimental_peak_params.length; i++) {
            peak_width.push((this.experimental_peak_params[i].sigma + this.experimental_peak_params[i].gamma) * 2.5);
        }

        this.median_experimental_peak_width = this.median(peak_width);


        /**
         * if this.reference is not 0, we need to shift the ppm of the reconstructed spectrum and experimental_peaks and peak_centers
         */
        if (this.reference != 0.0) {
            for (var i = 0; i < this.data_recon.length; i++) {
                this.data_recon[i][0] = this.data_recon[i][0] + this.reference;
            }
            for (var i = 0; i < this.experimental_peaks.length; i++) {
                for (var j = 0; j < this.experimental_peaks[i].length; j++) {
                    this.experimental_peaks[i][j][0] = this.experimental_peaks[i][j][0] + this.reference;
                }
                this.experimental_peaks_centers[i] = this.experimental_peaks_centers[i] + this.reference;
            }
        }

        //remove old one if exists
        this.vis.selectAll(".peak_recon").remove();

        /**
         * draw peaks. fake here. we will update the peaks later
         */
        for (var i = 0; i < this.experimental_peaks.length; i++) {
            this.experimental_peaks_line[i] = this.vis.append('g')
                .append("path")
                .attr("clip-path", "url(#clip)")
                .attr("class", "peak_recon")
                .attr("fill", "none")
                .style("stroke-width", this.recon_line_width+1)
                // .style("stroke", "green")
                .style("stroke", function () {
                    if (self.experimental_peak_params[i].background == 0) {
                        return "green";
                    }
                    else {
                        return "blue";
                    }
                })
                .attr("d", "M0 0");
            this.experimental_peaks_show[i] = 0; // 0: not shown, 1: shown
        }


        //reconstruction
        var data_recon_strided = this.data_recon;
        if (data_recon_strided.length > 20000) {
            let step = Math.ceil(data_recon_strided.length / 20000);
            //step is the number of data points to skip. Make sure step must <=4, otherwise the plot will be too sparse
            if (step > 4) {
                step = 4;
            }
            data_recon_strided = data_recon_strided.filter(function (x, i) {
                return i % step == 0;
            });
        }

        //remove old one if exists
        this.vis.selectAll(".line_recon").remove();

        this.line_recon = this.vis.append("g")
            .append("path")
            .attr("clip-path", "url(#clip)")
            .attr("class", "line_recon")
            .attr("fill", "none")
            .style("stroke", "red")
            .style("stroke-width", this.recon_line_width)
            .attr("d", this.lineGenerator(data_recon_strided));
    };

    /**
     * This function will add a baseline to the plot and save the baseline in this.baseline
     * baseline is an array of intensity only (from larger ppm to smaller ppm) but this.baseline is an array of [x,y] pairs. X is ppm, Y is intensity
     * @param {*} baseline 
     * @returns 
     */
    show_baseline(baseline) {
        if (!Array.isArray(baseline)) {
            throw new Error('colmar_1d_double_zoom function show_baseline argument must be array');
        }

        if (baseline.length != this.data.length) {
            throw new Error('colmar_1d_double_zoom function show_baseline argument must have same length as the experimental spectrum');
        }

        this.baseline_exist = true;


        //remove old one if exists
        this.vis.selectAll(".line_baseline").remove();

        this.line_baseline = this.vis.append("g")
            .append("path")
            .attr("clip-path", "url(#clip)")
            .attr("class", "line_baseline")
            .attr("fill", "none")
            .style("stroke", "green")
            .attr("d", this.lineGenerator(this.baseline));
    };

    /**
     * This function will subtract the baseline from the experimental spectrum
     * then remove the baseline from the plot
     * When this function is called. this.original_data === this.data
     * After this point, we do not need this.original_data anymore
     */
    apply_baseline() {
        if (this.baseline_exist === false) return;

        for (var i = 0; i < this.data.length; i++) {
            this.data[i][1] = this.data[i][1] - this.baseline[i][1];
        }

        this.baseline_exist = false;
        this.baseline = [];
        this.vis.selectAll(".line_baseline").remove();

        //redraw the experimental spectrum after this.data is updated
        this.redraw();
    }

    /**
     * Set new lineGenerator width 
     */
    reset_line_width(exp_line_width, recon_line_width,) {
        this.exp_line_width = parseFloat(exp_line_width);
        this.recon_line_width = parseFloat(recon_line_width);
        /** 
        * Redraw compound peaks will be done in redraw function
        */
        this.redraw();
    }

    /**
     * This function will redraw the plot. It will be called when the user zooms or pans the plot
    */
    redraw() {


        var self = this;

        this.lineGenerator.x((d) => this.xscale(d[0])).y((d) => this.yscale(d[1]));

        this.min_d = self.xscale.invert(self.margin.left);
        this.max_d = self.xscale.invert(self.width - self.margin.right);

        if (this.min_d > this.max_d) {
            let temp = this.min_d;
            this.min_d = this.max_d;
            this.max_d = temp;
        }

        /** To save computational resource, we filter out data points that are out of visible range or too close to each other
         * because this.data is an array of [x,y,z] pairs, this.data_strided is a shallow copy of this.data (share the same data!!)
        */


        // Re-downsample each line for new x-domain
        Object.entries(this.allLines).forEach(([lineId, data]) => {
            const downsampled = downsampleData(data,this.true_width, this.xscale.domain());
            this.vis.select(`#${lineId}`)
                .datum(downsampled)
                .attr("d", this.lineGenerator);
        });

     

        //redraw the x axis and y axis
        this.xAxis_element.call(this.xAxis);
        this.yAxis_element.call(this.yAxis);

        /**
         * Because d3 des not support axis font size. We have to use css to change the font size of the axis
         */
        d3.selectAll(".yaxis>.tick>text")
            .each(function () {
                d3.select(this).style("font", "italic 2.0em sans-serif");
            });

        d3.selectAll(".xaxis>.tick>text")
            .each(function () {
                d3.select(this).style("font", "italic 2.0em sans-serif");
            });
    }

    /**
     * This function will apply phase correction to the experimental spectrum.
     * this.data is an array of [x,y,z] pairs. X is ppm, Y is read part and Z is imaginary part of the spectrum
     * @param {double} phase0 phase correction for the experimental spectrum at the left end of the spectrum (smaller ppm)
     * @param {double} phase1 phase correction for the experimental spectrum at the right end of the spectrum (largest ppm)
     * But in visualization, max ppm is drawn on the left and min ppm is drawn on the right.
     * This is opposite to what we save the spectrum in this.data
     */
    apply_phase_correction(phase0, phase1) {

        /**
         * Throw error if phase0 or phase1 is not a number or imagine_exist is false
         */
        if (typeof phase0 != 'number' || typeof phase1 != 'number') {
            throw new Error('colmar_1d_double_zoom function apply_phase_correction phase0 and phase1 must be numbers');
        }
        if (this.imagine_exist === false) {
            throw new Error('colmar_1d_double_zoom function apply_phase_correction cannot apply phase correction because imaginary part is not provided');
        }

        /**
         * prevent re-interpretation of this inside some functions. we need to use self sometimes
         */
        var self = this;

        /**
         * var phase_correction is an array of phase correction for each data point. Same length as this.data
         */
        let phase_correction = new Array(this.data.length);
        /**
         * we can calculate the phase correction for each data point using linear interpolation, using index 
         * ppm is linearly spaced. So, we can use index to calculate the phase correction for each data point
         */
        for (var i = 0; i < this.data.length; i++) {
            phase_correction[i] = phase0 + (phase1 - phase0) * i / this.data.length;
        }

        /**
         * Now apply phase correction to the experimental spectrum at each data point
         * y ==> ori_y*cos(phase_correction) + ori_z * sin(phase_correction)
         * z ==> ori_z*cos(phase_correction) - ori_y * sin(phase_correction)
         * Infor: Angle is in radians in JS Math library
         */
        for (var i = 0; i < this.data.length; i++) {
            this.data[i][1] = this.original_data[i][1] * Math.cos(phase_correction[i]) + this.original_data[i][2] * Math.sin(phase_correction[i]);
            this.data[i][2] = this.original_data[i][2] * Math.cos(phase_correction[i]) - this.original_data[i][1] * Math.sin(phase_correction[i]);
        }

        /**
         * Now draw the experimental spectrum with phase correction.
         * this.data_strided is a shallow copy of this.data (share the same data!!)
         */
        this.line_exp.attr("d", self.lineGenerator(self.data_strided));
    }

    /**
     * This function will set the experimental spectrum to phase corrected spectrum
     * All subsequent phase correction will be applied to the phase corrected spectrum
     */
    permanent_phase_correction() {
        /**
         * Throw error if imagine_exist is false
        */
        if (this.imagine_exist === false) {
            throw new Error('colmar_1d_double_zoom function permanent_phase_correction cannot apply phase correction because imaginary part is not provided');
        }
        this.original_data = this.data.map((x) => [x[0], x[1], x[2]]);
    }

    /**
     * return the middle of the X axis
     */
    get_anchor() {
        return (this.min_d + this.max_d) / 2;
    }


    /**
     * This function will add a reference correction (in ppm) to the X axis of experimental spectrum only
     * Reconstruction spectrum and simulated spectrum are generated after the reference correction is applied,
     * so there is no need to apply reference correction to them 
     * Baseline use same x axis as the experimental spectrum, so there is no need to apply reference correction to it
    */
    apply_reference(reference) {
        /**
         * reference is the total reference correction in ppm applied by the user
         * this.reference is the total reference correction in ppm applied by the user, before this function is called
         * So, we need to subtract this.reference from reference to get the reference correction to be applied to the experimental spectrum
         */

        let current_reference = this.reference;


        /**
         * Add reference to the ppm of the experimental spectrum
         */
        for (var i = 0; i < this.data.length; i++) {
            this.data[i][0] = this.data[i][0] + reference - current_reference;
        }

        /**
         * If reconstruction spectrum exists, add reference to the ppm of the reconstruction spectrum
         */
        if (this.recon_exist) {
            for (var i = 0; i < this.data_recon.length; i++) {
                this.data_recon[i][0] = this.data_recon[i][0] + reference - current_reference;
            }
            /**
             * Need to apply to this.experimental_peaks and experimental_peaks_centers too
             */
            for (var i = 0; i < this.experimental_peaks.length; i++) {
                for (var j = 0; j < this.experimental_peaks[i].length; j++) {
                    this.experimental_peaks[i][j][0] = this.experimental_peaks[i][j][0] + reference - current_reference;
                }
                this.experimental_peaks_centers[i] = this.experimental_peaks_centers[i] + reference - current_reference;
            }
        }

        this.reference = reference; //update this.reference

        /**
         * Now draw the experimental spectrum with reference correction.
         */
        this.redraw();
    }



    /** helper function to get full peak profile from the right side only
     * @param {Object Array} data has following keys
     * Return @param {Object Array} peak_data [?][Array of {x, y}]
     *  data[?]["x"] and data[?]["y"] are the x and y values of the peak profile, right side only without center
    */
    get_full_peak_profile(data) {
        var peak_data = new Array();
        for (var i = 0; i < data.length; i++) {
            let x = data[i]["x"];
            let y = data[i]["y"];
            //invert x and y to get the left side of the peak profile, concatenate the two sides, and add the center in the middle
            let x_left = x.map((x) => -x);
            let y_left = y.map((y) => y);
            x_left.reverse();
            y_left.reverse();
            x_left.push(0);
            y_left.push(1.0);
            x = x_left.concat(x);
            y = y_left.concat(y);
            //convert x,y to 2D array as required by d3.lineGenerator
            let data_item = [];
            for (var j = 0; j < x.length; j++) {
                data_item.push([x[j], y[j]]);
            }
            peak_data.push(data_item);
        }
        return peak_data;
    }

    /**
     * 
     * get event center position
     * this is actually required when users use two fingers to zoom in or out
     * this is not required when users use mouse wheel to zoom in or out or use mouse to drag the plot
     */


    event_center(event, target, width, height) {
        if (event.sourceEvent) {
            const p = d3.pointers(event, target);
            return [d3.mean(p, d => d[0]), d3.mean(p, d => d[1])];
        }
        return [width / 2, height / 2];
    };

    /**
     * Return array of 2, ppm_start and ppm_end (ppm_start > ppm_end per NMR convention)
     */
    get_visible_region() {
        return this.xscale.domain();
    }

    /**
     * Show peaks on the plot, as red circles
     * @param {Object} peak_obj: cpeaks class object
     */
    add_peaks(peak_obj) {
        let self = this;
        /**
         * Construct peak data, array of [x,y,z] 
         * x is ppm: peak_obj.column['X_PPM']
         * z is index: peak_obj.column['INDEX'] (not for plotting, but for tracking the peak)
         */
        let peak_data = peak_obj.get_selected_columns_as_array(['X_PPM', 'HEIGHT','INDEX']);

        this.peaks_symbol=this.vis.append('g')
            .selectAll('circle')
            .data(peak_data)
            .enter()
            .append('circle')
            .attr("clip-path", "url(#clip)")
            .attr('cx', (d) => this.xscale(d[0]))
            .attr('cy', (d) => this.yscale(d[1]))
            .attr('r', 5)
            .style("fill", "blue")
            .style("stroke-width", 3.5)
            .style("stroke", "blue")
            .attr("class", "peak_circle");

        /**
         * Allow drag and drop of the peaks
         */
        this.peak_drag = d3.drag()
            .on("start", function (event, d) {
                d3.select(this).raise().classed("active", true);
            })
            .on("drag", function (event, d) {
                d3.select(this)
                    .attr("cx", event.x)
                    .attr("cy", event.y);
                //update the peak data

            })
            .on("end", function (event, d) {
                d3.select(this).classed("active", false);
                let ppm = self.xscale.invert(event.x);
                let intensity = self.yscale.invert(event.y);
                console.log("ppm", ppm, "intensity", intensity);
                //update the peak data, 
                d[0] = ppm;
                d[1] = intensity;
                //update the peak object
                peak_obj.update_row_1d(d[2], ppm, intensity);
            });

        this.peaks_symbol.call(this.peak_drag);
    };

    remove_peaks() {
        this.vis.selectAll(".peak_circle").remove();
        this.peaks_symbol = null;
    };

    zoom_to = function (x_scale)
    {
        this.xscale.domain(x_scale);
        this.redraw();
    }

};
