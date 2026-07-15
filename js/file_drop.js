
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

    async process_file_attachment(entry) {
        let file;

        if (!entry) return;

        if (entry instanceof File) {
            file = entry;
        }
        else if (typeof entry.getFile === 'function') {
            file = await entry.getFile();
        }
        else if (typeof entry.file === 'function') {
            file = await new Promise((resolve, reject) => {
                entry.file(resolve, reject);
            });
        }
        else {
            return;
        }

        if (!file) return;

        /**
         * Only if the dropped file is in the list
         */
        if (this.files_name.includes(file.name)) {
            let container = new DataTransfer();
            container.items.add(file);
            let file_id = this.files_id[this.files_name.indexOf(file.name)];

            if (file_id === "nuslist_file") {
                document.getElementById(file_id).files = container.files;
                /**
                 * Special case for nuslist file. 
                 * Disable the auto_indirect checkboxes. 
                 * User has to manually set the phase correction values for indirect dimension for NUS experiments
                 */
                document.getElementById("auto_indirect").checked = false;
                document.getElementById("auto_indirect").disabled = true;
                // Keep extract controls editable for class-based NUS processing.
            }
            else {
                document.getElementById(file_id).files = container.files;
                document.getElementById(file_id).dispatchEvent(new Event('change', { bubbles: true }));
            }

            /**
             * If this.drop_area_id === "input_files" and we have 
             * at least 3 of all files_id filled, we will highlight the processing div
             */
            if (this.drop_area_id === "input_files") {
                let filled = 0;
                for (let i = 0; i < this.required_files.length; i++) {
                    if (document.getElementById(this.files_id[this.required_files[i]]).files.length > 0) {
                        filled++;
                    }
                }
                if (filled >= this.required_files.length) {
                    document.getElementById("input_options").style.backgroundColor = "lightgreen";
                }
            }

            /**
             * If we can match file, will not try to match extension
             */
            return;
        }

        /**
         * Only if the dropped file's extension is as predefined, we will attach it to the corresponding file input
         * this.file_extension is an array of file extensions
         */
        let file_extension = file.name.split('.').pop().toLowerCase();
        if (this.file_extension.includes(file_extension)) {
            this.container.items.add(file);
            let file_id = this.files_id[this.file_extension.indexOf(file_extension)];
            document.getElementById(file_id).files = this.container.files;
            /**
             * Simulate the change event
             */
            document.getElementById(file_id).dispatchEvent(new Event('change', { bubbles: true }));
        }
        else if (this.file_extension.includes('*')) {
            this.container.items.add(file);
            let file_id = this.files_id[this.file_extension.indexOf('*')];
            document.getElementById(file_id).files = this.container.files;
            /**
             * Simulate the change event
             */
            document.getElementById(file_id).dispatchEvent(new Event('change', { bubbles: true }));
        }

    }

    async drop_handler(e) {
        e.preventDefault();

        if (!this.supportsFileSystemAccessAPI && !this.supportsWebkitGetAsEntry) {
            // Cannot handle directories.
            return;
        }
        // Un-highlight the drop zone.
        this.elem.style.outline = '';

        // Prepare an array of handles
        let fileHandlesPromises = [];

        if (e.dataTransfer.items) {
            for (const item of [...e.dataTransfer.items]) {
                if (item.kind !== 'file') continue;

                let handle = null;
                if (this.supportsFileSystemAccessAPI) {
                    try {
                        handle = await item.getAsFileSystemHandle();
                    } catch (err) {
                        console.warn("Failed to get file handle via FileSystemAccessAPI:", err);
                    }
                }
                if (!handle && this.supportsWebkitGetAsEntry) {
                    try {
                        handle = item.webkitGetAsEntry();
                    } catch (err) {
                        console.warn("Failed to get file handle via webkitGetAsEntry:", err);
                    }
                }

                if (handle) {
                    fileHandlesPromises.push(handle);
                } else {
                    console.warn("Total fallback to standard File API");
                    const file = item.getAsFile();
                    if (file) {
                        this.process_file_attachment(file);
                    }
                }
            }
        }

        // Loop over the array of promises.
        for await (const handle of fileHandlesPromises) {
            // This is where we can actually exclusively act on the directories.
            if (handle.kind === 'directory' || handle.isDirectory) {
                console.log(`Directory: ${handle.name}`);

                /**
                 * Get all files in the directory
                 */
                if (typeof handle.values === 'function') {
                    for await (const entry of handle.values()) {
                        if (entry.kind === 'file' || entry.isFile) {
                            /**
                             * If the dropped file is in the list, attach it to the corresponding file input
                             */
                            this.process_file_attachment(entry);
                        }
                    }
                }
                else if (typeof handle.createReader === 'function') {
                    /**
                     * Read all files in the directory
                     */
                    let reader = handle.createReader();
                    let entries = await new Promise((resolve, reject) => {
                        reader.readEntries(resolve, reject);
                    });
                    for (let entry of entries) {
                        if (entry.kind === 'file' || entry.isFile) {
                            /**
                             * If the dropped file is in the list, attach it to the corresponding file input
                             */
                            this.process_file_attachment(entry);
                        }
                    }
                }
            }
            /**
             * If the dropped item is a file, we will try to attach it to the corresponding file input if it is in the list
             */
            else if (handle.kind === 'file' || handle.isFile) {
                this.process_file_attachment(handle);
            }
        }
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

                for await (const entry of directoryHandle.values()) {
                    if (entry.kind === 'file' || entry.isFile) {
                        this.process_file_attachment(entry);
                    }
                }
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

        dirInput.addEventListener('change', (evt) => {
            const files = evt.target.files;
            if (!files || files.length === 0) return;

            console.log(`Fallback picked ${files.length} flat files from directory`);
            for (let i = 0; i < files.length; i++) {
                this.process_file_attachment(files[i]);
            }
        });

        dirInput.click();
    }
};
