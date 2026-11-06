// The conversation a chat carries to another provider, sent in front of the first message on the new provider.
// A short conversation goes whole. A longer one goes as a summary the old model writes, followed by the latest
// exchanges with every long message shortened. Without a summary, the newest part goes as text. The person's
// message bubble never shows it.

import { randomUUID } from "node:crypto";

// What the handoff reads of a transcript item, live or frozen.
export interface HandoffItem {
  type: "user" | "assistant" | "thought" | "tool";
  text?: string;
  title?: string;
  name?: string;
  kind?: string;
  parentId?: string;
  hidden?: boolean;
}

// Each handoff's tags carry a random ref, so a message that quotes the closing tag cannot end it early.
export const HANDOFF_OPEN = "<x-bench-handoff";
// A conversation up to this many tokens goes whole.
export const WHOLE_LIMIT = 8_000;
// Without a summary, the most of the conversation that goes as text: a quarter of the new model's window, at most this.
export const TEXT_CEILING = 50_000;
// The most of the old model's summary that is passed on.
export const SUMMARY_LIMIT = 6_000;
// After a summary: the latest exchanges, each message at most MESSAGE_LIMIT and all of them at most RECENT_LIMIT.
export const MESSAGE_LIMIT = 1_500;
export const RECENT_LIMIT = 4_000;
const RECENT_EXCHANGES = 2;
const TOOL_TITLE_MAX = 120;

// One stretch of the conversation and the name its replies go under.
export interface Spoken {
  speaker: string;
  items: readonly HandoffItem[];
}

export interface Handoff {
  text: string;
  tokens: number;
  // Earlier entries were left out.
  cut: boolean;
  summarized: boolean;
}

// One message, or the tool calls between two messages.
interface Entry {
  from: string;
  tools: boolean;
  text: string;
}

// The most a conversation may take whole: WHOLE_LIMIT, or a quarter of a smaller model's window.
export function wholeLimit(window: number | null | undefined): number {
  return window && window > 0 ? Math.min(WHOLE_LIMIT, Math.floor(window / 4)) : WHOLE_LIMIT;
}

// Close enough for a limit: tokenizers average about four characters a token on English and code.
export function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

function toolTitle(item: HandoffItem) {
  const title = (item.title || item.name || item.kind || "Tool").replace(/\s+/g, " ").trim();
  return title.length > TOOL_TITLE_MAX ? `${title.slice(0, TOOL_TITLE_MAX - 1)}…` : title;
}

function entriesOf({ speaker, items }: Spoken): Entry[] {
  const entries: Entry[] = [];
  let tools: string[] = [];
  items = withoutSummaryTurns(items);
  const flush = () => {
    if (tools.length) entries.push({ from: speaker, tools: true, text: tools.map((tool) => `[${tool}]`).join(" ") });
    tools = [];
  };
  for (const item of items) {
    if (item.type === "tool") {
      if (!item.parentId) tools.push(toolTitle(item));
      continue;
    }
    if (item.type === "thought" || item.hidden) continue;
    const text = (item.type === "user" ? stripHandoff(item.text ?? "") : (item.text ?? "")).trim();
    if (!text) continue;
    flush();
    entries.push({ from: item.type === "user" ? "User" : speaker, tools: false, text });
  }
  flush();
  return entries;
}

// A long message keeps its start and its end, with how much was left out between them.
export function shorten(text: string, limit: number): string {
  if (estimateTokens(text) <= limit) return text;
  const head = Math.floor(limit * 4 * 0.8);
  const tail = Math.floor(limit * 4 * 0.15);
  const left = text.length - head - tail;
  return `${text.slice(0, head)}\n[… ${left.toLocaleString("en-US")} characters left out …]\n${text.slice(text.length - tail)}`;
}

// Each entry between tags of its own, so a long message cannot swallow the one after it.
function render(entry: Entry, limit = Number.POSITIVE_INFINITY): string {
  const tag = entry.tools ? "tools" : "message";
  // A closing tag quoted inside a message would end that entry early.
  const text = shorten(entry.text, limit).replace(/<\/(message|tools)/g, "<\\/$1");
  return `<${tag} from="${entry.from}">\n${text}\n</${tag}>`;
}

// Whether the stretches hold anything to hand over: a message or a tool call.
export function anyEntries(stretches: Spoken[]): boolean {
  return stretches.some((stretch) => entriesOf(stretch).length > 0);
}


function names(stretches: Spoken[]) {
  return [...new Set(stretches.map((stretch) => stretch.speaker))].join(", then ");
}

function wrap(parts: string[]): string {
  const ref = randomUUID().slice(0, 8);
  return `${HANDOFF_OPEN} ref="${ref}">\n${parts.join("\n\n")}\n</x-bench-handoff ref="${ref}">`;
}

// The whole conversation as text.
export function wholeHandoff(stretches: Spoken[]): Handoff {
  const head = `This chat continues a conversation that ran on ${names(stretches)}. It follows whole, one tag per message and one per run of tool calls. Tool output is not included, so read files again before relying on them.`;
  const text = wrap([head, ...stretches.flatMap(entriesOf).map((entry) => render(entry))]);
  return { text, tokens: estimateTokens(text), cut: false, summarized: false };
}

