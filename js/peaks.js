
/**
 * Linear regression function to calculate the slope of a line, without intercept
 * @param {*} x 
 * @param {*} y 
 * @returns an object with slope and a predict function
 */

function linearRegressionNoIntercept(x, y) {
  
    const n = x.length;
  
    // Calculate the sum of x*y and the sum of x*x.
    let sumXY = 0;
    let sumXSquared = 0;
  
    for (let i = 0; i < n; i++) {
      sumXY += x[i] * y[i];
      sumXSquared += x[i] * x[i];
    }
  
    // Calculate the slope (beta).
    const slope = sumXY / sumXSquared;
  
    // predicted y values based on the slope
    let y_pre = x.map(xi => slope * xi);
  
    // Return the slope and the predict function.
    return {
      slope: slope,
      y_pre: y_pre,
};
  }


/**
 * Define the peaks object, to store peak parameters of a spectrum
 * and peak processing methods.
 */
class cpeaks {

    constructor() {
        this.comments = []; // comments, string array
        this.column_headers = []; // column headers, string array
        this.column_formats = []; // column formats, string array
        this.columns = []; // columns, array of arrays (arrays have same length, but different types)
        this.manual_peak_index = 10000; // index for manual peaks
    };

    /**
     * Clear all data in the peaks object
     */
    clear_all_data() {
        this.comments = [];
        this.column_headers = [];
        this.column_formats = [];
        this.columns = [];
        this.manual_peak_index = 10000;
        this.gradients = null;
        this.scale_constant = 1.0;
    }

    /**
     * Apply X_PPM reference shift to all X_PPM values
     */
    update_x_ppm_ref(x_ppm_ref) {
        let x_ppm_index = this.column_headers.indexOf('X_PPM');
        if (x_ppm_index === -1) {
            return false;
        }
        this.columns[x_ppm_index] = this.columns[x_ppm_index].map(x => x + x_ppm_ref);
        return true;
    }

    /**
     * Apply Y_PPM reference shift to all Y_PPM values
     */
    update_y_ppm_ref(y_ppm_ref) {
        let y_ppm_index = this.column_headers.indexOf('Y_PPM');
        if (y_ppm_index === -1) {
            return false;
        }
        this.columns[y_ppm_index] = this.columns[y_ppm_index].map(y => y + y_ppm_ref);
        return true;
    }

    /**
     * A class method to process a peaks.tab file (nmrPipe format)
     * @param {string} peaks_tab - the peaks.tab file content as one big string, separated by newlines
     */
    process_peaks_tab(peaks_tab) {

        /**
         * Clear all data first
         */
        this.clear_all_data();


        let lines = peaks_tab.split('\n');

        /**
         * Remove empty lines or lines with only white spaces, tabs, etc.
         */
        lines = lines.filter(line => line.trim() !== '');

        /**
         * Put lines starts with DATA into this.comments
         */
        this.comments = lines.filter(line => line.startsWith('DATA'));

        // Extract headers from the VARS line
        const varsLine = lines.find(line => line.startsWith('VARS'));
        this.column_headers = varsLine.split(/\s+/).slice(1);

        // Extract formats from the FORMAT line
        const formatLine = lines.find(line => line.startsWith('FORMAT'));
        this.column_formats = formatLine.split(/\s+/).slice(1);

        /**
         * Get all lines that are after the VARS and FORMAT lines
         */
        lines = lines.slice(lines.indexOf(varsLine) + 1);

        // Extract data rows (skipping lines starting with VARS and FORMAT and DATA or is empty)
        let dataRows = lines.filter(line => !line.startsWith('VARS') && !line.startsWith('FORMAT') && !line.startsWith('DATA') && line.trim() !== '');


        /**
         * Remove leading and trailing white spaces in each line of dataRows then
         * remove dataRows that don't have same number of columns as the number of column headers
         */
        dataRows = dataRows.filter(row => row.trim().split(/\s+/).length === this.column_headers.length);

        /**
         * Split data rows into columns and save each column as an array in this.columns
         * IF column format contains " %3s" or " %4s, etc., treat it as a string
         * ELSE if column format contains " %4d", "%1d", %d, etc., treat it as an integer
         * ELSE treat it as a float
         */
        this.columns = this.column_headers.map((header, index) => {
            return dataRows.map(row => {
                /**
                 * Clear leading and trailing white spaces
                 */
                row = row.trim();
                const value = row.split(/\s+/)[index];
                if (this.column_formats[index].includes('s')) {
                    return value;
                } else if (this.column_formats[index].includes('d')) {
                    return parseInt(value);
                } else {
                    return parseFloat(value);
                }
            });
        });
    };

