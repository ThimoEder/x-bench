import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import type { RenderOptions } from "beautiful-mermaid";
import type { MermaidConfig } from "mermaid";
import { flowchartOf } from "./diagramFlowchart.ts";
import { keepToItself } from "./svgSafety.ts";
import type { Theme } from "../../theme.ts";

// Mermaid diagrams in Markdown. Flowchart, sequence, state, class, ER and xychart diagrams are drawn by
// beautiful-mermaid, which looks like the app, and so are C4, mindmap, architecture, requirement and
// timeline diagrams, told again as flowcharts. Mermaid draws the rest (pie, gantt, gitGraph, ...), and
// checks each block first, so a block Mermaid cannot parse stays code. Both are large, so they load by
// dynamic import the first time a closed mermaid block is drawn; a page without diagrams fetches neither.

export type Drawn = { svg: string } | { error: string };

// The parts of each library this module calls, so tests can hand in their own.
export interface DiagramRenderer {
  initialize(config: MermaidConfig): void;
  parse(text: string): Promise<unknown>;
  render(id: string, text: string): Promise<{ svg: string }>;
  // A flowchart's node ids and edge count as Mermaid reads them, or null for other kinds.
  outline(text: string): Promise<Outline | null>;
  // Another kind told again as a flowchart (see diagramFlowchart.ts), or null to draw it as it is.
  flowchart(text: string): Promise<string | null>;
}

export interface PrettyRenderer {
  render(text: string, options: RenderOptions): string;
  outline(text: string): Outline | null;
}

export interface Outline {
  nodes: string[];
  edges: number;
}

export interface DiagramLoaders {
  mermaid: () => Promise<DiagramRenderer>;
  pretty: () => Promise<PrettyRenderer>;
  purify: () => Promise<(svg: string) => string>;
}

// DOMPurify's SVG profile keeps the diagram's shapes, markers and its own <style>, and drops scripts,
// event handlers and foreign HTML. It runs after keepToItself (svgSafety.ts), which removes what DOMPurify
// keeps: addresses outside the page, in attributes and in <style>.
const PURIFY = { USE_PROFILES: { svg: true, svgFilters: true }, ADD_TAGS: ["style"] };

const realLoaders: DiagramLoaders = {
  mermaid: async () => {
    const mermaid = (await import("mermaid")).default;
    return {
      initialize: (config) => mermaid.initialize(config),
      parse: (text) => mermaid.parse(text),
      render: (id, text) => mermaid.render(id, text),
      async outline(text) {
        const { db } = await mermaid.mermaidAPI.getDiagramFromText(text);
        const flow = db as unknown as { getVertices?: () => Map<string, unknown>; getEdges?: () => unknown[] };
        if (!flow.getVertices || !flow.getEdges) return null;
        return { nodes: [...flow.getVertices().keys()], edges: flow.getEdges().length };
      },
      async flowchart(text) {
        const { type, db } = await mermaid.mermaidAPI.getDiagramFromText(text);
        return flowchartOf({ type, db: db as unknown as Record<string, unknown> });
      },
    };
  },
  pretty: async () => {
    const { parseMermaid, renderMermaidSVG } = await import("beautiful-mermaid");
    return {
      render: renderMermaidSVG,
      outline(text) {
        if (!FLOWCHART.test(text.trimStart())) return null;
        const graph = parseMermaid(text);
        return { nodes: [...graph.nodes.keys()], edges: graph.edges.length };
      },
    };
  },
  purify: async () => {
    // An instance of our own: Mermaid uses the shared one and sets and clears hooks on it.
    const purify = (await import("dompurify")).default(window);
    return (svg) => purify.sanitize(svg, PURIFY);
  },
};

const FLOWCHART = /^(?:graph|flowchart)\b/i;
let loaders = realLoaders;

// Tests swap in fakes. null puts the real libraries back.
export function setDiagramLoaders(next: Partial<DiagramLoaders> | null): void {
  loaders = { ...realLoaders, ...next };
  drawn.clear();
}

export function isDiagramLang(lang: string): boolean {
  return lang.trim().toLowerCase() === "mermaid";
}

// Diagram text comes from the agent, so it is untrusted: strict security (labels are text, no click
// handlers or scripts), no HTML labels, and none of these keys can be changed by an %%{init}%% directive
// or front matter in the diagram. The theme keys are locked too, so a diagram always follows the app.
export function diagramConfig(theme: Theme, palette: Record<string, string> = {}): MermaidConfig {
  return {
    startOnLoad: false,
    securityLevel: "strict",
    htmlLabels: false,
    suppressErrorRendering: true,
    theme: "base",
    darkMode: theme === "dark",
    themeVariables: palette,
    secure: ["secure", "securityLevel", "startOnLoad", "maxTextSize", "suppressErrorRendering", "maxEdges", "htmlLabels", "dompurifyConfig", "theme", "themeVariables", "themeCSS", "darkMode"],
  };
}

