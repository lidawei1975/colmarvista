let pyodide = null;
let isReady = false;
let manifestData = null;

// DOM Elements
const statusBar = document.getElementById("statusBar");
const statusSpinner = document.getElementById("statusSpinner");
const statusText = document.getElementById("statusText");

const fsStatusBadge = document.getElementById("fsStatusBadge");
const btnWriteFs = document.getElementById("btnWriteFs");
const virtualFilesList = document.getElementById("virtualFilesList");

const btnRunFit = document.getElementById("btnRunFit");
const btnRunSim = document.getElementById("btnRunSim");
const residueSelect = document.getElementById("residueSelect");
const commandDisplay = document.getElementById("commandDisplay");

const outputFilesCard = document.getElementById("outputFilesCard");
const outputFilesBadges = document.getElementById("outputFilesBadges");
const fileViewerContainer = document.getElementById("fileViewerContainer");
const fileViewerTitle = document.getElementById("fileViewerTitle");
const fileViewerContent = document.getElementById("fileViewerContent");
const btnDownloadFile = document.getElementById("btnDownloadFile");

const pythonStdout = document.getElementById("pythonStdout");
const errorAlert = document.getElementById("errorAlert");

let currentSelectedFile = null;

// Update command display based on options
function updateCommandDisplay() {
  const residue = residueSelect ? residueSelect.value : "";
  const includeStr = residue && residue !== "ALL" ? ` --include ${residue}` : "";
  if (commandDisplay) {
    commandDisplay.textContent = `chemex fit -e Experiments/*.toml -p Parameters/parameters.toml -o Output${includeStr}`;
  }
}

// Initialize Pyodide, install dependencies, load ChemEx, and write CEST_15N into MEMFS
async function initPyodide() {
  try {
    statusText.textContent = "Loading Pyodide v0.28.0 (Python 3.13) from CDN...";
    pyodide = await loadPyodide({
      indexURL: "https://cdn.jsdelivr.net/pyodide/v0.28.0/full/"
    });

    statusText.textContent = "Loading scientific packages (numpy, scipy, matplotlib, pygments, micropip)...";
    await pyodide.loadPackage(["numpy", "scipy", "matplotlib", "pygments", "micropip"]);

    const micropip = pyodide.pyimport("micropip");

    statusText.textContent = "Installing ChemEx dependencies (pydantic, lmfit, rich, numdifftools)...";
    try {
      await micropip.install(["pydantic", "lmfit", "rich", "annotated-types", "cachetools", "emcee"]);
    } catch (e) {
      console.warn("Some optional micropip packages could not be installed from PyPI:", e);
    }

    statusText.textContent = "Mounting ChemEx package in virtual filesystem (MEMFS)...";
    const wheelRes = await fetch("chemex/chemex-2026.1.0-py3-none-any.whl");
    if (!wheelRes.ok) throw new Error(`Could not fetch chemex wheel: HTTP ${wheelRes.status}`);
    const wheelBytes = new Uint8Array(await wheelRes.arrayBuffer());
    pyodide.FS.writeFile("chemex-2026.1.0-py3-none-any.whl", wheelBytes);

    statusText.textContent = "Loading chemex_runner.py helper...";
    const runnerRes = await fetch("chemex_runner.py");
    if (!runnerRes.ok) throw new Error(`Could not fetch chemex_runner.py: HTTP ${runnerRes.status}`);
    const runnerCode = await runnerRes.text();
    pyodide.FS.writeFile("chemex_runner.py", runnerCode);

    // Initialize environment in Python
    pyodide.runPython(`
import sys
if "chemex-2026.1.0-py3-none-any.whl" not in sys.path:
    sys.path.insert(0, "chemex-2026.1.0-py3-none-any.whl")
import chemex
import chemex_runner
print(f"> [ChemEx] Successfully mounted ChemEx v{chemex.__version__}")
`);

    statusText.textContent = "Writing CEST_15N dataset to virtual filesystem...";
    await writeCestDataset();

    isReady = true;
    statusBar.className = "status-bar ready";
    statusSpinner.style.display = "none";
    const pyVer = pyodide.runPython("import sys; sys.version.split()[0]");
    const chemexVer = pyodide.runPython("import chemex; chemex.__version__");
    statusText.textContent = `✅ Ready! Python ${pyVer} | ChemEx v${chemexVer} | MEMFS populated with CEST_15N`;

    btnRunFit.disabled = false;
    btnRunSim.disabled = false;
    if (btnWriteFs) btnWriteFs.disabled = false;
  } catch (err) {
    console.error("Initialization error:", err);
    statusBar.className = "status-bar error";
    statusSpinner.style.display = "none";
    statusText.textContent = "❌ Error initializing: " + (err.message || err);
    showError(err.message || String(err));
  }
}

