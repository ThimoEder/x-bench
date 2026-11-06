import { isShortTicketHref } from "../../../server/board/boardLink.ts";

export type CellAlign = "left" | "center" | "right";

export interface ListBlock {
  type: "list";
  ordered: boolean;
  // The number of the first item when it is not 1.
  start?: number;
  items: ListItem[];
}

// An item's first line, then the paragraphs and lists indented under it.
export interface ListItem {
  text: string;
  children?: ListChild[];
}

export type ListChild = { type: "text"; text: string } | ListBlock | QuoteBlock;

export interface QuoteBlock {
  type: "quote";
  blocks: MarkdownBlock[];
}

// A code block is open while its closing fence has not arrived yet, as in a reply that is still streaming.
export type MarkdownBlock =
  | { type: "code"; lang: string; text: string; open?: true }
  | { type: "text"; text: string }
  | { type: "heading"; level: number; text: string }
  | { type: "table"; align: CellAlign[]; header: string[]; rows: string[][] }
  | { type: "math"; text: string }
  | QuoteBlock
  | ListBlock;

export type MathPart = { type: "math"; text: string; display: boolean };

export type InlinePart =
  | { type: "text" | "code" | "strong" | "em"; text: string }
  | { type: "link"; text: string; href: string }
  // A link to a file on this machine ([name](/abs/path), as Codex writes them). path has no line suffix.
  | { type: "file"; text: string; path: string; line?: number }
  // A picture on this machine (![alt](/abs/shot.png)) or a board ticket's file on the board API, shown inline.
  // path may be relative to the session folder.
  | { type: "image"; text: string; path: string }
  // A picture on the web (![alt](https://host/a.jpg)), shown inline.
  | { type: "webImage"; text: string; href: string }
  // A video on this machine (![alt](/abs/cut.mp4)), played inline. path may be relative to the session folder.
  | { type: "video"; text: string; path: string }
  | MathPart;

export type MathTextPart = { type: "text"; text: string } | MathPart;

export function isMarkdownPath(file: string | null | undefined): boolean {
  return /\.(?:md|markdown)$/i.test(String(file || ""));
}

// A fence starts a line, after any indent, list marker or quote marker.
const FENCE_START = String.raw`(?<=(?:^|\n)[ \t]*(?:(?:[-*+]|\d+[.)])[ \t]+|>[ \t]*)*)`;

export function parseMarkdown(source: string | null | undefined, depth = 0): MarkdownBlock[] {
  const text = String(source ?? "");
  const blocks: MarkdownBlock[] = [];
  // It closes on a line that starts with a run of backticks at least as long as its opener.
  const fence = new RegExp(String.raw`${FENCE_START}(\x60{3,})([^\n\x60]*)([\s\S]*?)(?:\n[ \t>]*(\1)\x60*|$)`, "g");
  let cursor = 0;
  for (let match = fence.exec(text); match; match = fence.exec(text)) {
    // A fence on a quoted line belongs to the quote, which parses its own text again.
    if (quoted(text, match.index)) {
      fence.lastIndex = match.index + 3;
      continue;
    }
    if (match[4] === undefined) break;
    if (match.index > cursor) pushText(blocks, text.slice(cursor, match.index), depth);
    blocks.push({ type: "code", lang: (match[2] ?? "").trim(), text: (match[3] ?? "").replace(/^\n/, "") });
    cursor = match.index + match[0].length;
  }
  const openers = text.slice(cursor).matchAll(new RegExp(String.raw`${FENCE_START}\x60{3,}`, "g"));
  const opener = [...openers].find((match) => !quoted(text, cursor + match.index));
  if (opener) {
    const start = cursor + opener.index;
    if (start > cursor) pushText(blocks, text.slice(cursor, start), depth);
    const rest = text.slice(start + opener[0].length);
    const newline = rest.indexOf("\n");
    const lang = newline === -1 ? rest : rest.slice(0, newline);
    const body = newline === -1 ? "" : rest.slice(newline + 1);
    blocks.push({ type: "code", lang: lang.trim(), text: body.replace(/\n$/, ""), open: true });
  } else if (cursor < text.length) pushText(blocks, text.slice(cursor), depth);
  return blocks.filter((block) => {
    if (block.type === "list") return block.items.length > 0;
    if (block.type === "table") return block.header.length > 0;
    if (block.type === "quote") return block.blocks.length > 0;
    return block.text.length > 0;
  });
}

