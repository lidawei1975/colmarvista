/**
 * NMR 1D FID Processing Tools (Shared Module)
 * Handles raw FID binary parsing (Bruker, Magritek, JCAMP-DX), S/N cutoff detection, and modal preview.
 */
function show_fid_window(fid_data, cutoff_index, confirm_callback) {
    let window_id = "fid_float_window";
    let win = document.getElementById(window_id);

    // Mutable state for cutoff (visual and logical)
    let currentCutoffIndex = cutoff_index;
    /**
     * If cutoff_index is 0, it means use full data.
     * So default the visual cutoff line to the end of the data.
     */
    if (currentCutoffIndex === 0) {
        currentCutoffIndex = fid_data.length;
    }

    // Create data array for D3. 
    // fid_data is interleaved real/imag. We plot Real part.
    // X axis: number of points (pairs).
    const plotDataReal = [];

    // Simple downsampling for performance
    let jump = 1;
    if (fid_data.length > 20000) jump = 2;
    if (fid_data.length > 40000) jump = 4;

    for (let i = 0; i < fid_data.length; i += 2 * jump) {
        let xVal = i / 2;
        plotDataReal.push({ x: xVal, y: fid_data[i] });
    }

    if (!win) {
        // Create window
        win = document.createElement("div");
        win.id = window_id;
        win.style.cssText = "position:fixed; top:10%; right:10%; width:600px; height:400px; background:white; border:1px solid #ccc; box-shadow:0 0 10px rgba(0,0,0,0.5); z-index:1000; display:flex; flex-direction:column;";

        let header = document.createElement("div");
        header.id = window_id + "_header"; // Assign ID for easier selection later
        header.style.cssText = "background:#eee; padding:5px; cursor:move; display:flex; justify-content:space-between; align-items:center;";
        // InnerHTML will be populated below to handle dynamic button

        // Drag logic
        let isDragging = false;
        let startX, startY, initialLeft, initialTop;
        header.onmousedown = function (e) {
            // Prevent drag if clicking buttons
            if (e.target.tagName === 'BUTTON') return;

            isDragging = true;
            startX = e.clientX;
            startY = e.clientY;
            initialLeft = win.offsetLeft;
            initialTop = win.offsetTop;

            function onMouseMove(e) {
                if (isDragging) {
                    win.style.left = (initialLeft + e.clientX - startX) + "px";
                    win.style.top = (initialTop + e.clientY - startY) + "px";
                    win.style.right = "auto"; // Clear right style if moving from right
                }
            }

            function onMouseUp() {
                isDragging = false;
                document.removeEventListener('mousemove', onMouseMove);
                document.removeEventListener('mouseup', onMouseUp);
            }

            document.addEventListener('mousemove', onMouseMove);
            document.addEventListener('mouseup', onMouseUp);
        };

        win.appendChild(header);

        let body = document.createElement("div");
        body.className = "fid-body";
        body.style.cssText = "flex:1; width:100%; height:100%; overflow:hidden;";
        body.id = "fid_plot_div";
        win.appendChild(body);

        document.body.appendChild(win);
    } else {
        win.style.display = "flex";
        let body = win.querySelector(".fid-body");
        if (body.style.display === "none") {
            body.style.display = "block";
            win.style.height = "400px";
            // Find the min button by class name
            let minBtn = win.querySelector(".min-btn");
            if (minBtn) minBtn.innerText = "-";
        }
    }

    // Update Header Content (Title + Optional Confirm Button + Min Button)
    let header = document.getElementById(window_id + "_header");
    header.innerHTML = ""; // Clear existing content

    let title = document.createElement("span");
    title.innerText = "FID Data";
    header.appendChild(title);

    let controlsDiv = document.createElement("div");
    controlsDiv.style.display = "flex";
    controlsDiv.style.alignItems = "center";

    if (confirm_callback) {
        let confirmBtn = document.createElement("button");
        confirmBtn.innerText = "Confirm Reduced Size";
        confirmBtn.style.cssText = "font-size: 12px; padding: 2px 5px; margin-right: 5px; background-color: #ff9800; color: white; border: none; cursor: pointer;";
        confirmBtn.onclick = function () {
            confirm_callback(currentCutoffIndex);
            // Optionally provide visual feedback or disable button
            confirmBtn.innerText = "Confirmed!";
            confirmBtn.disabled = true;
            confirmBtn.style.backgroundColor = "#ccc";
        };
        controlsDiv.appendChild(confirmBtn);
    }

    // Re-create min button (since we cleared innerHTML)
    let minBtn = document.createElement("button");
    minBtn.innerText = "-";
    minBtn.className = "min-btn"; // Add class for easier selection
    minBtn.style.cssText = "padding:0 5px;";
    minBtn.onclick = function () {
        let body = win.querySelector(".fid-body");
        if (body.style.display === "none") {
            body.style.display = "block";
            win.style.height = "400px";
            minBtn.innerText = "-";
        } else {
            body.style.display = "none";
            win.style.height = "auto";
            minBtn.innerText = "+";
        }
    };
    controlsDiv.appendChild(minBtn);

    header.appendChild(controlsDiv);


    // Clear previous plot
    d3.select("#fid_plot_div").selectAll("*").remove();

    // Draw Plot
    const margin = { top: 20, right: 20, bottom: 30, left: 60 };
    const width = 600 - margin.left - margin.right;
    const height = 360 - margin.top - margin.bottom;

    const svg = d3.select("#fid_plot_div")
        .append("svg")
        .attr("width", width + margin.left + margin.right)
        .attr("height", height + margin.top + margin.bottom)
        .append("g")
        .attr("transform", `translate(${margin.left},${margin.top})`);

    const x = d3.scaleLinear()
        .domain(d3.extent(plotDataReal, d => d.x))
        .range([0, width]);

    const y = d3.scaleLinear()
        .domain(d3.extent(plotDataReal, d => d.y))
        .range([height, 0]);

    const xAxis = svg.append("g")
        .attr("class", "x-axis")
        .attr("transform", `translate(0,${height})`)
        .call(d3.axisBottom(x));

    const yAxis = svg.append("g")
        .attr("class", "y-axis")
        .call(d3.axisLeft(y).tickFormat(d3.format(".1e")));

    svg.append("defs").append("clipPath")
        .attr("id", "fid_clip")
        .append("rect")
        .attr("width", width)
        .attr("height", height);

    const line = d3.line()
        .x(d => x(d.x))
        .y(d => y(d.y));

    const pathReal = svg.append("path")
        .datum(plotDataReal)
        .attr("class", "line-real")
        .attr("clip-path", "url(#fid_clip)")
        .attr("fill", "none")
        .attr("stroke", "steelblue")
        .attr("stroke-width", 1.5)
        .attr("d", line);



    // Cutoff Line (Vertical line at currentCutoffIndex)
    const cutoffLine = svg.append("line")
        .attr("x1", x(currentCutoffIndex / 2))
        .attr("y1", 0)
        .attr("x2", x(currentCutoffIndex / 2))
        .attr("y2", height)
        .attr("stroke", "red")
        .attr("stroke-width", 2)
        .attr("stroke-dasharray", "5,5")
        .attr("clip-path", "url(#fid_clip)");

    // Label the cutoff location
    const cutoffLabel = svg.append("text")
        .attr("x", x(currentCutoffIndex / 2) + 5)
        .attr("y", 20)
        .attr("fill", "red")
        .attr("clip-path", "url(#fid_clip)")
        .text("Cutoff");

    // Dynamic Label for numeric value (Top Right)
    const cutoffValueText = svg.append("text")
        .attr("x", width - 10)
        .attr("y", 20)
        .attr("text-anchor", "end")
        .attr("font-size", "14px")
        .attr("fill", "#333")
        .text(`Size: ${currentCutoffIndex}`);

    // --- Zoom Behavior ---

    // Store original scales to re-scale from
    const xOrig = x.copy();
    const yOrig = y.copy();

    // Functions to update chart
    function updateChart() {
        // Use the current domains of x and y (which are modified by zooms)
        xAxis.call(d3.axisBottom(x));
        yAxis.call(d3.axisLeft(y).tickFormat(d3.format(".1e")));

        pathReal.attr("d", line);

        const cx = x(currentCutoffIndex / 2);

        cutoffLine
            .attr("x1", cx)
            .attr("x2", cx);

        cutoffLabel.attr("x", cx + 5);
        cutoffValueText.text(`Size: ${currentCutoffIndex}`);

        if (confirm_callback) {
            // Update drag handle position
            svg.select(".cutoff-drag-handle")
                .attr("x", cx - 5);
        }
    }

    // X-Zoom (Plot Area)
    const zoomX = d3.zoom()
        .scaleExtent([0.5, 50]) // Limit zoom
        .translateExtent([[0, 0], [width, height]]) // Limit pan
        .extent([[0, 0], [width, height]])
        .on("zoom", (event) => {
            const newX = event.transform.rescaleX(xOrig);
            x.domain(newX.domain());
            updateChart();
        });

    // Y-Zoom (Y-Axis Area)
    const zoomY = d3.zoom()
        .scaleExtent([0.5, 50])
        // .translateExtent... for Y?
        .on("zoom", (event) => {
            const newY = event.transform.rescaleY(yOrig);
            y.domain(newY.domain());
            updateChart();
        });

    // Rect for Main Plot (X Zoom/Pan)
    svg.append("rect")
        .attr("class", "zoom-x-box")
        .attr("width", width)
        .attr("height", height)
        .style("fill", "none")
        .style("pointer-events", "all")
        // Cursor indicating horizontal usage might be nice, or default
        .call(zoomX);

    // Rect for Y Axis (Y Zoom/Pan)
    // Covers the left margin area. 
    // The main Group 'svg' is translated by (margin.left, margin.top).
    // So Y-axis is at x=0. Use x negative to cover margin.
    // Width = margin.left, Height = height.
    svg.append("rect")
        .attr("class", "zoom-y-box")
        .attr("x", -margin.left)
        .attr("y", 0)
        .attr("width", margin.left)
        .attr("height", height)
        .style("fill", "none")
        .style("pointer-events", "all")
        .style("cursor", "ns-resize") // Hint vertical zoom
        .call(zoomY);

    // Add Drag Behavior to Cutoff Line (if editable)
    // Moved here to be AFTER zoom rects (z-index layering)
    if (confirm_callback) {
        cutoffLine.style("cursor", "ew-resize");

        // Add a wider invisible rect for easier grabbing
        const dragHandle = svg.append("rect")
            .attr("class", "cutoff-drag-handle")
            .attr("x", x(currentCutoffIndex / 2) - 5)
            .attr("y", 0)
            .attr("width", 10)
            .attr("height", height)
            .attr("fill", "transparent")
            .style("cursor", "ew-resize")
            .attr("clip-path", "url(#fid_clip)");

        const dragBehavior = d3.drag()
            .on("drag", function (event) {
                // Get x coordinate within the 'g' element
                let mx = event.x;
                // Constrain within bounds (0, width)
                mx = Math.max(0, Math.min(width, mx));

                // Invert scale to get data value (which is index/2)
                let val = x.invert(mx);

                // Update currentCutoffIndex (value is index/2, so multiply by 2)
                // Round to nearest even number, as FID points are interleaved (real/imaginary)
                currentCutoffIndex = Math.floor(Math.round(val * 2) / 2) * 2;
                // Ensure cutoff is within valid data range
                currentCutoffIndex = Math.max(0, Math.min(fid_data.length - 2, currentCutoffIndex));

                updateChart();
            });

        dragHandle.call(dragBehavior);
    }
}

