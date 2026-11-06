import { after, test } from "node:test";
import assert from "node:assert/strict";
import { act, createElement } from "react";
import type { ShellView } from "../../server/snapshot.ts";
import { click, installDom } from "../testing/dom.ts";
import { terminalTheme } from "./terminalTheme.ts";
import { panelHeight, storedTerminalPlace } from "./terminalPlace.ts";
import type { TerminalScreenProps } from "./TerminalScreen.tsx";

// react-dom checks for a DOM when it loads, so it comes in after installDom.
const dom = installDom();
const { createRoot } = await import("react-dom/client");
const { TerminalToggle } = await import("./Terminal.tsx");
const { TerminalTab, useShellChoice } = await import("./TerminalTab.tsx");
const { dockPlaces } = await import("../dock/dockMemory.ts");
const { TerminalPanel } = await import("./TerminalPanel.tsx");

after(async () => {
  await dom.happyDOM.abort();
  dom.close();
});

const idle: ShellView = { id: "a", label: "zsh", running: false, exitCode: null };
const server: ShellView = { id: "b", label: "npm run dev", running: true, exitCode: null };
const failed: ShellView = { id: "c", label: "zsh", running: false, exitCode: 2 };

// Stands in for the xterm screen, which needs a real browser.
function Screen({ shellId, active }: TerminalScreenProps) {
  return createElement("div", { "data-testid": "screen", "data-shell": shellId, "data-active": String(active) });
}

async function mount(element: ReturnType<typeof createElement>) {
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  await act(async () => {
    root.render(element);
  });
  return {
    container,
    rerender: (next: ReturnType<typeof createElement>) =>
      act(async () => {
        root.render(next);
      }),
    unmount: () =>
      act(async () => {
        root.unmount();
        container.remove();
      }),
  };
}

function button(container: HTMLElement, label: string): HTMLButtonElement {
  const found = [...container.querySelectorAll("button")].find((item) => (item.getAttribute("aria-label") || item.textContent) === label);
  assert.ok(found, `no ${label} button`);
  return found;
}

test("the shelf's terminal icon carries a dot while a command runs, and toggles the terminal", async () => {
  let toggles = 0;
  const view = await mount(createElement(TerminalToggle, { shells: [idle], open: false, onToggle: () => toggles++ }));
  const toggle = button(view.container, "Terminal");
  assert.equal(toggle.getAttribute("aria-pressed"), "false");
  assert.equal(view.container.querySelector(".terminal-running"), null);
  await act(async () => click(toggle));
  assert.equal(toggles, 1);

  await view.rerender(createElement(TerminalToggle, { shells: [idle, server], open: true, onToggle: () => toggles++ }));
  const running = button(view.container, "Terminal, a command is running");
  assert.equal(running.getAttribute("aria-pressed"), "true");
  assert.ok(view.container.querySelector(".terminal-running"));
  await view.unmount();
});

interface TabCall {
  path: string;
  body: Record<string, unknown>;
}

function tab(props: { sessionId?: string; shells: ShellView[]; shellId?: string; calls: TabCall[]; picked?: string[]; answer?: () => unknown; active?: boolean }) {
  return createElement(TerminalTab, {
    sessionId: props.sessionId ?? "s1",
    cwd: "/Users/me/x_bench",
    shells: props.shells,
    shellId: props.shellId ?? "",
    onShell: (id: string) => props.picked?.push(id),
    call: async (path: string, body: Record<string, unknown>) => {
      props.calls.push({ path, body });
      return props.answer?.() ?? { shell: { id: "new" } };
    },
    onLink: () => {},
    active: props.active ?? true,
    screen: Screen,
  });
}

test("a chat's first visit to the Terminal tab starts a shell in its folder", async () => {
  const calls: TabCall[] = [];
  const picked: string[] = [];
  const view = await mount(tab({ sessionId: "first-visit", shells: [], calls, picked }));
  assert.equal(calls[0]?.path, "/api/terminal/open");
  assert.equal(typeof calls[0]?.body.cols, "number");
  assert.deepEqual(picked, ["new"]);
  assert.match(view.container.textContent || "", /x_bench/);
  await view.unmount();
});

