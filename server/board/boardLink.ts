import { ticketId, type TicketId } from "./ticketId.ts";

// The board a link opens: a folder and maybe a ticket on it, or nothing.
export type BoardTarget = { cwd: string; taskId: TicketId | null } | { cwd: null; taskId: null };

export function boardSearch({ cwd, taskId }: { cwd?: unknown; taskId?: unknown } = {}): string {
  const folder = String(cwd || "");
  if (!folder) return "";
  const params = new URLSearchParams();
  params.set("cwd", folder);
  const id = ticketId(taskId);
  if (id !== null) params.set("task", String(id));
  return `?${params.toString()}`;
}

export function boardHref(origin: unknown, cwd: unknown, taskId: unknown): string {
  const home = String(origin || "").replace(/\/$/, "");
  const search = boardSearch({ cwd, taskId });
  if (!search) return home ? `${home}/` : "/";
  return `${home}/${search}`;
}

export function boardTarget(search: unknown): BoardTarget {
  const params = new URLSearchParams(String(search || "").replace(/^\?/, ""));
  const cwd = params.get("cwd") || "";
  const taskId = ticketId(params.get("task"));
  if (!cwd) return { cwd: null, taskId: null };
  return { cwd, taskId };
}

// The ticket link an agent writes without the host or folder: [#<id>](?task=<id>).
export function isShortTicketHref(href: string): boolean {
  const id = /^\?task=([^&\s]+)$/.exec(href)?.[1];
  return id !== undefined && ticketId(id) !== null;
}

// A short ticket link points to the board of the chat's folder.
export function chatBoardHref(href: string, origin: string, cwd: string | undefined): string {
  if (!cwd || !isShortTicketHref(href)) return href;
  return boardHref(origin, cwd, new URLSearchParams(href).get("task"));
}

// The installed app's port, whose board links a dev window opens too.
const APP_PORT = "8797";

// The board a link in a chat points to: an X Bench page on this window's origin, or on a local host at this
// window's port or the installed app's.
export function localBoardTarget(href: unknown, origin: string): BoardTarget {
  let url: URL;
  try {
    url = new URL(String(href));
  } catch {
    return { cwd: null, taskId: null };
  }
  const here = new URL(origin);
  const local = url.hostname === "127.0.0.1" || url.hostname === "localhost" || url.hostname === "[::1]";
  const port = url.port === APP_PORT || url.port === here.port;
  if (!((local && port) || url.origin === here.origin) || url.pathname !== "/") return { cwd: null, taskId: null };
  return boardTarget(url.search);
}
