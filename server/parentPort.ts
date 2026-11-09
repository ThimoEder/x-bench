// When the Electron app runs the host in a utilityProcess (ticket 87),
// process.parentPort talks to the app's main process. Under `npm run dev` it
// is undefined and none of this runs.
import { isRecord } from "../bridge/lenient.ts";

export type ParentPort = {
  postMessage(message: unknown): void;
  on(event: "message", listener: (message: { data: unknown }) => void): void;
};

export function isParentPort(value: unknown): value is ParentPort {
  return isRecord(value) && typeof value.postMessage === "function" && typeof value.on === "function";
}

// The app sends { type: "stop" } when it quits.
export function isStopMessage(data: unknown): boolean {
  return isRecord(data) && data.type === "stop";
}

// The host sends this once it listens, so the app can open its window.
export function listeningMessage(port: number) {
  return { type: "listening", port };
}

// The host sends this each time it starts Grok, and with running false once
// that Grok has exited. Grok runs in its own process group, so if the host dies
// without its shutdown(), the app stops the groups still running.
export function grokMessage(pid: number, running: boolean) {
  return { type: "grok", pid, running };
}

// The same for the SAK server the host starts. It also runs in its own process
// group, and a host that crashes would leave it running.
export function sakMessage(pid: number, running: boolean) {
  return { type: "sak", pid, running };
}

// A routine run that ended, waits for the person, or did not start. The app shows it as a notification.
export function notifyMessage(note: { title: string; body: string; sessionId?: string }) {
  return { type: "notify", ...note };
}

// Whether the app should keep the Mac awake (settings.json).
export function keepAwakeMessage(on: boolean) {
  return { type: "keep-awake", on };
}

// The app sends { type: "open-session", sessionId } when a routine's notification is clicked.
export function openSessionOf(data: unknown): string | null {
  return isRecord(data) && data.type === "open-session" && typeof data.sessionId === "string" && data.sessionId ? data.sessionId : null;
}

// The app's first message, which the host waits for before it starts.
export type StartMessage = { key: string | null; dev: boolean; shellEnv: Record<string, string> };

export function startOf(data: unknown): StartMessage | undefined {
  if (!isRecord(data) || data.type !== "start") return undefined;
  const shellEnv = isRecord(data.shellEnv) ? Object.fromEntries(Object.entries(data.shellEnv).filter((entry): entry is [string, string] => typeof entry[1] === "string")) : {};
  return { key: typeof data.key === "string" ? data.key : null, dev: data.dev === true, shellEnv };
}