const QUOTE = /^[ \t]*> ?/;

// Deeper quotes keep their markers as text, so a long run of ">" cannot exhaust the stack.
const MAX_QUOTE_DEPTH = 50;

function quoted(text: string, index: number) {
  return QUOTE.test(text.slice(text.lastIndexOf("\n", index - 1) + 1, index));
}

// An open list, and the indent of its last marker.
interface ListLevel {
  list: ListBlock;
  indent: number;
  // The source number of its last item.
  number: number;
  // A list numbered from 1 again at the indent of an item that ends with a colon, held inside that item.
  adopted?: true;
}

function pushText(blocks: MarkdownBlock[], raw: string, depth: number) {
  const lines = raw.split("\n");
  let paragraph: string[] = [];
  let levels: ListLevel[] = [];
  // A blank line came after the open list's last line.
  let blank = false;

  function flushParagraph() {
    const text = paragraph.join("\n").trim();
    paragraph = [];
    if (text) blocks.push({ type: "text", text });
  }

  function flushList() {
    if (levels[0]) blocks.push(levels[0].list);
    levels = [];
    blank = false;
  }

  function lastItem(level: ListLevel): ListItem {
    const item = level.list.items.at(-1);
    if (!item) throw new Error("a list level has no item");
    return item;
  }

  function openList(ordered: boolean, number: number): ListBlock {
    return ordered && number !== 1 ? { type: "list", ordered, start: number, items: [] } : { type: "list", ordered, items: [] };
  }

  // A list beside the one at the top of the stack, at the same indent: in the same parent item, or a new block.
  function replaceTop(ordered: boolean, number: number, indent: number) {
    const parent = levels.at(-2);
    if (!parent) {
      flushList();
      levels = [{ list: openList(ordered, number), indent, number }];
      return;
    }
    levels.pop();
    nest(parent, ordered, number, indent);
  }

  function nest(parent: ListLevel, ordered: boolean, number: number, indent: number, adopted = false) {
    const list = openList(ordered, number);
    const item = lastItem(parent);
    (item.children ??= []).push(list);
    levels.push(adopted ? { list, indent, number, adopted } : { list, indent, number });
  }

  function addItem(indent: number, ordered: boolean, number: number, text: string) {
    flushParagraph();
    let top = levels.at(-1);
    if (!top) {
      top = { list: openList(ordered, number), indent, number };
      levels = [top];
    } else {
      // A marker a little left of a nested list's own stays in it while it is still indented under the parent item.
      while (levels.length > 1 && indent < top.indent && indent < (levels.at(-2) as ListLevel).indent + 2) {
        levels.pop();
        top = levels.at(-1) as ListLevel;
      }
      const parent = levels.at(-2);
      if (top.adopted && parent && indent < top.indent + 2) {
        // The parent list's numbering picks up again, as in 6. … then 1. 2. 3. then 7.
        const resumes = number === parent.number + 1 && number !== top.number + 1;
        if (top.list.ordered !== ordered || resumes) {
          levels.pop();
          top = parent;
        }
      }
      const item = lastItem(top);
      if (indent >= top.indent + 2) nest(top, ordered, number, indent);
      else if (top.list.ordered !== ordered) replaceTop(ordered, number, indent);
      else if (ordered && number === 1 && top.number > 1) {
        if (/:[*_]*$/.test(item.text)) nest(top, ordered, number, top.indent, true);
        else if (blank) replaceTop(ordered, number, indent);
      }
      top = levels.at(-1) as ListLevel;
    }
    top.list.items.push({ text });
    top.number = number;
    if (!top.adopted) top.indent = indent;
    blank = false;
  }

  // After a blank line, a line belongs to the list only when it is indented under the outer list's items.
  function underList(indent: number) {
    return levels[0] !== undefined && indent > 0 && (!blank || indent >= levels[0].indent + 2);
  }

  // An indented line under an open list belongs to the deepest item it is indented under.
  function itemAt(indent: number): ListItem {
    let top = levels.at(-1) as ListLevel;
    while (levels.length > 1 && indent < top.indent + 2) {
      levels.pop();
      top = levels.at(-1) as ListLevel;
    }
    return lastItem(top);
  }

  function addToItem(indent: number, text: string) {
    const item = itemAt(indent);
    const last = item.children?.at(-1);
    if (!blank && !last) item.text += `\n${text}`;
    else if (!blank && last?.type === "text") last.text += `\n${text}`;
    else (item.children ??= []).push({ type: "text", text });
    blank = false;
  }

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (line === undefined) continue;
    if (!line.trim()) {
      flushParagraph();
      if (levels.length) blank = true;
      continue;
    }
    if (QUOTE.test(line)) {
      flushParagraph();
      const inner: string[] = [];
      for (let next = line; QUOTE.test(next); next = lines[++i] ?? "") inner.push(next.replace(QUOTE, ""));
      i -= 1;
      const text = inner.join("\n");
      const quote: QuoteBlock = { type: "quote", blocks: depth + 1 < MAX_QUOTE_DEPTH ? parseMarkdown(text, depth + 1) : [{ type: "text", text }] };
      if (underList(indentOf(line))) {
        (itemAt(indentOf(line)).children ??= []).push(quote);
        blank = false;
      } else {
        flushList();
        blocks.push(quote);
      }
      continue;
    }
    const heading = /^(#{1,6})\s+(.+?)\s*#*$/.exec(line);
    if (heading) {
      flushParagraph();
      flushList();
      blocks.push({ type: "heading", level: (heading[1] ?? "").length, text: (heading[2] ?? "").trim() });
      continue;
    }
    const math = displayMath(lines, i);
    if (math) {
      flushParagraph();
      flushList();
      blocks.push({ type: "math", text: math.text });
      i = math.end;
      continue;
    }
    const align = delimiterAligns(lines[i + 1]);
    const header = align ? splitCells(line) : null;
    if (align && header && header.length === align.length) {
      flushParagraph();
      flushList();
      const rows: string[][] = [];
      i += 2;
      while (i < lines.length) {
        const row = lines[i];
        if (row === undefined || !row.trim() || startsOtherBlock(row)) break;
        rows.push(fitCells(splitCells(row), align.length));
        i += 1;
      }
      i -= 1;
      blocks.push({ type: "table", align, header, rows });
      continue;
    }
    const indent = indentOf(line);
    const item = /^\s*(?:[-*+]|(\d+)[.)])\s+(.+)$/.exec(line);
    if (item) {
      addItem(indent, item[1] != null, Number(item[1] ?? 1), (item[2] ?? "").trim());
      continue;
    }
    if (underList(indent)) {
      addToItem(indent, line.trim());
      continue;
    }
    flushList();
    paragraph.push(line.trim());
  }
  flushParagraph();
  flushList();
}

