import numpy as np
import re
import json

def calculate(filename="input_data.txt"):
    """
    Reads numbers from a text file in Pyodide's virtual filesystem (MEMFS)
    and computes mean, std, variance, min, max, and count using NumPy.
    """
    with open(filename, "r") as f:
        file_content = f.read()

    # Split numbers on commas, whitespace, or semicolons
    tokens = [t for t in re.split(r'[\s,;]+', file_content.strip()) if t]
    if not tokens:
        raise ValueError(f"Virtual file '{filename}' contains no valid numbers.")

    try:
        data = np.array([float(x) for x in tokens])
    except ValueError as e:
        raise ValueError(f"Could not parse values from '{filename}': {e}")

    if len(data) == 0:
        raise ValueError(f"Empty array after parsing '{filename}'.")

    mean_val = float(np.mean(data))
    std_val = float(np.std(data))
    var_val = float(np.var(data))
    min_val = float(np.min(data))
    max_val = float(np.max(data))

    print(f"> [FS] Read '{filename}' from virtual filesystem ({len(file_content)} bytes).")
    print(f"> [NumPy] Loaded {len(data)} numeric values into array.")
    print(f"> Mean (np.mean)               : {mean_val:.6f}")
    print(f"> Standard Deviation (np.std) : {std_val:.6f}")
    print(f"> Variance (np.var)           : {var_val:.6f}")
    print(f"> Range                       : [{min_val:.4f}, {max_val:.4f}]")

    results = {
        "count": int(len(data)),
        "mean": mean_val,
        "std": std_val,
        "var": var_val,
        "min": min_val,
        "max": max_val,
        "filename": filename
    }

    return json.dumps(results)

if __name__ == "__main__":
    import sys
    target = sys.argv[1] if len(sys.argv) > 1 else "input_data.txt"
    print(calculate(target))

