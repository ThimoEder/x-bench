import type { BtwEntry } from "../../server/chat/btw.ts";

export const BTW_PLACE_KEY = "x-bench-btw-place";

export interface Viewport {
  width: number;
  height: number;
}

export interface BtwPlace {
  x: number;
  y: number;
  width: number;
  height: number;
}

// A saved entry from /api/btw, or one the window still holds: a question in flight or a failure.
export type BtwItem = Omit<BtwEntry, "askedAt"> & {
  askedAt?: string | null;
  pending?: boolean;
  error?: string;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function isBtwItem(value: unknown): value is BtwItem {
  return (
    isRecord(value) &&
    typeof value.id === "string" &&
    typeof value.question === "string" &&
    typeof value.answer === "string"
  );
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

export function viewportSize(): Viewport {
  return { width: window.innerWidth, height: window.innerHeight };
}

export function clampBtwPlace(place: unknown, viewport: Viewport): BtwPlace {
  const box = isRecord(place) ? place : {};
  const limitW = Math.max(280, viewport.width - 16);
  const limitH = Math.max(220, viewport.height - 16);
  const width = clamp(Number(box.width) || 380, 280, limitW);
  const height = clamp(Number(box.height) || 480, 220, limitH);
  return {
    x: clamp(Number(box.x) || 0, 8, Math.max(8, viewport.width - width - 8)),
    y: clamp(Number(box.y) || 0, 8, Math.max(8, viewport.height - height - 8)),
    width,
    height,
  };
}

export function defaultBtwPlace(viewport: Viewport): BtwPlace {
  const width = Math.min(400, Math.max(280, viewport.width - 24));
  const height = Math.min(520, Math.max(240, viewport.height - 120));
  return clampBtwPlace(
    { x: viewport.width - width - 24, y: viewport.height - height - 24, width, height },
    viewport,
  );
}

export function readBtwPlace(raw: string | null | undefined, viewport: Viewport): BtwPlace {
  if (!raw) return defaultBtwPlace(viewport);
  try {
    return clampBtwPlace(JSON.parse(raw), viewport);
  } catch {
    return defaultBtwPlace(viewport);
  }
}

export function mergeBtwEntries(saved: unknown, local: readonly BtwItem[] | null | undefined): BtwItem[] {
  const disk = Array.isArray(saved) ? saved.filter(isBtwItem) : [];
  const extras: BtwItem[] = [];
  for (const entry of local || []) {
    if (entry.pending || entry.error) {
      extras.push(entry);
      continue;
    }
    const known = disk.some(
      (item) => item.id === entry.id || (item.question === entry.question && item.answer === entry.answer),
    );
    if (!known) extras.push(entry);
  }
  return [...disk, ...extras];
}
