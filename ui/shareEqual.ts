// Every streamed chunk resends the changed snapshot fields whole, parsed fresh, so every object in them is
// new even where nothing changed. shareEqual gives back next with each part that equals the same part
// of previous replaced by previous's own, so an unchanged session, transcript item or sidebar row keeps
// its identity and memoised components skip it. Arrays match by index, which fits a transcript that
// grows at the end. Only JSON values are compared, as the snapshot is parsed JSON.
export function shareEqual<T>(previous: unknown, next: T): T {
  // share answers next itself, or a part of previous that equals it.
  return share(previous, next) as T;
}

function share(previous: unknown, next: unknown): unknown {
  if (previous === next) return previous;
  if (Array.isArray(next)) {
    if (!Array.isArray(previous)) return next;
    let same = previous.length === next.length;
    const kept = next.map((value: unknown, index) => {
      const part = share(previous[index], value);
      if (part !== previous[index]) same = false;
      return part;
    });
    return same ? previous : kept;
  }
  if (isRecord(next)) {
    if (!isRecord(previous)) return next;
    const keys = Object.keys(next);
    let same = keys.length === Object.keys(previous).length;
    const kept: Record<string, unknown> = {};
    for (const key of keys) {
      const part = share(previous[key], next[key]);
      if (part !== previous[key] || !Object.hasOwn(previous, key)) same = false;
      kept[key] = part;
    }
    return same ? previous : kept;
  }
  return next;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
