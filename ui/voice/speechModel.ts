import { useSyncExternalStore } from "react";
import type { VoiceStatus } from "../../server/voice/voice.ts";
import { apiFetch } from "../launchToken.ts";

export interface SpeechModelView {
  // Null until the page first asks the host.
  status: VoiceStatus | null;
  open: boolean;
  // A request the host refused, such as Remove while the model is in use.
  note: string;
}

const POLL_MS = 500;

let view: SpeechModelView = { status: null, open: false, note: "" };
// Set while the open overlay shows a download, so it closes once the model is ready.
let watching = false;
let timer: ReturnType<typeof setTimeout> | 0 = 0;
const listeners = new Set<() => void>();

function update(next: Partial<SpeechModelView>) {
  view = { ...view, ...next };
  for (const listener of listeners) listener();
}

export function speechBusy(status: VoiceStatus | null): boolean {
  return status?.state === "downloading" || status?.state === "unpacking" || status?.state === "loading";
}

function take(status: VoiceStatus) {
  if (view.open && speechBusy(status)) watching = true;
  const done = watching && status.state === "ready";
  if (done || !speechBusy(status)) watching = false;
  update(done ? { status, open: false, note: "" } : { status });
  schedule();
}

// Polls while the overlay is open or the model is on its way, so the mic button can show the download.
function schedule() {
  clearTimeout(timer);
  timer = 0;
  if (view.open || speechBusy(view.status)) timer = setTimeout(() => void refreshSpeechModel().catch(() => schedule()), POLL_MS);
}

export async function refreshSpeechModel(): Promise<VoiceStatus> {
  const response = await apiFetch("/api/voice");
  if (!response.ok) throw new Error("The speech model status could not be read");
  const status = (await response.json()) as VoiceStatus;
  take(status);
  return status;
}

export function openSpeechModel() {
  update({ open: true, note: "" });
  refreshSpeechModel().catch(() => schedule());
}

export function closeSpeechModel() {
  watching = false;
  update({ open: false, note: "" });
  schedule();
}

export async function speechModelAction(action: "download" | "cancel" | "remove") {
  update({ note: "" });
  try {
    const response = await apiFetch(action === "remove" ? "/api/voice" : `/api/voice/${action}`, {
      method: action === "remove" ? "DELETE" : "POST",
      headers: { "content-type": "application/json" },
      body: "{}",
    });
    const data = (await response.json().catch(() => ({}))) as { error?: string };
    if (!response.ok) update({ note: data.error || "The speech model could not be changed" });
  } catch {
    update({ note: "The host did not answer" });
  }
  await refreshSpeechModel().catch(() => schedule());
}

function subscribe(listener: () => void) {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

export function useSpeechModel(): SpeechModelView {
  return useSyncExternalStore(subscribe, () => view);
}

export function formatMegabytes(bytes: number): string {
  return `${Math.round(bytes / 1e6)} MB`;
}
