import type { PresentedContext } from "../../server/present.ts";

export function formatTokens(value: unknown): string | null {
  const n = Number(value);
  if (!Number.isFinite(n) || n < 0) return null;
  if (n < 1000) return String(Math.round(n));
  const thousands = n / 1000;
  if (thousands < 10) {
    const shown = thousands.toFixed(1);
    return `${shown.endsWith(".0") ? shown.slice(0, -2) : shown}k`;
  }
  return `${Math.round(thousands)}k`;
}

export function formatContext(used: unknown, size: unknown): string | null {
  if (!(Number(size) > 0)) return null;
  const left = formatTokens(used);
  const right = formatTokens(size);
  if (!left || !right) return null;
  return `${left} / ${right}`;
}

export function contextIsFull(context: Partial<PresentedContext> | null | undefined): boolean {
  const used = Number(context?.used);
  const size = Number(context?.size);
  if (!(size > 0) || !Number.isFinite(used)) return false;
  const mark = Number(context?.compactAt);
  const percent = Number.isFinite(mark) && mark > 0 && mark <= 100 ? mark : 80;
  return used / size >= percent / 100;
}

export function contextLabel(used: unknown, size: unknown, full = false): string {
  const tokens = Math.round(Number(used));
  const window = Math.round(Number(size));
  if (!Number.isFinite(tokens) || !Number.isFinite(window) || window <= 0) return "";
  const base = `${tokens.toLocaleString("en-US")} of ${window.toLocaleString("en-US")} context tokens`;
  return full ? `${base}, at the compact limit` : base;
}
