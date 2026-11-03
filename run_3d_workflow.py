#!/usr/bin/env python3
"""
COLMARVIEW 3D Automated Workflow Runner
========================================
Runs the complete 3D NMR workflow from index_3d.html without manual browser intervention:
1. Serves the workspace via local HTTP server (ensuring secure context for WebGPU).
2. Launches system Google Chrome in headed mode with WebGPU hardware acceleration enabled.
3. Automatically locates and uploads Bruker 3D files (ser/fid, acqus, acqu2s, acqu3s, optional nuslist).
4. Enables automatic phase correction (multi-pass TF.js pipeline).
5. Executes 3D Fourier transform / NUS reconstruction.
6. Saves the processed spectrum as 'colmarvista_result.ft3' in the input folder.
7. Runs 3D peak picking and iterative fitting, saving 'colmarvista_peaks.txt' in the input folder.
"""

import os
import sys
import time
import base64
import shlex
import shutil
import argparse
import threading
import socketserver
import http.server
from pathlib import Path

# Try importing tkinter for GUI folder picker fallback
try:
    import tkinter as tk
    from tkinter import filedialog
    TKINTER_AVAILABLE = True
except ImportError:
    TKINTER_AVAILABLE = False

from playwright.sync_api import sync_playwright, TimeoutError as PlaywrightTimeoutError


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
    
    # Try which / where
    where_chrome = shutil.which("chrome") or shutil.which("google-chrome")
    if where_chrome and os.path.isfile(where_chrome):
        return where_chrome

    return None


# ---------------------------------------------------------------------------
# 2. Local HTTP Server (Secure Context for WebGPU)
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
    }

    def end_headers(self):
        # Enable CORS and SharedArrayBuffer if needed
        self.send_header('Access-Control-Allow-Origin', '*')
        self.send_header('Cross-Origin-Opener-Policy', 'same-origin')
        self.send_header('Cross-Origin-Embedder-Policy', 'require-corp')
        super().end_headers()

    def log_message(self, format, *args):
        # Suppress routine 200/304 request logs
        if len(args) > 1 and str(args[1]) in ("200", "304"):
            return
        # Print errors if any
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
# 3. Bruker File Resolution
# ---------------------------------------------------------------------------

def resolve_bruker_files(folder_path):
    """
    Finds required Bruker 3D files in folder_path or immediate subdirectories.
    Required: ser/fid, acqus, acqu2s, acqu3s
    Optional: nuslist
    """
    p = Path(folder_path).resolve()
    if not p.is_dir():
        raise FileNotFoundError(f"Selected path is not a directory: {p}")

    def scan_dir(d: Path):
        files = {f.name.lower(): f for f in d.iterdir() if f.is_file()}
        
        # FID / SER
        fid_file = files.get("ser") or files.get("fid") or files.get("fid.dat")
        acqus_file = files.get("acqus") or files.get("acqu")
        acqu2s_file = files.get("acqu2s") or files.get("acqu2")
        acqu3s_file = files.get("acqu3s") or files.get("acqu3")
        nuslist_file = files.get("nuslist")

        return fid_file, acqus_file, acqu2s_file, acqu3s_file, nuslist_file, d

    # 1. Check directory itself
    fid, a1, a2, a3, nus, active_dir = scan_dir(p)

    # 2. If not all required found, check immediate subdirectories (e.g., '1', '2')
    if not (fid and a1 and a2 and a3):
        for sub in sorted(p.iterdir()):
            if sub.is_dir():
                sub_fid, sub_a1, sub_a2, sub_a3, sub_nus, sub_dir = scan_dir(sub)
                if sub_fid and sub_a1 and sub_a2 and sub_a3:
                    fid, a1, a2, a3, nus, active_dir = sub_fid, sub_a1, sub_a2, sub_a3, sub_nus, sub_dir
                    break

    missing = []
    if not fid: missing.append("ser/fid")
    if not a1: missing.append("acqus")
    if not a2: missing.append("acqu2s")
    if not a3: missing.append("acqu3s")

    if missing:
        raise FileNotFoundError(
            f"Missing required Bruker files in '{p}': {', '.join(missing)}.\n"
            f"Expected ser/fid, acqus, acqu2s, and acqu3s."
        )

    return {
        "fid": str(fid),
        "acqus": str(a1),
        "acqu2s": str(a2),
        "acqu3s": str(a3),
        "nuslist": str(nus) if nus else None,
        "is_nus": bool(nus),
        "target_dir": str(active_dir)
    }


