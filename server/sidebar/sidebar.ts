import path from "node:path";
import { z } from "zod";
import type { CatalogEntry } from "../../bridge/protocol.ts";
import { fields } from "../../bridge/lenient.ts";
import { loadDurable, saveDurable, unreadable } from "../jsonFile.ts";
import { canonicalCwd, type SessionIndexRow } from "../chat/sessions.ts";
import { appWorktreeOf } from "../git/worktree.ts";
import type { SidebarProject, SidebarSession } from "../snapshot.ts";

// A project as sidebar.json stores it. A project found in the latest pass has no collapsed yet.
export interface StoredProject {
  cwd: string;
  name: string;
  collapsed?: boolean;
}

// A folder of chats inside one project, cwd being the project's.
export interface StoredFolder {
  id: string;
  cwd: string;
  name: string;
  collapsed?: boolean;
}

export interface SidebarState {
  projects: StoredProject[];
  archived: string[];
  // Pinned chats in the order they show at the top of their list, the latest pin first.
  pinned: string[];
  hidden: string[];
  chatIds: string[];
  promptedAt: Record<string, string>;
  seenAt: Record<string, string>;
  titles: Record<string, string>;
  folders: StoredFolder[];
  // Session id to the id of the folder it sits in.
  inFolder: Record<string, string>;
}

export interface ArrangedSidebar {
  projects: SidebarProject[];
  state: SidebarState;
  changed: boolean;
}

// createProjectLocator in projectHome.ts: the project a folder belongs to, or just its home folder.
type ProjectLocator = (cwd: string) => string | { home?: string | null; worktree?: string | null } | null | undefined;

interface Placement {
  home: string;
  worktree: string | null;
}

type Place = (cwd: string) => Placement;

// The catalog fields used here. session_kind is the spelling Grok sends on the wire.
type CatalogRow = Partial<Pick<CatalogEntry, "sessionId" | "title" | "cwd" | "sessionKind">> & {
  session_kind?: unknown;
  provider?: string;
};

// Missing or falsy reads as an empty list. Any other value that is not a list
// fails the sidebar schema. readSidebar then keeps the file and returns an empty sidebar.
const Empty = z
  .unknown()
  .refine((value) => !value)
  .optional()
  .transform(() => []);

const Ids = z
  .union([z.array(z.unknown()), Empty])
  .transform((list: unknown[]) => [...new Set(list.filter((id): id is string => typeof id === "string" && id !== ""))]);

const Stamps = z.unknown().optional().transform(stringMap);

// The fields stay unknown: they are coerced with String and Boolean below.
const StoredProjectFields = fields({
  cwd: z.unknown().optional(),
  name: z.unknown().optional(),
  collapsed: z.unknown().optional(),
});

// A string iterates to characters, and no character has a cwd.
const Projects = z.union([z.array(StoredProjectFields), z.string().transform(() => []), Empty]);

const StoredFolderFields = fields({
  id: z.unknown().optional(),
  cwd: z.unknown().optional(),
  name: z.unknown().optional(),
  collapsed: z.unknown().optional(),
});

const Folders = z.union([z.array(StoredFolderFields), z.string().transform(() => []), Empty]);

// sidebar.json. A file that is not an object reads as an empty sidebar.
const SidebarFile = z
  .looseObject({
    projects: Projects,
    archived: Ids,
    pinned: Ids,
    hidden: Ids,
    chatIds: Ids,
    promptedAt: Stamps,
    seenAt: Stamps,
    titles: Stamps,
    folders: Folders,
    inFolder: Stamps,
  })
  .transform((source): SidebarState => {
    const projects: StoredProject[] = [];
    const seen = new Set<string>();
    for (const project of source.projects) {
      const cwd = String(project.cwd || "");
      if (!cwd || seen.has(cwd)) continue;
      seen.add(cwd);
      projects.push({
        cwd,
        name: String(project.name || path.basename(cwd) || cwd),
        collapsed: Boolean(project.collapsed),
      });
    }
    const folders: StoredFolder[] = [];
    for (const folder of source.folders) {
      const id = typeof folder.id === "string" ? folder.id : "";
      const cwd = typeof folder.cwd === "string" ? folder.cwd : "";
      const name = cleanTitle(folder.name);
      if (!id || !cwd || !name || folders.some((other) => other.id === id)) continue;
      folders.push({ id, cwd, name, collapsed: Boolean(folder.collapsed) });
    }
    const known = new Set(folders.map((folder) => folder.id));
    const inFolder = Object.fromEntries(Object.entries(source.inFolder).filter(([, id]) => known.has(id)));
    return {
      projects,
      archived: source.archived,
      pinned: source.pinned,
      hidden: source.hidden,
      chatIds: source.chatIds,
      promptedAt: source.promptedAt,
      seenAt: source.seenAt,
      titles: source.titles,
      folders,
      inFolder,
    };
  });

