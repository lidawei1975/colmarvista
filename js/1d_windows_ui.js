(function () {
    const worker = window.webassembly_1d_worker_2;
    const pendingWorkerJobs = new Set();
    let nextWorkerJobId = 0;
    let pendingFileReads = 0;
    let pendingBackgroundJobs = 0;
    let windowsUiActive = false;
    let peakTableEnabled = false;
    window.colmar1dPeakTableEnabled = false;

    window.colmar1dBeginFileRead = function () {
        pendingFileReads += 1;
        let finished = false;
        return function () {
            if (finished) return;
            finished = true;
            pendingFileReads = Math.max(0, pendingFileReads - 1);
        };
    };

    window.colmar1dBeginBackgroundJob = function () {
        pendingBackgroundJobs += 1;
        let finished = false;
        return function () {
            if (finished) return;
            finished = true;
            pendingBackgroundJobs = Math.max(0, pendingBackgroundJobs - 1);
        };
    };

    window.colmar1dIsIdle = function () {
        return pendingWorkerJobs.size === 0
            && pendingFileReads === 0
            && pendingBackgroundJobs === 0
            && !(document.body && document.body.classList.contains("processing-background-job"));
    };

    if (worker && typeof worker.postMessage === "function") {
        const postMessage = worker.postMessage.bind(worker);
        const jobKey = "#sym:webassembly_job ";
        worker.postMessage = function (message, transferList) {
            const jobType = message && (message[jobKey] || message.webassembly_job);
            if (!jobType || jobType === "test_1d") return postMessage(message, transferList);
            const jobId = ++nextWorkerJobId;
            pendingWorkerJobs.add(jobId);
            try {
                return postMessage(Object.assign({}, message, { __colmar_1d_job_id: jobId }), transferList);
            } catch (error) {
                pendingWorkerJobs.delete(jobId);
                throw error;
            }
        };
        worker.addEventListener("message", event => {
            const jobId = event.data && event.data.__colmar_1d_job_complete;
            if (typeof jobId === "number") pendingWorkerJobs.delete(jobId);
        });
        worker.addEventListener("error", () => pendingWorkerJobs.clear());
    }

    const commandButtons = new Map();
    document.querySelectorAll("[data-one-d-command]").forEach(button => {
        commandButtons.set(button.dataset.oneDCommand, button);
    });

    function setExpanded(command, expanded) {
        const button = commandButtons.get(command);
        if (button) button.setAttribute("aria-expanded", String(expanded));
    }

    function closeButton(label, onClose) {
        const button = document.createElement("button");
        button.type = "button";
        button.className = "one-d-close";
        button.textContent = "Close";
        button.setAttribute("aria-label", `Close ${label}`);
        button.addEventListener("click", onClose);
        return button;
    }

    function installPanelHeader(panel, label, closePanel) {
        if (!panel || panel.querySelector(":scope > .one-d-panel-header")) return;
        const header = document.createElement("div");
        header.className = "one-d-panel-header";
        const title = document.createElement("strong");
        title.textContent = label;
        header.append(title, closeButton(label, closePanel));
        panel.insertBefore(header, panel.firstChild);
    }

    function setPanelOpen(id, open, command) {
        const panel = document.getElementById(id);
        if (!panel) return;
        panel.classList.toggle("windows-1d-panel-open", open);
        panel.classList.toggle("windows-1d-panel-hidden", !open);
        setExpanded(command, open);

        if (open && id === "fid_file_area") {
            const minimize = document.getElementById("button_minimize_fid_area");
            if (minimize && minimize.innerText.trim() === "+") minimize.click();
        }
        if (open && id === "file_area") {
            const minimize = document.getElementById("button_minimize_file_area");
            if (minimize && minimize.innerText.trim() === "+") minimize.click();
        }
    }

    function setPlotControlsOpen(open) {
        const plot = document.getElementById("plot");
        if (!plot) return;
        plot.classList.toggle("windows-1d-controls-open", open);
        setExpanded("plot-controls", open);
        if (open) document.getElementById("button_close_1d_plot_controls")?.focus();
        else commandButtons.get("plot-controls")?.focus();
    }

    function setPeakTableEnabled(enabled) {
        peakTableEnabled = enabled;
        window.colmar1dPeakTableEnabled = enabled;
        const button = commandButtons.get("peaks");
        if (button) button.setAttribute("aria-pressed", String(enabled));
        const peakArea = document.getElementById("peak_area");
        if (peakArea) {
            peakArea.classList.toggle("windows-1d-panel-open", enabled);
            peakArea.classList.toggle("windows-1d-panel-hidden", !enabled);
        }
        if (!enabled) {
            if (typeof window.remove_peak_table === "function") window.remove_peak_table();
            return;
        }
        if (window.current_spectrum_index_of_peaks !== -1 && typeof window.show_peak_table === "function") {
            window.show_peak_table();
        } else if (peakArea) {
            peakArea.classList.remove("windows-1d-panel-open");
            peakArea.classList.add("windows-1d-panel-hidden");
        }
    }

    function toggleLog(open) {
        const log = document.getElementById("log_area");
        if (!log) return;
        log.classList.toggle("windows-1d-panel-open", open);
        log.classList.toggle("windows-1d-panel-hidden", !open);
        setExpanded("log", open);
    }

    function closeAllPanels() {
        ["load_and_save", "fid_file_area", "file_area", "peak_area"].forEach(id => {
            const panel = document.getElementById(id);
            if (panel) {
                panel.classList.remove("windows-1d-panel-open");
                panel.classList.add("windows-1d-panel-hidden");
            }
        });
        toggleLog(false);
        setPlotControlsOpen(false);
        for (const command of ["load", "session", "fid", "spectrum"]) setExpanded(command, false);
    }

    function switchUiMode(useWindowsUi, force = false) {
        if (useWindowsUi === windowsUiActive) return true;
        if (!force && !window.colmar1dIsIdle()) {
            const toggle = document.getElementById("ui-mode-toggle-1d");
            if (toggle) toggle.checked = windowsUiActive;
            const navToggle = document.querySelector("#navbar-placeholder .navbar input[type='checkbox']");
            if (navToggle) navToggle.checked = windowsUiActive;
            window.alert("Wait for 1D processing to finish before switching UI.");
            return false;
        }

        closeAllPanels();
        windowsUiActive = useWindowsUi;
        document.documentElement.classList.toggle("windows-ui-1d", useWindowsUi);
        document.documentElement.classList.toggle("legacy-ui-mode", !useWindowsUi);
        document.body.classList.toggle("windows-ui-1d", useWindowsUi);
        document.body.classList.toggle("legacy-ui-mode", !useWindowsUi);
        const toggle = document.getElementById("ui-mode-toggle-1d");
        if (toggle) toggle.checked = useWindowsUi;
        const navToggle = document.querySelector("#navbar-placeholder .navbar input[type='checkbox']");
        if (navToggle) navToggle.checked = useWindowsUi;
        const url = new URL(window.location.href);
        if (useWindowsUi) url.searchParams.set("ui", "windows");
        else url.searchParams.set("ui", "legacy");
        window.history.replaceState(null, "", url);
        document.title = useWindowsUi ? "COLMARvista 1D - Windows UI" : "COLMARvista1D";
        if (useWindowsUi && peakTableEnabled) {
            setPeakTableEnabled(true);
        }
        window.dispatchEvent(new Event("resize"));
        return true;
    }

    window.colmar1dSwitchUiMode = switchUiMode;

    function initializePanels() {
        const panels = [
            ["load_and_save", "Session files", "session"],
            ["fid_file_area", "FID processing", "fid"],
            ["file_area", "Load FT1 spectrum", "spectrum"]
        ];
        for (const [id, label, command] of panels) {
            const panel = document.getElementById(id);
            if (!panel) continue;
            panel.classList.add("windows-1d-panel", "windows-1d-panel-hidden");
            installPanelHeader(panel, label, () => setPanelOpen(id, false, command));
        }

        const peakArea = document.getElementById("peak_area");
        if (peakArea) {
            peakArea.classList.add("windows-1d-panel", "windows-1d-panel-hidden");
            const header = peakArea.querySelector(":scope > .header_sticky");
            if (header) header.appendChild(closeButton("peak table", () => setPeakTableEnabled(false)));
        }

        const logArea = document.getElementById("log_area");
        if (logArea) {
            logArea.classList.add("windows-1d-panel", "windows-1d-panel-hidden");
            const actions = logArea.querySelector(".log-actions");
            if (actions) actions.appendChild(closeButton("processing log", () => toggleLog(false)));
        }

        const plot = document.getElementById("plot");
        const plotControls = plot && plot.querySelector(":scope > div:first-child");
        if (plotControls && !document.getElementById("button_close_1d_plot_controls")) {
            const close = closeButton("plot controls", () => setPlotControlsOpen(false));
            close.id = "button_close_1d_plot_controls";
            close.style.float = "right";
            plotControls.insertBefore(close, plotControls.firstChild);
        }
    }

    function runCommand(command) {
        switch (command) {
            case "save":
                if (typeof window.save_to_file === "function") window.save_to_file();
                break;
            case "load":
                setPanelOpen("load_and_save", true, "load");
                document.getElementById("load_file")?.click();
                break;
            case "session":
                setPanelOpen("load_and_save", true, "session");
                break;
            case "fid":
                setPanelOpen("fid_file_area", true, "fid");
                break;
            case "spectrum":
                setPanelOpen("file_area", true, "spectrum");
                document.getElementById("userfile")?.click();
                break;
            case "plot-controls":
                const plot = document.getElementById("plot");
                if (plot) setPlotControlsOpen(!plot.classList.contains("windows-1d-controls-open"));
                break;
            case "peaks":
                setPeakTableEnabled(!peakTableEnabled);
                break;
            case "log":
                toggleLog(document.getElementById("log_area").classList.contains("windows-1d-panel-hidden"));
                break;
        }
    }

    initializePanels();
    document.querySelectorAll("[data-one-d-command]").forEach(button => {
        button.addEventListener("click", () => runCommand(button.dataset.oneDCommand));
    });

    const modeToggle = document.getElementById("ui-mode-toggle-1d");
    if (modeToggle) modeToggle.addEventListener("change", () => switchUiMode(modeToggle.checked));
    document.addEventListener("click", event => {
        const target = event.target instanceof Element ? event.target : event.target.parentElement;
        const link = target && target.closest("[data-one-d-mode]");
        if (link) {
            event.preventDefault();
            switchUiMode(link.dataset.oneDMode === "windows");
            return;
        }
        if (target && target.closest('#navbar-placeholder .navbar input[type="checkbox"]')) {
            event.preventDefault();
            const checkbox = target.closest('input[type="checkbox"]');
            switchUiMode(checkbox.checked);
        }
    });

    if (new URLSearchParams(window.location.search).get("ui") === "windows") {
        switchUiMode(true, true);
    }
})();