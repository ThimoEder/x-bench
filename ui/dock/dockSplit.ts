export const LIST_RATIO_KEY = "x-bench-dock-list";
export const LIST_RATIO_DEFAULT = 0.38;
export const LIST_RATIO_MIN = 0.12;
export const LIST_RATIO_MAX = 0.72;

export function clampRatio(value: number): number {
  return Math.min(LIST_RATIO_MAX, Math.max(LIST_RATIO_MIN, value));
}

// A missing or blank entry is "not stored": Number(null) and Number("") are both 0.
export function listRatioFrom(stored: unknown): number {
  if (stored == null || String(stored).trim() === "") return LIST_RATIO_DEFAULT;
  const value = Number(stored);
  return Number.isFinite(value) ? clampRatio(value) : LIST_RATIO_DEFAULT;
}

export function storedListRatio(storage: Pick<Storage, "getItem"> | null | undefined = globalThis.localStorage): number {
  try {
    return listRatioFrom(storage?.getItem(LIST_RATIO_KEY));
  } catch {
    return LIST_RATIO_DEFAULT;
  }
}
