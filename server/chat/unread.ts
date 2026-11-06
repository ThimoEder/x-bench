import type { Snapshot } from "../snapshot.ts";

export interface UnreadEvent {
  id: string;
  wasRunning: boolean;
  status: string;
  open: boolean;
  pending: boolean;
}

export function updateUnread(ids: Iterable<string>, event: UnreadEvent): string[] {
  const next = new Set(ids);
  if (event.open || event.status === "running" || event.pending) next.delete(event.id);
  else if (event.wasRunning) next.add(event.id);
  return [...next];
}

// Loading a session replays its whole history. Each replayed update of a
// session that is not on the desk only carries these marks, so a publish
// is due only when one of them changed.
// The snapshot or a partial of it. Other keys are ignored.
type Marks = Partial<Snapshot>;

export function sameMarks(current: Marks | null | undefined, next: Marks | null | undefined): boolean {
  return (["working", "attention", "unread"] as const).every((key) => {
    const left = current?.[key] || [];
    const right = next?.[key] || [];
    return left.length === right.length && left.every((id, index) => id === right[index]);
  });
}
