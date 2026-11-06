import type { TicketLink } from "../../server/snapshot.ts";

// Indexed by any status string; a status outside these four has no color.
export const TICKET_STATUS: Record<string, string | undefined> = {
  open: "var(--status-open)",
  active: "var(--status-active)",
  review: "var(--status-review)",
  done: "var(--status-done)",
};

const RANK = ["active", "review", "open", "done"];

// Column names other boards use for the four statuses.
const STATUS_NAMES: Record<string, string | undefined> = {
  "to do": "open",
  todo: "open",
  backlog: "open",
  "in progress": "active",
  doing: "active",
  "in review": "review",
  "code review": "review",
  closed: "done",
  resolved: "done",
};

// One of the four statuses for a SAK status or another board's column name, or the name lowercased.
export function statusKey(status: unknown): string {
  const name = String(status ?? "").trim().toLowerCase();
  return STATUS_NAMES[name] ?? name;
}

export function statusTone(status: unknown): string | undefined {
  return TICKET_STATUS[statusKey(status)];
}

// taskId is a board task's id as the board API sent it.
export function threadCount(
  taskId: unknown,
  tickets: { bySession?: Record<string, readonly Pick<TicketLink, "taskId">[] | undefined> } | null | undefined,
): number {
  if (taskId === null || taskId === undefined || taskId === "") return 0;
  const key = String(taskId);
  let count = 0;
  for (const links of Object.values(tickets?.bySession || {})) {
    if (!Array.isArray(links)) continue;
    const linked = links.some((link) => link?.taskId != null && String(link.taskId) === key);
    if (linked) count += 1;
  }
  return count;
}

export function ticketStatus(links: readonly Partial<Pick<TicketLink, "status">>[] | null | undefined): string {
  let best = "";
  let rank = RANK.length;
  for (const link of links || []) {
    const status = statusKey(link?.status);
    const score = RANK.indexOf(status);
    const place = score < 0 ? RANK.length : score;
    if (place < rank) {
      rank = place;
      best = status;
    }
  }
  return best;
}
