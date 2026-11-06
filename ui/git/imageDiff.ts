import { withToken } from "../launchToken.ts";

export const IMAGE_MIME: Record<string, string> = {
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  gif: "image/gif",
  webp: "image/webp",
  bmp: "image/bmp",
  svg: "image/svg+xml",
  avif: "image/avif",
  ico: "image/x-icon",
};

const ADDED = new Set(["a", "add", "added", "new", "create", "created", "untracked"]);
const REMOVED = new Set(["d", "delete", "deleted", "remove", "removed"]);

export interface ImageSides {
  before: boolean;
  after: boolean;
}

// seen is the latest blob pair, shown the one the preview urls carry.
export interface ImageRevState {
  seen: string;
  shown: string;
}

export interface PatchParts {
  header: string;
  body: string;
}

export function imageExtension(filePath: unknown): string {
  const name = String(filePath || "").replaceAll("\\", "/").split("/").pop() || "";
  const dot = name.lastIndexOf(".");
  if (dot <= 0) return "";
  const ext = name.slice(dot + 1).toLowerCase();
  return IMAGE_MIME[ext] ? ext : "";
}

// An added picture has no previous version. A deleted one has no working copy.
export function imageSides(file: { path?: unknown; type?: unknown } | null | undefined, patch: unknown): ImageSides | null {
  if (!imageExtension(file?.path)) return null;
  return sidesFromType(file?.type) || sidesFromPatch(patch) || { before: true, after: true };
}

export function imageRev(patch: unknown): string {
  const match = String(patch || "").match(/(?:^|\n)index ([0-9a-f]+)\.\.([0-9a-f]+)/i);
  if (!match) return "";
  return `${match[1]}..${match[2]}`;
}

// The first blob pair is the picture already on screen. A later pair means the file changed.
export function trackImageRev(state: ImageRevState | null | undefined, rev: unknown): ImageRevState {
  const next = String(rev || "");
  const current = state || { seen: "", shown: "" };
  if (!current.seen) return next ? { seen: next, shown: "" } : current;
  if (!next || next === current.seen) return current;
  return { seen: next, shown: next };
}

export function imageSrc(sessionId: unknown, filePath: unknown, side: unknown, stamp: unknown, base = "head"): string {
  const params = new URLSearchParams({
    sessionId: String(sessionId || ""),
    path: String(filePath || ""),
    side: side === "before" ? "before" : "after",
  });
  if (stamp) params.set("v", String(stamp));
  if (base === "main") params.set("base", base);
  return withToken(`/api/git/image?${params.toString()}`);
}

// The git preamble stays. The picture replaces the "Binary files" line under it.
export function patchParts(patch: unknown): PatchParts {
  if (typeof patch !== "string" || !patch) return { header: "", body: "" };
  const header: string[] = [];
  const body: string[] = [];
  let seenBody = false;
  for (const line of patch.split("\n")) {
    if (!seenBody && (line.startsWith("@@") || line.startsWith("Binary files ") || line.startsWith("GIT binary patch"))) {
      seenBody = true;
    }
    if (!seenBody) header.push(line);
    else if (!line.startsWith("Binary files ") && !line.startsWith("GIT binary patch")) body.push(line);
  }
  return { header: trimLines(header), body: trimLines(body) };
}

function trimLines(lines: string[]): string {
  while (lines.length && lines.at(-1) === "") lines.pop();
  return lines.join("\n");
}

function sidesFromType(type: unknown): ImageSides | null {
  const kind = String(type || "").toLowerCase();
  if (ADDED.has(kind)) return { before: false, after: true };
  if (REMOVED.has(kind)) return { before: true, after: false };
  return null;
}

function sidesFromPatch(patch: unknown): ImageSides | null {
  if (typeof patch !== "string" || !patch) return null;
  const added = /(?:^|\n)new file mode /.test(patch) || /Binary files \/dev\/null and b\//.test(patch);
  const removed = /(?:^|\n)deleted file mode /.test(patch) || /Binary files a\/[\s\S]* and \/dev\/null differ/.test(patch);
  if (added && !removed) return { before: false, after: true };
  if (removed && !added) return { before: true, after: false };
  if (/(?:^|\n)Binary files /.test(patch) || patch.includes("GIT binary patch")) return { before: true, after: true };
  return null;
}
