// Wrap the logic in an async function to use 'await'
async function runPrediction() {
    // 1. Load the model
    console.log('Loading model...');
    // Use tf.loadGraphModel for SavedModel format, or tf.loadLayersModel for Keras
    const model = await tf.loadGraphModel('./saved_model/model.json');
    console.log('Model loaded successfully!');

    // 2. Preprocess Input Data (Example)
    // Let's assume your model expects a tensor of shape [1, 224, 224, 3]
    // representing a single normalized image.
    // NOTE: This is a placeholder! You must replace this with your actual input data.
    console.log('Creating input tensor...');
    // --- 1. Generate the Main Input ---
    // This creates a placeholder tensor with random data.
    // In your real application, you would replace this with your actual 1D array data.
    const mainData = tf.randomNormal([65536]); // Example data
    const mainTensor = mainData.reshape([1, 65536, 1]);

    // --- 2. Generate the Mask Input ---
    // This creates a tensor of shape [1, 512] filled with the value 1.0.
    const maskTensor = tf.ones([1, 512],'bool');
        

    const inputs = {
        'main_input': mainTensor,
        'mask_input': maskTensor
        };

    // 3. Run the prediction with the input object
    console.log('Running prediction with named inputs...');
    const prediction = model.predict(inputs);

    // The output 'prediction' is a tensor.

    // 4. Process Output
    console.log('Processing output...');
    // Use .dataSync() or .data() (async) to get the raw values from the tensor
    const outputData = prediction.dataSync();

    const probabilities = Array.from(outputData);

    console.log(`Prediction finished.`);
    console.log('Output Probabilities:', probabilities);

    // Clean up memory by disposing of the tensors
    mainTensor.dispose();
    maskTensor.dispose();
    prediction.dispose();
}

// Run the function
runPrediction();