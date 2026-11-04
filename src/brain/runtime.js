// Generic sparse affine/ReLU DAG with residual connections and recurrent wiring.
export function createRuntime(net) {
  const values = new Float64Array(net.base + net.biases.length);
  const memory = new Float64Array(net.stateSize);
  const offsets = Uint32Array.from(net.offsets);
  const sources = Uint32Array.from(net.sources);
  const weights = Float64Array.from(net.weights);
  const biases = Float64Array.from(net.biases);
  const activations = Uint8Array.from(net.activations);
  return {
    values,
    reset() { values.fill(0); memory.fill(0); },
    forward(input, output) {
      values.set(input, 0);
      values.set(memory, net.inputSize);
      for (let n = 0; n < biases.length; n++) {
        let sum = biases[n];
        for (let j = offsets[n]; j < offsets[n + 1]; j++) sum += weights[j] * values[sources[j]];
        values[net.base + n] = activations[n] ? Math.max(0, sum) : sum;
      }
      for (let i = 0; i < memory.length; i++) memory[i] = values[net.recurrence[i]];
      for (let i = 0; i < net.outputs.length; i++) output[i] = Math.max(-1, Math.min(1, values[net.outputs[i]]));
    },
  };
}
