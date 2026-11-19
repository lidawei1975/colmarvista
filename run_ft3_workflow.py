#!/usr/bin/env python3
"""
COLMARVIEW Automated Frequency-Domain Peak Picking & Fitting Workflow Runner
===========================================================================
Processes pre-processed 3D (.ft3 / .ft3.pipe / 3D .pipe / 3D .ucsf) and
2D (.ft2 / .ft2.pipe / 2D .pipe / 2D .ucsf) NMR spectra in a folder:
1. Serves the workspace via local HTTP server (ensuring secure context).
2. Launches system Google Chrome via Playwright with WebGPU enabled.
3. Automatically discovers all 3D and 2D frequency-domain spectral files in the folder.
4. For each 3D spectrum: loads into index_3d.html, runs 3D peak picking & iterative fitting,
   and saves the fitted peaks as <basename>.txt (stripping .ft3/.ft3.pipe/.pipe/.ucsf).
5. For each 2D spectrum: loads into index.html, runs 2D peak picking & Voigt/Gaussian fitting,
   and saves the fitted peaks as <basename>.txt (stripping .ft2/.ft2.pipe/.pipe/.ucsf).
"""

import os
import sys
import time
import base64
import struct
import shlex
import shutil
import argparse
import threading
import socketserver
import http.server
from pathlib import Path

try:
    import tkinter as tk
    from tkinter import filedialog
    TKINTER_AVAILABLE = True
except ImportError:
    TKINTER_AVAILABLE = False

from playwright.sync_api import sync_playwright


# ---------------------------------------------------------------------------
# 1. Chrome Executable Detection
# ---------------------------------------------------------------------------

def find_system_chrome():
    """Locates Google Chrome on the system."""
    candidates = [
        r"C:\Program Files\Google\Chrome\Application\chrome.exe",
        r"C:\Program Files (x86)\Google\Chrome\Application\chrome.exe",
        os.path.expandvars(r"%LOCALAPPDATA%\Google\Chrome\Application\chrome.exe"),
        os.path.expandvars(r"%PROGRAMFILES%\Google\Chrome\Application\chrome.exe"),
        os.path.expandvars(r"%PROGRAMFILES(X86)%\Google\Chrome\Application\chrome.exe"),
    ]
    for path in candidates:
        if path and os.path.isfile(path):
            return path

    where_chrome = shutil.which("chrome") or shutil.which("google-chrome")
    if where_chrome and os.path.isfile(where_chrome):
        return where_chrome

    return None


# ---------------------------------------------------------------------------
# 2. Local HTTP Server
# ---------------------------------------------------------------------------

class QuietHTTPHandler(http.server.SimpleHTTPRequestHandler):
    """Custom HTTP handler with proper WASM/JS MIME types and quiet logging."""

    extensions_map = {
        **http.server.SimpleHTTPRequestHandler.extensions_map,
        '.wasm': 'application/wasm',
        '.js': 'application/javascript',
        '.mjs': 'application/javascript',
        '.json': 'application/json',
        '.map': 'application/json',
        '.bin': 'application/octet-stream',
        '.ft3': 'application/octet-stream',
        '.ft2': 'application/octet-stream',
        '.pipe': 'application/octet-stream',
        '.ucsf': 'application/octet-stream',
    }

    def end_headers(self):
        self.send_header('Access-Control-Allow-Origin', '*')
        super().end_headers()

    def log_message(self, format, *args):
        if len(args) > 1 and str(args[1]) in ("200", "304"):
            return
        if len(args) > 1 and str(args[1]) not in ("200", "304"):
            print(f"[HTTP] {self.address_string()} - {format % args}", file=sys.stderr)


class ThreadedTCPServer(socketserver.ThreadingMixIn, socketserver.TCPServer):
    daemon_threads = True
    allow_reuse_address = True


def start_local_server(directory, port=0):
    """Starts a local HTTP server in a background daemon thread."""
    handler = lambda *args, **kwargs: QuietHTTPHandler(*args, directory=directory, **kwargs)
    server = ThreadedTCPServer(('127.0.0.1', port), handler)
    actual_port = server.server_address[1]
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()
    return server, actual_port


# ---------------------------------------------------------------------------
# 3. Spectrum File Discovery, Header Inspection & Output Naming
# ---------------------------------------------------------------------------

SPECTRUM_SUFFIXES = (
    ".ft3.pipe",
    ".ft2.pipe",
    ".ucsf.pipe",
    ".ft3",
    ".ft2",
    ".pipe",
    ".ucsf",
)


def is_candidate_spectrum_filename(filename):
    """Checks if filename ends with a supported processed spectrum extension."""
    lower = filename.lower()
    return any(lower.endswith(ext) for ext in SPECTRUM_SUFFIXES)


def get_spectrum_stem(spec_path):
    """Returns path stem without composite NMR spectrum extensions."""
    p = Path(spec_path)
    name = p.name
    lower = name.lower()
    for ext in SPECTRUM_SUFFIXES:
        if lower.endswith(ext):
            return name[: len(name) - len(ext)]
    return p.stem


def get_peak_output_path(spec_path):
    """Strips composite spectrum extensions and appends .txt."""
    p = Path(spec_path)
    stem = get_spectrum_stem(spec_path)
    return str(p.with_name(f"{stem}.txt"))


def get_plot_output_paths(spec_path, kind):
    """Returns dict of plot output paths based on spectrum kind ('3d' or '2d')."""
    p = Path(spec_path)
    stem = get_spectrum_stem(spec_path)
    if kind == "3d":
        return {
            "exp_png": str(p.with_name(f"{stem}_exp.png")),
            "theory_png": str(p.with_name(f"{stem}_theory.png")),
        }
    return {
        "plot_png": str(p.with_name(f"{stem}.png")),
    }


