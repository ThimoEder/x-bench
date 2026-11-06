// The parts of sherpa-onnx-node that server/voice.js uses. The package ships
// JavaScript only. Shapes follow its JSDoc in types.js and non-streaming-asr.js.
declare module "sherpa-onnx-node" {
  export interface FeatureConfig {
    sampleRate?: number;
    featureDim?: number;
  }

  export interface OfflineTransducerModelConfig {
    encoder?: string;
    decoder?: string;
    joiner?: string;
  }

  export interface OfflineModelConfig {
    transducer?: OfflineTransducerModelConfig;
    tokens?: string;
    numThreads?: number;
    provider?: string;
    debug?: number;
    modelType?: string;
  }

  export interface OfflineRecognizerConfig {
    featConfig?: FeatureConfig;
    modelConfig?: OfflineModelConfig;
  }

  export interface Waveform {
    samples: Float32Array;
    sampleRate: number;
  }

  export interface OfflineRecognizerResult {
    lang: string;
    emotion: string;
    event: string;
    text: string;
    timestamps: number[];
    durations: number[];
    tokens: string[];
    ys_log_probs: number[];
    words: number[];
  }

  export class OfflineStream {
    acceptWaveform(waveform: Waveform): void;
  }

  export class OfflineRecognizer {
    static createAsync(config: OfflineRecognizerConfig): Promise<OfflineRecognizer>;
    createStream(hotwords?: string): OfflineStream;
    decode(stream: OfflineStream): void;
    decodeAsync(stream: OfflineStream): Promise<OfflineRecognizerResult>;
    getResult(stream: OfflineStream): OfflineRecognizerResult;
  }
}
