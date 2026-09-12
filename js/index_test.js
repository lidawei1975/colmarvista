// Controller for ChemEx Web Worker, Floating Console UI, and Interactive NH Profile Simulation

let worker = null;
let isReady = false;
let isRunning = false;
let isInteractiveFitting = false;
let currentVirtualFiles = [];
let currentSelectedFile = null;
let profileChart = null;
let currentResidueDefaults = null;
let simDebounceTimer = null;

// DOM Elements: Status & Filesystem
const statusBar = document.getElementById("statusBar");
const statusSpinner = document.getElementById("statusSpinner");
const statusText = document.getElementById("statusText");

const fsStatusBadge = document.getElementById("fsStatusBadge");
const btnWriteFs = document.getElementById("btnWriteFs");
const virtualFilesList = document.getElementById("virtualFilesList");

// DOM Elements: ChemEx Run Controls
const btnRunFit = document.getElementById("btnRunFit");
const btnRunSim = document.getElementById("btnRunSim");
const btnToggleConsole = document.getElementById("btnToggleConsole");
const residueSelect = document.getElementById("residueSelect");
const commandDisplay = document.getElementById("commandDisplay");

// DOM Elements: Output Files
const outputFilesCard = document.getElementById("outputFilesCard");
const outputFilesBadges = document.getElementById("outputFilesBadges");
const fileViewerContainer = document.getElementById("fileViewerContainer");
const fileViewerTitle = document.getElementById("fileViewerTitle");
const fileViewerContent = document.getElementById("fileViewerContent");
const fileViewerPre = document.getElementById("fileViewerPre");
const fileViewerPdf = document.getElementById("fileViewerPdf");
const btnOpenPdfNewTab = document.getElementById("btnOpenPdfNewTab");
const btnDownloadFile = document.getElementById("btnDownloadFile");

const errorAlert = document.getElementById("errorAlert");

// Floating Console Elements
const consoleWindow = document.getElementById("chemex_console_window");
const consoleHeader = document.getElementById("chemex_console_header");
const consoleBody = document.getElementById("chemex_console_body");
const pythonStdout = document.getElementById("pythonStdout");
const buttonMinimizeConsole = document.getElementById("button_minimize_console");
const buttonClearConsole = document.getElementById("button_clear_console");

// Interactive Profile Simulation Elements
const interactiveResidueSelect = document.getElementById("interactiveResidueSelect");
const btnReloadResidue = document.getElementById("btnReloadResidue");
const interactiveProfileChartCanvas = document.getElementById("interactiveProfileChart");
const simLiveBadge = document.getElementById("simLiveBadge");
const paramStatusTag = document.getElementById("paramStatusTag");
const fitResultNotice = document.getElementById("fitResultNotice");

const num_PB = document.getElementById("num_PB");
const slider_PB = document.getElementById("slider_PB");
const num_KEX = document.getElementById("num_KEX");
const slider_KEX = document.getElementById("slider_KEX");
const num_CS = document.getElementById("num_CS");
const slider_CS = document.getElementById("slider_CS");
const num_DW = document.getElementById("num_DW");
const slider_DW = document.getElementById("slider_DW");
const num_TAUC = document.getElementById("num_TAUC");

const btnFitFromParams = document.getElementById("btnFitFromParams");
const btnResetParams = document.getElementById("btnResetParams");

// Update command display based on options
function updateCommandDisplay() {
  const residue = residueSelect ? residueSelect.value : "";
  const includeStr = residue && residue !== "ALL" ? ` --include ${residue}` : "";
  if (commandDisplay) {
    commandDisplay.textContent = `chemex fit -e Experiments/*.toml -p Parameters/parameters.toml -o Output${includeStr}`;
  }
}

// -------------------------------------------------------------
// Floating Console Window Controller (Drag, Minimize, Clear)
// -------------------------------------------------------------

function appendConsole(text) {
  if (!pythonStdout) return;
  pythonStdout.textContent += text;
  pythonStdout.scrollTop = pythonStdout.scrollHeight;
}

function clear_console() {
  if (pythonStdout) {
    pythonStdout.textContent = "";
  }
}

