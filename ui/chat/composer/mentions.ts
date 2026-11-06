export interface MentionToken {
  hidden: boolean;
  query: string;
  start: number;
}

export function mentionQuery(text: string, cursor?: number | null): MentionToken | null {
  const before = String(text).slice(0, cursor ?? text.length);
  const match = before.match(/(^|\s)@(!?)([^\s@]*)$/);
  if (!match) return null;
  const token = `@${match[2]}${match[3]}`;
  return {
    hidden: match[2] === "!",
    query: match[3] ?? "",
    start: before.length - token.length,
  };
}

export function applyMention(text: string, cursor: number, filePath: string): { text: string; cursor: number } {
  const token = mentionQuery(text, cursor);
  if (!token) return { text, cursor };
  const prefix = token.hidden ? "@!" : "@";
  const insertion = `${prefix}${filePath} `;
  const next = text.slice(0, token.start) + insertion + text.slice(cursor);
  return { text: next, cursor: token.start + insertion.length };
}

export function sessionFilePath(cwd: unknown, file: unknown): string {
  const raw = String(file || "").replace(/`/g, "").trim();
  if (!raw) return "";
  if (raw.startsWith("/") || /^[A-Za-z]:[\\/]/.test(raw)) return raw;
  const root = String(cwd || "").replace(/[/\\]+$/, "");
  const relative = raw.replace(/^\.\//, "");
  return root ? `${root}/${relative}` : relative;
}

export function relativeTo(cwd: unknown, filePath: string): string {
  const root = String(cwd || "").replace(/\/$/, "");
  if (root && (filePath === root || filePath.startsWith(`${root}/`))) return filePath.slice(root.length + 1);
  return filePath;
}
