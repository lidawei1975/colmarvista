// Web Worker for Pyodide & ChemEx execution
importScripts("https://cdn.jsdelivr.net/pyodide/v0.28.0/full/pyodide.js");

let pyodide = null;
let isReady = false;

// Resolve paths relative to web root
function getUrl(relPath) {
  return new URL(relPath, self.location.href).href;
}

// Initialize Pyodide and all dependencies inside worker
async function initWorker() {
  try {
    self.postMessage({ type: "status", text: "Loading Pyodide v0.28.0 (Python 3.13) in Worker..." });
    pyodide = await loadPyodide({
      indexURL: "https://cdn.jsdelivr.net/pyodide/v0.28.0/full/"
    });

    // Configure standard output streaming to main thread
    pyodide.setStdout({
      batched: (msg) => {
        self.postMessage({ type: "stdout", text: msg + "\n" });
      }
    });
    pyodide.setStderr({
      batched: (msg) => {
        self.postMessage({ type: "stderr", text: msg + "\n" });
      }
    });

    self.postMessage({ type: "status", text: "Loading scientific packages (numpy, scipy, matplotlib, pygments, micropip)..." });
    await pyodide.loadPackage(["numpy", "scipy", "matplotlib", "pygments", "micropip"]);

    const micropip = pyodide.pyimport("micropip");

    self.postMessage({ type: "status", text: "Installing ChemEx dependencies (pydantic, lmfit, rich, etc.)..." });
    try {
      await micropip.install(["pydantic", "lmfit", "rich", "annotated-types", "cachetools", "emcee"]);
    } catch (e) {
      console.warn("Some optional micropip packages could not be installed from PyPI:", e);
    }

    self.postMessage({ type: "status", text: "Fetching ChemEx wheel from chemex/ folder..." });
    const wheelUrl = getUrl("../chemex/chemex-2026.1.0-py3-none-any.whl");
    const wheelRes = await fetch(wheelUrl);
    if (!wheelRes.ok) throw new Error(`Could not fetch chemex wheel from ${wheelUrl}: HTTP ${wheelRes.status}`);
    const wheelBytes = new Uint8Array(await wheelRes.arrayBuffer());
    pyodide.FS.writeFile("/home/pyodide/chemex-2026.1.0-py3-none-any.whl", wheelBytes);

    self.postMessage({ type: "status", text: "Loading chemex_runner.py helper..." });
    const runnerUrl = getUrl("../chemex_runner.py?t=" + Date.now());
    const runnerRes = await fetch(runnerUrl);
    if (!runnerRes.ok) throw new Error(`Could not fetch chemex_runner.py from ${runnerUrl}: HTTP ${runnerRes.status}`);
    const runnerCode = await runnerRes.text();
    pyodide.FS.writeFile("/home/pyodide/chemex_runner.py", runnerCode);

    // Install ChemEx wheel into site-packages and configure sys.path
    pyodide.runPython(`
import sys, os, zipfile, site

home_dir = os.path.abspath("/home/pyodide")
if home_dir not in sys.path:
    sys.path.insert(0, home_dir)

wheel_file = os.path.join(home_dir, "chemex-2026.1.0-py3-none-any.whl")
site_pkgs = site.getsitepackages()
target_dir = site_pkgs[0] if site_pkgs else "/lib/python3.13/site-packages"

with zipfile.ZipFile(wheel_file, "r") as zf:
    zf.extractall(target_dir)

import chemex
import chemex_runner
print(f"> [ChemEx Worker] Installed ChemEx v{chemex.__version__} into {target_dir}")
`);

    self.postMessage({ type: "status", text: "Writing CEST_15N dataset to virtual filesystem..." });
    const filesWritten = await writeCestDataset();

    isReady = true;
    const pyVer = pyodide.runPython("import sys; sys.version.split()[0]");
    const chemexVer = pyodide.runPython("import chemex; chemex.__version__");
    const virtualFiles = JSON.parse(pyodide.runPython("import json, chemex_runner; json.dumps(chemex_runner.get_virtual_files('CEST_15N'))"));

    self.postMessage({
      type: "ready",
      pythonVersion: pyVer,
      chemexVersion: chemexVer,
      filesWritten: filesWritten,
      virtualFiles: virtualFiles
    });
  } catch (err) {
    console.error("Worker initialization error:", err);
    self.postMessage({ type: "init_error", error: err.message || String(err) });
  }
}

// Write the CEST_15N files into MEMFS
async function writeCestDataset() {
  const manifestUrl = getUrl("../chemex/CEST_15N/files_manifest.json");
  const res = await fetch(manifestUrl);
  if (!res.ok) throw new Error(`Could not fetch files_manifest.json: HTTP ${res.status}`);
  const manifestJsonText = await res.text();

  pyodide.globals.set("manifest_str", manifestJsonText);
  const count = pyodide.runPython(`
import chemex_runner
chemex_runner.write_virtual_files(manifest_str)
`);
  return count;
}

