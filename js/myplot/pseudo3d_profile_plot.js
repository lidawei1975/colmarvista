/**
 * pseudo3d_profile_plot.js
 * Interactive plane-by-plane peak profile plot for pseudo-3D NMR datasets.
 * Features:
 * - Line and scatter point visualization of intensity across planes.
 * - Overall wheel zoom (center / cursor pivot) inside plot area.
 * - X-only wheel zoom when cursor is below the X-axis.
 * - Y-only wheel zoom when cursor is to the left of the Y-axis.
 * - Click-and-drag panning.
 * - Dynamic resize and view reset.
 */

class pseudo3d_profile_plot {
    /**
     * @param {string|HTMLElement} container - Selector or DOM element for container
     * @param {Object} [options] - Configuration options
     */
    constructor(container, options = {}) {
        this.container = typeof container === 'string' ? document.querySelector(container) : container;
        if (!this.container) {
            console.error('pseudo3d_profile_plot: container element not found');
            return;
        }

        this.margin = options.margin || { top: 25, right: 30, bottom: 45, left: 65 };
        this.xLabelText = options.xLabel || 'Plane Index';
        this.yLabelText = options.yLabel || 'Peak Intensity';
        this.lineColor = options.lineColor || '#1976d2';
        this.pointColor = options.pointColor || '#0d47a1';

        this.data = [];
        this.xOrigDomain = [1, 1];
        this.yOrigDomain = [0, 1];

        this.width = Math.max(200, this.container.clientWidth || 460);
        this.height = Math.max(150, this.container.clientHeight || 280);

        this.clipId = 'clip_pseudo3d_profile_' + Math.random().toString(36).substring(2, 9);

        // Build SVG container
        this.container.innerHTML = '';
        this.svg = d3.select(this.container)
            .append('svg')
            .attr('width', '100%')
            .attr('height', '100%')
            .attr('viewBox', `0 0 ${this.width} ${this.height}`)
            .style('display', 'block')
            .style('user-select', 'none');

        // Clip path for data elements
        this.clipPath = this.svg.append('defs')
            .append('clipPath')
            .attr('id', this.clipId)
            .append('rect')
            .attr('x', 0)
            .attr('y', 0)
            .attr('width', Math.max(0, this.width - this.margin.left - this.margin.right))
            .attr('height', Math.max(0, this.height - this.margin.top - this.margin.bottom));

        // Main translated group
        this.g = this.svg.append('g')
            .attr('transform', `translate(${this.margin.left},${this.margin.top})`);

        // Grid group
        this.gridG = this.g.append('g').attr('class', 'profile-grid');

        // Data group with clipping
        this.dataG = this.g.append('g')
            .attr('class', 'profile-data-group')
            .attr('clip-path', `url(#${this.clipId})`);

        this.linePath = this.dataG.append('path')
            .attr('class', 'profile-line')
            .attr('fill', 'none')
            .attr('stroke', this.lineColor)
            .attr('stroke-width', 2);

        this.errorG = this.dataG.append('g').attr('class', 'profile-error-bars');
        this.dotsG = this.dataG.append('g').attr('class', 'profile-dots');

        // Fit graphics group (inside clipped dataG)
        this.fitG = this.dataG.append('g').attr('class', 'profile-fit-group');
        this.fitBoundsG = this.fitG.append('g').attr('class', 'profile-fit-bounds');
        this.fitBaseline = this.fitG.append('line')
            .attr('class', 'profile-fit-baseline')
            .attr('stroke', '#2e7d32')
            .attr('stroke-dasharray', '3,3')
            .attr('stroke-width', 1.5)
            .style('display', 'none');
        this.fitPeakMarkersG = this.fitG.append('g').attr('class', 'profile-fit-peak-markers');
        this.fitCompG = this.fitG.append('g').attr('class', 'profile-fit-components');
        this.fitLine = this.fitG.append('path')
            .attr('class', 'profile-fit-line')
            .attr('fill', 'none')
            .attr('stroke', '#d32f2f')
            .attr('stroke-width', 2);

        // Axes groups
        this.xAxisG = this.g.append('g')
            .attr('class', 'profile-x-axis')
            .attr('transform', `translate(0, ${this.height - this.margin.top - this.margin.bottom})`);

        this.yAxisG = this.g.append('g')
            .attr('class', 'profile-y-axis');

        // Legend group for fit statistics
        this.fitLegendG = this.g.append('g').attr('class', 'profile-fit-legend');

        // Fit data state
        this.fitData = null;
        this.showFit = true;

        // Axis labels
        this.xLabel = this.g.append('text')
            .attr('class', 'profile-x-label')
            .attr('text-anchor', 'middle')
            .attr('fill', '#455a64')
            .attr('font-size', '12px')
            .attr('font-weight', 'bold')
            .attr('x', (this.width - this.margin.left - this.margin.right) / 2)
            .attr('y', this.height - this.margin.top - this.margin.bottom + 36)
            .text(this.xLabelText);

        this.yLabel = this.g.append('text')
            .attr('class', 'profile-y-label')
            .attr('text-anchor', 'middle')
            .attr('fill', '#455a64')
            .attr('font-size', '12px')
            .attr('font-weight', 'bold')
            .attr('transform', 'rotate(-90)')
            .attr('x', -(this.height - this.margin.top - this.margin.bottom) / 2)
            .attr('y', -48)
            .text(this.yLabelText);

        // Overlay rect for mouse events & panning inside plot area
        this.overlay = this.g.append('rect')
            .attr('class', 'profile-overlay')
            .attr('width', Math.max(0, this.width - this.margin.left - this.margin.right))
            .attr('height', Math.max(0, this.height - this.margin.top - this.margin.bottom))
            .attr('fill', 'none')
            .attr('pointer-events', 'all')
            .style('cursor', 'crosshair');

        // Scales
        this.xScale = d3.scaleLinear();
        this.yScale = d3.scaleLinear();

        // Line generators
        this.lineGenerator = d3.line()
            .x(d => this.xScale(d.plane))
            .y(d => this.yScale(d.value));

        this.fitCurveGenerator = d3.line()
            .x(d => this.xScale(d.x))
            .y(d => this.yScale(d.y));

        // Tooltip
        this.tooltip = document.getElementById('pseudo3d_profile_tooltip');
        if (!this.tooltip) {
            this.tooltip = document.createElement('div');
            this.tooltip.id = 'pseudo3d_profile_tooltip';
            this.tooltip.className = 'pseudo3d-profile-tooltip';
            this.container.appendChild(this.tooltip);
        }

        // Setup interaction handlers
        this.setupInteractions();
    }