// Leading spaces, with a tab as four.
function indentOf(line: string) {
  let width = 0;
  for (const ch of line) {
    if (ch === " ") width += 1;
    else if (ch === "\t") width += 4;
    else break;
  }
  return width;
}

// A line that starts with $$ or \[ opens display math, up to the line that ends with $$ or \]. Its lines are
// math, even one that would start a list. Without a closer (a reply still streaming), the lines stay text.
function displayMath(lines: string[], start: number): { text: string; end: number } | null {
  const first = (lines[start] ?? "").trim();
  const close = first.startsWith("$$") ? "$$" : first.startsWith("\\[") ? "\\]" : null;
  if (!close) return null;
  const body: string[] = [];
  for (let i = start; i < lines.length; i++) {
    let line = (lines[i] ?? "").trim();
    if (i === start) line = line.slice(2);
    const at = line.indexOf(close);
    if (at === -1) {
      body.push(line);
      continue;
    }
    if (at !== line.length - close.length) return null;
    body.push(line.slice(0, at));
    const text = body.join("\n").trim();
    return text ? { text, end: i } : null;
  }
  return null;
}

function startsOtherBlock(line: string) {
  return /^(?:#{1,6}\s|(?:[-*+]|\d+[.)])\s|>)/.test(line);
}

function delimiterAligns(line: string | undefined): CellAlign[] | null {
  if (line == null || !String(line).includes("|")) return null;
  const cells = splitCells(line);
  if (!cells.length) return null;
  const align: CellAlign[] = [];
  for (const cell of cells) {
    if (!/^:?-+:?$/.test(cell)) return null;
    const left = cell.startsWith(":");
    const right = cell.endsWith(":");
    let side: CellAlign = "left";
    if (left && right) side = "center";
    else if (right) side = "right";
    align.push(side);
  }
  return align;
}

function fitCells(cells: string[], count: number) {
  const row = cells.slice(0, count);
  while (row.length < count) row.push("");
  return row;
}

function splitCells(line: string) {
  const source = String(line).trim();
  const cells: string[] = [];
  let buf = "";
  let i = source[0] === "|" ? 1 : 0;
  let trailingPipe = false;

  while (i < source.length) {
    const ch = source[i];
    if (ch === "\\") {
      trailingPipe = false;
      const next = source[i + 1];
      if (next == null) {
        buf += "\\";
        i += 1;
        continue;
      }
      if (next === "|") {
        buf += "|";
        i += 2;
        continue;
      }
      buf += next === "\\" ? "\\\\" : `\\${next}`;
      i += 2;
      continue;
    }
    if (ch === "`") {
      trailingPipe = false;
      let ticks = 0;
      while (source[i + ticks] === "`") ticks += 1;
      const closer = findCodeCloser(source, i + ticks, ticks);
      if (closer === -1) {
        buf += "`";
        i += 1;
        continue;
      }
      buf += source.slice(i, closer + ticks).replace(/\\\|/g, "|");
      i = closer + ticks;
      continue;
    }
    if (ch === "|") {
      cells.push(buf.trim());
      buf = "";
      trailingPipe = true;
      i += 1;
      continue;
    }
    trailingPipe = false;
    buf += ch;
    i += 1;
  }
  if (!trailingPipe) cells.push(buf.trim());
  return cells;
}

function findCodeCloser(source: string, from: number, ticks: number) {
  for (let i = from; i < source.length; i++) {
    if (source[i] !== "`") continue;
    let len = 0;
    while (source[i + len] === "`") len += 1;
    if (len === ticks) return i;
    i += len - 1;
  }
  return -1;
}

// Display math is $$…$$ or \[…\], inline math \(…\) or $…$. A lone $ opens only before a non-space and
// closes only after one, and not before a letter or digit, so "$5 and $10" and $HOME/$USER stay text. Math
// holds no backtick, so a code span inside or across it stays code. An escaped \$ is a plain dollar.
const MATH = String.raw`\$\$((?:\\[\s\S]|[^\\$\x60])+?)\$\$|\\\[([^\x60]+?)\\\]|\\\(([^\x60]+?)\\\)|(?<![\w$\\])\$(?![\s$])((?:\\.|[^\\$\n\x60])+?)(?<!\s)\$(?![\w$])|\\\$`;

// The forms before math are a bare address, which stops at a quote, a Markdown marker, or
// punctuation from other scripts, a link whose href is not a web address (a file link when it
// names an absolute path, a ticket link when it is ?task=<id>, else text, so no address inside it
// is linked), and a picture. File links take groups 10 and 11, pictures 12 and 13, math 14 to 17.
// A code span closes on a backtick run exactly as long as its opener, and sheds one space of padding on each side.
const INLINE = new RegExp(
  String.raw`\[([^\]\n]+)\]\((https?:\/\/[^\s)]+)\)|(?<!\x60)(\x60+)(?!\x60)([^\n]*?)(?<!\x60)\3(?!\x60)|\*\*([^*\n]+)\*\*|(?<![\w*])\*([^*\n]+)\*(?![\w*])|(?<![\w_])_([^_\n]+)_(?![\w_])|<(https?:\/\/[^>\s]+)>|(?<![\w])(https?:\/\/[^\s<>\x60"*“”‘’«»…。，、；：！？（）「」『』【】]+)|\[([^\]\n]+)\]\(([^)\n]*)\)|!\[([^\]\n]*)\]\(([^)\n]*)\)|${MATH}`,
  "g",
);

export function parseInline(source: string | null | undefined): InlinePart[] {
  const text = String(source ?? "");
  const parts: InlinePart[] = [];
  let cursor = 0;
  for (const match of text.matchAll(INLINE)) {
    if (match.index > cursor) pushPlain(parts, text.slice(cursor, match.index));
    const math = mathPart(match, 14);
    if (match[2]) parts.push({ type: "link", text: match[1] ?? "", href: match[2] });
    else if (match[3]) parts.push({ type: "code", text: (match[4] ?? "").replace(/^ (.*\S.*) $/, "$1") });
    else if (match[5] != null) parts.push({ type: "strong", text: match[5] });
    else if (match[6] != null || match[7] != null) parts.push({ type: "em", text: match[6] ?? match[7] ?? "" });
    else if (match[8] && isWebAddress(match[8])) parts.push({ type: "link", text: match[8], href: match[8] });
    else if (match[9]) pushAutolink(parts, match[9]);
    else if (match[10] != null) pushFileLink(parts, match[10], match[11] ?? "", match[0]);
    else if (match[12] != null) pushImage(parts, match[12], match[13] ?? "", match[0]);
    else if (math) parts.push(math);
    else pushPlain(parts, match[0] === "\\$" ? "$" : match[0]);
    cursor = match.index + match[0].length;
  }
  if (cursor < text.length) pushPlain(parts, text.slice(cursor));
  return parts.filter((part) => part.text.length > 0);
}

// A link target as written: </path with spaces> loses its brackets, file:///path becomes the path.
function localHref(rawHref: string): string {
  let href = rawHref.trim();
  if (href.startsWith("<") && href.endsWith(">")) href = href.slice(1, -1).trim();
  if (!href.startsWith("file://")) return href;
  try {
    return decodeURIComponent(new URL(href).pathname);
  } catch {
    return "";
  }
}

// A file a board ticket keeps, by its route on the board API, which names no file type.
const BOARD_FILE = /^\/api\/board\/tasks\/[A-Za-z0-9_-]+\/files\/[A-Za-z0-9_-]+$/;

// ![alt](/abs/shot.png), or a path relative to the session folder, is a picture shown inline when it
// names a picture file, and a video when it names a video file. A picture on the web is shown inline too,
// and a video on the web stays a link. Anything else stays as written.
function pushImage(parts: InlinePart[], alt: string, rawHref: string, whole: string) {
  const href = localHref(rawHref);
  const text = alt.trim() || href.split("/").pop() || "";
  if (isWebAddress(href)) {
    const { protocol, pathname } = new URL(href);
    if (/^https?:$/.test(protocol) && /\.(?:png|jpe?g|gif|webp|bmp|avif|svg)$/i.test(pathname)) {
      parts.push({ type: "webImage", text, href });
      return;
    }
    // A web address that is no picture or video was an exclamation mark before a link ("Done![PR](…)").
    if (!/\.(?:png|jpe?g|gif|webp|bmp|avif|svg|mp4|m4v|mov|webm)(?:[?#].*)?$/i.test(pathname)) pushPlain(parts, "!");
    parts.push({ type: "link", text: alt.trim() ? alt : text, href });
    return;
  }
  const local = href && !href.startsWith("//") && !/^[a-z][a-z0-9+.-]*:/i.test(href);
  if (local && (/\.(?:png|jpe?g|gif|webp|bmp|avif)$/i.test(href) || BOARD_FILE.test(href))) parts.push({ type: "image", text, path: href });
  else if (local && /\.(?:mp4|m4v|mov|webm)$/i.test(href)) parts.push({ type: "video", text, path: href });
  else pushPlain(parts, whole);
}

// [name](/abs/path), [name](</path with spaces>) or [name](file:///path), with an optional
// :12, :12:3 or #L12 for the line. Anything else stays as written.
function pushFileLink(parts: InlinePart[], text: string, rawHref: string, whole: string) {
  if (isShortTicketHref(rawHref)) {
    parts.push({ type: "link", text, href: rawHref });
    return;
  }
  const href = localHref(rawHref);
  // A label that shows a web address must not lead somewhere else.
  if (!text.trim() || /:\/\//.test(text) || !href.startsWith("/") || href.startsWith("//")) {
    pushPlain(parts, whole);
    return;
  }
  const suffix = /(?:#L(\d+)(?:C\d+)?(?:-L\d+)?|:(\d+)(?::\d+)?)$/.exec(href);
  const line = suffix ? Number(suffix[1] ?? suffix[2]) : undefined;
  const path = suffix ? href.slice(0, suffix.index) : href;
  parts.push(line ? { type: "file", text, path, line } : { type: "file", text, path });
}

// Plain text with math in it, for text that shows no other Markdown: Codex's step headings in a thought.
// A fence (closed or still open) and a code span stay as they are written, math inside them too.
const MATH_TEXT = new RegExp(
  String.raw`${FENCE_START}(\x60{3,})[\s\S]*?(?:\n[ \t>]*\1|$)|(?<!\x60)(\x60+)(?!\x60)[^\n]*?(?<!\x60)\2(?!\x60)|${MATH}`,
  "g",
);

export function parseMathText(source: string | null | undefined): MathTextPart[] {
  const text = String(source ?? "");
  const parts: MathTextPart[] = [];
  let cursor = 0;
  for (const match of text.matchAll(MATH_TEXT)) {
    const math = mathPart(match, 3);
    if (!math) continue;
    if (match.index > cursor) parts.push({ type: "text", text: text.slice(cursor, match.index) });
    parts.push(math);
    cursor = match.index + match[0].length;
  }
  if (cursor < text.length) parts.push({ type: "text", text: text.slice(cursor) });
  return parts;
}

// The math in a match of MATH whose groups start at `first`: $$ and \[ are display math, \( and $ inline.
function mathPart(match: RegExpMatchArray, first: number): MathPart | null {
  for (let group = first; group < first + 4; group++) {
    const tex = match[group]?.trim();
    if (tex) return { type: "math", text: tex, display: group < first + 2 };
  }
  return null;
}

function pushPlain(parts: InlinePart[], text: string) {
  const last = parts[parts.length - 1];
  if (last?.type === "text") last.text += text;
  else parts.push({ type: "text", text });
}

// A bare address swallows the sentence mark after it. Give that mark back, and
// keep a closing bracket that belongs to the address itself.
function pushAutolink(parts: InlinePart[], raw: string) {
  const href = trimAutolink(raw);
  if (!isWebAddress(href)) {
    pushPlain(parts, raw);
    return;
  }
  parts.push({ type: "link", text: href, href });
  if (href.length < raw.length) pushPlain(parts, raw.slice(href.length));
}

function isWebAddress(href: string) {
  try {
    return /[\p{L}\p{N}]/u.test(new URL(href).hostname);
  } catch {
    return false;
  }
}

const brackets = [
  ["(", ")"],
  ["[", "]"],
  ["{", "}"],
] as const;

function trimAutolink(raw: string): string {
  // How many more closers than openers the address has, per bracket.
  const surplus = new Map<string, number>();
  for (const [open, close] of brackets) {
    let count = 0;
    for (const ch of raw) count += ch === close ? 1 : ch === open ? -1 : 0;
    surplus.set(close, count);
  }
  let end = raw.length;
  while (end > 0) {
    const last = raw[end - 1] ?? "";
    const extra = surplus.get(last) ?? 0;
    if (".,;:!?'".includes(last)) end -= 1;
    else if (extra > 0) {
      surplus.set(last, extra - 1);
      end -= 1;
    } else break;
  }
  return raw.slice(0, end);
}
