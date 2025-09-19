
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

        this.$peaks_symbol = null; //this.$peaks_symbol is an array of [x,y] pairs. X is ppm, Y is intensity

        this.spectral_order = [];

        this.spectral_scale = []; // This is the scale of the spectrum, used to adjust the height of the spectrum in the plot

        this.spectrum_reference = [];   // This is the reference correction of each spectrum

        this.spectrum_visibility = []; // This is the visibility of each spectrum, used to show/hide the spectrum in the plot

        /**
         * Variables to run phase correction on the fly
         */
        this.spectrum_dimension = []; // This is the dimension of each spectrum, used to know if it is real only or real and imaginary
        this.anchor = [];
        this.anchor_ppm =[];
        this.phase_correction_at_min_ppm = [];
        this.phase_correction_at_max_ppm = [];
        this.left_end_ppm = [];
        this.right_end_ppm = [];
        this.current_actively_corrected_spectrum_index = -1; // -1 means no current actively corrected spectrum index
        this.current_actively_corrected_spectrum_data = []; // This is the data of the current actively corrected spectrum index after phase correction

        this.peak_type = null;

        this.current_spectrum_index = -1; // -1 means no current spectrum is selected
    }

    /**
     * 
     * @param {int} width  width of the plot SVG element
     * @param {int} height height of the plot SVG element
     * This function will init the plot and add the experimental spectrum only
     */
    init(width, height, peak_params,zoom_pan_on_call_function) {

        let self = this; // to use this inside some functions
        
        this.width = width;
        this.height = height;
        /**
         * ON call function we need to call when user zoom out the plot using mouse wheel
         */
        this.zoom_pan_on_call_function = zoom_pan_on_call_function || null;

        if(peak_params)
        {
            this.peak_color = peak_params.color || "#0000ff"; // Default peak color is blue
            this.peak_size = peak_params.size || 3; // Default peak size is 3 pixels (radius of the circle)
            this.peak_thickness = peak_params.peak_thickness || 1.0; // Default peak line width is 1.0
            this.filled_peaks = peak_params.filled_peaks || false; //default filled peaks is false, so peaks are not filled with color
        }
        else{
            this.peak_color = "#0000ff"; // Default peak color is blue
            this.peak_size = 3; // Default peak size is 3 pixels (radius of the circle)
            this.peak_thickness = 1.0; // Default peak line width is 1.0
            this.filled_peaks = false; // Default filled peaks is false, so peaks are not filled with color
        }

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
         * Right click to set anchor for phase correction
         */
        this.vis.on('contextmenu', (e) => {
            e.preventDefault();

            this.current_actively_corrected_spectrum_index = this.current_spectrum_index

            if (this.current_spectrum_index != -1 && this.spectrum_dimension[this.current_spectrum_index] === 3) {
                let bound = document.getElementById('main_plot').getBoundingClientRect();
                let px = e.clientX - bound.left;
                let py = e.clientY - bound.top;
                if (px > self.margin.left && px < self.width - self.margin.right
                    && py > self.margin.top && py < self.height - self.margin.bottom) {
                    let ppm = self.xscale.invert(px);
                    this.anchor[this.current_spectrum_index] = true;
                    this.anchor_ppm[this.current_spectrum_index] = ppm;
                    console.log('Set anchor at ppm: ', ppm);
                    document.getElementById("anchor").innerHTML = ppm.toFixed(4);
                }
            }
            return false; // To prevent the context menu from appearing

        });

        /**
         * mouse wheel event to zoom the plot
         */
        this.vis.on('wheel', (e) => {
            e.preventDefault();
            var delta = e.deltaY;
            

            /**
             * If alt key is pressed, we rescale one spectrum only (this.current_spectrum_index)
             */
            if (e.altKey == true && this.current_spectrum_index != -1) {

                if (delta > 0) {
                    delta = 0.99;
                }
                else {
                    delta = 1.01;
                }

                let index = this.current_spectrum_index;

                /**
                 * If it is a reconstructed spectrum, we need to get the original spectrum index
                 */
                if (all_spectra[index].spectrum_origin >= 0) {
                    index = all_spectra[index].spectrum_origin;
                }

                /**
                 * Update the scale of the spectrum to user (span element with id 'spectrum-scale-<index>')
                 */
                document.getElementById('spectrum-scale-'.concat(index)).textContent = (this.spectral_scale[index] * delta).toFixed(2); // Update the scale of the spectrum to user input

                let lineId = `line${index}`;
                let data = this.allLines[lineId];
                if (data) {
                    this.spectral_scale[index] *= delta; // Get the current scale of the spectrum
                    const scale = this.spectral_scale[index]; // Update the scale of the spectrum
                    const reference = this.spectrum_reference[index]; // Get the reference correction for the spectrum.
                    let downsampled = downsampleData(data, this.true_width, this.xscale.domain()).map(d => [d[0] + reference, d[1] * scale]);
                    this.vis.select(`#${lineId}`)
                        .datum(downsampled)
                        .attr("d", this.lineGenerator);


                    /**
                     * We also need to rescale all in all_spectra[index].reconstructed_indices
                     */
                    for (let m = 0; m < all_spectra[index].reconstructed_indices.length; m++) {
                        let recon_index = all_spectra[index].reconstructed_indices[m];
                        this.spectral_scale[recon_index] = scale;
                        this.spectrum_reference[recon_index] = reference;
                        lineId = `line${recon_index}`;
                        data = this.allLines[lineId];
                        if (data) {
                            const scale = this.spectral_scale[recon_index]; // Get the current scale of the spectrum
                            const reference = this.spectrum_reference[recon_index]; // Get the reference correction for the spectrum.
                            downsampled = downsampleData(data, this.true_width, this.xscale.domain()).map(d => [d[0] + reference, d[1] * scale]);
                            this.vis.select(`#${lineId}`)
                                .datum(downsampled)
                                .attr("d", this.lineGenerator);
                        }
                    }

                    if (current_spectrum_index_of_peaks != -1 ) {
                        /**
                         * We need to rescale the peaks of the current spectrum index
                         * this.$peaks_symbol is an array of [x,y] pairs. X is ppm, Y is intensity
                         */
                        this.$peaks_symbol
                            .attr('cx', (d) => this.xscale(d[0] + reference))
                            .attr('cy', (d) => this.yscale(d[1] * scale));

                        if (this.peak_type === "fitted") {
                            /**
                             * We need to rescale the fitted peaks of the current spectrum index
                             * this.$reconstructed_peaks is an array of [x,y] pairs. X is ppm, Y is intensity
                             */
                            this.$reconstructed_peaks
                                .attr('d', d => this.lineGenerator(d.map(p => [p[0] + reference, p[1] * scale])));
                        }
                    }
                }

                return;
            }

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

            if (this.spectrum_dimension[this.current_spectrum_index] === 3  && (e.shiftKey || e.ctrlKey)) {

                /**
                 * Set current actively corrected spectrum index.
                 * If user change current_spectrum_index, we need to update current_actively_corrected_spectrum_index
                 */
                if(this.current_actively_corrected_spectrum_index != this.current_spectrum_index) {
                    this.current_actively_corrected_spectrum_index = this.current_spectrum_index;
                    /**
                     * Make a deep copy of the data of the current_actively_corrected_spectrum_index
                     */
                    this.current_actively_corrected_spectrum_data = JSON.parse(JSON.stringify(this.allLines[`line${this.current_actively_corrected_spectrum_index}`]));
                }

                e.preventDefault();
                let phase_adjust = 0.0;
                if(e.shiftKey)
                {
                    phase_adjust = 0.0175; //In radians, about 1 degree
                }
                else if(e.ctrlKey)
                {
                    phase_adjust = 0.00175; //In radians, about 0.1 degree
                }
                if (e.deltaY < 0) {
                    phase_adjust = -phase_adjust;
                }
                const index = this.current_spectrum_index;
                /**
                 * Adjust p0 if anchor is not set
                 */
                if (this.anchor[index] === false) {
                    // document.getElementById("P0").innerHTML = P0.toFixed(2);
    
                    this.phase_correction_at_min_ppm[index] += phase_adjust;
                    this.phase_correction_at_max_ppm[index] += phase_adjust;
                    document.getElementById("pc_left_end").innerHTML = (this.phase_correction_at_min_ppm[index] * 180.0 / Math.PI).toFixed(2);
                    document.getElementById("pc_right_end").innerHTML = (this.phase_correction_at_max_ppm[index] * 180.0 / Math.PI).toFixed(2);
                }
                /**
                 * Adjust p1 if anchor is set
                 */
                else {

                    let current_slop = (this.phase_correction_at_max_ppm[index] - this.phase_correction_at_min_ppm[index]) / (this.right_end_ppm[index] - this.left_end_ppm[index]);
                    let phase_at_anchor = this.phase_correction_at_min_ppm[index] + current_slop * (this.anchor_ppm[index] - this.left_end_ppm[index]);
                    let new_slop = current_slop + phase_adjust / (this.right_end_ppm[index] - this.left_end_ppm[index]);
                    
                    // let P1 = (this.phase1[this.current_spectrum_index] ) * 180.0 / Math.PI; //back to degree
                    // document.getElementById("P1").innerHTML = P1.toFixed(2);
                    this.phase_correction_at_min_ppm[index] = phase_at_anchor - new_slop * (this.anchor_ppm[index] - this.left_end_ppm[index]);
                    this.phase_correction_at_max_ppm[index] = phase_at_anchor + new_slop * (this.right_end_ppm[index] - this.anchor_ppm[index]);
                    document.getElementById("pc_left_end").innerHTML = (this.phase_correction_at_min_ppm[index] * 180.0 / Math.PI).toFixed(2);
                    document.getElementById("pc_right_end").innerHTML = (this.phase_correction_at_max_ppm[index] * 180.0 / Math.PI).toFixed(2);
                }

                this.apply_phase_correction();
            }

            /**
            * left side of the Y axis or shift key is pressed, Y zoom only
            */
            else if (e.clientX - bound.left < self.margin.left) {
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
                /**
                 * We need to call the zoom_pan_on_call_function if it is defined
                 */
                if (this.peak_type === "fitted" && this.zoom_pan_on_call_function && this.current_spectrum_index != -1) {
                    this.zoom_pan_on_call_function(self.current_spectrum_index);
                }
            }

            this.redraw();
        });

    }

    update_current_spectrum_index(index) {
        if (index >= 0 && index < this.spectral_order.length) {

            /**
             * If we are actively phasing correcting a spectrum, we need to save the data of the current_actively_corrected_spectrum_index
             */
            if(this.current_actively_corrected_spectrum_index !=-1 && this.current_actively_corrected_spectrum_index != index)
            {
                this.permanently_apply_phase_correction();
            }

            this.current_spectrum_index = index;
        }
        else {
            this.current_spectrum_index = -1;
        }
    }


    /**
     * Add a new spectrum to the plot
     * or update an existing spectrum if index is less than current length of all spectra
     * @param {*} data 
     * @param {*} index 
     * @param {*} color 
     * @returns 
     */
    add_data(data,index,color) {

        /**
         * Test whether index is already in (we are updating the spectrum, not adding a new one)
         */
        if(index>=0 && index < this.spectral_order.length) {
            this.spectral_scale[index] = 1.0; // Reset the scale of the spectrum to 1.0
            this.spectrum_reference[index] = 0.0; // Reset the reference correction of the spectrum to 0.0
            /**
             * Update data in this.allLines
             */
            const lineId = `line${index}`;
            this.allLines[lineId] = data; // Store original data
            const downsampled = downsampleData(data, this.true_width, this.xscale.domain()).map(d => [d[0] + this.spectrum_reference[index], d[1] * this.spectral_scale[index]]); // Downsample data and scale it
            this.vis.select(`#${lineId}`)
                .datum(downsampled)
                .attr("d", this.lineGenerator);

            return;
        }


        /**
         * Redefine x and y scales, according to the data only if this is the 1st time add_data is called
         */
        if (index == 0) {
            this.xscale.domain([data[data.length - 1][0], data[0][0]]);
            this.yscale.domain(d3.extent(data, d => d[1]));
            // NO need to update this.lineGenerator, it will be updated because this.xscale and this.yscale are functions used by lineGenerator
        }

        this.spectral_order.push(index); // Keep track of the order of spectra

        this.spectral_scale.push(1.0); // This is the scale of the spectrum, used to adjust the height of the spectrum in the plot

        this.spectrum_reference.push(0.0); // This is the reference correction of the spectrum, used to adjust the ppm of the spectrum in the plot

        this.spectrum_visibility.push(true); // This is the visibility of the spectrum, used to show/hide the spectrum in the plot

        /**
         * For phase correction
         */
        this.spectrum_dimension.push(data[0].length) // 2: real only, 3: real and imaginary.
        this.anchor.push(false);
        this.anchor_ppm.push(0.0); // Anchor ppm for phase correction, not applicable for real only spectra or if anchor is false
        this.phase_correction_at_min_ppm.push(0.0); // Phase correction at the left end of the spectrum (smaller ppm)
        this.phase_correction_at_max_ppm.push(0.0); // Phase correction at the right end of the spectrum (largest ppm)
        this.right_end_ppm.push(data[data.length - 1][0]); // Left end ppm of the spectrum (smallest ppm)
        this.left_end_ppm.push(data[0][0]); // Right end ppm of the spectrum (largest ppm)



        const lineId = `line${index}`;
        this.allLines[lineId] = data; // Store original data

        const downsampled = downsampleData(data, this.true_width, this.xscale.domain()).map(d => [d[0] + this.spectrum_reference[index], d[1] * this.spectral_scale[index]]); // Downsample data and scale it

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

    update_visibility(index, visibility) {
        const lineId = `line${index}`;
        if (this.allLines[lineId]) {
            this.spectrum_visibility[index] = visibility; // Update visibility
            if (visibility) {
                this.vis.select(`#${lineId}`).style("display", "inline");
            } else {
                this.vis.select(`#${lineId}`).style("display", "none");
            }
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
             * Update self.startMousePos
             */
            self.startMousePos = [e.clientX, e.clientY];


            /**
             * If alt key is pressed, we need to pan only the current spectral index and along the X axis only.
             * We do not change xscale, instead, we change data of this.current_spectrum_index
             */
            if (e.altKey == true && this.current_spectrum_index != -1) {

                let index = this.current_spectrum_index;
                
                if ( all_spectra[index].spectrum_origin >=0)
                {
                    index = all_spectra[index].spectrum_origin; // Get the original spectrum index if it is a reconstructed spectrum
                }

                
                this.spectrum_reference[index] += delta_ppm; // Update reference correction for the spectrum
                
                /**
                 * Update the scale of the spectrum to user (span element with id 'spectrum-reference-<index>')
                 */
                document.getElementById('spectrum-reference-'.concat(index)).textContent = this.spectrum_reference[index].toFixed(4); // Update the scale of the spectrum to user input
                
                /**
                 * Redraw the current spectral index only
                 */
                let lineId = `line${index}`;
                let data = this.allLines[lineId];
                if (data) {
                    const scale = this.spectral_scale[index]; // Get the current scale of the spectrum
                    const reference = this.spectrum_reference[index]; // Get the reference correction for the spectrum.
                    let downsampled = downsampleData(data, this.true_width, this.xscale.domain()).map(d => [d[0] + reference, d[1] * scale]);
                    this.vis.select(`#${lineId}`)
                        .datum(downsampled)
                        .attr("d", this.lineGenerator);

                    /**
                     * We also need to update all in all_spectra[index].reconstructed_indices
                     */
                    for(let m=0;m < all_spectra[index].reconstructed_indices.length; m++)
                    {
                        let recon_index = all_spectra[index].reconstructed_indices[m];
                        this.spectrum_reference[recon_index] += delta_ppm; // Update reference correction for the spectrum
                        lineId = `line${recon_index}`;
                        data = this.allLines[lineId];
                        if (data) {
                            const scale = this.spectral_scale[recon_index]; // Get the current scale of the spectrum
                            const reference = this.spectrum_reference[recon_index]; // Get the reference correction for the spectrum.
                            downsampled = downsampleData(data, this.true_width, this.xscale.domain()).map(d => [d[0] + reference, d[1] * scale]);
                            this.vis.select(`#${lineId}`)
                                .datum(downsampled)
                                .attr("d", this.lineGenerator);
                        }
                    }

                    if (current_spectrum_index_of_peaks != -1 ) {
                        /**
                         * We need to rescale the peaks of the current spectrum index
                         * this.$peaks_symbol is an array of [x,y] pairs. X is ppm, Y is intensity
                         */
                        this.$peaks_symbol
                            .attr('cx', (d) => this.xscale(d[0] + reference))
                            .attr('cy', (d) => this.yscale(d[1] * scale));

                        if (this.peak_type === "fitted") {
                            /**
                             * We need to rescale the fitted peaks of the current spectrum index
                             * this.$reconstructed_peaks is an array of [x,y] pairs. X is ppm, Y is intensity
                             */
                            this.$reconstructed_peaks
                                .attr('d', d => this.lineGenerator(d.map(p => [p[0] + reference, p[1] * scale])));
                        }
                    }
                }
            }
            else {
                /**
                 * Update self.xscale and self.yscale
                 */
                self.xscale.domain([self.xscale.domain()[0] - delta_ppm, self.xscale.domain()[1] - delta_ppm]);
                self.yscale.domain([self.yscale.domain()[0] - delta_intensity, self.yscale.domain()[1] - delta_intensity]);
                /**
                 * Redraw the plot
                 */
                self.redraw();
                if(this.peak_type === "fitted" && self.zoom_pan_on_call_function && self.current_spectrum_index != -1)
                {
                    self.zoom_pan_on_call_function(self.current_spectrum_index);
                }
            }
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

    redraw_order()
    {
        /**
         * Redraw the order of the spectra in this.spectral_order
         * this.spectral_order is an array of index of the spectra in this.allLines
         * this.allLines is an object with keys as lineId and values as data
         */
        this.spectral_order.forEach((index) => {
            const lineId = `line${index}`;
            this.vis.select(`#${lineId}`).raise();  
        });
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

        /**
         * Redraw experimental spectrum
         */
         Object.entries(this.allLines).forEach(([lineId, data]) => {

            const index = parseInt(lineId.replace('line', ''))
            const scale = this.spectral_scale[index];
            const reference = this.spectrum_reference[index];

            if(this.current_actively_corrected_spectrum_index === index){
                /**
                 * We draw the actively corrected spectrum with the current_actively_corrected_spectrum_data instead of this.allLines[lineId]
                 */
                data = this.current_actively_corrected_spectrum_data;
            }

            const downsampled = downsampleData(data,this.true_width, this.xscale.domain()).map(d => [d[0] + reference, d[1] * scale]);
            this.vis.select(`#${lineId}`)
                .datum(downsampled)
                .attr("d", this.lineGenerator);
        });

        /**
         * Update peaks location if it is not null
         */
        if(this.$peaks_symbol) {
            this.$peaks_symbol
                .attr('cx', (d) => this.xscale(d[0] + this.spectrum_reference[this.current_spectrum_index])) // Scale the ppm of the peak according to the current spectrum index
                .attr('cy', (d) => this.yscale(d[1] * this.spectral_scale[this.current_spectrum_index])) // Scale the intensity of the peak according to the current spectrum index
                ;
        }


        // Redraw all peak profiles
        if(this.$reconstructed_peaks) {
            const scale_factor = this.spectral_scale[this.current_spectrum_index];
            const reference = this.spectrum_reference[this.current_spectrum_index];
            this.$reconstructed_peaks
            .attr('d', d => this.lineGenerator(
                d.map(p => [p[0] + reference, p[1] * scale_factor])
            ))
        }
    }

    /**
     * This function will apply phase correction to the experimental spectrum.
     */
    apply_phase_correction() {

        var self = this;
        let spectrum_index = this.current_spectrum_index;

        if (spectrum_index === -1 || this.spectrum_dimension[spectrum_index] != 3) {
            throw new Error('colmar_1d_double_zoom function apply_phase_correction cannot apply phase correction because no spectrum is selected');
        }

        /**
         * This is the phase correction at the two ends of the spectrum
         */
        let phase0 = this.phase_correction_at_min_ppm[spectrum_index];
        let phase1 = this.phase_correction_at_max_ppm[spectrum_index];

        /**
         * var phase_correction is an array of phase correction for each data point. Same length as this.data
         */
        let phase_correction = new Array(this.allLines['line' + spectrum_index].length);
        /**
         * we can calculate the phase correction for each data point using linear interpolation, using index 
         * ppm is linearly spaced. So, we can use index to calculate the phase correction for each data point
         */
        for (var i = 0; i < this.allLines['line' + spectrum_index].length; i++) {
            phase_correction[i] = phase0 + (phase1 - phase0) * i / this.allLines['line' + spectrum_index].length;
        }

        /**
         * Now apply phase correction to the experimental spectrum at each data point
         * y ==> ori_y*cos(phase_correction) + ori_z * sin(phase_correction)
         * z ==> ori_z*cos(phase_correction) - ori_y * sin(phase_correction)
         * Infor: Angle is in radians in JS Math library
         */

        for (var i = 0; i < this.allLines['line' + spectrum_index].length; i++) {
            this.current_actively_corrected_spectrum_data[i][1] = this.allLines['line' + spectrum_index][i][1] * Math.cos(phase_correction[i]) + this.allLines['line' + spectrum_index][i][2] * Math.sin(phase_correction[i]);
            this.current_actively_corrected_spectrum_data[i][2] = this.allLines['line' + spectrum_index][i][2] * Math.cos(phase_correction[i]) - this.allLines['line' + spectrum_index][i][1] * Math.sin(phase_correction[i]);
        }

        /**
         * Now re-draw the experimental spectrum with phase correction.
         */
        const downsampled = downsampleData(this.current_actively_corrected_spectrum_data, this.true_width, this.xscale.domain()).map(d => [d[0] + this.spectrum_reference[spectrum_index], d[1] * this.spectral_scale[spectrum_index]]);
        
        this.vis.select(`#line${spectrum_index}`)
            .datum(downsampled)
            .attr("d", this.lineGenerator);

    }

    /**
     * This function will permanently apply the phase correction to the experimental spectrum
     * with index this.current_actively_corrected_spectrum_index
     * then set this.current_actively_corrected_spectrum_index to -1
     */
    permanently_apply_phase_correction() {
        if(this.current_actively_corrected_spectrum_index !=-1) {
            this.allLines['line' + this.current_actively_corrected_spectrum_index] = this.current_actively_corrected_spectrum_data;

            /**
             * Also clear phase correction parameters
             */
            this.phase_correction_at_min_ppm[this.current_actively_corrected_spectrum_index] = 0.0;
            this.phase_correction_at_max_ppm[this.current_actively_corrected_spectrum_index] = 0.0;
            this.anchor[this.current_actively_corrected_spectrum_index] = false;
            this.anchor_ppm[this.current_actively_corrected_spectrum_index] = 0.0;


            /**
             * Also update all_spectra
            */
            for(var i=0; i < this.current_actively_corrected_spectrum_data.length; i++) {
                all_spectra[this.current_actively_corrected_spectrum_index].raw_data[i] = this.current_actively_corrected_spectrum_data[i][1];
                all_spectra[this.current_actively_corrected_spectrum_index].raw_data_i[i] = this.current_actively_corrected_spectrum_data[i][2];
            }
            

            this.current_actively_corrected_spectrum_index = -1;
            this.current_actively_corrected_spectrum_data = [];

        }
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
     * Show reconstructed peak profiles, as gray lines
     * @param {array} filtered_peaks_recon: array of array of [x,y] pairs, where x is ppm and y is intensity
     * filtered_peaks_recon[0] is the first peak profile, filtered_peaks_recon[1] is the second peak profile, etc.
     * filtered_peaks_recon[0][1] is first point of the first peak profile, which has two numbers: ppm and intensity
     */
    update_reconstructed_peaks(filtered_peaks_recon)
    {
        /**
         * Step 1, remove old peaks if they exist
         */
        if (this.$reconstructed_peaks) {
            this.$reconstructed_peaks.remove();
            this.$reconstructed_peaks = null;
        }

        if(filtered_peaks_recon == null || filtered_peaks_recon.length == 0) {
            return; // No peaks to show
        }

        /**
         * Step 2, add new peak profile. One peak profile is a path with multiple points
         */
        const scale_factor = this.spectral_scale[this.current_spectrum_index] || 1.0; // Get the scale factor for the current spectrum index, default to 1.0 if not defined
        const reference = this.spectrum_reference[this.current_spectrum_index] || 0.0; // Get the reference correction for the current spectrum index, default to 0.0 if not defined
        this.$reconstructed_peaks = this.vis.selectAll('path.reconstructed_peaks')
            .data(filtered_peaks_recon)
            .enter()
            .append('path')
            .attr('class', 'reconstructed_peaks')
            .attr('clip-path', 'url(#clip)')
            .attr('d', d => this.lineGenerator(
                d.map(p => [p[0]+reference, p[1] * scale_factor])
            ))
            .attr('stroke', 'grey')
            .attr('stroke-width', 1)
            .attr('fill', 'none');
    }

    /**
     * Show peaks on the plot, as red circles
     * @param {Object} peak_obj: cpeaks class object
     */
    add_peaks(peak_obj,peak_type='picked') {
        let self = this;
        self.peak_type = peak_type; // save peak type for later use
        /**
         * Construct peak data, array of [x,y,z] 
         * x is ppm: peak_obj.column['X_PPM']
         * z is index: peak_obj.column['INDEX'] (not for plotting, but for tracking the peak)
         */
        let peak_data = peak_obj.get_selected_columns_as_array(['X_PPM', 'HEIGHT','INDEX']);

        this.$peaks_symbol=this.vis.append('g')
            .selectAll("circle")
            .data(peak_data)
            .enter()
            .append('circle')
            .attr("clip-path", "url(#clip)")
            .attr('cx', (d) => this.xscale(d[0] + this.spectrum_reference[this.current_spectrum_index])) // Scale the ppm of the peak according to the current spectrum index
            .attr('cy', (d) => this.yscale(d[1] * this.spectral_scale[this.current_spectrum_index])) // Scale the intensity of the peak according to the current spectrum index
            .attr('r', self.peak_size) // radius of the circle
            .style("fill", function (d) {
                if (self.filled_peaks) {
                    return self.peak_color; // filled peaks
                } else {
                    return "none"; // not filled peaks
                }
            })
            .style("stroke-width", self.peak_thickness) // thickness of the circle
            .style("stroke",self.peak_color) // color of the circle
            ;
    };

    /**
     * Redraw peaks on the plot, only need to update one style, depending on the flag
     * Peak positions are not changed, so no need to update cx and cy
     * @param {int} flag:
     * 1: size changed
     * 2: line thickness changed
     * 3: filling changed
     * 4: color changed
     */
    redraw_peaks(flag) {
        if (this.$peaks_symbol) {
            switch(flag) {
                case 1:
                    this.$peaks_symbol.attr('r', this.peak_size); // update radius of the circle
                    break;
                case 2:
                    this.$peaks_symbol.style("stroke-width", this.peak_thickness); // update thickness of the circle
                    break;
                case 3:
                    if (this.filled_peaks) {
                        this.$peaks_symbol.style("fill", this.peak_color); // filled peaks
                    } else {
                        this.$peaks_symbol.style("fill", "none"); // not filled peaks
                    }
                    break;
                case 4:
                    this.$peaks_symbol.style("stroke", this.peak_color); // update color of the circle
                    this.$peaks_symbol.style("fill", this.filled_peaks ? this.peak_color : "none"); // update fill color of the circle
                    break;
                default:
                    console.warn("colmar_1d_double_zoom: redraw_peaks called with unknown flag: " + flag);
                    break;
            }
        }
    }

    remove_peaks() {
        if(this.$peaks_symbol)
        {
            this.vis.selectAll("circle").remove();
            this.$peaks_symbol = null;
        }
        this.peak_type = null; // reset peak type
        /**
         * also remove reconstructed peaks if they exist (if it is from fitted peaks)
         */
        this.update_reconstructed_peaks([]);
    };

    zoom_to = function (x_scale)
    {
        this.xscale.domain(x_scale);
        this.redraw();
    }

};