def is_bruker_dir(folder_path):
    """Checks whether folder_path contains a valid Bruker 3D dataset."""
    if not folder_path or not os.path.isdir(folder_path):
        return False
    try:
        resolve_bruker_files(folder_path)
        return True
    except Exception:
        return False


def select_folder_interactively():
    """Prompts the user to select a folder using GUI dialog or terminal."""
    if TKINTER_AVAILABLE:
        try:
            root = tk.Tk()
            root.withdraw()
            root.attributes('-topmost', True)
            print("Please select the 3D Bruker dataset folder in the dialog window...")
            chosen = filedialog.askdirectory(title="Select 3D Bruker Dataset Folder")
            root.destroy()
            if chosen and os.path.isdir(chosen):
                return chosen
        except Exception as e:
            print(f"[Warning] GUI dialog failed ({e}), falling back to CLI prompt.")

    while True:
        try:
            entry = input("\nEnter path to 3D Bruker dataset folder: ").strip().strip('"').strip("'")
            if entry and os.path.isdir(entry):
                return entry
            print(f"Directory not found: '{entry}'. Please try again.")
        except (KeyboardInterrupt, EOFError):
            print("\nAborted by user.")
            sys.exit(1)


# ---------------------------------------------------------------------------
# 4. Main Workflow Execution
# ---------------------------------------------------------------------------