// Write the CEST_15N files into MEMFS from files_manifest.json
async function writeCestDataset() {
  try {
    const res = await fetch("chemex/CEST_15N/files_manifest.json");
    if (!res.ok) throw new Error(`Could not fetch files_manifest.json: HTTP ${res.status}`);
    const manifestJsonText = await res.text();
    manifestData = JSON.parse(manifestJsonText);

    pyodide.globals.set("manifest_str", manifestJsonText);
    const filesWritten = pyodide.runPython(`
import chemex_runner
chemex_runner.write_virtual_files(manifest_str)
`);

    if (fsStatusBadge) {
      fsStatusBadge.className = "status-badge success";
      fsStatusBadge.textContent = `✅ ${filesWritten} files written to virtual filesystem (CEST_15N/)`;
    }

    refreshVirtualFilesList();
  } catch (err) {
    console.error("Error writing CEST_15N dataset:", err);
    if (fsStatusBadge) {
      fsStatusBadge.className = "status-badge error";
      fsStatusBadge.textContent = `⚠️ Filesystem notice: ${err.message || err}`;
    }
  }
}

// Refresh virtual file list display
function refreshVirtualFilesList() {
  if (!pyodide || !virtualFilesList) return;
  try {
    const jsonStr = pyodide.runPython(`
import json, chemex_runner
json.dumps(chemex_runner.get_virtual_files("CEST_15N"))
`);
    const files = JSON.parse(jsonStr);
    virtualFilesList.innerHTML = "";

    const experiments = files.filter(f => f.startsWith("Experiments/"));
    const params = files.filter(f => f.startsWith("Parameters/"));
    const data13 = files.filter(f => f.startsWith("Data/13Hz/"));
    const data26 = files.filter(f => f.startsWith("Data/26Hz/"));
    const outputs = files.filter(f => f.startsWith("Output") || f.startsWith("OutputSim"));

    const summary = document.createElement("div");
    summary.style.fontSize = "0.9rem";
    summary.style.marginBottom = "8px";
    summary.innerHTML = `<strong>Total Files:</strong> ${files.length} (Experiments: ${experiments.length}, Parameters: ${params.length}, 13Hz Data: ${data13.length}, 26Hz Data: ${data26.length}, Outputs: ${outputs.length})`;
    virtualFilesList.appendChild(summary);
  } catch (err) {
    console.warn("Could not list virtual files:", err);
  }
}

