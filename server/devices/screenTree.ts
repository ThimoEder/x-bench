// The device screen's accessibility tree for the simulator tools: the helper's describe JSON on iOS and
// uiautomator's XML on Android, read into one shape and written as lines with refs. Frames are in points
// (dp on Android), the same units as screenshots and taps.

import { isRecord } from "../../bridge/lenient.ts";
import type { Point } from "./deviceMath.ts";
import { clean } from "../mcp/mcp.ts";

export interface Frame {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface ScreenNode {
  role: string;
  label: string;
  id: string;
  value: string;
  frame: Frame | null;
  enabled: boolean;
  // Android's clickable, or a control role on iOS.
  actionable: boolean;
  flags: string[];
  children: ScreenNode[];
}

export interface ScreenRef {
  point: Point;
  label: string;
}

export interface WrittenTree {
  lines: string[];
  refs: Map<string, ScreenRef>;
}

const IOS_CONTROLS = new Set([
  "Button",
  "Link",
  "TextField",
  "SecureTextField",
  "SearchField",
  "TextView",
  "Switch",
  "Toggle",
  "Slider",
  "Stepper",
  "Cell",
  "Tab",
  "TabBarButton",
  "MenuItem",
  "PopUpButton",
  "SegmentedControl",
  "Picker",
  "PickerWheel",
  "Key",
  "CheckBox",
  "RadioButton",
  "Image",
]);

const PLAIN_ROLES = new Set(["Group", "Other", "Window", "Application", "ScrollView", "Table", "CollectionView", "LayoutArea", "View", "FrameLayout", "LinearLayout", "RelativeLayout", "ViewGroup"]);

// The sim-helper's describe op answers an array of root elements.
export function parseDescribeUi(json: unknown): ScreenNode[] {
  return Array.isArray(json) ? json.map(iosNode).filter((node): node is ScreenNode => node !== null) : [];
}

function iosNode(raw: unknown): ScreenNode | null {
  if (!isRecord(raw)) return null;
  const type = text(raw.type) || text(raw.role).replace(/^AX/, "") || "Element";
  const traits = Array.isArray(raw.traits) ? raw.traits.map(text) : [];
  const flags: string[] = [];
  for (const trait of traits) {
    const lower = trait.toLowerCase();
    if (lower === "selected") flags.push("selected");
    if (lower === "notenabled") flags.push("disabled");
  }
  const children = Array.isArray(raw.children) ? raw.children.map(iosNode).filter((node): node is ScreenNode => node !== null) : [];
  return {
    role: type,
    label: clean(raw.AXLabel) || clean(raw.title),
    id: clean(raw.AXUniqueId),
    value: clean(raw.AXValue),
    frame: frameOf(raw.frame) ?? rectOf(text(raw.AXFrame)),
    enabled: raw.enabled !== false,
    actionable: IOS_CONTROLS.has(type),
    flags,
    children,
  };
}

// "{{x, y}, {w, h}}", the AXFrame string.
function rectOf(value: string): Frame | null {
  const match = /\{\{\s*(-?[\d.]+),\s*(-?[\d.]+)\s*\},\s*\{\s*([\d.]+),\s*([\d.]+)\s*\}\}/.exec(value);
  if (!match) return null;
  return { x: Number(match[1]), y: Number(match[2]), width: Number(match[3]), height: Number(match[4]) };
}

function frameOf(value: unknown): Frame | null {
  if (!isRecord(value)) return null;
  const x = Number(value.x);
  const y = Number(value.y);
  const width = Number(value.width);
  const height = Number(value.height);
  return [x, y, width, height].every(Number.isFinite) ? { x, y, width, height } : null;
}

// uiautomator dump's XML. scale is pixels per dp, so frames come out in dp.
export function parseUiautomator(xml: string, scale: number): ScreenNode[] {
  const roots: ScreenNode[] = [];
  const stack: ScreenNode[] = [];
  const tag = /<node\b([^>]*?)(\/?)>|<\/node>/g;
  for (let match = tag.exec(xml); match; match = tag.exec(xml)) {
    if (match[0] === "</node>") {
      stack.pop();
      continue;
    }
    const attrs = attributes(match[1] ?? "");
    const node = androidNode(attrs, scale);
    const parent = stack[stack.length - 1];
    if (parent) parent.children.push(node);
    else roots.push(node);
    if (match[2] !== "/") stack.push(node);
  }
  for (const root of roots) nameRows(root);
  return roots;
}

// A clickable Android row is often a layout around its texts, so it takes their words as its label.
function nameRows(node: ScreenNode): void {
  for (const child of node.children) nameRows(child);
  if (!node.actionable || node.label) return;
  const words: string[] = [];
  const collect = (item: ScreenNode) => {
    for (const child of item.children) {
      if (words.length >= 2) return;
      if (child.label && !child.actionable) words.push(child.label);
      else if (!child.actionable) collect(child);
    }
  };
  collect(node);
  node.label = words.join(" · ");
}

function androidNode(attrs: Record<string, string>, scale: number): ScreenNode {
  const className = attrs.class ?? "";
  const role = className.slice(className.lastIndexOf(".") + 1) || "View";
  const bounds = /\[(-?\d+),(-?\d+)\]\[(-?\d+),(-?\d+)\]/.exec(attrs.bounds ?? "");
  const per = scale > 0 ? scale : 1;
  const frame = bounds
    ? {
        x: round(Number(bounds[1]) / per),
        y: round(Number(bounds[2]) / per),
        width: round((Number(bounds[3]) - Number(bounds[1])) / per),
        height: round((Number(bounds[4]) - Number(bounds[2])) / per),
      }
    : null;
  const flags: string[] = [];
  if (attrs.checked === "true") flags.push("checked");
  if (attrs.selected === "true") flags.push("selected");
  if (attrs.focused === "true") flags.push("focused");
  if (attrs.enabled === "false") flags.push("disabled");
  const resource = attrs["resource-id"] ?? "";
  const text = clean(attrs.text);
  const description = clean(attrs["content-desc"]);
  return {
    role,
    label: text || description,
    id: resource.includes(":id/") ? resource.slice(resource.indexOf(":id/") + 4) : resource,
    value: text && description && text !== description ? description : "",
    frame,
    enabled: attrs.enabled !== "false",
    actionable: attrs.clickable === "true" || attrs["long-clickable"] === "true" || attrs.checkable === "true" || role === "EditText",
    flags,
    children: [],
  };
}

function attributes(source: string): Record<string, string> {
  const attrs: Record<string, string> = {};
  const pattern = /([\w:-]+)="([^"]*)"/g;
  for (let match = pattern.exec(source); match; match = pattern.exec(source)) attrs[match[1] ?? ""] = unescapeXml(match[2] ?? "");
  return attrs;
}

