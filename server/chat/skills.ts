import { closeSync, openSync, readSync, readdirSync, realpathSync, statSync } from "node:fs";
import path from "node:path";
import { insideFolder } from "../folder/files.ts";

type SkillKind = "skill" | "command";

// A slash command offered in the composer for the open folder.
export interface FolderSkill {
  name: string;
  hint: string;
  argumentHint: string;
}

export interface SkillDocument {
  name: string;
  description: string;
  argumentHint: string;
  userInvocable: boolean;
}

// First match in one folder wins, which is the order Grok uses.
const ROOTS: { dir: string; kind: SkillKind }[] = [
  { dir: ".grok/skills", kind: "skill" },
  { dir: ".grok/commands", kind: "command" },
  { dir: ".agents/skills", kind: "skill" },
  { dir: ".agents/commands", kind: "command" },
  { dir: ".claude/skills", kind: "skill" },
  { dir: ".claude/commands", kind: "command" },
  { dir: ".cursor/skills", kind: "skill" },
];

// The composer already owns these names.
const RESERVED = new Set(["plan", "btw"]);
const MAX_SKILLS = 128;
const MAX_DEPTH = 6;
const MAX_BYTES = 16000;

export function listFolderSkills(folder: string): FolderSkill[] {
  let root: string;
  try {
    root = realpathSync(folder);
  } catch {
    return [];
  }
  const found: FolderSkill[] = [];
  const seen = new Set<string>();
  for (const source of ROOTS) {
    collect(root, path.join(root, source.dir), source.kind, 0, found, seen);
    if (found.length >= MAX_SKILLS) break;
  }
  found.sort((a, b) => a.name.localeCompare(b.name));
  return found;
}

