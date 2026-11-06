export const SAMPLE_RATE = 16000;
export const TAP_MS = 200;
export const MAX_TAKE_MS = 120_000;

const HOLD_KEYS = new Set(["Alt", "AltGraph"]);

// The parts of a focused element foreignField looks at.
export interface FieldLike {
  tagName: string;
  isContentEditable?: boolean;
}

export type VoiceKeyEvent = Pick<KeyboardEvent, "type" | "key" | "repeat" | "ctrlKey" | "metaKey" | "shiftKey">;

export interface VoiceKeyState {
  recording?: boolean;
  via?: "hold" | "button" | null;
  heldMs?: number;
  foreignField?: boolean;
  busy?: boolean;
}

export type VoiceAction = "cancel" | "abort" | "ignore" | "start" | "stop" | "discard";

export function downsample(
  samples: ArrayLike<number> | null | undefined,
  fromRate: number,
  toRate: number = SAMPLE_RATE,
): Float32Array {
  if (!samples?.length || fromRate === toRate) return samples instanceof Float32Array ? samples : Float32Array.from(samples || []);
  const ratio = fromRate / toRate;
  const length = Math.max(0, Math.floor(samples.length / ratio));
  const out = new Float32Array(length);
  for (let i = 0; i < length; i++) {
    const position = i * ratio;
    const index = Math.floor(position);
    const fraction = position - index;
    const left = samples[index] || 0;
    const right = samples[index + 1] ?? left;
    out[i] = left + (right - left) * fraction;
  }
  return out;
}

export function mergeFloats(chunks: readonly ArrayLike<number>[]): Float32Array {
  let length = 0;
  for (const chunk of chunks) length += chunk.length;
  const out = new Float32Array(length);
  let offset = 0;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.length;
  }
  return out;
}

export function encodeWav(samples: ArrayLike<number>, sampleRate: number = SAMPLE_RATE): ArrayBuffer {
  const buffer = new ArrayBuffer(44 + samples.length * 2);
  const view = new DataView(buffer);
  writeAscii(view, 0, "RIFF");
  view.setUint32(4, 36 + samples.length * 2, true);
  writeAscii(view, 8, "WAVE");
  writeAscii(view, 12, "fmt ");
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, 1, true);
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * 2, true);
  view.setUint16(32, 2, true);
  view.setUint16(34, 16, true);
  writeAscii(view, 36, "data");
  view.setUint32(40, samples.length * 2, true);
  let offset = 44;
  for (let i = 0; i < samples.length; i++) {
    const clamped = Math.max(-1, Math.min(1, samples[i] || 0));
    view.setInt16(offset, clamped < 0 ? clamped * 0x8000 : clamped * 0x7fff, true);
    offset += 2;
  }
  return buffer;
}

export function insertAtCursor(
  draft: string | null | undefined,
  cursor: number | null | undefined,
  text: string | null | undefined,
): { draft: string; cursor: number } {
  const clean = String(text || "").trim();
  const value = String(draft || "");
  if (!clean) return { draft: value, cursor: Math.max(0, Math.min(cursor || 0, value.length)) };
  const at = Math.max(0, Math.min(cursor ?? value.length, value.length));
  const before = value.slice(0, at);
  const gap = before.length && !/\s$/.test(before) ? " " : "";
  const next = before + gap + clean + value.slice(at);
  return { draft: next, cursor: before.length + gap.length + clean.length };
}

export function foreignField(active: FieldLike | null | undefined, composer: FieldLike | null | undefined): boolean {
  if (!active || active === composer) return false;
  const tag = active.tagName;
  if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT") return true;
  return Boolean(active.isContentEditable);
}

// Alt hold: start on press, stop on release, abort if another key joins the chord.
export function voiceKey(event: VoiceKeyEvent, state: VoiceKeyState = {}): VoiceAction {
  const recording = Boolean(state.recording);
  const hold = state.via === "hold";
  if (event.type === "keydown" && event.key === "Escape" && recording) return "cancel";
  if (event.type === "keydown" && recording && hold && !HOLD_KEYS.has(event.key) && !event.repeat) return "abort";
  if (!HOLD_KEYS.has(event.key)) return "ignore";
  if (event.type === "keyup" && recording && hold) return (state.heldMs || 0) < TAP_MS ? "discard" : "stop";
  if (event.repeat || event.ctrlKey || event.metaKey || event.shiftKey || state.foreignField || state.busy) return "ignore";
  if (event.type === "keydown") return recording ? "ignore" : "start";
  return "ignore";
}

function writeAscii(view: DataView, offset: number, text: string) {
  for (let i = 0; i < text.length; i++) view.setUint8(offset + i, text.charCodeAt(i));
}
