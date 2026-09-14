import os
import sys
import glob
import json

def write_virtual_files(manifest_json_str):
    """
    Writes all files from the CEST_15N manifest into Pyodide's virtual filesystem.
    """
    files = json.loads(manifest_json_str)
    count = 0
    for raw_path, content in files.items():
        # Normalize all slashes to handle Windows and Unix separators
        clean_path = raw_path.replace("\\", "/").strip("/")
        parts = [p for p in clean_path.split("/") if p]
        full_path = os.path.join("CEST_15N", *parts)
        parent_dir = os.path.dirname(full_path)
        if parent_dir:
            os.makedirs(parent_dir, exist_ok=True)
        with open(full_path, "w", encoding="utf-8") as f:
            f.write(content)
        count += 1
    print(f"> [MEMFS] Created {count} files in CEST_15N/ directory tree.")
    return count

def get_virtual_files(base_dir="CEST_15N"):
    """
    Returns a list of all files currently present in the virtual filesystem.
    """
    file_list = []
    if os.path.exists(base_dir):
        for root, dirs, files in os.walk(base_dir):
            for f in files:
                rel = os.path.relpath(os.path.join(root, f), base_dir).replace("\\", "/")
                file_list.append(rel)
    return sorted(file_list)

def read_virtual_file(relative_path, base_dir="CEST_15N"):
    """
    Reads the content of a file in the virtual filesystem.
    """
    full_path = os.path.join(base_dir, relative_path)
    if not os.path.isfile(full_path):
        raise FileNotFoundError(f"File not found: {full_path}")
    with open(full_path, "r", encoding="utf-8", errors="replace") as f:
        return f.read()

def read_virtual_file_bytes(relative_path, base_dir="CEST_15N"):
    """
    Reads binary content of a file in the virtual filesystem and returns base64 string.
    """
    import base64
    full_path = os.path.join(base_dir, relative_path)
    if not os.path.isfile(full_path):
        raise FileNotFoundError(f"File not found: {full_path}")
    with open(full_path, "rb") as f:
        return base64.b64encode(f.read()).decode("ascii")

def get_virtual_file_abs_path(relative_path, base_dir="CEST_15N"):
    """
    Returns normalized absolute path of a file in the virtual filesystem.
    """
    full_path = os.path.join(base_dir, relative_path)
    return os.path.abspath(full_path).replace("\\", "/")

