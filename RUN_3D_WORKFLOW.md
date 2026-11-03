# COLMARVIEW 3D Automated Workflow Runner (`run_3d_workflow.py`)

A standalone Python automation tool to process 3D NMR spectra (conventional and Non-Uniform Sampling / NUS) and perform 3D peak picking & iterative partition fitting without manual browser intervention.

The tool uses **Playwright** to drive your system's **Google Chrome** with **WebGPU hardware acceleration** enabled, taking full advantage of the GPU for SMILE reconstruction while running the entire web pipeline automatically.

---

## Features

- **End-to-End Automation**: Automatically loads Bruker raw files (`ser`/`fid`, `acqus`, `acqu2s`, `acqu3s`, optional `nuslist`), executes Fourier transforms, runs automatic phase correction, exports the 3D spectrum, and picks & fits 3D peaks.
- **Hardware WebGPU Acceleration**: Runs with your local Google Chrome installation using `--enable-unsafe-webgpu`, delivering full GPU speed for 3D SMILE NUS reconstruction.
- **Visual Check (Headed Mode by default)**: Runs Chrome visibly on screen so you can observe live progress, with an option to run silently in `--headless` mode.
- **Mode Selection**: Run either **`full`** (FID processing + 3D peak picking and iterative fitting) or **`fid-only`** (FID processing and FT3 export only).
- **Single Dataset or Batch Processing**: Process a single folder directly, choose via a GUI folder picker, or provide a text file with multiple folders and customizable per-dataset parameters.
- **Clean Session Isolation**: In batch mode, each dataset runs in its own browser session—the browser closes completely before opening the next dataset, preventing memory accumulation.
- **Automatic Output Generation**:
  - `colmarvista_result.ft3`: The phased, baseline-corrected 3D NMRPipe-compatible spectrum saved in the dataset folder.
  - `colmarvista_peaks.txt`: The fitted 3D peak list (centers, FWHH line widths, and Lorentzian fractions) saved in the dataset folder.

---

## Requirements

1. **Python 3.10+** (verified on Python 3.11).
2. **Playwright for Python**:
   ```powershell
   pip install playwright
   ```
3. **Google Chrome** installed on your system (Chrome 113+ recommended for WebGPU support).

---

## Quick Start

### 1. Interactive Selection
If you run without arguments, a folder picker dialog will open:
```powershell
python run_3d_workflow.py
```

### 2. Single Dataset (Full Workflow)
Runs FID processing, automatic phase correction, FT3 export, and 3D peak picking/fitting:
```powershell
python run_3d_workflow.py "D:\nmr_data\sample_3d_nus"
```

### 3. FID Processing Only (`--fid-only`)
Skips peak picking and fitting, saving only `colmarvista_result.ft3`:
```powershell
python run_3d_workflow.py "D:\nmr_data\sample_3d_nus" --fid-only
```

### 4. Custom Indirect Phase Angles
Specify $P_0$ and $P_1$ phase corrections for Indirect Dimension 1 (F1) and Indirect Dimension 2 (F3):
```powershell
python run_3d_workflow.py "D:\nmr_data\sample_3d_nus" --i1p0 90.0 --i1p1 0.0 --i2p0 -90.0 --i2p1 0.0
```

---

## Batch Processing from a Text File

You can process multiple 3D datasets in sequence by creating a text file (e.g. `datasets.txt`).

### Running a Batch
Pass the text file either directly or via `-b` / `--batch`:
```powershell
python run_3d_workflow.py datasets.txt
# or
python run_3d_workflow.py -b datasets.txt
```

### Batch File Format
- Each non-empty line specifies a folder path followed by optional parameter overrides.
- Quotes around paths with spaces are supported.
- Lines starting with `#` or `//` are treated as comments.
- Each dataset opens in Chrome and **closes completely** before starting the next one.

#### Example `datasets.txt`:
```text
# ======================================================================
# 3D NMR Batch Processing List
# ======================================================================

# 1. Standard dataset using default settings (Full processing + fitting)
D:\nmr_data\protein_hnco

# 2. Dataset with custom indirect phases in FID-only mode (skips peak fitting)
"D:\nmr_data\protein hncacb" --i1p0 90.0 --i1p1 0.0 --fid-only

# 3. Dataset with custom peak cutoff, ppm extraction range, and FLATT baseline
D:\nmr_data\protein_cbca --cutoff 0.35 --extract-from 11.0 --extract-to 5.5 --flatt

# 4. Dataset with custom indirect 2 phase
D:\nmr_data\protein_hnca --i2p0 -90.0 --i2p1 0.0
```

---

## Command-Line Arguments Reference

| Argument | Shorthand | Default | Description |
| :--- | :--- | :--- | :--- |
| `folder` | *(Positional)* | `None` | Path to a 3D Bruker dataset folder or a `.txt` batch file. If omitted, prompts with a GUI picker. |
| `--batch` / `--batch-file` | `-b` | `None` | Path to a text file containing batch directories and optional parameters (one per line). |
| `--mode` | | `full` | Execution mode: `full` (FID processing + peak picking/fitting) or `fid-only` (FID processing & FT3 export only). |
| `--fid-only` | | `False` | Convenient flag equivalent to `--mode fid-only`. |
| `--indirect1-p0` | `--i1p0` | `90.0` | Indirect Dimension 1 (F1) phase correction $P_0$ (degrees). |
| `--indirect1-p1` | `--i1p1` | `0.0` | Indirect Dimension 1 (F1) phase correction $P_1$ (degrees). |
| `--indirect2-p0` | `--i2p0` | `0.0` | Indirect Dimension 2 (F3) phase correction $P_0$ (degrees). |
| `--indirect2-p1` | `--i2p1` | `0.0` | Indirect Dimension 2 (F3) phase correction $P_1$ (degrees). |
| `--cutoff` | | `0.4` | Overlapping peak cutoff for 3D peak fitting (range: 0.2–0.6). |
| `--extract-from` | | `11.3` | Direct dimension PPM extraction start. |
| `--extract-to` | | `5.2` | Direct dimension PPM extraction end. |
| `--flatt` | | `False` | Enable direct-dimension FLATT baseline correction for NUS spectra. |
| `--headless` | | `False` | Run Chrome in headless mode (no visible browser window). |
| `--keep-browser` | | `False` | Keep the browser open after finishing a single run to inspect 2D plots and 3D views. |
| `--chrome-path` | | Auto-detected | Path to custom Google Chrome executable if not in standard program directories. |
| `--timeout` | | `900` | Timeout per operation in seconds (default: 15 minutes). |

---

## Expected Folder Structure

The target dataset directory must contain standard Bruker files:

```
my_3d_experiment/
    ser (or fid)
    acqus
    acqu2s
    acqu3s
    nuslist   (optional: only required for NUS experiments)
```

The script will automatically detect whether the experiment is NUS based on the presence of `nuslist`.

---

## Output Files

After running, two output files are created directly inside the experiment folder:

1. **`colmarvista_result.ft3`**:
   - NMRPipe-formatted 3D frequency-domain spectrum.
   - Fully phased and baseline-corrected.
   - Can be opened directly in COLMARVIEW (`index_3d.html`), NMRPipe, Sparky, or UCSF ChimeraX.

2. **`colmarvista_peaks.txt`** *(only generated in `full` mode)*:
   - Peak table containing partition IDs, peak amplitudes, 3D centers (grid points and PPM), FWHH line widths, and Lorentzian/Gaussian fractions ($L_x, L_y, L_z$).
   - Can be overlaid back into `index_3d.html` via the "Overlay Theoretical 3D Peaks" button.
