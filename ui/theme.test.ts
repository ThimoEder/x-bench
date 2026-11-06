import assert from "node:assert/strict";
import test from "node:test";
import { applyColors, applyTheme, persistColors, persistTheme, readColors, readTheme, readThemeSetting, shareTheme, themeChoice, type ThemeRoot } from "./theme.ts";

test("a stored theme wins over the system preference", () => {
  assert.equal(themeChoice("light", false), "light");
  assert.equal(themeChoice("dark", true), "dark");
});

test("the system preference is used only when nothing is stored", () => {
  assert.equal(themeChoice(null, true), "light");
  assert.equal(themeChoice("", false), "dark");
  assert.equal(themeChoice("blue", true), "light");
});

test("reading the theme uses storage first", () => {
  const storage = { getItem: () => "light" };
  const matchMedia = () => ({ matches: false });
  assert.equal(readTheme(storage, matchMedia), "light");
});

test("a blocked store falls back to the system preference", () => {
  const storage = { getItem: () => { throw new Error("blocked"); } };
  assert.equal(readTheme(storage, () => ({ matches: true })), "light");
  assert.equal(readTheme(storage, () => { throw new Error("blocked"); }), "dark");
});

test("persisting writes light or dark, and system clears the choice", () => {
  const saved: Record<string, string> = {};
  const storage = {
    setItem: (key: string, value: string) => { saved[key] = value; },
    removeItem: (key: string) => { delete saved[key]; },
  };
  assert.equal(persistTheme("light", storage), "light");
  assert.equal(saved["x-bench-theme"], "light");
  assert.equal(persistTheme("nope", storage), "dark");
  assert.equal(persistTheme("system", storage), "system");
  assert.equal(saved["x-bench-theme"], undefined);
  assert.equal(readThemeSetting({ getItem: (key) => saved[key] ?? null }), "system");
  const blocked = () => { throw new Error("blocked"); };
  assert.equal(persistTheme("dark", { setItem: blocked, removeItem: blocked }), "dark");
});

test("applying a theme sets the document theme", () => {
  const root: ThemeRoot = { dataset: {}, style: {} };
  assert.equal(applyTheme("light", root), "light");
  assert.equal(root.dataset.theme, "light");
  assert.equal(root.style.colorScheme, "light");
  applyTheme("dark", root);
  assert.equal(root.dataset.theme, "dark");
});

test("the desktop app gets the stored theme, or system without one", () => {
  const sent: string[] = [];
  Reflect.set(globalThis, "xBenchDesktop", { theme: (choice: string) => sent.push(choice) });
  try {
    shareTheme({ getItem: () => "light" });
    shareTheme({ getItem: () => null });
    shareTheme({ getItem() { throw new Error("blocked"); } });
  } finally {
    Reflect.deleteProperty(globalThis, "xBenchDesktop");
  }
  assert.deepEqual(sent, ["light", "system", "system"]);
  shareTheme({ getItem: () => "dark" });
});

test("the colours are Studio unless Classic is stored, and Studio clears the choice", () => {
  const saved: Record<string, string> = {};
  const storage = {
    getItem: (key: string) => saved[key] ?? null,
    setItem: (key: string, value: string) => { saved[key] = value; },
    removeItem: (key: string) => { delete saved[key]; },
  };
  assert.equal(readColors(storage), "studio");
  assert.equal(persistColors("classic", storage), "classic");
  assert.equal(readColors(storage), "classic");
  assert.equal(persistColors("nope", storage), "studio");
  assert.equal(saved["x-bench-colors"], undefined);
  assert.equal(readColors({ getItem() { throw new Error("blocked"); } }), "studio");
  const root: ThemeRoot = { dataset: {}, style: {} };
  assert.equal(applyColors("classic", root), "classic");
  assert.equal(root.dataset.colors, "classic");
  applyColors(undefined, root);
  assert.equal(root.dataset.colors, "studio");
});
