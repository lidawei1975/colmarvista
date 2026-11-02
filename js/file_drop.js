
class file_drop_processor {
    /**
     * 
     * @param {string} drop_area_id: DIV id of the drop area
     * @param {array} files_name: array of file names to be extracted from the dropped files
     * @param {array} files_id: array of file ids the extracted file to be attached to
     */
    constructor() {
        this.supportsFileSystemAccessAPI = 'getAsFileSystemHandle' in DataTransferItem.prototype;
        this.supportsWebkitGetAsEntry = 'webkitGetAsEntry' in DataTransferItem.prototype;
        this.container = new DataTransfer();
        this._click_to_select_folder = false;
    }

    drop_area(drop_area_id) {
        this.drop_area_id = drop_area_id;
        return this;
    }

    files_name(files_name) {
        this.files_name = files_name;
        return this;
    }

    file_extension(file_extension) {
        this.file_extension = file_extension;
        return this;
    }

    files_id(files_id) {
        this.files_id = files_id;
        return this;
    }

    extension_files_id(extension_files_id) {
        this.extension_files_id = extension_files_id;
        return this;
    }

    required_files(required_files) {
        this.required_files = required_files;
        return this;
    }

    /**
     * Enable click-to-select-folder on the drop area background.
     * When enabled, clicking the empty background of the drop zone
     * opens a native OS folder picker.
     * Should only be enabled where appropriate (e.g. FID area).
     */
    click_to_select_folder() {
        this._click_to_select_folder = true;
        return this;
    }

    init() {
        /**
         *  Get the element that will be the drop target. 
         *  Then add the relevant event listeners to it.
         */
        this.elem = document.getElementById(this.drop_area_id);

        // Prevent navigation.
        this.elem.addEventListener('dragover', (e) => {
            e.preventDefault();
        });

        // Visually highlight the drop zone.
        this.elem.addEventListener('dragenter', (e) => {
            this.elem.style.outline = 'solid red 2px';
        });

        // Visually un-highlight the drop zone.
        this.elem.addEventListener('dragleave', (e) => {
            let rect = this.elem.getBoundingClientRect();
            // Check the mouseEvent coordinates are outside of the rectangle
            if (e.clientX > rect.left + rect.width || e.clientX < rect.left
                || e.clientY > rect.top + rect.height || e.clientY < rect.top) {
                this.elem.style.outline = '';
            }
        });

        this.elem.addEventListener('drop', this.drop_handler.bind(this));

        if (this._click_to_select_folder) {
            this.elem.style.cursor = 'pointer';
            this.elem.title = 'Drag and drop files here, or click the background to select a folder';
            this.elem.addEventListener('click', this.click_handler.bind(this));
        }

        return this;
    }

    async read_file_text_safe(file) {
        if (!file) {
            return '';
        }
        if (typeof file.text === 'function') {
            return await file.text();
        }
        return await new Promise((resolve, reject) => {
            const reader = new FileReader();
            reader.onload = function () {
                resolve(reader.result || '');
            };
            reader.onerror = reject;
            reader.readAsText(file);
        });
    }

    async get_files_from_entry(entry) {
        if (!entry) return [];
        let files = [];

        if (entry instanceof File) {
            return [entry];
        }

        if (typeof entry.kind === 'string') {
            if (entry.kind === 'file') {
                try {
                    const f = await entry.getFile();
                    if (f) files.push(f);
                } catch (err) {
                    console.warn("Failed to get file from FileSystemFileHandle:", err);
                }
                return files;
            } else if (entry.kind === 'directory') {
                try {
                    for await (const child of entry.values()) {
                        const childFiles = await this.get_files_from_entry(child);
                        files.push(...childFiles);
                    }
                } catch (err) {
                    console.warn("Failed to read directory from FileSystemDirectoryHandle:", err);
                }
                return files;
            }
        }

        if (entry.isFile && typeof entry.file === 'function') {
            try {
                const f = await new Promise((resolve, reject) => entry.file(resolve, reject));
                if (f) files.push(f);
            } catch (err) {
                console.warn("Failed to read file from FileSystemFileEntry:", err);
            }
            return files;
        }

        if (entry.isDirectory && typeof entry.createReader === 'function') {
            try {
                const reader = entry.createReader();
                let allEntries = [];
                while (true) {
                    const batch = await new Promise((resolve, reject) => reader.readEntries(resolve, reject));
                    if (!batch || batch.length === 0) break;
                    allEntries.push(...batch);
                }
                for (const child of allEntries) {
                    const childFiles = await this.get_files_from_entry(child);
                    files.push(...childFiles);
                }
            } catch (err) {
                console.warn("Failed to read directory from FileSystemDirectoryEntry:", err);
            }
            return files;
        }

        return files;
    }