// Handle messages from Main Thread
self.onmessage = async function (e) {
  const data = e.data || {};

  if (data.type === "init") {
    await initWorker();
  } else if (data.type === "sync_dataset") {
    try {
      const count = await writeCestDataset();
      const virtualFiles = JSON.parse(pyodide.runPython("import json, chemex_runner; json.dumps(chemex_runner.get_virtual_files('CEST_15N'))"));
      self.postMessage({ type: "dataset_synced", count: count, virtualFiles: virtualFiles });
    } catch (err) {
      self.postMessage({ type: "error", error: err.message || String(err) });
    }
  } else if (data.type === "run_chemex") {
    if (!isReady || !pyodide) {
      self.postMessage({ type: "run_error", error: "Worker is not ready yet." });
      return;
    }
    try {
      const command = data.command || "fit";
      const includeResidue = data.includeResidue || null;
      const outputDir = data.outputDir || (command === "simulate" ? "OutputSim" : "Output");

      pyodide.globals.set("cmd_type", command);
      pyodide.globals.set("inc_res", includeResidue);
      pyodide.globals.set("out_dir", outputDir);

      const pyScript = `
import chemex_runner
chemex_runner.run_chemex_command(command=cmd_type, include_residue=inc_res, output_dir=out_dir)
`;
      const resultStr = pyodide.runPython(pyScript);
      const result = JSON.parse(resultStr);
      const virtualFiles = JSON.parse(pyodide.runPython("import json, chemex_runner; json.dumps(chemex_runner.get_virtual_files('CEST_15N'))"));

      self.postMessage({
        type: "run_complete",
        command: command,
        outputDir: outputDir,
        result: result,
        virtualFiles: virtualFiles
      });
    } catch (err) {
      console.error("Worker execution error:", err);
      self.postMessage({ type: "run_error", error: err.message || String(err) });
    }
  } else if (data.type === "read_file") {
    try {
      const fullRelPath = `${data.outputDir}/${data.filename}`;
      pyodide.globals.set("view_path", fullRelPath);
      const isBinary = /\.(pdf|png|jpg|jpeg)$/i.test(data.filename);
      if (isBinary) {
        const b64 = pyodide.runPython(`
import chemex_runner
chemex_runner.read_virtual_file_bytes(view_path, base_dir="CEST_15N")
`);
        self.postMessage({
          type: "file_content",
          outputDir: data.outputDir,
          filename: data.filename,
          isBinary: true,
          content: b64
        });
      } else {
        const content = pyodide.runPython(`
import chemex_runner
chemex_runner.read_virtual_file(view_path, base_dir="CEST_15N")
`);
        self.postMessage({
          type: "file_content",
          outputDir: data.outputDir,
          filename: data.filename,
          isBinary: false,
          content: content
        });
      }
    } catch (err) {
      self.postMessage({
        type: "file_error",
        filename: data.filename,
        error: err.message || String(err)
      });
    }
  } else if (data.type === "get_residue_data") {
    if (!isReady || !pyodide) {
      self.postMessage({ type: "residue_data_error", error: "Worker not ready yet." });
      return;
    }
    try {
      const residue = data.residue || "13N";
      pyodide.globals.set("res_name", residue);
      const pyScript = `
import chemex_runner
chemex_runner.get_residue_profile_data(residue=res_name)
`;
      const resJson = pyodide.runPython(pyScript);
      const resData = JSON.parse(resJson);
      self.postMessage({
        type: "residue_data_result",
        residue: residue,
        data: resData
      });
    } catch (err) {
      console.error("Error fetching residue profile:", err);
      self.postMessage({
        type: "residue_data_error",
        residue: data.residue,
        error: err.message || String(err)
      });
    }
  } else if (data.type === "simulate_residue") {
    if (!isReady || !pyodide) {
      return;
    }
    try {
      const residue = data.residue || "13N";
      pyodide.globals.set("res_name", residue);
      pyodide.globals.set("res_params", JSON.stringify(data.params || {}));
      const pyScript = `
import chemex_runner, json
chemex_runner.simulate_residue_lines(residue=res_name, params_override=json.loads(res_params))
`;
      const resJson = pyodide.runPython(pyScript);
      const resData = JSON.parse(resJson);
      self.postMessage({
        type: "simulation_update_result",
        residue: residue,
        data: resData
      });
    } catch (err) {
      console.error("Error calculating live simulation:", err);
    }
  } else if (data.type === "fit_from_user_params") {
    if (!isReady || !pyodide) {
      self.postMessage({ type: "user_fit_error", error: "Worker not ready yet." });
      return;
    }
    try {
      const residue = data.residue || "13N";
      const outputDir = data.outputDir || "Output";
      pyodide.globals.set("fit_res", residue);
      pyodide.globals.set("fit_params", JSON.stringify(data.params || {}));
      pyodide.globals.set("fit_out_dir", outputDir);

      const pyScript = `
import chemex_runner, json
params_dict = json.loads(fit_params)
# 1. Update starting parameters in Parameters/parameters.toml
chemex_runner.update_parameters_toml("Parameters/parameters.toml", fit_res, params_dict)

# 2. Run ChemEx Fit for this residue
run_res_str = chemex_runner.run_chemex_command(command="fit", include_residue=fit_res, output_dir=fit_out_dir)
run_res = json.loads(run_res_str)

# 3. Read fitted parameters and errors
fitted_params = chemex_runner.read_fitted_parameters(output_dir=fit_out_dir, residue=fit_res)

# 4. Generate updated curve with best-fit values
prof_res_str = chemex_runner.get_residue_profile_data(residue=fit_res)
prof_res = json.loads(prof_res_str)

virtual_files = chemex_runner.get_virtual_files("CEST_15N")

json.dumps({
    "status": "success",
    "residue": fit_res,
    "output_dir": fit_out_dir,
    "run_result": run_res,
    "fitted_params": fitted_params,
    "calc_13hz": prof_res.get("calc_13hz", []),
    "calc_26hz": prof_res.get("calc_26hz", []),
    "params": prof_res.get("params", {}),
    "virtual_files": virtual_files
})
`;
      const resJson = pyodide.runPython(pyScript);
      const resData = JSON.parse(resJson);

      self.postMessage({
        type: "fit_complete_with_params",
        residue: residue,
        outputDir: outputDir,
        data: resData
      });
    } catch (err) {
      console.error("Error during user fit:", err);
      self.postMessage({
        type: "user_fit_error",
        residue: data.residue,
        error: err.message || String(err)
      });
    }
  }
};

