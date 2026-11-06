// Pictures and clips a ticket's text shows from the files the ticket keeps: ![alt](<url>) by the url its source
// gives the file, and, on a board that embeds by name, !shot.png! or !shot.png|width=300!. The ticket's file
// list says which file each one is, and whether it is a clip.

import { withToken } from "../launchToken.ts";
import { isRecord } from "./boardData.ts";

export interface TicketFile {
  id: unknown;
  name: unknown;
  url: unknown;
  type: unknown;
}

const NAMED = /!([^!\n|]+?\.(?:png|jpe?g|gif|webp|bmp|avif|mp4|m4v|mov|webm))(?:\|[^!\n]*)?!/gi;
const BY_URL = /!\[[^\]\n]*\]\(([^\s)]+)\)/g;

export function fileRefs(text: string, byName: boolean): string[] {
  return [...(byName ? text.matchAll(NAMED) : []), ...text.matchAll(BY_URL)].map((match) => match[1] ?? "");
}

// While files is null, every name and address points at pendingFile until the list arrives. Then a name or
// address the ticket has no file for stays as written.
export function embedFiles(text: string, taskId: unknown, files: readonly TicketFile[] | null, byName: boolean): string {
  const route = (file: TicketFile | undefined) => (files ? file && embedRoute(taskId, file) : pendingFile(taskId));
  const linked = text.replace(BY_URL, (whole, url: string) => {
    const to = route(files?.find((item) => item.url === url));
    return to ? `${whole.slice(0, -url.length - 1)}${to})` : whole;
  });
  if (!byName) return linked;
  return linked.replace(NAMED, (whole, name: string) => {
    const to = route(files?.find((item) => item.name === name));
    return to ? `![${name.replace(/[[\]]/g, "")}](${to})` : whole;
  });
}

// No source names a file "pending": theirs are numbers or 24 hex characters.
export function pendingFile(taskId: unknown): string {
  return fileRoute(taskId, "pending");
}

export function ticketFiles(data: unknown): TicketFile[] {
  return isRecord(data) && Array.isArray(data.files) ? data.files.filter(isRecord).map((file) => ({ id: file.id, name: file.name, url: file.url, type: file.content_type })) : [];
}

// null for a path that is no clip of a ticket.
export function ticketVideoSrc(filePath: string): string | null {
  return /^\/api\/board\/tasks\/[A-Za-z0-9_-]+\/files\/[A-Za-z0-9_-]+\.(?:mp4|mov|webm)$/.test(filePath) ? withToken(filePath) : null;
}

// null for a path that is no ticket file.
export function ticketImageSrc(filePath: string): string | null {
  return /^\/api\/board\/tasks\/[A-Za-z0-9_-]+\/files\/[A-Za-z0-9_-]+$/.test(filePath) ? withToken(filePath) : null;
}

// A clip's route ends in a video extension, so the Markdown parser plays it. The board API ignores the extension.
function embedRoute(taskId: unknown, file: TicketFile): string {
  const route = fileRoute(taskId, file.id);
  const type = String(file.type ?? "");
  if (!type.startsWith("video/")) return route;
  return `${route}.${type === "video/webm" ? "webm" : type === "video/quicktime" ? "mov" : "mp4"}`;
}

function fileRoute(taskId: unknown, fileId: unknown): string {
  return `/api/board/tasks/${encodeURIComponent(String(taskId))}/files/${encodeURIComponent(String(fileId))}`;
}