function toggle_console_minimize() {
  if (!consoleWindow || !consoleBody || !buttonMinimizeConsole) return;

  if (consoleBody.style.display === "none") {
    // Restore
    consoleBody.style.display = "flex";
    consoleWindow.style.height = consoleWindow.dataset.lastHeight || "360px";
    consoleWindow.style.width = consoleWindow.dataset.lastWidth || "580px";
    consoleWindow.style.resize = "both";
    buttonMinimizeConsole.innerText = "—";
    buttonMinimizeConsole.title = "Minimize console window";
  } else {
    // Minimize
    consoleWindow.dataset.lastHeight = consoleWindow.offsetHeight + "px";
    consoleWindow.dataset.lastWidth = consoleWindow.offsetWidth + "px";
    consoleBody.style.display = "none";
    consoleWindow.style.height = "auto";
    consoleWindow.style.width = "300px";
    consoleWindow.style.resize = "none";
    buttonMinimizeConsole.innerText = "□";
    buttonMinimizeConsole.title = "Restore console window";
  }
}

function show_console() {
  if (!consoleWindow) return;
  consoleWindow.style.display = "flex";
  if (consoleBody && consoleBody.style.display === "none") {
    toggle_console_minimize();
  }
}

function make_console_movable() {
  if (!consoleWindow || !consoleHeader) return;

  let startX, startY, initialLeft, initialTop;

  consoleHeader.onmousedown = function (e) {
    e = e || window.event;
    if (e.target.tagName === "BUTTON") return;
    e.preventDefault();

    startX = e.clientX;
    startY = e.clientY;

    const rect = consoleWindow.getBoundingClientRect();
    initialLeft = rect.left;
    initialTop = rect.top;

    consoleWindow.style.right = "auto";
    consoleWindow.style.bottom = "auto";
    consoleWindow.style.left = initialLeft + "px";
    consoleWindow.style.top = initialTop + "px";

    document.onmouseup = function () {
      document.onmouseup = null;
      document.onmousemove = null;
    };

    document.onmousemove = function (ev) {
      ev = ev || window.event;
      ev.preventDefault();

      const dx = ev.clientX - startX;
      const dy = ev.clientY - startY;

      const newLeft = Math.max(0, Math.min(window.innerWidth - 120, initialLeft + dx));
      const newTop = Math.max(0, Math.min(window.innerHeight - 40, initialTop + dy));

      consoleWindow.style.left = newLeft + "px";
      consoleWindow.style.top = newTop + "px";
    };
  };
}

// -------------------------------------------------------------
// Interactive NH Profile Chart & Simulation Controls
// -------------------------------------------------------------

function renderProfileChart(exp13, calc13, exp26, calc26) {
  if (!interactiveProfileChartCanvas || typeof Chart === "undefined") return;

  const chartData = {
    datasets: [
      {
        label: "13 Hz Data",
        data: exp13,
        type: "scatter",
        backgroundColor: "#2563eb",
        borderColor: "#2563eb",
        pointRadius: 3.5,
        pointHoverRadius: 6,
        showLine: false,
        order: 1
      },
      {
        label: "13 Hz Sim",
        data: calc13,
        type: "line",
        borderColor: "#2563eb",
        borderWidth: 2,
        pointRadius: 0,
        fill: false,
        tension: 0.1,
        order: 2
      },
      {
        label: "26 Hz Data",
        data: exp26,
        type: "scatter",
        backgroundColor: "#dc2626",
        borderColor: "#dc2626",
        pointRadius: 3.5,
        pointHoverRadius: 6,
        showLine: false,
        order: 3
      },
      {
        label: "26 Hz Sim",
        data: calc26,
        type: "line",
        borderColor: "#dc2626",
        borderWidth: 2,
        pointRadius: 0,
        fill: false,
        tension: 0.1,
        order: 4
      }
    ]
  };

  if (profileChart) {
    profileChart.data = chartData;
    profileChart.update("none");
    return;
  }

  profileChart = new Chart(interactiveProfileChartCanvas, {
    type: "scatter",
    data: chartData,
    options: {
      responsive: true,
      maintainAspectRatio: false,
      animation: false,
      plugins: {
        legend: {
          position: "top",
          labels: {
            boxWidth: 12,
            font: { size: 11, family: "-apple-system, sans-serif" }
          }
        },
        tooltip: {
          callbacks: {
            label: function (ctx) {
              const xVal = ctx.parsed.x ? ctx.parsed.x.toFixed(2) : "";
              const yVal = ctx.parsed.y ? ctx.parsed.y.toFixed(3) : "";
              return `${ctx.dataset.label}: ${xVal} ppm, I/I₀ = ${yVal}`;
            }
          }
        }
      },
      scales: {
        x: {
          type: "linear",
          position: "bottom",
          reverse: true, // NMR standard: ppm descending
          title: {
            display: true,
            text: "B1 Offset (ppm)",
            font: { weight: "bold", size: 12 }
          },
          grid: { color: "#f1f5f9" }
        },
        y: {
          min: 0,
          max: 1.15,
          title: {
            display: true,
            text: "Intensity (I/I₀)",
            font: { weight: "bold", size: 12 }
          },
          grid: { color: "#f1f5f9" }
        }
      }
    }
  });
}

