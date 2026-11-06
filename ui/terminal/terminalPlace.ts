import { desktopBridge, isWebUrl, paneCall } from "../browser/browserPane.ts";

// Where the terminal shows: a tab of the review dock, or a panel under the desk. Every chat shares it.
export type TerminalPlace = "dock" | "bottom";

export const TERMINAL_PLACE_KEY = "x-bench-terminal-place";
export const TERMINAL_HEIGHT_KEY = "x-bench-terminal-height";
export const TERMINAL_HEIGHT = 300;
export const TERMINAL_MIN_HEIGHT = 140;
// The panes keep at least this much of the desk above the panel.
export const DESK_MIN_HEIGHT = 220;

type PlaceStorage = Pick<Storage, "getItem">;

export function storedTerminalPlace(storage: PlaceStorage | null | undefined = globalThis.localStorage): TerminalPlace {
  try {
    return storage?.getItem(TERMINAL_PLACE_KEY) === "bottom" ? "bottom" : "dock";
  } catch {
    return "dock";
  }
}

// The panel's height in a desk column this tall. A column too short for both keeps the panel at its minimum,
// and a column that cannot be measured (0) sets no upper bound.
export function panelHeight(height: number, column: number): number {
  const max = column > 0 ? Math.max(TERMINAL_MIN_HEIGHT, column - DESK_MIN_HEIGHT) : Infinity;
  return Math.round(Math.min(max, Math.max(TERMINAL_MIN_HEIGHT, height)));
}

// A link in a shell's output opens in the chat's Browser tab when the app has one. Cmd-click and other modified
// clicks, and a page without the pane, open the person's own browser.
export function openTerminalLink(event: MouseEvent, uri: string, sessionId: string, pane: boolean) {
  if (!isWebUrl(uri)) return;
  const modified = event.metaKey || event.ctrlKey || event.shiftKey || event.altKey;
  if (!pane || modified || !desktopBridge()) {
    window.open(uri, "_blank", "noopener");
    return;
  }
  void paneCall("/api/browser/open", { url: uri, newTab: true, sessionId }).then((error) => {
    if (error) window.open(uri, "_blank", "noopener");
  });
}
