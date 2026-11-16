// The order a queue runs in: which sub-tickets wait on which, the check for a cycle, and which chats start next.
// The page imports the types and labels from here.

export const FINISH_MODES = ["merged", "pr"] as const;
export type FinishMode = (typeof FINISH_MODES)[number];

export const FINISH_LABELS: Record<FinishMode, string> = { merged: "Merged", pr: "PR open" };

export const MAX_SLOTS = 8;
export const DEFAULT_SLOTS = 2;

// A message X Bench sends into a run's main chat goes inside this tag, with its kind, so the page draws it as an
// event line: <x-bench-queue-event kind="finished">…</x-bench-queue-event>.
export const EVENT_TAG = "x-bench-queue-event";
export const EVENT_KINDS = ["finished", "waiting", "stopped", "failed"] as const;
export type EventKind = (typeof EVENT_KINDS)[number];

export type StoredState = "queued" | "started" | "done" | "failed";

export interface PlanItem {
  id: string;
  // The tickets it is blocked by or follows.
  needs: string[];
  state: StoredState;
}

// The ids a ticket read names as blocking it or coming before it. Other kinds of link do not order the queue.
export function needsOf(related: readonly { id?: unknown; relation?: unknown }[]): string[] {
  const ids = related.filter((item) => item.relation === "blocked_by" || item.relation === "follows").map((item) => String(item.id ?? ""));
  return [...new Set(ids.filter(Boolean))];
}

// The ids along the first cycle among the items, ending on the one it began with, or null.
export function cycleIn(items: readonly Pick<PlanItem, "id" | "needs">[]): string[] | null {
  const needs = new Map(items.map((item) => [item.id, item.needs]));
  const cleared = new Set<string>();
  function walk(id: string, path: string[]): string[] | null {
    if (path.includes(id)) return [...path.slice(path.indexOf(id)), id];
    if (cleared.has(id)) return null;
    for (const need of needs.get(id) ?? []) {
      const found = walk(need, [...path, id]);
      if (found) return found;
    }
    cleared.add(id);
    return null;
  }
  for (const item of items) {
    const found = walk(item.id, []);
    if (found) return found;
  }
  return null;
}

// The queued items that start now, in list order: each with no open ticket among its needs, as many as there are
// free slots. openOutside holds the open prerequisites that are no item of this queue.
export function nextStarts<Item extends PlanItem>(items: readonly Item[], openOutside: ReadonlySet<string>, slots: number, working: number): Item[] {
  const open = new Set([...items.filter((item) => item.state !== "done").map((item) => item.id), ...openOutside]);
  const ready = items.filter((item) => item.state === "queued" && item.needs.every((need) => !open.has(need)));
  return ready.slice(0, Math.max(0, slots - working));
}

// Whether a pull request in this state finishes its sub-ticket.
export function finishes(mode: FinishMode, pr: { status: string; draft?: boolean | undefined } | undefined): boolean {
  if (!pr) return false;
  if (pr.status === "merged") return true;
  // A GitLab draft says so only in its status.
  return mode === "pr" && !pr.draft && pr.status !== "draft" && pr.status !== "closed";
}