// Mermaid's base theme derives its colours from a few variables. They come from the page's own tokens in
// styles.css, so a diagram sits on its code panel like the code it replaces.
const PALETTE: Record<string, string> = {
  background: "--sidebar",
  mainBkg: "--chip",
  primaryColor: "--chip",
  secondaryColor: "--fill",
  tertiaryColor: "--card-2",
  primaryBorderColor: "--soft",
  primaryTextColor: "--text",
  secondaryTextColor: "--text",
  tertiaryTextColor: "--text",
  textColor: "--text",
  lineColor: "--muted",
  noteBkgColor: "--card-3",
  noteTextColor: "--text",
  noteBorderColor: "--soft",
  clusterBkg: "--card-2",
  clusterBorder: "--quiet",
  edgeLabelBackground: "--sidebar",
};

function pagePalette(): Record<string, string> {
  const style = globalThis.getComputedStyle?.(document.documentElement);
  const palette: Record<string, string> = {};
  if (!style) return palette;
  for (const [name, token] of Object.entries(PALETTE)) {
    const value = style.getPropertyValue(token).trim();
    if (value) palette[name] = value;
  }
  const font = globalThis.getComputedStyle(document.body).fontFamily;
  if (font) palette.fontFamily = font;
  return palette;
}

// Drawn diagrams by theme, colours and text, so a bubble that mounts again (another session, a reload of the
// list) shows its diagram at once instead of its code first.
const drawn = new Map<string, Drawn>();
const KEEP = 48;
let queue: Promise<unknown> = Promise.resolve();
// Mermaid removes any element that has the id it draws under, so ids never repeat, even across a hot
// reload of this module.
const idPrefix = `x-mermaid-${Math.random().toString(36).slice(2, 8)}`;
let count = 0;

function remember(key: string, result: Drawn) {
  drawn.delete(key);
  drawn.set(key, result);
  if (drawn.size > KEEP) drawn.delete(drawn.keys().next().value ?? "");
}

// Mermaid paints the page's colours into its diagram, so one is kept per theme and colours.
function lookOf(theme: Theme): string {
  return globalThis.document?.documentElement.dataset.colors === "classic" ? `classic ${theme}` : theme;
}

// A diagram drawn by beautiful-mermaid follows the theme through CSS variables, so it is kept for every look.
export function drawnDiagram(text: string, theme: Theme): Drawn | undefined {
  return drawn.get(`*\n${text}`) ?? drawn.get(`${lookOf(theme)}\n${text}`);
}

// Mermaid's config is global, so diagrams are drawn one at a time, each with its own theme. The page's
// colours are read now, while the page is in that theme: the draw may run after a theme switch, and would
// then paint the other theme's colours into a diagram kept under this one.
export function drawDiagram(text: string, theme: Theme): Promise<Drawn> {
  const known = drawnDiagram(text, theme);
  if (known) return Promise.resolve(known);
  const palette = pagePalette();
  const look = lookOf(theme);
  const job = queue.then(async (): Promise<Drawn> => {
    // The same diagram may have been queued twice, by two blocks or a bubble that mounted again.
    const done = drawnDiagram(text, theme);
    if (done) return done;
    const { themeless, unloaded, ...result } = await draw(text, theme, palette);
    // A library that did not load is not remembered: the next block tries the import again.
    if (!unloaded) remember(`${themeless ? "*" : look}\n${text}`, result);
    return result;
  });
  queue = job;
  return job;
}

type Drawing = Drawn & { themeless?: boolean; unloaded?: boolean };

async function draw(text: string, theme: Theme, palette: Record<string, string>): Promise<Drawing> {
  let mermaid: DiagramRenderer;
  let purify: (svg: string) => string;
  try {
    [mermaid, purify] = await Promise.all([loaders.mermaid(), loaders.purify()]);
  } catch (error) {
    return { error: `Mermaid did not load: ${firstLine(error)}`, unloaded: true };
  }
  const id = `${idPrefix}-${++count}`;
  // Whichever library drew it, nothing in the diagram may point outside the page.
  const finish = (svg: string) => {
    const kept = keepToItself(svg);
    if (kept == null) throw new Error("The diagram could not be checked");
    return purify(kept);
  };
  try {
    mermaid.initialize(diagramConfig(theme, palette));
    const source = await parsed(mermaid, text);
    // A kind beautiful-mermaid does not draw may still be boxes and arrows it does.
    const pretty = prettyText(source) ?? prettyText((await mermaid.flowchart(source).catch(() => null)) ?? "");
    if (pretty != null) {
      const svg = await drawPretty(pretty, id, () => mermaid.outline(source));
      if (svg) return { svg: finish(svg), themeless: true };
    }
    const { svg } = await mermaid.render(id, source);
    return svg ? { svg: finish(naturalWidth(svg)) } : { error: "Mermaid drew nothing" };
  } catch (error) {
    return { error: firstLine(error) };
  } finally {
    // Mermaid measures in a scratch element on the body. Make sure a failed draw leaves none behind.
    document.getElementById(id)?.remove();
    document.getElementById(`d${id}`)?.remove();
  }
}