    /**
     * Class method to process a peaks.list file from Sparky
     */
    process_peaks_list(peaks_list) {
        /**
         * Clear all data first
         */
        this.clear_all_data();

        const lines = peaks_list.split('\n');

        let b_header = false;

        /**
         * Check all lines for header line and data lines
         */
        lines.forEach((line) => {
            /**
             * Trim and split the line by white spaces
             */
            let parts = line.trim().split(/\s+/);
            /**
             * Check if the line is a header line (contain w2 and w1)
             */
            if (b_header == false && parts.includes('w2') && parts.includes('w1')) {
                this.column_headers = parts;
                /**
                 * Assign column formats based on the header,
                 * w2 and w1 are %10.4f, Assignment is %s and height is %e
                 * other columns are %s
                 */
                this.column_formats = parts.map((header) => {
                    if (header === 'w2' || header === 'w1') {
                        return '%10.4f';
                    } else if (header === 'Assignment') {
                        return '%s';
                    } else if (header === 'height') {
                        return '%e';
                    } else {
                        return '%s';
                    }
                });
                b_header = true;
                this.columns =[];
                for(let i=0;i<this.column_headers.length;i++)
                {
                    this.columns.push([]);
                }
            }
            else if (b_header === true) {
                /**
                 * only when the header line is found, process the data lines
                 * and only process as data line when number of parts is the same as number of headers
                 */
                if (parts.length === this.column_headers.length) {
                    for (let i = 0; i < this.column_headers.length; i++) {
                        if (this.column_formats[i].includes('s')) {
                            this.columns[i].push(parts[i]);
                        }
                        else if (this.column_formats[i].includes('f')) {
                            this.columns[i].push(parseFloat(parts[i]));
                        }
                        else if (this.column_formats[i].includes('e')) {
                            this.columns[i].push(parseFloat(parts[i]));
                        }
                    }
                }
            }
        });

        /**
         * Sort this.column_headers according to the order of w2 < w1 < height < Assignment
         * Keep track of the original index of each column header
         * Note not necessary all column headers are present
         */
        let original_indexes = this.column_headers.map((header, index) =>{ return { header, index };});
        original_indexes.sort((a, b) => {
            let order = ['w2', 'w1', 'height', 'Assignment'];
            return order.indexOf(a.header) - order.indexOf(b.header);
        });

        /**
         * Apply the sorting to this.column_headers, this.column_formats, and this.columns
         */
        this.column_headers = original_indexes.map((item) => this.column_headers[item.index]);
        this.column_formats = original_indexes.map((item) => this.column_formats[item.index]);
        this.columns = original_indexes.map((item) => this.columns[item.index]);

        /**
         * Change header "Assignment" to "ASS", "w1" to "Y_PPM", "w2" to "X_PPM", and Height to HEIGHT
         */
        
        this.column_headers = this.column_headers.map(item => {
            if (item == "Assignment") {
                return "ASS";
            }
            else if (item == "w1") {
                return "Y_PPM";
            }
            else if (item == "w2") {
                return "X_PPM";
            }
            else if (item == "Height") {
                return "HEIGHT";
            }
            else {
                return item;
            }
        });

        /**
         * Add a column_headers at the beginning, "INDEX", column_formats is "%5d"
         * and column values is 1,2,3,4
         */
        this.column_headers.unshift("INDEX");
        this.column_formats.unshift("%5d");
        let index_array=[];
        for(let i=0;i<this.columns[0].length;i++)
        {
            index_array.push(i);
        }
        this.columns.unshift(index_array);
        return;
    }

    /**
     * A class method to change all values in a column by add,sub,mul,div a value.
     * @param {string} column_header_name - the column header name
     * @param {string} operation - the operation to be performed: add, sub, mul, div
     * @param {number} value - the value to be added, subtracted, multiplied, or divided
     * @return {boolean} - true if the column is successfully changed, false if the column is not found, not a number, or the operation is invalid
     */
    change_column(column_header_name, operation, value) {
        let index = this.column_headers.indexOf(column_header_name);
        if (index === -1) {
            return false;
        }
        if (isNaN(value)) {
            return false;
        }

        /**
         * Check column_formats[index] to determine the type of the column, must be float or integer
         */
        if (this.column_formats[index].includes('s')) {
            return false;
        }

        if (operation === 'add') {
            this.columns[index] = this.columns[index].map(x => x + value);
        } else if (operation === 'sub') {
            this.columns[index] = this.columns[index].map(x => x - value);
        } else if (operation === 'mul') {
            this.columns[index] = this.columns[index].map(x => x * value);
        } else if (operation === 'div') {
            this.columns[index] = this.columns[index].map(x => x / value);
        } else {
            return false;
        }
        return true;
    }