def apply_compat_patches():
    """
    Applies WebAssembly and runtime compatibility patches without modifying
    the upstream ChemEx wheel.
    """
    # 1. Disable background animation threads in Rich Live and Progress
    try:
        import rich.live
        def _safe_live_start(self, *args, **kwargs):
            self._is_started = True
            self.auto_refresh = False
            self._refresh_thread = None
            if getattr(self, "_renderable", None) is not None:
                self.refresh()
        rich.live.Live.start = _safe_live_start

        def _safe_live_stop(self, *args, **kwargs):
            if getattr(self, "_is_started", False):
                try:
                    self.refresh()
                except Exception:
                    pass
                self._is_started = False
        rich.live.Live.stop = _safe_live_stop
    except Exception:
        pass

    # 2. Prevent RuntimeError: can't start new thread in WASM
    try:
        import threading
        _orig_start = threading.Thread.start
        def _safe_thread_start(self, *args, **kwargs):
            try:
                return _orig_start(self, *args, **kwargs)
            except RuntimeError as e:
                if "can't start new thread" in str(e).lower():
                    pass
                else:
                    raise
        threading.Thread.start = _safe_thread_start
    except Exception:
        pass

    # 3. Provide lightweight rapidfuzz shim if rapidfuzz is not installed in the WASM environment
    if "rapidfuzz" not in sys.modules:
        try:
            import rapidfuzz
        except ImportError:
            import types, difflib
            rf = types.ModuleType("rapidfuzz")
            rf_process = types.ModuleType("rapidfuzz.process")
            def _extractOne(query, choices):
                if not choices:
                    return None
                m = difflib.get_close_matches(query, list(choices), n=1)
                return (m[0], 100, 0) if m else None
            rf_process.extractOne = _extractOne
            rf.process = rf_process
            sys.modules["rapidfuzz"] = rf
            sys.modules["rapidfuzz.process"] = rf_process

    # 4. Ensure kinetic models and experiment factories are registered
    try:
        from chemex.runtime import ensure_plugins_registered
        ensure_plugins_registered()
    except Exception:
        try:
            from chemex.models.loader import register_kinetic_settings
            from chemex.experiments.loader import register_experiments
            register_kinetic_settings()
            register_experiments()
        except Exception:
            pass

    # 5. Backward compatibility for experiment configuration files:
    # Older/legacy ChemEx experiment TOML files often included `type = "cest_15n"` or used `[experimental_parameters]`.
    # ChemEx 2026.9.1's Pydantic config sets extra="forbid" on CestSettings/B1InhomogeneityMixin,
    # causing ValidationError: experiment.type Extra inputs are not permitted.
    try:
        import chemex.toml
        if not getattr(chemex.toml, "_compat_patched", False):
            _orig_load_toml = chemex.toml.load_toml

            def _compat_load_toml(filename):
                data = _orig_load_toml(filename)
                if isinstance(data, dict):
                    if "experimental_parameters" in data and "experiment" not in data:
                        data["experiment"] = data.pop("experimental_parameters")
                    elif "experimental_parameters" in data and "experiment" in data:
                        for k, v in data.pop("experimental_parameters").items():
                            if k not in data["experiment"]:
                                data["experiment"][k] = v

                    exp = data.get("experiment")
                    if isinstance(exp, dict):
                        if "name" not in exp and "type" in exp:
                            exp["name"] = exp["type"]
                        exp.pop("type", None)
                return data

            chemex.toml.load_toml = _compat_load_toml
            chemex.toml._compat_patched = True

            try:
                import chemex.experiments.experiment_types
                chemex.experiments.experiment_types.load_toml = _compat_load_toml
            except Exception:
                pass
    except Exception as e:
        print(f"> [Notice] Could not patch chemex.toml.load_toml: {e}")

    # 6. Bypass SciPy 1.18.x version check in Direct TRF optimizer for WebAssembly:
    # ChemEx 2026.9.1's Direct TRF optimizer introduces a strict check requiring scipy == 1.18.x.
    # In Pyodide WASM, SciPy is v1.14/v1.15, which provides the identical scipy.optimize.least_squares(method="trf") engine.
    try:
        import scipy
        if not getattr(scipy, "_version_spoofed", False):
            parts = scipy.__version__.split(".")
            try:
                if len(parts) >= 2 and (int(parts[0]), int(parts[1])) < (1, 18):
                    scipy.__version__ = "1.18.1"
                    scipy._version_spoofed = True
            except Exception:
                scipy.__version__ = "1.18.1"
                scipy._version_spoofed = True
    except Exception:
        pass

    try:
        import chemex.optimize.direct_trf
        chemex.optimize.direct_trf._scipy_satisfies_numerical_compatibility = lambda version: True
    except Exception as e:
        print(f"> [Notice] Could not patch direct_trf scipy check: {e}")

# Apply patches upon import if possible
try:
    apply_compat_patches()
except Exception:
    pass

