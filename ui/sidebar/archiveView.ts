export const SHOW_ARCHIVED_KEY = "x-bench-show-archived";

export function readShowArchived(storage: Pick<Storage, "getItem"> | null | undefined = globalThis.localStorage): boolean {
  try {
    return storage?.getItem(SHOW_ARCHIVED_KEY) === "1";
  } catch {
    return false;
  }
}

export function persistShowArchived(
  show: unknown,
  storage: Pick<Storage, "setItem" | "removeItem"> | null | undefined = globalThis.localStorage,
): boolean {
  const next = Boolean(show);
  try {
    if (next) storage?.setItem(SHOW_ARCHIVED_KEY, "1");
    else storage?.removeItem(SHOW_ARCHIVED_KEY);
  } catch {
    // The choice still applies for this visit.
  }
  return next;
}

export function visibleSessions<T extends { archived?: boolean }>(sessions: T[] | null | undefined, showArchived: boolean): T[] {
  const list = Array.isArray(sessions) ? sessions : [];
  if (showArchived) return list;
  return list.filter((session) => !session?.archived);
}
