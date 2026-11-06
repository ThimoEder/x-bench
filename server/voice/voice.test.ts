import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { existsSync, mkdtempSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { encodeWav } from "../../ui/chat/composer/voice.ts";
import type { Waveform } from "sherpa-onnx-node";
import { createVoice, decodeWav, readAudio, weightsReady, type DownloadProgress } from "./voice.ts";

class FakeRequest extends EventEmitter {
  destroy() {
    this.emit("error", new Error("aborted"));
  }
}

test("a pcm wav round-trips to float samples", () => {
  const wav = Buffer.from(encodeWav(new Float32Array([0, 0.5, -0.5]), 16000));
  const decoded = decodeWav(wav);
  assert.equal(decoded.sampleRate, 16000);
  assert.equal(decoded.samples.length, 3);
  assert.equal(decoded.samples[0], 0);
  assert.ok(Math.abs((decoded.samples[1] ?? NaN) - 0.5) < 0.002);
  assert.ok(Math.abs((decoded.samples[2] ?? NaN) + 0.5) < 0.002);
});

test("a truncated recording is rejected", () => {
  assert.throws(() => decodeWav(Buffer.from("nope")), /could not be read/);
});

test("transcribe uses a stub recognizer and skips the download when weights exist", async () => {
  const dir = tempModel();
  const seen: { waveform?: Waveform } = {};
  const voice = createVoice({
    modelDir: dir,
    download: async () => {
      throw new Error("should not download");
    },
    loadRecognizer: async () => ({
      createStream() {
        return {
          acceptWaveform(payload) {
            seen.waveform = payload;
          },
        };
      },
      async decodeAsync() {
        return { text: "  hello there  " };
      },
    }),
  });
  const text = await voice.transcribe(Buffer.from(encodeWav(new Float32Array([0.1, -0.1]), 16000)));
  assert.equal(text, "hello there");
  assert.equal(seen.waveform?.sampleRate, 16000);
  assert.equal(seen.waveform?.samples.length, 2);
  assert.equal(voice.status().state, "ready");
});

test("a download reports progress, unpacks, loads and becomes ready", async () => {
  const dir = path.join(mkdtempSync(path.join(os.tmpdir(), "x-bench-voice-")), "model");
  const steps = gates();
  let loads = 0;
  const voice = createVoice({
    modelDir: dir,
    download: async (dest, progress) => {
      progress.received(100, 400);
      await steps.next();
      progress.unpacking();
      writeWeights(dest);
      assert.equal(weightsReady(dir), false);
      await steps.next();
    },
    loadRecognizer: async () => {
      loads += 1;
      return stubRecognizer();
    },
  });
  assert.equal(voice.status().state, "missing");
  const done = voice.prepare();
  await steps.reached();
  assert.deepEqual([voice.status().state, voice.status().received, voice.status().total], ["downloading", 100, 400]);
  assert.equal(voice.prepare(), done);
  steps.release();
  await steps.reached();
  assert.equal(voice.status().state, "unpacking");
  steps.release();
  await done;
  assert.equal(voice.status().state, "ready");
  assert.ok(voice.status().size > 0);
  assert.equal(existsSync(`${dir}.partial`), false);
  assert.equal(await voice.transcribe(Buffer.from(encodeWav(new Float32Array([0.2]), 16000))), "ok");
  assert.equal(loads, 1);
});

test("cancel aborts the download and leaves nothing behind", async () => {
  const dir = path.join(mkdtempSync(path.join(os.tmpdir(), "x-bench-voice-")), "model");
  const started = Promise.withResolvers<void>();
  const voice = createVoice({ modelDir: dir, download: (dest, progress) => abortable(dest, progress, started.resolve), loadRecognizer: stubRecognizer });
  const done = voice.prepare();
  await started.promise;
  assert.equal(existsSync(`${dir}.partial`), true);
  voice.cancel();
  await assert.rejects(done);
  assert.deepEqual(voice.status(), { state: "missing", received: 0, total: 0, size: 0, error: null });
  assert.equal(existsSync(`${dir}.partial`), false);
  assert.equal(existsSync(dir), false);
});

test("a failed download reports its error and a retry succeeds", async () => {
  const dir = path.join(mkdtempSync(path.join(os.tmpdir(), "x-bench-voice-")), "model");
  let attempt = 0;
  const voice = createVoice({
    modelDir: dir,
    download: async (dest) => {
      attempt += 1;
      writeFileSync(path.join(dest, "encoder.int8.onnx"), "half");
      if (attempt === 1) throw new Error("Speech model download failed (503)");
      writeWeights(dest);
    },
    loadRecognizer: stubRecognizer,
  });
  await assert.rejects(voice.prepare(), /503/);
  assert.equal(voice.status().state, "error");
  assert.equal(voice.status().error, "Speech model download failed (503)");
  assert.equal(existsSync(dir), false);
  assert.equal(existsSync(`${dir}.partial`), false);
  await voice.prepare();
  assert.equal(voice.status().state, "ready");
});

test("a download without all the weights never looks ready", async () => {
  const dir = path.join(mkdtempSync(path.join(os.tmpdir(), "x-bench-voice-")), "model");
  const voice = createVoice({
    modelDir: dir,
    download: async (dest) => {
      writeFileSync(path.join(dest, "tokens.txt"), "");
    },
    loadRecognizer: stubRecognizer,
  });
  await assert.rejects(voice.prepare(), /incomplete/);
  assert.equal(voice.status().state, "error");
  assert.equal(weightsReady(dir), false);
});

test("remove refuses while downloading, then deletes and unloads the model", async () => {
  const dir = path.join(mkdtempSync(path.join(os.tmpdir(), "x-bench-voice-")), "model");
  let loads = 0;
  let downloads = 0;
  const started = Promise.withResolvers<void>();
  const voice = createVoice({
    modelDir: dir,
    download: async (dest, progress) => {
      downloads += 1;
      if (downloads === 1) await abortable(dest, progress, started.resolve);
      writeWeights(dest);
    },
    loadRecognizer: async () => {
      loads += 1;
      return stubRecognizer();
    },
  });
  const first = voice.prepare();
  await started.promise;
  assert.equal(await voice.remove(), false);
  voice.cancel();
  await assert.rejects(first);
  await voice.prepare();
  assert.equal(loads, 1);
  assert.equal(await voice.remove(), true);
  assert.equal(existsSync(dir), false);
  assert.equal(voice.status().state, "missing");
  await assert.rejects(voice.transcribe(Buffer.from(encodeWav(new Float32Array([0.2]), 16000))), /not downloaded/);
  await voice.prepare();
  assert.equal(loads, 2);
  const removed = voice.remove();
  await assert.rejects(voice.transcribe(Buffer.from(encodeWav(new Float32Array([0.2]), 16000))), /not downloaded/);
  await assert.rejects(voice.prepare(), /being removed/);
  assert.equal(await voice.remove(), false);
  assert.equal(await removed, true);
});

test("a model that fails to load can be removed", async () => {
  const voice = createVoice({
    modelDir: tempModel(),
    loadRecognizer: () => {
      throw new Error("bad weights");
    },
  });
  await assert.rejects(voice.prepare(), /bad weights/);
  assert.equal(voice.status().state, "error");
  assert.equal(await voice.remove(), true);
  assert.equal(voice.status().state, "missing");
});

test("an oversized body is refused", async () => {
  const req = new FakeRequest();
  const pending = readAudio(req, 4);
  req.emit("data", Buffer.alloc(8));
  assert.equal(await pending, null);
});

function tempModel() {
  const dir = mkdtempSync(path.join(os.tmpdir(), "x-bench-voice-"));
  writeWeights(dir);
  return dir;
}

function writeWeights(dir: string) {
  for (const name of ["encoder.int8.onnx", "decoder.int8.onnx", "joiner.int8.onnx", "tokens.txt"]) {
    writeFileSync(path.join(dir, name), "weights");
  }
}

function stubRecognizer() {
  return {
    createStream: () => ({ acceptWaveform() {} }),
    decodeAsync: async () => ({ text: "ok" }),
  };
}

// A fake download that writes part of the archive, calls started, and waits until it is aborted.
function abortable(dest: string, progress: DownloadProgress, started: () => void) {
  progress.received(10, 400);
  writeFileSync(path.join(dest, "archive.tar.bz2"), "partial");
  started();
  return new Promise<void>((_, reject) => {
    progress.signal.addEventListener("abort", () => reject(progress.signal.reason));
  });
}

// Each next() waits for one release(); reached() resolves once the download waits at the current gate.
function gates() {
  const waiting: (() => void)[] = [];
  let arrived = Promise.withResolvers<void>();
  return {
    next: () =>
      new Promise<void>((resolve) => {
        waiting.push(resolve);
        arrived.resolve();
      }),
    reached: () => arrived.promise,
    release: () => {
      arrived = Promise.withResolvers<void>();
      waiting.shift()?.();
    },
  };
}