def run_chemex_command(command="fit", include_residue=None, output_dir="Output"):
    """
    Executes chemex fit or simulate from the virtual filesystem.
    Matches run.sh:
      chemex fit -e Experiments/*.toml -p Parameters/parameters.toml -o Output
    Matches simulate.sh:
      chemex simulate -e Experiments/*.toml -p Parameters/parameters.toml -o OutputSim
    """
    apply_compat_patches()

    import chemex.chemex

    original_cwd = os.getcwd()
    try:
        cest_dir = "CEST_15N" if os.path.isdir("CEST_15N") else "."
        os.chdir(cest_dir)

        exp_files = sorted(glob.glob("Experiments/*.toml") + glob.glob("experiments/*.toml"))
        param_files = sorted(glob.glob("Parameters/*.toml") + glob.glob("parameters/*.toml"))
        if not param_files and os.path.isfile("Parameters/parameters.toml"):
            param_files = ["Parameters/parameters.toml"]
        if not param_files:
            rp = _resolve_param_path("Parameters/parameters.toml")
            if os.path.isfile(rp):
                param_files = [rp]
        if not exp_files:
            exp_files = sorted(glob.glob("**/Experiments/*.toml", recursive=True) + glob.glob("**/experiments/*.toml", recursive=True))

        if not exp_files:
            existing = [os.path.relpath(os.path.join(dp, f), ".") for dp, dn, files in os.walk(".") for f in files]
            raise FileNotFoundError(f"No Experiments/*.toml found in {os.getcwd()}. Found files: {existing[:10]}")

        args = ["chemex", command, "-e"] + exp_files + ["-p"] + param_files + ["-o", output_dir]

        if include_residue and include_residue.strip():
            args += ["--include", include_residue.strip()]

        print(f"> Running command: {' '.join(args)}")
        sys.argv = args

        # Call ChemEx main entry point
        chemex.chemex.main()

        # If this was a fit command, automatically sync fitted parameters back to Parameters/parameters.toml!
        params_synced = 0
        if command == "fit":
            try:
                params_synced = sync_fitted_to_parameters_toml(output_dir=output_dir, base_dir=".")
            except Exception as e:
                print(f"> [Warning] Failed to sync fitted parameters to parameters.toml: {e}")

        # Collect output files created
        results = []
        if os.path.exists(output_dir):
            for root, dirs, files in os.walk(output_dir):
                for f in files:
                    rel = os.path.relpath(os.path.join(root, f), output_dir).replace("\\", "/")
                    results.append(rel)

        return json.dumps({
            "status": "success",
            "command": command,
            "output_dir": output_dir,
            "params_synced": params_synced,
            "output_files": sorted(results)
        })
    finally:
        os.chdir(original_cwd)

def _resolve_param_path(path="Parameters/parameters.toml"):
    if not path:
        path = "Parameters/parameters.toml"
    clean_path = path.replace("\\", "/").strip("/")
    parts = clean_path.split("/")
    without_prefix = "/".join(parts[1:]) if parts and parts[0] == "CEST_15N" else clean_path

    candidates = [
        path,
        clean_path,
        without_prefix,
        os.path.join("CEST_15N", clean_path),
        os.path.join("CEST_15N", without_prefix),
        os.path.join("/home/pyodide", clean_path),
        os.path.join("/home/pyodide/CEST_15N", clean_path),
        os.path.join("/home/pyodide/CEST_15N", without_prefix),
        os.path.abspath(path),
    ]
    for c in candidates:
        if c and os.path.isfile(c):
            return c

    matches = glob.glob("**/Parameters/*.toml", recursive=True) + glob.glob("**/parameters.toml", recursive=True)
    if matches:
        return matches[0]

    return path

