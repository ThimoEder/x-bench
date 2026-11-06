import type { RoutineSeed } from "./routineForm.ts";

// ?routines opens the Routines page, so a reload stays on it.
export function routineSearch(): string {
  return "?routines";
}

export function routinesTarget(search: unknown): boolean {
  return new URLSearchParams(String(search || "").replace(/^\?/, "")).has("routines");
}

// The folder a routine made from a chat runs in: the project the chat belongs to, so a chat in a worktree gives a
// routine on the main checkout. A draft is found by a chat in the same folder.
export function routineFolder(session: { id: string; cwd: string }, projects: readonly { cwd: string; sessions: readonly { id: string; cwd: string }[] }[] | null | undefined): string {
  const list = projects ?? [];
  const project =
    list.find((item) => item.sessions.some((row) => row.id === session.id)) ||
    list.find((item) => item.cwd === session.cwd || item.sessions.some((row) => row.cwd === session.cwd));
  return project?.cwd || session.cwd;
}

interface ComposerPane {
  id: string;
  cwd: string;
  provider?: string;
  modeId?: string;
  configOptions: readonly { id: string; currentValue?: unknown }[];
}

// A draft's model menu lists composer values; an open session's lists the provider's own model ids.
export function composerRoutine(session: ComposerPane, prompt: string, chat: boolean, projects: Parameters<typeof routineFolder>[1]): RoutineSeed {
  const draftPane = session.id === "draft";
  const option = (id: string) => {
    const current = session.configOptions.find((item) => item.id === id)?.currentValue;
    return typeof current === "string" ? current : "";
  };
  const model = option("model");
  const effort = option("effort");
  const value = draftPane ? model : session.provider && model ? `${session.provider}:${model}` : "";
  return {
    prompt,
    chat,
    cwd: routineFolder(session, projects),
    ...(value ? { picks: { model: value, ...(effort ? { effort } : {}) } } : {}),
    ...(!draftPane && session.modeId ? { mode: session.modeId } : {}),
  };
}