def inspect_spectrum_file(file_path):
    """
    Inspects binary header of a spectrum file to classify it as '3d' or '2d'.
    Returns dict with keys: kind ('3d'|'2d'|None), format ('nmrpipe'|'ucsf'), nx, ny, nz.
    """
    p = Path(file_path)
    if not p.is_file():
        return None

    size = p.stat().st_size
    if size < 180:
        return None

    with open(p, "rb") as fh:
        header_bytes = fh.read(2048)

    lower = p.name.lower()

    # Check UCSF Sparky header
    if len(header_bytes) >= 14 and header_bytes[:8] == b"UCSF NMR":
        naxis = header_bytes[10]
        kind = "3d" if naxis == 3 else ("2d" if naxis == 2 else None)
        return {
            "kind": kind,
            "format": "ucsf",
            "dim_count": naxis,
            "nx": None,
            "ny": None,
            "nz": None,
        }

    # Check NMRPipe 2048-byte header (512 float32)
    dim_count = 0
    nx = ny = nz = 0
    if len(header_bytes) >= 2048:
        hdr = struct.unpack("<512f", header_bytes[:2048])
        dc = hdr[9]
        if (dc != dc) or abs(dc - round(dc)) > 1e-4 or round(dc) not in (1, 2, 3, 4) or hdr[99] <= 0:
            hdr_be = struct.unpack(">512f", header_bytes[:2048])
            dc_be = hdr_be[9]
            if dc_be == dc_be and abs(dc_be - round(dc_be)) <= 1e-4 and round(dc_be) in (1, 2, 3, 4) and hdr_be[99] > 0:
                hdr = hdr_be
                dc = dc_be

        if dc == dc and hdr[15] == hdr[15] and hdr[99] == hdr[99] and hdr[219] == hdr[219]:
            dim_count = int(round(dc))
            nz = int(round(hdr[15]))
            nx = int(round(hdr[99]))
            ny = int(round(hdr[219]))

    if dim_count == 3:
        kind = "3d"
    elif dim_count == 2:
        kind = "2d"
    elif dim_count == 1 or dim_count == 4:
        kind = None
    elif lower.endswith(".ft3.pipe") or lower.endswith(".ft3"):
        kind = "3d"
    elif lower.endswith(".ft2.pipe") or lower.endswith(".ft2"):
        kind = "2d"
    else:
        kind = None

    return {
        "kind": kind,
        "format": "nmrpipe",
        "dim_count": dim_count,
        "nx": nx,
        "ny": ny,
        "nz": nz,
    }


def discover_spectra_in_folder(folder_path, include_3d=True, include_2d=True):
    """
    Discovers all 3D and 2D processed spectral files in folder_path.
    Returns list of dicts sorted cleanly (3D spectra alphabetically, then 2D spectra alphabetically).
    """
    p = Path(folder_path).resolve()
    if not p.is_dir():
        raise FileNotFoundError(f"Selected path is not a directory: {p}")

    found_3d = []
    found_2d = []

    for entry in sorted(p.iterdir(), key=lambda f: f.name.lower()):
        if not entry.is_file():
            continue
        if not is_candidate_spectrum_filename(entry.name):
            continue

        info = inspect_spectrum_file(entry)
        if not info or not info["kind"]:
            print(f"[Skip] Could not classify as 2D or 3D spectrum: {entry.name}")
            continue

        plot_paths = get_plot_output_paths(entry, info["kind"])
        item = {
            "path": str(entry),
            "name": entry.name,
            "kind": info["kind"],
            "format": info["format"],
            "nx": info["nx"],
            "ny": info["ny"],
            "nz": info["nz"],
            "output_txt": get_peak_output_path(entry),
            **plot_paths,
            "size_mb": entry.stat().st_size / (1024 * 1024),
        }

        if info["kind"] == "3d" and include_3d:
            found_3d.append(item)
        elif info["kind"] == "2d" and include_2d:
            found_2d.append(item)

    return found_3d + found_2d


def is_spectrum_dir(folder_path):
    """Checks whether folder_path contains any 2D or 3D processed spectral files."""
    if not folder_path or not os.path.isdir(folder_path):
        return False
    try:
        return len(discover_spectra_in_folder(folder_path)) > 0
    except Exception:
        return False


def select_folder_interactively():
    """Prompts the user to select a folder using GUI dialog or terminal."""
    if TKINTER_AVAILABLE:
        try:
            root = tk.Tk()
            root.withdraw()
            root.attributes('-topmost', True)
            print("Please select the NMR spectral dataset folder in the dialog window...")
            chosen = filedialog.askdirectory(title="Select NMR Dataset Folder (.ft3 / .ft2 / .pipe)")
            root.destroy()
            if chosen and os.path.isdir(chosen):
                return chosen
        except Exception as e:
            print(f"[Warning] GUI dialog failed ({e}), falling back to CLI prompt.")

    while True:
        try:
            entry = input("\nEnter path to NMR dataset folder: ").strip().strip('"').strip("'")
            if entry and os.path.isdir(entry):
                return entry
            print(f"Directory not found: '{entry}'. Please try again.")
        except (KeyboardInterrupt, EOFError):
            print("\nAborted by user.")
            sys.exit(1)


# ---------------------------------------------------------------------------
# 4. Per-Spectrum Browser Runners (3D and 2D)
# ---------------------------------------------------------------------------

def attach_page_listeners(page, tag):
    """Attaches console, pageerror, and dialog handlers to a Playwright page."""
    dialogs = []

    def on_console(msg):
        text = msg.text
        if any(k in text for k in [
            "[webass_3d]", "[main", "pick_and_fit_3d", "peak_picker_2d",
            "peak_fitter_v2", "Fitted peaks", "Error", "error", "Failed"
        ]):
            print(f"  [{tag}] {text}")

    def on_page_error(err):
        print(f"  [{tag} Page/Worker Error] {err}", file=sys.stderr)

    def on_dialog(dialog):
        print(f"  [{tag} Dialog {dialog.type.upper()}] {dialog.message}")
        dialogs.append(dialog.message)
        dialog.accept()

    page.on("console", on_console)
    page.on("pageerror", on_page_error)
    page.on("dialog", on_dialog)
    return dialogs