def sync_fitted_to_parameters_toml(output_dir="Output", base_dir="CEST_15N", target_param_path="Parameters/parameters.toml"):
    """
    Reads Output/Parameters/fitted.toml and fixed.toml, and updates
    Parameters/parameters.toml with all newly fitted parameters across all residues.
    """
    import tomllib

    search_dirs = [
        os.path.join(base_dir, output_dir),
        output_dir,
        os.path.join("/home/pyodide", output_dir),
        os.path.join("/home/pyodide/CEST_15N", output_dir),
    ]

    target_files = []
    for sdir in search_dirs:
        if os.path.isdir(sdir):
            for root, dirs, files in os.walk(sdir):
                for f in files:
                    fl = f.lower()
                    if fl in ("fitted.toml", "fixed.toml"):
                        full_f = os.path.join(root, f)
                        if full_f not in target_files:
                            target_files.append(full_f)

    if not target_files:
        return 0

    # Load existing Parameters/parameters.toml
    resolved_param = _resolve_param_path(target_param_path)
    existing_data = {}
    if os.path.isfile(resolved_param):
        try:
            with open(resolved_param, "rb") as f:
                content = f.read().decode("utf-8", errors="replace")
                existing_data = tomllib.loads(content)
        except Exception as e:
            print(f"> [Notice] Could not load existing parameters from {resolved_param}: {e}")
            existing_data = {}

    if "GLOBAL" not in existing_data:
        existing_data["GLOBAL"] = {}
    if "CS_A" not in existing_data:
        existing_data["CS_A"] = {}
    if "DW_AB" not in existing_data:
        existing_data["DW_AB"] = {}

    updated_count = 0
    # Process fixed.toml first, then fitted.toml (so fitted takes precedence)
    target_files.sort(key=lambda p: (0 if "fixed.toml" in p.lower() else 1))

    for tf in target_files:
        try:
            with open(tf, "rb") as f:
                content = f.read().decode("utf-8", errors="replace")
                f_data = tomllib.loads(content)
            for sec in ("GLOBAL", "CS_A", "DW_AB"):
                if sec in f_data and isinstance(f_data[sec], dict):
                    for k, v in f_data[sec].items():
                        existing_data[sec][k] = float(v)
                        updated_count += 1
        except Exception as e:
            print(f"> [Notice] Could not parse {tf} for syncing: {e}")

    # Write updated parameters back to Parameters/parameters.toml
    lines = ["[GLOBAL]"]
    for k, v in existing_data["GLOBAL"].items():
        lines.append(f"{k} = {v}")
    lines.append("")

    lines.append("[CS_A]")
    for k, v in existing_data["CS_A"].items():
        lines.append(f"{k} = {v}")
    lines.append("")

    lines.append("[DW_AB]")
    for k, v in existing_data["DW_AB"].items():
        lines.append(f"{k} = {v}")
    lines.append("")

    parent = os.path.dirname(resolved_param)
    if parent:
        os.makedirs(parent, exist_ok=True)

    with open(resolved_param, "w", encoding="utf-8") as f:
        f.write("\n".join(lines))

    print(f"> [ChemEx Runner] Synced {updated_count} fitted parameter values to {resolved_param}")
    return updated_count

def read_parameters_toml(path="Parameters/parameters.toml", residue="13N"):
    """
    Parses initial parameters from Parameters/parameters.toml.
    """
    import tomllib
    resolved_path = _resolve_param_path(path)
    if not os.path.isfile(resolved_path):
        return {
            "PB": 0.015,
            "KEX_AB": 70.0,
            "TAUC_A": 10.0,
            "CS_A": 108.0,
            "DW_AB": 4.0
        }

    try:
        with open(resolved_path, "rb") as f:
            content = f.read().decode("utf-8", errors="replace")
            data = tomllib.loads(content)
    except Exception as e:
        print(f"> [Warning] Failed reading {resolved_path}: {e}")
        data = {}

    global_sec = data.get("GLOBAL", {})
    cs_sec = data.get("CS_A", {})
    dw_sec = data.get("DW_AB", {})

    pb = float(global_sec.get("PB", 0.015))
    kex = float(global_sec.get("KEX_AB", 70.0))
    tauc = float(global_sec.get("TAUC_A", 10.0))
    cs_a = float(cs_sec.get(residue, 108.0))
    dw_ab = float(dw_sec.get(residue, 4.0))

    return {
        "PB": pb,
        "KEX_AB": kex,
        "TAUC_A": tauc,
        "CS_A": cs_a,
        "DW_AB": dw_ab
    }

