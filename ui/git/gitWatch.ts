// The open review pane polls git. A turn edits files without changing session status,
// and a patch can change while its add and delete counts stay the same.

import { remotePage } from "../launchToken.ts";

export interface ReviewUpdate {
  snapshot: string;
  info: unknown;
  refresh: Record<string, unknown> | null;
  clear: boolean;
}

export function reviewWatchMs(running: boolean): number {
  return running ? 2000 : 5000;
}

// The open review pane on a page through remote access, where every check is a request through the tunnel.
export function remoteReviewWatchMs(running: boolean): number {
  return running ? 10_000 : 30_000;
}

// Repeats a git check every localMs, or every remoteMs on a page through remote access, where null means
// never. It skips the check while the page is hidden and checks once when the page shows again.
// Returns the cleanup.
export function watchGit(load: () => void, localMs: number, remoteMs: number | null, remote = remotePage()): () => void {
  const everyMs = remote ? remoteMs : localMs;
  const timer = everyMs === null ? undefined : setInterval(() => {
    if (document.visibilityState !== "hidden") load();
  }, everyMs);
  const onVisibility = () => {
    if (document.visibilityState === "visible") load();
  };
  document.addEventListener("visibilitychange", onVisibility);
  return () => {
    clearInterval(timer);
    document.removeEventListener("visibilitychange", onVisibility);
  };
}

export function gitSnapshot(info: unknown): string {
  const files = filesOf(info);
  return [
    isRecord(info) ? info.branch || "" : "",
    isRecord(info) ? info.commit || "" : "",
    isRecord(info) ? info.error || "" : "",
    ...files.map((file) => `${file.path}\0${file.type || ""}\0${file.additions || 0}\0${file.deletions || 0}`),
  ].join("\n");
}

export function reviewUpdate(previousSnapshot: string, data: unknown, selectedPath: string): ReviewUpdate {
  const snapshot = gitSnapshot(data);
  const file = selectedPath ? filesOf(data).find((item) => item.path === selectedPath) || null : null;
  return {
    snapshot,
    info: snapshot === previousSnapshot ? null : data,
    refresh: file,
    clear: Boolean(selectedPath) && !file,
  };
}

// A files field that is not a list, and rows that are not objects, read as missing.
function filesOf(info: unknown): Record<string, unknown>[] {
  if (!isRecord(info) || !Array.isArray(info.files)) return [];
  const files: unknown[] = info.files;
  return files.filter(isRecord);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