def count_3d_peaks(peaks_text):
    """Counts fitted 3D peaks in formatted output text."""
    if not peaks_text:
        return 0
    lines = [l for l in peaks_text.splitlines() if l.strip() and not l.startswith("=") and not l.startswith("#")]
    return max(0, len(lines) - 1)


def count_2d_peaks(peaks_text):
    """Counts peaks in an NMRPipe .tab string."""
    if not peaks_text:
        return 0
    count = 0
    for raw in peaks_text.splitlines():
        line = raw.strip()
        if not line or line.startswith(("DATA", "REMARK", "VARS", "FORMAT", "#")):
            continue
        count += 1
    return count


def process_3d_spectrum(
    context,
    port,
    spec_item,
    peak_cutoff=0.4,
    timeout_seconds=3600,
    keep_page_open=False,
):
    """Loads a 3D spectrum (.ft3/.ft3.pipe/.pipe/.ucsf) in index_3d.html, picks/fits peaks, saves .txt."""
    spec_start = time.time()
    app_url = f"http://127.0.0.1:{port}/index_3d.html"
    page = context.new_page()
    dialogs = attach_page_listeners(page, "3D")

    try:
        print(f"[3D] Loading {spec_item['name']} ({spec_item['size_mb']:.2f} MB) in index_3d.html...")
        page.goto(app_url, wait_until="networkidle")

        # Upload file to #userfile_ft3 and ensure auto-phase is unchecked for pre-processed spectra
        page.locator('#userfile_ft3').set_input_files(spec_item['path'])
        page.evaluate("""(cutoffVal) => {
            const autoCb = document.getElementById('normal_direct_dim_auto_phase_3d');
            if (autoCb) autoCb.checked = false;
            if (cutoffVal !== null && cutoffVal !== undefined) {
                const el = document.getElementById('input_new_peak_cutoff');
                if (el) el.value = String(cutoffVal);
            }
        }""", peak_cutoff)

        page.locator('#button_ft3_process').click()

        load_start = time.time()
        last_status = ""
        while True:
            if time.time() - load_start > timeout_seconds:
                raise TimeoutError(f"Loading 3D spectrum timed out after {timeout_seconds}s.")

            msg = page.evaluate("() => (document.getElementById('webassembly_message') ? document.getElementById('webassembly_message').innerText : '')")
            if msg and msg != last_status:
                print(f"  [Load Status] {msg}")
                last_status = msg
                if msg.startswith("Error:"):
                    raise RuntimeError(f"3D loading failed: {msg}")

            is_loaded = page.evaluate("""() => {
                const plotArea = document.getElementById('main_plot_area');
                const hasSpectra = typeof spectra_3d !== 'undefined' && spectra_3d !== null && spectra_3d.length > 0;
                const isVisible = plotArea && window.getComputedStyle(plotArea).display !== 'none';
                const fitBtn = document.getElementById('button_peak_fit_3d');
                return hasSpectra && isVisible && fitBtn && !fitBtn.disabled;
            }""")
            if is_loaded:
                print(f"[3D] Loaded in {time.time() - load_start:.1f}s.")
                break

            page.wait_for_timeout(500)

        page.wait_for_timeout(500)

        # Ensure peak cutoff is set before triggering workflow, reset previous text marker, and run peak pick/fit
        if peak_cutoff is not None:
            page.evaluate("(val) => { const el = document.getElementById('input_new_peak_cutoff'); if (el) el.value = String(val); }", peak_cutoff)

        print(f"[3D] Running peak picking and iterative fitting (cutoff={peak_cutoff})...")
        page.evaluate("""() => {
            window.fitted_peaks_text_data = null;
            if (typeof run_peak_fit_3d_workflow === 'function') {
                run_peak_fit_3d_workflow();
            } else {
                const btn = document.getElementById('button_peak_fit_3d');
                if (btn) btn.click();
            }
        }""")

        fit_start = time.time()
        last_fit_status = ""
        while True:
            if time.time() - fit_start > timeout_seconds:
                raise TimeoutError(f"3D peak picking & fitting timed out after {timeout_seconds}s.")

            msg = page.evaluate("() => (document.getElementById('webassembly_message') ? document.getElementById('webassembly_message').innerText : '')")
            if msg and msg != last_fit_status:
                print(f"  [Fit Status] {msg}")
                last_fit_status = msg
                if msg.startswith("Peak picking/fitting failed:") or msg.startswith("Error:"):
                    raise RuntimeError(f"3D peak fitting error: {msg}")

            is_fit_done = page.evaluate("""() => {
                const dlBtn = document.getElementById('button_download_peaks_list');
                const hasText = typeof window.fitted_peaks_text_data === 'string' && window.fitted_peaks_text_data.length > 0;
                const emptyComplete = (typeof window.fitted_peaks_text_data === 'string') && dlBtn && !dlBtn.disabled;
                return (dlBtn && !dlBtn.disabled && hasText) || emptyComplete;
            }""")
            if is_fit_done:
                print(f"[3D] Peak picking & fitting completed in {time.time() - fit_start:.1f}s!")
                break

            page.wait_for_timeout(1000)

        peaks_text = page.evaluate("() => window.fitted_peaks_text_data || ''")
        output_path = spec_item['output_txt']
        with open(output_path, "w", encoding="utf-8") as f:
            f.write(peaks_text)

        num_peaks = count_3d_peaks(peaks_text)
        print(f"[Output] Saved {output_path} ({num_peaks} peaks)")

        exp_png_path = None
        theory_png_path = None
        if num_peaks > 0:
            print("[3D View] Enabling True 3D Isosurface Visualization...")
            page.evaluate("""() => {
                const cb = document.getElementById('check_visualize_3d');
                if (cb) {
                    cb.checked = true;
                    cb.dispatchEvent(new Event('change', { bubbles: true }));
                } else if (typeof toggle_visualize_3d === 'function') {
                    toggle_visualize_3d(true);
                }
            }""")

            render_start = time.time()
            while True:
                if time.time() - render_start > 60:
                    print("[Warning] Timed out waiting for 3D isosurface rendering.")
                    break

                is_rendered = page.evaluate("""() => {
                    const loading = document.getElementById('loading_3d');
                    const isLoading = loading && window.getComputedStyle(loading).display !== 'none';
                    const hasRenderer = typeof iso_renderer !== 'undefined' && iso_renderer !== null && iso_renderer.gl;
                    const hasVolume = typeof current_volume_data !== 'undefined' && current_volume_data !== null;
                    const hasTheo = typeof theoretical_spectra_3d !== 'undefined' && theoretical_spectra_3d && theoretical_spectra_3d.length > 0;
                    const hasReconRenderer = !hasTheo || (typeof iso_renderer_recon !== 'undefined' && iso_renderer_recon !== null && iso_renderer_recon.gl);
                    return Boolean(!isLoading && hasRenderer && hasVolume && hasReconRenderer);
                }""")
                if is_rendered:
                    break
                page.wait_for_timeout(500)

            page.wait_for_timeout(500)

            exp_target = spec_item["exp_png"]
            exp_b64 = page.evaluate("""() => {
                if (typeof get_3d_view_data_url === 'function') {
                    return get_3d_view_data_url('exp', 2);
                }
                const c = document.getElementById('canvas_3d');
                return c ? c.toDataURL('image/png') : null;
            }""")
            if exp_b64 and "," in exp_b64:
                with open(exp_target, "wb") as f:
                    f.write(base64.b64decode(exp_b64.split(",", 1)[1]))
                exp_png_path = exp_target
                print(f"[Output] Saved {exp_png_path} ({os.path.getsize(exp_png_path):,} bytes)")
            else:
                print("[Warning] Failed to capture experimental 3D view.")

            theory_target = spec_item["theory_png"]
            theory_b64 = page.evaluate("""() => {
                if (typeof get_3d_view_data_url === 'function') {
                    return get_3d_view_data_url('theory', 2);
                }
                const c = document.getElementById('canvas_3d_recon');
                return c ? c.toDataURL('image/png') : null;
            }""")
            if theory_b64 and "," in theory_b64:
                with open(theory_target, "wb") as f:
                    f.write(base64.b64decode(theory_b64.split(",", 1)[1]))
                theory_png_path = theory_target
                print(f"[Output] Saved {theory_png_path} ({os.path.getsize(theory_png_path):,} bytes)")
            else:
                print("[Warning] Failed to capture reconstructed 3D view.")

        duration = time.time() - spec_start
        print(f"[3D] Finished {spec_item['name']} in {duration:.1f}s.")

        if keep_page_open:
            print("\n[Notice] --keep-browser is enabled. Press Enter in this terminal to continue/close...")
            try:
                input()
            except (KeyboardInterrupt, EOFError):
                pass

        return {
            "name": spec_item["name"],
            "kind": "3d",
            "output_txt": output_path,
            "exp_png": exp_png_path,
            "theory_png": theory_png_path,
            "num_peaks": num_peaks,
            "duration": duration,
            "dialogs": dialogs,
        }
    finally:
        page.close()