// Run ChemEx Command (fit or simulate)
async function executeChemex(command = "fit") {
  if (!isReady || !pyodide) return;

  hideError();
  btnRunFit.disabled = true;
  btnRunSim.disabled = true;

  const residue = residueSelect ? residueSelect.value : "";
  const includeResidue = (residue && residue !== "ALL") ? residue : null;
  const outputDir = command === "simulate" ? "OutputSim" : "Output";

  const originalStatus = statusText.textContent;
  statusText.textContent = `⏳ Running ChemEx ${command.toUpperCase()} on CEST_15N dataset... (this may take a moment)`;
  statusBar.className = "status-bar loading";
  statusSpinner.style.display = "block";

  try {
    let stdoutBuffer = "";
    pyodide.setStdout({
      batched: (msg) => {
        stdoutBuffer += msg + "\n";
        if (pythonStdout) {
          pythonStdout.textContent = stdoutBuffer;
          pythonStdout.scrollTop = pythonStdout.scrollHeight;
        }
      }
    });

    pyodide.globals.set("cmd_type", command);
    pyodide.globals.set("inc_res", includeResidue);
    pyodide.globals.set("out_dir", outputDir);

    const pyScript = `
import chemex_runner
result_json = chemex_runner.run_chemex_command(command=cmd_type, include_residue=inc_res, output_dir=out_dir)
result_json
`;

    const resultStr = pyodide.runPython(pyScript);
    const result = JSON.parse(resultStr);

    statusText.textContent = `✅ ChemEx ${command.toUpperCase()} completed successfully! Output saved to '${outputDir}' in MEMFS.`;
    statusBar.className = "status-bar ready";
    statusSpinner.style.display = "none";

    // Display output files in UI
    displayOutputFiles(outputDir, result.output_files);
    refreshVirtualFilesList();
  } catch (err) {
    console.error("Execution error:", err);
    statusBar.className = "status-bar error";
    statusSpinner.style.display = "none";
    statusText.textContent = "❌ ChemEx execution error: " + (err.message || err);
    showError(err.message || String(err));
  } finally {
    btnRunFit.disabled = false;
    btnRunSim.disabled = false;
  }
}

// Display output files as interactive badges
function displayOutputFiles(outputDir, fileList) {
  if (!outputFilesCard || !outputFilesBadges) return;

  outputFilesCard.style.display = "block";
  outputFilesBadges.innerHTML = "";

  if (!fileList || fileList.length === 0) {
    outputFilesBadges.innerHTML = `<span style="color: var(--text-muted);">No output files detected in ${outputDir}</span>`;
    return;
  }

  fileList.forEach(filename => {
    const badge = document.createElement("button");
    badge.className = "btn-secondary file-badge";
    badge.textContent = `📄 ${filename}`;
    badge.style.fontSize = "0.85rem";
    badge.style.padding = "6px 12px";

    badge.addEventListener("click", () => {
      viewVirtualFile(outputDir, filename);
    });

    outputFilesBadges.appendChild(badge);
  });

  // Automatically view parameters.fit or the first file
  const defaultFile = fileList.find(f => f.endsWith("parameters.fit") || f.endsWith(".fit") || f.endsWith(".toml")) || fileList[0];
  if (defaultFile) {
    viewVirtualFile(outputDir, defaultFile);
  }
}

// View file content from virtual filesystem
function viewVirtualFile(outputDir, filename) {
  if (!pyodide) return;
  try {
    const fullRelPath = `${outputDir}/${filename}`;
    pyodide.globals.set("view_path", fullRelPath);

    const content = pyodide.runPython(`
import chemex_runner
chemex_runner.read_virtual_file(view_path, base_dir="CEST_15N")
`);

    currentSelectedFile = { path: fullRelPath, filename: filename, content: content };

    if (fileViewerContainer && fileViewerTitle && fileViewerContent) {
      fileViewerContainer.style.display = "block";
      fileViewerTitle.textContent = `CEST_15N/${fullRelPath} (Virtual MEMFS)`;
      fileViewerContent.textContent = content;
    }
  } catch (err) {
    console.error("Error reading virtual file:", err);
    showError(`Could not read file ${filename}: ` + err.message);
  }
}

// Download selected file to local computer
function downloadSelectedFile() {
  if (!currentSelectedFile) return;
  const blob = new Blob([currentSelectedFile.content], { type: "text/plain;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = currentSelectedFile.filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
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

// Event Listeners
btnRunFit.addEventListener("click", () => executeChemex("fit"));
btnRunSim.addEventListener("click", () => executeChemex("simulate"));
if (btnWriteFs) btnWriteFs.addEventListener("click", writeCestDataset);
if (btnDownloadFile) btnDownloadFile.addEventListener("click", downloadSelectedFile);
if (residueSelect) residueSelect.addEventListener("change", updateCommandDisplay);

// Start on page load
window.addEventListener("DOMContentLoaded", () => {
  updateCommandDisplay();
  initPyodide();
  fetch("navbar.html")
    .then(res => (res.ok ? res.text() : ""))
    .then(html => {
      const el = document.getElementById("navbar-placeholder");
      if (el) el.innerHTML = html;
    })
    .catch(() => {});
});