    async attach_files(allFiles) {
        if (!allFiles || allFiles.length === 0) return;

        // 1. Process files matching specific names (e.g. FID files)
        if (this.files_name && this.files_name.length > 0) {
            for (const file of allFiles) {
                if (this.files_name.includes(file.name)) {
                    let container = new DataTransfer();
                    container.items.add(file);
                    let file_id = this.files_id[this.files_name.indexOf(file.name)];

                    let elem = document.getElementById(file_id);
                    if (elem) {
                        if (file_id === "nuslist_file") {
                            elem.files = container.files;
                            let autoInd = document.getElementById("auto_indirect");
                            if (autoInd) {
                                autoInd.checked = false;
                                autoInd.disabled = true;
                            }
                        } else {
                            elem.files = container.files;
                            elem.dispatchEvent(new Event('change', { bubbles: true }));
                        }
                    }
                }
            }

            if (this.drop_area_id === "input_files" && this.required_files) {
                let filled = 0;
                for (let i = 0; i < this.required_files.length; i++) {
                    let elem = document.getElementById(this.files_id[this.required_files[i]]);
                    if (elem && elem.files && elem.files.length > 0) {
                        filled++;
                    }
                }
                if (filled >= this.required_files.length) {
                    let inOpts = document.getElementById("input_options");
                    if (inOpts) inOpts.style.backgroundColor = "lightgreen";
                }
            }
        }

        // 2. Match by file extension (e.g. Frequency domain spectra .ft2, .ucsf, .txt, etc.)
        if (this.file_extension && this.file_extension.length > 0) {
            let matchedFilesByInputId = {};

            for (const file of allFiles) {
                // If it already matched a specific file name above, skip extension matching
                if (this.files_name && this.files_name.includes(file.name)) {
                    continue;
                }

                let ext = file.name.split('.').pop().toLowerCase();
                let file_id = null;

                if (this.file_extension.includes(ext)) {
                    let idx = this.file_extension.indexOf(ext);
                    file_id = (this.extension_files_id && this.extension_files_id[idx])
                        || (this.files_id && this.files_id[idx])
                        || (this.files_id && this.files_id[0]);
                } else if (this.file_extension.includes('*')) {
                    let idx = this.file_extension.indexOf('*');
                    file_id = (this.files_id && this.files_id[idx]) || (this.files_id && this.files_id[0]);
                }

                if (file_id) {
                    if (!matchedFilesByInputId[file_id]) {
                        matchedFilesByInputId[file_id] = [];
                    }
                    matchedFilesByInputId[file_id].push(file);
                }
            }

            for (const [file_id, filesArray] of Object.entries(matchedFilesByInputId)) {
                let elem = document.getElementById(file_id);
                if (elem) {
                    let container = new DataTransfer();
                    for (const f of filesArray) {
                        container.items.add(f);
                    }
                    elem.files = container.files;
                    this.container = container;
                    elem.dispatchEvent(new Event('change', { bubbles: true }));
                }
            }
        }
    }

    async process_file_attachment(entry) {
        const files = await this.get_files_from_entry(entry);
        await this.attach_files(files);
    }

    async drop_handler(e) {
        e.preventDefault();
        this.elem.style.outline = '';

        // Reset container for this drop operation
        this.container = new DataTransfer();

        const items = e.dataTransfer && e.dataTransfer.items
            ? Array.from(e.dataTransfer.items).filter(item => item.kind === 'file')
            : [];
        const rawFiles = e.dataTransfer && e.dataTransfer.files
            ? Array.from(e.dataTransfer.files)
            : [];

        // Synchronously extract handles and entries before yielding the event loop
        const fsHandlePromises = items.map(item => {
            if (this.supportsFileSystemAccessAPI && typeof item.getAsFileSystemHandle === 'function') {
                try {
                    return item.getAsFileSystemHandle().catch(err => {
                        console.warn("Failed getAsFileSystemHandle:", err);
                        return null;
                    });
                } catch (err) {
                    return Promise.resolve(null);
                }
            }
            return Promise.resolve(null);
        });

        const webkitEntries = items.map(item => {
            if (this.supportsWebkitGetAsEntry && typeof item.webkitGetAsEntry === 'function') {
                try {
                    return item.webkitGetAsEntry();
                } catch (err) {
                    return null;
                }
            }
            return null;
        });

        const standardFiles = items.map(item => {
            try {
                return typeof item.getAsFile === 'function' ? item.getAsFile() : null;
            } catch (err) {
                return null;
            }
        });

        const fsHandles = await Promise.all(fsHandlePromises);

        let allFiles = [];

        if (items.length > 0) {
            for (let i = 0; i < items.length; i++) {
                let entry = fsHandles[i] || webkitEntries[i] || standardFiles[i] || (rawFiles[i] || null);
                if (entry) {
                    const extracted = await this.get_files_from_entry(entry);
                    allFiles.push(...extracted);
                }
            }
        } else if (rawFiles.length > 0) {
            allFiles = rawFiles;
        }

        await this.attach_files(allFiles);
    }

    async click_handler(e) {
        // Prevent clicking if the user actually clicked a child element (like a button, form, or file input)
        // inside the drop area box. It MUST be the exact drop area DIV background.
        if (e.target.id !== this.drop_area_id) {
            return;
        }

        e.preventDefault();

        // 1. Try modern File System Access API
        if (typeof window.showDirectoryPicker !== 'undefined') {
            try {
                const directoryHandle = await window.showDirectoryPicker();
                console.log(`Directory selected manually: ${directoryHandle.name}`);

                const allFiles = await this.get_files_from_entry(directoryHandle);
                await this.attach_files(allFiles);
                return; // Success
            } catch (err) {
                // User may have cancelled the dialog or the API is restricted, fall through to fallback
                if (err.name !== 'AbortError') {
                    console.warn("Failed to showDirectoryPicker, falling back to input trick:", err);
                } else {
                    return; // User aborted
                }
            }
        }

        // 2. Legacy fallback for browsers without showDirectoryPicker
        let dirInput = document.createElement('input');
        dirInput.type = 'file';
        dirInput.webkitdirectory = true;
        dirInput.directory = true; // For Firefox
        dirInput.multiple = true;

        dirInput.addEventListener('change', async (evt) => {
            const files = evt.target.files ? Array.from(evt.target.files) : [];
            if (files.length === 0) return;

            console.log(`Fallback picked ${files.length} flat files from directory`);
            await this.attach_files(files);
        });

        dirInput.click();
    }
};
