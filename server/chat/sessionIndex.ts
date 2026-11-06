// The app's own list of sessions it opened: which provider holds each one, the harness's
// id for it, its folder, title and dates. A session remembers its provider here, so a
// prompt, a cancel or a permission answer goes to the harness that runs it, and the
// sidebar lists sessions whose harness keeps no folder this app reads.
//
// The app id is the harness's id of the chat's first session. A chat switched to another provider keeps
// its app id, and harnessId names the session it runs on now. The sessions it ran on before are in its chat
// record (chatRecords.ts), since an older host rewrites this file without fields it does not know.

import { z } from "zod";
import { listOf } from "../../bridge/lenient.ts";
import { fileStamp, loadDurable, saveDurable } from "../jsonFile.ts";

export interface IndexedSession {
  id: string;
  provider: string;
  harnessId: string;
  cwd: string;
  title: string;
  createdAt: string;
  updatedAt: string;
  // Choices a harness forgets when a session loads again, in the harness's own names.
  // Codex forgets its approval preset. Claude forgets its model, effort and permission mode.
  harnessMode?: string;
  harnessModel?: string;
  harnessEffort?: string;
}

// Loose, so a field a newer host adds survives this host rewriting the file.
const Row = z.looseObject({
  id: z.string().min(1),
  provider: z.string().min(1),
  harnessId: z.string().min(1),
  cwd: z.string(),
  title: z.string().catch(""),
  createdAt: z.string().catch(""),
  updatedAt: z.string().catch(""),
  harnessMode: z.string().optional().catch(undefined),
  harnessModel: z.string().optional().catch(undefined),
  harnessEffort: z.string().optional().catch(undefined),
});

const IndexFile = z.object({ sessions: listOf(Row) });

function parse(value: unknown): IndexedSession[] | null {
  const parsed = IndexFile.safeParse(value);
  return parsed.success ? parsed.data.sessions : null;
}

export interface SessionIndexStore {
  all(): IndexedSession[];
  get(id: string): IndexedSession | null;
  // The chat running on a harness session. null for a session the index does not know.
  chatOf(harnessId: string): IndexedSession | null;
  // Adds the session or updates the fields given. Fields left out keep their value.
  record(entry: Partial<IndexedSession> & { id: string; provider: string }): IndexedSession;
  drop(id: string): void;
}

// Codex's approval preset for a harness session. A chat still on another provider keeps it: the preset of a
// session the chat moves to is saved before the move commits.
export function notePreset(index: SessionIndexStore, harnessId: string, preset: string) {
  const row = index.chatOf(harnessId);
  index.record({ id: row?.id ?? harnessId, provider: row?.provider ?? "chatgpt", harnessMode: preset });
}

export function createSessionIndex(file: string): SessionIndexStore {
  // Read on every published snapshot, so the file is parsed again only when it changed.
  let cached: { stamp: string; rows: IndexedSession[]; byId: Map<string, IndexedSession>; byHarness: Map<string, IndexedSession> } | null = null;

  function load() {
    const stamp = fileStamp(file);
    if (cached?.stamp !== stamp) {
      const rows = loadDurable(file, parse, []);
      cached = { stamp, rows, byId: new Map(rows.map((row) => [row.id, row])), byHarness: harnessMap(rows) };
    }
    return cached;
  }

  function read(): IndexedSession[] {
    return load().rows.map((row) => ({ ...row }));
  }

  function write(rows: IndexedSession[]) {
    saveDurable(file, `${JSON.stringify({ sessions: rows }, null, 2)}\n`, parse);
    cached = null;
  }

  return {
    all: read,
    // Every call into a provider looks its chat up here, so this reads the cached map instead of copying every row.
    get(id) {
      const row = load().byId.get(id);
      return row ? { ...row } : null;
    },
    chatOf(harnessId) {
      const row = load().byHarness.get(harnessId);
      return row ? { ...row } : null;
    },
    record(entry) {
      const rows = read();
      const now = new Date().toISOString();
      const index = rows.findIndex((row) => row.id === entry.id);
      const known = index >= 0 ? rows[index] : undefined;
      const next: IndexedSession = {
        harnessId: entry.id,
        cwd: "",
        title: "",
        createdAt: now,
        updatedAt: now,
        ...known,
        ...Object.fromEntries(Object.entries(entry).filter(([, value]) => value !== undefined)),
      } as IndexedSession;
      const unchanged = known && JSON.stringify(known) === JSON.stringify(next);
      if (unchanged) return next;
      if (index >= 0) rows[index] = next;
      else rows.push(next);
      write(rows);
      return next;
    },
    drop(id) {
      const rows = read();
      const next = rows.filter((row) => row.id !== id);
      if (next.length !== rows.length) write(next);
    },
  };
}

// Each harness id to its chat. A chat running on a session another row also names wins over that row.
function harnessMap(rows: IndexedSession[]) {
  const map = new Map<string, IndexedSession>();
  for (const row of rows) map.set(row.id, row);
  for (const row of rows) if (row.harnessId !== row.id) map.set(row.harnessId, row);
  return map;
}