def run_workflow(
    folder_path,
    mode="full",
    chrome_path=None,
    headless=False,
    keep_browser=False,
    peak_cutoff=0.4,
    timeout_seconds=900,
    extract_from=None,
    extract_to=None,
    flatt_baseline=False,
    indirect1_p0=None,
    indirect1_p1=None,
    indirect2_p0=None,
    indirect2_p1=None,
    server_info=None
):
    start_time = time.time()
    mode = "fid-only" if mode in ("fid-only", "fid_only", "fid") else "full"
    
    # 1. Resolve files
    print("=" * 70)
    print("COLMARVIEW 3D AUTOMATED NMR WORKFLOW")
    print(f"[Mode] {mode.upper()} ({'FID processing only' if mode == 'fid-only' else 'FID processing + Peak picking/fitting'})")
    print("=" * 70)
    bruker = resolve_bruker_files(folder_path)
    target_dir = bruker["target_dir"]
    is_nus = bruker["is_nus"]

    print(f"[Input Directory] {target_dir}")
    print(f"  • FID/SER:   {os.path.basename(bruker['fid'])} ({os.path.getsize(bruker['fid']):,} bytes)")
    print(f"  • acqus:     {os.path.basename(bruker['acqus'])}")
    print(f"  • acqu2s:    {os.path.basename(bruker['acqu2s'])}")
    print(f"  • acqu3s:    {os.path.basename(bruker['acqu3s'])}")
    if is_nus:
        print(f"  • nuslist:   {os.path.basename(bruker['nuslist'])} (NUS experiment detected)")
    else:
        print("  • nuslist:   None (Uniform / conventional 3D experiment)")
    print("-" * 70)

    # 2. Locate Chrome
    resolved_chrome = chrome_path or find_system_chrome()
    if not resolved_chrome or not os.path.isfile(resolved_chrome):
        raise RuntimeError(
            f"Google Chrome executable not found at '{resolved_chrome}'.\n"
            f"Please specify via --chrome-path or install Chrome."
        )
    print(f"[Chrome] Using system Chrome: {resolved_chrome}")

    # 3. HTTP Server management
    repo_root = os.path.dirname(os.path.abspath(__file__))
    own_server = False
    if server_info is not None:
        server, port = server_info
    else:
        server, port = start_local_server(repo_root)
        own_server = True

    app_url = f"http://127.0.0.1:{port}/index_3d.html"
    print(f"[Server] Local web server running at {app_url}")

    # 4. Launch Chrome with WebGPU flags
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

    print(f"[Browser] Launching Chrome (headed={not headless}, WebGPU enabled)...")

    with sync_playwright() as p:
        browser = p.chromium.launch(
            executable_path=resolved_chrome,
            headless=headless,
            args=chrome_args
        )
        context = browser.new_context(
            accept_downloads=True,
            viewport={"width": 1400, "height": 950}
        )
        page = context.new_page()

        # Stream web console messages to terminal
        def on_console(msg):
            text = msg.text
            # Filter noise, display significant logs
            if any(k in text for k in [
                "[webass_3d]", "[smile", "[tfjs", "[main", "[auto-phase", 
                "process_fid_3d", "pick_and_fit_3d", "Error", "error", "Failed"
            ]):
                print(f"  [colmarview] {text}")

        page.on("console", on_console)

        # Handle any modal dialogs (alerts)
        def on_dialog(dialog):
            print(f"  [Dialog Alert] {dialog.type.upper()}: {dialog.message}")
            dialog.accept()

        page.on("dialog", on_dialog)

        try:
            print(f"[App] Navigating to {app_url}...")
            page.goto(app_url, wait_until="networkidle")

            # Check WebGPU availability in the page context
            has_webgpu = page.evaluate("() => typeof navigator !== 'undefined' && !!navigator.gpu")
            print(f"[WebGPU] navigator.gpu available in page: {has_webgpu}")
            if not has_webgpu:
                print("[Warning] WebGPU is not detected in this Chrome session. SMILE may fall back to CPU.")

            # 5. Populate file inputs
            print("[Upload] Uploading Bruker experiment files...")
            page.locator('#fid_file').set_input_files(bruker['fid'])
            page.locator('#acquisition_file').set_input_files(bruker['acqus'])
            page.locator('#acquisition_file2').set_input_files(bruker['acqu2s'])
            page.locator('#acquisition_file3').set_input_files(bruker['acqu3s'])
            if bruker['nuslist']:
                page.locator('#nuslist_file').set_input_files(bruker['nuslist'])

            # 6. Configure parameters
            # Reveal options panel so user can visually inspect parameters in headed mode
            options_section = page.locator('#input_options')
            if not options_section.is_visible():
                page.locator('#button_toggle_options').click()

            # Enable automatic phase correction
            print("[Config] Enabling Automatic phase correction...")
            page.evaluate("""(opts) => {
                const autoPhaseCb = document.getElementById('normal_direct_dim_auto_phase_3d');
                if (autoPhaseCb) {
                    autoPhaseCb.checked = true;
                    autoPhaseCb.dispatchEvent(new Event('change', { bubbles: true }));
                }
                if (opts.extractFrom !== null && opts.extractFrom !== undefined) {
                    const el = document.getElementById('extract_direct_from');
                    if (el) {
                        el.value = opts.extractFrom;
                        el.dispatchEvent(new Event('change', { bubbles: true }));
                    }
                }
                if (opts.extractTo !== null && opts.extractTo !== undefined) {
                    const el = document.getElementById('extract_direct_to');
                    if (el) {
                        el.value = opts.extractTo;
                        el.dispatchEvent(new Event('change', { bubbles: true }));
                    }
                }
                if (opts.flatt) {
                    const el = document.getElementById('nus_flatt_baseline_3d');
                    if (el) {
                        el.checked = true;
                        el.dispatchEvent(new Event('change', { bubbles: true }));
                    }
                }
                if (opts.indirect1_p0 !== null && opts.indirect1_p0 !== undefined) {
                    const el = document.getElementById('phase_correction_indirect1_p0');
                    if (el) {
                        el.value = opts.indirect1_p0;
                        el.dispatchEvent(new Event('change', { bubbles: true }));
                    }
                }
                if (opts.indirect1_p1 !== null && opts.indirect1_p1 !== undefined) {
                    const el = document.getElementById('phase_correction_indirect1_p1');
                    if (el) {
                        el.value = opts.indirect1_p1;
                        el.dispatchEvent(new Event('change', { bubbles: true }));
                    }
                }
                if (opts.indirect2_p0 !== null && opts.indirect2_p0 !== undefined) {
                    const el = document.getElementById('phase_correction_indirect2_p0');
                    if (el) {
                        el.value = opts.indirect2_p0;
                        el.dispatchEvent(new Event('change', { bubbles: true }));
                    }
                }
                if (opts.indirect2_p1 !== null && opts.indirect2_p1 !== undefined) {
                    const el = document.getElementById('phase_correction_indirect2_p1');
                    if (el) {
                        el.value = opts.indirect2_p1;
                        el.dispatchEvent(new Event('change', { bubbles: true }));
                    }
                }
            }""", {
                "extractFrom": extract_from,
                "extractTo": extract_to,
                "flatt": flatt_baseline,
                "indirect1_p0": indirect1_p0,
                "indirect1_p1": indirect1_p1,
                "indirect2_p0": indirect2_p0,
                "indirect2_p1": indirect2_p1
            })

            if indirect1_p0 is not None:
                print(f"[Config] Set Indirect 1 P0: {indirect1_p0}")
            if indirect1_p1 is not None:
                print(f"[Config] Set Indirect 1 P1: {indirect1_p1}")
            if indirect2_p0 is not None:
                print(f"[Config] Set Indirect 2 P0: {indirect2_p0}")
            if indirect2_p1 is not None:
                print(f"[Config] Set Indirect 2 P1: {indirect2_p1}")

            # Overlapping peak cutoff for fitting (set via JS in case aux_buttons is hidden)
            if peak_cutoff is not None:
                page.evaluate(f"() => {{ const el = document.getElementById('input_new_peak_cutoff'); if (el) el.value = '{peak_cutoff}'; }}")
                print(f"[Config] Overlapping peak cutoff set to: {peak_cutoff}")

            # 7. Start processing
            print("[Process] Triggering 3D FID Processing...")
            page.locator('#button_fid_process_3d').click()

            # Wait for FID processing to complete
            # Conditions for completion:
            # - #main_plot_area is visible, or spectra_3d is loaded
            # - #button_save_ft3 is visible
            print("[Process] Processing running in WebAssembly / SMILE / TF.js...")
            print("          (Please observe progress in terminal and Chrome window)")

            process_start = time.time()
            last_status = ""

            while True:
                elapsed = time.time() - process_start
                if elapsed > timeout_seconds:
                    raise TimeoutError(f"3D FID processing timed out after {timeout_seconds} seconds.")

                # Check error message in page
                msg = page.evaluate("() => (document.getElementById('webassembly_message') ? document.getElementById('webassembly_message').innerText : '')")
                if msg and msg != last_status:
                    print(f"  [Status] {msg}")
                    last_status = msg
                    if msg.startswith("Error:"):
                        raise RuntimeError(f"Processing error in webass_3d: {msg}")

                # Check if processing has fully completed
                is_done = page.evaluate("""() => {
                    const plotArea = document.getElementById('main_plot_area');
                    const hasSpectra = typeof spectra_3d !== 'undefined' && spectra_3d !== null && spectra_3d.length > 0;
                    const saveBtn = document.getElementById('button_save_ft3');
                    const isVisible = plotArea && window.getComputedStyle(plotArea).display !== 'none';
                    return hasSpectra && isVisible;
                }""")

                if is_done:
                    print(f"[Process] 3D FID processing completed in {time.time() - process_start:.1f}s!")
                    break

                page.wait_for_timeout(1000)

            # Allow 1 second for plot renderings to stabilize
            page.wait_for_timeout(1000)

            # 8. Save colmarvista_result.ft3
            ft3_output_path = os.path.join(target_dir, "colmarvista_result.ft3")
            print(f"[Output] Exporting 3D spectrum to: {ft3_output_path}...")

            # Trigger native browser download directly from download_ft3()
            with page.expect_download(timeout=60000) as download_info:
                page.evaluate("() => { if (typeof download_ft3 === 'function') download_ft3(); }")
            download = download_info.value
            download.save_as(ft3_output_path)

            file_size_mb = os.path.getsize(ft3_output_path) / (1024 * 1024)
            print(f"[Output] Successfully saved {ft3_output_path} ({file_size_mb:.2f} MB)")

            # 9. Run Peak Picking and Fitting (if mode is full)
            peaks_output_path = None
            num_peaks = 0

            if mode == "fid-only":
                print("-" * 70)
                print("[Peak Pick] Mode is 'fid-only'. Skipping 3D peak picking and fitting.")
            else:
                print("-" * 70)
                print("[Peak Pick] Starting 3D peak picking and iterative fitting...")
                page.evaluate("() => { if (typeof run_peak_fit_3d_workflow === 'function') run_peak_fit_3d_workflow(); }")

                fit_start = time.time()
                last_fit_status = ""

                while True:
                    elapsed_fit = time.time() - fit_start
                    if elapsed_fit > timeout_seconds:
                        raise TimeoutError(f"Peak picking & fitting timed out after {timeout_seconds} seconds.")

                    msg = page.evaluate("() => (document.getElementById('webassembly_message') ? document.getElementById('webassembly_message').innerText : '')")
                    if msg and msg != last_fit_status:
                        print(f"  [Status] {msg}")
                        last_fit_status = msg
                        if msg.startswith("Peak picking/fitting failed:"):
                            raise RuntimeError(f"Fitting error: {msg}")

                    is_fit_done = page.evaluate("""() => {
                        const dlBtn = document.getElementById('button_download_peaks_list');
                        const hasPeaksText = typeof window.fitted_peaks_text_data === 'string' && window.fitted_peaks_text_data.length > 0;
                        return dlBtn && !dlBtn.disabled && hasPeaksText;
                    }""")

                    if is_fit_done:
                        print(f"[Peak Pick] Peak picking & fitting completed in {time.time() - fit_start:.1f}s!")
                        break

                    page.wait_for_timeout(1000)

                # 10. Save colmarvista_peaks.txt
                peaks_output_path = os.path.join(target_dir, "colmarvista_peaks.txt")
                peaks_text = page.evaluate("() => window.fitted_peaks_text_data")

                with open(peaks_output_path, "w", encoding="utf-8") as f:
                    f.write(peaks_text)

                peak_lines = [l for l in peaks_text.splitlines() if l.strip() and not l.startswith("=")]
                num_peaks = max(0, len(peak_lines) - 1)  # Subtract header line
                print(f"[Output] Successfully saved {peaks_output_path} ({num_peaks} peaks fitted)")

            # Summary
            total_duration = time.time() - start_time
            print("=" * 70)
            print("WORKFLOW SUMMARY:")
            print(f"  • Spectrum FT3: {ft3_output_path} ({file_size_mb:.2f} MB)")
            if peaks_output_path and os.path.isfile(peaks_output_path):
                print(f"  • Fitted Peaks: {peaks_output_path} ({num_peaks} peaks)")
            else:
                print(f"  • Peak Fitting: Skipped (mode='{mode}')")
            print(f"  • Total Time:   {total_duration:.1f} seconds")
            print("=" * 70)

            if keep_browser:
                print("\n[Notice] --keep-browser is enabled. The browser will stay open.")
                print("Press Enter in this terminal when finished to close the browser...")
                try:
                    input()
                except (KeyboardInterrupt, EOFError):
                    pass

            return {
                "success": True,
                "target_dir": target_dir,
                "mode": mode,
                "ft3_path": ft3_output_path,
                "ft3_size_mb": file_size_mb,
                "peaks_path": peaks_output_path,
                "num_peaks": num_peaks,
                "duration": total_duration
            }

        finally:
            if not keep_browser:
                browser.close()
            if own_server and server:
                server.shutdown()


