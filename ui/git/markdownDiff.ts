import { sessionFilePath } from "../chat/composer/mentions.ts";
import { withToken } from "../launchToken.ts";

export type ChunkChange = "same" | "added" | "changed" | "removed";

export interface MarkdownChunk {
  text: string;
  change: ChunkChange;
}

const FENCE = /^\s{0,3}(`{3,}|~{3,})(.*)$/;
const BLOCK_START = /^(#{1,6}\s|[-*+]\s|\d{1,9}[.)]\s)/;
const ORDERED_ITEM = /^(\d{1,9})[.)]\s/;

// A removed block pairs with the next block added in its place.
export function markdownChunks(patch: string | null | undefined): MarkdownChunk[] {
  const chunks: MarkdownChunk[] = [];
  const pending: string[] = [];
  let lines: string[] = [];
  let removed: string[] = [];
  let added = false;
  let kept = false;
  let fence = "";
  let gap = false;
  let started = false;
  // Each item renders as a list of its own, so it carries its running number.
  let next: number | null = null;

  function emitPending() {
    for (const text of pending.splice(0)) chunks.push({ text, change: "removed" });
  }

  function flush() {
    if (lines.length) {
      const replaces = !kept && !removed.length && pending.length > 0;
      if (replaces) pending.shift();
      else emitPending();
      chunks.push({ text: lines.join("\n"), change: replaces || removed.length ? "changed" : added ? "added" : "same" });
    } else if (removed.length) pending.push(removed.join("\n"));
    lines = [];
    removed = [];
    added = false;
    kept = false;
  }

  for (const line of String(patch || "").split("\n")) {
    if (line.startsWith("@@")) {
      started = true;
      continue;
    }
    if (!started || !line || line.startsWith("\\")) continue;
    const sign = line[0];
    let text = line.slice(1);
    if (!fence && !text.trim()) {
      gap = true;
      continue;
    }
    // Indented text after a blank line stays with the block above.
    const nested = /^\s/.test(text) && (lines.length > 0 || removed.length > 0);
    const starts = !fence && ((gap && !nested) || BLOCK_START.test(text));
    if (starts) flush();
    else if (gap) lines.push("");
    gap = false;
    if (sign === "-") {
      removed.push(text);
      continue;
    }
    const item = fence ? null : ORDERED_ITEM.exec(text);
    if (item) {
      next ??= Number(item[1]);
      text = text.replace(/^\d+/, String(next));
      next += 1;
    } else if (starts) next = null;
    lines.push(text);
    if (sign === "+") added = true;
    else kept = true;
    fence = fenceAfter(fence, text);
  }
  flush();
  emitPending();
  return chunks;
}

// A code block closes only on a fence of its own kind, at least as long.
function fenceAfter(fence: string, text: string): string {
  const match = FENCE.exec(text);
  if (!match?.[1]) return fence;
  if (!fence) return match[1];
  const closes = match[1][0] === fence[0] && match[1].length >= fence.length && !match[2]?.trim();
  return closes ? "" : fence;
}

// filePath is absolute, and href is resolved from its folder.
export function markdownImageSrc(sessionId: string, filePath: string, href: string): string {
  const folder = filePath.replace(/[/\\][^/\\]*$/, "");
  const params = new URLSearchParams({ sessionId, path: sessionFilePath(folder, href) });
  return withToken(`/api/file/image?${params.toString()}`);
}