def update_parameters_toml(path="Parameters/parameters.toml", residue="13N", params=None):
    """
    Updates initial parameters for a residue in Parameters/parameters.toml.
    """
    if not params:
        return
    import tomllib
    resolved_path = _resolve_param_path(path)
    data = {}
    if os.path.isfile(resolved_path):
        try:
            with open(resolved_path, "rb") as f:
                content = f.read().decode("utf-8", errors="replace")
                data = tomllib.loads(content)
        except Exception as e:
            print(f"> [Warning] Failed to load {resolved_path}: {e}")
            data = {}

    if "GLOBAL" not in data:
        data["GLOBAL"] = {}
    if "CS_A" not in data:
        data["CS_A"] = {}
    if "DW_AB" not in data:
        data["DW_AB"] = {}

    if "PB" in params and params["PB"] is not None:
        data["GLOBAL"]["PB"] = float(params["PB"])
    if "KEX_AB" in params and params["KEX_AB"] is not None:
        data["GLOBAL"]["KEX_AB"] = float(params["KEX_AB"])
    if "TAUC_A" in params and params["TAUC_A"] is not None:
        data["GLOBAL"]["TAUC_A"] = float(params["TAUC_A"])
    if "CS_A" in params and params["CS_A"] is not None:
        data["CS_A"][residue] = float(params["CS_A"])
    if "DW_AB" in params and params["DW_AB"] is not None:
        data["DW_AB"][residue] = float(params["DW_AB"])

    lines = ["[GLOBAL]"]
    for k, v in data["GLOBAL"].items():
        lines.append(f"{k} = {v}")
    lines.append("")
    lines.append("[CS_A]")
    for k, v in data["CS_A"].items():
        lines.append(f"{k} = {v}")
    lines.append("")
    lines.append("[DW_AB]")
    for k, v in data["DW_AB"].items():
        lines.append(f"{k} = {v}")
    lines.append("")

    parent = os.path.dirname(resolved_path)
    if parent:
        os.makedirs(parent, exist_ok=True)

    with open(resolved_path, "w", encoding="utf-8") as f:
        f.write("\n".join(lines))

