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
