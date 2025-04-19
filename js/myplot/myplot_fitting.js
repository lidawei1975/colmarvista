
/**
 * A class to show pseudo3D fitting result.
 * 2D plot with both scatter (experiments) and linear (fitted) 
 */


class fitting_plot {
    /**
     * Creates a new ScatterLinearPlot.
     *
     * @param {string} selector - The CSS selector for the container element.
     * @param {object} options - Configuration options for the plot.
     * @param {number} [options.width=800] - The width of the plot.
     * @param {number} [options.height=600] - The height of the plot.
     * @param {number} [options.margin={ top: 20, right: 30, bottom: 30, left: 40 }] - Margins for the plot.
     * @param {string} [options.xLabel='pseudo3D plane'] - Label for the x-axis.
     * @param {string} [options.yLabel='Y Axis'] - Label for the y-axis.
     * @param {string} [options.linearColor='red'] - Color for the linear regression line.
     * @param {string} [options.scatterColor='steelblue'] - Color for the scatter points.
     */
    constructor(selector, options = {}) {
      this.selector = selector;
      this.width = options.width || 800;
      this.height = options.height || 600;
      this.margin = options.margin || { top: 10, right: 10, bottom: 40, left: 50 };
      this.xLabel = options.xLabel || 'pseudo3D plane';
      this.yLabel = options.yLabel || 'Y Axis';
      this.linearColor = options.linearColor || 'red';
      this.scatterColor = options.scatterColor || 'steelblue';
      this.svg = d3
        .select(this.selector)
        .append('svg')
        .attr('width', this.width)
        .attr('height', this.height);
      this.g = this.svg
        .append('g')
        .attr('transform', `translate(${this.margin.left},${this.margin.top})`);
      this.xScale = null;
      this.yScale = null;
      this.xAxis = null;
      this.yAxis = null;
    }
  
    /**
     * Draws the scatter plot and optionally the linear regression line.
     *
     * @param {Array<{ x: number, y: number }>} data - The data points to plot.
     */
    draw_scatter(data) {
      const innerWidth = this.width - this.margin.left - this.margin.right;
      const innerHeight = this.height - this.margin.top - this.margin.bottom;
  
      this.xScale = d3
        .scaleLinear()
        .domain(d3.extent(data, (d) => d.x))
        .range([0, innerWidth]);
  
      this.yScale = d3
        .scaleLinear()
        .domain(d3.extent(data, (d) => d.y))
        .range([innerHeight, 0]);
  
      this.xAxis = d3.axisBottom(this.xScale);
      this.yAxis = d3.axisLeft(this.yScale);
  
      this.g
        .append('g')
        .attr('transform', `translate(0,${innerHeight})`)
        .call(this.xAxis);
  
      this.g.append('g').call(this.yAxis);
  
      /**
       * Draw two additional rect on top of the scatter points to represent the standard deviation.
       * only if y_std is available.
       */
      if (data[0].y_std != null) {
        this.g
        .selectAll('rect.error_top')
          .data(data)
          .enter()
          .append('rect')
          .attr('x', (d) => this.xScale(d.x)-3)
          .attr('y', (d) => this.yScale(d.y+d.y_std)-3)
          .attr('width', 6)
          .attr('height', 6)
          .attr('fill', 'red');

        this.g
          .selectAll('rect.error_bottom')
          .data(data)
          .enter()
          .append('rect')
          .attr('x', (d) => this.xScale(d.x)-3)
          .attr('y', (d) => this.yScale(d.y-d.y_std)-3)
          .attr('width', 6)
          .attr('height', 6)
          .attr('fill', 'red');
      }

      /**
       * Draw the scatter points later
       * so that it will cover the error rects if they overlap (error is very small).
       */
      this.g
        .selectAll('circle.center')
        .data(data)
        .enter()
        .append('circle')
        .attr('cx', (d) => this.xScale(d.x))
        .attr('cy', (d) => this.yScale(d.y))
        .attr('r', 5)
        .attr('fill', this.scatterColor);

  
      this.g
        .append('text')
        .attr('transform', `translate(${innerWidth / 2},${innerHeight + this.margin.bottom - 5})`)
        .style('text-anchor', 'middle')
        .text(this.xLabel);
  
      this.g
        .append('text')
        .attr('transform', 'rotate(-90)')
        .attr('y', 0 - this.margin.left)
        .attr('x', 0 - innerHeight / 2)
        .attr('dy', '1em')
        .style('text-anchor', 'middle')
        .text(this.yLabel);
    }
  
    /**
     * Draws the linear regression line.
     *
     * @param {Array<{ x: number, y: number }>} data - The data points.
     */
    draw_line(data) {
        const lineGenerator = d3
        .line()
        .x((d) =>  this.xScale(d.x)) // Access the x-coordinate from each data point
        .y((d) =>  this.yScale(d.y)); // Access the y-coordinate from each data point
    
      // Append a path element and use the line generator to create the 'd' attribute
      this.g
        .append('path')
        .datum(data) // Bind the data array to the path element
        .attr('d', lineGenerator) // Generate the path data using the line generator
        .attr('stroke', this.linearColor)
        .attr('stroke-width', 2)
        .attr('fill', 'none'); // Ensure the path is not filled
    }
  }