export function emptySidebar(): SidebarState {
  return { projects: [], archived: [], pinned: [], hidden: [], chatIds: [], promptedAt: {}, seenAt: {}, titles: {}, folders: [], inFolder: {} };
}

export function readSidebar(file: string): SidebarState {
  return loadDurable(file, parseSidebar, emptySidebar());
}

export function writeSidebar(state: SidebarState, file: string): void {
  saveDurable(file, `${JSON.stringify(normalizeSidebar(state), null, 2)}\n`, parseSidebar);
}

// The sidebar as sidebar.json has it now, so a change another host saved is kept, and a file
// that reads again after it did not is taken back. While it does not read, the state in memory stays.
export function currentSidebar(state: SidebarState, file: string): SidebarState {
  const stored = readSidebar(file);
  return unreadable(file) ? state : stored;
}

function parseSidebar(value: unknown): SidebarState | null {
  const parsed = SidebarFile.safeParse(value);
  return parsed.success ? parsed.data : null;
}

export function notePrompt(state: SidebarState, sessionId: string, at?: string): SidebarState {
  if (!sessionId) return state;
  return { ...unarchiveSession(state, sessionId), promptedAt: { ...state.promptedAt, [sessionId]: at || new Date().toISOString() } };
}

export function noteChat(state: SidebarState, sessionId: string): SidebarState {
  if (!sessionId) return state;
  const ids = state.chatIds;
  if (ids.includes(sessionId)) return state;
  return { ...state, chatIds: [...ids, sessionId] };
}

export function archiveSession(state: SidebarState, sessionId: string): SidebarState {
  if (!sessionId || state.archived.includes(sessionId)) return state;
  return { ...unpinSession(state, sessionId), archived: [...state.archived, sessionId] };
}

export function unarchiveSession(state: SidebarState, sessionId: string): SidebarState {
  if (!sessionId || !state.archived.includes(sessionId)) return state;
  return { ...state, archived: state.archived.filter((id) => id !== sessionId) };
}

export function pinSession(state: SidebarState, sessionId: string): SidebarState {
  if (!sessionId || state.pinned.includes(sessionId)) return state;
  return { ...state, pinned: [sessionId, ...state.pinned] };
}

export function unpinSession(state: SidebarState, sessionId: string): SidebarState {
  if (!sessionId || !state.pinned.includes(sessionId)) return state;
  return { ...state, pinned: state.pinned.filter((id) => id !== sessionId) };
}

export function dropSession(state: SidebarState, sessionId: string): SidebarState {
  if (!sessionId) return state;
  const promptedAt = { ...state.promptedAt };
  const seenAt = { ...state.seenAt };
  const titles: Record<string, string> = { ...state.titles };
  const inFolder = { ...state.inFolder };
  delete promptedAt[sessionId];
  delete seenAt[sessionId];
  delete titles[sessionId];
  delete inFolder[sessionId];
  return {
    ...state,
    archived: state.archived.filter((id) => id !== sessionId),
    pinned: state.pinned.filter((id) => id !== sessionId),
    chatIds: state.chatIds.filter((id) => id !== sessionId),
    promptedAt,
    seenAt,
    titles,
    inFolder,
  };
}

export function renameSession(state: SidebarState, sessionId: string, title: unknown): SidebarState {
  const name = cleanTitle(title);
  if (!sessionId || !name) return state;
  return { ...state, titles: { ...state.titles, [sessionId]: name } };
}

export function nameUntitled(state: SidebarState, sessionId: string, title: unknown): SidebarState {
  return state.titles[sessionId] ? state : renameSession(state, sessionId, title);
}

// The project's folder with this name, compared without case.
export function folderNamed(state: SidebarState, cwd: string, name: string): StoredFolder | undefined {
  const wanted = cleanTitle(name).toLowerCase();
  return state.folders.find((folder) => folder.cwd === cwd && folder.name.toLowerCase() === wanted);
}

export function addFolder(state: SidebarState, cwd: string, name: string, id: string): SidebarState {
  const clean = cleanTitle(name);
  if (!cwd || !clean || !id || state.folders.some((folder) => folder.id === id)) return state;
  return { ...state, folders: [...state.folders, { id, cwd, name: clean, collapsed: false }] };
}

