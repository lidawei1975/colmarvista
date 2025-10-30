

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
        this.baseline = new Float32Array(0); //baseline data, same size as raw_data
        this.raw_data_i = new Float32Array(0); //raw data for real (along indirect dimension) and imaginary (along indirect dimension) part
        this.noise_level = 0.001; //noise level of the input spectrum_1d
        this.spectral_max = Number.MAX_VALUE; //maximum value of the spectrum_1d
        this.n_direct = 4096; //size of direct dimension of the input spectrum_1d. integer
        this.n_indirect = 1; //size of indirect dimension of the input spectrum_1d. integer, must be 1 for 1D spectrum
        this.x_ppm_start = 12.0; //start ppm of direct dimension
        this.x_ppm_width = 12.0; //width of direct dimension
        this.x_ppm_step = -12.0 / 4096; //step of direct dimension
        this.x_ppm_ref = 0.0; //reference ppm of direct dimension
        this.frq1 = 850.0; //spectrometer frequency of direct dimension
        this.datatype_direct = 1; //datatype of direct dimension, 1 for real, 0 for complex
        this.picked_peaks_object = new cpeaks(); //picked peaks object
        this.fitted_peaks_object = new cpeaks(); //fitted peaks object
        this.spectrum_scale = 1.0; //scale factor to scale the spectrum for display purpose
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
                if (key == "fid_process_parameters")
                {
                    // do not copy fid_process_parameters, it is not needed in the copied spectrum
                }
                else if (key === "header" || key === "raw_data" || key === "raw_data_i") {
                    new_spectrum[key + "_length"] = this[key].length;
                }
                else {
                    new_spectrum[key] = this[key];
                }
            }
        }

        /**
         * if spectrum_origin is -2 (from fid), change it to -1 (user uploaded frequency file)
         * Because we removed the fid_process_parameters, which is only valid when spectrum_origin is -2
         */
        if (new_spectrum.spectrum_origin === -2) {
            new_spectrum.spectrum_origin = -1;
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
        this.n_indirect = 1;
        this.x_ppm_start = undefined;
        this.y_ppm_start = undefined;
        this.x_ppm_width = undefined;
        this.y_ppm_width = undefined;
        for (let i = 0; i < lines.length; i++) {
            if (lines[i].includes("LEFT") && lines[i].includes("RIGHT")) {
                /**
                 * Separate the line by any number of space(s) and get the location of F1LEFT and F1RIGHT
                 */
                let temp = lines[i].split(/\s+/); //split by any number of space(s)
                let left = temp.indexOf("LEFT");
                let right = temp.indexOf("RIGHT");
                this.x_ppm_start = parseFloat(temp[left + 2]);
                this.x_ppm_width = parseFloat(temp[right + 2]) - parseFloat(temp[left + 2]);
                number_of_info_retrieved++;
            }
            if (lines[i].includes("SIZE")) {
                let temp = lines[i].split(/\s+/);
                let location = temp.indexOf("SIZE");
                this.n_direct = parseInt(temp[location + 2]);
                number_of_info_retrieved++;
            }
            if (number_of_info_retrieved >= 2 && this.n_direct !== undefined && this.x_ppm_start !== undefined ) {
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
        for (let i = data_start; i < lines.length; i++) {
            if (lines[i].startsWith("#") || lines[i] === "") {
                continue;
            }
            /**
             * Others are data line, only one number per line in Topspin totxt format
             */
            else {
                this.raw_data[col_counter] = parseFloat(lines[i]);
                col_counter++;
            }
        }

        /**
         * Make x_ppm_width and y_ppm_width positive.
         * Set this.x_ppm_step and this.y_ppm_step. Note that the ppm_step is negative
         */
        this.x_ppm_width = Math.abs(this.x_ppm_width);
        this.x_ppm_step = -this.x_ppm_width / this.n_direct;

        /**
         * Set default ref to 0
         */
        this.x_ppm_ref = 0;

        /**
         * Noise level, spectral_max and min, projection, levels, negative_levels code.
         */
        this.filename = file_name;
        this.noise_level = this.mathTool.estimate_noise_level_1d(this.n_direct,this.raw_data);
        [this.spectral_max, this.spectral_min] = this.mathTool.find_max_min(this.raw_data);

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

    process_ft_file_type2(header,spectral_data, file_name, spectrum_origin) {
        
        this.header=header;

        this.spectrum_format = "ft1";

        this.spectrum_origin = spectrum_origin;


        this.n_direct = this.header[99]; //size of direct dimension of the input spectrum
        this.n_indirect = this.header[219]; //size of indirect dimension of the input spectrum (must be 1 for 1D spectrum)

       
        /**
         * Datatype of the direct and indirect dimension
         * 0: complex
         * 1: real
         */
        this.header[56] =1;
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

        /**
         * Initialize this.raw_data, this.raw_data_ri, this.raw_data_ir, this.raw_data_ii
         * If no initialization here, it will have default size of 0 (empty array)
         */
        this.raw_data = spectral_data;
        

        /**
         * Keep original file name
         */
        this.filename = file_name;
        this.noise_level = this.mathTool.estimate_noise_level_1d(this.n_direct,this.raw_data);
        [this.spectral_max, this.spectral_min] = this.mathTool.find_max_min(this.raw_data);

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

    
    process_sparky_file(arrayBuffer, file_name, spectrum_origin) {

        /**
         * Get the 11th bytes and convert to integer (one byte integer). 
         */
        let n_dim = new Int8Array(arrayBuffer, 10, 1)[0];
        let n_complicity = new Int8Array(arrayBuffer, 11, 1)[0]; // 1: real, 0: complex
        // let n_version = new Int8Array(arrayBuffer, 13, 1)[0]; 

        /**
         * Make sure n_dim is 2 and n_complicity is 1 (real)
         */
        if (n_dim !== 1 || n_complicity !== 1) {
            console.log('n_dim: ', n_dim, 'n_complicity: ', n_complicity, 'n_version: ', n_version, ' . Only 1D real data is supported');
            return;
        }

        this.spectrum_format = "ucsf";

        this.spectrum_origin = spectrum_origin;

        /**
         * @IMPORTANT
         * Please notice that Sparky stores data in big endian. DataView's get* methods use big endian by default.
         */

        let direct_parameters = new DataView(arrayBuffer, 188, 24);

        this.n_indirect = 1; //because it is 1D spectrum, indirect dimension is not used
        this.n_direct = direct_parameters.getInt32(0);
        let direct_tile_size = direct_parameters.getInt32(8);
        this.frq1 = direct_parameters.getFloat32(12); //observed frequency of direct dimension MHz
        this.sw1 = direct_parameters.getFloat32(16); //spectral width of direct dimension, Hz
        this.center1 = direct_parameters.getFloat32(20);   //ppm of the center of the spectrum
        this.ref1 = this.center1 * this.frq1 - this.sw1 / 2; //end frequency of the spectrum (lowest frequency)
        this.x_ppm_ref = 0.0; //reference correction (initially set to 0)
        this.x_ppm_start = this.center1 + this.sw1 / this.frq1 / 2.0; //ppm of the start of the spectrum
        this.x_ppm_width = this.sw1 / this.frq1; //width of the spectrum in ppm
        this.x_ppm_step = -this.x_ppm_width / this.n_direct; //step size in ppm

        this.raw_data = new Float32Array(this.n_direct);
        this.raw_data_i = new Float32Array(0); //no imaginary part at this time for Sparky format
       


        let current_file_position = 436-128; //start of the spectral data. Aligned to 4 bytes boundary, so there is not need to use DataView

        /**
         * Because Sparky stores data in big endian, we need to swap the byte order
         * from location current_file_position to the end of the arrayBuffer
         * for all float32 data (4 bytes), swap the byte order
         */
        for (let i = 0; i < (arrayBuffer.byteLength - current_file_position) / 4; i++) {
            let temp = new Uint8Array(arrayBuffer, current_file_position + i * 4, 4);
            temp.reverse();
        }

        let temp_raw_data = new Float32Array(arrayBuffer, current_file_position, this.n_direct);
        this.raw_data = new Float32Array(temp_raw_data); //copy with new buffer.


        /**
         * Setup fake nmrPipe header, so that we can use the same code to run DEEP_Picker, etc.
         */
        this.header = new Float32Array(512); //empty array
        this.header[0] = 0.0; //magic number for nmrPipe header

        this.header[99] = this.n_direct; //size of direct dimension of the input spectrum
        this.header[219] = this.n_indirect; //size of indirect dimension of the input spectrum
        this.header[221] = 0; // not transposed
        this.header[9] = 1; // # of dimensions
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
        this.header[119] = this.frq1; //observed frequency of direct dimension
        this.header[218] = 85.0 //not used

        this.header[100] = this.sw1; //spectral width of direct dimension
        this.header[229] = 100.0; // //spectral width of indirect dimension, not used

        /**
         * Per topspin convention, First point is inclusive, last point is exclusive in [ppm_start, ppm_start+ppm_width)]
         * Notice x_ppm_step and y_ppm_step are negative
         */
        this.header[101] = (this.x_ppm_start - this.x_ppm_width - this.x_ppm_step) * this.frq1; //origin of direct dimension (last point frq in Hz)
        this.header[249] = 0.0; //origin of indirect dimension (last point frq in Hz, not used)
        // this.ref1 = this.header[101];
        // this.ref2 = this.header[249];

        /**
         * Noise level, spectral_max and min.
         */
        this.filename = file_name;
        this.noise_level = this.mathTool.estimate_noise_level_1d(this.n_direct,this.raw_data);
        [this.spectral_max, this.spectral_min] = this.mathTool.find_max_min(this.raw_data);

    };


};