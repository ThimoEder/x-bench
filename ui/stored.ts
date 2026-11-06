export function storedFlag(key: string, fallback: boolean): boolean {
  try {
    const value = localStorage.getItem(key);
    if (value === "1") return true;
    if (value === "0") return false;
  } catch {
    // Private mode can block storage. The in-memory default still works.
  }
  return fallback;
}
