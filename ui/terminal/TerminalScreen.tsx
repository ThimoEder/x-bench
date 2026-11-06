// One shell's screen: xterm.js on the stream socket of /api/terminal/stream. The host sends the screen as it
// is, then the output, and takes the keys and the size. Loaded only once a terminal opens.

import { useEffect, useRef } from "react";
import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import { WebLinksAddon } from "@xterm/addon-web-links";
import "@xterm/xterm/css/xterm.css";
import { withToken } from "../launchToken.ts";
import { terminalTheme } from "./terminalTheme.ts";
import { useColors, useTheme } from "../useTheme.ts";
import type { Theme } from "../theme.ts";

// As many lines as the host keeps (SCROLLBACK in server/terminal/terminal.ts).
const SCROLLBACK = 2000;
// The dock animates its width when it opens and closes, so the screen fits once the size settles.
const FIT_DELAY_MS = 120;
// A box this small is a dock opening or closing, never a size to give the shell.
const MIN_COLS = 20;
const MIN_ROWS = 4;

export interface TerminalScreenProps {
  shellId: string;
  // Whether the dock is open. A closed dock keeps the shell's size.
  active?: boolean;
  onLink: (event: MouseEvent, uri: string) => void;
}

type Send = (message: Record<string, unknown>) => void;

export default function TerminalScreen({ shellId, active = true, onLink }: TerminalScreenProps) {
  const box = useRef<HTMLDivElement | null>(null);
  const terminal = useRef<Terminal | null>(null);
  const refit = useRef<() => void>(() => {});
  const activeRef = useRef(active);
  activeRef.current = active;
  const [theme] = useTheme();
  const [colors] = useColors();
  const themeRef = useRef(theme);
  themeRef.current = theme;
  const linkRef = useRef(onLink);
  linkRef.current = onLink;

  useEffect(() => {
    const element = box.current;
    if (!element) return undefined;
    const term = new Terminal({
      fontFamily: 'ui-monospace, "SF Mono", SFMono-Regular, Menlo, monospace',
      fontSize: 12,
      lineHeight: 1.2,
      cursorBlink: true,
      scrollback: SCROLLBACK,
      macOptionClickForcesSelection: true,
      theme: themeOf(themeRef.current),
    });
    const fit = new FitAddon();
    term.loadAddon(fit);
    term.loadAddon(new WebLinksAddon((event, uri) => linkRef.current(event, uri)));
    term.open(element);
    const sized = activeRef.current && fitTo(term, fit);
    terminal.current = term;

    const socket = new WebSocket(streamUrl(shellId, sized ? term : null));
    const send: Send = (message) => {
      if (socket.readyState === WebSocket.OPEN) socket.send(JSON.stringify(message));
    };
    socket.onmessage = (event) => show(term, event.data);
    const typed = term.onData((data) => send({ type: "input", data }));
    const mouse = term.onBinary((data) => send({ type: "input", data }));
    const resized = term.onResize(({ cols, rows }) => send({ type: "resize", cols, rows }));
    term.attachCustomKeyEventHandler((event) => onKey(event, term, send));
    let fitTimer: ReturnType<typeof setTimeout> | undefined;
    refit.current = () => {
      clearTimeout(fitTimer);
      fitTimer = setTimeout(() => {
        if (activeRef.current) fitTo(term, fit);
      }, FIT_DELAY_MS);
    };
    const observer = new ResizeObserver(() => refit.current());
    observer.observe(element);
    if (activeRef.current) term.focus();
    return () => {
      clearTimeout(fitTimer);
      refit.current = () => {};
      observer.disconnect();
      typed.dispose();
      mouse.dispose();
      resized.dispose();
      socket.close();
      term.dispose();
      terminal.current = null;
    };
  }, [shellId]);

  useEffect(() => {
    if (terminal.current) terminal.current.options.theme = themeOf(theme);
  }, [theme, colors]);

  useEffect(() => {
    if (active) refit.current();
  }, [active]);

  return <div className="terminal-screen" ref={box} data-testid="terminal-screen" />;
}

function themeOf(theme: Theme) {
  const style = getComputedStyle(document.documentElement);
  return terminalTheme((name) => style.getPropertyValue(name), theme);
}

// Without a size, the shell keeps the one it has.
function streamUrl(shellId: string, size: { cols: number; rows: number } | null): string {
  const query = new URLSearchParams({ shellId, ...(size ? { cols: String(size.cols), rows: String(size.rows) } : {}) });
  return `${location.protocol === "https:" ? "wss" : "ws"}://${location.host}${withToken(`/api/terminal/stream?${query}`)}`;
}

// Resizes the screen to its box. False when the box cannot be measured or is too small to be the dock.
function fitTo(term: Terminal, fit: FitAddon): boolean {
  let size: { cols: number; rows: number } | undefined;
  try {
    size = fit.proposeDimensions();
  } catch {
    return false;
  }
  if (!size || size.cols < MIN_COLS || size.rows < MIN_ROWS) return false;
  if (size.cols !== term.cols || size.rows !== term.rows) term.resize(size.cols, size.rows);
  return true;
}

function show(term: Terminal, raw: unknown) {
  let message: unknown;
  try {
    message = JSON.parse(String(raw));
  } catch {
    return;
  }
  if (typeof message !== "object" || message === null) return;
  const type = Reflect.get(message, "type");
  const data = Reflect.get(message, "data");
  if (type === "screen" && typeof data === "string") {
    term.reset();
    term.write(data);
  } else if (type === "output" && typeof data === "string") {
    term.write(data);
  } else if (type === "exit") {
    term.write(`\r\n\x1b[2m[The shell exited with code ${Number(Reflect.get(message, "code"))}]\x1b[0m\r\n`);
  }
}

// Cmd-K clears, Cmd-C copies the selection and Cmd-A selects everything. Ctrl-` is left to the page, which
// shows and hides the terminal with it.
function onKey(event: KeyboardEvent, term: Terminal, send: Send): boolean {
  if (event.ctrlKey && !event.metaKey && event.key === "`") return false;
  if (event.type !== "keydown" || !event.metaKey || event.ctrlKey || event.altKey) return true;
  const key = event.key.toLowerCase();
  if (key === "k") {
    event.preventDefault();
    term.clear();
    send({ type: "clear" });
    return false;
  }
  if (key === "c" && term.hasSelection()) {
    event.preventDefault();
    void navigator.clipboard?.writeText(term.getSelection()).catch(() => {});
    return false;
  }
  if (key === "a") {
    event.preventDefault();
    term.selectAll();
    return false;
  }
  return true;
}
