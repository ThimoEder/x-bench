import { spawn } from "node:child_process";
import { createWriteStream, readdirSync, statSync } from "node:fs";
import fs from "node:fs/promises";
import { createRequire } from "node:module";
import path from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import type { ReadableStream as NodeReadableStream } from "node:stream/web";
import type { OfflineRecognizerResult, OfflineStream } from "sherpa-onnx-node";

// NVIDIA Parakeet TDT 0.6B v3, INT8, via sherpa-onnx. License: CC-BY-4.0.
export const MODEL_URL =
  "https://github.com/k2-fsa/sherpa-onnx/releases/download/asr-models/sherpa-onnx-nemo-parakeet-tdt-0.6b-v3-int8.tar.bz2";
export const MODEL_NAME = "sherpa-onnx-nemo-parakeet-tdt-0.6b-v3-int8";
export const MAX_WAV_BYTES = 4 * 1024 * 1024;

const MODEL_FILES = ["encoder.int8.onnx", "decoder.int8.onnx", "joiner.int8.onnx", "tokens.txt"];

type Sherpa = typeof import("sherpa-onnx-node");

// The parts of sherpa's OfflineRecognizer that transcribe uses.
export type SpeechStream = Pick<OfflineStream, "acceptWaveform">;
export type SpeechResult = Pick<OfflineRecognizerResult, "text">;
export type SpeechRecognizer = { createStream(): SpeechStream } & (
  | { decodeAsync(stream: SpeechStream): Promise<SpeechResult> }
  | { decodeAsync?: undefined; decode(stream: SpeechStream): void; getResult(stream: SpeechStream): SpeechResult }
);

export interface VoiceOptions {
  modelDir: string;
  download?: (dest: string, progress: DownloadProgress) => Promise<void>;
  loadRecognizer?: (dir: string) => SpeechRecognizer | Promise<SpeechRecognizer>;
}

export interface DownloadProgress {
  signal: AbortSignal;
  received(bytes: number, total: number): void;
  unpacking(): void;
}

export type VoiceState = "missing" | "downloading" | "unpacking" | "loading" | "ready" | "error";

export interface VoiceStatus {
  state: VoiceState;
  // Bytes of the archive so far and its content-length, while downloading.
  received: number;
  total: number;
  // Bytes of the model on disk, when ready.
  size: number;
  error: string | null;
}

export interface Voice {
  status(): VoiceStatus;
  // Downloads the model if missing, then loads it.
  prepare(): Promise<void>;
  cancel(): void;
  // False while a download or a transcription runs.
  remove(): Promise<boolean>;
  transcribe(buffer: Uint8Array): Promise<string>;
}

export interface DecodedWav {
  sampleRate: number;
  samples: Float32Array;
}

// The request events readAudio listens to.
export interface AudioSource {
  on(event: "data", listener: (chunk: Buffer) => void): unknown;
  on(event: "end", listener: () => void): unknown;
  on(event: "error", listener: (error: Error) => void): unknown;
  destroy(): unknown;
}

export function modelDir(modelsDir: string): string {
  return path.join(modelsDir, MODEL_NAME);
}

export function weightsReady(dir: string): boolean {
  return MODEL_FILES.every((name) => {
    try {
      return statSync(path.join(dir, name)).isFile();
    } catch {
      return false;
    }
  });
}

