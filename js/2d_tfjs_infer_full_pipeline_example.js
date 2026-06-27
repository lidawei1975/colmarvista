// 1. Initialize TensorFlow.js and load the models from your server's static directories
async function initPipelineAndRun(ft2File) {
    try {
        // Reference the global window object loaded from the scripts
        const pipeline = window.NUS2DPhasePipeline;
        const tf = window.tf;

        console.log("Loading models...");

        // Replace these URLs with the correct paths on your web server
        const modelUrl = '/2D_model30_tfjs/model.json';
        const largeModelUrl = '/2D_model30_large_tfjs/model.json';

        // Register custom model layers and load the model instances
        pipeline.registerCustomLayers(tf);
        const model = await tf.loadGraphModel(modelUrl);
        const largeModel = await tf.loadGraphModel(largeModelUrl);

        console.log("Reading FT2 file into ArrayBuffer...");
        const ft2ArrayBuffer = await readFileAsArrayBuffer(ft2File);

        console.log("Executing 5-stage inference pipeline...");
        const result = await pipeline.runFromFt2({
            tf: tf,
            ft2ArrayBuffer: ft2ArrayBuffer,
            model: model,
            largeModel: largeModel,
            useTokenNorms: false, // matches test_tfjs_pipeline.js settings
        });

        console.log("Inference complete!", result);

        // Retrieve the final phase outputs (Left, Right)
        const finalPhases = result.final_wls_phase_left_right;
        console.log("Final WLS phase left/right arrays:", finalPhases);

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
