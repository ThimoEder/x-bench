import { useEffect, useSyncExternalStore } from "react";
import type { TicketId } from "../../server/board/ticketId.ts";
import type { SidebarSession, TicketLinks } from "../../server/snapshot.ts";
import { apiFetch } from "../launchToken.ts";
import { boardView, isRecord, sameId, statusOf, taskDetail } from "./boardData.ts";
import type { BoardTask, BoardView } from "./boardData.ts";

// The boards ticket links read: one board load per folder, shared by every link to it. A ticket the load
// leaves out is read on its own.

export type BoardTicket =
  | { state: "loading" }
  | { state: "ready"; board: BoardView | null; task: BoardTask }
  | { state: "gone" }
  | { state: "failed" };

interface Folder {
  board: BoardView | null;
  failed: boolean;
  activity: unknown;
  stale: boolean;
  loading: Promise<void> | null;
}

interface Single {
  ticket: BoardTicket;
  stale: boolean;
  loading: Promise<void> | null;
}

const folders = new Map<string, Folder>();
const singles = new Map<string, Single>();
const listeners = new Set<() => void>();
let version = 0;
let changes: number | null = null;
let linked: { tickets: TicketLinks | null; chats: SidebarSession[]; working: string[] } = { tickets: null, chats: [], working: [] };

function emit() {
  version += 1;
  for (const listener of listeners) listener();
}

function subscribe(listener: () => void) {
  if (!listeners.size) window.addEventListener("focus", refresh);
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
    if (!listeners.size) window.removeEventListener("focus", refresh);
  };
}

// Later reads load again. Links on screen reload now and keep showing what they had meanwhile.
function refresh() {
  for (const folder of folders.values()) folder.stale = true;
  for (const single of singles.values()) single.stale = true;
  emit();
}

async function getJson(path: string): Promise<unknown> {
  const response = await apiFetch(path);
  const data: unknown = await response.json().catch(() => null);
  if (!response.ok) throw Object.assign(new Error("Request failed"), { status: response.status });
  return data;
}

function loadBoard(cwd: string): Promise<void> {
  const folder = folders.get(cwd) ?? { board: null, failed: false, activity: null, stale: false, loading: null };
  folders.set(cwd, folder);
  folder.loading ??= (async () => {
    // Cleared before the request, so a board write while it runs keeps the folder stale.
    folder.stale = false;
    try {
      const params = new URLSearchParams({ cwd });
      if (folder.board && folder.activity) params.set("activity", String(folder.activity));
      const data = await getJson(`/api/board/board?${params}`);
      if (isRecord(data) && data.unchanged) return;
      folder.board = boardView(data);
      folder.activity = folder.board?.activity ?? null;
      folder.failed = !folder.board;
    } catch {
      // A later load that fails keeps the last board.
      folder.failed = !folder.board;
    } finally {
      folder.loading = null;
      emit();
    }
  })();
  return folder.loading;
}

function loadSingle(taskId: TicketId): Promise<void> {
  const key = String(taskId);
  const single: Single = singles.get(key) ?? { ticket: { state: "loading" }, stale: false, loading: null };
  singles.set(key, single);
  single.loading ??= (async () => {
    single.stale = false;
    try {
      const task = taskDetail(await getJson(`/api/board/tasks/${encodeURIComponent(key)}`))?.task;
      single.ticket = task ? { state: "ready", board: null, task } : { state: "failed" };
    } catch (error) {
      if (statusOf(error) === 404) single.ticket = { state: "gone" };
      else if (single.ticket.state === "loading") single.ticket = { state: "failed" };
    } finally {
      single.loading = null;
      emit();
    }
  })();
  return single.loading;
}

// Safe to call on every store change: it loads only what is missing or stale.
export async function need(cwd: string, taskId: TicketId): Promise<void> {
  const folder = folders.get(cwd);
  if (!folder || folder.stale || folder.loading) await loadBoard(cwd);
  if (folders.get(cwd)?.board?.tasks.some((task) => sameId(task.id, taskId))) return;
  const single = singles.get(String(taskId));
  if (!single || single.stale) await loadSingle(taskId);
}

export function ticketOf(cwd: string, taskId: TicketId): BoardTicket {
  const board = folders.get(cwd)?.board ?? null;
  const task = board?.tasks.find((item) => sameId(item.id, taskId));
  if (task) return { state: "ready", board, task };
  const single = singles.get(String(taskId))?.ticket;
  if (single?.state === "ready") return { ...single, board };
  return single ?? { state: "loading" };
}

export function useBoardTicket(cwd: string, taskId: TicketId): BoardTicket {
  const seen = useSyncExternalStore(subscribe, () => version);
  useEffect(() => {
    void need(cwd, taskId);
  }, [cwd, taskId, seen]);
  return ticketOf(cwd, taskId);
}

// A board write through this host, counted in tickets.changes, reloads the boards links read.
export function noteSnapshot(tickets: TicketLinks | null, chats: SidebarSession[], working: string[]): void {
  linked = { tickets, chats, working };
  const next = tickets?.changes ?? 0;
  if (changes !== null && next !== changes) refresh();
  changes = next;
}

export function linkedChats(taskId: unknown): { id: string; title: string; running: boolean }[] {
  return Object.entries(linked.tickets?.bySession || {}).flatMap(([sessionId, links]) => {
    if (!links?.some((link) => sameId(link.taskId, taskId))) return [];
    const chat = linked.chats.find((item) => item.id === sessionId);
    return chat ? [{ id: sessionId, title: chat.title, running: linked.working.includes(sessionId) }] : [];
  });
}