    /**
     * Get values from a column, as an array
     */
    get_column(column_header_name) {
        let index = this.column_headers.indexOf(column_header_name);
        if (index === -1) {
            return [];
        }
        return this.columns[index];
    };

    /**
     * Copy all data from another peaks object
     */
    copy_data(peaks) {
        this.comments = peaks.comments;
        this.column_headers = peaks.column_headers;
        this.column_formats = peaks.column_formats;
        this.columns = peaks.columns;
    }

    /**
     * Get a array of json objects, each object is a row of the peaks object with only selected columns
     * @param {string[]} column_header_names - the column header names to be selected
     */
    get_selected_columns(column_header_names) {
        let indexes = column_header_names.map(header => this.column_headers.indexOf(header));
        let result = [];
        for (let i = 0; i < this.columns[0].length; i++) {
            let row = {};
            for (let j = 0; j < indexes.length; j++) {
                if (indexes[j] === -1) {
                    continue;
                }
                row[column_header_names[j]] = this.columns[indexes[j]][i];
            }
            result.push(row);
        }
        return result;
    }

    /**
     * Get a column as a array, using colomn header name
     */
    get_column_by_header(column_header_name) {
        let index = this.column_headers.indexOf(column_header_name);
        if (index === -1) {
            return [];
        }
        return this.columns[index];
    }

    /**
     * Filter a column by a range of values
     * then apply the filter to all columns
     */
    filter_by_column_range(column_header_name, min_value, max_value) {
        let index = this.column_headers.indexOf(column_header_name);
        if (index === -1) {
            return false;
        }
        if (isNaN(min_value) || isNaN(max_value)) {
            return false;
        }
        const indexes = this.columns[index].map((value, index) => (value >= min_value && value <= max_value) ? index : -1)
            .filter((index) => index !== -1);

        /**
         * Apply the filter to all columns
         */
        this.columns = this.columns.map((column) => indexes.map((index) => column[index]));
    }

    /**
     * Filter by several columns by a range of values (must fulfill all conditions)
     * @param {*} column_header_names 
     * @param {*} min_values 
     * @param {*} max_values 
     * @param {bool} b_keep: true to keep the rows that fulfill the conditions, false to remove them
     * @return {bool} - true if the filter is successfully applied, false if the columns are not found, not a number, or the operation is invalid
     */
    filter_by_columns_range(column_header_names, min_values, max_values, b_keep = true) {
        let indexes = column_header_names.map(header => this.column_headers.indexOf(header));
        if (indexes.includes(-1)) {
            return false;
        }
        if (min_values.length !== indexes.length || max_values.length !== indexes.length) {
            return false;
        }
        if (min_values.some(isNaN) || max_values.some(isNaN)) {
            return false;
        }

        for (let i = this.columns[0].length - 1; i >= 0; i--) {
            let b_fulfill = true;
            for (let j = 0; j < indexes.length; j++) {
                if (this.columns[indexes[j]][i] < min_values[j] || this.columns[indexes[j]][i] > max_values[j]) {
                    b_fulfill = false;
                    break;
                }
            }

            if (b_fulfill === false && b_keep === true) {
                for (let j = 0; j < this.columns.length; j++) {
                    this.columns[j].splice(i, 1);
                }
            }
            else if (b_fulfill === true && b_keep === false) {
                for (let j = 0; j < this.columns.length; j++) {
                    this.columns[j].splice(i, 1);
                }
            }
        }
        return true;
    }

    /**
     * Remove a row by column with header named "INDEX"
     * @param {number} index - the index of the row to be removed
     */
    remove_row(index) {
        let index_index = this.column_headers.indexOf('INDEX');
        if (index_index === -1) {
            return false;
        }
        let row_index = this.columns[index_index].indexOf(index);
        if (row_index === -1) {
            return false;
        }
        for (let i = 0; i < this.columns.length; i++) {
            this.columns[i].splice(row_index, 1);
        }
        return true;
    }