// Without a summary, as text: the newest entries first, until a quarter of the new model's window is used. Only a
// message that alone would take a third of that is shortened, so answers with tables, diagrams and code go whole.
export function textLimit(window: number | null | undefined): number {
  return window && window > 0 ? Math.min(TEXT_CEILING, Math.floor(window / 4)) : TEXT_CEILING;
}

export function textHandoff(stretches: Spoken[], limit: number): Handoff {
  const entries = stretches.flatMap(entriesOf);
  const kept: string[] = [];
  let used = 0;
  for (let index = entries.length - 1; index >= 0; index -= 1) {
    const text = render(entries[index]!, Math.floor(limit / 3));
    const cost = estimateTokens(text);
    if (used + cost > limit) break;
    kept.unshift(text);
    used += cost;
  }
  const cut = kept.length < entries.length;
  const head = `This chat continues a conversation that ran on ${names(stretches)}. It follows as text, one tag per message and one per run of tool calls${cut ? ", newest entries only: the earlier part did not fit" : ""}. A very long message is shortened. Tool output is not included, so read files again before relying on them.`;
  const text = wrap([head, ...kept]);
  return { text, tokens: estimateTokens(text), cut, summarized: false };
}

export function needsSummary(stretches: Spoken[], window: number | null | undefined): boolean {
  return wholeHandoff(stretches).tokens > wholeLimit(window);
}

// The latest exchanges, from the user message RECENT_EXCHANGES back, each message shortened. The oldest go first
// when they do not fit together.
function recentEntries(entries: Entry[]): { kept: string[]; cut: boolean } {
  let start = entries.length;
  let asks = 0;
  for (let index = entries.length - 1; index >= 0; index -= 1) {
    start = index;
    if (entries[index]!.from === "User" && !entries[index]!.tools && ++asks === RECENT_EXCHANGES) break;
  }
  const kept: string[] = [];
  let used = 0;
  for (let index = entries.length - 1; index >= start; index -= 1) {
    const text = render(entries[index]!, MESSAGE_LIMIT);
    const cost = estimateTokens(text);
    if (used + cost > RECENT_LIMIT) break;
    kept.unshift(text);
    used += cost;
  }
  return { kept, cut: entries.length > kept.length };
}

// The old model's summary, then the latest exchanges. Without a summary only the latest exchanges go.
export function summaryHandoff(stretches: Spoken[], summary: string | null): Handoff {
  const recent = recentEntries(stretches.flatMap(entriesOf));
  const parts = summary
    ? [
        `This chat continues a conversation that ran on ${names(stretches)}. The model it ran on summarized it below. The latest exchanges follow the summary, one tag per message, with long messages shortened. Tool output is not included, so read files again before relying on them.`,
        `<summary>\n${shorten(summary.trim(), SUMMARY_LIMIT)}\n</summary>`,
        ...recent.kept,
      ]
    : [
        `This chat continues a conversation that ran on ${names(stretches)}. Only its latest exchanges follow, one tag per message, with long messages shortened. The earlier part is left out. Ask the person if you need it.`,
        ...recent.kept,
      ];
  const text = wrap(parts);
  return { text, tokens: estimateTokens(text), cut: recent.cut, summarized: Boolean(summary) };
}

export function withHandoff(handoff: string, text: string): string {
  return `${handoff}\n\n${text}`;
}

// The person's own words of a message that carried a handoff.
export function stripHandoff(text: string): string {
  const open = /^<x-bench-handoff(?: ref="(\w+)")?>/.exec(text);
  if (!open) return text;
  const close = open[1] ? `</x-bench-handoff ref="${open[1]}">` : "</x-bench-handoff>";
  const end = text.indexOf(close);
  if (end < 0) return text;
  return text.slice(end + close.length).replace(/^\s+/, "");
}

// The turn that asked the old model for a summary, which stays in its session when a switch is cancelled or the
// chat comes back to it. It is never shown or passed on: the request, and everything up to the next message.
export function withoutSummaryTurns<T extends HandoffItem>(items: readonly T[]): T[] {
  const kept: T[] = [];
  let inside = false;
  for (const item of items) {
    // A hidden message the harness adds (a background task's notice) belongs to the turn it lands in.
    if (item.type === "user" && !item.hidden) inside = stripHandoff(item.text ?? "").trim() === SUMMARY_REQUEST;
    if (!inside) kept.push(item);
  }
  return kept;
}

export const SUMMARY_REQUEST = `This conversation moves to another model, which gets your summary and the last two exchanges in place of the full history. Write that summary now, at most about 4,000 words. Cover the goal, what was decided and why, what was changed and in which files, what is still open, and anything the next model must not get wrong. Copy verbatim what the next model may need exactly: tables, diagrams such as Mermaid blocks, key code, commands, numbers and names. For long material the person pasted, say what it was and keep only the parts the conversation relied on. Use Markdown, and do not use tools for it. This request ends with your summary: afterwards, carry on as usual, tools included.`;
