// Vite serves the page from a checkout: X Bench Dev and `npm run dev`. X Bench
// Dev passes the feature it is testing in VITE_X_BENCH_LABEL.
export const devBuild = import.meta.env?.DEV === true;
export const devLabel = devBuild ? (import.meta.env?.VITE_X_BENCH_LABEL ?? "").trim() : "";

// A packaged copy's name, from the preload.
export function copyName(): string {
  if (typeof window === "undefined") return "";
  const desktop: unknown = Reflect.get(window, "xBenchDesktop");
  const name: unknown = typeof desktop === "object" && desktop !== null ? Reflect.get(desktop, "appName") : null;
  return typeof name === "string" ? name.trim() : "";
}

// The window title, which Mission Control and the Window menu show.
export function devTitle(label: string): string {
  return label ? `${label} · X Bench Dev` : "X Bench Dev";
}