def process_2d_spectrum(
    context,
    port,
    spec_item,
    picker_flag=0,
    fitter_flag=0,
    timeout_seconds=3600,
    keep_page_open=False,
):
    """Loads a 2D spectrum (.ft2/.ft2.pipe/.pipe/.ucsf) in index.html, picks/fits peaks, saves .txt."""
    spec_start = time.time()
    app_url = f"http://127.0.0.1:{port}/index.html"
    page = context.new_page()
    dialogs = attach_page_listeners(page, "2D")

    try:
        print(f"[2D] Loading {spec_item['name']} ({spec_item['size_mb']:.2f} MB) in index.html...")
        page.goto(app_url, wait_until="networkidle")

        page.locator('#userfile').set_input_files(spec_item['path'])
        page.locator('#button_ft2_process').click()

        load_start = time.time()
        while True:
            if time.time() - load_start > timeout_seconds:
                raise TimeoutError(f"Loading 2D spectrum timed out after {timeout_seconds}s.")

            is_loaded = page.evaluate("""() => {
                if (typeof hsqc_spectra === 'undefined' || !hsqc_spectra || hsqc_spectra.length === 0) return false;
                if (typeof main_plot === 'undefined' || !main_plot) return false;
                if (!main_plot.contour_lbs || main_plot.contour_lbs.length === 0) return false;
                if (!main_plot.contour_lbs_negative || main_plot.contour_lbs_negative.length === 0) return false;
                const pickerBtn = document.getElementById('run_deep_picker-0');
                return !!(pickerBtn && !pickerBtn.disabled);
            }""")
            if is_loaded:
                print(f"[2D] Loaded in {time.time() - load_start:.1f}s.")
                break

            page.wait_for_timeout(400)

        page.wait_for_timeout(300)

        # Step 1: 2D Peak Picking
        picker_name = "Simple Picker" if picker_flag == 1 else "DEEP Picker"
        print(f"[2D] Running {picker_name}...")
        page.evaluate("(flag) => { run_DEEP_Picker(0, flag); }", picker_flag)

        pick_start = time.time()
        last_pick_msg = ""
        while True:
            if time.time() - pick_start > timeout_seconds:
                raise TimeoutError(f"2D peak picking timed out after {timeout_seconds}s.")

            msg = page.evaluate("() => (document.getElementById('webassembly_message') ? document.getElementById('webassembly_message').innerText : '')")
            if msg and msg != last_pick_msg:
                print(f"  [Pick Status] {msg}")
                last_pick_msg = msg
                if "failed" in msg.lower() or msg.startswith("Error:"):
                    raise RuntimeError(f"2D peak picking error: {msg}")

            pick_state = page.evaluate("""() => {
                const s = (typeof hsqc_spectra !== 'undefined' && hsqc_spectra[0]) ? hsqc_spectra[0] : null;
                if (!s || !s.picked_peaks_object) return { done: false };
                const btn = document.getElementById('run_voigt_fitter-0');
                if (!btn || btn.disabled) return { done: false };
                const cols = s.picked_peaks_object.columns || [];
                const count = (cols.length > 0 && cols[0]) ? cols[0].length : 0;
                return { done: true, count: count };
            }""")
            if pick_state.get("done"):
                picked_count = pick_state.get("count", 0)
                print(f"[2D] Picked {picked_count} peaks in {time.time() - pick_start:.1f}s.")
                break

            page.wait_for_timeout(400)

        output_path = spec_item['output_txt']

        if picked_count == 0:
            print("[Warning] 0 peaks picked in 2D spectrum; saving empty peak table header.")
            peaks_tab = page.evaluate("""() => {
                const pk = hsqc_spectra[0].picked_peaks_object;
                if (pk && pk.columns && pk.columns.length > 0) return pk.save_peaks_tab();
                return '';
            }""")
            with open(output_path, "w", encoding="utf-8") as f:
                f.write(peaks_tab)
            duration = time.time() - spec_start
            print(f"[Output] Saved {output_path} (0 peaks, {duration:.1f}s)")
            return {
                "name": spec_item["name"],
                "kind": "2d",
                "output_txt": output_path,
                "num_peaks": 0,
                "duration": duration,
                "dialogs": dialogs,
            }

        # Step 2: 2D Peak Fitting (v2)
        fitter_names = {0: "Voigt", 1: "Gaussian", 2: "Voigt_Lorentzian"}
        print(f"[2D] Running Peak Fitting v2 ({fitter_names.get(fitter_flag, 'Voigt')})...")
        page.evaluate("""(flag) => {
            const sel = document.getElementById('run_voigt_fitter_select-0');
            if (sel) sel.value = String(flag);
            run_Voigt_fitter_v2(0, flag);
        }""", fitter_flag)

        fit_start = time.time()
        last_fit_msg = ""
        while True:
            if time.time() - fit_start > timeout_seconds:
                raise TimeoutError(f"2D peak fitting timed out after {timeout_seconds}s.")

            msg = page.evaluate("() => (document.getElementById('webassembly_message') ? document.getElementById('webassembly_message').innerText : '')")
            if msg and msg != last_fit_msg:
                print(f"  [Fit Status] {msg}")
                last_fit_msg = msg
                if msg.startswith("Peak fitting error:") or msg.startswith("Error:"):
                    raise RuntimeError(f"2D peak fitting error: {msg}")

            fit_state = page.evaluate("""() => {
                const s = (typeof hsqc_spectra !== 'undefined' && hsqc_spectra[0]) ? hsqc_spectra[0] : null;
                if (!s) return { done: false };
                const total = s.total_peak_fitting_jobs || 0;
                const completed = s.completed_peak_fitting_jobs || 0;
                const failed = s.failed_peak_fitting_jobs || 0;
                const msgEl = document.getElementById('webassembly_message');
                const msgText = msgEl ? msgEl.innerText : '';
                if (msgText === 'No picked peaks in current visible region.') {
                    return { done: true, noVisible: true };
                }
                if (total > 0 && completed >= total) {
                    if (s.fitted_peaks_object && s.fitted_peaks_object.columns && s.fitted_peaks_object.columns.length > 0 && s.fitted_peaks_object.columns[0].length > 0) {
                        const dlBtn = document.getElementById('download_fitted_peaks-0');
                        if (dlBtn && !dlBtn.disabled) {
                            return { done: true, hasFitted: true, failed: failed };
                        }
                    } else if (failed > 0 || msgText.includes('No fitted peaks found')) {
                        return { done: true, hasFitted: false, failed: failed };
                    }
                }
                return { done: false };
            }""")
            if fit_state.get("done"):
                if fit_state.get("hasFitted"):
                    print(f"[2D] Peak fitting completed in {time.time() - fit_start:.1f}s!")
                elif fit_state.get("noVisible"):
                    raise RuntimeError("No picked peaks in current visible region during 2D fitting.")
                else:
                    raise RuntimeError("2D peak fitting completed with no fitted peaks.")
                break

            page.wait_for_timeout(400)

        peaks_tab = page.evaluate("() => hsqc_spectra[0].fitted_peaks_object.save_peaks_tab()")
        with open(output_path, "w", encoding="utf-8") as f:
            f.write(peaks_tab)

        num_peaks = count_2d_peaks(peaks_tab)
        print(f"[Output] Saved {output_path} ({num_peaks} peaks)")

        plot_png_path = None
        if num_peaks > 0:
            print("[2D Plot] Waiting for reconstructed contour overlay (contours only, no peak symbols/labels)...")
            recon_start = time.time()
            while True:
                if time.time() - recon_start > 60:
                    print("[Warning] Timed out waiting for reconstructed 2D contour overlay; exporting current plot.")
                    break
                recon_ready = page.evaluate("""() => {
                    const s0 = (typeof hsqc_spectra !== 'undefined' && hsqc_spectra) ? hsqc_spectra[0] : null;
                    if (!s0 || !s0.recon_generated_v2) return false;
                    if (typeof main_plot === 'undefined' || !main_plot || !main_plot.levels_length || !main_plot.levels_length_negative) return false;
                    const contourMsg = document.getElementById('contour_message');
                    const isCalculating = contourMsg && contourMsg.innerText.trim().length > 0;
                    return !isCalculating && main_plot.levels_length.length >= 2 && main_plot.levels_length_negative.length >= 2;
                }""")
                if recon_ready:
                    break
                page.wait_for_timeout(300)

            page.evaluate("""() => {
                const lblCb = document.getElementById('show_peak_label');
                if (lblCb) {
                    lblCb.checked = false;
                }
                const sfp = document.getElementById('show_fitted_peaks-0');
                if (sfp) {
                    sfp.checked = false;
                }
                const sp = document.getElementById('show_peaks-0');
                if (sp) {
                    sp.checked = false;
                }

                if (typeof main_plot !== 'undefined' && main_plot) {
                    if (main_plot.sim && typeof main_plot.sim.stop === 'function') {
                        main_plot.sim.stop();
                    }
                    if (typeof main_plot.remove_picked_peaks === 'function') {
                        main_plot.remove_picked_peaks();
                    }
                    if (main_plot.$vis) {
                        main_plot.$vis.selectAll('.peak').remove();
                        main_plot.$vis.selectAll('.peak_text').remove();
                        main_plot.$vis.selectAll('.peak_line').remove();
                    }
                }
                const visEl = document.getElementById('visualization');
                if (visEl) {
                    visEl.querySelectorAll('.peak, .peak_text, .peak_line').forEach(el => el.remove());
                }

                if (typeof hsqc_spectra !== 'undefined' && Array.isArray(hsqc_spectra)) {
                    for (let i = 0; i < hsqc_spectra.length; i++) {
                        if (hsqc_spectra[i]) {
                            hsqc_spectra[i].visible = true;
                        }
                        const rCb = document.getElementById('show_recon-' + i);
                        if (rCb) {
                            rCb.checked = true;
                        }
                    }
                }
                if (typeof main_plot !== 'undefined' && main_plot && typeof main_plot.redraw_contour === 'function') {
                    main_plot.redraw_contour();
                }
            }""")

            page.wait_for_timeout(200)

            plot_target = spec_item["plot_png"]
            plot_b64 = page.evaluate("""async () => {
                const $svg = document.getElementById('visualization');
                if (!$svg || typeof main_plot === 'undefined' || !main_plot || !main_plot.contour_plot) return null;
                const contourUrl = main_plot.contour_plot.drawScene(1);
                if (!contourUrl) return null;
                const contour_image = await loadImage(contourUrl);
                const svgData = encodeAsUTF8(serializeAsXML($svg));
                const img = await loadImage(svgData);
                const $canvas = document.createElement('canvas');
                $canvas.width = $svg.clientWidth;
                $canvas.height = $svg.clientHeight;
                const ctx = $canvas.getContext('2d');
                ctx.fillStyle = 'white';
                ctx.fillRect(0, 0, $canvas.width, $canvas.height);
                ctx.drawImage(
                    contour_image,
                    plot_margin_left,
                    plot_margin_top,
                    $canvas.width - plot_margin_left - plot_margin_right,
                    $canvas.height - plot_margin_top - plot_margin_bottom
                );
                ctx.drawImage(img, 0, 0, $canvas.width, $canvas.height);
                return $canvas.toDataURL('image/png', 1.0);
            }""")
            if plot_b64 and "," in plot_b64:
                with open(plot_target, "wb") as f:
                    f.write(base64.b64decode(plot_b64.split(",", 1)[1]))
                plot_png_path = plot_target
                print(f"[Output] Saved {plot_png_path} ({os.path.getsize(plot_png_path):,} bytes)")
            else:
                print("[Warning] Failed to capture 2D overlaid plot.")

        duration = time.time() - spec_start
        print(f"[2D] Finished {spec_item['name']} in {duration:.1f}s.")

        if keep_page_open:
            print("\n[Notice] --keep-browser is enabled. Press Enter in this terminal to continue/close...")
            try:
                input()
            except (KeyboardInterrupt, EOFError):
                pass

        return {
            "name": spec_item["name"],
            "kind": "2d",
            "output_txt": output_path,
            "plot_png": plot_png_path,
            "num_peaks": num_peaks,
            "duration": duration,
            "dialogs": dialogs,
        }
    finally:
        page.close()


