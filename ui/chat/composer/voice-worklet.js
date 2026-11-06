// @ts-check
class VoiceCapture extends AudioWorkletProcessor {
  /** @param {Float32Array[][]} inputs */
  process(inputs) {
    const channel = inputs[0]?.[0];
    if (channel?.length) {
      const copy = new Float32Array(channel.length);
      copy.set(channel);
      this.port.postMessage(copy);
    }
    return true;
  }
}

registerProcessor("voice-capture", VoiceCapture);
