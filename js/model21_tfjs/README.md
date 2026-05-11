# Model21 TensorFlow.js Export

## Model Information
- Architecture: model21 (3D phase prediction)
- Input shape: (batch, 32, 3, 16, 16, 96, 2)
- Output: Per-token phase and weight predictions

## Inputs
- **cube_input**: Pre-extracted normalized cubes
  - Type: Float32
  - Shape: (batch, 32, 3, 16, 16, 96, 2)
  - Each cube must be normalized to max amplitude 1.0

## Outputs
- **pred_local_phase**: Predicted phase per token
  - Type: Float32
  - Shape: (batch, 32)
  - Range: typically [-180, 180] degrees
  
- **pred_local_w**: Effective weight per token
  - Type: Float32
  - Shape: (batch, 32)
  - Range: [0.01, 1.0] (0.01 for inactive, ~1.0 for active tokens)

## Usage Example (Node.js)

```javascript
const tf = require('@tensorflow/tfjs');
const model = await tf.loadLayersModel('file://./model.json');

// Prepare cubes: shape (1, 32, 3, 16, 16, 96, 2)
const cubes = tf.randomNormal([
  1, 32, 3, 16, 16, 96, 2
]);

// Run inference
const result = model.predict({cube_input: cubes});

// Extract results
const phase = result.pred_local_phase.dataSync();  // Float32Array
const weights = result.pred_local_w.dataSync();     // Float32Array

console.log('Phase per token:', phase);
console.log('Weight per token:', weights);

// Clean up
cubes.dispose();
result.pred_local_phase.dispose();
result.pred_local_w.dispose();
```

## Usage Example (Browser)

```html
<script src="https://cdn.jsdelivr.net/npm/@tensorflow/tfjs@latest"></script>
<script src="https://cdn.jsdelivr.net/npm/@tensorflow/tfjs-layers@latest"></script>

<script>
async function predictPhase() {
  // Load model
  const model = await tf.loadLayersModel('./model.json');
  
  // Create sample cubes (replace with real data)
  const cubes = tf.randomNormal([1, 32, 3, 16, 16, 96, 2]);
  
  // Run inference
  const result = model.predict({cube_input: cubes});
  
  // Convert to arrays
  const phaseArray = await result.pred_local_phase.array();
  const weightArray = await result.pred_local_w.array();
  
  console.log('Predictions:');
  console.log('  Phase:', phaseArray[0]);
  console.log('  Weights:', weightArray[0]);
  
  // Clean up
  cubes.dispose();
  result.pred_local_phase.dispose();
  result.pred_local_w.dispose();
}

predictPhase();
</script>
```

## Pre-processing Cubes

Before feeding cubes to the model:
1. Extract top-N cubes per token using power ranking
2. Normalize each token to max absolute amplitude 1.0
3. Convert to Float32 tensor with shape (batch, n_tokens, top_n, 16, 16, 96, 2)

## Performance Notes
- Model is optimized for CPU inference
- Batch processing is supported for efficiency
- Memory usage: ~3MB weights + ~100MB for inference buffer (est.)