    /**
     * Set data and initialize scales
     * @param {Array<{ plane: number, label: string, value: number, std?: number }>} data
     * @param {Object} [fitData] - Optional fit curve data generated from peak_profile
     */
    set_data(data, fitData = null) {
        if (fitData !== undefined) {
            this.fitData = fitData;
        }

        if (!data || data.length === 0) {
            this.data = [];
            this.update_plot();
            return;
        }

        this.data = data.filter(d => !isNaN(d.value) && isFinite(d.value));
        if (this.data.length === 0) return;

        // Determine X extent
        const minX = d3.min(this.data, d => d.plane);
        const maxX = d3.max(this.data, d => d.plane);
        const xPad = (maxX === minX) ? 1 : (maxX - minX) * 0.05;
        this.xOrigDomain = [minX - xPad, maxX + xPad];

        // Determine Y extent
        let minY = d3.min(this.data, d => (typeof d.std === 'number' ? d.value - d.std : d.value));
        let maxY = d3.max(this.data, d => (typeof d.std === 'number' ? d.value + d.std : d.value));
        if (this.fitData && this.fitData.total_curve && this.fitData.total_curve.length > 0) {
            const fitMinY = d3.min(this.fitData.total_curve, d => d.y);
            const fitMaxY = d3.max(this.fitData.total_curve, d => d.y);
            if (fitMinY !== undefined && !isNaN(fitMinY)) minY = Math.min(minY, fitMinY);
            if (fitMaxY !== undefined && !isNaN(fitMaxY)) maxY = Math.max(maxY, fitMaxY);
            if (typeof this.fitData.baseline === 'number' && !isNaN(this.fitData.baseline)) {
                minY = Math.min(minY, this.fitData.baseline);
                maxY = Math.max(maxY, this.fitData.baseline);
            }
        }
        const ySpan = maxY - minY;
        const yPad = (ySpan === 0) ? Math.abs(maxY || 1) * 0.1 : ySpan * 0.1;
        this.yOrigDomain = [minY - yPad, maxY + yPad];

        // Set initial domains
        this.xScale.domain([...this.xOrigDomain]);
        this.yScale.domain([...this.yOrigDomain]);

        this.update_plot();
    }

