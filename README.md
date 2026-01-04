# COLMARvista
Web based NMR spectra viewer.

# Installation
Download all files/folders into one location or visit as a web server.

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

Please refer to the wiki page https://github.com/lidawei1975/colmarvista/wiki for user instructions. 

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