# ---------------------------------------------------------------------------
# 5. Folder Workflow & Batch Execution
# ---------------------------------------------------------------------------

def run_folder_workflow(
    folder_path,
    chrome_path=None,
    headless=False,
    keep_browser=False,
    peak_cutoff=0.4,
    picker_2d="deep",
    fitter_2d="voigt",
    include_3d=True,
    include_2d=True,
    timeout_seconds=3600,
    server_info=None,
):
    folder_start = time.time()
    picker_flag = 1 if picker_2d == "simple" else 0
    fitter_map = {"voigt": 0, "gaussian": 1, "voigt-lorentzian": 2}
    fitter_flag = fitter_map.get(fitter_2d, 0)

    spectra_items = discover_spectra_in_folder(
        folder_path,
        include_3d=include_3d,
        include_2d=include_2d,
    )
    target_dir = str(Path(folder_path).resolve())

    print("=" * 78)
    print("COLMARVIEW FT3/FT2 AUTOMATED PEAK PICK & FIT WORKFLOW")
    print(f"[Folder] {target_dir}")
    print(f"[Found]  {len(spectra_items)} spectrum file(s):")
    for idx, item in enumerate(spectra_items, 1):
        dims = f"{item['nx']}x{item['ny']}" + (f"x{item['nz']}" if item['kind'] == '3d' else "")
        out_name = os.path.basename(item['output_txt'])
        print(f"  {idx}. [{item['kind'].upper()}] {item['name']} ({dims}, {item['size_mb']:.2f} MB) -> {out_name}")
    print("=" * 78)

    if not spectra_items:
        print("[Warning] No matching 3D (.ft3/.ft3.pipe) or 2D (.ft2/.ft2.pipe/.pipe) spectra found.")
        return {
            "success": True,
            "target_dir": target_dir,
            "results": [],
            "failed": [],
            "duration": time.time() - folder_start,
        }

    resolved_chrome = chrome_path or find_system_chrome()
    if not resolved_chrome or not os.path.isfile(resolved_chrome):
        raise RuntimeError(
            f"Google Chrome executable not found at '{resolved_chrome}'.\n"
            f"Please specify via --chrome-path or install Chrome."
        )
    print(f"[Chrome] Using system Chrome: {resolved_chrome}")

    repo_root = os.path.dirname(os.path.abspath(__file__))
    own_server = False
    if server_info is not None:
        server, port = server_info
    else:
        server, port = start_local_server(repo_root)
        own_server = True
    print(f"[Server] Local web server running at http://127.0.0.1:{port}/")

    chrome_args = [
        "--enable-unsafe-webgpu",
        "--enable-features=Vulkan",
        "--use-webgpu-adapter=default",
        "--ignore-gpu-blocklist",
        "--enable-gpu-rasterization",
        "--enable-zero-copy",
        "--disable-background-timer-throttling",
        "--disable-backgrounding-occluded-windows",
        "--disable-renderer-backgrounding",
    ]

    results = []
    failures = []

    try:
        with sync_playwright() as p:
            browser = p.chromium.launch(
                executable_path=resolved_chrome,
                headless=headless,
                args=chrome_args,
            )
            try:
                for idx, item in enumerate(spectra_items, 1):
                    print("\n" + "-" * 78)
                    print(f"[{idx}/{len(spectra_items)}] Processing {item['kind'].upper()}: {item['name']}")
                    print("-" * 78)

                    # Isolated context per spectrum so WebAssembly workers and caches start fresh
                    context = browser.new_context(
                        accept_downloads=True,
                        viewport={"width": 1400, "height": 950},
                    )
                    keep_this = keep_browser and (idx == len(spectra_items))
                    try:
                        if item["kind"] == "3d":
                            res = process_3d_spectrum(
                                context=context,
                                port=port,
                                spec_item=item,
                                peak_cutoff=peak_cutoff,
                                timeout_seconds=timeout_seconds,
                                keep_page_open=keep_this,
                            )
                        else:
                            res = process_2d_spectrum(
                                context=context,
                                port=port,
                                spec_item=item,
                                picker_flag=picker_flag,
                                fitter_flag=fitter_flag,
                                timeout_seconds=timeout_seconds,
                                keep_page_open=keep_this,
                            )
                        results.append({"item": item, "status": "SUCCESS", "result": res})
                    except Exception as err:
                        print(f"[Error] Failed processing {item['name']}: {err}", file=sys.stderr)
                        failures.append({"item": item, "error": str(err)})
                        results.append({"item": item, "status": "FAILED", "error": str(err)})
                    finally:
                        context.close()
            finally:
                browser.close()
    finally:
        if own_server and server:
            server.shutdown()

    total_duration = time.time() - folder_start
    print("\n" + "=" * 78)
    print(f"FOLDER SUMMARY: {target_dir}")
    print("-" * 78)
    for r in results:
        item = r["item"]
        if r["status"] == "SUCCESS":
            res = r["result"]
            extras = []
            if res.get("exp_png") and os.path.isfile(res["exp_png"]):
                extras.append(os.path.basename(res["exp_png"]))
            if res.get("theory_png") and os.path.isfile(res["theory_png"]):
                extras.append(os.path.basename(res["theory_png"]))
            if res.get("plot_png") and os.path.isfile(res["plot_png"]):
                extras.append(os.path.basename(res["plot_png"]))
            extra_str = (", plots: " + ", ".join(extras)) if extras else ""
            print(
                f"  SUCCESS | {item['kind'].upper()} | {item['name']} -> "
                f"{os.path.basename(res['output_txt'])} ({res['num_peaks']} peaks{extra_str}, {res['duration']:.1f}s)"
            )
        else:
            print(f"  FAILED  | {item['kind'].upper()} | {item['name']} -> {r['error']}")
    print("-" * 78)
    print(f"Completed {len(results) - len(failures)}/{len(spectra_items)} spectrum(s) in {total_duration:.1f}s")
    print("=" * 78)

    if failures:
        raise RuntimeError(f"{len(failures)} spectrum(s) failed in '{target_dir}'.")

    return {
        "success": True,
        "target_dir": target_dir,
        "results": results,
        "failed": failures,
        "duration": total_duration,
    }