test("the strip shows each shell with its mark, and the screen shows the chosen one", async () => {
  const calls: TabCall[] = [];
  const picked: string[] = [];
  const view = await mount(tab({ sessionId: "strip", shells: [idle, server, failed], shellId: "b", calls, picked }));
  assert.equal(calls.length, 0, "a chat that has shells starts none");
  const tabs = [...view.container.querySelectorAll("[role=tab]")];
  assert.deepEqual(tabs.map((item) => item.textContent), ["zsh", "npm run dev", "zsh2"]);
  assert.equal(tabs[1]?.getAttribute("aria-selected"), "true");
  assert.ok(tabs[1]?.querySelector(".terminal-running"), "the dev server's tab is marked running");
  assert.equal(tabs[2]?.querySelector(".terminal-exit")?.getAttribute("aria-label"), "Exited with code 2");
  assert.equal(view.container.querySelector("[data-testid=screen]")?.getAttribute("data-shell"), "b");
  await view.rerender(tab({ sessionId: "strip", shells: [idle, server, failed], shellId: "b", calls, picked, active: false }));
  assert.equal(view.container.querySelector("[data-testid=screen]")?.getAttribute("data-active"), "false", "a closed dock tells the screen to keep the shell's size");

  await act(async () => click(tabs[0] as HTMLElement));
  assert.deepEqual(picked, ["a"]);

  await act(async () => click(button(view.container, "Close npm run dev")));
  assert.deepEqual(calls.at(-1), { path: "/api/terminal/close", body: { shellId: "b" } });
  assert.deepEqual(picked, ["a", "c"], "closing the shown shell shows the next one");

  await act(async () => click(button(view.container, "New shell")));
  assert.equal(calls.at(-1)?.path, "/api/terminal/open");
  await view.unmount();
});

test("once its last shell closed, a chat shows the empty state instead of starting another", async () => {
  const calls: TabCall[] = [];
  const view = await mount(tab({ sessionId: "closed-all", shells: [idle], calls }));
  await view.rerender(tab({ sessionId: "closed-all", shells: [], calls }));
  assert.equal(calls.length, 0);
  assert.ok(view.container.querySelector("[data-testid=terminal-empty]"));
  assert.match(view.container.textContent || "", /No shell in x_bench/);

  await act(async () => click(button(view.container, "New shell")));
  assert.equal(calls.at(-1)?.path, "/api/terminal/open");
  await view.unmount();
});

test("a shell that does not start says why", async () => {
  const calls: TabCall[] = [];
  const view = await mount(
    tab({
      sessionId: "refused",
      shells: [],
      calls,
      answer: () => {
        throw new Error("This session's folder is gone");
      },
    }),
  );
  assert.equal(view.container.querySelector("[role=alert]")?.textContent, "This session's folder is gone");
  assert.ok(view.container.querySelector("[data-testid=terminal-empty]"));
  await view.unmount();
});

test("the terminal's colours come from the app's tokens in both themes", () => {
  const tokens: Record<string, string> = { "--sidebar": " #141414", "--danger": "#ff8b8b", "--ok": "#7dcea0", "--code-text": "#c6c6ce" };
  const dark = terminalTheme((name) => tokens[name] ?? "", "dark");
  assert.equal(dark.background, "#141414");
  assert.equal(dark.cursorAccent, "#141414");
  assert.equal(dark.red, "#ff8b8b");
  assert.equal(dark.green, "#7dcea0");
  assert.equal(dark.foreground, "#c6c6ce");
  assert.equal(dark.blue, "#6ea8fe", "a missing token falls back to the theme's own colour");

  const light = terminalTheme(() => "", "light");
  assert.equal(light.background, "#f4f4f2");
  assert.equal(light.red, "#c1272d");
  assert.notEqual(light.white, light.background, "white text stays readable on the light background");
});

