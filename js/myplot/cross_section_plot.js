class cross_section_plot {
    constructor(parent_plot) {

        // test d3 exist
        if (!d3) throw Error('d3 library not set');


        this.data = []; //experimental spectrum, with phase correction applied.
        this.original_data = []; //experimental spectrum before phase correction
        this.data_strided = []; //experimental spectrum that will be plotted at current zoom level and pan position, shallow copy of this.data
        this.parent_plot = parent_plot; //parent plot object
        this.data_reconstructed_array = []; //reconstructed spectrum, with phase correction applied.
    }

    /**
     * 
     * @param {int} width  width of the plot SVG element
     * @param {int} height height of the plot SVG element
     * @param {array} data   //data is an array of [x,y,z] pairs. X: chemical shift, Y: intensity, Z: imaginary_data part of the spectrum. Z might not exist
     * 
     * This function will init the plot and add the experimental spectrum only
     */
    init(width, height, x_domain, y_domain, margin, svg_id, orientation) {

        this.phase_correction = 0.0;
        this.anchor_ppm = -100.0;
        this.phase_correction_p1 = 0.0;


        this.orientation = orientation; //"horizontal" or "vertical"

        this.margin = margin;


        this.width = width;
        this.height = height;

        this.svg_id = svg_id;

        /**
         * Default line width of the experimental spectrum, reconstructed spectrum, and simulated spectrum
         */
        this.exp_line_width = 2.0;

        this.vis = d3.select("#" + this.svg_id)
            .attr("xmlns", "http://www.w3.org/2000/svg")
            .attr("width", this.width)
            .attr("height", this.height);

        if(this.orientation === "horizontal"){
            this.x = d3.scaleLinear()
                .domain(x_domain)
                .range([this.margin.left, this.width - this.margin.right]);
        }
        else if(this.orientation === "vertical"){
            this.x = d3.scaleLinear()
                .domain(x_domain)
                .range([this.width - this.margin.right, this.margin.left]);
        }   

        
        
        this.y = d3.scaleLinear()
            .domain(y_domain)
            .range([this.height - this.margin.bottom, this.margin.top]);

        this.true_width = this.width - this.margin.left - this.margin.right;
        this.true_height = this.height - this.margin.top - this.margin.bottom;


        /**
         * Define y axis object. Add y axis to the plot and y label for "horizontal" orientation
        */
        if (this.orientation === "horizontal") {
            this.Axis = d3.axisLeft(this.y).ticks(this.true_height / 50.0).tickFormat(d3.format(".1e"));
            this.Axis_element
                = this.vis.append('svg:g')
                    .attr('class', 'yaxis')
                    .attr('transform', 'translate(' + (this.margin.left) + ',0)')
                    .style("stroke-width", 2.5)
                    .call(this.Axis);
        }
        else if (this.orientation === "vertical") {
            this.Axis = d3.axisBottom(this.x).ticks(this.true_width / 50.0).tickFormat(d3.format(".1e"));
            this.Axis_element
                = this.vis.append('svg:g')
                    .attr('class', 'xaxis')
                    .attr('transform', 'translate(0,' + (this.height - this.margin.bottom) + ')')
                    .style("stroke-width", 3.5)
                    .call(this.Axis);
        }

        /**
         * Define line object
         * this.line is a function that will convert data (ppm,amp) to path (screen coordinates)
        */
        this.line = d3.line()
            .x((d) => this.x(d[0]))
            .y((d) => this.y(d[1]))
            ;

        /**
         * Define clip space for the plot. 
        */
        this.clip_space
            = this.vis.append("defs").append("clipPath")
                .attr("id", "clip" + this.orientation)
                .append("rect")
                .attr("transform", "translate(" + this.margin.left + "," + this.margin.top + ")")
                .attr("width", width - this.margin.left - this.margin.right)
                .attr("height", height - this.margin.top - this.margin.bottom);

        /**
         * Add a line to show the 0 intensity
         */
        if (this.orientation === "horizontal") {
            this.line_zero = this.vis.append("g")
                .attr("class", "line_zero_g")
                .append("line")
                .attr("clip-path", "url(#clip" + this.orientation + ")")
                .attr("x1", this.x.range()[0])
                .attr("y1", this.y(0))
                .attr("x2", this.x.range()[1])
                .attr("y2", this.y(0))
                .style("stroke", "red")
                .style("stroke-width", 1.5);
        }
        else //vertical
        {
            this.line_zero = this.vis.append("g")
                .attr("class", "line_zero_g")
                .append("line")
                .attr("clip-path", "url(#clip" + this.orientation + ")")
                .attr("x1", this.x(0))
                .attr("y1", this.y.range()[0])
                .attr("x2", this.x(0))
                .attr("y2", this.y.range()[1])
                .style("stroke", "red")
                .style("stroke-width", 1.5);
        }

        /**
         * Turn off the default right click menu
         */
        this.vis.on("contextmenu", function (e) {
            e.preventDefault();
        });

        /**
         * Handle zoom and pan event
         */
        var self = this;
        this.handleMouseMoveHandler = this.handleMouseMove.bind(this);
        this.vis.on('mousemove', (e) => { self.handleMouseMoveHandler(e); });

        /**
         * mouse drag event to pan the plot
         */
        this.vis.on('mousedown', (e) => {
            e.preventDefault();

            this.mouse_is_down = true;
            this.mouse_is_moving = false;            
            this.handleMouseUpHandler = this.handleMouseUp.bind(this);
            this.vis.on('mouseup', (e) => { self.handleMouseUpHandler(e); });
            self.startMousePos = [e.clientX, e.clientY];
        });

        /**
         * mouse wheel event to zoom the plot
         */
        this.vis.on('wheel', (e) => {
            e.preventDefault();
            var delta = e.deltaY;
            
            /**
             * Wheel event:
             * 1. If shift key is pressed, try phase correction
             * 2. If not, zoom in/out
             */
            if ((e.shiftKey || e.ctrlKey) && this.imagine_exist === true) {
                /**
                 * Coarse phase correction with shift key, step is 1.0 degree per wheel event
                 * Fine phase correction with ctrl key, step is 0.1 degree per wheel event
                 */
                let step = 1.0;
                if (e.shiftKey) {
                    step = 1.0;
                }
                else if (e.ctrlKey) {
                    step = 0.1;
                }
                /**
                 * If anchor ppm is not set, we change this.phase_correction
                 */
                if(this.anchor_ppm < -99.0)
                {
                    
                    if(delta > 0) {
                        this.phase_correction -=step/180*Math.PI;
                    }
                    else {
                        this.phase_correction +=step/180*Math.PI;
                    }
                }
                /**
                 * If anchor ppm is set, we change this.phase_correction_p1
                 */
                else {
                    if (delta > 0) {
                        this.phase_correction_p1 -= step / 180 * Math.PI;
                    }
                    else {
                        this.phase_correction_p1 += step / 180 * Math.PI;
                    }
                }
                /**
                     * Get index of the anchor ppm. phase_correction_array[anchor_index] = this.phase_correction
                     * and phase_correction_array[last] - phase_correction_array[0] = this.phase_correction_p1
                     */
                this.make_phase_correction_array();
                /**
                 * Update real_data and imaginary_data with phase correction
                 */
                if (orientation === "horizontal") {
                    if(this.anchor_ppm < -99.0){
                        document.getElementById('p0_direct').innerHTML = (this.phase_correction/Math.PI*180).toFixed(1);
                    }
                    else{
                        document.getElementById('p1_direct').innerHTML = (this.phase_correction_p1/Math.PI*180).toFixed(1);
                    }
                    
                    for (var i = 0; i < this.data.length; i++) {
                        this.data[i][1] = this.real_data[i] * Math.cos(this.phase_correction_array[i]) - this.imaginary_data[i] * Math.sin(this.phase_correction_array[i]);
                
                }
                   
                }
                else
                {
                    if(this.anchor_ppm < -99.0){
                        document.getElementById('p0_indirect').innerHTML = (this.phase_correction/Math.PI*180).toFixed(1);
                    }
                    else{
                        document.getElementById('p1_indirect').innerHTML = (this.phase_correction_p1/Math.PI*180).toFixed(1);
                    }
                    for (var i = 0; i < this.data.length; i++) {
                        this.data[i][0] = this.real_data[i] * Math.cos(this.phase_correction_array[i]) - this.imaginary_data[i] * Math.sin(this.phase_correction_array[i]);
                    }
                }
                this.redraw();
            }
            else
            {
                if (delta > 0) {
                    delta = 1.1;
                }
                else {
                    delta = 0.9;
                }
                /**
                 * Get the amp of the mouse position. Y zoom only in this plot
                 *
                 * Get top and bottom of the visible range
                 * We need to zoom in/out around the mouse position
                 * So, we need to calculate the new top and bottom of the visible range
                 * Note: Y axis is inverted
                 * So, top is smaller than bottom
                 */
                if (orientation === "horizontal") {

                    let bound = document.getElementById('cross_section_x').getBoundingClientRect();
                    let ppm = self.x.invert(e.clientX - bound.left);
                    let amp = self.y.invert(e.clientY - bound.top);

                    if (e.clientX - bound.left < self.margin.left ) {
                        /**
                         * Get top and bottom of the visible range
                         * We need to zoom in/out around the mouse position
                         * So, we need to calculate the new top and bottom of the visible range
                         * Note: Y axis is inverted
                         * So, top is smaller than bottom
                         */
                        let top = self.y.domain()[0];
                        let bottom = self.y.domain()[1];
                        let new_top = amp - (amp - top) * delta;
                        let new_bottom = amp + (bottom - amp) * delta;
                        this.y.domain([new_top, new_bottom]);
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
                        let left = self.x.domain()[0];
                        let right = self.x.domain()[1];
                        let new_left = ppm - (ppm - left) * delta;
                        let new_right = ppm + (right - ppm) * delta;
                        this.x.domain([new_left, new_right]);
                        /**
                         * Update parent plot (main_plot)'s x domain
                         */
                        this.parent_plot.zoom_x([this.x.domain()[0], this.x.domain()[1]]);
                    }
                }
                else {
                    let bound = document.getElementById('cross_section_y').getBoundingClientRect();
                    let ppm = self.y.invert(e.clientY - bound.top);
                    let amp = self.x.invert(e.clientX - bound.left);

                    /**
                     * Above the X axis, Y zoom only
                     */
                    if (e.clientY - bound.top < self.height - self.margin.bottom && e.clientY - bound.top > self.margin.top) 
                    {
                        let top = self.y.domain()[0];
                        let bottom = self.y.domain()[1];
                        let new_top = ppm - (ppm - top) * delta;
                        let new_bottom = ppm + (bottom - ppm) * delta;
                        this.y.domain([new_top, new_bottom]);
                        /**
                         * Update parent plot (main_plot)'s y domain
                         */
                        this.parent_plot.zoom_y([this.y.domain()[0], this.y.domain()[1]]);
                    }
                    /**
                     * Below the X axis, X zoom only (amplitude zoom)
                     */
                    else if (e.clientY - bound.top > self.height - self.margin.bottom)
                    {
                        let left = self.x.domain()[0];
                        let right = self.x.domain()[1];
                        let new_left = amp - (amp - left) * delta;
                        let new_right = amp + (right - amp) * delta;
                        this.x.domain([new_left, new_right]);
                    }
                }
            }

            this.redraw();
        });
    };

    /**
     * User zoom or pan the plot
     * @param {*} x_domain: new x domain after zooming
     * @param {*} y_domain: new y domain after zooming
     */
    zoom(x_domain, y_domain) {

        this.x.domain(x_domain);
        this.y.domain(y_domain);

        if (this.orientation === "horizontal") {
            this.Axis = d3.axisLeft(this.y).ticks(this.true_height / 50.0).tickFormat(d3.format(".1e"));
            this.Axis_element
                .attr('transform', 'translate(' + (this.margin.left) + ',0)')
                .call(this.Axis);
        }
        else if (this.orientation === "vertical") {
            this.Axis = d3.axisBottom(this.x).ticks(this.true_width / 50.0).tickFormat(d3.format(".1e"));
            this.Axis_element
                .attr('transform', 'translate(0,' + (this.height - this.margin.bottom) + ')')
                .call(this.Axis);
        }

        this.redraw();
    }

    zoom_x(x_domain) {
        this.x.domain(x_domain);
        this.redraw();
    }

    zoom_y(y_domain) {
        this.y.domain(y_domain);
        this.redraw();
    }

    resize_x(width) {
        this.width = width;
        if(this.orientation === "horizontal"){
            this.x.range([this.margin.left, this.width - this.margin.right]);
            /**
             * Change width of the clip space according to the new width of the main_plot object
             */
            this.clip_space.attr("width", width - this.margin.left - this.margin.right);
        }
        else if(this.orientation === "vertical"){
            this.x.range([this.width - this.margin.right, this.margin.left]);
            /**
             * Change width of the clip space according to the new width of the main_plot object
             */
            this.clip_space.attr("width", width - this.margin.left - this.margin.right);
        }
        this.redraw();
    }

    resize_y(height) {
        this.height = height;
        this.y.range([this.height - this.margin.bottom, this.margin.top]);
        /**
         * Remove old axis element and add new axis element
         */
        this.vis.selectAll(".xaxis").remove();
        this.Axis_element = this.vis.append('svg:g')
            .attr('class', 'xaxis')
            .attr('transform', 'translate(0,' + (this.height - this.margin.bottom) + ')')
            .style("stroke-width", 3.5)
            .call(this.Axis);
        /**
         * Change height of the clip space according to the new height of the main_plot object
         */
        this.clip_space.attr("height", height - this.margin.top - this.margin.bottom);
        this.redraw();
    }
    
    make_phase_correction_array()
    {
        if(this.anchor_ppm < -99.0){
            this.phase_correction_array = new Array(this.ppm_size);
            for (var i = 0; i < this.ppm_size; i++) {
                this.phase_correction_array[i] = this.phase_correction;
            }
        }
        else{
            let anchor_index = Math.round((this.anchor_ppm-this.ppm_start)/this.ppm_step);
            this.phase_correction_array = new Array(this.ppm_size);
            for (var i = 0; i < this.ppm_size; i++) {
                this.phase_correction_array[i] = this.phase_correction + this.phase_correction_p1 * (i-anchor_index) / this.ppm_size;
            }
        }
    }

    /**
     * Update only ppm, not intensity
     * @param {*} data0 
     * @param {*} ppm 
     */
    update_ppm(data0,ppm,index) {

        this.ppm_start = data0[0];
        this.ppm_step = data0[1];
        this.ppm_size = data0[2];

        for(let i=0;i<this.data.length;i++)
        {
            this.data_reconstructed_array[index][i][0] = ppm[i];
        }
        this.redraw();
    }

    clear_data() {

        this.vis.selectAll(".line_exp").remove();
        this.vis.selectAll(".line_exp_g").remove();

        this.line_exp = null;

        for(let i=0;i<this.data_reconstructed_array.length;i++)
        {
            this.vis.selectAll(".line_reconstructed_"+i.toString()).remove();
            this.vis.selectAll(".line_reconstructed_g_"+i.toString()).remove();
        }
        this.data_reconstructed_array = [];
    }

    /**
     * Function to add additional experimental (reconstructed) spectrum
     * @param {*} data: [ppm, real_data]
     */
    add_data(data,data_color) {

        var self = this;

        this.data_reconstructed = new Array(data[0].length);

        if (this.orientation === "horizontal") {
            for (var i = 0; i < data[0].length; i++) {
                this.data_reconstructed[i] = [data[0][i], data[1][i]];
            }
        }
        else if (this.orientation === "vertical") {
            for (var i = 0; i < data[0].length; i++) {
                this.data_reconstructed[i] = [data[1][i], data[0][i]];
            }
        }

        /**
         * Convert data_color from hex string '#435F77' to a string like rgb(255, 0, 0). skip alpha value
         */
        if (data_color[0] === '#') {
            data_color = data_color.substring(1);
            var r = parseInt(data_color.substring(0, 2), 16);
            var g = parseInt(data_color.substring(2, 4), 16);
            var b = parseInt(data_color.substring(4, 6), 16);
            data_color = "rgb(" + r + "," + g + "," + b + ")";
        }

        this.data_reconstructed_array.push(this.data_reconstructed);
        let current_data_index = this.data_reconstructed_array.length - 1;


        this.vis.append("g")
            .attr("class", "line_reconstructed_g_"+current_data_index.toString())
            .append("path")
            .attr("clip-path", "url(#clip" + this.orientation + ")")
            .attr("class", "line_reconstructed_"+current_data_index.toString())
            .attr("fill", "none")
            .attr("stroke", data_color)
            .attr("stroke-width", this.exp_line_width)
            .attr("d", this.line(self.data_reconstructed));

        this.redraw();
    };
        


    /**
     * Function to update the experimental spectrum
     * @param {*} data0: [ppm_start, ppm_step, ppm_size]
     * @param {*} data: [ppm, real_data, imaginary_data]
     */
    update_data(data0,data) {
        /**
         * Remove old experimental spectrum, including "g" element and "path" element
         */
        this.clear_data();

        /**
         * These are required for phase correction
         */
        this.ppm_start = data0[0];
        this.ppm_step = data0[1];
        this.ppm_size = data0[2];

        /**
         * data is an array of [x,y,z] pairs. X: chemical shift, Y: intensity, Z: imaginary_data part of the spectrum. Z might not exist (length of Z is 0)
         * Convert to an array of [x,y] pairs. X: chemical shift, Y: intensity or [x,y,z] pairs. X: chemical shift, Y: intensity, Z: imaginary_data part of the spectrum
         */
        if (data[2].length === 0) {
            this.imagine_exist = false;
            this.ppm = data[0];
            this.real_data = data[1];
            this.imaginary_data = [];
            /**
             * Hide phase correction panel
             */
            if (this.orientation === "horizontal") {
                document.getElementById('cross_section_x_info').style.display = "none";
            }
            else {
                document.getElementById('cross_section_y_info').style.display = "none";
            }
        }
        else {
            this.imagine_exist = true;
            this.ppm = data[0];
            this.real_data = data[1];
            this.imaginary_data = data[2];
            /**
             * Show phase correction panel
             */
            if (this.orientation === "horizontal") {
                document.getElementById('cross_section_x_info').style.display = "block";
            }
            else {
                document.getElementById('cross_section_y_info').style.display = "block";
            }
        }

        this.data = new Array(this.ppm.length);
        if(this.imagine_exist === false)
        {
            if (this.orientation === "horizontal") {
                for (var i = 0; i < data[0].length; i++) {
                    this.data[i] = [this.ppm[i], this.real_data[i]];
                }
            }
            else if (this.orientation === "vertical") {
                for (var i = 0; i < data[0].length; i++) {
                    this.data[i] = [this.real_data[i], this.ppm[i]];
                }
            }
        }
        else
        {
            this.make_phase_correction_array();
            if (this.orientation === "horizontal") {
                for (var i = 0; i < data[0].length; i++) {
                    this.data[i] = [this.ppm[i], this.real_data[i] * Math.cos(this.phase_correction_array[i]) - this.imaginary_data[i] * Math.sin(this.phase_correction_array[i])];
                }
            }
            else if (this.orientation === "vertical") {
                for (var i = 0; i < data[0].length; i++) {
                    this.data[i] = [this.real_data[i] * Math.cos(this.phase_correction_array[i]) - this.imaginary_data[i] * Math.sin(this.phase_correction_array[i]), this.ppm[i]];
                }
            }
        }

        var self = this;

        this.line_exp = this.vis.append("g")
            .attr("class", "line_exp_g")
            .append("path")
            .attr("clip-path", "url(#clip" + this.orientation + ")")
            .attr("class", "line_exp")
            .attr("fill", "none")
            .style("stroke", "black")
            .style("stroke-width", this.exp_line_width)
            .attr("d", this.line(self.data));

        this.redraw();
    };

    clear() {
        /**
         * Clear this.data
         */
        this.data = [];
        this.imagine_exist = false;
        if (this.orientation === "horizontal") {
            document.getElementById('cross_section_x_info').style.display = "none";
        }
        else {
            document.getElementById('cross_section_y_info').style.display = "none";
        }
        this.redraw();
    }


    get_phase_correction() {
        /**
         * Need to get phase_correction at index 0
         */
        if(typeof this.phase_correction_array === 'undefined' || this.phase_correction_array.length === 0)
        {
            return [0.0, 0.0];
        }
        let phase_correction_at_0 = this.phase_correction_array[0];
        return [phase_correction_at_0, this.phase_correction_p1];
    }

    clear_phase_correction() {
        this.phase_correction = 0.0;
        this.phase_correction_p1 = 0.0;
        this.anchor_ppm = -100.0;
        this.phase_correction_array =[];

        if (this.orientation === "horizontal") {
            document.getElementById('p0_direct').innerHTML = "0.0";
            document.getElementById('p1_direct').innerHTML = "0.0";
        }
        else {
            document.getElementById('p0_indirect').innerHTML = "0.0";
            document.getElementById('p1_indirect').innerHTML = "0.0";
        }
    }

    /**
     * This function will redraw the plot. 
     * It will be called when the user zooms or pans the plot, resize the plot or replace the experimental spectrum
    */
    redraw() {
        var self = this;
        if (this.line_exp) {
            this.line_exp.attr("d", this.line(this.data)).style("stroke-width", self.exp_line_width);
        }
        if (this.data_reconstructed_array.length > 0)
        {
            for (var i = 0; i < this.data_reconstructed_array.length; i++){
                this.vis.selectAll(".line_reconstructed_"+i.toString()).attr("d", this.line(this.data_reconstructed_array[i])).style("stroke-width", self.exp_line_width);
            }
        }
        this.Axis_element.call(this.Axis);

        /**
         * Update the line that shows the 0 intensity
         */
        if (this.orientation === "horizontal") {
            this.line_zero
                .attr("x1", this.x.range()[0])
                .attr("y1", this.y(0))
                .attr("x2", this.x.range()[1])
                .attr("y2", this.y(0));

        }
        else //vertical
        {
            this.line_zero
                .attr("x1", this.x(0))
                .attr("y1", this.y.range()[0])
                .attr("x2", this.x(0))
                .attr("y2", this.y.range()[1]);
        }
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
            throw new Error('colmar_1d_double_zoom function permanent_phase_correction cannot apply phase correction because imaginary_data part is not provided');
        }
        this.original_data = this.data.map((x) => [x[0], x[1], x[2]]);
    }

    /**
     * Mouse event handler
     */

    handleMouseMove(e) {
        var self = this;

        /**
         * If the mouse is down, we need to pan the plot.
         */
        if (this.mouse_is_down == true) {

            this.mouse_is_moving = true;

            if (this.orientation === "horizontal") {
                /**
                 * Convert deltaY intensity
                 */
                let delta_intensity = this.y.invert(e.clientY) - this.y.invert(this.startMousePos[1]);
                /**
                 * Update self.y
                 */
                self.y.domain([self.y.domain()[0] - delta_intensity, self.y.domain()[1] - delta_intensity]);

                /**
                 * Convert deltaX ppm
                 */
                let delta_ppm = this.x.invert(e.clientX) - this.x.invert(this.startMousePos[0]);
                /**
                 * Update self.x
                 */
                self.x.domain([self.x.domain()[0] - delta_ppm, self.x.domain()[1] - delta_ppm]);

                /**
                 * Also update parent plot (main_plot)'s x domain
                 */
                this.parent_plot.zoom_x([this.x.domain()[0], this.x.domain()[1]]);

            }
            else if (this.orientation === "vertical") {
                /**
                 * Convert deltaX intensity
                 */
                let delta_intensity = this.x.invert(e.clientX) - this.x.invert(this.startMousePos[0]);

                /**
                 * Update self.x
                 */
                self.x.domain([self.x.domain()[0] - delta_intensity, self.x.domain()[1] - delta_intensity]);

                /**
                 * Convert deltaY ppm
                 */
                let delta_ppm = this.y.invert(e.clientY) - this.y.invert(this.startMousePos[1]);
                /**
                 * Update self.y
                 */
                self.y.domain([self.y.domain()[0] - delta_ppm, self.y.domain()[1] - delta_ppm]);

                /**
                 * Also update parent plot (main_plot)'s y domain
                 */
                this.parent_plot.zoom_y([this.y.domain()[0], this.y.domain()[1]]);
            }

            /**
             * Update self.startMousePos
             */
            self.startMousePos = [e.clientX, e.clientY];

            /**
             * Redraw the plot
             */
            self.redraw();
        }
        e.preventDefault();
    }

    handleMouseUp(e) {
        e.preventDefault();
        var self = this;
        this.vis.on('mouseup', null);
        this.mouse_is_down = false;
        /**
         * Left click event
         */
        if(this.mouse_is_moving === false && e.button === 0)
        {
            /**
             * If the mouse is not moving, we have a click event.
             * Get the ppm value of the mouse position from the event x
             */
            
            if(this.orientation === "horizontal")
            {
                let ppm = this.x.invert(e.offsetX);
                this.anchor_ppm = ppm;
                document.getElementById('anchor_direct').innerHTML = ppm.toFixed(2)+" ppm";
            }
            else
            {
                let ppm = this.y.invert(e.offsetY);
                this.anchor_ppm = ppm;
                document.getElementById('anchor_indirect').innerHTML = ppm.toFixed(2)+" ppm";
            }
        }
        /**
         * Right click event
         */
        else if(this.mouse_is_moving === false && e.button === 2)
        {
            /**
             * Clear anchor ppm
             */
            this.anchor_ppm = -100.0;
            if(this.orientation === "horizontal"){
                document.getElementById('anchor_direct').innerHTML = "not set";
            }
            else{
                document.getElementById('anchor_indirect').innerHTML = "not set";
            }
        }
        return;
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

};