export function skillSlug(value: unknown): string {
  const name = String(value || "")
    .trim()
    .toLowerCase()
    .replace(/[\s_]+/g, "-")
    .replace(/[^a-z0-9-]/g, "")
    .replace(/-+/g, "-")
    .replace(/^-+|-+$/g, "");
  if (!/^[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?$/.test(name)) return "";
  return name;
}

export function parseSkillDocument(text: string | null | undefined): SkillDocument {
  const raw = String(text || "").replace(/^\uFEFF/, "");
  let front = "";
  let body = raw;
  if (raw.startsWith("---")) {
    const end = raw.indexOf("\n---", 3);
    if (end !== -1) {
      front = raw.slice(raw.indexOf("\n") + 1, end);
      body = raw.slice(end + 4).replace(/^\r?\n/, "");
    }
  }
  const fields = parseFrontmatter(front);
  const description = String(fields.description || "").trim() || firstParagraph(body);
  const argumentHint = String(fields["argument-hint"] || fields.argument_hint || "").trim();
  const userInvocable = boolFlag(fields["user-invocable"] ?? fields.user_invocable, true);
  return {
    name: String(fields.name || "").trim(),
    description,
    argumentHint,
    userInvocable,
  };
}

function collect(
  root: string,
  directory: string,
  kind: SkillKind,
  depth: number,
  found: FolderSkill[],
  seen: Set<string>,
): void {
  let realDir: string;
  try {
    realDir = realpathSync(directory);
  } catch {
    return;
  }
  if (realDir !== root && !insideFolder(root, realDir)) return;
  let entries;
  try {
    entries = readdirSync(realDir, { withFileTypes: true });
  } catch {
    return;
  }
  entries.sort((a, b) => a.name.localeCompare(b.name));
  for (const entry of entries) {
    if (found.length >= MAX_SKILLS) return;
    if (entry.name === ".git" || entry.name === "node_modules") continue;
    const full = path.join(realDir, entry.name);
    let real: string;
    try {
      real = realpathSync(full);
    } catch {
      continue;
    }
    if (!insideFolder(root, real)) continue;
    let stat;
    try {
      stat = statSync(real);
    } catch {
      continue;
    }
    if (stat.isDirectory()) {
      if (kind !== "skill" || depth >= MAX_DEPTH) continue;
      collect(root, real, kind, depth + 1, found, seen);
      continue;
    }
    if (!stat.isFile()) continue;
    if (kind === "skill" && entry.name.toLowerCase() !== "skill.md") continue;
    if (kind === "command" && (depth !== 0 || !entry.name.toLowerCase().endsWith(".md"))) continue;
    const fallback = kind === "command" ? entry.name.replace(/\.md$/i, "") : path.basename(directory);
    const skill = skillFromFile(real, fallback);
    if (!skill || seen.has(skill.name)) continue;
    seen.add(skill.name);
    found.push(skill);
  }
}

function skillFromFile(file: string, fallback: string): FolderSkill | null {
  const parsed = parseSkillDocument(readHead(file));
  if (!parsed.userInvocable) return null;
  const base = skillSlug(parsed.name) || skillSlug(fallback);
  if (!base) return null;
  const name = RESERVED.has(base) ? `local:${base}` : base;
  return {
    name,
    hint: clip(parsed.description, 140),
    argumentHint: clip(parsed.argumentHint, 80),
  };
}

function readHead(file: string): string {
  let fd: number | undefined;
  try {
    const stat = statSync(file);
    if (!stat.isFile() || stat.size <= 0) return "";
    fd = openSync(file, "r");
    const length = Math.min(stat.size, MAX_BYTES);
    const buffer = Buffer.alloc(length);
    readSync(fd, buffer, 0, length, 0);
    return buffer.toString("utf8");
  } catch {
    return "";
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
}

function parseFrontmatter(text: string): Record<string, string | undefined> {
  const fields: Record<string, string | undefined> = {};
  const lines = String(text || "").split(/\r?\n/);
  let index = 0;
  while (index < lines.length) {
    const line = lines[index];
    if (line === undefined) break;
    if (!line.trim() || line.trim().startsWith("#")) {
      index += 1;
      continue;
    }
    const match = line.match(/^([A-Za-z0-9_-]+):\s*(.*)$/);
    if (!match) {
      index += 1;
      continue;
    }
    const key = (match[1] ?? "").toLowerCase();
    const rest = (match[2] ?? "").trim();
    if (rest === ">" || rest === ">-" || rest === "|" || rest === "|-" || rest === "") {
      const block: string[] = [];
      const literal = rest.startsWith("|");
      index += 1;
      while (index < lines.length && /^[ \t]/.test(lines[index] ?? "")) {
        block.push((lines[index] ?? "").trim());
        index += 1;
      }
      fields[key] = block.join(literal ? "\n" : " ").trim();
      continue;
    }
    fields[key] = unquote(rest);
    index += 1;
  }
  return fields;
}

function unquote(value: string): string {
  const text = String(value || "").trim();
  if (
    (text.startsWith('"') && text.endsWith('"') && text.length >= 2) ||
    (text.startsWith("'") && text.endsWith("'") && text.length >= 2)
  ) {
    return text.slice(1, -1);
  }
  return text;
}

function boolFlag(value: string | undefined, fallback: boolean): boolean {
  if (value == null || value === "") return fallback;
  const text = String(value).trim().toLowerCase();
  if (text === "false" || text === "no" || text === "0") return false;
  if (text === "true" || text === "yes" || text === "1") return true;
  return fallback;
}

function firstParagraph(body: string): string {
  const kept: string[] = [];
  let started = false;
  for (const line of String(body || "").split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!started) {
      if (!trimmed || trimmed.startsWith("#")) continue;
      started = true;
    } else if (!trimmed) {
      break;
    }
    kept.push(trimmed.replace(/^#+\s*/, ""));
  }
  return kept.join(" ");
}

function clip(value: string, max: number): string {
  const text = String(value || "").replace(/\s+/g, " ").trim();
  if (text.length <= max) return text;
  return `${text.slice(0, max - 1).trimEnd()}…`;
}
