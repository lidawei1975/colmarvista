

let pyodide = null;
let isReady = false;
let pythonScriptContent = "";

const statusBar = document.getElementById("statusBar");
const statusSpinner = document.getElementById("statusSpinner");
const statusText = document.getElementById("statusText");
const calcBtn = document.getElementById("calcBtn");
const genRandomBtn = document.getElementById("genRandomBtn");
const clearBtn = document.getElementById("clearBtn");
const dataInput = document.getElementById("dataInput");
const resultsCard = document.getElementById("resultsCard");
const errorAlert = document.getElementById("errorAlert");
const pythonStdout = document.getElementById("pythonStdout");
const pythonScriptPreview = document.getElementById("pythonScriptPreview");

// Fetch the external Python script (calculate_stats.py)
async function loadPythonScript() {
  try {
    const res = await fetch("calculate_stats.py");
    if (res.ok) {
      pythonScriptContent = await res.text();
    } else {
      throw new Error(`HTTP ${res.status}`);
    }
  } catch (err) {
    console.warn("Could not fetch calculate_stats.py via HTTP, using fallback:", err);
  }
}

// Initialize Pyodide, NumPy, and load calculate_stats.py into MEMFS
async function initPyodide() {
  try {
    statusText.textContent = "Loading Pyodide runtime from CDN...";
    pyodide = await loadPyodide();

    statusText.textContent = "Loading NumPy package in WebAssembly...";
    await pyodide.loadPackage("numpy");

    statusText.textContent = "Loading external Python module (calculate_stats.py)...";
    await loadPythonScript();

    // Write calculate_stats.py to Pyodide virtual filesystem
    pyodide.FS.writeFile("calculate_stats.py", pythonScriptContent);

    // Update code preview block if present
    if (pythonScriptPreview) {
      pythonScriptPreview.textContent = pythonScriptContent;
    }

    isReady = true;
    statusBar.className = "status-bar ready";
    statusSpinner.style.display = "none";
    statusText.textContent = "✅ Pyodide, NumPy & calculate_stats.py ready in MEMFS!";
    calcBtn.disabled = false;

    // Auto-run on load with default data
    calculateStats();
  } catch (err) {
    console.error("Pyodide loading error:", err);
    statusBar.className = "status-bar error";
    statusSpinner.style.display = "none";
    statusText.textContent = "❌ Failed to load Pyodide/NumPy: " + (err.message || err);
  }
}

// Run calculation by writing data to virtual filesystem and executing Python module
function calculateStats() {
  if (!isReady || !pyodide) return;

  errorAlert.style.display = "none";
  errorAlert.textContent = "";

  const rawText = dataInput.value.trim();
  if (!rawText) {
    showError("Please enter some numbers or click 'Generate Random Data'.");
    return;
  }

  try {
    let stdoutBuffer = "";
    pyodide.setStdout({
      batched: (msg) => {
        stdoutBuffer += msg + "\n";
      }
    });

    // 1. Write input data as a text file to Pyodide's virtual filesystem (MEMFS)
    const filename = "input_data.txt";
    pyodide.FS.writeFile(filename, rawText);

    // 2. Ensure calculate_stats.py is current in MEMFS
    pyodide.FS.writeFile("calculate_stats.py", pythonScriptContent);

    // 3. Import and execute calculate_stats from virtual filesystem
    const runnerCode = `
import calculate_stats
import importlib
importlib.reload(calculate_stats)
calculate_stats.calculate("${filename}")
`;

    const jsonStr = pyodide.runPython(runnerCode);
    const res = JSON.parse(jsonStr);

    // Display results
    document.getElementById("valCount").textContent = res.count;
    document.getElementById("valMean").textContent = res.mean.toFixed(4);
    document.getElementById("valStd").textContent = res.std.toFixed(4);
    document.getElementById("valVar").textContent = res.var.toFixed(4);
    document.getElementById("valMin").textContent = res.min.toFixed(4);
    document.getElementById("valMax").textContent = res.max.toFixed(4);

    if (pythonStdout) {
      pythonStdout.textContent = stdoutBuffer.trim() || "Script completed successfully.";
    }

    resultsCard.style.display = "block";
  } catch (err) {
    console.error("Execution error:", err);
    let msg = err.message || String(err);
    if (msg.includes("ValueError:")) {
      msg = msg.split("ValueError:").pop().trim();
    }
    showError(msg);
  }
}

function showError(message) {
  errorAlert.textContent = "Error: " + message;
  errorAlert.style.display = "block";
  resultsCard.style.display = "none";
}

// Generate random numbers
function generateRandomData(count = 15) {
  const arr = [];
  for (let i = 0; i < count; i++) {
    const val = (Math.random() * 100).toFixed(2);
    arr.push(val);
  }
  dataInput.value = arr.join(", ");
  if (isReady) {
    calculateStats();
  }
}

// Event listeners
calcBtn.addEventListener("click", calculateStats);
genRandomBtn.addEventListener("click", () => generateRandomData(15));
clearBtn.addEventListener("click", () => {
  dataInput.value = "";
  resultsCard.style.display = "none";
  errorAlert.style.display = "none";
});

dataInput.addEventListener("keydown", (e) => {
  if (e.ctrlKey && e.key === "Enter") {
    calculateStats();
  }
});

// Start loading on page ready
window.addEventListener("DOMContentLoaded", () => {
  initPyodide();
  fetch("navbar.html")
    .then((res) => {
      if (res.ok) return res.text();
      throw new Error("Not found");
    })
    .then((html) => {
      const el = document.getElementById("navbar-placeholder");
      if (el) el.innerHTML = html;
    })
    .catch(() => {
      // Gracefully ignore fetch error (e.g. if opened via direct file://)
    });
});

