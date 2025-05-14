

/**
 * Define a spectrum_1d class to hold all spectrum_1d information
 * Example of levels_length, polygon_length and points
 * levels_length=[0,3,5] means there are 2 levels, first level has 3 polygons, second level has 2 polygons: total 5 polygons
 * polygon_length=[0,3,6,8,14,16] means there are 5 polygons, first polygon has 3 points,
 * second polygon has 3 points, third polygon has 2 points, fourth polygon has 6 points, fifth polygon has 2 points: total 16 points
 * points=[x1,y1,x2,y2,x3,y3,x4,y4,x5,y5,x6,y6,x7,y7,x8,y8,x9,y9,x10,y10,x11,y11,x12,y12,x13,y13,x14,y14,x15,y15,x16,y16]
 * 
 * In case we have more than one contour plots (overlay of two contour plots),
 * we will have overlays= [0, 2, 4] means there are 2 overlayed contour plots
 * first plot has 2 levels, second plot has 2 levels in the levels_length array
 * if overlays =[] means all levels are in one plot (no overlay), this is the default, equal to [0, levels_length.length]
 */
class spectrum_1d {
    constructor() {
        this.spectrum_format = "ft1"; //ft2 is the default format
        this.header = new Float32Array(512); //header of the spectrum_1d, 512 float32 numbers
        this.raw_data = new Float32Array(0); //raw data, real real
        this.raw_data_i = new Float32Array(0); //raw data for real (along indirect dimension) and imaginary (along indirect dimension) part
        this.noise_level = 0.001; //noise level of the input spectrum_1d
        this.spectral_max = Number.MAX_VALUE; //maximum value of the spectrum_1d
        this.n_direct = 4096; //size of direct dimension of the input spectrum_1d. integer
        this.x_ppm_start = 12.0; //start ppm of direct dimension
        this.x_ppm_width = 12.0; //width of direct dimension
        this.x_ppm_step = -12.0 / 4096; //step of direct dimension
        this.x_ppm_ref = 0.0; //reference ppm of direct dimension
        this.frq1 = 850.0; //spectrometer frequency of direct dimension
        this.picked_peaks_object = new cpeaks(); //picked peaks object
        this.fitted_peaks_object = new cpeaks(); //fitted peaks object
        /**
         * spectrum_1d origin: 
         * -4: unknown,
         * -3" removed spectrum
         * -2: experimental spectrum from fid, 
         * -1: experimental spectrum uploaded,  
         * n(n>=0 and n<10000): reconstructed from experimental spectrum n
         * n(n>=10000): pseudo 3D spectrum, whose first plane spectrum is n-10000
         */
        this.spectrum_origin = -4;

        this.reconstructed_indices = []; //array of reconstructed spectra indices.

        this.spectrum_index = -1; //index of the spectrum in the hsqc_spectra array. integer and >=0

        /**
         * Default median sigmax, sigmay, gammax, gammay
         */
        this.median_sigmax = 1.0;
        this.median_gammax = 1.0;

        /**
         * Control the display of the spectrum
         */
        this.visible = true; //visible or not

        /**
         * fid process parameters is only valid when spectrum_origin is -2 (from fid)
         * and it is the first plane (of a pseudo 3D spectrum if it is a pseudo 3D fid)
         */
        this.fid_process_parameters = null;

        this.mathTool  = new ldwmath();
    };

    /**
     * Function to create a shallow copy of the spectrum object
     * Keep all the properties, except header, raw_data, raw_data_ri, raw_data_ir, raw_data_ii (Float32Array)
     * And add new properties: header_length, raw_data_length, raw_data_ri_length, raw_data_ir_length, raw_data_ii_length
     * which are the length of the corresponding Float32Array
     */
    create_shallow_copy_wo_float32() {
        let new_spectrum = new Object();
        for(var key in this) {
            if (this.hasOwnProperty(key)) {
                if (key === "header" || key === "raw_data" || key === "raw_data_i") {
                    new_spectrum[key + "_length"] = this[key].length;
                }
                else {
                    new_spectrum[key] = this[key];
                }
            }
        }
        return new_spectrum;
    };


