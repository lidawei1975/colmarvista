// 1. Initialize TensorFlow.js and load Model 17 from your server's static directory
async function initPipelineAndRun(ft2File) {
    try {
        // Reference the global window object loaded from the scripts
        const pipeline = window.NUS2DPhasePipeline;
        const tf = window.tf;

        console.log("Loading Model 17...");

        // Replace this URL with the correct path on your web server
        const modelUrl = 'js/model17_tfjs/model.json';

        // Load the Model 17 GraphModel instance (with automatic CPU fallback for integrated GPUs)
        const model = await pipeline.loadModel(tf, modelUrl);

        console.log("Reading FT2 file into ArrayBuffer...");
        const ft2ArrayBuffer = await readFileAsArrayBuffer(ft2File);

        console.log("Executing 2-round Model 17 inference pipeline...");
        const result = await pipeline.runFromFt2({
            tf: tf,
            ft2ArrayBuffer: ft2ArrayBuffer,
            model: model,
            numRounds: 2,
        });

        console.log("Inference complete!", result);

        // Retrieve the final phase outputs (Left, Right)
        const finalPhases = result.final_wls_phase_left_right;
        console.log("Final phase left/right arrays:", finalPhases);

        alert(`Prediction Complete!\nFirst row phases (Left, Right): ${finalPhases[0].join(', ')}`);

    } catch (error) {
        console.error("Error executing pipeline:", error);
    }
}

// Helper utility to read a File object into an ArrayBuffer via FileReader
function readFileAsArrayBuffer(file) {
    return new Promise((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => resolve(reader.result);
        reader.onerror = () => reject(reader.error);
        reader.readAsArrayBuffer(file);
    });
}
