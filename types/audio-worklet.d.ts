// The two AudioWorklet globals ui/chat/composer/voice-worklet.js uses. Only tsconfig.worklet.json
// includes this file, so the page never sees them.
declare class AudioWorkletProcessor {
  readonly port: MessagePort;
}

declare function registerProcessor(name: string, processor: new () => AudioWorkletProcessor): void;
