// Where a suggested follow-up task goes: the folder a new chat for it starts in, and the board a ticket for it lands on.

import type { RoutineRunView, RoutineView, SidebarProject, SidebarSession, TaskSuggestion, TicketLinks } from "../../server/snapshot.ts";

type ProjectRows = Pick<SidebarProject, "cwd"> & { sessions: readonly Pick<SidebarSession, "id">[] };
type RoutineRows = Pick<RoutineView, "cwd"> & { runs: readonly Pick<RoutineRunView, "sessionId">[] };

// The project the sidebar lists the session under. A worktree session is listed under its main checkout. A routine
// run stays out of the sidebar, so its routine's folder stands in.
export function projectFolder(
  session: { id: string; cwd: string },
  projects: readonly ProjectRows[] | null | undefined,
  routines?: readonly RoutineRows[] | null,
): string {
  const project = (projects ?? []).find((item) => item.sessions.some((row) => row.id === session.id));
  const routine = (routines ?? []).find((item) => item.runs.some((run) => run.sessionId === session.id));
  return project?.cwd || routine?.cwd || session.cwd;
}

// The bound folder a ticket for this session's suggestion goes to: its own folder, else its project's
// (a worktree of a bound folder finds no board by itself). null when neither has a board.
export function boardFolder(
  session: { id: string; cwd: string },
  tickets: Partial<TicketLinks> | null | undefined,
  projects: readonly ProjectRows[] | null | undefined,
  routines?: readonly RoutineRows[] | null,
): string | null {
  const boards = tickets?.boards ?? [];
  if (boards.includes(session.cwd)) return session.cwd;
  const project = projectFolder(session, projects, routines);
  return boards.includes(project) ? project : null;
}

export function ticketDescription(suggestion: Pick<TaskSuggestion, "summary" | "prompt">): string {
  return [suggestion.summary, suggestion.prompt].filter(Boolean).join("\n\n");
}
