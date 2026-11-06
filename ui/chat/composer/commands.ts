export interface SlashCommand {
  name: string;
  title: string;
  hint: string;
  argumentHint?: string;
  kind?: "skill";
  // What the menu shows and puts in the box, when it is not /name.
  text?: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function textOf(value: unknown): string {
  return typeof value === "string" ? value : "";
}

export const SLASH_COMMANDS: SlashCommand[] = [
  { name: "plan", title: "Plan", hint: "Switch to plan mode" },
  { name: "btw", title: "By the way", hint: "Ask aside, off this thread" },
  { name: "routine", title: "Routine", hint: "Send this message on a schedule" },
];

// The /token the cursor is in, at the start of the draft or after a space.
export function slashQuery(text: unknown, cursor?: number | null): { query: string; start: number } | null {
  const before = String(text ?? "").slice(0, cursor ?? undefined);
  const match = before.match(/(^|\s)\/([^\s/]*)$/);
  if (!match) return null;
  return { query: (match[2] ?? "").toLowerCase(), start: before.length - (match[2] ?? "").length - 1 };
}

// skills is the /api/skills reply (FolderSkill in server/chat/skills.ts). reported is what the harness listed:
// its installed skills and its own commands. A folder skill it also listed, as name or $name, shows once.
export function matchingCommands(
  query: string | null | undefined,
  skills: readonly unknown[] = [],
  reported: readonly unknown[] = [],
): SlashCommand[] {
  if (query == null) return [];
  const harness: SlashCommand[] = [];
  const seen = new Set(SLASH_COMMANDS.map((command) => command.name));
  const names = new Set([...seen, ...reported.map((command) => (isRecord(command) ? textOf(command.name) : ""))]);
  for (const command of reported) {
    if (!isRecord(command)) continue;
    const name = textOf(command.name);
    if (!name || seen.has(name)) continue;
    seen.add(name);
    // A Codex $name skill shows as /name, unless /name is a command too: then it stays $name to stay apart.
    const bare = name.replace(/^\$/, "");
    const text = bare !== name && names.has(bare) ? name : `/${bare}`;
    harness.push({ name, title: name, hint: textOf(command.description) || "Skill", kind: "skill", text });
  }
  const folderSkills: SlashCommand[] = [];
  for (const skill of skills) {
    if (!isRecord(skill)) continue;
    const name = String(skill.name || "");
    if (!name || seen.has(name) || seen.has(`$${name}`)) continue;
    seen.add(name);
    folderSkills.push({
      name,
      title: name,
      hint: textOf(skill.hint) || "Skill",
      argumentHint: textOf(skill.argumentHint),
      kind: "skill",
    });
  }
  return [...SLASH_COMMANDS, ...harness, ...folderSkills].filter((command) => command.name.replace(/^\$/, "").toLowerCase().startsWith(query));
}

// The text split around the skills and commands the session's harness reported: /why, or for Codex $why,
// or /why for a skill Codex listed only as $why. Punctuation after a name stays text.
export function skillParts(text: string, reported: readonly unknown[] = []): (string | { skill: string })[] {
  const names = new Set(reported.map((command) => (isRecord(command) ? textOf(command.name) : "")));
  const parts: (string | { skill: string })[] = [];
  let last = 0;
  for (const match of text.matchAll(/(?<=^|\s)([/$])([^\s/$]+?)(?=[.,;:!?)]*(?:\s|$))/g)) {
    const name = match[2] ?? "";
    const known = match[1] === "$" ? names.has(`$${name}`) : names.has(name) || names.has(`$${name}`);
    if (!known) continue;
    if (match.index > last) parts.push(text.slice(last, match.index));
    parts.push({ skill: name });
    last = match.index + match[0].length;
  }
  if (last < text.length) parts.push(text.slice(last));
  return parts;
}

export function planCommand(text: unknown): { description: string } | null {
  const match = String(text ?? "").trim().match(/^\/plan(?:\s+([\s\S]+))?$/i);
  if (!match) return null;
  return { description: (match[1] || "").trim() };
}

// /routine opens the routine editor with the rest of the message as its prompt.
export function routineCommand(text: unknown): { prompt: string } | null {
  const match = String(text ?? "").trim().match(/^\/routine(?:\s+([\s\S]+))?$/i);
  if (!match) return null;
  return { prompt: (match[1] || "").trim() };
}

// A /btw token anywhere in the message makes it an aside. The rest of the
// message is the question, and nothing is sent on the main turn.
export function btwCommand(text: unknown): { question: string } | null {
  const value = String(text ?? "");
  const match = value.match(/(^|\s)\/btw(?=$|\s)/i);
  if (!match) return null;
  const index = match.index ?? 0;
  const question = `${value.slice(0, index)}${value.slice(index + match[0].length)}`
    .replace(/\s+/g, " ")
    .trim();
  return { question };
}