# ---------------------------------------------------------------------------
# 5. Batch File Processing
# ---------------------------------------------------------------------------

def make_task_parser():
    """Builds a lightweight parser for individual lines in a batch file."""
    p = argparse.ArgumentParser(prog="batch_line", add_help=False)
    p.add_argument("folder", help="Path to 3D Bruker dataset folder")
    p.add_argument(
        "--mode",
        choices=["full", "fid-only", "fid_only"],
        default=None,
        help="Run mode: 'full' (processing + fitting, default) or 'fid-only'."
    )
    p.add_argument(
        "--fid-only",
        action="store_true",
        default=False,
        help="Shortcut for --mode fid-only."
    )
    p.add_argument(
        "--cutoff",
        type=float,
        default=None,
        help="Overlapping peak cutoff for 3D peak fitting."
    )
    p.add_argument(
        "--extract-from",
        type=float,
        default=None,
        help="Direct dimension extraction start ppm."
    )
    p.add_argument(
        "--extract-to",
        type=float,
        default=None,
        help="Direct dimension extraction end ppm."
    )
    p.add_argument(
        "--flatt",
        action="store_true",
        default=None,
        help="Enable NUS FLATT baseline correction along F2 traces."
    )
    p.add_argument(
        "--indirect1-p0", "--i1p0",
        type=float,
        default=None,
        help="Indirect dimension 1 (F1) phase correction P0 (degrees)."
    )
    p.add_argument(
        "--indirect1-p1", "--i1p1",
        type=float,
        default=None,
        help="Indirect dimension 1 (F1) phase correction P1 (degrees)."
    )
    p.add_argument(
        "--indirect2-p0", "--i2p0",
        type=float,
        default=None,
        help="Indirect dimension 2 (F3) phase correction P0 (degrees)."
    )
    p.add_argument(
        "--indirect2-p1", "--i2p1",
        type=float,
        default=None,
        help="Indirect dimension 2 (F3) phase correction P1 (degrees)."
    )
    p.add_argument(
        "--timeout",
        type=int,
        default=None,
        help="Timeout in seconds."
    )
    return p