def make_task_parser():
    """Lightweight parser for individual lines in a batch file."""
    p = argparse.ArgumentParser(prog="batch_line", add_help=False)
    p.add_argument("folder", help="Path to spectral dataset folder")
    p.add_argument("--cutoff", type=float, default=None)
    p.add_argument("--picker-2d", choices=["deep", "simple"], default=None)
    p.add_argument("--fitter-2d", choices=["voigt", "gaussian", "voigt-lorentzian"], default=None)
    p.add_argument("--skip-2d", action="store_true", default=None)
    p.add_argument("--skip-3d", action="store_true", default=None)
    p.add_argument("--timeout", type=int, default=None)
    return p


def parse_batch_file(batch_path, base_args):
    """Parses a text file containing one dataset folder (and optional flags) per line."""
    tasks = []
    task_parser = make_task_parser()

    with open(batch_path, "r", encoding="utf-8", errors="replace") as f:
        for line_num, raw_line in enumerate(f, 1):
            line = raw_line.strip()
            if not line or line.startswith("#") or line.startswith("//"):
                continue

            try:
                tokens = shlex.split(line, posix=False)
                tokens = [t.strip("\"'") for t in tokens if t.strip()]
                if not tokens:
                    continue
                parsed, unknown = task_parser.parse_known_args(tokens)
                if unknown:
                    print(f"[Warning] Batch line {line_num}: ignored unknown argument(s): {unknown}")
            except Exception as e:
                print(f"[Warning] Batch line {line_num}: syntax error ({e}), skipping: {line}", file=sys.stderr)
                continue

            skip_2d = parsed.skip_2d if parsed.skip_2d is not None else base_args.skip_2d
            skip_3d = parsed.skip_3d if parsed.skip_3d is not None else base_args.skip_3d
            tasks.append({
                "folder": parsed.folder,
                "cutoff": parsed.cutoff if parsed.cutoff is not None else base_args.cutoff,
                "picker_2d": parsed.picker_2d if parsed.picker_2d is not None else base_args.picker_2d,
                "fitter_2d": parsed.fitter_2d if parsed.fitter_2d is not None else base_args.fitter_2d,
                "include_2d": not skip_2d,
                "include_3d": not skip_3d,
                "timeout": parsed.timeout if parsed.timeout is not None else base_args.timeout,
                "line_num": line_num,
            })

    return tasks


