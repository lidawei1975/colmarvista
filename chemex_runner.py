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

    # 4. ChemEx Data positional arguments compatibility:
    # In chemex/plotters/cest.py (line 270) and chemex/plotters/cpmg.py (line 193),
    # Data(np.array([]), np.array([]), np.array([])) is called with 3 positional arguments: (exp, err, metadata).
    # Since chemex.containers.data.Data inherits from pydantic.BaseModel and defines __init__(self, **data: Array),
    # passing positional arguments raises TypeError: Data.__init__() takes 1 positional argument but 4 were given.
    try:
        import chemex.containers.data
        _orig_data_init = getattr(chemex.containers.data.Data, "_unpatched_init", chemex.containers.data.Data.__init__)
        chemex.containers.data.Data._unpatched_init = _orig_data_init

        def _safe_data_init(self, *args, **kwargs):
            if args:
                keys = ["exp", "err", "metadata"]
                for k, v in zip(keys, args):
                    kwargs[k] = v
                args = ()
            return _orig_data_init(self, *args, **kwargs)

        chemex.containers.data.Data.__init__ = _safe_data_init
    except Exception as e:
        print(f"> [Shim Notice] Could not patch chemex.containers.data.Data: {e}")

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
            "output_files": sorted(results)
        })
    finally:
        os.chdir(original_cwd)

def read_parameters_toml(path="Parameters/parameters.toml", residue="13N"):
    """
    Parses initial parameters from Parameters/parameters.toml.
    """
    import tomllib
    with open(path, "rb") as f:
        data = tomllib.load(f)

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
    with open(path, "rb") as f:
        data = tomllib.load(f)

    if "GLOBAL" not in data:
        data["GLOBAL"] = {}
    if "CS_A" not in data:
        data["CS_A"] = {}
    if "DW_AB" not in data:
        data["DW_AB"] = {}

    if "PB" in params:
        data["GLOBAL"]["PB"] = float(params["PB"])
    if "KEX_AB" in params:
        data["GLOBAL"]["KEX_AB"] = float(params["KEX_AB"])
    if "TAUC_A" in params:
        data["GLOBAL"]["TAUC_A"] = float(params["TAUC_A"])
    if "CS_A" in params:
        data["CS_A"][residue] = float(params["CS_A"])
    if "DW_AB" in params:
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

    with open(path, "w", encoding="utf-8") as f:
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
        from chemex.models.model import model
        from chemex.configuration.methods import Selection
        from chemex.experiments.builder import build_experiments
        from chemex.configuration.parameters import read_defaults
        from chemex.parameters import database
        from chemex.parameters.spin_system import SpinSystem
        from chemex.plotters.cest import create_plot_data_calc, create_plot_data_exp

        model.set_model("2st")

        exp_files = sorted(glob.glob("Experiments/*.toml") + glob.glob("experiments/*.toml"))
        param_files = sorted(glob.glob("Parameters/*.toml") + glob.glob("parameters/*.toml"))
        if not param_files and os.path.isfile("Parameters/parameters.toml"):
            param_files = ["Parameters/parameters.toml"]

        defaults = read_defaults([Path(p) for p in param_files])
        database.set_param_defaults(defaults)
        database.fix_all_parameters()

        selection = Selection(include=[SpinSystem.from_name(residue)], exclude=None)
        experiments = build_experiments([Path(p) for p in exp_files], selection)
        experiments.prepare_for_simulation()

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
    Parses fitted parameters and uncertainties from Output/parameters.fit or Output/<residue>/parameters.fit.
    """
    import re
    fitted = {}
    search_paths = [
        os.path.join(base_dir, output_dir, "parameters.fit"),
        os.path.join(base_dir, output_dir, residue, "parameters.fit"),
        os.path.join(base_dir, output_dir, "All", "parameters.fit"),
    ]
    target_file = None
    for p in search_paths:
        if os.path.isfile(p):
            target_file = p
            break

    if not target_file:
        return fitted

    current_section = ""
    line_pattern = re.compile(r"^\s*([A-Za-z0-9_]+)\s*=\s*([-+]?\d*\.?\d+(?:[eE][-+]?\d+)?)(?:\s*#\s*(?:(?:±|\+/-)\s*([-+]?\d*\.?\d+(?:[eE][-+]?\d+)?))?)?")
    with open(target_file, "r", encoding="utf-8") as f:
        for line in f:
            line_str = line.strip()
            if line_str.startswith("[") and line_str.endswith("]"):
                current_section = line_str[1:-1].strip().upper()
                continue
            m = line_pattern.match(line_str)
            if m:
                key = m.group(1).strip()
                val = float(m.group(2))
                err = float(m.group(3)) if m.group(3) else None

                if current_section == "GLOBAL":
                    fitted[key] = {"value": val, "error": err}
                elif current_section in ("CS_A", "DW_AB") and key == residue:
                    fitted[current_section] = {"value": val, "error": err}

    return fitted