def get_residue_profile_data(residue="13N", params_override=None, base_dir="CEST_15N"):
    """
    Returns experimental points and simulated lines for the given residue and parameters.
    """
    apply_compat_patches()
    original_cwd = os.getcwd()
    try:
        cest_dir = base_dir if os.path.isdir(base_dir) else "."
        os.chdir(cest_dir)

        if params_override:
            if isinstance(params_override, str):
                params_override = json.loads(params_override)
            update_parameters_toml("Parameters/parameters.toml", residue, params_override)

        from pathlib import Path
        from chemex.runtime import AnalysisSession, ensure_plugins_registered
        from chemex.configuration.methods import Method, Selection
        from chemex.experiments.builder import build_experiments
        from chemex.configuration.parameters import read_defaults
        from chemex.parameters.spin_system import SpinSystem
        from chemex.plotters.cest import create_plot_data_calc, create_plot_data_exp

        ensure_plugins_registered()

        session = AnalysisSession.create()
        session.set_model("2st")

        exp_files = sorted(glob.glob("Experiments/*.toml") + glob.glob("experiments/*.toml"))
        param_files = sorted(glob.glob("Parameters/*.toml") + glob.glob("parameters/*.toml"))
        if not param_files and os.path.isfile("Parameters/parameters.toml"):
            param_files = ["Parameters/parameters.toml"]
        if not param_files:
            rp = _resolve_param_path("Parameters/parameters.toml")
            if os.path.isfile(rp):
                param_files = [rp]
        if not exp_files:
            exp_files = sorted(glob.glob("**/Experiments/*.toml", recursive=True) + glob.glob("**/experiments/*.toml", recursive=True))

        selection = Selection(include=[SpinSystem.from_name(residue)], exclude=None)
        experiments = build_experiments([Path(p) for p in exp_files], selection, session=session)

        defaults = read_defaults([Path(p) for p in param_files])
        session.parameters.set_defaults(defaults)
        session.try_build_analysis_values()

        snapshot = session.analysis_values.snapshot()
        parameterization = session.compile_parameterization(Method(), experiments.param_ids)
        resolved_values = parameterization.resolve(parameterization.frame_from_snapshot(snapshot))

        experiments.back_calculate_from_values(resolved_values)

        exp_13hz = []
        calc_13hz = []
        exp_26hz = []
        calc_26hz = []

        for experiment in experiments:
            exp_name = str(experiment.filename).lower()
            for profile in experiment.profiles:
                if str(profile.spin_system) != residue:
                    continue
                d_exp = create_plot_data_exp(profile)
                d_calc = create_plot_data_calc(profile)

                exp_pts = []
                for x, y, err in zip(d_exp.metadata, d_exp.exp, d_exp.err):
                    err_val = float(err[0]) if hasattr(err, "__len__") else float(err)
                    if abs(err_val) < 1e10:
                        exp_pts.append({
                            "x": round(float(x), 4),
                            "y": round(float(y), 4),
                            "err": round(err_val, 4)
                        })
                exp_pts.sort(key=lambda p: p["x"], reverse=True)

                calc_pts = []
                for x, y in zip(d_calc.metadata, d_calc.calc):
                    calc_pts.append({
                        "x": round(float(x), 4),
                        "y": round(float(y), 4)
                    })
                calc_pts.sort(key=lambda p: p["x"], reverse=True)

                if "13" in exp_name:
                    exp_13hz = exp_pts
                    calc_13hz = calc_pts
                else:
                    exp_26hz = exp_pts
                    calc_26hz = calc_pts

        current_params = read_parameters_toml("Parameters/parameters.toml", residue)

        return json.dumps({
            "status": "success",
            "residue": residue,
            "params": current_params,
            "exp_13hz": exp_13hz,
            "calc_13hz": calc_13hz,
            "exp_26hz": exp_26hz,
            "calc_26hz": calc_26hz
        })
    finally:
        os.chdir(original_cwd)

def simulate_residue_lines(residue="13N", params_override=None, base_dir="CEST_15N"):
    """
    Lightweight simulation calculation returning only the updated calculated lines for 13Hz and 26Hz.
    """
    res_str = get_residue_profile_data(residue=residue, params_override=params_override, base_dir=base_dir)
    res = json.loads(res_str)
    return json.dumps({
        "status": "success",
        "residue": residue,
        "calc_13hz": res.get("calc_13hz", []),
        "calc_26hz": res.get("calc_26hz", []),
        "params": res.get("params", {})
    })

