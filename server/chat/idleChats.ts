import { waitsOnPerson, type SessionState } from "../../bridge/reducer.ts";

// A loaded chat can hold an agent process of its own, so the host closes idle chats past this many per provider.
export const OPEN_CHAT_LIMIT = 8;
export const OVER_LIMIT_UNSEEN_MS = 30 * 60_000;
// An idle chat unseen this long closes even under the limit.
export const UNSEEN_MS = 2 * 60 * 60_000;

export interface LoadedChat {
  id: string;
  // Running, waiting on the person, or holding work that a close would drop.
  busy: boolean;
}

export function isBusy(session: SessionState, held: ReadonlySet<string>): boolean {
  return held.has(session.id) || session.status === "running" || waitsOnPerson(session) || session.queue.length > 0 || session.backgroundTasks.some((task) => task.status === "running");
}

export function chatsToClose(loaded: LoadedChat[], lastShown: ReadonlyMap<string, number>, now: number, limit = OPEN_CHAT_LIMIT): string[] {
  const unseen = (chat: LoadedChat) => now - (lastShown.get(chat.id) ?? now);
  const extra = loaded.length - limit;
  return loaded
    .filter((chat) => !chat.busy)
    .sort((left, right) => unseen(right) - unseen(left))
    .filter((chat, index) => unseen(chat) >= UNSEEN_MS || (index < extra && unseen(chat) >= OVER_LIMIT_UNSEEN_MS))
    .map((chat) => chat.id);
}