function updateProfileChartLines(calc13, calc26) {
  if (!profileChart) return;
  profileChart.data.datasets[1].data = calc13 || [];
  profileChart.data.datasets[3].data = calc26 || [];
  profileChart.update("none");
}

function getParamValuesFromUI() {
  return {
    PB: parseFloat(num_PB ? num_PB.value : 0.015) || 0.015,
    KEX_AB: parseFloat(num_KEX ? num_KEX.value : 70.0) || 70.0,
    CS_A: parseFloat(num_CS ? num_CS.value : 108.0) || 108.0,
    DW_AB: parseFloat(num_DW ? num_DW.value : 4.0) || 4.0,
    TAUC_A: parseFloat(num_TAUC ? num_TAUC.value : 10.0) || 10.0
  };
}

function setParamValuesToUI(params) {
  if (!params) return;
  if (params.PB !== undefined && num_PB && slider_PB) {
    num_PB.value = Number(params.PB).toFixed(3);
    slider_PB.value = params.PB;
  }
  if (params.KEX_AB !== undefined && num_KEX && slider_KEX) {
    num_KEX.value = Math.round(params.KEX_AB);
    slider_KEX.value = params.KEX_AB;
  }
  if (params.CS_A !== undefined && num_CS && slider_CS) {
    const csVal = parseFloat(params.CS_A);
    num_CS.value = csVal.toFixed(2);
    slider_CS.min = (csVal - 4.0).toFixed(2);
    slider_CS.max = (csVal + 4.0).toFixed(2);
    slider_CS.value = csVal.toFixed(2);
  }
  if (params.DW_AB !== undefined && num_DW && slider_DW) {
    const dwVal = parseFloat(params.DW_AB);
    num_DW.value = dwVal.toFixed(1);
    slider_DW.value = dwVal;
  }
  if (params.TAUC_A !== undefined && num_TAUC) {
    num_TAUC.value = parseFloat(params.TAUC_A).toFixed(1);
  }
}

function triggerInteractiveSimulation() {
  if (!worker || !isReady || isRunning || isInteractiveFitting) return;
  if (simDebounceTimer) clearTimeout(simDebounceTimer);

  if (simLiveBadge) {
    simLiveBadge.textContent = "Calculating...";
    simLiveBadge.style.background = "#fef3c7";
    simLiveBadge.style.color = "#92400e";
  }

  simDebounceTimer = setTimeout(() => {
    const residue = interactiveResidueSelect ? interactiveResidueSelect.value : "13N";
    const params = getParamValuesFromUI();
    worker.postMessage({
      type: "simulate_residue",
      residue: residue,
      params: params
    });
  }, 35);
}

function bindSliderAndInput(slider, numInput) {
  if (!slider || !numInput) return;
  slider.addEventListener("input", () => {
    numInput.value = slider.value;
    if (paramStatusTag) paramStatusTag.textContent = "Modified by user";
    triggerInteractiveSimulation();
  });
  numInput.addEventListener("input", () => {
    slider.value = numInput.value;
    if (paramStatusTag) paramStatusTag.textContent = "Modified by user";
    triggerInteractiveSimulation();
  });
}