    /**
     * Update visualization based on current scales and data
     */
    update_plot() {
        if (!this.data || this.data.length === 0) {
            this.linePath.attr('d', null);
            this.dotsG.selectAll('*').remove();
            this.errorG.selectAll('*').remove();
            this.fitG.style('display', 'none');
            this.fitLegendG.selectAll('*').remove();
            return;
        }

        const innerWidth = Math.max(0, this.width - this.margin.left - this.margin.right);
        const innerHeight = Math.max(0, this.height - this.margin.top - this.margin.bottom);

        this.xScale.range([0, innerWidth]);
        this.yScale.range([innerHeight, 0]);

        // Calculate tick counts adaptively
        const xTicksCount = Math.max(3, Math.min(10, Math.floor(innerWidth / 50)));
        const yTicksCount = Math.max(3, Math.min(8, Math.floor(innerHeight / 35)));

        const xAxis = d3.axisBottom(this.xScale).ticks(xTicksCount).tickFormat(d3.format('~g'));
        const yAxis = d3.axisLeft(this.yScale).ticks(yTicksCount).tickFormat(d3.format('~g'));

        this.xAxisG.call(xAxis);
        this.yAxisG.call(yAxis);

        // Update Grid
        const gridX = d3.axisBottom(this.xScale).ticks(xTicksCount).tickSize(-innerHeight).tickFormat('');
        const gridY = d3.axisLeft(this.yScale).ticks(yTicksCount).tickSize(-innerWidth).tickFormat('');

        this.gridG.selectAll('*').remove();
        this.gridG.append('g')
            .attr('class', 'grid-x')
            .attr('transform', `translate(0, ${innerHeight})`)
            .call(gridX)
            .selectAll('line')
            .attr('stroke', '#e0e0e0')
            .attr('stroke-dasharray', '2,2');

        this.gridG.append('g')
            .attr('class', 'grid-y')
            .call(gridY)
            .selectAll('line')
            .attr('stroke', '#e0e0e0')
            .attr('stroke-dasharray', '2,2');

        this.gridG.selectAll('.domain').remove();

        // Update connecting line
        this.linePath.datum(this.data).attr('d', this.lineGenerator);

        // Update error bars (if any)
        const errorData = this.data.filter(d => typeof d.std === 'number' && !isNaN(d.std) && d.std > 0);
        const errorSelection = this.errorG.selectAll('.error-bar').data(errorData, d => d.plane);

        errorSelection.exit().remove();

        const errorEnter = errorSelection.enter()
            .append('g')
            .attr('class', 'error-bar');

        errorEnter.append('line').attr('class', 'error-stem').attr('stroke', '#78909c').attr('stroke-width', 1.5);
        errorEnter.append('line').attr('class', 'error-top').attr('stroke', '#78909c').attr('stroke-width', 1.5);
        errorEnter.append('line').attr('class', 'error-bottom').attr('stroke', '#78909c').attr('stroke-width', 1.5);

        const errorMerged = errorEnter.merge(errorSelection);
        errorMerged.select('.error-stem')
            .attr('x1', d => this.xScale(d.plane))
            .attr('x2', d => this.xScale(d.plane))
            .attr('y1', d => this.yScale(d.value - d.std))
            .attr('y2', d => this.yScale(d.value + d.std));

        errorMerged.select('.error-top')
            .attr('x1', d => this.xScale(d.plane) - 3)
            .attr('x2', d => this.xScale(d.plane) + 3)
            .attr('y1', d => this.yScale(d.value + d.std))
            .attr('y2', d => this.yScale(d.value + d.std));

        errorMerged.select('.error-bottom')
            .attr('x1', d => this.xScale(d.plane) - 3)
            .attr('x2', d => this.xScale(d.plane) + 3)
            .attr('y1', d => this.yScale(d.value - d.std))
            .attr('y2', d => this.yScale(d.value - d.std));

        // Update scatter points
        const dotsSelection = this.dotsG.selectAll('.profile-dot').data(this.data, d => d.plane);

        dotsSelection.exit().remove();

        const self = this;
        const dotsEnter = dotsSelection.enter()
            .append('circle')
            .attr('class', 'profile-dot')
            .attr('r', 4)
            .attr('fill', this.pointColor)
            .attr('stroke', '#ffffff')
            .attr('stroke-width', 1.5)
            .style('cursor', 'pointer');

        dotsEnter.merge(dotsSelection)
            .attr('cx', d => this.xScale(d.plane))
            .attr('cy', d => this.yScale(d.value))
            .attr('fill', d => (d.value > 0.98 ? '#b0bec5' : this.pointColor))
            .attr('stroke', d => (d.value > 0.98 ? '#37474f' : '#ffffff'))
            .attr('r', d => (d.value > 0.98 ? 3.5 : 4))
            .on('mouseenter', function (event, d) {
                d3.select(this).attr('r', 6).attr('fill', '#e53935');
                if (self.tooltip) {
                    const stdStr = (typeof d.std === 'number') ? ` ± ${d.std.toFixed(2)}` : '';
                    const refTag = (d.value > 0.98) ? '<br><span style="color:#e65100;font-weight:bold;">[Reference Scan &gt; 0.98, excluded from fit]</span>' : '';
                    self.tooltip.innerHTML = `<strong>Plane:</strong> ${d.label || d.plane}<br><strong>Value:</strong> ${d.value.toFixed(3)}${stdStr}${refTag}`;
                    self.tooltip.style.display = 'block';
                    const contRect = self.container.getBoundingClientRect();
                    self.tooltip.style.left = Math.min(contRect.width - 120, Math.max(10, event.clientX - contRect.left + 10)) + 'px';
                    self.tooltip.style.top = Math.max(10, event.clientY - contRect.top - 40) + 'px';
                }
            })
            .on('mousemove', function (event) {
                if (self.tooltip) {
                    const contRect = self.container.getBoundingClientRect();
                    self.tooltip.style.left = Math.min(contRect.width - 120, Math.max(10, event.clientX - contRect.left + 10)) + 'px';
                    self.tooltip.style.top = Math.max(10, event.clientY - contRect.top - 40) + 'px';
                }
            })
            .on('mouseleave', function (event, d) {
                const defFill = (d && d.value > 0.98) ? '#b0bec5' : self.pointColor;
                const defR = (d && d.value > 0.98) ? 3.5 : 4;
                d3.select(this).attr('r', defR).attr('fill', defFill);
                if (self.tooltip) self.tooltip.style.display = 'none';
            });

        // Update Fit Elements
        if (this.fitData && this.showFit) {
            this.fitG.style('display', 'block');

            // 1. Baseline line
            if (typeof this.fitData.baseline === 'number' && this.fitData.fit_range) {
                const y0_px = this.yScale(this.fitData.baseline);
                const x1_px = this.xScale(this.fitData.fit_range[0]);
                const x2_px = this.xScale(this.fitData.fit_range[1]);
                this.fitBaseline
                    .attr('x1', x1_px)
                    .attr('x2', x2_px)
                    .attr('y1', y0_px)
                    .attr('y2', y0_px)
                    .style('display', 'block');
            } else {
                this.fitBaseline.style('display', 'none');
            }

            // 2. Fit window boundary markers
            const bData = (this.fitData.fit_range && this.fitData.fit_range.length === 2) ? this.fitData.fit_range : [];
            const bSel = this.fitBoundsG.selectAll('.fit-bound-line').data(bData);
            bSel.exit().remove();
            bSel.enter().append('line')
                .attr('class', 'fit-bound-line')
                .attr('stroke', '#b0bec5')
                .attr('stroke-dasharray', '3,3')
                .attr('stroke-width', 1)
                .merge(bSel)
                .attr('x1', d => this.xScale(d))
                .attr('x2', d => this.xScale(d))
                .attr('y1', 0)
                .attr('y2', innerHeight);

            // 3. Peak center vertical markers
            const pCenters = this.fitData.peak_centers || [];
            const pSel = this.fitPeakMarkersG.selectAll('.fit-peak-marker').data(pCenters, (d, i) => i);
            pSel.exit().remove();
            pSel.enter().append('line')
                .attr('class', 'fit-peak-marker')
                .attr('stroke', '#78909c')
                .attr('stroke-dasharray', '2,2')
                .attr('stroke-width', 1)
                .merge(pSel)
                .attr('x1', d => this.xScale(d.x0))
                .attr('x2', d => this.xScale(d.x0))
                .attr('y1', 0)
                .attr('y2', innerHeight);

            // 4. Component dashed lines (for multi-peak models)
            const comps = this.fitData.components || [];
            const compSel = this.fitCompG.selectAll('.fit-comp-line').data(comps.length > 1 ? comps : [], d => d.id);
            compSel.exit().remove();
            compSel.enter().append('path')
                .attr('class', 'fit-comp-line')
                .attr('fill', 'none')
                .attr('stroke-dasharray', '4,3')
                .attr('stroke-width', 1.6)
                .merge(compSel)
                .attr('stroke', d => d.color || '#e53935')
                .attr('d', d => this.fitCurveGenerator(d.points));

            // 5. Total fitted curve
            if (this.fitData.total_curve && this.fitData.total_curve.length > 0) {
                this.fitLine
                    .datum(this.fitData.total_curve)
                    .attr('d', this.fitCurveGenerator)
                    .style('display', 'block');
            } else {
                this.fitLine.style('display', 'none');
            }

            // 6. Inset Legend / Fit summary badge
            this.fitLegendG.selectAll('*').remove();
            if (this.fitData.stats) {
                const st = this.fitData.stats;
                const r2Str = (typeof st.r2 === 'number') ? st.r2.toFixed(3) : '';
                const rmseStr = (typeof st.rmse === 'number') ? st.rmse.toFixed(4) : '';
                const badgeText = `${st.num_peaks} Peak${st.num_peaks > 1 ? 's' : ''} Fit | R²: ${r2Str} | RMSE: ${rmseStr}`;

                const badgeG = this.fitLegendG.append('g')
                    .attr('transform', `translate(${innerWidth - 6}, 14)`);

                badgeG.append('text')
                    .attr('text-anchor', 'end')
                    .attr('font-size', '10px')
                    .attr('fill', '#c62828')
                    .attr('font-weight', 'bold')
                    .text(badgeText);
            }
        } else {
            this.fitG.style('display', 'none');
            this.fitLegendG.selectAll('*').remove();
        }
    }