def run_batch(tasks, global_args):
    """Executes multiple folder workflows sequentially using a shared local HTTP server."""
    total = len(tasks)
    print("=" * 80)
    print(f"COLMARVIEW FT3/FT2 BATCH PROCESSING: {total} folder(s) queued")
    print("=" * 80)

    repo_root = os.path.dirname(os.path.abspath(__file__))
    server, port = start_local_server(repo_root)
    print(f"[Batch Server] Shared web server active at http://127.0.0.1:{port}/")

    batch_results = []
    try:
        for idx, task in enumerate(tasks, 1):
            print("\n" + "#" * 80)
            print(f"# BATCH FOLDER [{idx}/{total}]: {task['folder']}")
            print("#" * 80)

            try:
                res = run_folder_workflow(
                    folder_path=task["folder"],
                    chrome_path=global_args.chrome_path,
                    headless=global_args.headless,
                    keep_browser=False,
                    peak_cutoff=task["cutoff"],
                    picker_2d=task["picker_2d"],
                    fitter_2d=task["fitter_2d"],
                    include_3d=task["include_3d"],
                    include_2d=task["include_2d"],
                    timeout_seconds=task["timeout"],
                    server_info=(server, port),
                )
                batch_results.append({"task": task, "status": "SUCCESS", "result": res})
            except Exception as err:
                print(f"\n[Batch Error] Folder [{idx}/{total}] failed: {err}", file=sys.stderr)
                batch_results.append({"task": task, "status": "FAILED", "error": str(err)})
    finally:
        server.shutdown()
        print("\n[Batch Server] Web server stopped.")

    print("\n" + "=" * 80)
    print(f"BATCH EXECUTION REPORT ({len(batch_results)} folder(s)):")
    print("=" * 80)
    num_success = sum(1 for r in batch_results if r["status"] == "SUCCESS")
    for idx, r in enumerate(batch_results, 1):
        folder_name = os.path.basename(os.path.normpath(r["task"]["folder"])) or r["task"]["folder"]
        if r["status"] == "SUCCESS":
            res = r["result"]
            print(f"  [{idx}/{total}] SUCCESS | {folder_name} ({len(res['results'])} spectra, {res['duration']:.1f}s)")
        else:
            print(f"  [{idx}/{total}] FAILED  | {folder_name} -> Error: {r['error']}")
    print("-" * 80)
    print(f"Summary: {num_success} succeeded, {len(batch_results) - num_success} failed out of {total} total.")
    print("=" * 80)

    if num_success < len(batch_results):
        sys.exit(1)