function loadInteractiveResidue(residue) {
  if (!worker || !isReady) return;
  if (fitResultNotice) fitResultNotice.style.display = "none";
  if (paramStatusTag) paramStatusTag.textContent = "Loading...";
  if (btnFitFromParams) btnFitFromParams.disabled = true;

  worker.postMessage({
    type: "get_residue_data",
    residue: residue
  });
}

function fitFromCurrentParams() {
  if (!worker || !isReady || isRunning || isInteractiveFitting) return;

  const residue = interactiveResidueSelect ? interactiveResidueSelect.value : "13N";
  const params = getParamValuesFromUI();

  isInteractiveFitting = true;
  setRunningState(true);

  if (btnFitFromParams) {
    btnFitFromParams.disabled = true;
    btnFitFromParams.textContent = `⏳ Fitting ${residue}...`;
  }
  if (fitResultNotice) {
    fitResultNotice.style.display = "block";
    fitResultNotice.style.background = "#eff6ff";
    fitResultNotice.style.borderColor = "#bfdbfe";
    fitResultNotice.style.color = "#1e40af";
    fitResultNotice.textContent = `Running ChemEx fit for ${residue} starting from your custom parameters... (see console for details)`;
  }

  appendConsole(`\n========================================================\n> Fitting residue ${residue} starting from user parameters:\n> PB = ${params.PB}, KEX_AB = ${params.KEX_AB}, CS_A = ${params.CS_A}, DW_AB = ${params.DW_AB}\n========================================================\n`);
  show_console();

  worker.postMessage({
    type: "fit_from_user_params",
    residue: residue,
    params: params,
    outputDir: "Output"
  });
}

// -------------------------------------------------------------
// Web Worker Initialization and Communication
// -------------------------------------------------------------

function initChemexWorker() {
  if (!window.Worker) {
    showError("Your browser does not support Web Workers.");
    if (statusText) statusText.textContent = "❌ Error: Web Workers unsupported.";
    return;
  }

  if (pythonStdout) {
    pythonStdout.textContent = "Spawning ChemEx Web Worker (js/chemex_worker.js)...\n";
  }

  try {
    worker = new Worker("js/chemex_worker.js?t=" + Date.now());
    worker.onmessage = handleWorkerMessage;
    worker.onerror = handleWorkerError;

    // Tell worker to initialize Pyodide runtime & packages
    worker.postMessage({ type: "init" });
  } catch (err) {
    console.error("Worker spawn error:", err);
    showError("Could not start Web Worker: " + err.message);
  }
}