    /**
     * Update X_PPM and Y_PPM of a row, from index (value of the column with header "INDEX")
     */
    update_row(index, x_ppm, y_ppm) {
        let index_index = this.column_headers.indexOf('INDEX');
        if (index_index === -1) {
            return false;
        }
        let row_index = this.columns[index_index].indexOf(index);
        if (row_index === -1) {
            return false;
        }
        let x_ppm_index = this.column_headers.indexOf('X_PPM');
        let y_ppm_index = this.column_headers.indexOf('Y_PPM');
        if (x_ppm_index === -1 || y_ppm_index === -1) {
            return false;
        }
        this.columns[x_ppm_index][row_index] = x_ppm;
        this.columns[y_ppm_index][row_index] = y_ppm;
        return true;
    }

    /**
     * Add a row to the peaks object from a json object
     * {X_PPM: x_ppm,Y_PPM: y_ppm, HEIGHT: data_height};
     * INDEX will be 10000, 10001, 10002, etc.
     * Set X_PPM and Y_PPM and HEIGHT columns to the values in the json object
     * For others:
     * For number columns, set to median value of the column
     * For string columns, set to the first value of the column
     */
    add_row(new_row) {
        let index = this.column_headers.indexOf('INDEX');
        if (index === -1) {
            return false;
        }
        let new_index = this.manual_peak_index;
        this.manual_peak_index += 1;
        this.columns[index].push(new_index);
        for (let i = 0; i < this.column_headers.length; i++) {
            if (this.column_headers[i] === 'INDEX') {
                continue;
            }
            else if (this.column_headers[i] === 'X_PPM') {
                this.columns[i].push(new_row.X_PPM);
            }
            else if (this.column_headers[i] === 'Y_PPM') {
                this.columns[i].push(new_row.Y_PPM);
            }
            else if (this.column_headers[i] === 'HEIGHT') {
                this.columns[i].push(new_row.HEIGHT);
            }
            else if (this.column_formats[i].includes('s')) {
                this.columns[i].push(this.columns[i][0]);
            }
            else {
                this.columns[i].push(this.columns[i].reduce((a, b) => a + b, 0) / this.columns[i].length);
            }
        }
        return true;
    }

    /**
     * Class method to save the peaks object as a peaks.tab file (nmrPipe format)
     */
    save_peaks_tab() {
        let peaks_tab = '';
        peaks_tab += this.comments.join('\n') + '\n';
        peaks_tab += 'VARS ' + this.column_headers.join(' ') + '\n';
        peaks_tab += 'FORMAT ' + this.column_formats.join(' ') + '\n';
        for (let i = 0; i < this.columns[0].length; i++) {
            let row = '';
            for (let j = 0; j < this.columns.length; j++) {

                /**
                 * If this.columns[j][i] is null
                 * or is a number and is NaN, set it to 0
                 */
                if (this.columns[j][i] === null || (typeof this.columns[j][i] === 'number' && isNaN(this.columns[j][i])))
                {
                    this.columns[j][i] = 0;
                }

                /**
                 * Simulate a c++ sprintf function to format the value according to column_formats[j]
                 */
                if (this.column_formats[j].includes('s')) {
                    row += this.columns[j][i].toString().padEnd(parseInt(this.column_formats[j]), ' ');
                }
                else if (this.column_formats[j].includes('d')) {
                    /**
                     * Get the number from a string like %4d
                     */
                    let num = parseInt(this.column_formats[j].substring(1, this.column_formats[j].length - 1));
                    row += this.columns[j][i].toFixed(0).padStart(num, ' ');
                }
                else if (this.column_formats[j].includes('f')) {
                    /**
                     * Get number of decimal places from column_formats[j].
                     * First get %5.3f to 5.3
                     * Use toFixed to format the number to that many decimal places
                     */
                    let num = this.column_formats[j].substring(1, this.column_formats[j].length - 1);
                    let decimal_places = 3;
                    let width = 6;
                    /**
                     * num could be 7.3, or 7, or empty
                     */
                    if (num.includes('.')) {
                        decimal_places = parseInt(num.split('.')[1]);
                        width = parseInt(num.split('.')[0]);
                    }
                    else if(num.length === 0) {
                        /**
                         * If format is %f, set default to 6.3f decimal places
                         */
                        decimal_places = 3;
                        width = 6;
                    }
                    else{
                        /**
                         * If format is %7f, set decimal to 7-3, but must >=1
                         */
                        width = parseInt(num);
                        decimal_places = width - 3;
                        if (decimal_places < 1) {
                            decimal_places = 1;
                        }
                    }
                    row += this.columns[j][i].toFixed(decimal_places).padStart(width, ' ');
                }
                else if (this.column_formats[j].includes('e')) {
                    /**
                     * Get number of decimal places from column_formats[j]
                     * Use toExponential to format the number to that many decimal places
                     */
                    let decimal_places = 6;  //default if not specified
                    let number = this.column_formats[j].substring(1, this.column_formats[j].length - 1);
                    if (number.includes('.')) {
                        decimal_places = number.split('.')[1];
                    }
                    let str = this.columns[j][i].toExponential(decimal_places);
                    /**
                     * Per C++ sprintf, if there is only single digit after the e+ or e-, add a zero
                     */
                    if (str.includes('e+')) {
                        let num = str.split('e+')[1];
                        if (num.length === 1) {
                            str = str.replace('e+', 'e+0');
                        }
                    }
                    if (str.includes('e-')) {
                        let num = str.split('e-')[1];
                        if (num.length === 1) {
                            str = str.replace('e-', 'e-0');
                        }
                    }

                    row += str;
                }
                else {
                    /**
                     * If column format is not recognized, just pad the value with spaces
                     */
                    row += this.columns[j][i].toString() + ' ';
                }
                /**
                 * Add a space between columns, except for the last column
                 */
                if (j < this.columns.length - 1) {
                    row += ' ';
                }
            }
            peaks_tab += row + '\n';
        }
        return peaks_tab;
    }

