import { useCallback, useEffect, useState } from "react";
import {
  applyColors,
  applyTheme,
  COLORS_KEY,
  persistColors,
  persistTheme,
  readColors,
  readTheme,
  readThemeSetting,
  shareTheme,
  THEME_KEY,
  type Colors,
  type Theme,
  type ThemeSetting,
} from "./theme.ts";

// Tells every useTheme and useColors on the page that a choice changed, so the settings page and the
// terminal stay in step.
const THEME_EVENT = "x-bench-theme";

// The page's theme, a way to choose it, and the choice itself: stored, applied, and shared with the other users.
// While the choice is "system", the page follows the device's appearance as it changes.
export function useTheme(): [Theme, (next: ThemeSetting) => void, ThemeSetting] {
  const [theme, setTheme] = useState(() => readTheme());
  const [setting, setSetting] = useState(() => readThemeSetting());

  useEffect(() => {
    function onTheme() {
      setTheme(readTheme());
      setSetting(readThemeSetting());
    }
    function onSystem() {
      if (readThemeSetting() === "system") setTheme(applyTheme(readTheme()));
    }
    const system = window.matchMedia?.("(prefers-color-scheme: light)");
    window.addEventListener(THEME_EVENT, onTheme);
    system?.addEventListener?.("change", onSystem);
    return () => {
      window.removeEventListener(THEME_EVENT, onTheme);
      system?.removeEventListener?.("change", onSystem);
    };
  }, []);

  const choose = useCallback((next: ThemeSetting) => {
    const chosen = persistTheme(next);
    setSetting(chosen);
    shareTheme();
    setTheme(applyTheme(chosen === "system" ? readTheme() : chosen));
    window.dispatchEvent(new Event(THEME_EVENT));
  }, []);

  return [theme, choose, setting];
}

export function useColors(): [Colors, (next: Colors) => void] {
  const [colors, setColors] = useState(() => readColors());

  useEffect(() => {
    const onColors = () => setColors(readColors());
    window.addEventListener(THEME_EVENT, onColors);
    return () => window.removeEventListener(THEME_EVENT, onColors);
  }, []);

  const choose = useCallback((next: Colors) => {
    setColors(applyColors(persistColors(next)));
    window.dispatchEvent(new Event(THEME_EVENT));
  }, []);

  return [colors, choose];
}

// The other windows on this origin share the stored choices; one stored in another window applies here at once.
export function followOtherWindows(): void {
  window.addEventListener("storage", (event) => {
    if (event.key !== null && event.key !== THEME_KEY && event.key !== COLORS_KEY) return;
    applyTheme(readTheme());
    applyColors(readColors());
    window.dispatchEvent(new Event(THEME_EVENT));
  });
}
