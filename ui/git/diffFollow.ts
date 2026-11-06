// The review diff is one scroll. The file whose header has reached the top is
// the one on screen. Nothing is removed while scrolling, so the scrollbar stays put.

// Where a file's section starts in the review scroll.
export interface ScrollSection {
  path: string;
  top: number;
}

// Where review patches come from. bulk answers for many files at once; anything but a list falls back to one.
export interface PatchSources {
  bulk?: ((paths: unknown[]) => Promise<unknown>) | null;
  one?: ((path: unknown) => Promise<unknown>) | null;
}

export function pathAtScroll(scrollTop: unknown, sections: readonly ScrollSection[]): string {
  let path = "";
  const mark = Number(scrollTop) || 0;
  for (const section of sections) {
    if (Number(section.top) <= mark) path = section.path;
    else break;
  }
  return path;
}

export function revealScroll(scrollTop: number, viewTop: number, viewBottom: number, itemTop: number, itemBottom: number): number {
  if (itemTop < viewTop) return scrollTop - (viewTop - itemTop);
  if (itemBottom > viewBottom) return scrollTop + (itemBottom - viewBottom);
  return scrollTop;
}

export function patchRecord(rows: readonly unknown[] | null | undefined): Record<string, string> {
  const next: Record<string, string> = {};
  for (const row of rows || []) {
    if (!isRecord(row) || !row.path) continue;
    next[String(row.path)] = String(row.patch || "");
  }
  return next;
}

export function samePatches(current: Readonly<Record<string, string>> | null | undefined, rows: readonly unknown[] | null | undefined): boolean {
  const next = patchRecord(rows);
  const left = Object.keys(current || {});
  const right = Object.keys(next);
  if (left.length !== right.length) return false;
  return right.every((key) => current?.[key] === next[key]);
}

export async function reviewPatches(sources: PatchSources | null | undefined, paths: readonly unknown[] | null | undefined): Promise<unknown[]> {
  const wanted = [...new Set((paths || []).filter(Boolean))];
  if (!wanted.length) return [];
  if (sources?.bulk) {
    const rows = await sources.bulk(wanted);
    if (Array.isArray(rows)) return rows;
  }
  if (!sources?.one) return [];
  const rows: { path: unknown; patch: string }[] = [];
  for (const path of wanted) rows.push({ path, patch: String((await sources.one(path)) || "") });
  return rows;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