    /**
     * Update fit data and re-render plot
     * @param {Object} fitData
     */
    set_fit_data(fitData) {
        this.fitData = fitData;
        this.update_plot();
    }

    /**
     * Toggle visibility of the fitted curve
     * @param {boolean} [forceVisible]
     * @returns {boolean} current visibility state
     */
    toggle_fit_visibility(forceVisible) {
        if (typeof forceVisible === 'boolean') {
            this.showFit = forceVisible;
        } else {
            this.showFit = !this.showFit;
        }
        this.update_plot();
        return this.showFit;
    }

    /**
     * Set up wheel zoom and drag panning interactions
     */
    setupInteractions() {
        const self = this;
        const svgNode = this.svg.node();

        // 1. Wheel Zoom Handler
        svgNode.addEventListener('wheel', function (event) {
            event.preventDefault();

            if (!self.data || self.data.length === 0) return;

            const rect = svgNode.getBoundingClientRect();
            // Scale mouse position to SVG internal viewBox coordinate space
            const scaleX = self.width / rect.width;
            const scaleY = self.height / rect.height;
            const mouseX = (event.clientX - rect.left) * scaleX;
            const mouseY = (event.clientY - rect.top) * scaleY;

            const isLeftOfYAxis = (mouseX < self.margin.left);
            const isBelowXAxis = (mouseY > self.height - self.margin.bottom);

            // Zoom factor: wheel down (positive) zooms out (>1), wheel up zooms in (<1)
            const zoomFactor = event.deltaY > 0 ? 1.15 : 0.87;

            const innerWidth = self.width - self.margin.left - self.margin.right;
            const innerHeight = self.height - self.margin.top - self.margin.bottom;

            // Determine whether to zoom X, Y, or both
            const zoomX = isBelowXAxis || (!isLeftOfYAxis && !isBelowXAxis);
            const zoomY = isLeftOfYAxis || (!isLeftOfYAxis && !isBelowXAxis);

            if (zoomX) {
                const pivotXPixel = Math.max(0, Math.min(innerWidth, mouseX - self.margin.left));
                const pivotX = self.xScale.invert(pivotXPixel);
                const xDomain = self.xScale.domain();
                const xSpan = xDomain[1] - xDomain[0];
                const newXSpan = xSpan * zoomFactor;
                const ratioX = (xSpan === 0) ? 0.5 : (pivotX - xDomain[0]) / xSpan;

                const newXMin = pivotX - ratioX * newXSpan;
                const newXMax = newXMin + newXSpan;
                self.xScale.domain([newXMin, newXMax]);
            }

            if (zoomY) {
                const pivotYPixel = Math.max(0, Math.min(innerHeight, mouseY - self.margin.top));
                const pivotY = self.yScale.invert(pivotYPixel);
                const yDomain = self.yScale.domain();
                const ySpan = yDomain[1] - yDomain[0];
                const newYSpan = ySpan * zoomFactor;
                const ratioY = (ySpan === 0) ? 0.5 : (pivotY - yDomain[0]) / ySpan;

                const newYMin = pivotY - ratioY * newYSpan;
                const newYMax = newYMin + newYSpan;
                self.yScale.domain([newYMin, newYMax]);
            }

            self.update_plot();
        }, { passive: false });

        // 2. Click and Drag to Pan
        let isDragging = false;
        let startX = 0;
        let startY = 0;
        let startDomainX = [0, 1];
        let startDomainY = [0, 1];

        this.overlay.on('mousedown', function (event) {
            if (event.button !== 0) return; // Left click only
            event.preventDefault();
            isDragging = true;
            startX = event.clientX;
            startY = event.clientY;
            startDomainX = [...self.xScale.domain()];
            startDomainY = [...self.yScale.domain()];
            self.overlay.style('cursor', 'grabbing');
        });

        window.addEventListener('mousemove', function (event) {
            if (!isDragging) return;
            event.preventDefault();

            const rect = svgNode.getBoundingClientRect();
            const scaleX = self.width / rect.width;
            const scaleY = self.height / rect.height;

            const dxPixels = (event.clientX - startX) * scaleX;
            const dyPixels = (event.clientY - startY) * scaleY;

            const innerWidth = self.width - self.margin.left - self.margin.right;
            const innerHeight = self.height - self.margin.top - self.margin.bottom;

            const xSpan = startDomainX[1] - startDomainX[0];
            const ySpan = startDomainY[1] - startDomainY[0];

            const dxDomain = (dxPixels / innerWidth) * xSpan;
            // Note: SVG Y coordinates run top-down, but yScale runs bottom-up
            const dyDomain = (dyPixels / innerHeight) * ySpan;

            self.xScale.domain([startDomainX[0] - dxDomain, startDomainX[1] - dxDomain]);
            self.yScale.domain([startDomainY[0] + dyDomain, startDomainY[1] + dyDomain]);

            self.update_plot();
        });

        window.addEventListener('mouseup', function () {
            if (isDragging) {
                isDragging = false;
                self.overlay.style('cursor', 'crosshair');
            }
        });
    }

