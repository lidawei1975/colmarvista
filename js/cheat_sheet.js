import MyModule from './mymodule.js';

MyModule().then(Module => {
  // Create C++ instance
  const obj = new Module.MyClass();

  // ✅ Call a function with NO arguments
  obj.doSomething();

  // ✅ Call a function with INT argument
  const resultInt = obj.addInt(5);  // => 15
  console.log(resultInt);

  // ✅ Call a function with BOOL argument
  const resultBool = obj.setFlag(true);  // => true
  console.log(resultBool);

  // ✅ Call a function with FLOAT argument
  const resultFloat = obj.multiply(2.5);  // => 5.0
  console.log(resultFloat);

  // ✅ Call a function with VECTOR<FLOAT32>
  // Make JS Float32Array first
  const jsArray = new Float32Array([1.0, 2.0, 3.0]);

  // Convert to Embind VectorFloat
  const vec = new Module.VectorFloat();
  for (let i = 0; i < jsArray.length; ++i) {
    vec.push_back(jsArray[i]);
  }

  obj.setVector(vec);

  // Get vector back (returns VectorFloat)
  const returnedVec = obj.getVector();
  console.log(returnedVec.size()); // 3
  console.log(returnedVec.get(0)); // 1.0

  // If needed, convert to JS array:
  const jsArrayBack = [];
  for (let i = 0; i < returnedVec.size(); ++i) {
    jsArrayBack.push(returnedVec.get(i));
  }
  console.log(jsArrayBack); // [1.0, 2.0, 3.0]

  // Clean up (optional but good)
  vec.delete();
  returnedVec.delete();
  obj.delete();
});