test("the strip's move button sends the terminal under the chat and back, and the panel can hide it", async () => {
  const calls: TabCall[] = [];
  let moves = 0;
  let hides = 0;
  const docked = await mount(createElement(TerminalTab, { ...tab({ sessionId: "moves", shells: [idle], calls }).props, onMove: () => moves++ }));
  assert.equal(maybeButton(docked.container, "Hide the terminal"), null, "the dock closes with its own button");
  await act(async () => click(button(docked.container, "Move the terminal under the chat")));
  assert.equal(moves, 1);
  await docked.unmount();

  const below = await mount(createElement(TerminalTab, { ...tab({ sessionId: "moves", shells: [idle], calls }).props, place: "bottom", onMove: () => moves++, onHide: () => hides++ }));
  await act(async () => click(button(below.container, "Move the terminal into the review dock")));
  await act(async () => click(button(below.container, "Hide the terminal")));
  assert.deepEqual([moves, hides], [2, 1]);
  await below.unmount();
});

test("the panel under the desk resizes from its edge, within the desk", async () => {
  const heights: number[] = [];
  const view = await mount(
    createElement(TerminalPanel, {
      sessionId: "panel",
      cwd: "/Users/me/x_bench",
      shells: [],
      call: async () => ({ shell: { id: "new" } }),
      height: 300,
      onHeight: (height: number) => heights.push(height),
      onMove: () => {},
      onHide: () => {},
      onLink: () => {},
    }),
  );
  const grip = view.container.querySelector("[aria-label='Resize terminal']");
  assert.ok(grip);
  await act(async () => {
    grip.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowUp", bubbles: true }));
    grip.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowDown", bubbles: true }));
  });
  assert.deepEqual(heights, [324, 276]);
  await view.unmount();

  assert.equal(panelHeight(500, 900), 500);
  assert.equal(panelHeight(800, 900), 680, "the panes keep their share of the desk");
  assert.equal(panelHeight(40, 900), 140);
  assert.equal(panelHeight(300, 300), 140, "a short desk keeps the panel at its minimum");
  assert.equal(storedTerminalPlace({ getItem: () => "bottom" }), "bottom");
  assert.equal(storedTerminalPlace({ getItem: () => "sideways" }), "dock");
});

function maybeButton(container: HTMLElement, label: string): HTMLButtonElement | null {
  return [...container.querySelectorAll("button")].find((item) => item.getAttribute("aria-label") === label) ?? null;
}

test("a closed terminal starts no shell, and the first look at it does", async () => {
  const calls: TabCall[] = [];
  const view = await mount(tab({ sessionId: "seen-later", shells: [], calls, active: false }));
  assert.equal(calls.length, 0, "a Terminal tab the dock remembers, behind a closed dock, starts nothing");
  await view.rerender(tab({ sessionId: "seen-later", shells: [], calls, active: true }));
  assert.equal(calls[0]?.path, "/api/terminal/open");
  await view.unmount();
});

test("the dock and the panel under the desk show the shell the other one picked last", async () => {
  const shells = [idle, server];
  function Place() {
    const [shell, choose] = useShellChoice("shared");
    return createElement(TerminalTab, { sessionId: "shared", cwd: "/x", shells, shellId: shell, onShell: choose, call: async () => ({}), onLink: () => {}, screen: Screen });
  }
  const shown = (container: HTMLElement) => container.querySelector("[data-testid=screen]")?.getAttribute("data-shell");
  const dock = await mount(createElement(Place));
  await act(async () => click([...dock.container.querySelectorAll("[role=tab]")][0] as HTMLElement));
  assert.equal(shown(dock.container), "a");

  const panel = await mount(createElement(Place));
  assert.equal(shown(panel.container), "a", "the panel opens on the dock's shell");
  await act(async () => click([...panel.container.querySelectorAll("[role=tab]")][1] as HTMLElement));
  assert.equal(dockPlaces.get("shared")?.shell, "b");
  assert.equal(shown(dock.container), "b", "back in the dock, the panel's shell shows");
  await panel.unmount();
  await dock.unmount();
});