export function decodeWav(input: Uint8Array): DecodedWav {
  const view = Buffer.isBuffer(input) ? input : Buffer.from(input);
  if (view.length < 44 || view.toString("ascii", 0, 4) !== "RIFF" || view.toString("ascii", 8, 12) !== "WAVE") {
    throw new Error("Recording could not be read");
  }
  let offset = 12;
  let format: { audioFormat: number; channels: number; sampleRate: number; bits: number } | null = null;
  let data: Buffer | null = null;
  while (offset + 8 <= view.length) {
    const id = view.toString("ascii", offset, offset + 4);
    const size = view.readUInt32LE(offset + 4);
    const start = offset + 8;
    if (start + size > view.length) break;
    if (id === "fmt ") {
      format = {
        audioFormat: view.readUInt16LE(start),
        channels: view.readUInt16LE(start + 2),
        sampleRate: view.readUInt32LE(start + 4),
        bits: view.readUInt16LE(start + 14),
      };
    } else if (id === "data") {
      data = view.subarray(start, start + size);
    }
    offset = start + size + (size % 2);
  }
  if (!format || format.audioFormat !== 1 || format.bits !== 16 || format.channels < 1 || !data) {
    throw new Error("Recording could not be read");
  }
  const frame = format.channels * 2;
  const frames = Math.floor(data.length / frame);
  const samples = new Float32Array(frames);
  for (let i = 0; i < frames; i++) {
    let sum = 0;
    for (let channel = 0; channel < format.channels; channel++) {
      sum += data.readInt16LE(i * frame + channel * 2) / 32768;
    }
    samples[i] = sum / format.channels;
  }
  return { sampleRate: format.sampleRate, samples };
}

export function readAudio(req: AudioSource, max = MAX_WAV_BYTES): Promise<Buffer | null> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    let settled = false;
    let tooBig = false;
    const finish = (value: Buffer | null) => {
      if (settled) return;
      settled = true;
      resolve(value);
    };
    req.on("data", (chunk) => {
      if (tooBig) return;
      size += chunk.length;
      if (size > max) {
        tooBig = true;
        req.destroy();
        finish(null);
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => finish(tooBig ? null : Buffer.concat(chunks)));
    req.on("error", (error) => {
      if (tooBig) finish(null);
      else if (!settled) {
        settled = true;
        reject(error);
      }
    });
  });
}

export function createVoice(options: VoiceOptions): Voice {
  const dir = options.modelDir;
  // The download unpacks here and moves to dir only once its weights are complete.
  const partial = `${dir}.partial`;
  const download = options.download || downloadModel;
  const loadRecognizer = options.loadRecognizer || ((folder: string) => loadSherpa(folder));
  let phase: "downloading" | "unpacking" | "loading" | null = null;
  let received = 0;
  let total = 0;
  let error: string | null = null;
  let controller: AbortController | null = null;
  let job: Promise<void> | null = null;
  let transcribing = 0;
  let removing = false;
  let recognizerPromise: Promise<SpeechRecognizer> | null = null;

  function status(): VoiceStatus {
    const state: VoiceState = phase || (error ? "error" : weightsReady(dir) ? "ready" : "missing");
    const downloading = state === "downloading";
    return { state, received: downloading ? received : 0, total: downloading ? total : 0, size: state === "ready" ? folderSize(dir) : 0, error };
  }

  function prepare(): Promise<void> {
    if (removing) return Promise.reject(new Error("The speech model is being removed"));
    if (!job) {
      error = null;
      received = 0;
      total = 0;
      const abort = new AbortController();
      controller = abort;
      job = (async () => {
        if (!weightsReady(dir)) {
          phase = "downloading";
          try {
            await fs.rm(partial, { recursive: true, force: true });
            await fs.mkdir(partial, { recursive: true });
            await download(partial, {
              signal: abort.signal,
              received(bytes, size) {
                received = bytes;
                total = size;
              },
              unpacking() {
                phase = "unpacking";
              },
            });
            abort.signal.throwIfAborted();
            if (!weightsReady(partial)) throw new Error("Speech model download was incomplete");
            await fs.rm(dir, { recursive: true, force: true });
            await fs.rename(partial, dir);
          } finally {
            await fs.rm(partial, { recursive: true, force: true }).catch(() => {});
          }
        }
        phase = "loading";
        await recognizer();
      })()
        .catch((err: unknown) => {
          if (!abort.signal.aborted) error = messageOf(err) || "Speech model failed to load";
          throw err;
        })
        .finally(() => {
          phase = null;
          job = null;
          controller = null;
        });
    }
    return job;
  }

  function cancel() {
    controller?.abort();
  }

  async function remove(): Promise<boolean> {
    if (job || transcribing || removing) return false;
    removing = true;
    recognizerPromise = null;
    error = null;
    try {
      await fs.rm(dir, { recursive: true, force: true });
      await fs.rm(partial, { recursive: true, force: true });
    } finally {
      removing = false;
    }
    return true;
  }

  function recognizer(): Promise<SpeechRecognizer> {
    if (!recognizerPromise) {
      recognizerPromise = Promise.resolve()
        .then(() => loadRecognizer(dir))
        .catch((err: unknown) => {
          recognizerPromise = null;
          throw new Error(messageOf(err) || "The speech engine failed to load");
        });
    }
    return recognizerPromise;
  }

  async function transcribe(buffer: Uint8Array): Promise<string> {
    const wav = decodeWav(buffer);
    if (!wav.samples.length) return "";
    if (removing || !weightsReady(dir)) throw new Error("The speech model is not downloaded");
    transcribing += 1;
    try {
      const engine = await recognizer();
      const stream = engine.createStream();
      stream.acceptWaveform({ samples: wav.samples, sampleRate: wav.sampleRate });
      const result = engine.decodeAsync ? await engine.decodeAsync(stream) : (engine.decode(stream), engine.getResult(stream));
      return String(result?.text || "").trim();
    } finally {
      transcribing -= 1;
    }
  }

  return { status, prepare, cancel, remove, transcribe };
}