# ---------------------------------------------------------------------------
# 6. CLI Entry Point
# ---------------------------------------------------------------------------

def main():
    parser = argparse.ArgumentParser(
        description="Run automated COLMARVIEW peak picking/fitting on 3D (.ft3/.ft3.pipe) and 2D (.ft2/.ft2.pipe/.pipe) spectra in a folder."
    )
    parser.add_argument(
        "folder",
        nargs="?",
        default=None,
        help="Path to dataset folder containing .ft3/.ft3.pipe/.ft2/.pipe files, or a batch text file (.txt).",
    )
    parser.add_argument(
        "--batch", "--batch-file", "-b",
        dest="batch_file",
        default=None,
        help="Path to a text file containing batch directories (one per line).",
    )
    parser.add_argument(
        "--chrome-path",
        default=None,
        help="Path to custom Google Chrome executable.",
    )
    parser.add_argument(
        "--headless",
        action="store_true",
        help="Run Chrome in headless mode (default: False, headed mode).",
    )
    parser.add_argument(
        "--keep-browser",
        action="store_true",
        help="Keep Chrome open after the last spectrum completes (single folder run only).",
    )
    parser.add_argument(
        "--cutoff",
        type=float,
        default=0.4,
        help="Overlapping peak cutoff for 3D peak fitting (default: 0.4).",
    )
    parser.add_argument(
        "--picker-2d",
        choices=["deep", "simple"],
        default="deep",
        help="2D peak picker algorithm: 'deep' (default) or 'simple'.",
    )
    parser.add_argument(
        "--fitter-2d",
        choices=["voigt", "gaussian", "voigt-lorentzian"],
        default="voigt",
        help="2D peak fitting profile: 'voigt' (default), 'gaussian', or 'voigt-lorentzian'.",
    )
    parser.add_argument(
        "--skip-2d",
        action="store_true",
        help="Skip 2D spectra (only process 3D spectra).",
    )
    parser.add_argument(
        "--skip-3d",
        action="store_true",
        help="Skip 3D spectra (only process 2D spectra).",
    )
    parser.add_argument(
        "--timeout",
        type=int,
        default=3600,
        help="Timeout per spectrum step in seconds (default: 3600s).",
    )

    args = parser.parse_args()

    target = args.folder
    batch_file = args.batch_file

    if target and os.path.isfile(target):
        if target.lower().endswith(('.txt', '.batch', '.list')) or not is_spectrum_dir(target):
            batch_file = target
            target = None

    if batch_file:
        if not os.path.isfile(batch_file):
            print(f"Batch file not found: {batch_file}", file=sys.stderr)
            sys.exit(1)
        tasks = parse_batch_file(batch_file, args)
        if not tasks:
            print(f"No valid tasks found in batch file: {batch_file}", file=sys.stderr)
            sys.exit(1)
        run_batch(tasks, args)
    else:
        if not target:
            target = select_folder_interactively()

        try:
            run_folder_workflow(
                folder_path=target,
                chrome_path=args.chrome_path,
                headless=args.headless,
                keep_browser=args.keep_browser,
                peak_cutoff=args.cutoff,
                picker_2d=args.picker_2d,
                fitter_2d=args.fitter_2d,
                include_3d=not args.skip_3d,
                include_2d=not args.skip_2d,
                timeout_seconds=args.timeout,
            )
        except Exception as err:
            print(f"\n[Error] {err}", file=sys.stderr)
            sys.exit(1)


if __name__ == "__main__":
    main()