    /**
     * Reset zoom and pan to initial extent
     */
    reset_view() {
        if (!this.data || this.data.length === 0) return;
        this.xScale.domain([...this.xOrigDomain]);
        this.yScale.domain([...this.yOrigDomain]);
        this.update_plot();
    }

    /**
     * Resize plot to new container dimensions
     * @param {number} newWidth
     * @param {number} newHeight
     */
    resize(newWidth, newHeight) {
        if (newWidth < 150 || newHeight < 100) return;
        this.width = newWidth;
        this.height = newHeight;

        const innerWidth = Math.max(0, this.width - this.margin.left - this.margin.right);
        const innerHeight = Math.max(0, this.height - this.margin.top - this.margin.bottom);

        this.svg.attr('viewBox', `0 0 ${this.width} ${this.height}`);

        this.clipPath
            .attr('width', innerWidth)
            .attr('height', innerHeight);

        this.overlay
            .attr('width', innerWidth)
            .attr('height', innerHeight);

        this.xAxisG
            .attr('transform', `translate(0, ${innerHeight})`);

        this.xLabel
            .attr('x', innerWidth / 2)
            .attr('y', innerHeight + 36);

        this.yLabel
            .attr('x', -innerHeight / 2)
            .attr('y', -48);

        this.update_plot();
    }
}