def parse_batch_file(batch_path, base_args):
    """
    Parses a text file containing batch tasks.
    Each non-empty, non-comment line specifies a dataset folder and optional override flags.
    Lines starting with '#' or '//' are treated as comments.
    """
    tasks = []
    task_parser = make_task_parser()
    
    with open(batch_path, 'r', encoding='utf-8', errors='replace') as f:
        for line_num, raw_line in enumerate(f, 1):
            line = raw_line.strip()
            if not line or line.startswith('#') or line.startswith('//'):
                continue
            
            try:
                tokens = shlex.split(line, posix=False)
                tokens = [t.strip('"\'') for t in tokens if t.strip()]
                if not tokens:
                    continue
                parsed, unknown = task_parser.parse_known_args(tokens)
                if unknown:
                    print(f"[Warning] Batch line {line_num}: ignored unknown argument(s): {unknown}")
            except Exception as e:
                print(f"[Warning] Batch line {line_num}: syntax error ({e}), skipping: {line}", file=sys.stderr)
                continue

            # Determine mode for this task
            if parsed.fid_only_flag or parsed.mode in ("fid-only", "fid_only"):
                task_mode = "fid-only"
            elif parsed.mode == "full":
                task_mode = "full"
            else:
                task_mode = base_args.mode

            task = {
                "folder": parsed.folder,
                "mode": task_mode,
                "cutoff": parsed.cutoff if parsed.cutoff is not None else base_args.cutoff,
                "extract_from": parsed.extract_from if parsed.extract_from is not None else base_args.extract_from,
                "extract_to": parsed.extract_to if parsed.extract_to is not None else base_args.extract_to,
                "flatt": parsed.flatt if parsed.flatt is not None else base_args.flatt,
                "indirect1_p0": parsed.indirect1_p0 if parsed.indirect1_p0 is not None else base_args.indirect1_p0,
                "indirect1_p1": parsed.indirect1_p1 if parsed.indirect1_p1 is not None else base_args.indirect1_p1,
                "indirect2_p0": parsed.indirect2_p0 if parsed.indirect2_p0 is not None else base_args.indirect2_p0,
                "indirect2_p1": parsed.indirect2_p1 if parsed.indirect2_p1 is not None else base_args.indirect2_p1,
                "timeout": parsed.timeout if parsed.timeout is not None else base_args.timeout,
                "line_num": line_num
            }
            tasks.append(task)
            
    return tasks