    update_x_ppm_ref(x_ppm_ref) {
        let delta_ppm = x_ppm_ref - this.x_ppm_ref;
        this.x_ppm_ref = x_ppm_ref;
        this.header[101] += delta_ppm * this.frq1;
        this.ref1 = this.header[101];

         /**
         * Update peaks as well if there are any
         */
         if (this.picked_peaks_object != null) {
            this.picked_peaks_object.update_x_ppm_ref(delta_ppm);
        }
        if (this.fitted_peaks_object != null) {
            this.fitted_peaks_object.update_x_ppm_ref(delta_ppm);
        }
    };


    /**
     * Process the raw file data of a 2D FT spectrum (.txt from Topspin totxt command)
     * @param {*} file_text: raw file data as a string
     * @param {*} file_name: name of the file
     * @param {*} field_strength: field strength of the spectrometer
     * Note: for topspin file, spectrum_origin is always -1 (user uploaded frequency file)
     *  
     */
    process_topspin_file(file_text, file_name, field_strength) {

        this.spectrum_format = "Topspin"
        this.spectrum_origin = -1;
        this.filename = file_name;


        let lines = file_text.split(/\r\n|\n/);

        /**
         * Loop all lines
         * 1. find line contained both "F1LEFT" and "F1RIGHT" to get the x_ppm_start and x_ppm_width
         * 2. find line contained both "F2LEFT" and "F2RIGHT" to get the y_ppm_start and y_ppm_width
         * 3. find line contained NROWS to get the n_indirect
         * 4. find line contained NCOLS to get the n_direct
         * Quit the loop if all 4 values are found. 
         */
        let number_of_info_retrieved = 0;
        let data_start = 0;
        this.n_direct = undefined;
        this.n_indirect = undefined;
        this.x_ppm_start = undefined;
        this.y_ppm_start = undefined;
        this.x_ppm_width = undefined;
        this.y_ppm_width = undefined;
        for (let i = 0; i < lines.length; i++) {
            if (lines[i].includes("F1LEFT") && lines[i].includes("F1RIGHT")) {
                /**
                 * Separate the line by any number of space(s) and get the location of F1LEFT and F1RIGHT
                 */
                let temp = lines[i].split(/\s+/); //split by any number of space(s)
                let left = temp.indexOf("F1LEFT");
                let right = temp.indexOf("F1RIGHT");
                this.y_ppm_start = parseFloat(temp[left + 2]);
                this.y_ppm_width = parseFloat(temp[right + 2]) - parseFloat(temp[left + 2]);
                number_of_info_retrieved++;
            }
            if (lines[i].includes("F2LEFT") && lines[i].includes("F2RIGHT")) {
                let temp = lines[i].split(/\s+/);
                let left = temp.indexOf("F2LEFT");
                let right = temp.indexOf("F2RIGHT");
                this.x_ppm_start = parseFloat(temp[left + 2]);
                this.x_ppm_width = parseFloat(temp[right + 2]) - parseFloat(temp[left + 2]);
                number_of_info_retrieved++;
            }
            if (lines[i].includes("NROWS")) {
                let temp = lines[i].split(/\s+/);
                let location = temp.indexOf("NROWS");
                this.n_indirect = parseInt(temp[location + 2]);
                number_of_info_retrieved++;
            }
            if (lines[i].includes("NCOLS")) {
                let temp = lines[i].split(/\s+/);
                let location = temp.indexOf("NCOLS");
                this.n_direct = parseInt(temp[location + 2]);
                number_of_info_retrieved++;
            }
            if (number_of_info_retrieved >= 4 && this.n_direct !== undefined && this.n_indirect !== undefined && this.x_ppm_start !== undefined && this.y_ppm_start !== undefined) {
                number_of_info_retrieved = -1; //this is a flag to show that we have found all 4 values
                data_start = i + 1;
                break;
            }
        }

        if (number_of_info_retrieved !== -1) {
            this.error = "Cannot find all necessary information in the file";
            return result;
        }

        /**
         * Loop remaining lines to get the data
         */
        this.raw_data = new Float32Array(this.n_direct * this.n_indirect);
        let col_counter = 0;
        let row_counter = 0;
        for (let i = data_start; i < lines.length; i++) {
            /**
             * If line start with "# row = ", this is a start of a new row, we reset column counter to 0
             * and get row counter from the line immediately after "# row = "
             */
            if (lines[i].startsWith("# row = ")) {
                col_counter = 0;
                row_counter = parseInt(lines[i].substring(8));
                continue;
            }
            /**
             * Other lines start with # are comments, we skip them
             * and also skip empty lines
             */
            else if (lines[i].startsWith("#") || lines[i] === "") {
                continue;
            }
            /**
             * Others are data line, only one number per line in Topspin totxt format
             */
            else {
                this.raw_data[row_counter * this.n_direct + col_counter] = parseFloat(lines[i]);
                col_counter++;
            }
        }

        /**
         * At the end, we should have col_counter = this.n_direct and row_counter = this.n_indirect-1
         */
        if (col_counter !== this.n_direct || row_counter !== this.n_indirect - 1) {
            this.error = "Cannot find all data in the file";
            return result;
        }

        /**
         * Make x_ppm_width and y_ppm_width positive.
         * Set this.x_ppm_step and this.y_ppm_step. Note that the ppm_step is negative
         */
        this.x_ppm_width = Math.abs(this.x_ppm_width);
        this.y_ppm_width = Math.abs(this.y_ppm_width);
        this.x_ppm_step = -this.x_ppm_width / this.n_direct;
        this.y_ppm_step = -this.y_ppm_width / this.n_indirect;

        /**
         * Set default ref to 0
         */
        this.x_ppm_ref = 0;
        this.y_ppm_ref = 0;

        /**
         * Noise level, spectral_max and min, projection, levels, negative_levels code.
         */
        this.process_spectrum_common_task();

        /**
         * Setup a fake nmrPipe header, so that we can use the same code to 
         * run DEEP_Picker, VoigtFit, etc.
         */
        this.header = new Float32Array(512); //empty array
        this.header[0] = 0.0; //magic number for nmrPipe header

        this.header[99] = this.n_direct; //size of direct dimension of the input spectrum
        this.header[219] = this.n_indirect; //size of indirect dimension of the input spectrum
        this.header[221] = 0; // not transposed
        this.header[56] = 1; //real data along both dimensions
        this.header[55] = 1; //real data along both dimensions

        this.header[24] = 2; //direct dimension is the second dimension
        this.header[25] = 1; //indirect dimension is the first dimension

        
        this.header[220] = 1; // frequency domain data (1 for frequency domain, 0 for time domain), indirect dimension
        this.header[222] = 1; // frequency domain data (1 for frequency domain, 0 for time domain), direct dimension

        /**
         * Suppose filed strength is 850 along direct dimension
         * and indirection dimension obs is 85.0
         */
        this.header[119] = field_strength; //observed frequency of direct dimension
        this.header[218] = 85.0; //observed frequency of indirect dimension

        this.header[100] = this.x_ppm_width * field_strength; //spectral width of direct dimension
        this.header[229] = this.y_ppm_width * 85.0; //spectral width of indirect dimension

        /**
         * Per topspin convention, First point is inclusive, last point is exclusive in [ppm_start, ppm_start+ppm_width)]
         * Notice x_ppm_step and y_ppm_step are negative
         */
        this.header[101] = (this.x_ppm_start - this.x_ppm_width - this.x_ppm_step) * field_strength; //origin of direct dimension (last point frq in Hz)
        this.header[249] = (this.y_ppm_start - this.y_ppm_width - this.y_ppm_step) * 85.0; //origin of indirect dimension (last point frq in Hz)
        this.ref1 = this.header[101];
        this.ref2 = this.header[249];

        /**
         * We did not fill carrier frequency, because we do not need it for DEEP_Picker, VoigtFit, etc.
         * They are needed in fid processing, not in spectrum processing.
         */

        this.frq1 = this.header[119];
        this.frq2 = this.header[218];

    };


