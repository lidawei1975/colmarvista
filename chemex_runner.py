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

def run_chemex_command(command="fit", include_residue=None, output_dir="Output"):
    """
    Executes chemex fit or simulate from the virtual filesystem.
    Matches run.sh:
      chemex fit -e Experiments/*.toml -p Parameters/parameters.toml -o Output
    Matches simulate.sh:
      chemex simulate -e Experiments/*.toml -p Parameters/parameters.toml -o OutputSim
    """
    # Provide lightweight rapidfuzz shim if rapidfuzz is not installed in the WASM environment
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