/**
 * Detect signal end based on noise level and envelope decay.
  * 1. Skip first 150 points (avoid filter artifacts).
  * 2. Calculate envelope (max - min in window of ~N/16 or 4096).
  * 3. Find rough end (drops below 1% of max).
  * 4. Estimate noise in the tail (median of RMSD of segments).
  *    - Method: Split into segments of length 32. Calculate StdDev (RMSD) for each.
  *    - Noise Level = Median of these StdDevs.
  * 5. Final cutoff: where envelope drops below max(6 * Noise, 0.001 * A0).
  * 
  * @param {Float32Array|Float64Array|Int32Array} fid_data - The FID data.
  * @returns {number} The index where the signal ends.
  */
function detect_signal_end(fid_data) {
    const N = fid_data.length;
    if (N < 200) return N;

    // 1. Parameters
    const skip = 150;
    const window_size = Math.max(1, Math.min(4096, Math.floor(N / 16)));

    // 2. Envelope Extraction
    let envelope_amp = []; // value
    let envelope_idx = []; // original index

    // Efficiency: For window_size 256, naive loop is OK.
    for (let i = skip; i <= N - window_size; i++) {
        let local_max = -Infinity;
        let local_min = Infinity;
        for (let j = 0; j < window_size; j++) {
            const val = fid_data[i + j];
            if (val > local_max) local_max = val;
            if (val < local_min) local_min = val;
        }
        let amp = (local_max - local_min) * 0.5;
        envelope_amp.push(amp);
        envelope_idx.push(i);
    }

    if (envelope_amp.length === 0) return N;

    // Estimate A0 (Max of envelope)
    // To be robust, max of first chunk? Or global max of envelope?
    // Envelope should be strictly decaying ideally, so max should be near start.
    let A0 = 0;
    for (let val of envelope_amp) {
        if (val > A0) A0 = val;
    }

    if (A0 === 0) return N;

    // 3. Rough End Definition (1%)
    const thresh_1pct = 0.01 * A0;
    let rough_end_idx_in_envelope = envelope_amp.length - 1;

    // Find first point where it drops and stays low? Or just first point?
    // "use 1% to define end of signal"
    for (let k = 0; k < envelope_amp.length; k++) {
        if (envelope_amp[k] < thresh_1pct) {
            rough_end_idx_in_envelope = k;
            break;
        }
    }

    const noise_start_idx = envelope_idx[rough_end_idx_in_envelope];

    // 4. Noise Estimation (Median of RMSDs of 32-pt segments)
    const segment_len = 32;
    let std_devs = [];

    // Iterate from noise_start_idx to N
    // We iterate on the raw data
    const noise_region_len = N - noise_start_idx;
    const n_segments = Math.floor(noise_region_len / segment_len);

    if (n_segments > 0) {
        for (let s = 0; s < n_segments; s++) {
            const seg_start = noise_start_idx + s * segment_len;

            // Calc Mean
            let sum = 0;
            for (let i = 0; i < segment_len; i++) sum += fid_data[seg_start + i];
            let mean = sum / segment_len;

            // Calc Variance
            let sum_sq_diff = 0;
            for (let i = 0; i < segment_len; i++) {
                const diff = fid_data[seg_start + i] - mean;
                sum_sq_diff += diff * diff;
            }
            // StdDev (Population or Sample? Usually Sample n-1, but for noise n is fine too. Let's use n-1)
            let variance = sum_sq_diff / (segment_len - 1);
            std_devs.push(Math.sqrt(variance));
        }

        // Median
        std_devs.sort((a, b) => a - b);
        var noise_level = std_devs[Math.floor(std_devs.length / 2)];
    } else {
        // Fallback if region is too small: just std of whatever is there
        noise_level = 0; // Or handle gracefully
    }

    // 5. Final Cutoff
    // "reach 6 times noise level or 0.1% of init"
    // "whichever is short" -> The value that is HIGHER (reached earlier).
    const limit = Math.max(6 * noise_level, 0.001 * A0);

    let final_cutoff_idx = N; // Default to end

    for (let k = 0; k < envelope_amp.length; k++) {
        if (envelope_amp[k] < limit) {
            final_cutoff_idx = envelope_idx[k];
            break;
        }
    }

    return final_cutoff_idx;
}