function handleWorkerMessage(e) {
  const data = e.data || {};

  switch (data.type) {
    case "status":
      if (statusText) statusText.textContent = data.text;
      break;

    case "stdout":
      appendConsole(data.text);
      break;

    case "stderr":
      appendConsole(data.text);
      break;

    case "ready":
      isReady = true;
      if (statusBar) statusBar.className = "status-bar ready";
      if (statusSpinner) statusSpinner.style.display = "none";
      if (statusText) {
        statusText.textContent = `✅ Ready! Python ${data.pythonVersion} | ChemEx v${data.chemexVersion} | MEMFS populated with CEST_15N`;
      }
      if (btnRunFit) btnRunFit.disabled = false;
      if (btnRunSim) btnRunSim.disabled = false;
      if (btnWriteFs) btnWriteFs.disabled = false;

      if (fsStatusBadge) {
        fsStatusBadge.className = "status-bar ready";
        fsStatusBadge.textContent = `✅ ${data.filesWritten} files loaded in MEMFS (CEST_15N/)`;
      }

      currentVirtualFiles = data.virtualFiles || [];
      renderVirtualFilesList(currentVirtualFiles);

      // Automatically load the initial residue for interactive simulation
      const initialRes = interactiveResidueSelect ? interactiveResidueSelect.value : "13N";
      loadInteractiveResidue(initialRes);
      break;

    case "residue_data_result":
      if (data.data && data.data.status === "success") {
        const res = data.data;
        currentResidueDefaults = { ...res.params };
        setParamValuesToUI(res.params);
        renderProfileChart(res.exp_13hz, res.calc_13hz, res.exp_26hz, res.calc_26hz);

        if (btnFitFromParams) btnFitFromParams.disabled = false;
        if (paramStatusTag) paramStatusTag.textContent = "Initial guess (Parameters.toml)";
        if (simLiveBadge) {
          simLiveBadge.textContent = "Simulating on-the-fly";
          simLiveBadge.style.background = "#e0f2fe";
          simLiveBadge.style.color = "#0369a1";
        }
      }
      break;

    case "simulation_update_result":
      if (data.data && data.data.status === "success") {
        updateProfileChartLines(data.data.calc_13hz, data.data.calc_26hz);
        if (simLiveBadge) {
          simLiveBadge.textContent = "Updated on-the-fly";
          simLiveBadge.style.background = "#dcfce7";
          simLiveBadge.style.color = "#166534";
        }
      }
      break;

    case "fit_complete_with_params":
      isInteractiveFitting = false;
      setRunningState(false);
      if (btnFitFromParams) {
        btnFitFromParams.disabled = false;
        btnFitFromParams.textContent = "⚡ Fit from Current Parameters";
      }

      if (data.data) {
        const res = data.data;
        // Update chart lines with newly fitted curves
        updateProfileChartLines(res.calc_13hz, res.calc_26hz);

        // Update parameters if fitted results found
        if (res.fitted_params) {
          const fp = res.fitted_params;
          const updated = {};
          if (fp.PB) updated.PB = fp.PB.value;
          if (fp.KEX_AB) updated.KEX_AB = fp.KEX_AB.value;
          if (fp.CS_A) updated.CS_A = fp.CS_A.value;
          if (fp.DW_AB) updated.DW_AB = fp.DW_AB.value;
          setParamValuesToUI(updated);
        }

        if (paramStatusTag) paramStatusTag.textContent = "✅ Fitted Result";
        if (fitResultNotice) {
          fitResultNotice.style.display = "block";
          fitResultNotice.style.background = "#ecfdf5";
          fitResultNotice.style.borderColor = "#a7f3d0";
          fitResultNotice.style.color = "#065f46";

          let noticeText = `✅ Fit completed successfully for ${data.residue}!`;
          if (res.fitted_params) {
            const parts = [];
            if (res.fitted_params.PB) parts.push(`pB = ${res.fitted_params.PB.value.toFixed(4)}`);
            if (res.fitted_params.KEX_AB) parts.push(`kex = ${res.fitted_params.KEX_AB.value.toFixed(1)} s⁻¹`);
            if (res.fitted_params.DW_AB) parts.push(`Δϖ = ${res.fitted_params.DW_AB.value.toFixed(2)} ppm`);
            if (parts.length > 0) noticeText += " (" + parts.join(", ") + ")";
          }
          fitResultNotice.textContent = noticeText;
        }

        if (res.virtual_files) {
          currentVirtualFiles = res.virtual_files;
          renderVirtualFilesList(currentVirtualFiles);
        }
        if (res.run_result && res.run_result.output_files) {
          displayOutputFiles(data.outputDir, res.run_result.output_files);
        }
      }
      break;

    case "user_fit_error":
      isInteractiveFitting = false;
      setRunningState(false);
      if (btnFitFromParams) {
        btnFitFromParams.disabled = false;
        btnFitFromParams.textContent = "⚡ Fit from Current Parameters";
      }
      showError(`Fit error: ${data.error}`);
      if (fitResultNotice) {
        fitResultNotice.style.display = "block";
        fitResultNotice.style.background = "#fee2e2";
        fitResultNotice.style.borderColor = "#fecaca";
        fitResultNotice.style.color = "#991b1b";
        fitResultNotice.textContent = `❌ Error during fit: ${data.error}`;
      }
      break;

    case "residue_data_error":
      console.warn("Could not load residue data:", data.error);
      if (paramStatusTag) paramStatusTag.textContent = "Error loading";
      break;

    case "dataset_synced":
      if (fsStatusBadge) {
        fsStatusBadge.className = "status-bar ready";
        fsStatusBadge.textContent = `✅ ${data.count} files synced to MEMFS (CEST_15N/)`;
      }
      currentVirtualFiles = data.virtualFiles || [];
      renderVirtualFilesList(currentVirtualFiles);
      break;

    case "run_complete":
      isRunning = false;
      setRunningState(false);
      if (statusBar) statusBar.className = "status-bar ready";
      if (statusSpinner) statusSpinner.style.display = "none";
      if (statusText) {
        statusText.textContent = `✅ ChemEx ${data.command.toUpperCase()} completed successfully! Output saved to '${data.outputDir}/'`;
      }
      currentVirtualFiles = data.virtualFiles || [];
      renderVirtualFilesList(currentVirtualFiles);
      displayOutputFiles(data.outputDir, data.result.output_files || []);
      break;

    case "run_error":
      isRunning = false;
      setRunningState(false);
      if (statusBar) statusBar.className = "status-bar error";
      if (statusSpinner) statusSpinner.style.display = "none";
      if (statusText) {
        statusText.textContent = "❌ ChemEx execution error (see console output)";
      }
      showError(data.error);
      appendConsole(`\n❌ Error: ${data.error}\n`);
      show_console();
      break;

    case "file_content":
      handleFileContentResponse(data);
      break;

    case "file_error":
      showError(`Could not read file ${data.filename}: ${data.error}`);
      break;

    case "init_error":
      if (statusBar) statusBar.className = "status-bar error";
      if (statusSpinner) statusSpinner.style.display = "none";
      if (statusText) statusText.textContent = "❌ Initialization failed: " + data.error;
      showError(data.error);
      break;

    default:
      console.log("Worker message received:", data);
  }
}

