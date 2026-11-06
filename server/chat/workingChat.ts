import { canonicalCwd } from "./sessions.ts";

// An open chat as the host lists it for the board routes.
export interface ChatActivity {
  id: string;
  cwd?: string;
  working: boolean;
}

export interface WorkingChat {
  // Empty unless exactly one chat is working.
  id: string;
  count: number;
}

// The chat a ticket should attach to: the one turn working in this folder.
export function workingChatId(sessions: Iterable<ChatActivity | null | undefined> | null | undefined, cwd: unknown): WorkingChat {
  const raw = String(cwd || "");
  if (!raw) return { id: "", count: 0 };
  const folder = canonicalCwd(raw);
  const ids: string[] = [];
  for (const session of sessions || []) {
    const id = String(session?.id || "");
    const home = String(session?.cwd || "");
    if (!id || !home || !session?.working || ids.includes(id)) continue;
    if (canonicalCwd(home) !== folder) continue;
    ids.push(id);
  }
  return { id: ids.length === 1 ? (ids[0] ?? "") : "", count: ids.length };
}
