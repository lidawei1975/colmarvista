
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
        return this;
    }

    async process_file_attachment(entry) {
        let file;
        if (typeof FileSystemFileHandle !== 'undefined' && entry instanceof FileSystemFileHandle) {
            file = await entry.getFile();
        }
        else if (typeof FileSystemFileEntry !== 'undefined' && entry instanceof FileSystemFileEntry) {
            file = await new Promise((resolve, reject) => {
                entry.file(resolve, reject);
            });
        }
        else {
            return;
        }

        /**
         * Only if the dropped file is in the list
         */
        if (this.files_name.includes(file.name)) {
            let container = new DataTransfer();
            container.items.add(file);
            let file_id = this.files_id[this.files_name.indexOf(file.name)];

            /**
             * A special case for the file input id "hsqc_acquisition_file2"
             * File name can be acqu2s or acqu3s. 
             * we will read the file (either acqu2s or acqu3s) as a text file.
             * if it contains line "##$FnMODE= 1", skip the file
             */
            if (file_id === "acquisition_file2" && (file.name === "acqu3s" || file.name === "acqu2s")) {

                /**
                 * Read the file as text
                 */
                let file_data = await read_file_text(file);
                /**
                 * Split the file_data by line (line break)
                 */
                let lines = file_data.split(/\r?\n/);
                /**
                 * Loop all lines, find line start with "##$FnMODE=", get the value after "="
                 */
                let fnmode = 0;
                for (let i = 0; i < lines.length; i++) {
                    if (lines[i].startsWith("##$FnMODE=")) {
                        fnmode = parseInt(lines[i].split("=")[1]);
                        break;
                    }
                }
                /**
                 * Only when fnmode > 1 and fnmode !=7, we will attach the file to the file input
                */
                if (fnmode > 1 && fnmode != 7) {
                    document.getElementById(file_id).files = container.files;
                }
            }
           
            else if(file_id === "nuslist_file")
            {
                document.getElementById(file_id).files = container.files;
                /**
                 * Special case for nuslist file. 
                 * Disable the auto_indirect checkboxes. 
                 * User has to manually set the phase correction values for indirect dimension for NUS experiments
                 */
                document.getElementById("auto_indirect").checked = false;
                document.getElementById("auto_indirect").disabled = true;
                /**
                 * At this moment, also disable extract_direct_from and extract_direct_to
                 * because smile (my implementation) doesn't support NUS processing
                 */
                document.getElementById("extract_direct_from").value = 0;
                document.getElementById("extract_direct_to").value = 100;
                document.getElementById("extract_direct_from").disabled = true;
                document.getElementById("extract_direct_to").disabled = true;
            }
            else
            {
                document.getElementById(file_id).files = container.files;
            }

            /**
             * If this.drop_area_id === "input_files" and we have 
             * at least 3 of all files_id filled, we will highlight the processing div
             */
            if(this.drop_area_id === "input_files")
            {
                let filled = 0;
                let required_files = [0,2,3];
                for(let i=0;i<required_files.length;i++)
                {
                    if(document.getElementById(this.files_id[required_files[i]]).files.length > 0)
                    {
                        filled++;
                    }
                }
                if(filled >= 3)
                {
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
        let file_extension = file.name.split('.').pop();   
        if (this.file_extension.includes(file_extension)) {
            this.container.items.add(file);
            let file_id = this.files_id[this.file_extension.indexOf(file_extension)];
            document.getElementById(file_id).files = this.container.files;
            /**
             * Simulate the change event
             */
            // document.getElementById(file_id).dispatchEvent(new Event('change'));
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

        // Prepare an array of promises…
        const fileHandlesPromises = [...e.dataTransfer.items]
            // …by including only files (where file misleadingly means actual file _or_
            // directory)…
            .filter((item) => item.kind === 'file')
            // …and, depending on previous feature detection…
            .map((item) =>
                this.supportsFileSystemAccessAPI
                    // …either get a modern `FileSystemHandle`…
                    ? item.getAsFileSystemHandle()
                    // …or a classic `FileSystemFileEntry`.
                    : item.webkitGetAsEntry(),
            );

        // Loop over the array of promises.
        for await (const handle of fileHandlesPromises) {
            // This is where we can actually exclusively act on the directories.
            if (handle.kind === 'directory' || handle.isDirectory) {
                console.log(`Directory: ${handle.name}`);

                /**
                 * Get all files in the directory
                 */
                if (typeof FileSystemDirectoryHandle !== 'undefined' && handle instanceof FileSystemDirectoryHandle) {
                    for await (const entry of handle.values()) {
                        if (entry.kind === 'file' || entry.isFile) {
                            /**
                             * If the dropped file is in the list, attach it to the corresponding file input
                             */
                            this.process_file_attachment(entry);
                        }
                    }
                }
                else if(typeof FileSystemDirectoryEntry !== 'undefined' && handle instanceof FileSystemDirectoryEntry)
                {
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
};