// A name another folder of the project has already leaves the folder as it is.
export function renameFolder(state: SidebarState, id: string, name: string): SidebarState {
  const clean = cleanTitle(name);
  const folder = state.folders.find((item) => item.id === id);
  const taken = folder && folderNamed(state, folder.cwd, clean);
  if (!clean || (taken && taken.id !== id)) return state;
  return { ...state, folders: state.folders.map((folder) => (folder.id === id ? { ...folder, name: clean } : folder)) };
}

export function setFolderCollapsed(state: SidebarState, id: string, collapsed: boolean): SidebarState {
  return { ...state, folders: state.folders.map((folder) => (folder.id === id ? { ...folder, collapsed: Boolean(collapsed) } : folder)) };
}

export function removeFolder(state: SidebarState, id: string): SidebarState {
  return {
    ...state,
    folders: state.folders.filter((folder) => folder.id !== id),
    inFolder: Object.fromEntries(Object.entries(state.inFolder).filter(([, folder]) => folder !== id)),
  };
}

// A null folder takes the chats out of their folders. An unknown folder leaves the state alone.
export function moveToFolder(state: SidebarState, sessionIds: readonly string[], folderId: string | null): SidebarState {
  if (folderId !== null && !state.folders.some((folder) => folder.id === folderId)) return state;
  const inFolder = { ...state.inFolder };
  for (const id of sessionIds) {
    if (!id) continue;
    if (folderId) inFolder[id] = folderId;
    else delete inFolder[id];
  }
  return { ...state, inFolder };
}

export function applyTitles<Row extends { id: string; title: string }>(rows: readonly Row[], state: SidebarState): Row[] {
  const titles: Record<string, string> = state.titles;
  return rows.map((row) => (titles[row.id] ? { ...row, title: titles[row.id] } : row));
}

export function cleanTitle(title: unknown): string {
  return String(title || "").trim().replace(/\s+/g, " ").slice(0, 80);
}

export function removeProject(state: SidebarState, cwd: string): SidebarState {
  if (!cwd) return state;
  return {
    ...state,
    projects: state.projects.filter((project) => project.cwd !== cwd),
    hidden: state.hidden.includes(cwd) ? state.hidden : [...state.hidden, cwd],
  };
}

export function showProject(state: SidebarState, cwd: string): SidebarState {
  if (!cwd || !state.hidden.includes(cwd)) return state;
  return { ...state, hidden: state.hidden.filter((item) => item !== cwd) };
}

export function setProjectCollapsed(state: SidebarState, cwd: string, collapsed: boolean): SidebarState {
  return {
    ...state,
    projects: state.projects.map((project) => (project.cwd === cwd ? { ...project, collapsed: Boolean(collapsed) } : project)),
  };
}

export function reorderProjects(state: SidebarState, cwdList: readonly string[]): SidebarState {
  const byCwd = new Map(state.projects.map((project) => [project.cwd, project]));
  const next: StoredProject[] = [];
  for (const cwd of cwdList) {
    const project = byCwd.get(cwd);
    if (!project) continue;
    next.push(project);
    byCwd.delete(cwd);
  }
  for (const project of byCwd.values()) next.push(project);
  return { ...state, projects: next };
}

