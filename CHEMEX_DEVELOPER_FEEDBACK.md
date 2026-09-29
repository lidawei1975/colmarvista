# ChemEx WebAssembly (Pyodide) Integration & API Feedback

**From:** COLMARVista Development Team  
**To:** ChemEx Developers  
**Topic:** WebAssembly (Pyodide) Runtime Compatibility & Programmatic Simulation API Stability  

---

## 1. Context & Motivation

In **COLMARVista**, we have integrated ChemEx directly into an interactive, client-side NMR web application running in modern web browsers via **Pyodide (Python 3.13 / WebAssembly)**.

Users can pick peaks, run automated CEST pre-analysis, and adjust exchange parameters ($k_{ex}$, $p_B$, $\varpi_A$, $\Delta\varpi_{AB}$) using interactive sliders that recalculate and visualize simulated CEST profile curves on-the-fly (~30–80 ms response time). Users can also run full ChemEx fits (either single-peak or global multi-peak) entirely on their local machine without requiring a remote server backend.

Below are notes on:
1. Adjustments currently required to run ChemEx cleanly in WebAssembly / Pyodide.
2. The specific internal ChemEx functions we call directly for real-time simulation (bypassing the CLI `main()` for speed), with a request to keep these interfaces stable across future releases.

---

## 2. Modifications Required to Run in WebAssembly (Pyodide)

WebAssembly running in a browser provides a POSIX-compliant virtual in-memory filesystem (MEMFS) and standard Python interpreter, but has two primary system-level constraints:
- **No OS threading support** (`threading.Thread.start()` throws `RuntimeError: can't start new thread`).
- **Fixed package versions** provided by Pyodide's pre-built wheel ecosystem.

### A. Background Threads in `rich.live` / `rich.progress`
- **Issue**: ChemEx uses `rich` for animated terminal output and spinners. When `rich.live.Live` or `rich.progress.Progress` starts its background refresh thread, WebAssembly raises:
  ```text
  RuntimeError: can't start new thread
  ```
- **Current Workaround**: We monkey-patch `rich.live.Live` to disable the background refresh thread:
  ```python
  import rich.live
  rich.live.Live.start = lambda self, *a, **k: setattr(self, "_is_started", True)
  rich.live.Live.stop = lambda self, *a, **k: setattr(self, "_is_started", False)
  ```
- **Suggestion**: Consider checking `sys.platform == "emscripten"` or guarding thread creation so that terminal UI animations gracefully degrade to synchronous / non-threaded logging when running in WebAssembly.

---

### B. Strict SciPy Version Check in Direct TRF Optimizer
- **Issue**: ChemEx 2026.9.1 introduces a numerical compatibility check in `chemex.optimize.direct_trf`:
  `_scipy_satisfies_numerical_compatibility` strictly requires `scipy == 1.18.x`.  
  Pyodide (v0.28.0) ships with SciPy 1.14 / 1.15. The underlying least-squares engine (`scipy.optimize.least_squares(method="trf")`) is functionally identical and produces correct convergence results.
- **Current Workaround**: We bypass this check at runtime:
  ```python
  import chemex.optimize.direct_trf
  chemex.optimize.direct_trf._scipy_satisfies_numerical_compatibility = lambda version: True
  ```
- **Suggestion**: Consider allowing a broader version range (e.g., `scipy >= 1.14`) or providing an environment variable / flag (e.g. `CHEMEX_RELAX_SCIPY_CHECK=1`) to allow execution in embedded and WASM environments.

---

### C. Optional Native Dependencies (`rapidfuzz`)
- **Note**: Packaging ChemEx as a pure Python wheel (`chemex-2026.x-py3-none-any.whl`) is ideal for Pyodide because it installs directly via `micropip`.
- If optional dependencies with C-extensions (like `rapidfuzz`) are not compiled for Pyodide, ChemEx would fail on import. Providing a lightweight pure-Python fallback (e.g. using `difflib.get_close_matches` for command/option typo suggestions) ensures compatibility across environments without prebuilt binary wheels.

---

## 3. Functions Called Directly for High-Speed Simulation (Bypassing CLI `main()`)

When users adjust parameter sliders in the web interface, calling the command-line entrypoint `chemex.chemex.main(["simulate", ...])` is too slow because it re-parses CLI arguments, re-discovers plugins, generates Matplotlib figure files, and writes multiple files to disk.

To achieve interactive, real-time simulation updates, we invoke the calculation engine directly in memory. **We would greatly appreciate keeping these interfaces stable in future releases, or providing an official public programmatic facade:**

```python
from pathlib import Path
from chemex.runtime import AnalysisSession, ensure_plugins_registered
from chemex.configuration.methods import Method, Selection
from chemex.experiments.builder import build_experiments
from chemex.configuration.parameters import read_defaults
from chemex.parameters.spin_system import SpinSystem
from chemex.plotters.cest import create_plot_data_calc, create_plot_data_exp

# 1. Initialize session and model
ensure_plugins_registered()
session = AnalysisSession.create()
session.set_model("2st")

# 2. Select spin system / residue and build experiments
selection = Selection(include=[SpinSystem.from_name(residue)], exclude=None)
experiments = build_experiments([Path(p) for p in exp_files], selection, session=session)

# 3. Load parameters and resolve values
defaults = read_defaults([Path(p) for p in param_files])
session.parameters.set_defaults(defaults)
session.try_build_analysis_values()

snapshot = session.analysis_values.snapshot()
parameterization = session.compile_parameterization(Method(), experiments.param_ids)
resolved_values = parameterization.resolve(parameterization.frame_from_snapshot(snapshot))

# 4. In-memory back-calculation (core simulation engine)
experiments.back_calculate_from_values(resolved_values)

# 5. Extract calculated curve coordinates (Hz offset, ppm, intensity)
for experiment in experiments:
    spectrometer = getattr(experiment, "spectrometer", None)
    for profile in experiment.profiles:
        if str(profile.spin_system) == residue:
            prof_spectrometer = getattr(profile, "spectrometer", spectrometer)
            d_calc = create_plot_data_calc(profile)
            # d_calc.metadata provides offsets (Hz)
            # d_calc.calc provides calculated intensities
```

---

## 4. API Suggestions / Requests

1. **Official Python Programmatic API**:  
   If possible, please consider providing an official public programmatic interface (e.g., `chemex.api.simulate(...)` or `chemex.api.fit(...)`) that returns in-memory data structures rather than writing to disk.
2. **Interface Stability**:  
   If any of the classes or methods above (`AnalysisSession`, `build_experiments`, `back_calculate_from_values`, `create_plot_data_calc`) are slated for refactoring, please let us know the intended migration path so we can keep WebAssembly / COLMARVista compatibility intact.

---

Thank you again for creating and maintaining ChemEx!

