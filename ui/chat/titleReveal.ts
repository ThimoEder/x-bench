const placeholders = new Set(["untitled", "new session", "new chat"]);

export function isPlaceholderTitle(value: unknown): boolean {
  const text = String(value ?? "").trim().toLowerCase();
  return text === "" || placeholders.has(text);
}

// The generated name arriving. Later renames keep the plain text swap.
export function nextTitleReveal<T>(previous: T, next: T): { from: T; to: T } | null {
  if (Object.is(previous, next)) return null;
  if (!isPlaceholderTitle(previous) || isPlaceholderTitle(next)) return null;
  return { from: previous, to: next };
}