function unescapeXml(value: string): string {
  return value.replace(/&(#x?[0-9a-f]+|amp|lt|gt|quot|apos);/gi, (whole, code: string) => {
    const named: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'" };
    if (named[code.toLowerCase()]) return named[code.toLowerCase()] ?? whole;
    const number = code.startsWith("#x") || code.startsWith("#X") ? Number.parseInt(code.slice(2), 16) : Number.parseInt(code.slice(1), 10);
    return Number.isFinite(number) ? String.fromCodePoint(number) : whole;
  });
}

// One line per element worth naming, indented by depth. Controls and labelled elements with a frame get a
// ref like e4, whose center a tap can use. Layout containers without a name fold into their children.
// Elements without a frame, or entirely outside the screen (a hidden keyboard, other home screen pages),
// are left out.
export function writeTree(roots: ScreenNode[], interactiveOnly = false): WrittenTree {
  const lines: string[] = [];
  const refs = new Map<string, ScreenRef>();
  const screen = screenOf(roots);
  const walk = (node: ScreenNode, depth: number) => {
    const named = Boolean(node.label || node.value);
    const plain = PLAIN_ROLES.has(node.role) || /Image(View)?$/.test(node.role) ? !named : false;
    const visible = Boolean(node.frame && node.frame.width > 0 && node.frame.height > 0 && (!screen || overlaps(node.frame, screen)));
    const shown = visible && !plain && (interactiveOnly ? node.actionable : named || node.actionable || Boolean(node.id));
    if (shown) {
      let line = `${"  ".repeat(depth)}- ${node.role}`;
      if (node.label) line += ` "${node.label}"`;
      if (node.id) line += ` id=${node.id}`;
      if (node.value && node.value !== node.label) line += ` value="${node.value}"`;
      for (const flag of node.flags) line += ` ${flag}`;
      if (!node.enabled && !node.flags.includes("disabled")) line += " disabled";
      const frame = node.frame;
      if (frame) {
        line += ` (${round(frame.x)},${round(frame.y)} ${round(frame.width)}×${round(frame.height)})`;
        const ref = `e${refs.size + 1}`;
        // An element partly off the screen is tapped at the middle of the part that shows.
        const shown = screen ? visiblePart(frame, screen) : frame;
        refs.set(ref, {
          point: { x: round(shown.x + shown.width / 2), y: round(shown.y + shown.height / 2) },
          label: nameOf(node),
        });
        line += ` [${ref}]`;
      }
      lines.push(line);
    }
    for (const child of node.children) walk(child, shown ? depth + 1 : depth);
  };
  for (const root of roots) walk(root, 0);
  return { lines, refs };
}