function handleWorkerError(err) {
  console.error("Worker error:", err);
  if (statusBar) statusBar.className = "status-bar error";
  if (statusSpinner) statusSpinner.style.display = "none";
  if (statusText) statusText.textContent = "❌ Worker error: " + (err.message || "Unknown error");
  showError("Worker encountered an error: " + (err.message || err));
}

// -------------------------------------------------------------
// Virtual Filesystem & File Viewer Helpers
// -------------------------------------------------------------

function renderVirtualFilesList(files) {
  if (!virtualFilesList) return;
  if (!files || files.length === 0) {
    virtualFilesList.innerHTML = `<span style="color: var(--text-muted); font-style: italic;">No files in virtual filesystem yet</span>`;
    return;
  }

  const items = files.map(f => {
    const isOut = f.startsWith("Output/") || f.startsWith("OutputSim/");
    const color = isOut ? "#16a34a" : "#2563eb";
    return `<div style="padding: 2px 0;"><span style="color: ${color};">📄 ${f}</span></div>`;
  });
  virtualFilesList.innerHTML = items.join("");
}

function displayOutputFiles(outputDir, fileList) {
  if (!outputFilesCard || !outputFilesBadges) return;

  outputFilesCard.style.display = "block";
  outputFilesBadges.innerHTML = "";

  if (!fileList || fileList.length === 0) {
    outputFilesBadges.innerHTML = `<span style="color: var(--text-muted);">No output files detected in ${outputDir}</span>`;
    return;
  }

  fileList.forEach(filename => {
    const isPdf = filename.toLowerCase().endsWith(".pdf");
    const badge = document.createElement("button");
    badge.className = "btn-secondary file-badge";
    badge.textContent = `${isPdf ? "📊" : "📄"} ${filename}`;
    badge.style.fontSize = "0.85rem";
    badge.style.padding = "6px 12px";

    badge.addEventListener("click", () => {
      requestVirtualFile(outputDir, filename);
    });

    outputFilesBadges.appendChild(badge);
  });

  // Automatically request view of parameters.fit or the first output file
  const defaultFile = fileList.find(f => f.endsWith("parameters.fit") || f.endsWith(".fit") || f.endsWith(".toml")) || fileList[0];
  if (defaultFile) {
    requestVirtualFile(outputDir, defaultFile);
  }
}

