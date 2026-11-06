import { addStartupImage } from "./remote/startupImage.ts";

export const THEME_KEY = "x-bench-theme";
export const COLORS_KEY = "x-bench-colors";

export type Theme = "light" | "dark";

// The app's colours, each in light and dark: Studio, the default, or Classic, the colours from before the redesign.
export type Colors = "studio" | "classic";

// What the person chose: a theme, or "system", which follows the device's appearance.
export type ThemeSetting = Theme | "system";

// The part of document.documentElement the theme touches.
export interface ThemeRoot {
  dataset: DOMStringMap;
  style: { colorScheme?: string };
}

type MatchMedia = (query: string) => { matches: boolean } | null | undefined;

// index.html repeats this choice so the first paint matches stored or system preference.
export function themeChoice(stored: unknown, prefersLight: boolean): Theme {
  if (stored === "light" || stored === "dark") return stored;
  return prefersLight ? "light" : "dark";
}

export function readTheme(
  storage: Pick<Storage, "getItem"> | null | undefined = globalThis.localStorage,
  matchMedia: MatchMedia | null | undefined = globalThis.matchMedia,
): Theme {
  let stored: unknown;
  try {
    stored = storage?.getItem(THEME_KEY) ?? null;
  } catch {
    stored = null;
  }
  let prefersLight;
  try {
    prefersLight = Boolean(matchMedia?.("(prefers-color-scheme: light)")?.matches);
  } catch {
    prefersLight = false;
  }
  return themeChoice(stored, prefersLight);
}

export function readThemeSetting(storage: Pick<Storage, "getItem"> | null | undefined = globalThis.localStorage): ThemeSetting {
  let stored: unknown;
  try {
    stored = storage?.getItem(THEME_KEY);
  } catch {
    stored = null;
  }
  return stored === "light" || stored === "dark" ? stored : "system";
}

// The desktop app's launch page shows before this page loads, so the app keeps the stored choice for it,
// or "system" when the page follows the system.
export function shareTheme(storage: Pick<Storage, "getItem"> | null | undefined = globalThis.localStorage): void {
  const desktop: unknown = Reflect.get(globalThis, "xBenchDesktop");
  const send: unknown = typeof desktop === "object" && desktop !== null ? Reflect.get(desktop, "theme") : null;
  if (typeof send !== "function") return;
  Reflect.apply(send, desktop, [readThemeSetting(storage)]);
}

// "system" clears the stored choice, so the page follows the device again.
export function persistTheme(
  theme: unknown,
  storage: Pick<Storage, "setItem" | "removeItem"> | null | undefined = globalThis.localStorage,
): ThemeSetting {
  const next = theme === "system" ? "system" : theme === "light" ? "light" : "dark";
  try {
    if (next === "system") storage?.removeItem(THEME_KEY);
    else storage?.setItem(THEME_KEY, next);
  } catch {
    // The choice still applies for this visit.
  }
  return next;
}

export function applyTheme(theme: unknown, root: ThemeRoot | null | undefined = globalThis.document?.documentElement): Theme {
  const next = theme === "light" ? "light" : "dark";
  if (root) {
    root.dataset.theme = next;
    root.style.colorScheme = next;
  }
  // The phone's status bar takes this color in the home-screen app.
  globalThis.document?.querySelector('meta[name="theme-color"]')?.setAttribute("content", next === "light" ? "#ffffff" : "#0a0a0a");
  addStartupImage(next);
  return next;
}

// index.html repeats this, so the first paint has the stored colours.
export function readColors(storage: Pick<Storage, "getItem"> | null | undefined = globalThis.localStorage): Colors {
  try {
    return storage?.getItem(COLORS_KEY) === "classic" ? "classic" : "studio";
  } catch {
    return "studio";
  }
}

export function persistColors(
  colors: unknown,
  storage: Pick<Storage, "setItem" | "removeItem"> | null | undefined = globalThis.localStorage,
): Colors {
  const next = colors === "classic" ? "classic" : "studio";
  try {
    if (next === "studio") storage?.removeItem(COLORS_KEY);
    else storage?.setItem(COLORS_KEY, next);
  } catch {
    // The choice still applies for this visit.
  }
  return next;
}

export function applyColors(colors: unknown, root: ThemeRoot | null | undefined = globalThis.document?.documentElement): Colors {
  const next = colors === "classic" ? "classic" : "studio";
  if (root) root.dataset.colors = next;
  return next;
}