    /**
     * Function to run DOSY fitting on all peaks (pseudo 3D peak list only, with Z_A1, Z_A2, Z_A3 ... columns)
     * This function will add a column "DOSY" to the peaks object, with the fitted DOSY value for each peak
     */
    run_dosy_fitting(gradients,scale_constant = 1.0) {

        /**
         * Save gradients and scale constant as properties of the peaks object
         * for future reference
         */
        this.gradients = gradients;
        this.scale_constant = scale_constant;

        /**
         * Get total # of Z_A1, Z_A2, Z_A3 ... columns, which must == gradients.length
         */
        let z_columns = this.column_headers.filter(header => header.startsWith('Z_A'));
        if (z_columns.length !== gradients.length) {
            return {
                message: 'Number of Z_A columns does not match the number of gradients',
                result: false
            };
        }
        /**
         * Get a 2D array of Z_A values, each row is a peak, each column is a Z_A value. 
         * The array should be row-major, for optimal performance in the fitting function
         * Step 1, get column indexes of Z_A columns
         */
        let z_column_indexes = z_columns.map(header => this.column_headers.indexOf(header));
        /**
         * Step 2, get the Z_A values for each peak
         */
        for(var i = 0; i < this.columns[0].length; i++) {
            let z_values = z_column_indexes.map(index => this.columns[index][i]);
            /**
             * Step 3, run the fitting function to get the DOSY value
             */
            let dosy_value = this.dosy_fitting_core(z_values, gradients);
            /**
             * Step 4, add the DOSY value to the peaks object
             */
            if (i === 0) {
                this.column_headers.push('DOSY');
                this.column_formats.push('%6.4e');
                this.columns.push([]);
            }
            this.columns[this.column_headers.indexOf('DOSY')].push(-dosy_value.slope*scale_constant);
        }
        return {
            message: 'DOSY fitting completed successfully',
            result: true,
        };
    }

    /**
     * Dosy fitting function to calculate the DOSY value from the Z_A values and gradients
     * I=I0*exp(-D*G^2), so D = -ln(I/I0)/G^2, so we can get D from a linear fit of -ln(I) vs G^2
     */
    dosy_fitting_core(z_values, gradients) {
        /**
         * Step 1, get the natural log of the Z_A values.
         * z[0] is always 1.0, and z becomes smaller as the gradient increases
         */
        let ln_z = z_values.map(z => Math.log(z));
        /**
         * Step 2, get the square of the gradients
         */
        let g_squared = gradients.map(g => g * g);
        /**
         * Step 3, perform a linear fit of ln_z vs g_squared to get the slope while forcing the intercept to be 0
         */
        let result = linearRegressionNoIntercept(g_squared, ln_z);
        /**
         * Step 4, calculate the DOSY value from the slope
         */
        return result; //object with two properties: slope and y_pre
    }
};
