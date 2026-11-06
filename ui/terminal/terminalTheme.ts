import type { ITheme } from "@xterm/xterm";
import type { Theme } from "../theme.ts";

// Reads one of the app's colour tokens, such as "--danger".
export type TokenReader = (name: string) => string;

// The terminal's colours from the app's tokens, on the dock's background. The ANSI colours a program asks for
// map to the tokens with the same meaning: red to --danger, green to --ok, yellow to --attention.
export function terminalTheme(token: TokenReader, theme: Theme): ITheme {
  const read = (name: string, fallback: string) => token(name).trim() || fallback;
  const dark = theme === "dark";
  const red = read("--danger", dark ? "#ff8b8b" : "#c1272d");
  const green = read("--ok", dark ? "#4ade80" : "#16a34a");
  const yellow = read("--attention", dark ? "#ffb224" : "#d97706");
  const blue = read("--status-active", dark ? "#6ea8fe" : "#2563eb");
  const magenta = read("--task", dark ? "#b07cff" : "#7c4dff");
  const cyan = read("--link", dark ? "#9ecbff" : "#185ea8");
  const background = read("--sidebar", dark ? "#141414" : "#f4f4f2");
  return {
    background,
    foreground: read("--code-text", dark ? "#c6c6ce" : "#3a3a42"),
    cursor: read("--text", dark ? "#ececec" : "#1a1a1a"),
    cursorAccent: background,
    selectionBackground: dark ? "rgba(255, 255, 255, 0.2)" : "rgba(0, 0, 0, 0.14)",
    black: dark ? read("--scrollbar", "#3a3a3a") : read("--code", "#2c2c32"),
    red,
    green,
    yellow,
    blue,
    magenta,
    cyan,
    white: dark ? read("--code-text", "#c6c6ce") : read("--soft", "#6e6e78"),
    brightBlack: read("--faint", dark ? "#6f6f78" : "#646468"),
    brightRed: red,
    brightGreen: green,
    brightYellow: yellow,
    brightBlue: blue,
    brightMagenta: magenta,
    brightCyan: cyan,
    brightWhite: dark ? read("--text", "#ececec") : read("--chevron-light", "#9a9aa0"),
  };
}
