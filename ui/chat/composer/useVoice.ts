import { useEffect, useRef, useState } from "react";
import type { RefObject } from "react";
import { downsample, encodeWav, foreignField, insertAtCursor, MAX_TAKE_MS, mergeFloats, SAMPLE_RATE, voiceKey } from "./voice.ts";
import { apiFetch } from "../../launchToken.ts";
import { quietVolume, readDictationSetting, useDictationSetting } from "../../settings/dictationSettings.ts";
import { openSpeechModel, refreshSpeechModel } from "../../voice/speechModel.ts";

export type VoicePhase = "idle" | "arming" | "recording" | "busy";

interface MicrophoneTake {
  sampleRate: number;
  chunks: Float32Array[];
  close(): void;
}

// The hook whose take holds the microphone. Panes share it and the Mac's volume, so one records at a time.
let recorder: object | null = null;

export interface VoiceOptions {
  // Alt-hold starts dictation only while this is on. A take already running goes on without it.
  hotkey: boolean;
  box: RefObject<HTMLTextAreaElement | null>;
  draftRef: RefObject<string>;
  setDraft: (text: string) => void;
  setCursor: (cursor: number) => void;
  setAttachError: (error: string) => void;
}

// Local dictation: hold Alt or press the mic, and the transcript lands at the caret.
export function useVoice({ hotkey, box, draftRef, setDraft, setCursor, setAttachError }: VoiceOptions) {
  const [voicePhase, setVoicePhase] = useState<VoicePhase>("idle");
  const [voiceNote, setVoiceNote] = useState("");
  const [voiceEnabled] = useDictationSetting("dictation");
  const [quietWanted] = useDictationSetting("lowerVolume");
  const voicePhaseRef = useRef<VoicePhase>("idle");
  const voiceVia = useRef<"hold" | "button" | null>(null);
  const voiceStarted = useRef(0);
  const voiceMedia = useRef<MicrophoneTake | null>(null);
  const voiceTimer = useRef<ReturnType<typeof setTimeout> | 0>(0);
  const voiceToken = useRef(0);
  const mounted = useRef(true);
  const beginVoiceRef = useRef<(via: "hold" | "button") => void>(() => {});
  const finishVoiceRef = useRef<() => void>(() => {});
  const cancelVoiceRef = useRef<() => void>(() => {});
  const endTakeRef = useRef<() => void>(() => {});
  const quietenRef = useRef<(quiet: boolean) => void>(() => {});
  const owner = useRef({}).current;
  // Set when the window lost focus during an Alt-hold take, so the Alt release went elsewhere.
  const voiceAway = useRef(false);
  // The take the host turned the volume down for.
  const quietTake = useRef<string | null>(null);
  // The Alt listener subscribes once and reads these through refs.
  const hotkeyRef = useRef(hotkey);
  hotkeyRef.current = hotkey && voiceEnabled;
  const composerBox = useRef(box);
  composerBox.current = box;

  useEffect(() => {
    // Finishes a take whose Alt release was missed, at the first event that shows Alt up.
    function releasedAway(event: KeyboardEvent | PointerEvent) {
      if (!voiceAway.current || voiceVia.current !== "hold" || event.altKey) return false;
      voiceAway.current = false;
      if (voicePhaseRef.current === "recording") finishVoiceRef.current();
      else cancelVoiceRef.current();
      return true;
    }
    function onKey(event: KeyboardEvent) {
      if (releasedAway(event)) return;
      const action = voiceKey(event, {
        recording: voicePhaseRef.current === "recording" || voicePhaseRef.current === "arming",
        busy: voicePhaseRef.current === "busy",
        via: voiceVia.current,
        heldMs: Date.now() - voiceStarted.current,
        foreignField: foreignField(document.activeElement, composerBox.current.current),
      });
      if (action === "start") {
        if (!hotkeyRef.current) return;
        event.preventDefault();
        beginVoiceRef.current("hold");
      } else if (action === "stop") {
        event.preventDefault();
        if (voicePhaseRef.current === "recording") finishVoiceRef.current();
        else cancelVoiceRef.current();
      } else if (action === "discard" || action === "cancel") {
        event.preventDefault();
        event.stopPropagation();
        cancelVoiceRef.current();
      } else if (action === "abort") {
        cancelVoiceRef.current();
      }
    }
    function onBlur() {
      if (voiceVia.current === "hold") voiceAway.current = true;
    }
    function onPointer(event: PointerEvent) {
      releasedAway(event);
    }
    function onPageHide() {
      endTakeRef.current();
    }
    window.addEventListener("keydown", onKey, true);
    window.addEventListener("keyup", onKey, true);
    window.addEventListener("blur", onBlur);
    window.addEventListener("pointermove", onPointer, true);
    window.addEventListener("pointerdown", onPointer, true);
    window.addEventListener("pagehide", onPageHide);
    return () => {
      window.removeEventListener("keydown", onKey, true);
      window.removeEventListener("keyup", onKey, true);
      window.removeEventListener("blur", onBlur);
      window.removeEventListener("pointermove", onPointer, true);
      window.removeEventListener("pointerdown", onPointer, true);
      window.removeEventListener("pagehide", onPageHide);
    };
  }, []);

  useEffect(() => {
    if (voicePhaseRef.current === "recording") quietenRef.current(quietWanted);
  }, [quietWanted]);

  useEffect(() => {
    if (!voiceEnabled) cancelVoiceRef.current();
  }, [voiceEnabled]);

  useEffect(
    () => () => {
      mounted.current = false;
      cancelVoiceRef.current();
    },
    [],
  );

  function setVoice(phase: VoicePhase) {
    voicePhaseRef.current = phase;
    if (mounted.current) setVoicePhase(phase);
  }

  async function beginVoice(via: "hold" | "button") {
    if (!readDictationSetting("dictation") || voicePhaseRef.current !== "idle" || (recorder && recorder !== owner)) return;
    const token = voiceToken.current + 1;
    voiceToken.current = token;
    recorder = owner;
    voiceAway.current = false;
    voiceVia.current = via;
    voiceStarted.current = Date.now();
    setAttachError("");
    setVoiceNote("");
    setVoice("arming");
    let media: MicrophoneTake | null = null;
    try {
      const model = await refreshSpeechModel();
      if (token !== voiceToken.current) return;
      if (model.state !== "ready" && model.state !== "loading") {
        voiceToken.current += 1;
        voiceVia.current = null;
        endTake();
        setVoice("idle");
        openSpeechModel();
        return;
      }
      // With the weights on disk, this only loads the model, while the microphone opens.
      if (model.state === "ready") apiFetch("/api/voice/download", { method: "POST", headers: { "content-type": "application/json" }, body: "{}" }).catch(() => {});
      media = await openMicrophone();
      if (token !== voiceToken.current || (voicePhaseRef.current as VoicePhase) !== "arming") {
        media.close();
        return;
      }
      voiceMedia.current = media;
      setVoiceNote("");
      setVoice("recording");
      try {
        playReadyTone();
      } catch {
        // The wave still marks that recording has started.
      }
      quieten(readDictationSetting("lowerVolume"));
      voiceTimer.current = setTimeout(() => finishVoiceRef.current(), MAX_TAKE_MS);
    } catch (error) {
      media?.close();
      if (token !== voiceToken.current) return;
      voiceToken.current += 1;
      clearTimeout(voiceTimer.current);
      voiceVia.current = null;
      endTake();
      setVoice("idle");
      setVoiceNote(microphoneMessage(error));
    }
  }

  function cancelVoice() {
    voiceToken.current += 1;
    clearTimeout(voiceTimer.current);
    voiceMedia.current?.close();
    voiceMedia.current = null;
    voiceVia.current = null;
    endTake();
    if (voicePhaseRef.current === "arming" || voicePhaseRef.current === "recording" || voicePhaseRef.current === "busy") {
      setVoiceNote("");
      setVoice("idle");
    }
  }

  // Turns the Mac's volume down for the recording take, or back up.
  function quieten(quiet: boolean) {
    const take = quietTake.current;
    if (quiet && !take) {
      quietTake.current = crypto.randomUUID();
      quietVolume(true, quietTake.current);
    } else if (!quiet && take) {
      quietTake.current = null;
      quietVolume(false, take);
    }
  }

  // The take stopped recording: another pane may record, and the volume comes back.
  function endTake() {
    voiceAway.current = false;
    if (recorder === owner) recorder = null;
    quieten(false);
  }

  async function finishVoice() {
    if (voicePhaseRef.current !== "recording") return;
    const token = voiceToken.current;
    clearTimeout(voiceTimer.current);
    setVoice("busy");
    endTake();
    const started = Date.now();
    while (!voiceMedia.current && token === voiceToken.current && Date.now() - started < 5000) {
      await new Promise((resolve) => {
        setTimeout(resolve, 30);
      });
    }
    if (token !== voiceToken.current) return;
    const media = voiceMedia.current;
    voiceMedia.current = null;
    voiceVia.current = null;
    const sampleRate = media?.sampleRate || SAMPLE_RATE;
    const samples = downsample(mergeFloats(media?.chunks || []), sampleRate, SAMPLE_RATE);
    media?.close();
    if (samples.length < SAMPLE_RATE / 10) {
      setVoice("idle");
      setVoiceNote("No speech heard");
      return;
    }
    setVoiceNote("Transcribing…");
    try {
      const response = await apiFetch("/api/transcribe", {
        method: "POST",
        headers: { "content-type": "audio/wav" },
        body: encodeWav(samples, SAMPLE_RATE),
      });
      const data: unknown = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(String(fieldOf(data, "error") || "Transcription failed"));
      if (token !== voiceToken.current) return;
      const text = String(fieldOf(data, "text") || "").trim();
      if (!text) {
        setVoiceNote("No speech heard");
        return;
      }
      const field = box.current;
      const current = field?.value ?? draftRef.current;
      const at = field ? field.selectionStart : current.length;
      const next = insertAtCursor(current, at, text);
      setDraft(next.draft);
      setCursor(next.cursor);
      setVoiceNote("");
      requestAnimationFrame(() => {
        const node = box.current;
        if (!node) return;
        node.focus();
        node.setSelectionRange(next.cursor, next.cursor);
      });
    } catch (error) {
      if (token === voiceToken.current) setVoiceNote((error instanceof Error && error.message) || "Transcription failed");
    } finally {
      if (token === voiceToken.current) setVoice("idle");
    }
  }

  beginVoiceRef.current = beginVoice;
  finishVoiceRef.current = finishVoice;
  cancelVoiceRef.current = cancelVoice;
  endTakeRef.current = endTake;
  quietenRef.current = quieten;

  function onVoiceClick() {
    if (voicePhaseRef.current === "busy") return;
    if (voicePhaseRef.current === "recording") finishVoice();
    else if (voicePhaseRef.current === "arming") cancelVoice();
    else beginVoice("button");
  }

  return { voiceEnabled, voicePhase, voiceNote, voicePhaseRef, finishVoice, onVoiceClick };
}

