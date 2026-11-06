import { useSyncExternalStore } from "react";
import { apiFetch } from "../launchToken.ts";

// Dictation's preferences for this window, both on until turned off in Settings: dictation itself, and
// turning the Mac's volume down while it records, to the share of it chosen in Settings.
export type DictationSetting = "dictation" | "lowerVolume";

const KEYS: Record<DictationSetting, string> = {
  dictation: "x-bench-dictation",
  lowerVolume: "x-bench-dictation-lower-volume",
};
// The choices made on this page, which hold when storage cannot keep them.
const chosen = new Map<DictationSetting, boolean>();
let chosenLevel: number | null = null;
// Every useDictationSetting and useQuietLevel on the page, so Settings and the composers agree.
const listeners = new Set<() => void>();

export function readDictationSetting(setting: DictationSetting): boolean {
  const made = chosen.get(setting);
  if (made !== undefined) return made;
  try {
    return localStorage.getItem(KEYS[setting]) !== "off";
  } catch {
    return true;
  }
}

function chooseDictationSetting(setting: DictationSetting, on: boolean) {
  chosen.set(setting, on);
  try {
    localStorage.setItem(KEYS[setting], on ? "on" : "off");
  } catch {
    // Kept for this page only.
  }
  for (const listener of listeners) listener();
}

function subscribe(listener: () => void) {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

const QUIET_LEVEL_KEY = "x-bench-dictation-quiet-level";
export const QUIET_LEVELS = { min: 0, max: 80, step: 5, initial: 20 };

// The percent of the Mac's volume a take keeps.
export function readQuietLevel(): number {
  if (chosenLevel !== null) return chosenLevel;
  try {
    const stored = Number(localStorage.getItem(QUIET_LEVEL_KEY) ?? NaN);
    return Number.isFinite(stored) ? Math.min(QUIET_LEVELS.max, Math.max(QUIET_LEVELS.min, stored)) : QUIET_LEVELS.initial;
  } catch {
    return QUIET_LEVELS.initial;
  }
}

function chooseQuietLevel(percent: number) {
  chosenLevel = percent;
  try {
    localStorage.setItem(QUIET_LEVEL_KEY, String(percent));
  } catch {
    // Kept for this page only.
  }
  for (const listener of listeners) listener();
}

export function useQuietLevel(): [number, (percent: number) => void] {
  return [useSyncExternalStore(subscribe, readQuietLevel), chooseQuietLevel];
}

export function useDictationSetting(setting: DictationSetting): [boolean, (on: boolean) => void] {
  const on = useSyncExternalStore(subscribe, () => readDictationSetting(setting));
  return [on, (next: boolean) => chooseDictationSetting(setting, next)];
}

// Tells the host a take started (quiet) or ended. The host ignores a lower that arrives after its take ended,
// so the requests go at once, and keepalive lets a restore finish while the page closes.
export function quietVolume(quiet: boolean, take: string) {
  const body = quiet ? { quiet, take, level: readQuietLevel() / 100 } : { quiet, take };
  apiFetch("/api/quiet-volume", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body), keepalive: true }).catch(() => {});
}