/**
 * Helper to parse FID data from buffer using WebAssembly (read_acqus_and_fid_from_memory and write_nmrpipe_fid_to_buffer)
 * @param {ArrayBuffer} fid_buffer 
 * @param {string} acquisition_string 
 * @returns {Promise<Float32Array>}
 */
async function get_fid_data_from_buffer(fid_buffer, acquisition_string) {
    if (!webdp1d_module && webdp1d_module_promise) {
        await webdp1d_module_promise;
    }

    if (webdp1d_module) {
        const obj = new webdp1d_module.spectrum_phasing_1d();

        const fid_bytes = new webdp1d_module.VectorUChar();
        if (fid_buffer && fid_buffer.byteLength > 0) {
            const raw_bytes = new Uint8Array(fid_buffer);
            for (let i = 0; i < raw_bytes.length; i++) {
                fid_bytes.push_back(raw_bytes[i]);
            }
        }

        obj.read_acqus_and_fid_from_memory(acquisition_string, fid_bytes);
        fid_bytes.delete();

        const nmrpipe_vec = new webdp1d_module.VectorUChar();
        const write_ok = obj.write_nmrpipe_fid_to_buffer(nmrpipe_vec);

        if (write_ok && nmrpipe_vec.size() > 2048) {
            const nmrpipe_uint8 = new Uint8Array(nmrpipe_vec.size());
            for (let i = 0; i < nmrpipe_vec.size(); i++) {
                nmrpipe_uint8[i] = nmrpipe_vec.get(i);
            }
            nmrpipe_vec.delete();
            obj.delete();

            const total_floats = (nmrpipe_uint8.byteLength - 2048) / 4;
            const n_real = total_floats / 2;

            return new Float32Array(
                nmrpipe_uint8.buffer,
                nmrpipe_uint8.byteOffset + 2048,
                n_real
            );
        }

        nmrpipe_vec.delete();
        obj.delete();
    }
    return null;
}

