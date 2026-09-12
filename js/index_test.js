// Controller for ChemEx Web Worker and Floating Console UI

let worker = null;
let isReady = false;
let isRunning = false;
let currentVirtualFiles = [];
let currentSelectedFile = null;

// DOM Elements
const statusBar = document.getElementById("statusBar");
const statusSpinner = document.getElementById("statusSpinner");
const statusText = document.getElementById("statusText");

const fsStatusBadge = document.getElementById("fsStatusBadge");
const btnWriteFs = document.getElementById("btnWriteFs");
const virtualFilesList = document.getElementById("virtualFilesList");

const btnRunFit = document.getElementById("btnRunFit");
const btnRunSim = document.getElementById("btnRunSim");
const btnToggleConsole = document.getElementById("btnToggleConsole");
const residueSelect = document.getElementById("residueSelect");
const commandDisplay = document.getElementById("commandDisplay");

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
    // Do not initiate drag if user clicked one of the header buttons
    if (e.target.tagName === "BUTTON") return;
    e.preventDefault();

    startX = e.clientX;
    startY = e.clientY;

    const rect = consoleWindow.getBoundingClientRect();
    initialLeft = rect.left;
    initialTop = rect.top;

    // Convert CSS right/bottom fixed positioning to explicit top/left
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

  // Clean up previous blob URL if needed
  if (currentSelectedFile && currentSelectedFile.blobUrl) {
    URL.revokeObjectURL(currentSelectedFile.blobUrl);
  }

  if (isBinary) {
    // Decode base64 to binary bytes
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
  if (residueSelect) residueSelect.disabled = running;
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

  // Ensure floating console is visible so user sees the output streaming
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

if (btnRunFit) btnRunFit.addEventListener("click", () => executeChemex("fit"));
if (btnRunSim) btnRunSim.addEventListener("click", () => executeChemex("simulate"));
if (btnWriteFs) btnWriteFs.addEventListener("click", syncCestDataset);
if (btnDownloadFile) btnDownloadFile.addEventListener("click", downloadSelectedFile);
if (residueSelect) residueSelect.addEventListener("change", updateCommandDisplay);
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