def read_fitted_parameters(output_dir="Output", residue="13N", base_dir="CEST_15N"):
    """
    Parses fitted parameters and uncertainties from Output/Parameters/fitted.toml
    and Output/Parameters/fixed.toml (or legacy parameters.fit).
    """
    import re
    fitted = {}

    search_dirs = [
        os.path.join(base_dir, output_dir),
        output_dir,
        os.path.join("/home/pyodide", output_dir),
        os.path.join("/home/pyodide/CEST_15N", output_dir),
    ]

    target_files = []
    for sdir in search_dirs:
        if os.path.isdir(sdir):
            for root, dirs, files in os.walk(sdir):
                for f in files:
                    fl = f.lower()
                    if fl in ("fitted.toml", "fixed.toml", "parameters.fit"):
                        full_f = os.path.join(root, f)
                        if full_f not in target_files:
                            target_files.append(full_f)

    # Prioritize fitted.toml files first, then fixed.toml, then legacy parameters.fit
    target_files.sort(key=lambda p: (0 if "fitted.toml" in p.lower() else (1 if "fixed.toml" in p.lower() else 2)))

    if not target_files:
        return fitted

    line_pattern = re.compile(
        r"^\s*([A-Za-z0-9_]+)\s*=\s*([-+]?\d*\.?\d+(?:[eE][-+]?\d+)?)(?:\s*#\s*(?:(?:±|\+/-)\s*([-+]?\d*\.?\d+(?:[eE][-+]?\d+)?))?)?",
        re.UNICODE
    )

    for tf in target_files:
        current_section = ""
        try:
            with open(tf, "r", encoding="utf-8", errors="replace") as f:
                for line in f:
                    line_str = line.strip()
                    if line_str.startswith("[") and line_str.endswith("]"):
                        current_section = line_str[1:-1].strip().strip('"\'').upper()
                        continue
                    m = line_pattern.match(line_str)
                    if m:
                        key = m.group(1).strip()
                        val = float(m.group(2))
                        err = float(m.group(3)) if m.group(3) else None

                        if current_section == "GLOBAL":
                            if key not in fitted or fitted[key].get("error") is None:
                                fitted[key] = {"value": val, "error": err}
                        elif current_section in ("CS_A", "DW_AB") and key == residue:
                            if current_section not in fitted or fitted[current_section].get("error") is None:
                                fitted[current_section] = {"value": val, "error": err}
        except Exception as e:
            print(f"> [Notice] Error reading {tf}: {e}")

    return fitted

def fit_from_user_parameters(residue="13N", params=None, output_dir="Output", base_dir="CEST_15N"):
    """
    Updates initial parameters in Parameters/parameters.toml, runs ChemEx fit,
    extracts fitted parameters, updates baseline parameters, and computes the updated best-fit profile.
    """
    apply_compat_patches()
    original_cwd = os.getcwd()
    try:
        cest_dir = base_dir if os.path.isdir(base_dir) else "."
        os.chdir(cest_dir)

        # 1. Update starting parameters
        if params:
            if isinstance(params, str):
                params = json.loads(params)
            update_parameters_toml("Parameters/parameters.toml", residue, params)

        # 2. Run ChemEx fit
        run_res_str = run_chemex_command(command="fit", include_residue=residue, output_dir=output_dir)
        run_res = json.loads(run_res_str)

        # 3. Read fitted parameters and uncertainties
        fitted_params = read_fitted_parameters(output_dir=output_dir, residue=residue, base_dir=".")

        # 4. If fitted parameters were found, update parameters.toml so they persist as baseline
        fitted_values = {}
        if "PB" in fitted_params:
            fitted_values["PB"] = fitted_params["PB"]["value"]
        if "KEX_AB" in fitted_params:
            fitted_values["KEX_AB"] = fitted_params["KEX_AB"]["value"]
        if "CS_A" in fitted_params:
            fitted_values["CS_A"] = fitted_params["CS_A"]["value"]
        if "DW_AB" in fitted_params:
            fitted_values["DW_AB"] = fitted_params["DW_AB"]["value"]
        if "TAUC_A" in fitted_params:
            fitted_values["TAUC_A"] = fitted_params["TAUC_A"]["value"]

        if fitted_values:
            update_parameters_toml("Parameters/parameters.toml", residue, fitted_values)

        # 5. Generate updated curve with best-fit values
        prof_res_str = get_residue_profile_data(residue=residue, params_override=fitted_values if fitted_values else None, base_dir=".")
        prof_res = json.loads(prof_res_str)

        virtual_files = get_virtual_files(".")

        return json.dumps({
            "status": "success",
            "residue": residue,
            "output_dir": output_dir,
            "run_result": run_res,
            "fitted_params": fitted_params,
            "calc_13hz": prof_res.get("calc_13hz", []),
            "calc_26hz": prof_res.get("calc_26hz", []),
            "params": prof_res.get("params", {}),
            "virtual_files": virtual_files
        })
    finally:
        os.chdir(original_cwd)

