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

        this.ppmConverter = options.ppmConverter || null;
        this.invertX = (options.invertX !== undefined) ? !!options.invertX : (this.ppmConverter && this.ppmConverter.n15_mhz ? true : false);
        const defaultMarginTop = (this.ppmConverter && this.ppmConverter.n15_mhz) ? 38 : 25;
        this.margin = options.margin || { top: defaultMarginTop, right: 30, bottom: 45, left: 65 };
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
        // 1. Voigt fit graphics group (blue line)
        this.voigtFitG = this.dataG.append('g').attr('class', 'profile-voigt-fit-group');
        this.fitBoundsG = this.voigtFitG.append('g').attr('class', 'profile-fit-bounds');
        this.fitBaseline = this.voigtFitG.append('line')
            .attr('class', 'profile-fit-baseline')
            .attr('stroke', '#2e7d32')
            .attr('stroke-dasharray', '3,3')
            .attr('stroke-width', 1.5)
            .style('display', 'none');
        this.fitPeakMarkersG = this.voigtFitG.append('g').attr('class', 'profile-fit-peak-markers');
        this.fitCompG = this.voigtFitG.append('g').attr('class', 'profile-fit-components');
        this.voigtLine = this.voigtFitG.append('path')
            .attr('class', 'profile-voigt-line')
            .attr('fill', 'none')
            .attr('stroke', '#1976d2')
            .attr('stroke-width', 2);

        // 2. ChemEx fit graphics group (red line)
        this.chemexFitG = this.dataG.append('g').attr('class', 'profile-chemex-fit-group');
        this.chemexLine = this.chemexFitG.append('path')
            .attr('class', 'profile-chemex-line')
            .attr('fill', 'none')
            .attr('stroke', '#d32f2f')
            .attr('stroke-width', 2.2);

        // Backward compatibility references
        this.fitG = this.voigtFitG;
        this.fitLine = this.voigtLine;

        // Axes groups
        this.xAxisG = this.g.append('g')
            .attr('class', 'profile-x-axis')
            .attr('transform', `translate(0, ${this.height - this.margin.top - this.margin.bottom})`);

        this.topXAxisG = this.g.append('g')
            .attr('class', 'profile-top-x-axis')
            .attr('transform', 'translate(0, 0)');

        this.yAxisG = this.g.append('g')
            .attr('class', 'profile-y-axis');

        // Legend group for fit statistics
        this.fitLegendG = this.g.append('g').attr('class', 'profile-fit-legend');

        // Fit data state and visibility flags
        this.fitData = null;
        this.showVoigtFit = true;
        this.showChemexFit = true;
        this.showFit = true;
        this.isAutozoomed = false;

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

        this.topXLabel = this.g.append('text')
            .attr('class', 'profile-top-x-label')
            .attr('text-anchor', 'middle')
            .attr('fill', '#455a64')
            .attr('font-size', '11px')
            .attr('font-weight', 'bold')
            .attr('x', (this.width - this.margin.left - this.margin.right) / 2)
            .attr('y', -24)
            .text('¹⁵N (ppm)');

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
        this.ppmScale = d3.scaleLinear();

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

        // Apply layout sizing
        this.update_layout();

        // Setup interaction handlers
        this.setupInteractions();
    }

    /**
     * Recompute layout positions and dimensions for axes, labels, and scales
     */
    update_layout() {
        this.margin.top = (this.ppmConverter && typeof this.ppmConverter.n15_mhz === 'number' && this.ppmConverter.n15_mhz > 0) ? 38 : 25;
        const innerWidth = Math.max(0, this.width - this.margin.left - this.margin.right);
        const innerHeight = Math.max(0, this.height - this.margin.top - this.margin.bottom);

        this.g.attr('transform', `translate(${this.margin.left},${this.margin.top})`);

        this.clipPath
            .attr('width', innerWidth)
            .attr('height', innerHeight);

        this.overlay
            .attr('width', innerWidth)
            .attr('height', innerHeight);

        this.xAxisG
            .attr('transform', `translate(0, ${innerHeight})`);

        this.topXAxisG
            .attr('transform', 'translate(0, 0)');

        this.xLabel
            .attr('x', innerWidth / 2)
            .attr('y', innerHeight + 36);

        this.topXLabel
            .attr('x', innerWidth / 2)
            .attr('y', -24);

        this.yLabel
            .attr('x', -innerHeight / 2)
            .attr('y', -48);

        this.xScale.range([0, innerWidth]);
        this.yScale.range([innerHeight, 0]);
        this.ppmScale.range([0, innerWidth]);
    }

    /**
     * Convert offset in Hz to 15N chemical shift in ppm
     * Formula: ppm = carrier + (offset_hz / n15_mhz)
     * @param {number} hz
     * @returns {number|null}
     */
    hz_to_ppm(hz) {
        if (!this.ppmConverter || typeof this.ppmConverter.n15_mhz !== 'number' || this.ppmConverter.n15_mhz === 0) {
            return null;
        }
        return this.ppmConverter.carrier + (hz / this.ppmConverter.n15_mhz);
    }

    /**
     * Convert 15N chemical shift in ppm to offset in Hz
     * Formula: offset_hz = (ppm - carrier) * n15_mhz
     * @param {number} ppm
     * @returns {number|null}
     */
    ppm_to_hz(ppm) {
        if (!this.ppmConverter || typeof this.ppmConverter.n15_mhz !== 'number' || this.ppmConverter.n15_mhz === 0) {
            return null;
        }
        return (ppm - this.ppmConverter.carrier) * this.ppmConverter.n15_mhz;
    }

    /**
     * Set or update the ppm conversion configuration
     * @param {{ carrier: number, n15_mhz: number, h_larmor_frq?: number }|null} converter
     */
    set_ppm_converter(converter, invertX = undefined) {
        this.ppmConverter = converter;
        if (invertX !== undefined) {
            this.invertX = !!invertX;
        } else if (converter && converter.n15_mhz) {
            this.invertX = true;
        }
        this.update_layout();
        this.update_plot();
    }

    /**
     * Set or toggle inverted X axis (NMR convention: large values on left, smaller on right)
     * @param {boolean} invert
     */
    set_invert_x(invert) {
        this.invertX = !!invert;
        if (this.data && this.data.length > 0) {
            const minX = d3.min(this.data, d => d.plane);
            const maxX = d3.max(this.data, d => d.plane);
            const xPad = (maxX === minX) ? 1 : (maxX - minX) * 0.05;
            this.xOrigDomain = this.invertX ? [maxX + xPad, minX - xPad] : [minX - xPad, maxX + xPad];
            this.xScale.domain([...this.xOrigDomain]);
            this.update_plot();
        }
    }

    /**
     * Set data and initialize scales
     * @param {Array<{ plane: number, label: string, value: number, std?: number }>} data
     * @param {Object} [fitData] - Optional fit curve data generated from peak_profile
     * @param {Object} [ppmConverter] - Optional { carrier, n15_mhz, h_larmor_frq }
     * @param {boolean} [invertX] - Optional whether to invert X axis (NMR convention)
     */
    set_data(data, fitData = null, ppmConverter = undefined, invertX = undefined) {
        if (ppmConverter !== undefined) {
            this.ppmConverter = ppmConverter;
        }
        if (invertX !== undefined) {
            this.invertX = !!invertX;
        } else if (this.ppmConverter && this.ppmConverter.n15_mhz) {
            this.invertX = true;
        }
        this.update_layout();

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

        // In NMR convention, large values are on the left and smaller values on the right
        if (this.invertX || (this.ppmConverter && this.ppmConverter.n15_mhz)) {
            this.xOrigDomain = [maxX + xPad, minX - xPad];
        } else {
            this.xOrigDomain = [minX - xPad, maxX + xPad];
        }

        // Determine Y extent
        let minY = d3.min(this.data, d => (typeof d.std === 'number' ? d.value - d.std : d.value));
        let maxY = d3.max(this.data, d => (typeof d.std === 'number' ? d.value + d.std : d.value));

        const voigt = (this.fitData && this.fitData.voigt) ? this.fitData.voigt : (this.fitData && this.fitData.total_curve ? this.fitData : null);
        const chemex = (this.fitData && this.fitData.chemex) ? this.fitData.chemex : null;

        if (voigt && voigt.total_curve && voigt.total_curve.length > 0) {
            const fitMinY = d3.min(voigt.total_curve, d => d.y);
            const fitMaxY = d3.max(voigt.total_curve, d => d.y);
            if (fitMinY !== undefined && !isNaN(fitMinY)) minY = Math.min(minY, fitMinY);
            if (fitMaxY !== undefined && !isNaN(fitMaxY)) maxY = Math.max(maxY, fitMaxY);
            if (typeof voigt.baseline === 'number' && !isNaN(voigt.baseline)) {
                minY = Math.min(minY, voigt.baseline);
                maxY = Math.max(maxY, voigt.baseline);
            }
        }
        if (chemex && chemex.total_curve && chemex.total_curve.length > 0) {
            const chemMinY = d3.min(chemex.total_curve, d => d.y);
            const chemMaxY = d3.max(chemex.total_curve, d => d.y);
            if (chemMinY !== undefined && !isNaN(chemMinY)) minY = Math.min(minY, chemMinY);
            if (chemMaxY !== undefined && !isNaN(chemMaxY)) maxY = Math.max(maxY, chemMaxY);
            if (typeof chemex.baseline === 'number' && !isNaN(chemex.baseline)) {
                minY = Math.min(minY, chemex.baseline);
                maxY = Math.max(maxY, chemex.baseline);
            }
        }
        const ySpan = maxY - minY;
        const yPad = (ySpan === 0) ? Math.abs(maxY || 1) * 0.1 : ySpan * 0.1;
        this.yOrigDomain = [minY - yPad, maxY + yPad];

        // Set initial domains
        this.xScale.domain([...this.xOrigDomain]);
        this.yScale.domain([...this.yOrigDomain]);

        // Automatically autozoom to dips if negative peak(s) are detected; otherwise remain at full view
        if (this.has_negative_peaks()) {
            this.autozoom_to_dips();
        } else {
            this.isAutozoomed = false;
            this.update_plot();
        }
    }

    /**
     * Update the X axis label text dynamically
     * @param {string} label
     */
    set_x_label(label) {
        this.xLabelText = label || 'Plane Index';
        if (this.xLabel) {
            this.xLabel.text(this.xLabelText);
        }
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
            this.topXAxisG.style('display', 'none');
            this.topXLabel.style('display', 'none');
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

        // Update top X axis (15N ppm)
        if (this.ppmConverter && typeof this.ppmConverter.n15_mhz === 'number' && this.ppmConverter.n15_mhz > 0) {
            this.ppmScale.range([0, innerWidth]);
            const xDom = this.xScale.domain();
            const leftPpm = this.hz_to_ppm(xDom[0]);
            const rightPpm = this.hz_to_ppm(xDom[1]);
            this.ppmScale.domain([leftPpm, rightPpm]);

            const topXAxis = d3.axisTop(this.ppmScale)
                .ticks(xTicksCount)
                .tickFormat(d => d.toFixed(2));

            this.topXAxisG
                .style('display', 'block')
                .call(topXAxis);

            this.topXAxisG.selectAll('text').attr('fill', '#455a64').attr('font-size', '10px');
            this.topXAxisG.selectAll('line').attr('stroke', '#78909c');
            this.topXAxisG.select('.domain').attr('stroke', '#78909c');

            let labelStr = '¹⁵N (ppm)';
            if (typeof this.ppmConverter.carrier === 'number') {
                labelStr += ` [Carrier: ${this.ppmConverter.carrier.toFixed(2)} ppm]`;
            }
            this.topXLabel
                .style('display', 'block')
                .attr('x', innerWidth / 2)
                .attr('y', -24)
                .text(labelStr);

            let carrierTip = `Carrier: ${this.ppmConverter.carrier.toFixed(2)} ppm, 15N frq: ${this.ppmConverter.n15_mhz.toFixed(3)} MHz`;
            if (this.ppmConverter.h_larmor_frq) {
                carrierTip += ` (1H: ${this.ppmConverter.h_larmor_frq.toFixed(1)} MHz)`;
            }
            this.topXLabel.selectAll('title').remove();
            this.topXLabel.append('title').text(carrierTip);
        } else {
            this.topXAxisG.style('display', 'none');
            this.topXLabel.style('display', 'none');
        }

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
                    
                    let xCoordStr = '';
                    if (self.ppmConverter && typeof self.ppmConverter.n15_mhz === 'number') {
                        const ppmVal = self.hz_to_ppm(d.plane);
                        const ppmStr = (typeof ppmVal === 'number') ? ` (${ppmVal.toFixed(2)} ppm)` : '';
                        xCoordStr = `<strong>Offset:</strong> ${d.plane} Hz${ppmStr}`;
                    } else {
                        const xLabelPrefix = (self.xLabelText && self.xLabelText.includes('Offset')) ? 'Offset (Hz)' : 'Plane';
                        xCoordStr = `<strong>${xLabelPrefix}:</strong> ${d.plane}`;
                    }

                    self.tooltip.innerHTML = `${xCoordStr}<br><strong>Value:</strong> ${d.value.toFixed(3)}${stdStr}${refTag}`;
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
        const voigt = (this.fitData && this.fitData.voigt) ? this.fitData.voigt : (this.fitData && this.fitData.total_curve ? this.fitData : null);
        const chemex = (this.fitData && this.fitData.chemex) ? this.fitData.chemex : null;

        // 1. Voigt Fit Elements
        if (voigt && this.showVoigtFit) {
            this.voigtFitG.style('display', 'block');

            // 1.1 Baseline line
            if (typeof voigt.baseline === 'number' && voigt.fit_range) {
                const y0_px = this.yScale(voigt.baseline);
                const x1_px = this.xScale(voigt.fit_range[0]);
                const x2_px = this.xScale(voigt.fit_range[1]);
                this.fitBaseline
                    .attr('x1', x1_px)
                    .attr('x2', x2_px)
                    .attr('y1', y0_px)
                    .attr('y2', y0_px)
                    .style('display', 'block');
            } else {
                this.fitBaseline.style('display', 'none');
            }

            // 1.2 Fit window boundary markers
            const bData = (voigt.fit_range && voigt.fit_range.length === 2) ? voigt.fit_range : [];
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

            // 1.3 Peak center vertical markers
            const pCenters = voigt.peak_centers || [];
            const pSel = this.fitPeakMarkersG.selectAll('.fit-peak-marker').data(pCenters, (d, i) => i);
            pSel.exit().remove();
            const pEnter = pSel.enter().append('g').attr('class', 'fit-peak-marker');
            pEnter.append('line')
                .attr('class', 'fit-peak-marker-line')
                .attr('stroke', '#78909c')
                .attr('stroke-dasharray', '2,2')
                .attr('stroke-width', 1.2);
            pEnter.append('title');

            const pMerged = pEnter.merge(pSel);
            pMerged.select('line')
                .attr('x1', d => this.xScale(d.x0))
                .attr('x2', d => this.xScale(d.x0))
                .attr('y1', 0)
                .attr('y2', innerHeight);

            pMerged.select('title')
                .text(d => {
                    if (self.ppmConverter) {
                        const ppmVal = self.hz_to_ppm(d.x0);
                        const ppmStr = (typeof ppmVal === 'number') ? ` (${ppmVal.toFixed(2)} ppm)` : '';
                        return `Dip Center: ${d.x0.toFixed(1)} Hz${ppmStr}`;
                    }
                    return `Dip Center: ${d.x0.toFixed(1)}`;
                });

            // 1.4 Component dashed lines (for multi-peak models)
            const comps = voigt.components || [];
            const compSel = this.fitCompG.selectAll('.fit-comp-line').data(comps.length > 1 ? comps : [], d => d.id);
            compSel.exit().remove();
            compSel.enter().append('path')
                .attr('class', 'fit-comp-line')
                .attr('fill', 'none')
                .attr('stroke-dasharray', '4,3')
                .attr('stroke-width', 1.6)
                .merge(compSel)
                .attr('stroke', d => d.color || '#1976d2')
                .attr('d', d => this.fitCurveGenerator(d.points));

            // 1.5 Total Voigt curve (blue)
            if (voigt.total_curve && voigt.total_curve.length > 0) {
                this.voigtLine
                    .datum(voigt.total_curve)
                    .attr('d', this.fitCurveGenerator)
                    .style('display', 'block');
            } else {
                this.voigtLine.style('display', 'none');
            }
        } else {
            this.voigtFitG.style('display', 'none');
        }

        // 2. ChemEx Fit Elements (red line)
        if (chemex && this.showChemexFit && chemex.total_curve && chemex.total_curve.length > 0) {
            this.chemexFitG.style('display', 'block');
            this.chemexLine
                .datum(chemex.total_curve)
                .attr('d', this.fitCurveGenerator)
                .style('display', 'block');
        } else {
            this.chemexFitG.style('display', 'none');
        }

        // 3. Inset Legend / Fit summary badges
        this.fitLegendG.selectAll('*').remove();
        let badgeY = 14;

        if (voigt && this.showVoigtFit && voigt.stats) {
            const st = voigt.stats;
            const r2Str = (typeof st.r2 === 'number') ? st.r2.toFixed(3) : '';
            const rmseStr = (typeof st.rmse === 'number') ? st.rmse.toFixed(4) : '';
            const voigtText = st.custom_badge ? st.custom_badge : `Voigt: ${st.num_peaks || 1} Dip${(st.num_peaks || 1) > 1 ? 's' : ''} | R²: ${r2Str}`;

            const badgeG = this.fitLegendG.append('g')
                .attr('transform', `translate(${innerWidth - 6}, ${badgeY})`);
            badgeG.append('text')
                .attr('text-anchor', 'end')
                .attr('font-size', '10px')
                .attr('fill', '#1565c0')
                .attr('font-weight', 'bold')
                .text(voigtText);
            badgeY += 14;
        }

        if (chemex && this.showChemexFit && chemex.stats) {
            const chemexText = chemex.stats.custom_badge || 'ChemEx Fit';
            const badgeG = this.fitLegendG.append('g')
                .attr('transform', `translate(${innerWidth - 6}, ${badgeY})`);
            badgeG.append('text')
                .attr('text-anchor', 'end')
                .attr('font-size', '10px')
                .attr('fill', '#c62828')
                .attr('font-weight', 'bold')
                .text(chemexText);
        }

        // Keep DOM autozoom button in sync with current state
        this.update_autozoom_button();
    }

    /**
     * Update fit data and re-render plot
     * @param {Object} fitData
     */
    set_fit_data(fitData) {
        this.fitData = fitData;
        if (this.has_negative_peaks()) {
            this.autozoom_to_dips();
        } else {
            this.isAutozoomed = false;
            this.update_plot();
        }
    }

    /**
     * Toggle visibility of Voigt fit
     * @param {boolean} [forceVisible]
     * @returns {boolean} current visibility state
     */
    toggle_voigt_fit(forceVisible) {
        if (typeof forceVisible === 'boolean') {
            this.showVoigtFit = forceVisible;
        } else {
            this.showVoigtFit = !this.showVoigtFit;
        }
        this.update_plot();
        return this.showVoigtFit;
    }

    /**
     * Toggle visibility of ChemEx fit
     * @param {boolean} [forceVisible]
     * @returns {boolean} current visibility state
     */
    toggle_chemex_fit(forceVisible) {
        if (typeof forceVisible === 'boolean') {
            this.showChemexFit = forceVisible;
        } else {
            this.showChemexFit = !this.showChemexFit;
        }
        this.update_plot();
        return this.showChemexFit;
    }

    /**
     * Toggle visibility of fitted curves (backward compatibility)
     * @param {boolean} [forceVisible]
     * @returns {boolean} current visibility state
     */
    toggle_fit_visibility(forceVisible) {
        let newState = (typeof forceVisible === 'boolean') ? forceVisible : !(this.showVoigtFit || this.showChemexFit);
        this.showVoigtFit = newState;
        this.showChemexFit = newState;
        this.showFit = newState;
        this.update_plot();
        return newState;
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
            const isAboveTopXAxis = (mouseY < self.margin.top && mouseX >= self.margin.left && mouseX <= self.width - self.margin.right);

            // Zoom factor: wheel down (positive) zooms out (>1), wheel up zooms in (<1)
            const zoomFactor = event.deltaY > 0 ? 1.15 : 0.87;
            self.isAutozoomed = false;

            const innerWidth = self.width - self.margin.left - self.margin.right;
            const innerHeight = self.height - self.margin.top - self.margin.bottom;

            // Determine whether to zoom X, Y, or both
            const zoomX = isBelowXAxis || isAboveTopXAxis || (!isLeftOfYAxis && !isBelowXAxis && !isAboveTopXAxis);
            const zoomY = isLeftOfYAxis || (!isLeftOfYAxis && !isBelowXAxis && !isAboveTopXAxis);

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

            self.isAutozoomed = false;
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
     * Retrieve detected negative peaks / dips from available fit models.
     * Checks Voigt fit result (peak_centers) and ChemEx fit curve.
     * @returns {Array<{ x0: number, fwhm?: number, A?: number, lfrac?: number }>}
     */
    get_negative_peaks() {
        const peaks = [];
        const voigt = (this.fitData && this.fitData.voigt) ? this.fitData.voigt : (this.fitData && this.fitData.total_curve ? this.fitData : null);
        const chemex = (this.fitData && this.fitData.chemex) ? this.fitData.chemex : null;

        // 1. Voigt Fit negative peak centers
        if (voigt && Array.isArray(voigt.peak_centers) && voigt.peak_centers.length > 0) {
            const numPeaks = (voigt.stats && typeof voigt.stats.num_peaks === 'number') ? voigt.stats.num_peaks : voigt.peak_centers.length;
            if (numPeaks > 0) {
                for (let pc of voigt.peak_centers) {
                    if (typeof pc.x0 === 'number' && isFinite(pc.x0)) {
                        peaks.push({
                            x0: pc.x0,
                            fwhm: pc.fwhm,
                            A: pc.A,
                            lfrac: pc.lfrac
                        });
                    }
                }
            }
        }

        // 2. ChemEx Fit curve local minima (if no Voigt peaks found)
        if (peaks.length === 0 && chemex && chemex.total_curve && chemex.total_curve.length > 5) {
            const isHz = !!(this.ppmConverter && this.ppmConverter.n15_mhz) || 
                         (this.xLabelText && this.xLabelText.includes('Offset'));
            const pts = chemex.total_curve;
            const baseline = (typeof chemex.baseline === 'number') ? chemex.baseline : d3.max(pts, d => d.y);
            const minCurveY = d3.min(pts, d => d.y);
            const maxDrop = baseline - minCurveY;
            if (maxDrop >= 0.05) {
                for (let i = 1; i < pts.length - 1; i++) {
                    if (pts[i].y < pts[i - 1].y && pts[i].y < pts[i + 1].y) {
                        const drop = baseline - pts[i].y;
                        if (drop >= Math.max(0.04, 0.20 * maxDrop)) {
                            const halfY = pts[i].y + 0.5 * drop;
                            let leftX = pts[0].x, rightX = pts[pts.length - 1].x;
                            for (let j = i; j >= 0; j--) {
                                if (pts[j].y >= halfY) { leftX = pts[j].x; break; }
                            }
                            for (let j = i; j < pts.length; j++) {
                                if (pts[j].y >= halfY) { rightX = pts[j].x; break; }
                            }
                            const fwhm = Math.abs(rightX - leftX);
                            peaks.push({
                                x0: pts[i].x,
                                fwhm: fwhm > 0 ? fwhm : (isHz ? 300 : 3.0),
                                A: drop
                            });
                        }
                    }
                }
            }
        }

        return peaks;
    }

    /**
     * Check if one or more valid negative peaks are detected
     * @returns {boolean}
     */
    has_negative_peaks() {
        const peaks = this.get_negative_peaks();
        return Array.isArray(peaks) && peaks.length > 0;
    }

    /**
     * Compute and apply autozoom focusing on the 1 or 2 dips (negative peaks).
     * Does nothing if there are no negative peaks.
     * @returns {boolean} Whether autozoom was applied.
     */
    autozoom_to_dips() {
        if (!this.data || this.data.length === 0) return false;
        const dips = this.get_negative_peaks();
        if (!dips || dips.length === 0) {
            return false;
        }

        // Determine coordinate system: Hz offsets vs Plane indices
        const isHz = !!(this.ppmConverter && this.ppmConverter.n15_mhz) || 
                     (this.xLabelText && this.xLabelText.includes('Offset'));

        // Experimental data range bounds (excluding reference scans > 0.98)
        const validData = this.data.filter(d => d.value <= 0.98);
        const dataToUse = validData.length >= 3 ? validData : this.data;
        const dataMinX = d3.min(dataToUse, d => d.plane);
        const dataMaxX = d3.max(dataToUse, d => d.plane);
        const totalSpanX = Math.abs(dataMaxX - dataMinX);

        let xZoomMin, xZoomMax;

        if (dips.length === 1) {
            // Case 1: Single dip
            const dip = dips[0];
            const x0 = dip.x0;
            const w = (typeof dip.fwhm === 'number' && dip.fwhm > 0) ? dip.fwhm : (isHz ? 350 : 3.0);
            const minHalfSpan = isHz ? 450 : 4.5;
            const halfSpan = Math.max(3.5 * w, minHalfSpan);

            xZoomMin = x0 - halfSpan;
            xZoomMax = x0 + halfSpan;
        } else {
            // Case 2: 2 or more dips
            // Sort dips by x0 ascending
            const sortedDips = [...dips].sort((a, b) => a.x0 - b.x0);
            const leftDip = sortedDips[0];
            const rightDip = sortedDips[sortedDips.length - 1];

            const xMinDip = leftDip.x0;
            const xMaxDip = rightDip.x0;
            const dipDist = Math.abs(xMaxDip - xMinDip);

            const wLeft = (typeof leftDip.fwhm === 'number' && leftDip.fwhm > 0) ? leftDip.fwhm : (isHz ? 300 : 2.5);
            const wRight = (typeof rightDip.fwhm === 'number' && rightDip.fwhm > 0) ? rightDip.fwhm : (isHz ? 300 : 2.5);

            const minMargin = isHz ? 300 : 3.0;
            const maxMargin = isHz ? 1000 : 10.0;

            const leftMargin = Math.min(maxMargin, Math.max(2.5 * wLeft, 0.35 * dipDist, minMargin));
            const rightMargin = Math.min(maxMargin, Math.max(2.5 * wRight, 0.35 * dipDist, minMargin));

            xZoomMin = xMinDip - leftMargin;
            xZoomMax = xMaxDip + rightMargin;
        }

        // Clamp to on-resonance data range with a small cushion
        const cushion = totalSpanX * 0.03;
        xZoomMin = Math.max(dataMinX - cushion, xZoomMin);
        xZoomMax = Math.min(dataMaxX + cushion, xZoomMax);

        // Safety check: ensure min < max
        if (xZoomMax <= xZoomMin) {
            const center = (xZoomMin + xZoomMax) / 2;
            const half = isHz ? 500 : 5;
            xZoomMin = center - half;
            xZoomMax = center + half;
        }

        // Apply NMR inverted X-axis convention (large values on left, smaller on right)
        const isInverted = this.invertX || (this.ppmConverter && this.ppmConverter.n15_mhz);
        if (isInverted) {
            this.xScale.domain([xZoomMax, xZoomMin]);
        } else {
            this.xScale.domain([xZoomMin, xZoomMax]);
        }

        // Calculate Y-axis domain focused on the dips and baseline within zoomed window
        const voigt = (this.fitData && this.fitData.voigt) ? this.fitData.voigt : (this.fitData && this.fitData.total_curve ? this.fitData : null);
        const chemex = (this.fitData && this.fitData.chemex) ? this.fitData.chemex : null;
        const hasLowBaseline = (voigt && typeof voigt.baseline === 'number' && voigt.baseline < 0.95) || 
                               (chemex && typeof chemex.baseline === 'number' && chemex.baseline < 0.95);

        let yPts = [];
        // 1. Experimental points within zoomed window
        for (let d of this.data) {
            if (d.plane >= xZoomMin && d.plane <= xZoomMax) {
                // If baseline is below 0.95, ignore high reference scans (> 0.98) from determining Y scale
                if (!hasLowBaseline || d.value <= 0.98) {
                    yPts.push(d.value);
                    if (typeof d.std === 'number' && !isNaN(d.std)) {
                        yPts.push(d.value - d.std);
                        yPts.push(d.value + d.std);
                    }
                }
            }
        }

        // 2. Fitted curve points within zoomed window
        if (voigt && this.showVoigtFit && voigt.total_curve) {
            for (let pt of voigt.total_curve) {
                if (pt.x >= xZoomMin && pt.x <= xZoomMax) {
                    yPts.push(pt.y);
                }
            }
            if (typeof voigt.baseline === 'number' && !isNaN(voigt.baseline)) {
                yPts.push(voigt.baseline);
            }
        }

        if (chemex && this.showChemexFit && chemex.total_curve) {
            for (let pt of chemex.total_curve) {
                if (pt.x >= xZoomMin && pt.x <= xZoomMax) {
                    yPts.push(pt.y);
                }
            }
            if (typeof chemex.baseline === 'number' && !isNaN(chemex.baseline)) {
                yPts.push(chemex.baseline);
            }
        }

        if (yPts.length > 0) {
            let minY = d3.min(yPts);
            let maxY = d3.max(yPts);
            let ySpan = maxY - minY;
            let yPad = Math.max(ySpan * 0.10, 0.04);
            let newMinY = Math.max(0, minY - yPad);
            let newMaxY = maxY + yPad;
            this.yScale.domain([newMinY, newMaxY]);
        } else {
            this.yScale.domain([...this.yOrigDomain]);
        }

        this.isAutozoomed = true;
        this.update_plot();
        return true;
    }

    /**
     * Toggle between autozoomed dips view and full overview
     * @returns {boolean} Whether currently autozoomed
     */
    toggle_autozoom() {
        if (this.isAutozoomed) {
            this.reset_view();
            return false;
        } else {
            return this.autozoom_to_dips();
        }
    }

    /**
     * Synchronize DOM Zoom button state with current plot zoom status
     */
    update_autozoom_button() {
        const btn = document.getElementById('pseudo3d_profile_autozoom_btn');
        if (!btn) return;
        const hasDips = this.has_negative_peaks();
        btn.disabled = !hasDips;
        if (!hasDips) {
            btn.innerText = 'Zoom: N/A';
            btn.style.opacity = '0.4';
            btn.style.background = '#eceff1';
            btn.style.color = '#90a4ae';
            btn.style.borderColor = '#cfd8dc';
            btn.title = 'No negative peak detected';
        } else {
            btn.innerText = this.isAutozoomed ? 'Zoom: ON' : 'Zoom: OFF';
            btn.style.opacity = '1.0';
            btn.style.background = this.isAutozoomed ? '#e8f5e9' : '#eceff1';
            btn.style.color = this.isAutozoomed ? '#2e7d32' : '#546e7a';
            btn.style.borderColor = this.isAutozoomed ? '#388e3c' : '#b0bec5';
            btn.title = this.isAutozoomed ? 'Zoomed to dips (click to toggle full view)' : 'Click to autozoom to dips';
        }
    }

    /**
     * Reset zoom and pan to initial extent
     */
    reset_view() {
        if (!this.data || this.data.length === 0) return;
        this.xScale.domain([...this.xOrigDomain]);
        this.yScale.domain([...this.yOrigDomain]);
        this.isAutozoomed = false;
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

        this.svg.attr('viewBox', `0 0 ${this.width} ${this.height}`);
        this.update_layout();
        this.update_plot();
    }
}

