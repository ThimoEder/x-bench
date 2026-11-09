import { useEffect, useSyncExternalStore } from "react";
import type { TicketId } from "../../server/board/ticketId.ts";
import type { SidebarSession, TicketLinks } from "../../server/snapshot.ts";
import { apiFetch } from "../launchToken.ts";
import { NO_SETTINGS } from "../../server/board/boardSettings.ts";
import { arrangedBoard, boardSettings, boardView, isRecord, sameId, statusOf, taskDetail, withSettings } from "./boardData.ts";
import type { BoardColumn, BoardTask, BoardView } from "./boardData.ts";

// The boards ticket links read: one board load per folder, shared by every link to it. A ticket the load
// leaves out is read on its own.

export type BoardTicket =
  | { state: "loading" }
  | { state: "ready"; board: BoardView | null; task: BoardTask }
  | { state: "gone" }
  | { state: "failed" };

interface Folder {
  // The next load sends no activity stamp. A load on its way when this is set cannot undo it.
  full?: boolean;
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
let bound: string | null = null;
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
    const full = folder.full;
    folder.full = false;
    try {
      const params = new URLSearchParams({ cwd });
      if (folder.board && folder.activity && !full) params.set("activity", String(folder.activity));
      const data = await getJson(`/api/board/board?${params}`);
      if (isRecord(data) && data.unchanged) {
        // The settings can change while the board stays as it is.
        if (folder.board) folder.board = withSettings(folder.board, data.settings);
        return;
      }
      folder.board = boardView(data);
      folder.activity = folder.board?.activity ?? null;
      folder.failed = !folder.board;
    } catch {
      // A later load that fails keeps the last board.
      folder.failed = !folder.board;
      folder.full ||= full;
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

// Every kept board loads in full, for a change a source's activity stamp does not show, such as a column's color.
// A chat in a worktree keeps the same board under its own folder.
export function reloadKept(): void {
  for (const folder of folders.values()) folder.full = true;
  refresh();
}

export function keptBoard(cwd: string): BoardView | null {
  return folders.get(cwd)?.board ?? null;
}

export function keepBoard(cwd: string, board: BoardView): void {
  const folder = folders.get(cwd) ?? { board: null, failed: false, activity: null, stale: false, loading: null };
  Object.assign(folder, { board, failed: false, activity: board.activity ?? null });
  folders.set(cwd, folder);
  emit();
}

// Safe to call on every store change: it loads only what is missing or stale.
export async function need(cwd: string, taskId: TicketId): Promise<void> {
  const folder = folders.get(cwd);
  if (!folder || folder.stale || folder.loading) await loadBoard(cwd);
  if (folders.get(cwd)?.board?.tasks.some((task) => sameId(task.id, taskId))) return;
  const single = singles.get(String(taskId));
  if (!single || single.stale) await loadSingle(taskId);
}

const arranged = new WeakMap<BoardView, BoardView>();

// A kept board as its settings show it. The page keeps and reads the board as the host sent it.
function shown(board: BoardView | null): BoardView | null {
  if (!board) return null;
  const view = arranged.get(board) ?? arrangedBoard(board, boardSettings(board.settings) ?? NO_SETTINGS);
  arranged.set(board, view);
  return view;
}

export function ticketOf(cwd: string, taskId: TicketId): BoardTicket {
  const board = shown(folders.get(cwd)?.board ?? null);
  const task = board?.tasks.find((item) => sameId(item.id, taskId));
  if (task) return { state: "ready", board, task };
  const single = singles.get(String(taskId))?.ticket;
  if (single?.state === "ready") return { ...single, board };
  return single ?? { state: "loading" };
}

const NO_COLUMNS: BoardColumn[] = [];

// The columns of the folder's board, in its settings' order and colors. Empty until the board loads.
export function useBoardColumns(cwd: string): BoardColumn[] {
  const seen = useSyncExternalStore(subscribe, () => version);
  useEffect(() => {
    const folder = folders.get(cwd);
    if (!folder || folder.stale) void loadBoard(cwd);
  }, [cwd, seen]);
  return shown(folders.get(cwd)?.board ?? null)?.columns ?? NO_COLUMNS;
}

export function useBoardTicket(cwd: string, taskId: TicketId): BoardTicket {
  const seen = useSyncExternalStore(subscribe, () => version);
  useEffect(() => {
    void need(cwd, taskId);
  }, [cwd, taskId, seen]);
  return ticketOf(cwd, taskId);
}

// A board write through this host, counted in tickets.changes, reloads the boards links read. A folder that got or
// lost a board drops every kept board, since a folder can come back bound to another one.
export function noteSnapshot(tickets: TicketLinks | null, chats: SidebarSession[], working: string[]): void {
  linked = { tickets, chats, working };
  const boards = JSON.stringify(tickets?.boards ?? []);
  if (bound !== null && boards !== bound) {
    folders.clear();
    emit();
  }
  bound = boards;
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