function requestVirtualFile(outputDir, filename) {
  if (!worker) return;
  if (fileViewerContainer && fileViewerTitle) {
    fileViewerContainer.style.display = "block";
    fileViewerTitle.textContent = `Loading CEST_15N/${outputDir}/${filename}...`;
  }
  worker.postMessage({
    type: "read_file",
    outputDir: outputDir,
    filename: filename
  });
}

function handleFileContentResponse(data) {
  const { outputDir, filename, isBinary, content } = data;
  const fullRelPath = `${outputDir}/${filename}`;

  if (currentSelectedFile && currentSelectedFile.blobUrl) {
    URL.revokeObjectURL(currentSelectedFile.blobUrl);
  }

  if (isBinary) {
    const binStr = atob(content);
    const len = binStr.length;
    const bytes = new Uint8Array(len);
    for (let i = 0; i < len; i++) {
      bytes[i] = binStr.charCodeAt(i);
    }
    const blob = new Blob([bytes], { type: "application/pdf" });
    const blobUrl = URL.createObjectURL(blob);

    currentSelectedFile = {
      path: fullRelPath,
      filename: filename,
      isBinary: true,
      bytes: bytes,
      blob: blob,
      blobUrl: blobUrl,
      mimeType: "application/pdf"
    };

    if (fileViewerContainer && fileViewerTitle) {
      fileViewerContainer.style.display = "block";
      fileViewerTitle.textContent = `CEST_15N/${fullRelPath} (PDF Document, ${(bytes.length / 1024).toFixed(1)} KB)`;
    }

    if (fileViewerPre) fileViewerPre.style.display = "none";
    if (fileViewerPdf) {
      fileViewerPdf.style.display = "block";
      fileViewerPdf.src = blobUrl;
    }
    if (btnOpenPdfNewTab) {
      btnOpenPdfNewTab.style.display = "inline-flex";
      btnOpenPdfNewTab.href = blobUrl;
    }
    if (btnDownloadFile) {
      btnDownloadFile.textContent = "⬇ Download PDF";
    }
  } else {
    currentSelectedFile = {
      path: fullRelPath,
      filename: filename,
      isBinary: false,
      content: content,
      mimeType: "text/plain;charset=utf-8"
    };

    if (fileViewerContainer && fileViewerTitle && fileViewerContent) {
      fileViewerContainer.style.display = "block";
      fileViewerTitle.textContent = `CEST_15N/${fullRelPath} (Virtual MEMFS)`;
      fileViewerContent.textContent = content;
    }

    if (fileViewerPdf) {
      fileViewerPdf.style.display = "none";
      fileViewerPdf.src = "";
    }
    if (btnOpenPdfNewTab) {
      btnOpenPdfNewTab.style.display = "none";
    }
    if (fileViewerPre) {
      fileViewerPre.style.display = "block";
    }
    if (btnDownloadFile) {
      btnDownloadFile.textContent = "⬇ Download File";
    }
  }
}

function downloadSelectedFile() {
  if (!currentSelectedFile) return;

  const downloadFilename = currentSelectedFile.filename.split("/").pop() || "download";
  let blob;
  if (currentSelectedFile.isBinary) {
    blob = currentSelectedFile.blob || new Blob([currentSelectedFile.bytes], { type: currentSelectedFile.mimeType });
  } else {
    blob = new Blob([currentSelectedFile.content], { type: currentSelectedFile.mimeType || "text/plain;charset=utf-8" });
  }

  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = downloadFilename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  setTimeout(() => URL.revokeObjectURL(url), 2000);
}

// -------------------------------------------------------------
// Execution & UI Controls
// -------------------------------------------------------------

function setRunningState(running) {
  if (btnRunFit) btnRunFit.disabled = running;
  if (btnRunSim) btnRunSim.disabled = running;
  if (btnWriteFs) btnWriteFs.disabled = running;
  if (btnFitFromParams) btnFitFromParams.disabled = running;
  if (residueSelect) residueSelect.disabled = running;
  if (interactiveResidueSelect) interactiveResidueSelect.disabled = running;
}