export function arrangeSidebar(
  rows: readonly SessionIndexRow[],
  state: SidebarState,
  chatHome = "",
  locate: ProjectLocator | null = null,
  worktreeRoot = "",
): ArrangedSidebar {
  const next = normalizeSidebar(state);
  const home = chatHome ? canonicalCwd(chatHome) : "";
  let changed = false;
  if (home) {
    const withoutHome = next.projects.filter((project) => canonicalCwd(project.cwd) !== home);
    if (withoutHome.length !== next.projects.length) {
      next.projects = withoutHome;
      changed = true;
    }
  }
  const place = placementFor(rows, locate);
  const groups = new Map<string, SidebarSession[]>();
  for (const row of rows) {
    if (!row.cwd) continue;
    const placed = place(row.cwd);
    if (!placed.home) continue;
    const list = groups.get(placed.home) || [];
    list.push(placed.worktree ? { ...row, worktree: placed.worktree } : row);
    groups.set(placed.home, list);
    if (!next.seenAt[row.id] && row.updatedAt) {
      next.seenAt[row.id] = row.updatedAt;
      changed = true;
    }
  }
  // A project shows up once this app has started a chat there. CLI sessions for that folder still list.
  const hidden = new Set(next.hidden);
  const chatIds = new Set(next.chatIds);
  const qualifies = (key: string) => {
    if (!key || (home && key === home) || hidden.has(key)) return false;
    const sessions = groups.get(key) || [];
    const prompted = sessions.some((session) => next.promptedAt[session.id]);
    const listed = sessions.some((session) => !chatIds.has(session.id));
    return prompted && listed;
  };
  const storedHome = new Map<string, StoredProject>();
  for (const project of next.projects) {
    const key = place(project.cwd).home;
    if (!key) continue;
    const current = storedHome.get(key);
    if (!current || project.cwd === key) storedHome.set(key, project);
  }
  const kept: StoredProject[] = [];
  const seen = new Set<string>();
  for (const project of next.projects) {
    const key = place(project.cwd).home;
    if (!key || seen.has(key)) continue;
    seen.add(key);
    if (!qualifies(key)) continue;
    const stored = storedHome.get(key);
    kept.push(stored && stored.cwd === key ? { ...stored } : { cwd: key, name: path.basename(key) || key, collapsed: false });
  }
  const discovered = [...groups.keys()].filter((key) => !seen.has(key) && qualifies(key));
  discovered.sort((a, b) => compareRank(projectRank(groups.get(b), next), projectRank(groups.get(a), next)) || compareRank(a, b));
  for (const key of discovered) kept.push({ cwd: key, name: path.basename(key) || key });
  if (!sameProjects(next.projects, kept)) {
    next.projects = kept;
    changed = true;
  }
  const archived = new Set(next.archived);
  const sole = soleWorktreeChats(rows, worktreeRoot);
  const order = chatOrder(next);
  const projects: SidebarProject[] = next.projects.map((project) => {
    const folders = next.folders.filter((folder) => folder.cwd === project.cwd);
    const own = new Set(folders.map((folder) => folder.id));
    const sessions = (groups.get(project.cwd) || [])
      .filter((session) => !chatIds.has(session.id))
      .sort(order)
      .map((session) => {
        const marked = withMarks({ ...session, rankedAt: chatRank(session, next) }, next, archived, sole);
        const folder = next.inFolder[session.id];
        return folder && own.has(folder) ? { ...marked, folder } : marked;
      });
    if (!folders.length) return { ...project, sessions };
    return { ...project, sessions, folders: folders.map(({ id, name, collapsed }) => ({ id, name, collapsed: Boolean(collapsed) })) };
  });
  return { projects, state: next, changed };
}

export function arrangeChats(
  rows: readonly SessionIndexRow[],
  state: SidebarState,
  chatHome: string,
  locate: ProjectLocator | null = null,
  worktreeRoot = "",
): SidebarSession[] {
  const next = normalizeSidebar(state);
  const home = canonicalCwd(chatHome);
  const archived = new Set(next.archived);
  const chatIds = new Set(next.chatIds);
  const place = placementFor(rows, locate);
  const sole = soleWorktreeChats(rows, worktreeRoot);
  return rows
    .filter((row) => row.id && (chatIds.has(row.id) || (row.cwd && canonicalCwd(row.cwd) === home)))
    .sort(chatOrder(next))
    .map((session) => withMarks(labelSession(session, place), next, archived, sole));
}

function labelSession(row: SessionIndexRow, place: Place): SidebarSession {
  if (!row.cwd) return row;
  const placed = place(row.cwd);
  if (!placed.worktree) return row;
  return { ...row, worktree: placed.worktree };
}

function placementFor(rows: readonly SessionIndexRow[], locate: ProjectLocator | null): Place {
  const sources = sourceLinks(rows);
  return (cwd) => placeFolder(cwd, sources, locate);
}

interface SourceLinks {
  links: Map<string, string>;
  labels: Map<string, string>;
}

function sourceLinks(rows: readonly SessionIndexRow[]): SourceLinks {
  const links = new Map<string, string>();
  const labels = new Map<string, string>();
  for (const row of rows) {
    if (!row.cwd || !row.source) continue;
    const from = canonicalCwd(row.cwd);
    const to = canonicalCwd(row.source);
    if (!from || !to || from === to) continue;
    links.set(from, to);
    if (row.worktreeLabel) labels.set(from, String(row.worktreeLabel));
  }
  return { links, labels };
}

function placeFolder(cwd: string, sources: SourceLinks, locate: ProjectLocator | null): Placement {
  const start = canonicalCwd(String(cwd || ""));
  if (!start) return { home: "", worktree: null };
  let cursor = start;
  let origin = "";
  const seen = new Set<string>();
  while (sources.links.has(cursor) && !seen.has(cursor)) {
    seen.add(cursor);
    if (!origin) origin = cursor;
    const next = sources.links.get(cursor);
    if (!next || next === cursor) break;
    cursor = next;
  }
  if (origin) return { home: cursor, worktree: sources.labels.get(origin) || path.basename(origin) };
  return normalizePlace(start, locate);
}