function microphoneMessage(error: unknown): string {
  const name = fieldOf(error, "name") || "";
  if (name === "NotAllowedError" || name === "NotFoundError" || name === "NotReadableError" || /microphone/i.test(String(fieldOf(error, "message") || ""))) {
    return "Microphone access is off. Enable it in System Settings → Privacy & Security → Microphone, then reload.";
  }
  return (error instanceof Error && error.message) || "Microphone access is off. Enable it in System Settings → Privacy & Security → Microphone, then reload.";
}

function playReadyTone() {
  const audio = new AudioContext();
  const tone = audio.createOscillator();
  const level = audio.createGain();
  tone.type = "sine";
  tone.frequency.value = 784;
  level.gain.setValueAtTime(0.0001, audio.currentTime);
  level.gain.exponentialRampToValueAtTime(0.06, audio.currentTime + 0.02);
  level.gain.exponentialRampToValueAtTime(0.0001, audio.currentTime + 0.16);
  tone.connect(level);
  level.connect(audio.destination);
  tone.start();
  tone.stop(audio.currentTime + 0.17);
  tone.onended = () => audio.close().catch(() => {});
}

async function openMicrophone(): Promise<MicrophoneTake> {
  if (!navigator.mediaDevices?.getUserMedia) throw new Error("Microphone unavailable");
  const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
  const audio = new AudioContext();
  const source = audio.createMediaStreamSource(stream);
  const chunks: Float32Array[] = [];
  let node: AudioWorkletNode | null = null;
  let processor: ScriptProcessorNode | null = null;
  const gain = audio.createGain();
  gain.gain.value = 0;
  try {
    await audio.audioWorklet.addModule(new URL("./voice-worklet.js", import.meta.url));
    node = new AudioWorkletNode(audio, "voice-capture");
    node.port.onmessage = (event: MessageEvent<unknown>) => {
      if (event.data instanceof Float32Array && event.data.length) chunks.push(event.data);
    };
    source.connect(node);
    node.connect(gain);
  } catch {
    processor = audio.createScriptProcessor(4096, 1, 1);
    processor.onaudioprocess = (event) => {
      chunks.push(new Float32Array(event.inputBuffer.getChannelData(0)));
    };
    source.connect(processor);
    processor.connect(gain);
  }
  if (!node && !processor) throw new Error("Microphone unavailable");
  gain.connect(audio.destination);
  if (audio.state === "suspended") await audio.resume();
  return {
    sampleRate: audio.sampleRate,
    chunks,
    close() {
      node?.disconnect();
      processor?.disconnect();
      source.disconnect();
      gain.disconnect();
      for (const track of stream.getTracks()) track.stop();
      audio.close().catch(() => {});
    },
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

// A field of a parsed reply; undefined unless the value is an object.
function fieldOf(value: unknown, key: string): unknown {
  return isRecord(value) ? value[key] : undefined;
}