function folderSize(dir: string): number {
  try {
    return readdirSync(dir, { recursive: true, encoding: "utf8" }).reduce((sum, name) => sum + statSync(path.join(dir, name)).size, 0);
  } catch {
    return 0;
  }
}

async function downloadModel(dest: string, progress: DownloadProgress): Promise<void> {
  const archive = path.join(dest, `${MODEL_NAME}.tar.bz2`);
  const response = await fetch(MODEL_URL, { signal: progress.signal });
  if (!response.ok || !response.body) throw new Error(`Speech model download failed (${response.status})`);
  const total = Number(response.headers.get("content-length")) || 0;
  let received = 0;
  await pipeline(
    // The DOM and Node typings of ReadableStream disagree on BYOB readers; it is the same object.
    Readable.fromWeb(response.body as NodeReadableStream<Uint8Array>),
    async function* (source: AsyncIterable<Buffer>) {
      for await (const chunk of source) {
        received += chunk.length;
        progress.received(received, total);
        yield chunk;
      }
    },
    createWriteStream(archive),
    { signal: progress.signal },
  );
  progress.unpacking();
  await extractTar(archive, dest, progress.signal);
  await fs.unlink(archive);
}

function extractTar(archive: string, dest: string, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn("tar", ["-xjf", archive, "-C", dest, "--strip-components=1"], { signal });
    let stderr = "";
    child.stderr.on("data", (chunk: Buffer) => {
      stderr += chunk;
    });
    child.on("error", reject);
    child.on("exit", (code) => {
      if (code === 0) resolve();
      else reject(new Error(stderr.trim() || `tar exited ${code}`));
    });
  });
}

async function loadSherpa(dir: string) {
  const require = createRequire(import.meta.url);
  let sherpa: Sherpa;
  try {
    sherpa = require("sherpa-onnx-node");
  } catch {
    throw new Error("The speech engine failed to load");
  }
  return sherpa.OfflineRecognizer.createAsync({
    featConfig: { sampleRate: 16000, featureDim: 80 },
    modelConfig: {
      transducer: {
        encoder: path.join(dir, "encoder.int8.onnx"),
        decoder: path.join(dir, "decoder.int8.onnx"),
        joiner: path.join(dir, "joiner.int8.onnx"),
      },
      tokens: path.join(dir, "tokens.txt"),
      numThreads: 2,
      provider: "cpu",
      debug: 0,
      modelType: "nemo_transducer",
    },
  });
}

function messageOf(err: unknown) {
  return err instanceof Error ? err.message : "";
}