function normalizePlace(cwd: string, locate: ProjectLocator | null): Placement {
  const key = canonicalCwd(String(cwd || ""));
  if (!key) return { home: "", worktree: null };
  if (!locate) return { home: key, worktree: null };
  const found = locate(key);
  if (typeof found === "string") return { home: canonicalCwd(found), worktree: null };
  const home = canonicalCwd(found?.home || key);
  const worktree = found?.worktree && home !== key ? String(found.worktree) : null;
  return { home, worktree };
}

function sameProjects(left: readonly StoredProject[], right: readonly StoredProject[]): boolean {
  if (left.length !== right.length) return false;
  return left.every((project, index) => {
    const other = right[index];
    if (!other) return false;
    return project.cwd === other.cwd && project.name === other.name && project.collapsed === other.collapsed;
  });
}

function withMarks(session: SidebarSession, state: SidebarState, archived: Set<string>, sole: Set<string>): SidebarSession {
  const title = state.titles[session.id];
  const marked = archived.has(session.id);
  const pinned = state.pinned.includes(session.id);
  const own = sole.has(session.id);
  if (!title && !marked && !pinned && !own) return session;
  const next = title ? { ...session, title } : { ...session };
  if (marked) next.archived = true;
  if (pinned) next.pinned = true;
  if (own) next.ownWorktree = true;
  return next;
}

// Chats that are the only row in a worktree this app added under the canonical root, whose folder still exists.
function soleWorktreeChats(rows: readonly SessionIndexRow[], root: string): Set<string> {
  if (!root) return new Set();
  const byWorktree = new Map<string, SessionIndexRow[]>();
  for (const row of rows) {
    const worktree = row.cwd ? appWorktreeOf(row.cwd, root) : null;
    if (worktree) byWorktree.set(worktree, [...(byWorktree.get(worktree) || []), row]);
  }
  return new Set([...byWorktree.values()].flatMap(([only, ...others]) => (only && !others.length && !only.gone ? [only.id] : [])));
}

export function rowsWithCatalog(
  rows: readonly SessionIndexRow[],
  catalog: readonly CatalogRow[],
  hiddenIds: readonly string[] = [],
): SessionIndexRow[] {
  const hidden = new Set(hiddenIds);
  const byId = new Map(rows.map((row) => [row.id, { ...row }]));
  for (const entry of catalog) {
    if (!entry.sessionId || hidden.has(entry.sessionId)) continue;
    if (entry.sessionKind === "subagent" || entry.session_kind === "subagent") continue;
    const cwd = entry.cwd ? canonicalCwd(entry.cwd) : "";
    const current = byId.get(entry.sessionId);
    if (current) {
      if (entry.title) current.title = entry.title;
      continue;
    }
    if (!cwd) continue;
    byId.set(entry.sessionId, {
      id: entry.sessionId,
      cwd,
      title: entry.title || "Untitled",
      updatedAt: "",
      ...(entry.provider ? { provider: entry.provider } : {}),
    });
  }
  return [...byId.values()];
}

function projectRank(rows: readonly SessionIndexRow[] | undefined, state: SidebarState): string {
  let rank = "";
  for (const row of rows || []) {
    const value = chatRank(row, state);
    if (value > rank) rank = value;
  }
  return rank;
}

function chatOrder(state: SidebarState): (a: SessionIndexRow, b: SessionIndexRow) => number {
  const pins = new Map(state.pinned.map((id, index) => [id, index]));
  return (a, b) => {
    const left = pins.get(a.id) ?? Infinity;
    const right = pins.get(b.id) ?? Infinity;
    if (left !== right) return left < right ? -1 : 1;
    return compareRank(chatRank(b, state), chatRank(a, state)) || compareRank(a.id, b.id);
  };
}

function chatRank(row: SessionIndexRow, state: SidebarState): string {
  return state.promptedAt[row.id] || state.seenAt[row.id] || row.updatedAt || "";
}

function compareRank(a: string, b: string): number {
  if (a === b) return 0;
  return a < b ? -1 : 1;
}

function normalizeSidebar(state: SidebarState): SidebarState {
  return SidebarFile.parse(state);
}

function stringMap(value: unknown): Record<string, string> {
  const map: Record<string, string> = {};
  if (!value || typeof value !== "object") return map;
  const entries: [string, unknown][] = Object.entries(value);
  for (const [key, stamp] of entries) {
    if (key && typeof stamp === "string") map[key] = stamp;
  }
  return map;
}