/**
 * Parse NMRPipe format .fid file (test_output.fid) sent from backend.
 * NMRPipe header is 2048 bytes (512 Float32 values).
 * @param {ArrayBuffer} buffer - Binary content of test_output.fid
 * @returns {Float32Array|null} fid_data (interleaved real and imaginary time-domain points)
 */
function get_fid_data_from_nmrpipe(buffer) {
    const HEADER_SIZE_BYTES = 2048; // 512 floats * 4 bytes
    // 1. Read 512-float NMRPipe Header
    const header = new Float32Array(buffer, 0, 512);
    // 2. Calculate data block size (nDataBruker)
    const totalDataFloats = (buffer.byteLength - HEADER_SIZE_BYTES) / 4;
    const nDataBruker = Math.floor(totalDataFloats / 2);
    // Header index 99 is FDSIZE (number of valid complex data points)
    const nData = Math.round(header[99]) || Math.floor(nDataBruker / 2);
    // 3. Extract Real and Imaginary Float32 blocks
    const realBlock = new Float32Array(buffer, HEADER_SIZE_BYTES, nDataBruker);
    const imagBlock = new Float32Array(buffer, HEADER_SIZE_BYTES + nDataBruker * 4, nDataBruker);
    // 4. Slice to extract valid nData points
    const real = realBlock.slice(0, nData);
    const imag = imagBlock.slice(0, nData);
    return real;
}

/**
 * Read a file as array buffer
 * @param {File|Blob} file 
 * @returns {Promise<ArrayBuffer>}
 */
function read_file(file) {
    return new Promise((resolve, reject) => {
        var reader = new FileReader();
        reader.onload = function () {
            resolve(reader.result);
        };
        reader.onerror = function (e) {
            reject("Error reading file");
        };
        reader.readAsArrayBuffer(file);
    });
}

/**
 * Read a file as text
 * @param {File|Blob} file 
 * @returns {Promise<string>}
 */
function read_file_text(file) {
    return new Promise((resolve, reject) => {
        var reader = new FileReader();
        reader.onload = function () {
            resolve(reader.result);
        };
        reader.onerror = function (e) {
            reject("Error reading file");
        };
        reader.readAsText(file);
    });
}

