        function appDocument() {
            return document;
        }

        function appElement(id) {
            return appDocument().getElementById(id);
        }

        function clickAppElement(id) {
            const element = appElement(id);
            if (element) element.click();
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
            }
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

            function closeDetails() {
                const openRow = list.querySelector(":scope > li.windows-spectrum-popup-open");
                if (!openRow) {
                    documentRef.body.classList.remove("windows-spectrum-popup-active");
                    return;
                }

                openRow.classList.remove("windows-spectrum-popup-open");
                const controls = openRow.querySelector(":scope > div");
                const trigger = openRow.querySelector(":scope > .windows-spectrum-actions .windows-spectrum-details-button");
                if (controls) {
                    controls.removeAttribute("role");
                    controls.removeAttribute("aria-modal");
                    controls.removeAttribute("aria-labelledby");
                }
                if (trigger) {
                    trigger.setAttribute("aria-expanded", "false");
                    trigger.focus();
                }
                documentRef.body.classList.remove("windows-spectrum-popup-active");
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
                    const activePeakIndex = window.current_spectrum_index_of_peaks;
                    const isPseudo3dPeaks = activePeakIndex === -2
                        && typeof window.is_pseudo3d_spectrum === "function"
                        && window.is_pseudo3d_spectrum(spectrumIndex);
                    if (relatedIndices.has(activePeakIndex) || isPseudo3dPeaks) {
                        window.show_hide_peaks(
                            activePeakIndex,
                            window.current_flag_of_peaks || "picked",
                            false
                        );
                    }
                }

                for (const spectrumRow of list.querySelectorAll(":scope > li.windows-spectrum-row")) {
                    updateSpectrumVisibility(spectrumRow);
                }
            }

            function decorateRows() {
                for (const row of list.querySelectorAll(":scope > li[id^='spectrum-']")) {
                    const controls = row.querySelector(":scope > div");
                    if (!controls || row.style.display === "none") continue;

                    controls.classList.add("windows-spectrum-controls");
                    row.classList.add("windows-spectrum-row");
                    const spectrumIndex = Number.parseInt(row.id.slice("spectrum-".length), 10);
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

                    let header = controls.querySelector(":scope > .windows-spectrum-popup-header");
                    if (!header) {
                        header = documentRef.createElement("div");
                        header.className = "windows-spectrum-popup-header";
                        const title = documentRef.createElement("strong");
                        const closeButton = documentRef.createElement("button");
                        closeButton.type = "button";
                        closeButton.className = "windows-spectrum-popup-close";
                        closeButton.textContent = "Close";
                        closeButton.title = "Close spectrum details";
                        header.append(title, closeButton);
                        controls.insertBefore(header, controls.firstChild);
                    }
                    header.querySelector("strong").textContent = label;
                }
            }

            list.addEventListener("click", event => {
                const closeButton = event.target.closest(".windows-spectrum-popup-close");
                if (closeButton) {
                    closeDetails();
                    return;
                }

                const visibilityButton = event.target.closest(".windows-spectrum-visibility-toggle");
                if (visibilityButton) {
                    const row = visibilityButton.closest("li");
                    if (row) toggleSpectrumVisibility(row);
                    return;
                }

                const detailsButton = event.target.closest(".windows-spectrum-details-button");
                if (!detailsButton) return;
                const row = detailsButton.closest("li");
                const controls = row && row.querySelector(":scope > div");
                if (!row || !controls) return;

                closeDetails();
                row.classList.add("windows-spectrum-popup-open");
                detailsButton.setAttribute("aria-expanded", "true");
                controls.setAttribute("role", "dialog");
                controls.setAttribute("aria-modal", "true");
                controls.setAttribute("aria-labelledby", `windows-spectrum-title-${row.id}`);
                controls.querySelector(".windows-spectrum-popup-header strong").id = `windows-spectrum-title-${row.id}`;
                documentRef.body.classList.add("windows-spectrum-popup-active");

                const spectrumIndex = Number.parseInt(row.id.slice("spectrum-".length), 10);
                if (typeof window.set_current_spectrum === "function") {
                    window.set_current_spectrum(spectrumIndex);
                }
                controls.querySelector(".windows-spectrum-popup-close").focus();
            });

            backdrop.addEventListener("click", closeDetails);
            documentRef.addEventListener("keydown", event => {
                if (event.key === "Escape") closeDetails();
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
                #plot { width: 100% !important; padding: 10px !important; border-color: #94a3b8 !important; border-radius: 6px !important; background: #fff !important; }
                #vis_parent { height: clamp(280px, calc(100vh - 470px), 800px) !important; }
                #load_and_save { position: absolute !important; top: 24px !important; left: 50% !important; transform: translateX(-50%) !important; width: 440px !important; min-height: 0 !important; margin: 0 !important; padding: 16px !important; z-index: 9999 !important; background: #fff !important; border: 1px solid #cbd5e1 !important; border-radius: 7px !important; box-shadow: 0 12px 32px rgba(15,23,42,.22) !important; }
                #peak_area.windows-peak-visible { display: block !important; }
                #section2 > #fid_file_area, #section2 > #file_area, #section2 > #pseudo3d_area, #section2 > #assignment_area { position: absolute !important; top: 50% !important; left: 50% !important; transform: translate(-50%, -50%) !important; width: min(760px, calc(100% - 32px)) !important; max-height: calc(100% - 32px) !important; overflow: auto !important; margin: 0 !important; padding: 16px !important; z-index: 9999 !important; background: #fff !important; border: 1px solid #94a3b8 !important; border-radius: 7px !important; box-shadow: 0 12px 32px rgba(15,23,42,.24) !important; }
                :root { --windows-spectrum-rail-width: 220px; }
                @media (max-width: 720px) { :root { --windows-spectrum-rail-width: min(220px, calc(100vw - 120px)); } }
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
                #spectra_list_ol > li.windows-spectrum-row.windows-spectrum-popup-open > .windows-spectrum-controls { display: block !important; position: fixed !important; top: 50% !important; left: 50% !important; right: auto !important; bottom: auto !important; transform: translate(-50%, -50%) !important; width: min(680px, calc(100vw - 32px)) !important; max-width: calc(100vw - 32px) !important; height: auto !important; max-height: calc(100vh - 40px) !important; min-height: 0 !important; margin: 0 !important; padding: 12px !important; overflow: auto !important; border: 1px solid #94a3b8 !important; border-radius: 6px !important; background: #fff !important; box-shadow: 0 16px 48px rgba(15,23,42,.28) !important; z-index: 10001 !important; font-size: 13px !important; line-height: 1.4 !important; box-sizing: border-box !important; }
                #spectra_list_ol > li.windows-spectrum-popup-open > div > * { display: revert !important; }
                #spectra_list_ol > li.windows-spectrum-popup-open > div > .windows-spectrum-popup-header { display: flex !important; align-items: center; justify-content: space-between; gap: 12px; position: sticky; top: -12px; margin: -12px -12px 10px; padding: 10px 12px; border-bottom: 1px solid #cbd5e1; background: #fff; z-index: 1; }
                .windows-spectrum-popup-close { padding: 4px 10px; border: 1px solid #cbd5e1; border-radius: 4px; background: #fff; cursor: pointer; }
                #log_area { position: absolute !important; top: auto; right: 12px; bottom: 40px; left: auto; width: 360px; height: 220px; border-radius: 7px !important; z-index: 9998 !important; }
                .windows-panel-hidden { display: none !important; }
                #pseudo3d_profile_modal { position: absolute !important; top: 24px !important; right: 24px !important; z-index: 9999 !important; }
                #button_toggle_log { display: none !important; }
                button, input, select { font-family: inherit !important; }
            `;
            documentRef.head.appendChild(theme);
            initializeSpectrumSidebar(documentRef);
            ["load_and_save", "fid_file_area", "file_area", "pseudo3d_area", "assignment_area"].forEach(id => {
                const element = documentRef.getElementById(id);
                if (element) setSectionHidden(element, true);
            });
            const logArea = documentRef.getElementById("log_area");
            if (logArea) logArea.classList.add("windows-panel-hidden");

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

            const fidForm = documentRef.getElementById("fid_file_form");
            if (fidForm) {
                fidForm.addEventListener("submit", () => {
                    const fidArea = documentRef.getElementById("fid_file_area");
                    if (fidArea) setSectionHidden(fidArea, true);
                });
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
                    togglePanel("peak_area");
                    break;
                case "log":
                    togglePanel("log_area");
                    break;
                case "reset":
                    window.location.reload();
                    break;
                default:
                    break;
            }
        }


        function switchUi(useWindowsUi) {
            window.location.href = useWindowsUi ? "index_windows_ui.html" : "index.html";
        }
        styleEmbeddedApp();
        document.querySelectorAll("[data-command]").forEach(button => {
            button.addEventListener("click", () => runCommand(button.dataset.command));
        });
        document.getElementById("ui-mode-toggle").addEventListener("change", (event) => switchUi(event.target.checked));