    /**
     * Process the raw file data of a 1D FT spectrum (nmrPipe .ft1 format)
     * @param {arrayBuffer} arrayBuffer: raw file data
     * @param {string} file_name: name of the file
     * @param {string} spectrum_origin: index to origin of the spectrum for reconstructed spectra, -1 for ft2, -2 for FID and -3 for removed spectra
     * @returns hsqc_spectra object
     */
    process_ft_file(arrayBuffer, file_name, spectrum_origin) {


        this.spectrum_format = "ft1";

        this.spectrum_origin = spectrum_origin;

        this.header = new Float32Array(arrayBuffer, 0, 512);

        this.n_direct = this.header[99]; //size of direct dimension of the input spectrum
        this.n_indirect = this.header[219]; //size of indirect dimension of the input spectrum (must be 1 for 1D spectrum)

       
        /**
         * Datatype of the direct and indirect dimension
         * 0: complex
         * 1: real
         */
        this.datatype_direct = this.header[56];

        /**
         * this.datatype_direct: 1 means real, 0 means complex
         * this.datatype_indirect: 1 means real, 0 means complex
         */
        if (this.datatype_direct == 0 ) {
            console.log("Complex data ");
        }
       
        else if (this.datatype_direct == 1) {
            console.log("Real data ");
        }
        console.log("n_direct: ", this.n_direct);

        this.direct_ndx = 2;
        
        /**
         * this.sw, this.frq,this.ref are the spectral width, frequency and reference of the direct dimension
         * All are array of length 4
         */
        this.sw = [];
        this.frq = [];
        this.ref = [];

        this.sw[0] = this.header[229];
        this.sw[1] = this.header[100];
        this.sw[2] = this.header[11];
        this.sw[3] = this.header[29];

        this.frq[0] = this.header[218];
        this.frq[1] = this.header[119];
        this.frq[2] = this.header[10];
        this.frq[3] = this.header[28];

        this.ref[0] = this.header[249];
        this.ref[1] = this.header[101];
        this.ref[2] = this.header[12];
        this.ref[3] = this.header[30];

        /**
         * Get ppm_start, ppm_width, ppm_step for both direct and indirect dimensions
         */
        this.sw1 = this.sw[this.direct_ndx - 1];
        this.frq1 = this.frq[this.direct_ndx - 1];
        this.ref1 = this.ref[this.direct_ndx - 1];


        this.x_ppm_start = (this.ref1 + this.sw1) / this.frq1;
        this.x_ppm_width = this.sw1 / this.frq1;
        this.x_ppm_step = -this.x_ppm_width / this.n_direct;

        /**
         * shift by half of the bin size because the contour plot is defined by the center of each bin
         */
        this.x_ppm_start -= this.x_ppm_width / this.n_direct / 2;

        this.x_ppm_ref = 0.0;

        const spectral_data = new Float32Array(arrayBuffer);

        let data_size = arrayBuffer.byteLength / 4 - 512;

        /**
         * Let assess data_size, if it is not equal to n_direct * n_indirect * number_of_data_type, set error and return
         * number_of_data_type =1, if  real
         * number_of_data_type =2, if complex
         */
        let data_size_per_point = 1;
        if (this.datatype_direct === 1) {
            data_size_per_point = 1;
        }
        else if (this.datatype_direct === 0 ) {
            data_size_per_point = 2;
        }
        

        if (data_size !== this.n_direct *  data_size_per_point) {
            this.error = "Data size does not match the size of the spectrum";
        }

        /**
         * this.raw_data is a Float32Array of the spectrum data, real (along indirect) real (along direct)
         * this.raw_data_ri is a Float32Array of the spectrum data, real (along indirect) imaginary (along direct)
         * this.raw_data_ir is a Float32Array of the spectrum data, imaginary (along indirect) real (along direct)
         * this.raw_data_ii is a Float32Array of the spectrum data, imaginary (along indirect) imaginary (along direct)
         * 
         * They are all row major, size is  n_indirect (rows) * n_direct (columns).
         * Order of data in arrayBuffer, after the 512 float (4 bytes) header
         * raw_data row1, raw_data_ri row1, raw_data_ir row1, raw_data_ii row1, 
         * raw_data row2, raw_data_ri row2, raw_data_ir row2, raw_data_ii row2, ...
         */
        let current_position = 512;

        /**
         * Initialize this.raw_data, this.raw_data_ri, this.raw_data_ir, this.raw_data_ii
         * If no initialization here, it will have default size of 0 (empty array)
         */
        this.raw_data = new Float32Array(this.n_direct);
        if (this.datatype_direct === 0) {
            this.raw_data_i = new Float32Array(this.n_direct);
        }



        this.raw_data.set(spectral_data.subarray(current_position, current_position + this.n_direct), 0);
        current_position += this.n_direct;

        if (this.datatype_direct === 0) {
            this.raw_data_i.set(spectral_data.subarray(current_position, current_position + this.n_direct), 0);
        }
            

        /**
         * Keep original file name
         */
        this.filename = file_name;
        this.noise_level = this.mathTool.estimate_noise_level_1d(this.n_direct,this.raw_data);
        [this.spectral_max, this.spectral_min] = this.mathTool.find_max_min(this.raw_data);

    };

};