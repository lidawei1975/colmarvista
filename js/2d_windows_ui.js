        function appDocument() {
            return document;
        }

        function appElement(id) {
            return appDocument().getElementById(id);
        }

        let peakTableEnabled = false;
        window.colmarWindowsPeakTableEnabled = peakTableEnabled;

        function clickAppElement(id) {
            const element = appElement(id);
            if (element) element.click();
        }

        function setRibbonButtonExpanded(command, expanded) {
            const button = document.querySelector(`[data-command="${command}"]`);
            if (button) button.setAttribute("aria-expanded", String(expanded));
        }

        function setPeakTableEnabled(enabled) {
            peakTableEnabled = enabled;
            window.colmarWindowsPeakTableEnabled = enabled;
            const button = document.querySelector('[data-command="peaks"]');
            if (button) {
                button.setAttribute("aria-pressed", String(enabled));
                button.title = enabled ? "Hide the peak table" : "Show the peak table";
            }

            if (!enabled || window.current_spectrum_index_of_peaks === -1) {
                if (typeof window.remove_peak_table === "function") window.remove_peak_table();
            } else if (typeof window.show_peak_table === "function") {
                window.show_peak_table();
            }
        }

        function togglePanel(id) {
            const element = appElement(id);
            if (element) {
                const hidden = id === "peak_area"
                    ? !element.classList.contains("windows-peak-visible")
                    : element.style.display === "none" || element.classList.contains("windows-panel-hidden");
                if (id === "peak_area") element.classList.toggle("windows-peak-visible", hidden);
                else element.classList.toggle("windows-panel-hidden", !hidden);
                element.style.display = hidden ? (id === "log_area" ? "flex" : "block") : "none";
                if (id === "log_area") setRibbonButtonExpanded("log", hidden);
            }
        }

        function setPlotControlsOpen(open) {
            const dialog = appElement("plot_control_dialog");
            const backdrop = appElement("plot_control_backdrop");
            const button = document.querySelector('[data-command="plot-controls"]');
            if (!dialog || !backdrop) return;

            if (open && document.body.classList.contains("windows-peak-editing-open")) {
                setPeakEditingOpen(false);
            }
            if (open && document.body.classList.contains("windows-magnifier-settings-open")) {
                setMagnifierSettingsOpen(false);
            }
            if (open && document.body.classList.contains("windows-spec-edit-open")) {
                setSpecEditOpen(false);
            }

            dialog.classList.toggle("windows-plot-controls-hidden", !open);
            dialog.classList.toggle("windows-plot-controls-open", open);
            dialog.setAttribute("aria-hidden", String(!open));
            document.body.classList.toggle("windows-plot-controls-open", open);
            if (button) button.setAttribute("aria-expanded", String(open));

            const focusTarget = open
                ? appElement("button_close_plot_controls")
                : button;
            if (focusTarget) focusTarget.focus();
        }

        function togglePlotControls() {
            const dialog = appElement("plot_control_dialog");
            if (!dialog) return;
            setPlotControlsOpen(dialog.classList.contains("windows-plot-controls-hidden"));
        }

        function setPeakEditingOpen(open) {
            const dialog = appElement("peak_editing_dialog");
            const backdrop = appElement("plot_control_backdrop");
            const button = document.querySelector('[data-command="peak-editing"]');
            if (!dialog || !backdrop) return;

            if (open && document.body.classList.contains("windows-plot-controls-open")) {
                setPlotControlsOpen(false);
            }
            if (open && document.body.classList.contains("windows-magnifier-settings-open")) {
                setMagnifierSettingsOpen(false);
            }
            if (open && document.body.classList.contains("windows-spec-edit-open")) {
                setSpecEditOpen(false);
            }

            dialog.classList.toggle("windows-peak-editing-hidden", !open);
            dialog.classList.toggle("windows-peak-editing-open", open);
            dialog.setAttribute("aria-hidden", String(!open));
            document.body.classList.toggle("windows-peak-editing-open", open);
            if (button) button.setAttribute("aria-expanded", String(open));

            const focusTarget = open ? appElement("button_close_peak_editing") : button;
            if (focusTarget) focusTarget.focus();
        }

        function togglePeakEditing() {
            const dialog = appElement("peak_editing_dialog");
            if (!dialog) return;
            setPeakEditingOpen(dialog.classList.contains("windows-peak-editing-hidden"));
        }

        function setMagnifierSettingsOpen(open) {
            const dialog = appElement("magnifier_settings_dialog");
            const backdrop = appElement("plot_control_backdrop");
            const button = document.querySelector('[data-command="magnifier-toggle"]');
            if (!dialog || !backdrop) return;

            if (open && document.body.classList.contains("windows-plot-controls-open")) {
                setPlotControlsOpen(false);
            }
            if (open && document.body.classList.contains("windows-peak-editing-open")) {
                setPeakEditingOpen(false);
            }
            if (open && document.body.classList.contains("windows-spec-edit-open")) {
                setSpecEditOpen(false);
            }

            dialog.classList.toggle("windows-magnifier-settings-hidden", !open);
            dialog.classList.toggle("windows-magnifier-settings-open", open);
            dialog.setAttribute("aria-hidden", String(!open));
            document.body.classList.toggle("windows-magnifier-settings-open", open);

            const focusTarget = open ? appElement("button_close_magnifier_settings") : button;
            if (focusTarget) focusTarget.focus();
        }

        function closeActiveDialog() {
            if (document.body.classList.contains("windows-plot-controls-open")) {
                setPlotControlsOpen(false);
            } else if (document.body.classList.contains("windows-peak-editing-open")) {
                setPeakEditingOpen(false);
            } else if (document.body.classList.contains("windows-magnifier-settings-open")) {
                setMagnifierSettingsOpen(false);
            } else if (document.body.classList.contains("windows-spec-edit-open")) {
                setSpecEditOpen(false);
            }
        }

        function setSpecEditOpen(open) {
            const dialog = appElement("spec_edit_dialog");
            const backdrop = appElement("plot_control_backdrop");
            const button = document.querySelector('[data-command="spec-edit"]');
            if (!dialog || !backdrop) return;

            if (open && document.body.classList.contains("windows-plot-controls-open")) setPlotControlsOpen(false);
            if (open && document.body.classList.contains("windows-peak-editing-open")) setPeakEditingOpen(false);
            if (open && document.body.classList.contains("windows-magnifier-settings-open")) setMagnifierSettingsOpen(false);

            dialog.classList.toggle("windows-spec-edit-hidden", !open);
            dialog.classList.toggle("windows-spec-edit-open", open);
            dialog.setAttribute("aria-hidden", String(!open));
            document.body.classList.toggle("windows-spec-edit-open", open);
            if (button) button.setAttribute("aria-expanded", String(open));

            const focusTarget = open ? appElement("button_close_spec_edit") : button;
            if (focusTarget) focusTarget.focus();
        }

        function toggleSpecEdit() {
            const dialog = appElement("spec_edit_dialog");
            if (!dialog) return;
            setSpecEditOpen(dialog.classList.contains("windows-spec-edit-hidden"));
        }

        function setSectionHidden(element, hidden) {
            element.classList.toggle("windows-section-hidden", hidden);
            if (hidden) {
                element.style.setProperty("display", "none", "important");
            } else {
                element.style.removeProperty("display");
            }
        }

        function toggleSection(id, buttonId) {
            const element = appElement(id);
            if (!element) return;
            const isHidden = !element.classList.contains("windows-section-hidden");
            setSectionHidden(element, isHidden);
            const command = {
                fid_file_area: "fid",
                pseudo3d_area: "pseudo3d",
                assignment_area: "transfer"
            }[id];
            if (command) setRibbonButtonExpanded(command, !isHidden);
            if (!isHidden && buttonId) {
                const button = appElement(buttonId);
                if (button && button.innerText.trim() === "+") button.click();
            }
        }

        function openSection(id, buttonId) {
            const element = appElement(id);
            if (!element) return;
            setSectionHidden(element, false);
            if (buttonId) {
                const button = appElement(buttonId);
                if (button && button.innerText.trim() === "+") button.click();
            }
        }

        function createPanelCloseButton(documentRef, label, closePanel) {
            const button = documentRef.createElement("button");
            button.type = "button";
            button.className = "windows-panel-close";
            button.textContent = "Close";
            button.title = `Close ${label}`;
            button.setAttribute("aria-label", `Close ${label}`);
            button.addEventListener("click", event => {
                event.preventDefault();
                event.stopPropagation();
                closePanel();
            });
            return button;
        }

        function initializeRibbonDialogClosers(documentRef) {
            const sectionPanels = [
                ["fid_file_area", "fid", "FID processing"],
                ["pseudo3d_area", "pseudo3d", "pseudo-3D fitting"],
                ["assignment_area", "transfer", "assignment transfer"]
            ];

            for (const [id, command, label] of sectionPanels) {
                const panel = documentRef.getElementById(id);
                const heading = panel && panel.querySelector("p");
                if (!panel || !heading || heading.querySelector(".windows-panel-close")) continue;
                panel.classList.add("windows-ribbon-dialog");
                heading.classList.add("windows-ribbon-dialog-heading");
                heading.appendChild(createPanelCloseButton(documentRef, label, () => {
                    setSectionHidden(panel, true);
                    setRibbonButtonExpanded(command, false);
                }));
            }

            const logArea = documentRef.getElementById("log_area");
            const logActions = logArea && logArea.querySelector(".log-actions");
            if (logArea && logActions && !logActions.querySelector(".windows-panel-close")) {
                logArea.classList.add("windows-ribbon-dialog");
                const closeButton = createPanelCloseButton(documentRef, "processing log", () => togglePanel("log_area"));
                closeButton.classList.add("windows-panel-close-inline");
                logActions.appendChild(closeButton);
            }

            const peakArea = documentRef.getElementById("peak_area");
            const peakHeader = peakArea && peakArea.querySelector(":scope > .header_sticky");
            if (peakArea && peakHeader && !peakHeader.querySelector(".windows-panel-close")) {
                peakArea.classList.add("windows-ribbon-dialog");
                peakHeader.classList.add("windows-peak-table-header");
                peakHeader.appendChild(createPanelCloseButton(documentRef, "peak table", () => setPeakTableEnabled(false)));
            }
        }

        function initializeSpectrumSidebar(documentRef) {
            const list = documentRef.getElementById("spectra_list_ol");
            if (!list || list.dataset.windowsSidebarReady) return;
            list.dataset.windowsSidebarReady = "true";

            const heading = documentRef.querySelector("#spectra_list > h4");
            if (heading) {
                heading.classList.add("windows-spectrum-sidebar-header");
                heading.replaceChildren();
                const toggle = documentRef.createElement("button");
                toggle.type = "button";
                toggle.className = "windows-spectrum-list-toggle";
                toggle.setAttribute("aria-controls", "spectra_list_ol");
                toggle.setAttribute("aria-expanded", "true");
                toggle.title = "Collapse spectra list";
                const icon = documentRef.createElement("span");
                icon.className = "windows-spectrum-list-toggle-icon";
                icon.textContent = "<";
                const label = documentRef.createElement("span");
                label.className = "windows-spectrum-list-toggle-label";
                label.textContent = "Spectra";
                toggle.append(icon, label);
                heading.appendChild(toggle);

                toggle.addEventListener("click", () => {
                    const collapsed = documentRef.body.classList.toggle("windows-spectrum-list-collapsed");
                    toggle.setAttribute("aria-expanded", String(!collapsed));
                    toggle.title = collapsed ? "Expand spectra list" : "Collapse spectra list";
                    icon.textContent = collapsed ? ">" : "<";
                });
            }

            const backdrop = documentRef.createElement("div");
            backdrop.id = "windows-spectrum-backdrop";
            documentRef.body.appendChild(backdrop);

            const dialog = documentRef.createElement("section");
            dialog.id = "windows-spectrum-dialog";
            dialog.setAttribute("role", "dialog");
            dialog.setAttribute("aria-modal", "true");
            dialog.setAttribute("aria-labelledby", "windows-spectrum-dialog-title");
            dialog.setAttribute("aria-hidden", "true");

            const dialogHeader = documentRef.createElement("header");
            dialogHeader.className = "windows-spectrum-dialog-header";
            const dialogTitle = documentRef.createElement("h2");
            dialogTitle.id = "windows-spectrum-dialog-title";
            dialogTitle.textContent = "Spectrum details";
            const dialogCloseButton = documentRef.createElement("button");
            dialogCloseButton.type = "button";
            dialogCloseButton.className = "windows-spectrum-popup-close";
            dialogCloseButton.textContent = "Close";
            dialogCloseButton.title = "Close spectrum details";
            dialogHeader.append(dialogTitle, dialogCloseButton);

            const dialogContent = documentRef.createElement("div");
            dialogContent.id = "windows-spectrum-dialog-content";
            dialog.append(dialogHeader, dialogContent);
            documentRef.body.appendChild(dialog);

            const controlsByRow = new WeakMap();
            const hiddenPeakStateBySpectrum = new WeakMap();
            let activeDetails = null;

            function closeDetails(restoreFocus = true) {
                if (!activeDetails) {
                    documentRef.body.classList.remove("windows-spectrum-popup-active");
                    dialog.setAttribute("aria-hidden", "true");
                    return;
                }

                const { row, controls, placeholder, trigger } = activeDetails;
                row.classList.remove("windows-spectrum-popup-open");
                if (placeholder.parentNode) {
                    placeholder.parentNode.insertBefore(controls, placeholder);
                    placeholder.remove();
                } else {
                    controls.remove();
                }
                trigger.setAttribute("aria-expanded", "false");
                dialog.classList.remove("windows-spectrum-dialog-open");
                dialog.setAttribute("aria-hidden", "true");
                documentRef.body.classList.remove("windows-spectrum-popup-active");
                activeDetails = null;

                if (restoreFocus && trigger.isConnected) trigger.focus();
            }

            function updateSpectrumVisibility(row) {
                const spectrumIndex = Number.parseInt(row.id.slice("spectrum-".length), 10);
                const spectrum = window.hsqc_spectra && window.hsqc_spectra[spectrumIndex];
                const visible = !spectrum || spectrum.visible !== false;
                const button = row.querySelector(".windows-spectrum-visibility-toggle");
                if (!button) return;

                button.setAttribute("aria-pressed", String(visible));
                button.title = `${visible ? "Hide" : "Show"} this spectrum and its peaks`;
                button.setAttribute("aria-label", `Toggle visibility for spectrum ${spectrumIndex + 1}`);
                row.classList.toggle("windows-spectrum-hidden", !visible);
                const status = button.querySelector(".windows-spectrum-status");
                if (status) status.textContent = visible ? "●" : "○";
            }

            function toggleSpectrumVisibility(row) {
                const spectrumIndex = Number.parseInt(row.id.slice("spectrum-".length), 10);
                const spectra = window.hsqc_spectra || [];
                const spectrum = spectra[spectrumIndex];
                const visibleBefore = !spectrum || spectrum.visible !== false;
                const minimizeButton = documentRef.getElementById(`minimize-${spectrumIndex}`);
                const reconstructedCheckbox = documentRef.getElementById(`show_recon-${spectrumIndex}`);
                const activePeakIndex = window.current_spectrum_index_of_peaks;
                const activePeakFlag = window.current_flag_of_peaks || "picked";

                if (minimizeButton && typeof window.minimize_spectrum === "function") {
                    window.minimize_spectrum(spectrumIndex);
                } else if (reconstructedCheckbox) {
                    reconstructedCheckbox.click();
                }

                if (visibleBefore && typeof window.show_hide_peaks === "function") {
                    const relatedIndices = new Set([spectrumIndex]);
                    for (let index = 0; index < spectra.length; index++) {
                        if (spectra[index] && spectra[index].spectrum_origin === spectrumIndex) {
                            relatedIndices.add(index);
                        }
                    }
                    const isPseudo3dPeaks = activePeakIndex === -2
                        && typeof window.is_pseudo3d_spectrum === "function"
                        && window.is_pseudo3d_spectrum(spectrumIndex);
                    if (relatedIndices.has(activePeakIndex) || isPseudo3dPeaks) {
                        if (spectrum) {
                            hiddenPeakStateBySpectrum.set(spectrum, {
                                index: activePeakIndex,
                                flag: activePeakFlag
                            });
                        }
                        window.show_hide_peaks(
                            activePeakIndex,
                            activePeakFlag,
                            false
                        );
                    }
                } else if (!visibleBefore && spectrum && typeof window.show_hide_peaks === "function") {
                    const hiddenPeakState = hiddenPeakStateBySpectrum.get(spectrum);
                    if (hiddenPeakState) {
                        if (window.current_spectrum_index_of_peaks === -1) {
                            window.show_hide_peaks(hiddenPeakState.index, hiddenPeakState.flag, true);
                        }
                        hiddenPeakStateBySpectrum.delete(spectrum);
                    }
                }

                for (const spectrumRow of list.querySelectorAll(":scope > li.windows-spectrum-row")) {
                    updateSpectrumVisibility(spectrumRow);
                }
            }

            function decorateRows() {
                for (const row of list.querySelectorAll(":scope > li[id^='spectrum-']")) {
                    const controls = row.querySelector(":scope > div:not(.windows-spectrum-actions)");
                    if (!controls || row.style.display === "none") continue;

                    controls.classList.add("windows-spectrum-controls");
                    row.classList.add("windows-spectrum-row");
                    const spectrumIndex = Number.parseInt(row.id.slice("spectrum-".length), 10);
                    controls.dataset.windowsSpectrumIndex = String(spectrumIndex);
                    controlsByRow.set(row, controls);
                    const rowText = controls.textContent.replace(/\s+/g, " ").trim();
                    const filename = rowText.match(/File name:\s*(.+?)(?=\s+Noise:|$)/i);
                    const reconstructed = rowText.match(/Remove me\s+(.+?)\s+\(fitted from plane/i);
                    const label = (filename && filename[1]) || (reconstructed && reconstructed[1]) || `Spectrum ${spectrumIndex + 1}`;

                    let actions = row.querySelector(":scope > .windows-spectrum-actions");
                    if (!actions) {
                        actions = documentRef.createElement("div");
                        actions.className = "windows-spectrum-actions";
                        row.appendChild(actions);
                    }

                    let visibilityButton = actions.querySelector(".windows-spectrum-visibility-toggle");
                    if (!visibilityButton) {
                        visibilityButton = documentRef.createElement("button");
                        visibilityButton.type = "button";
                        visibilityButton.className = "windows-spectrum-visibility-toggle";
                        actions.appendChild(visibilityButton);
                    }
                    visibilityButton.replaceChildren();
                    const indexLabel = documentRef.createElement("span");
                    indexLabel.className = "windows-spectrum-index";
                    indexLabel.textContent = String(spectrumIndex + 1);
                    const nameLabel = documentRef.createElement("span");
                    nameLabel.className = "windows-spectrum-name";
                    nameLabel.textContent = label;
                    const status = documentRef.createElement("span");
                    status.className = "windows-spectrum-status";
                    visibilityButton.append(indexLabel, nameLabel, status);
                    updateSpectrumVisibility(row);

                    let detailsButton = actions.querySelector(".windows-spectrum-details-button");
                    if (!detailsButton) {
                        detailsButton = documentRef.createElement("button");
                        detailsButton.type = "button";
                        detailsButton.className = "windows-spectrum-details-button";
                        detailsButton.setAttribute("aria-haspopup", "dialog");
                        detailsButton.setAttribute("aria-expanded", "false");
                        detailsButton.innerHTML = '<span class="windows-spectrum-details-label">Details</span><span class="windows-spectrum-details-icon" aria-hidden="true">⋯</span>';
                        actions.appendChild(detailsButton);
                    }
                    detailsButton.title = `Show processing controls for ${label}`;
                    detailsButton.setAttribute("aria-label", `Show processing controls for spectrum ${spectrumIndex + 1}: ${label}`);
                    detailsButton.dataset.spectrumLabel = label;
                    const oldHeader = controls.querySelector(":scope > .windows-spectrum-popup-header");
                    if (oldHeader) oldHeader.remove();
                }
            }

            list.addEventListener("click", event => {
                const visibilityButton = event.target.closest(".windows-spectrum-visibility-toggle");
                if (visibilityButton) {
                    const row = visibilityButton.closest("li");
                    if (row) toggleSpectrumVisibility(row);
                    return;
                }

                const detailsButton = event.target.closest(".windows-spectrum-details-button");
                if (!detailsButton) return;
                const row = detailsButton.closest("li");
                const controls = row && controlsByRow.get(row);
                if (!row || !controls) return;

                closeDetails(false);
                const placeholder = documentRef.createComment("spectrum-controls");
                controls.parentNode.insertBefore(placeholder, controls);
                dialogContent.replaceChildren(controls);
                dialogTitle.textContent = detailsButton.dataset.spectrumLabel || "Spectrum details";
                activeDetails = { row, controls, placeholder, trigger: detailsButton };
                row.classList.add("windows-spectrum-popup-open");
                detailsButton.setAttribute("aria-expanded", "true");
                dialog.classList.add("windows-spectrum-dialog-open");
                dialog.setAttribute("aria-hidden", "false");
                documentRef.body.classList.add("windows-spectrum-popup-active");

                const spectrumIndex = Number.parseInt(row.id.slice("spectrum-".length), 10);
                if (typeof window.set_current_spectrum === "function") {
                    window.set_current_spectrum(spectrumIndex);
                }
                dialogCloseButton.focus();
            });

            dialogCloseButton.addEventListener("click", () => closeDetails());
            backdrop.addEventListener("click", closeDetails);
            documentRef.addEventListener("keydown", event => {
                if (event.key === "Escape" && activeDetails) closeDetails();
            });

            const observer = new documentRef.defaultView.MutationObserver(decorateRows);
            observer.observe(list, { childList: true });
            decorateRows();
        }

        function styleEmbeddedApp() {
            const documentRef = appDocument();
            if (!documentRef || documentRef.getElementById("windows-ui-theme")) return;

            const theme = documentRef.createElement("style");
            theme.id = "windows-ui-theme";
            theme.textContent = `
                #app-view-root { background: #f8fafc !important; }
                #navbar-placeholder { display: none !important; }
                #body { min-width: 0 !important; width: 100% !important; margin: 0 !important; align-items: stretch !important; }
                #section1 { display: none !important; }
                #section1 h1 { margin: 4px 0 !important; font-size: 20px !important; color: #1e3a5f !important; }
                #section1 h2 { margin: 4px 0 8px !important; font-size: 12px !important; color: #64748b !important; }
                #section1 h3 { margin: 0 !important; font-size: 12px !important; }
                #section2 { min-width: 0 !important; width: 100% !important; margin: 0 !important; padding: 10px !important; }
                #section2 > .drop-area-neighbor:not(#log_area):not(#spectra_list), #section2 > .drop-area, #assignment_area { width: 100% !important; max-width: none !important; margin: 6px 0 !important; border-color: #cbd5e1 !important; border-radius: 6px !important; background: #fff !important; box-shadow: 0 2px 7px rgba(15,23,42,.06) !important; }
                #load_and_save, #fid_file_area, #file_area, #pseudo3d_area, #assignment_area, #spectra_list { padding: 8px 12px !important; }
                #fid_file_area.windows-section-hidden, #file_area.windows-section-hidden, #pseudo3d_area.windows-section-hidden, #assignment_area.windows-section-hidden { display: none !important; }
                #file_area.windows-section-hidden { visibility: hidden !important; }
                #load_and_save.windows-section-hidden { display: none !important; }
                #section2 > .windows-ribbon-dialog { border: 1px solid #94a3b8 !important; border-radius: 7px !important; background: #fff !important; box-shadow: 0 12px 32px rgba(15,23,42,.24) !important; }
                #plot { width: 100% !important; padding: 10px !important; border-color: #94a3b8 !important; border-radius: 6px !important; background: #fff !important; }
                #plot > div:first-child { display: none !important; }
                #plot_control_dialog.windows-plot-controls-hidden { display: none !important; }
                #plot_control_dialog.windows-plot-controls-open { position: fixed !important; top: 50% !important; left: 50% !important; right: auto !important; bottom: auto !important; transform: translate(-50%, -50%) !important; display: block !important; width: min(920px, calc(100vw - 32px)) !important; max-height: calc(100vh - 48px) !important; min-height: 0 !important; margin: 0 !important; padding: 14px !important; overflow: auto !important; border: 1px solid #94a3b8 !important; border-radius: 7px !important; background: #fff !important; box-shadow: 0 16px 48px rgba(15,23,42,.28) !important; z-index: 10002 !important; }
                #plot_control_dialog .windows-plot-controls-header { display: flex !important; align-items: center; justify-content: space-between; position: sticky; top: -14px; margin: -14px -14px 12px; padding: 10px 14px; border-bottom: 1px solid #cbd5e1; background: #fff; z-index: 1; }
                #plot_control_dialog .windows-plot-controls-header button { padding: 4px 10px; border: 1px solid #cbd5e1; border-radius: 4px; background: #f8fafc; color: #334155; cursor: pointer; }
                #plot_control_dialog #peak_display_controls { margin-top: 10px; padding-top: 10px; border-top: 1px solid #e2e8f0; }
                #plot_control_dialog #plot_1d_view_controls { margin-top: 10px; padding-top: 10px; border-top: 1px solid #e2e8f0; }
                #plot_control_dialog #peak_label_size, #plot_control_dialog #min_distance, #plot_control_dialog #max_distance, #plot_control_dialog #repulsive_force { width: 76px !important; }
                #peak_editing_dialog.windows-peak-editing-hidden { display: none !important; }
                #peak_editing_dialog.windows-peak-editing-open { position: fixed !important; top: 50% !important; left: 50% !important; right: auto !important; bottom: auto !important; transform: translate(-50%, -50%) !important; display: block !important; width: min(460px, calc(100vw - 32px)) !important; max-height: calc(100vh - 48px) !important; min-height: 0 !important; margin: 0 !important; padding: 14px !important; overflow: auto !important; border: 1px solid #94a3b8 !important; border-radius: 7px !important; background: #fff !important; box-shadow: 0 16px 48px rgba(15,23,42,.28) !important; z-index: 10002 !important; }
                #peak_editing_dialog .windows-peak-editing-header { display: flex !important; align-items: center; justify-content: space-between; position: sticky; top: -14px; margin: -14px -14px 12px; padding: 10px 14px; border-bottom: 1px solid #cbd5e1; background: #fff; z-index: 1; }
                #peak_editing_dialog .windows-peak-editing-header button { padding: 4px 10px; border: 1px solid #cbd5e1; border-radius: 4px; background: #f8fafc; color: #334155; cursor: pointer; }
                #peak_editing_controls { display: flex; flex-direction: column; gap: 12px; padding: 4px; }
                .windows-peak-editing-option { display: flex; align-items: center; gap: 8px; }
                #magnifier_settings_dialog.windows-magnifier-settings-hidden { display: none !important; }
                #magnifier_settings_dialog.windows-magnifier-settings-open { position: fixed !important; top: 50% !important; left: 50% !important; right: auto !important; bottom: auto !important; transform: translate(-50%, -50%) !important; display: block !important; width: min(380px, calc(100vw - 32px)) !important; max-height: calc(100vh - 48px) !important; min-height: 0 !important; margin: 0 !important; padding: 14px !important; overflow: auto !important; border: 1px solid #94a3b8 !important; border-radius: 7px !important; background: #fff !important; box-shadow: 0 16px 48px rgba(15,23,42,.28) !important; z-index: 10002 !important; }
                #magnifier_settings_dialog .windows-magnifier-settings-header { display: flex !important; align-items: center; justify-content: space-between; position: sticky; top: -14px; margin: -14px -14px 12px; padding: 10px 14px; border-bottom: 1px solid #cbd5e1; background: #fff; z-index: 1; }
                #magnifier_settings_dialog .windows-magnifier-settings-header button { padding: 4px 10px; border: 1px solid #cbd5e1; border-radius: 4px; background: #f8fafc; color: #334155; cursor: pointer; }
                #magnifier_settings_dialog fieldset { margin: 0; border: 0; padding: 4px; }
                #magnifier_settings_dialog label[for="enable_magnifying_glass"], #magnifier_settings_dialog #enable_magnifying_glass { display: none !important; }
                #magnifier_settings_dialog label[for="magnifying_glass_size"], #magnifier_settings_dialog label[for="magnifying_glass_ratio"] { display: inline-block; min-width: 72px; }
                #magnifier_settings_dialog #magnifying_glass_size, #magnifier_settings_dialog #magnifying_glass_ratio { width: 88px !important; }
                #spec_edit_dialog.windows-spec-edit-hidden { display: none !important; }
                #spec_edit_dialog.windows-spec-edit-open { position: fixed !important; top: 50% !important; left: 50% !important; right: auto !important; bottom: auto !important; transform: translate(-50%, -50%) !important; display: block !important; width: min(680px, calc(100vw - 32px)) !important; max-height: calc(100vh - 48px) !important; min-height: 0 !important; margin: 0 !important; padding: 14px !important; overflow: auto !important; border: 1px solid #94a3b8 !important; border-radius: 7px !important; background: #fff !important; box-shadow: 0 16px 48px rgba(15,23,42,.28) !important; z-index: 10002 !important; }
                #spec_edit_dialog .windows-spec-edit-header { display: flex !important; align-items: center; justify-content: space-between; position: sticky; top: -14px; margin: -14px -14px 12px; padding: 10px 14px; border-bottom: 1px solid #cbd5e1; background: #fff; z-index: 1; }
                #spec_edit_dialog .windows-spec-edit-header button { padding: 4px 10px; border: 1px solid #cbd5e1; border-radius: 4px; background: #f8fafc; color: #334155; cursor: pointer; }
                #spec_edit_controls { display: flex; flex-wrap: wrap; align-items: center; gap: 10px; }
                #cross_section_x, #cross_section_y { box-sizing: content-box !important; }
                #plot_control_backdrop { display: none; position: fixed; inset: 0; background: rgba(15,23,42,.38); z-index: 10001; }
                body.windows-plot-controls-open #plot_control_backdrop, body.windows-peak-editing-open #plot_control_backdrop, body.windows-magnifier-settings-open #plot_control_backdrop, body.windows-spec-edit-open #plot_control_backdrop { display: block; }
                #button_reset_zoom, #button_zoom_back, #button_zoom_out { display: none !important; }
                #load_and_save { position: absolute !important; top: 24px !important; left: 50% !important; transform: translateX(-50%) !important; width: 440px !important; min-height: 0 !important; margin: 0 !important; padding: 16px !important; z-index: 9999 !important; background: #fff !important; border: 1px solid #cbd5e1 !important; border-radius: 7px !important; box-shadow: 0 12px 32px rgba(15,23,42,.22) !important; }
                #peak_area.windows-peak-visible { display: block !important; }
                #peak_area.windows-ribbon-dialog { border: 1px solid #94a3b8 !important; border-radius: 7px !important; background: #fff !important; box-shadow: 0 12px 32px rgba(15,23,42,.24) !important; }
                #peak_area .windows-peak-table-header { display: flex !important; align-items: center; flex-wrap: wrap; gap: 8px; padding: 8px 10px; }
                #peak_area .windows-panel-close { margin-left: auto; }
                .windows-ribbon-dialog-heading { position: relative; padding-right: 72px !important; }
                .windows-panel-close { padding: 4px 10px; border: 1px solid #cbd5e1; border-radius: 4px; background: #fff; color: #334155; cursor: pointer; font: inherit; font-size: 12px; line-height: 1.2; white-space: nowrap; }
                .windows-panel-close:hover { border-color: #3182ce; background: #eaf4fd; color: #075b9e; }
                .windows-ribbon-dialog-heading > .windows-panel-close { position: absolute; top: 50%; right: 0; transform: translateY(-50%); }
                #log_area .log-actions .windows-panel-close { flex: 0 0 auto; }
                #section2 > #fid_file_area, #section2 > #file_area, #section2 > #pseudo3d_area, #section2 > #assignment_area { position: absolute !important; top: 50% !important; left: 50% !important; transform: translate(-50%, -50%) !important; width: min(760px, calc(100% - 32px)) !important; max-height: calc(100% - 32px) !important; overflow: auto !important; margin: 0 !important; padding: 16px !important; z-index: 9999 !important; background: #fff !important; border: 1px solid #94a3b8 !important; border-radius: 7px !important; box-shadow: 0 12px 32px rgba(15,23,42,.24) !important; }
                    #section2 > #fid_file_area:not(#log_area):not(#spectra_list) { width: min(900px, calc(100% - 32px)) !important; }
                    #section2 > #pseudo3d_area:not(#log_area):not(#spectra_list), #section2 > #assignment_area:not(#log_area):not(#spectra_list) { width: min(640px, calc(100% - 32px)) !important; }
                #section2 > #fid_file_area:not(#log_area):not(#spectra_list) { z-index: 10002 !important; border: 2px solid #64748b !important; }
                #fid_file_area #button_minimize_fid_area, #pseudo3d_area #button_minimize_preudo3d_area, #assignment_area #button_minimize_assignment_area { display: none !important; }
                :root { --windows-spectrum-rail-width: 220px; --windows-log-top: 112px; }
                @media (max-width: 720px) { :root { --windows-spectrum-rail-width: min(220px, calc(100vw - 120px)); --windows-log-top: 100px; } }
                body.windows-spectrum-list-collapsed { --windows-spectrum-rail-width: 38px; }
                #spectra_list { position: absolute !important; top: 8px !important; right: auto !important; bottom: 8px !important; left: 8px !important; width: var(--windows-spectrum-rail-width) !important; min-width: 0 !important; max-width: var(--windows-spectrum-rail-width) !important; height: auto !important; max-height: none !important; margin: 0 !important; padding: 6px !important; overflow-x: hidden !important; overflow-y: auto !important; z-index: 10000 !important; box-sizing: border-box !important; }
                #spectra_list h4 { display: block !important; margin: 0 0 6px !important; padding: 0 !important; font-size: 13px !important; }
                #spectra_list_ol { margin: 0 !important; padding: 0 !important; list-style: none !important; }
                #section2 > .flex-container { width: calc(100% - var(--windows-spectrum-rail-width) - 10px) !important; min-width: 0 !important; margin-left: calc(var(--windows-spectrum-rail-width) + 10px) !important; }
                #spectra_list_ol > li.windows-spectrum-row { display: block !important; width: 100% !important; margin: 0 0 4px !important; padding: 0 !important; }
                #spectra_list_ol > li.windows-spectrum-row > .windows-spectrum-controls { display: none !important; }
                #spectra_list_ol > li.spectrum-minimized-compact > .windows-spectrum-actions { display: flex !important; align-items: stretch !important; gap: 4px !important; font-size: 11px !important; line-height: normal !important; }
                #spectra_list_ol > li.spectrum-minimized-compact > .windows-spectrum-actions > .windows-spectrum-visibility-toggle,
                #spectra_list_ol > li.spectrum-minimized-compact > .windows-spectrum-actions > .windows-spectrum-details-button { display: inline-flex !important; font-size: 11px !important; line-height: normal !important; }
                .windows-spectrum-list-toggle { display: flex; align-items: center; gap: 8px; width: 100%; min-width: 0; padding: 5px 6px; border: 1px solid #cbd5e1; border-radius: 4px; background: #f8fafc; color: #334155; cursor: pointer; font-size: 12px; font-weight: 650; text-align: left; }
                .windows-spectrum-list-toggle:hover { border-color: #3182ce; background: #eaf4fd; color: #075b9e; }
                .windows-spectrum-list-toggle-icon { display: inline-block; width: 12px; text-align: center; font-weight: 700; }
                .windows-spectrum-actions { display: flex; align-items: stretch; gap: 4px; min-width: 0; }
                .windows-spectrum-visibility-toggle { display: grid; grid-template-columns: 24px minmax(0, 1fr) 14px; align-items: center; gap: 6px; flex: 1 1 auto; min-width: 0; padding: 6px; overflow: hidden; border: 1px solid #cbd5e1; border-radius: 4px; background: #fff; color: #334155; cursor: pointer; font-size: 11px; text-align: left; }
                .windows-spectrum-details-button { display: inline-flex; align-items: center; justify-content: center; flex: 0 0 auto; min-width: 30px; padding: 4px 8px; border: 1px solid #cbd5e1; border-radius: 4px; background: #f8fafc; color: #334155; cursor: pointer; font-size: 11px; }
                .windows-spectrum-index { font-weight: 650; text-align: center; }
                .windows-spectrum-name { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
                .windows-spectrum-status { color: #18864b; font-size: 10px; text-align: center; }
                .windows-spectrum-hidden .windows-spectrum-status { color: #94a3b8; }
                .windows-spectrum-visibility-toggle:hover { border-color: #3182ce; background: #eaf4fd; color: #075b9e; }
                .windows-spectrum-details-button:hover { border-color: #3182ce; background: #eaf4fd; color: #075b9e; }
                .windows-spectrum-hidden .windows-spectrum-visibility-toggle { border-color: #cbd5e1; background: #e5e7eb; color: #64748b; }
                .windows-spectrum-hidden .windows-spectrum-details-button { border-color: #d1d5db; background: #f1f5f9; color: #64748b; }
                .windows-spectrum-details-icon { display: none; font-size: 16px; line-height: 1; }
                body.windows-spectrum-list-collapsed #spectra_list { padding: 4px !important; }
                body.windows-spectrum-list-collapsed .windows-spectrum-list-toggle { justify-content: center; padding: 5px 2px; }
                body.windows-spectrum-list-collapsed .windows-spectrum-list-toggle-label, body.windows-spectrum-list-collapsed .windows-spectrum-name, body.windows-spectrum-list-collapsed .windows-spectrum-details-label { display: none; }
                body.windows-spectrum-list-collapsed .windows-spectrum-actions { flex-direction: column; gap: 3px; }
                body.windows-spectrum-list-collapsed .windows-spectrum-visibility-toggle { grid-template-columns: 1fr; justify-items: center; gap: 2px; padding: 4px 2px; }
                body.windows-spectrum-list-collapsed .windows-spectrum-details-button { width: 100%; min-width: 0; padding: 3px 1px; }
                body.windows-spectrum-list-collapsed .windows-spectrum-details-icon { display: inline; }
                #windows-spectrum-backdrop { display: none; position: fixed; inset: 0; background: rgba(15,23,42,.38); z-index: 9999; }
                body.windows-spectrum-popup-active #windows-spectrum-backdrop { display: block; }
                #windows-spectrum-dialog { display: none; position: fixed !important; top: 50% !important; left: 50% !important; right: auto !important; bottom: auto !important; transform: translate(-50%, -50%) !important; width: min(1200px, calc(100vw - 32px)) !important; max-width: calc(100vw - 32px) !important; max-height: calc(100vh - 40px) !important; min-height: 0 !important; margin: 0 !important; padding: 12px !important; overflow: auto !important; border: 1px solid #94a3b8 !important; border-radius: 6px !important; background: #fff !important; box-shadow: 0 16px 48px rgba(15,23,42,.28) !important; z-index: 10001 !important; font-size: 13px !important; line-height: 1.4 !important; box-sizing: border-box !important; }
                #windows-spectrum-dialog.windows-spectrum-dialog-open { display: block !important; }
                .windows-spectrum-dialog-header { display: flex !important; align-items: center; justify-content: space-between; gap: 12px; position: sticky; top: -12px; margin: -12px -12px 10px; padding: 10px 12px; border-bottom: 1px solid #cbd5e1; background: #fff; z-index: 1; }
                .windows-spectrum-dialog-header h2 { margin: 0; font-size: 16px; font-weight: 650; }
                #windows-spectrum-dialog .windows-spectrum-controls { display: block !important; position: static !important; width: auto !important; max-width: none !important; max-height: none !important; min-height: 0 !important; margin: 0 !important; padding: 0 !important; overflow: visible !important; border: 0 !important; border-radius: 0 !important; background: transparent !important; box-shadow: none !important; }
                .windows-contour-color-control { display: inline-flex; align-items: center; gap: 4px; white-space: nowrap; vertical-align: middle; }
                #windows-spectrum-dialog .draggable, #windows-spectrum-dialog button[id^="minimize-"] { display: none !important; }
                .windows-spectrum-popup-close { padding: 4px 10px; border: 1px solid #cbd5e1; border-radius: 4px; background: #fff; cursor: pointer; }
                #log_area { position: fixed !important; top: var(--windows-log-top); right: 12px; bottom: auto; left: auto; width: 360px; height: 220px; margin: 0 !important; border-radius: 7px !important; z-index: 9998 !important; }
                .windows-panel-hidden { display: none !important; }
                #pseudo3d_profile_modal { position: absolute !important; top: 24px !important; right: 24px !important; z-index: 9999 !important; }
                #button_toggle_log { display: none !important; }
                button, input, select { font-family: inherit !important; }
            `;
            documentRef.head.appendChild(theme);
            initializeRibbonDialogClosers(documentRef);
            initializeSpectrumSidebar(documentRef);
            const mainPlotParent = appElement("vis_parent");
            if (mainPlotParent) {
                const startingHeight = Math.min(800, Math.max(300, window.innerHeight - 470));
                mainPlotParent.style.height = `${startingHeight}px`;
            }
            const crossSectionEmpty = appElement("cross_section_empty");
            const crossSectionY = appElement("cross_section_y");
            if (crossSectionEmpty && crossSectionY) {
                const syncCrossSectionSpacer = () => {
                    crossSectionEmpty.style.width = `${crossSectionY.getBoundingClientRect().width}px`;
                };
                syncCrossSectionSpacer();
                const alignmentObserver = new ResizeObserver(syncCrossSectionSpacer);
                alignmentObserver.observe(crossSectionY);
                documentRef.defaultView.__windowsCrossSectionAlignmentObserver = alignmentObserver;
                documentRef.defaultView.addEventListener("resize", syncCrossSectionSpacer);
            }
            const plotControls = appElement("plot_control_dialog");
            if (plotControls) {
                plotControls.setAttribute("role", "dialog");
                plotControls.setAttribute("aria-modal", "true");
                plotControls.setAttribute("aria-labelledby", "plot_control_dialog_title");
                plotControls.classList.add("windows-plot-controls-hidden");
                plotControls.setAttribute("aria-hidden", "true");
                documentRef.body.appendChild(plotControls);
            }
            const peakDisplayControls = appElement("peak_display_controls");
            if (plotControls && peakDisplayControls) plotControls.appendChild(peakDisplayControls);
            const plot1dViewControls = appElement("plot_1d_view_controls");
            if (plotControls && plot1dViewControls) plotControls.appendChild(plot1dViewControls);
            const peakEditingDialog = appElement("peak_editing_dialog");
            if (peakEditingDialog) {
                peakEditingDialog.setAttribute("role", "dialog");
                peakEditingDialog.setAttribute("aria-modal", "true");
                peakEditingDialog.setAttribute("aria-labelledby", "peak_editing_dialog_title");
                peakEditingDialog.classList.add("windows-peak-editing-hidden");
                peakEditingDialog.setAttribute("aria-hidden", "true");
                documentRef.body.appendChild(peakEditingDialog);
            }
            const magnifierSettingsDialog = appElement("magnifier_settings_dialog");
            if (magnifierSettingsDialog) {
                magnifierSettingsDialog.setAttribute("role", "dialog");
                magnifierSettingsDialog.setAttribute("aria-modal", "true");
                magnifierSettingsDialog.setAttribute("aria-labelledby", "magnifier_settings_dialog_title");
                magnifierSettingsDialog.classList.add("windows-magnifier-settings-hidden");
                magnifierSettingsDialog.setAttribute("aria-hidden", "true");
                documentRef.body.appendChild(magnifierSettingsDialog);
            }
            const specEditDialog = appElement("spec_edit_dialog");
            if (specEditDialog) {
                specEditDialog.setAttribute("role", "dialog");
                specEditDialog.setAttribute("aria-modal", "true");
                specEditDialog.setAttribute("aria-labelledby", "spec_edit_dialog_title");
                specEditDialog.classList.add("windows-spec-edit-hidden");
                specEditDialog.setAttribute("aria-hidden", "true");
                documentRef.body.appendChild(specEditDialog);
            }
            const plotControlsBackdrop = documentRef.createElement("div");
            plotControlsBackdrop.id = "plot_control_backdrop";
            documentRef.body.appendChild(plotControlsBackdrop);
            plotControlsBackdrop.addEventListener("click", closeActiveDialog);
            const closePlotControls = appElement("button_close_plot_controls");
            if (closePlotControls) closePlotControls.addEventListener("click", () => setPlotControlsOpen(false));
            const closePeakEditing = appElement("button_close_peak_editing");
            if (closePeakEditing) closePeakEditing.addEventListener("click", () => setPeakEditingOpen(false));
            const closeMagnifierSettings = appElement("button_close_magnifier_settings");
            if (closeMagnifierSettings) closeMagnifierSettings.addEventListener("click", () => setMagnifierSettingsOpen(false));
            const closeSpecEdit = appElement("button_close_spec_edit");
            if (closeSpecEdit) closeSpecEdit.addEventListener("click", () => setSpecEditOpen(false));
            documentRef.addEventListener("keydown", event => {
                if (event.key === "Escape") closeActiveDialog();
            });
            ["load_and_save", "fid_file_area", "file_area", "pseudo3d_area", "assignment_area"].forEach(id => {
                const element = documentRef.getElementById(id);
                if (element) setSectionHidden(element, true);
            });
            const logArea = documentRef.getElementById("log_area");
            if (logArea) logArea.classList.add("windows-panel-hidden");

            documentRef.addEventListener("colmar:fid-processing-started", () => {
                const fidArea = documentRef.getElementById("fid_file_area");
                if (fidArea) setSectionHidden(fidArea, true);
                setRibbonButtonExpanded("fid", false);
            });
            documentRef.addEventListener("colmar:pseudo3d-processing-started", () => {
                const pseudo3dArea = documentRef.getElementById("pseudo3d_area");
                if (pseudo3dArea) setSectionHidden(pseudo3dArea, true);
                setRibbonButtonExpanded("pseudo3d", false);
            });

            const ft2Input = documentRef.getElementById("userfile");
            const ft2Form = documentRef.getElementById("ft2_file_form");
            if (ft2Input) {
                ft2Input.addEventListener("change", () => {
                    const fileArea = documentRef.getElementById("file_area");
                    if (fileArea) setSectionHidden(fileArea, true);
                    if (ft2Input.files && ft2Input.files.length > 0 && ft2Form) {
                        if (typeof ft2Form.requestSubmit === "function") {
                            ft2Form.requestSubmit();
                        } else {
                            ft2Form.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
                        }
                    }
                });
            }

            const magnifierToggle = appElement("enable_magnifying_glass");
            const magnifierButton = document.querySelector('[data-command="magnifier-toggle"]');
            if (magnifierToggle && magnifierButton) {
                const syncMagnifierButton = () => {
                    magnifierButton.setAttribute("aria-pressed", String(magnifierToggle.checked));
                };
                magnifierToggle.addEventListener("change", syncMagnifierButton);
                syncMagnifierButton();
            }
        }

        function runCommand(command) {
            switch (command) {
                case "save":
                    if (typeof window.save_to_file === "function") window.save_to_file();
                    break;
                case "load":
                    clickAppElement("load_file");
                    break;
                case "zoom-reset":
                    if (window.main_plot) clickAppElement("button_reset_zoom");
                    break;
                case "zoom-back":
                    if (window.main_plot) clickAppElement("button_zoom_back");
                    break;
                case "zoom-out":
                    if (window.main_plot) clickAppElement("button_zoom_out");
                    break;
                case "plot-controls":
                    togglePlotControls();
                    break;
                case "peak-editing":
                    togglePeakEditing();
                    break;
                case "spec-edit":
                    toggleSpecEdit();
                    break;
                case "magnifier-toggle":
                    if (window.main_plot) clickAppElement("enable_magnifying_glass");
                    break;
                case "fid":
                    toggleSection("fid_file_area", "button_minimize_fid_area");
                    break;
                case "spectrum":
                    clickAppElement("userfile");
                    break;
                case "pseudo3d":
                    toggleSection("pseudo3d_area", "button_minimize_preudo3d_area");
                    break;
                case "transfer":
                    toggleSection("assignment_area", "button_minimize_assignment_area");
                    break;
                case "peaks":
                    setPeakTableEnabled(!peakTableEnabled);
                    break;
                case "log":
                    togglePanel("log_area");
                    break;
                default:
                    break;
            }
        }


        function switchUi(useWindowsUi) {
            window.location.href = useWindowsUi ? "index_windows_ui.html" : "index.html";
        }
        styleEmbeddedApp();
        const magnifierButton = document.querySelector('[data-command="magnifier-toggle"]');
        if (magnifierButton) {
            let longPressTimer;
            let longPressTriggered = false;
            magnifierButton.addEventListener("pointerdown", event => {
                if (event.button !== 0) return;
                window.clearTimeout(longPressTimer);
                longPressTriggered = false;
                longPressTimer = window.setTimeout(() => {
                    longPressTriggered = true;
                    setMagnifierSettingsOpen(true);
                }, 600);
            });
            const clearLongPressTimer = () => window.clearTimeout(longPressTimer);
            magnifierButton.addEventListener("pointerup", clearLongPressTimer);
            magnifierButton.addEventListener("pointerleave", clearLongPressTimer);
            magnifierButton.addEventListener("pointercancel", () => {
                clearLongPressTimer();
                longPressTriggered = false;
            });
            magnifierButton.addEventListener("contextmenu", event => event.preventDefault());
            magnifierButton.addEventListener("click", event => {
                if (!longPressTriggered) return;
                longPressTriggered = false;
                event.stopImmediatePropagation();
            });
        }
        document.querySelectorAll("[data-command]").forEach(button => {
            button.addEventListener("click", () => runCommand(button.dataset.command));
        });
        document.getElementById("ui-mode-toggle").addEventListener("change", (event) => switchUi(event.target.checked));
