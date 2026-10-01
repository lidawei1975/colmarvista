# COLMARvista
Web based NMR spectra process, view and analysis tool.

# Installation
Download all files/folders into one location or visit as a web server.

# License
COLMARvista is open source under the GPL V3, with a linking exception for the proprietary SMILE WebAssembly plugin (used with permission from its original author).

# Usage
Visit the web server https://lidawei1975.github.io/colmarvista/ in your browser. COLMAR Viewer is a static web server, which means all your data stays on your computer; the server does not take any input or uploads from you.

Alternatively, you can download the program and open index.html in your browser. This program uses WebWorker and WebAssembly, which cannot be loaded automatically when run locally unless you modify your browser settings.  

For Google Chrome:  
1. Right-click the Google Chrome icon and select "Properties."  
2. In the "Target" field, add the following flag to the end of the existing path: --allow-file-access-from-files.  
   Your modified "Target" field should look like this:  
   "C:\Program Files\Google\Chrome\Application\chrome.exe" --allow-file-access-from-files  
3. Click "Apply" or "OK."  
4. Restart Google Chrome and load the program.  

For Mozilla Firefox:  
1. Enter about:config in the browser's address bar.  
2. Search for security.fileuri.strict_origin_policy in the configuration page.  
3. Change its value to false.  

For Safari:  
1. Open Safari settings and go to the "Advanced" tab.  
2. Check the box for "Show Develop menu in menu bar."  
3. In the menu bar, click "Develop" and select "Disable Local File Restrictions."  

Warning: Modifying these settings poses a security risk. Do not load any local files unless you are certain they are safe.

# Functions

COLMARvista provides an integrated suite for web-based NMR processing, interactive visualization, and spectral analysis:
- **1D, 2D, and 3D NMR Spectral Viewing**: High-performance WebGL contours, 3D surface mesh rendering, synchronous zoom/pan, 1D orthogonal projections/slices, and 3D WebGL isosurfaces.
- **Client-Side WebAssembly Processing**: Process raw Bruker time-domain FID data (`fid`, `ser`) directly in the browser with automated phase correction, apodization, zero filling, solvent suppression, and baseline correction.
- **Non-Uniform Sampling (NUS)**: Fast direct-FT and iterative SMILE reconstruction for 2D, Pseudo-3D, and 3D NUS experiments.
- **Peak Picking & 2D Line-Shape Fitting**: AI-driven DEEP Picker neural network, local maxima Simple Picker, and Voigt/Gaussian deconvolution.
- **Pseudo-3D Series Processing & 2D DOSY**: Multi-plane sequential peak fitting across relaxation ($T_1, T_2$), titration, and kinetics series, plus pulsed field gradient DOSY diffusion fitting ($D$) with interactive decay plots.
- **CEST Analysis & ChemEx Integration**: Automated pre-analysis Voigt dip finding, exchange-active residue filtering ("Show ≥2 Peaks Only"), floating profile visualizer with automatic dip autozoom, real-time client-side ChemEx simulation via Pyodide WebWorker ($k_{ex}, p_B, \varpi_A, \Delta\varpi_{AB}$), single-peak fitting, and batch global fitting.
- **Automated Assignment Transfer**: Globally optimal bipartite Hungarian matching ($O(N^3)$) from reference lists (`.list`, `.tab`, `.txt`, `.csv`), customizable $^1$H / heteronucleus distance cutoffs, global calibration shift offsets, dynamic 2D diamond & arrow visual overlay, and one-click finalization.

For detailed manuals and tutorials, refer to the documentation portal in `index_document.html` or the standalone manual pages (`doc_2d.html`, `doc_3d.html`, `doc_1d.html`).

# Bug report or suggestions

Please start a new discussion at https://github.com/lidawei1975/colmarvista/discussions

# Developer Testing
**Note: These instructions are for developers only.**

1. **Start Local Server**:
    Open the terminal in the project directory and run:
    ```bash
    npm start
    ```
    This launches `http-server` at `http://127.0.0.1:8080`.

2. **Run Tests (Cypress)**:
    Open a new terminal window (keep the server running) and execute:
    ```bash
    npm run cy:open
    ```
    This will open the Cypress Test Runner.
              
# References
Please cite our publications if you found COLMARvista useful.

1. Li, DW., Brüschweiler, R.; COLMARvista: an open source 2D and pseudo-3D NMR spectral processing, visualization, and analysis software in JavaScript. J. Bio. NMR (in press)

2. Li, DW., Hansen, A.L., Yuan, C. et al. DEEP picker is a deep neural network for accurate deconvolution of complex two-dimensional NMR spectra. Nat. Commun. 12, 5229 (2021).

3. Ying J, Delaglio F, Torchia DA, Bax A. Sparse multidimensional iterative lineshape-enhanced (SMILE) reconstruction of both non-uniformly sampled and conventional NMR data. J Biomol NMR. 2017 Jun;68(2):101-11
