import { useEffect, useState } from "react";
import type { PresentedMention } from "../../../server/present.ts";
import { matchingCommands, slashQuery } from "./commands.ts";
import { apiFetch } from "../../launchToken.ts";

export interface SlashCommandsOptions {
  // commands is what the session's harness reported. A draft has none yet.
  session: { cwd: string; commands?: readonly unknown[] | undefined };
  // The provider that runs the session, or the one a draft would start.
  provider?: string | undefined;
  // A chat has no slash menu.
  plain: boolean;
  draft: string;
  cursor: number;
  // The @ list takes the menu's place while it is open.
  mentions: PresentedMention[];
  // False when the session's provider has no side questions, which hides /btw.
  btw?: boolean;
  // False where nothing opens the routine editor, which hides /routine.
  routine?: boolean;
}

// The slash menu: built-in commands and the harness's commands that match the draft. The session's own list
// replaces the folder's skills. Until it comes, the list the harness reported last goes with the folder's skills,
// since that list can be another folder's.
export function useSlashCommands({ session, provider, plain, draft, cursor, mentions, btw = true, routine = true }: SlashCommandsOptions) {
  const [commandIndex, setCommandIndex] = useState(0);
  const [skills, setSkills] = useState<unknown[]>([]);
  const [saved, setSaved] = useState<unknown[]>([]);

  const slash = slashQuery(draft, cursor);
  const query = slash?.query;
  const slashOpen = slash != null;
  const own = Boolean(session.commands?.length);
  const reported = own ? session.commands ?? [] : saved;
  const listed = plain || mentions.length ? [] : matchingCommands(query, own ? [] : skills, reported);
  // /plan and /btw take the whole draft, so they show only while the draft is the token. A harness runs its
  // own commands only from the start of a message; of those, only Codex's tell themselves apart from its $name skills.
  const whole = /^\/\S*$/.test(draft);
  const codexCommand = (name: string) =>
    provider === "chatgpt" && !name.startsWith("$") && reported.some((command) => isRecord(command) && command.name === name);
  const commands = listed.filter((command) =>
    command.kind === "skill" ? slash?.start === 0 || !codexCommand(command.name) : whole && (btw || command.name !== "btw") && (routine || command.name !== "routine"),
  );

  useEffect(() => {
    setCommandIndex(0);
  }, [query]);

  useEffect(() => {
    if (plain || !slashOpen || !session.cwd) return undefined;
    const controller = new AbortController();
    apiFetch("/api/skills", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ cwd: session.cwd, provider }),
      signal: controller.signal,
    })
      .then((response) => (response.ok ? response.json() : {}))
      .then((result: unknown) => {
        if (controller.signal.aborted) return;
        setSkills(isRecord(result) && Array.isArray(result.skills) ? result.skills : []);
        setSaved(isRecord(result) && Array.isArray(result.commands) ? result.commands : []);
      })
      .catch(() => {
        if (controller.signal.aborted) return;
        setSkills([]);
        setSaved([]);
      });
    return () => controller.abort();
  }, [plain, session.cwd, provider, slashOpen]);

  return { commands, commandIndex, setCommandIndex, slashStart: slash?.start ?? 0 };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}