def run_batch(tasks, global_args):
    """
    Executes multiple tasks sequentially.
    Crucially: Closes the browser after each task before launching the next one,
    even in headed mode, so each dataset runs in an isolated, clean session.
    """
    total = len(tasks)
    print("=" * 80)
    print(f"COLMARVIEW 3D BATCH PROCESSING: {total} dataset(s) queued")
    print("=" * 80)
    
    repo_root = os.path.dirname(os.path.abspath(__file__))
    server, port = start_local_server(repo_root)
    print(f"[Batch Server] Shared web server active at http://127.0.0.1:{port}/")
    
    results = []
    
    try:
        for idx, task in enumerate(tasks, 1):
            print("\n" + "#" * 80)
            print(f"# BATCH TASK [{idx}/{total}]: {task['folder']} (Mode: {task['mode'].upper()})")
            print("#" * 80)
            
            try:
                res = run_workflow(
                    folder_path=task["folder"],
                    mode=task["mode"],
                    chrome_path=global_args.chrome_path,
                    headless=global_args.headless,
                    keep_browser=False,  # Close browser between batch tasks
                    peak_cutoff=task["cutoff"],
                    timeout_seconds=task["timeout"],
                    extract_from=task["extract_from"],
                    extract_to=task["extract_to"],
                    flatt_baseline=task["flatt"],
                    indirect1_p0=task["indirect1_p0"],
                    indirect1_p1=task["indirect1_p1"],
                    indirect2_p0=task["indirect2_p0"],
                    indirect2_p1=task["indirect2_p1"],
                    server_info=(server, port)
                )
                results.append({"task": task, "status": "SUCCESS", "result": res})
            except Exception as err:
                print(f"\n[Batch Error] Task [{idx}/{total}] failed: {err}", file=sys.stderr)
                results.append({"task": task, "status": "FAILED", "error": str(err)})

    finally:
        server.shutdown()
        print("\n[Batch Server] Web server stopped.")

    # Final summary report
    print("\n" + "=" * 80)
    print(f"BATCH EXECUTION REPORT ({len(results)} datasets):")
    print("=" * 80)
    num_success = sum(1 for r in results if r["status"] == "SUCCESS")
    num_fail = len(results) - num_success

    for idx, r in enumerate(results, 1):
        task = r["task"]
        status = r["status"]
        folder_display = os.path.basename(os.path.normpath(task["folder"])) or task["folder"]
        if status == "SUCCESS":
            res = r["result"]
            peak_str = f"{res['num_peaks']} peaks" if res["num_peaks"] > 0 else "peaks skipped"
            print(f"  [{idx}/{total}] SUCCESS | {folder_display} ({task['mode']}) -> FT3: {res['ft3_size_mb']:.1f} MB, {peak_str} ({res['duration']:.1f}s)")
        else:
            print(f"  [{idx}/{total}] FAILED  | {folder_display} ({task['mode']}) -> Error: {r['error']}")

    print("-" * 80)
    print(f"Summary: {num_success} succeeded, {num_fail} failed out of {total} total.")
    print("=" * 80)