function executeChemex(command) {
  if (!isReady || !worker || isRunning) return;

  hideError();
  isRunning = true;
  setRunningState(true);

  const residue = residueSelect ? residueSelect.value : "13N";
  const includeResidue = residue === "ALL" ? null : residue;
  const outputDir = command === "simulate" ? "OutputSim" : "Output";

  if (statusBar) statusBar.className = "status-bar loading";
  if (statusSpinner) statusSpinner.style.display = "inline-block";
  if (statusText) {
    statusText.textContent = `Running 'chemex ${command}' in Worker (Residue: ${residue})... Output streaming to console.`;
  }

  appendConsole(`\n========================================================\n> Executing ChemEx ${command.toUpperCase()} (Residue: ${residue})\n========================================================\n`);
  show_console();

  worker.postMessage({
    type: "run_chemex",
    command: command,
    includeResidue: includeResidue,
    outputDir: outputDir
  });
}

function syncCestDataset() {
  if (!worker || isRunning) return;
  if (fsStatusBadge) {
    fsStatusBadge.className = "status-bar loading";
    fsStatusBadge.textContent = "Syncing dataset to MEMFS...";
  }
  worker.postMessage({ type: "sync_dataset" });
}

function showError(msg) {
  if (errorAlert) {
    errorAlert.textContent = "Error: " + msg;
    errorAlert.style.display = "block";
  }
}

function hideError() {
  if (errorAlert) {
    errorAlert.style.display = "none";
    errorAlert.textContent = "";
  }
}

// -------------------------------------------------------------
// Event Listeners & Startup
// -------------------------------------------------------------

// Sliders and Number Inputs bindings
bindSliderAndInput(slider_PB, num_PB);
bindSliderAndInput(slider_KEX, num_KEX);
bindSliderAndInput(slider_CS, num_CS);
bindSliderAndInput(slider_DW, num_DW);
if (num_TAUC) num_TAUC.addEventListener("input", triggerInteractiveSimulation);

// Interactive Residue Select change
if (interactiveResidueSelect) {
  interactiveResidueSelect.addEventListener("change", (e) => {
    const res = e.target.value;
    if (residueSelect) residueSelect.value = res;
    updateCommandDisplay();
    loadInteractiveResidue(res);
  });
}

if (btnReloadResidue) {
  btnReloadResidue.addEventListener("click", () => {
    const res = interactiveResidueSelect ? interactiveResidueSelect.value : "13N";
    loadInteractiveResidue(res);
  });
}

if (btnFitFromParams) {
  btnFitFromParams.addEventListener("click", fitFromCurrentParams);
}

if (btnResetParams) {
  btnResetParams.addEventListener("click", () => {
    if (currentResidueDefaults) {
      setParamValuesToUI(currentResidueDefaults);
      if (paramStatusTag) paramStatusTag.textContent = "Reset to defaults";
      triggerInteractiveSimulation();
    }
  });
}

if (btnRunFit) btnRunFit.addEventListener("click", () => executeChemex("fit"));
if (btnRunSim) btnRunSim.addEventListener("click", () => executeChemex("simulate"));
if (btnWriteFs) btnWriteFs.addEventListener("click", syncCestDataset);
if (btnDownloadFile) btnDownloadFile.addEventListener("click", downloadSelectedFile);
if (residueSelect) residueSelect.addEventListener("change", (e) => {
  updateCommandDisplay();
  if (interactiveResidueSelect && e.target.value !== "ALL") {
    interactiveResidueSelect.value = e.target.value;
    loadInteractiveResidue(e.target.value);
  }
});
if (btnToggleConsole) btnToggleConsole.addEventListener("click", toggle_console_minimize);

window.addEventListener("DOMContentLoaded", () => {
  updateCommandDisplay();
  make_console_movable();
  initChemexWorker();

  fetch("navbar.html")
    .then(res => (res.ok ? res.text() : ""))
    .then(html => {
      const el = document.getElementById("navbar-placeholder");
      if (el) el.innerHTML = html;
    })
    .catch(() => {});
});