// The element on the screen whose label, id or value is query, ignoring case, else the first that contains it.
// Among equal matches a control wins, then the first in reading order. null when nothing that shows matches.
export function findElement(roots: ScreenNode[], query: string): ScreenRef | null {
  const wanted = query.trim().toLowerCase();
  if (!wanted) return null;
  const screen = screenOf(roots);
  let best: { score: number; ref: ScreenRef } | null = null;
  const walk = (node: ScreenNode) => {
    const frame = node.frame;
    if (frame && frame.width > 0 && frame.height > 0 && (!screen || overlaps(frame, screen))) {
      const fields = [node.label, node.id, node.value].map((field) => field.toLowerCase());
      const match = fields.includes(wanted) ? 2 : fields.some((field) => field.includes(wanted)) ? 1 : 0;
      const score = match ? match * 2 + Number(node.actionable) : 0;
      if (score > (best?.score ?? 0)) {
        const shown = screen ? visiblePart(frame, screen) : frame;
        best = { score, ref: { point: { x: round(shown.x + shown.width / 2), y: round(shown.y + shown.height / 2) }, label: nameOf(node) } };
      }
    }
    for (const child of node.children) walk(child);
  };
  for (const root of roots) walk(root);
  return (best as { ref: ScreenRef } | null)?.ref ?? null;
}

function screenOf(roots: ScreenNode[]): Frame | null {
  return roots.map((root) => root.frame).find((frame) => frame && frame.width > 0 && frame.height > 0) ?? null;
}

function nameOf(node: ScreenNode): string {
  return `${node.role}${node.label ? ` "${node.label}"` : node.id ? ` ${node.id}` : ""}`;
}

function visiblePart(frame: Frame, screen: Frame): Frame {
  const x = Math.max(frame.x, screen.x);
  const y = Math.max(frame.y, screen.y);
  return { x, y, width: Math.min(frame.x + frame.width, screen.x + screen.width) - x, height: Math.min(frame.y + frame.height, screen.y + screen.height) - y };
}

function overlaps(frame: Frame, screen: Frame): boolean {
  return frame.x < screen.x + screen.width && frame.x + frame.width > screen.x && frame.y < screen.y + screen.height && frame.y + frame.height > screen.y;
}

// One decimal, enough for positions in points.
export function round(value: number): number {
  return Math.round(value * 10) / 10;
}


function text(value: unknown): string {
  return typeof value === "string" ? value : "";
}