# ---------------------------------------------------------------------------
# 6. CLI Argument Parsing
# ---------------------------------------------------------------------------

def main():
    parser = argparse.ArgumentParser(
        description="Run automated COLMARVIEW 3D workflow (processing, auto-phase, FT3 export, peak picking/fitting)."
    )
    parser.add_argument(
        "folder",
        nargs="?",
        default=None,
        help="Path to Bruker 3D experiment directory, or a batch text file (.txt)."
    )
    parser.add_argument(
        "--batch", "--batch-file", "-b",
        dest="batch_file",
        default=None,
        help="Path to a text file containing batch directories and optional parameters (one per line)."
    )
    parser.add_argument(
        "--mode",
        choices=["full", "fid-only", "fid_only"],
        default="full",
        help="Execution mode: 'full' (FID processing + peak picking/fitting, default) or 'fid-only' (process FID and save FT3 only)."
    )
    parser.add_argument(
        "--fid-only",
        action="store_true",
        default=False,
        help="Shortcut for --mode fid-only."
    )
    parser.add_argument(
        "--chrome-path",
        default=None,
        help="Path to custom Google Chrome executable."
    )
    parser.add_argument(
        "--headless",
        action="store_true",
        help="Run Chrome in headless mode (default: False, headed mode for visual check)."
    )
    parser.add_argument(
        "--keep-browser",
        action="store_true",
        help="Keep the Chrome browser window open after completion for visual inspection (single run only)."
    )
    parser.add_argument(
        "--cutoff",
        type=float,
        default=0.4,
        help="Overlapping peak cutoff for 3D peak fitting (default: 0.4)."
    )
    parser.add_argument(
        "--extract-from",
        type=float,
        default=None,
        help="Direct dimension extraction start ppm (default: from index_3d.html = 11.3)."
    )
    parser.add_argument(
        "--extract-to",
        type=float,
        default=None,
        help="Direct dimension extraction end ppm (default: from index_3d.html = 5.2)."
    )
    parser.add_argument(
        "--flatt",
        action="store_true",
        help="Enable NUS FLATT baseline correction along F2 traces."
    )
    parser.add_argument(
        "--indirect1-p0", "--i1p0",
        type=float,
        default=None,
        help="Indirect dimension 1 (F1) phase correction P0 (degrees)."
    )
    parser.add_argument(
        "--indirect1-p1", "--i1p1",
        type=float,
        default=None,
        help="Indirect dimension 1 (F1) phase correction P1 (degrees)."
    )
    parser.add_argument(
        "--indirect2-p0", "--i2p0",
        type=float,
        default=None,
        help="Indirect dimension 2 (F3) phase correction P0 (degrees)."
    )
    parser.add_argument(
        "--indirect2-p1", "--i2p1",
        type=float,
        default=None,
        help="Indirect dimension 2 (F3) phase correction P1 (degrees)."
    )
    parser.add_argument(
        "--timeout",
        type=int,
        default=900,
        help="Timeout in seconds for processing and fitting (default: 900s / 15 mins)."
    )

    args = parser.parse_args()

    # Normalize mode
    if args.fid_only or args.mode in ("fid-only", "fid_only"):
        args.mode = "fid-only"
    else:
        args.mode = "full"

    target = args.folder
    batch_file = args.batch_file

    # Auto-detect if positional folder argument is actually a batch text file
    if target and os.path.isfile(target):
        if target.lower().endswith(('.txt', '.batch', '.list')) or not is_bruker_dir(target):
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

        run_workflow(
            folder_path=target,
            mode=args.mode,
            chrome_path=args.chrome_path,
            headless=args.headless,
            keep_browser=args.keep_browser,
            peak_cutoff=args.cutoff,
            timeout_seconds=args.timeout,
            extract_from=args.extract_from,
            extract_to=args.extract_to,
            flatt_baseline=args.flatt,
            indirect1_p0=args.indirect1_p0,
            indirect1_p1=args.indirect1_p1,
            indirect2_p0=args.indirect2_p0,
            indirect2_p1=args.indirect2_p1
        )


if __name__ == "__main__":
    main()