// The text to draw: the block itself, or, when Mermaid cannot parse it, its repaired flowchart if that
// parses. Otherwise Mermaid's error for the block as written.
async function parsed(mermaid: DiagramRenderer, text: string): Promise<string> {
  try {
    await mermaid.parse(text);
    return text;
  } catch (error) {
    const repaired = repairFlowchart(text);
    if (repaired === text) throw error;
    try {
      await mermaid.parse(repaired);
      return repaired;
    } catch {
      throw error;
    }
  }
}

// Agents often write a flowchart label or subgraph title with brackets inside, unquoted, as in
// `host [Node host (server/)]`, `B{Ready (yet)?}` or `-->|yes (1)|`, which Mermaid reads as a shape and
// rejects. Quote such [...], {...} and edge labels. Labels that are quoted already, and the shapes that
// open with ( [ { / \ inside the bracket, are left alone.
export function repairFlowchart(text: string): string {
  if (!/^\s*(?:%%.*\n\s*)*(?:graph|flowchart)\b/i.test(text)) return text;
  return text
    .replace(/(^|[\w\s-])\[(?!["([/\\])([^\]\n"]*[(){}][^\]\n"]*)\]/g, (_all, before: string, label: string) => `${before}["${label}"]`)
    .replace(/(\w)\{(?!["{])([^}\n"]*[()[\]][^}\n"]*)\}/g, (_all, before: string, label: string) => `${before}{"${label}"}`)
    .replace(/(-->|---|-\.->|==>|--[ox]|<-->)\|(?!")([^|\n"]*[(){}[\]][^|\n"]*)\|/g, (_all, arrow: string, label: string) => `${arrow}|"${label}"|`);
}

// beautiful-mermaid's colours are CSS variables. Each is given here, from the page's --text and --sidebar,
// because it would otherwise read the page's own --line, --muted, --accent and --border, which mean other
// things. A theme switch changes the tokens, and the diagram follows without being drawn again.
const tint = (percent: number) => `color-mix(in srgb, var(--text) ${percent}%, var(--sidebar))`;
const PRETTY_COLORS: RenderOptions = {
  bg: "var(--sidebar)",
  fg: "var(--text)",
  line: tint(45),
  accent: tint(80),
  muted: tint(60),
  surface: tint(5),
  border: tint(24),
  transparent: true,
  // The code panel has its own padding.
  padding: 16,
};

// A diagram of a kind beautiful-mermaid draws, or undefined when Mermaid should draw it instead.
async function drawPretty(text: string, id: string, mermaidOutline: () => Promise<Outline | null>): Promise<string | undefined> {
  let pretty: PrettyRenderer;
  try {
    pretty = await loaders.pretty();
  } catch {
    return undefined;
  }
  try {
    // beautiful-mermaid skips flowchart syntax it does not know (an edge like --o, an edge id), which would
    // lose nodes and edges. A flowchart it reads differently from Mermaid is left to Mermaid.
    const ours = pretty.outline(text);
    if (ours && !sameOutline(ours, await mermaidOutline())) return undefined;
    return scopePretty(pretty.render(text, PRETTY_COLORS), id) || undefined;
  } catch {
    // Mermaid parsed it, so it is a diagram beautiful-mermaid does not handle in full.
    return undefined;
  }
}

function sameOutline(ours: Outline, theirs: Outline | null): boolean {
  if (!theirs) return true;
  const nodes = new Set(theirs.nodes);
  return ours.edges === theirs.edges && ours.nodes.length === nodes.size && ours.nodes.every((node) => nodes.has(node));
}

const PRETTY_HEADERS = [/^(?:graph|flowchart)(?:\s+(?:TD|TB|LR|BT|RL))?$/i, /^stateDiagram(?:-v2)?$/i, /^sequenceDiagram$/i, /^classDiagram$/i, /^erDiagram$/i, /^xychart(?:-beta)?\b/i];

// The diagram as beautiful-mermaid reads it, or null for a kind it does not draw. Front matter, %% lines and
// the lines that do not change the picture (click, accTitle, accDescr) go, since it would draw a line it
// does not know as a node; Mermaid has checked them. A flowchart without a direction gets Mermaid's TD.
export function prettyText(text: string): string | null {
  const lines = text
    .replace(/^\s*---\n[\s\S]*?\n---[^\S\n]*(?:\n|$)/, "")
    .replace(/^[^\S\n]*accDescr\s*\{[\s\S]*?\}[^\S\n]*(?:\n|$)/m, "")
    .split("\n")
    .filter((line) => !/^\s*(?:%%|click\s|accTitle\s*:|accDescr\s*:)/.test(line));
  const first = lines.findIndex((line) => line.trim());
  if (first === -1) return null;
  const header = (lines[first] ?? "").trim().replace(/;$/, "");
  if (!PRETTY_HEADERS.some((pattern) => pattern.test(header))) return null;
  lines[first] = /^(?:graph|flowchart)$/i.test(header) ? `${header} TD` : header;
  const body = lines.slice(first).join("\n");
  // Its stick figure for a sequence actor puts the name under the figure, over the first message. A box
  // reads the same and keeps clear.
  return /^sequenceDiagram$/i.test(header) ? body.replace(/^(\s*)actor(\s)/gm, "$1participant$2") : body;
}

// beautiful-mermaid's SVG is made to stand alone. Inline in the page it would load its font from Google
// Fonts, style every svg and text on the page, and share marker ids with the next diagram. The font import
// goes (the text takes the page's font), its rules are scoped to this svg, and its ids get this one's prefix.
export function scopePretty(svg: string, id: string): string {
  const ids = new Set([...svg.matchAll(/(?<![\w-])id="([^"]+)"/g)].map((match) => match[1] ?? ""));
  let out = svg.replace(/<style>([\s\S]*?)<\/style>/, (_all, css: string) => {
    const scoped = css
      .replace(/@import url\([^)]*\);?/g, "")
      .replace(/(^|\n)(\s*)text\s*\{[^}]*\}/, `$1$2#${id} text { font-family: inherit; }`)
      .replace(/(^|\n)(\s*)\.mono\s*\{/, `$1$2#${id} .mono {`)
      .replace(/(^|\n)(\s*)svg\s*\{/, `$1$2#${id} {`);
    return `<style>${scoped}</style>`;
  });
  for (const name of ids) {
    out = out
      .replaceAll(` id="${name}"`, ` id="${id}-${name}"`)
      .replaceAll(`url(#${name})`, `url(#${id}-${name})`)
      .replaceAll(`href="#${name}"`, `href="#${id}-${name}"`);
  }
  return out.replace(/^<svg\b/, `<svg id="${id}"`);
}

// Mermaid sizes a diagram to fill its box (width 100%, up to its own width), which shrinks a wide one
// until its labels cannot be read. Give it its own width instead; the box scrolls sideways.
export function naturalWidth(svg: string): string {
  const width = /^<svg[^>]*\bstyle="[^"]*max-width:\s*([\d.]+)px/.exec(svg)?.[1];
  return width ? svg.replace(/^(<svg[^>]*?\s)width="100%"/, `$1width="${width}"`) : svg;
}

function firstLine(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error ?? "");
  const line = message.split("\n").find((part) => part.trim()) ?? "";
  return line.trim().replace(/:$/, "") || "Unknown error";
}

function subscribeTheme(onChange: () => void) {
  const observer = new MutationObserver(onChange);
  observer.observe(document.documentElement, { attributes: true, attributeFilter: ["data-theme", "data-colors"] });
  return () => observer.disconnect();
}

function noSubscribe() {
  return () => {};
}

function pageLook(): string {
  return lookOf(document.documentElement.dataset.theme === "light" ? "light" : "dark");
}

// The diagram for a closed mermaid block in the page's current theme: undefined while it is drawn, and
// null when text is null (not a diagram, or a block still streaming), which loads nothing.
export function useDiagram(text: string | null): Drawn | null | undefined {
  // Only a diagram watches the theme; other code blocks do not need to.
  const look = useSyncExternalStore(text == null ? noSubscribe : subscribeTheme, pageLook, () => "dark");
  const theme: Theme = look.endsWith("light") ? "light" : "dark";
  const [result, setResult] = useState<{ key: string; drawn: Drawn } | null>(null);
  const shown = useRef<{ text: string; drawn: Drawn } | null>(null);
  const key = text == null ? null : `${look}\n${text}`;
  useEffect(() => {
    if (text == null || key == null || drawnDiagram(text, theme)) return undefined;
    let live = true;
    void drawDiagram(text, theme).then((next) => {
      if (live) setResult({ key, drawn: next });
    });
    return () => {
      live = false;
    };
  }, [key, text, theme]);
  if (text == null) return null;
  const current = drawnDiagram(text, theme) ?? (result?.key === key ? result.drawn : undefined);
  if (current) shown.current = { text, drawn: current };
  // After a theme switch the diagram in the old theme stays up until the new one is drawn.
  return current ?? (shown.current?.text === text ? shown.current.drawn : undefined);
}
