// The terminal's shells: one pseudo-terminal per tab, running the user's login shell in its session's folder.
// A headless xterm on the host keeps each shell's screen and scrollback, so a page that attaches again (after a
// switch to another chat, or a reload) gets the screen back as it was, full-screen programs included.

import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn as spawnPty, type IPty } from "node-pty";
import headless from "@xterm/headless";
import serializeAddon from "@xterm/addon-serialize";
import { z } from "zod";
import { adapterEnvironment } from "../../bridge/adapter.ts";

const { Terminal: Screen } = headless;
const { SerializeAddon } = serializeAddon;

export const SCROLLBACK = 2000;

// How often the host asks each shell which program is in the foreground.
const POLL_MS = 1000;
// A shell that does not end on SIGHUP is killed after this long.
const KILL_AFTER_MS = 2000;
// A shell that ends this soon after it starts, with an error, keeps its tab, so the person sees why it ended.
const QUICK_EXIT_MS = 2000;
// Output the headless screen has not parsed yet, and output a page has not read yet, above which the shell is
// paused. A program that prints without end (yes) then waits for the reader instead of filling memory.
const PAUSE_PARSE_BYTES = 1024 * 1024;
const PAUSE_SOCKET_BYTES = 4 * 1024 * 1024;

const MIN_COLS = 2;
const MAX_COLS = 500;
const MIN_ROWS = 1;
const MAX_ROWS = 300;

// What the snapshot shows of a shell: its tab's name, whether a program other than the shell runs in it, and
// the exit code of a shell that failed right after it started. Any other shell that ends closes its tab.
export interface ShellView {
  id: string;
  label: string;
  running: boolean;
  exitCode: number | null;
}

export interface TerminalSize {
  cols: number;
  rows: number;
}

// The part of a WebSocket connection a shell talks to.
export interface ShellViewer {
  sendText(text: string): boolean;
  onMessage(listener: (payload: Buffer, text: boolean) => void): void;
  onClose(listener: () => void): void;
  close(): void;
  buffered(): number;
}

export interface Terminals {
  // Starts a shell for the session. Throws when the folder is gone or the shell does not start.
  open(sessionId: string, cwd: string, size: TerminalSize): ShellView;
  // Ends the shell and drops its tab. False for a shell this session does not have.
  close(sessionId: string, shellId: string): boolean;
  // Sends the shell's screen to the viewer, then its output, and takes its input. False for an unknown shell.
  attach(shellId: string, viewer: ShellViewer, size?: TerminalSize | null): boolean;
  // Ends every shell of the session.
  endSession(sessionId: string): void;
  // Each session's shells, in the order they opened.
  views(): Record<string, ShellView[]>;
  onChange(listener: () => void): void;
  // Ends every shell, and resolves once they exited or were killed.
  stopAll(): Promise<void>;
}

export interface TerminalOptions {
  // The shell to run. Defaults to the user's login shell.
  shell?: string;
  env?: NodeJS.ProcessEnv;
  pollMs?: number;
  // The command line of a process, for a tab's name. Defaults to ps.
  commandOf?: (pid: number) => Promise<string>;
  // The foreground process group of the shell's terminal. Defaults to ps.
  foregroundOf?: (shellPid: number) => Promise<number>;
  // How soon after it starts a shell that fails keeps its tab.
  quickExitMs?: number;
}

// What the page sends over the stream socket.
const ViewerMessage = z.discriminatedUnion("type", [
  z.object({ type: z.literal("input"), data: z.string() }),
  z.object({ type: z.literal("resize"), cols: z.number(), rows: z.number() }),
  z.object({ type: z.literal("clear") }),
]);

interface Shell {
  id: string;
  sessionId: string;
  shellName: string;
  pty: IPty;
  screen: InstanceType<typeof Screen>;
  serializer: InstanceType<typeof SerializeAddon>;
  viewers: Set<ShellViewer>;
  view: ShellView;
  startedAt: number;
  // The foreground program's name the last poll saw.
  foreground: string;
  unparsed: number;
  paused: boolean;
  ended: boolean;
}

export function createTerminals(options: TerminalOptions = {}): Terminals {
  const shellPath = options.shell || loginShell();
  const pollMs = options.pollMs ?? POLL_MS;
  const commandOf = options.commandOf ?? psCommand;
  const foregroundOf = options.foregroundOf ?? psForeground;
  const quickExitMs = options.quickExitMs ?? QUICK_EXIT_MS;
  const shells = new Map<string, Shell>();
  const listeners: (() => void)[] = [];
  let timer: ReturnType<typeof setInterval> | undefined;

  function changed() {
    for (const listener of listeners) listener();
  }

  function open(sessionId: string, cwd: string, size: TerminalSize): ShellView {
    if (!cwd || !isFolder(cwd)) throw new Error("This session's folder is gone");
    const { cols, rows } = clampSize(size);
    const pty = spawnPty(shellPath, ["-l"], {
      name: "xterm-256color",
      cols,
      rows,
      cwd,
      env: shellEnv(options.env ?? adapterEnvironment()),
    });
    const screen = new Screen({ cols, rows, scrollback: SCROLLBACK, allowProposedApi: true });
    const serializer = new SerializeAddon();
    screen.loadAddon(serializer);
    const shellName = programName(shellPath);
    const shell: Shell = {
      id: randomUUID(),
      sessionId,
      shellName,
      pty,
      screen,
      serializer,
      viewers: new Set(),
      view: { id: "", label: shellName, running: false, exitCode: null },
      startedAt: Date.now(),
      foreground: shellName,
      unparsed: 0,
      paused: false,
      ended: false,
    };
    shell.view.id = shell.id;
    shells.set(shell.id, shell);

    // The screen's answers to a program's queries, such as the cursor position. An attached page's xterm answers
    // them itself, so the host answers only while no page watches; viewers join in the screen's parse order, so
    // exactly one of them answers each query.
    screen.onData((reply) => {
      if (!shell.viewers.size && !shell.ended) shell.pty.write(reply);
    });

    pty.onData((data) => {
      shell.unparsed += data.length;
      screen.write(data, () => {
        shell.unparsed -= data.length;
        const message = JSON.stringify({ type: "output", data });
        for (const viewer of shell.viewers) viewer.sendText(message);
        flow(shell);
      });
      flow(shell);
    });
    pty.onExit(({ exitCode, signal }) => {
      shell.ended = true;
      if (!shells.has(shell.id)) return;
      // exit and Ctrl-D end the shell with the last command's status, so only an early end counts as a failure.
      const code = signal ? 128 + signal : exitCode;
      const failedAtStart = code !== 0 && Date.now() - shell.startedAt < quickExitMs;
      // The screen gets the shell's last output before the page hears that it ended.
      screen.write("", () => {
        const message = JSON.stringify({ type: "exit", code });
        for (const viewer of shell.viewers) viewer.sendText(message);
        if (failedAtStart) {
          shell.view = { ...shell.view, running: false, exitCode: code };
        } else {
          drop(shell);
        }
        changed();
      });
    });
    startPolling();
    changed();
    return shell.view;
  }

  // Pauses the shell while its output piles up unread, and resumes it once the screen and every page caught up.
  function flow(shell: Shell) {
    const behind = shell.unparsed > PAUSE_PARSE_BYTES || [...shell.viewers].some((viewer) => viewer.buffered() > PAUSE_SOCKET_BYTES);
    if (behind && !shell.paused && !shell.ended) {
      shell.paused = true;
      shell.pty.pause();
      setTimeout(() => {
        shell.paused = false;
        if (!shell.ended) shell.pty.resume();
        flow(shell);
      }, 50).unref();
    }
  }

  function drop(shell: Shell) {
    shells.delete(shell.id);
    for (const viewer of shell.viewers) viewer.close();
    shell.viewers.clear();
    shell.screen.dispose();
    if (!shells.size) stopPolling();
  }

  // SIGHUP, as a closed terminal window sends, to the shell and to every process group on its terminal, so a
  // background job ends with the tab even when the shell does not pass the hangup on. A process that ignores
  // hangups, as nohup makes it, keeps running. A shell that ignores it is killed.
  async function end(shell: Shell) {
    drop(shell);
    if (shell.ended) return;
    const exited = new Promise<void>((resolve) => {
      shell.pty.onExit(() => resolve());
    });
    const groups = await psJobGroups(shell.pty.pid).catch((): number[] => []);
    for (const group of groups) {
      try {
        process.kill(-group, "SIGHUP");
      } catch {
        // The job ended meanwhile.
      }
    }
    try {
      shell.pty.kill("SIGHUP");
    } catch {
      // Already gone.
    }
    const killer = setTimeout(() => {
      try {
        process.kill(shell.pty.pid, "SIGKILL");
      } catch {
        // Already gone.
      }
    }, KILL_AFTER_MS);
    killer.unref();
    await exited.finally(() => clearTimeout(killer));
  }

  function close(sessionId: string, shellId: string): boolean {
    const shell = shells.get(shellId);
    if (!shell || shell.sessionId !== sessionId) return false;
    void end(shell);
    changed();
    return true;
  }

  function attach(shellId: string, viewer: ShellViewer, size?: TerminalSize | null): boolean {
    const shell = shells.get(shellId);
    if (!shell) {
      viewer.sendText(JSON.stringify({ type: "gone" }));
      viewer.close();
      return false;
    }
    let left = false;
    viewer.onClose(() => {
      left = true;
      shell.viewers.delete(viewer);
      flow(shell);
    });
    viewer.onMessage((payload, text) => {
      if (!text) return;
      let parsed: unknown;
      try {
        parsed = JSON.parse(payload.toString("utf8"));
      } catch {
        return;
      }
      const message = ViewerMessage.safeParse(parsed);
      if (!message.success || !shells.has(shell.id)) return;
      if (message.data.type === "input") {
        if (!shell.ended) shell.pty.write(message.data.data);
      } else if (message.data.type === "resize") {
        resize(shell, message.data);
      } else {
        shell.screen.write("", () => shell.screen.clear());
      }
    });
    if (size) resize(shell, size);
    // Output written before this point is on the screen the viewer gets. Output after it reaches the viewer
    // live, because the screen parses in order and calls back in order.
    shell.screen.write("", () => {
      if (left || !shells.has(shell.id)) return;
      viewer.sendText(JSON.stringify({ type: "screen", data: screenOf(shell.screen, shell.serializer) }));
      if (shell.view.exitCode !== null) viewer.sendText(JSON.stringify({ type: "exit", code: shell.view.exitCode }));
      shell.viewers.add(viewer);
    });
    return true;
  }

  function resize(shell: Shell, size: TerminalSize) {
    const { cols, rows } = clampSize(size);
    if (cols === shell.screen.cols && rows === shell.screen.rows) return;
    shell.screen.resize(cols, rows);
    if (shell.ended) return;
    try {
      shell.pty.resize(cols, rows);
    } catch {
      // The shell ended between the check and the resize.
    }
  }

  function endSession(sessionId: string) {
    let any = false;
    for (const shell of [...shells.values()]) {
      if (shell.sessionId !== sessionId) continue;
      void end(shell);
      any = true;
    }
    if (any) changed();
  }

  function views(): Record<string, ShellView[]> {
    const bySession: Record<string, ShellView[]> = {};
    for (const shell of shells.values()) (bySession[shell.sessionId] ??= []).push(shell.view);
    return bySession;
  }

  async function stopAll() {
    const all = [...shells.values()];
    if (!all.length) return;
    await Promise.all(all.map(end));
    changed();
  }

  function startPolling() {
    if (timer || !pollMs) return;
    timer = setInterval(poll, pollMs);
    timer.unref();
  }

  function stopPolling() {
    clearInterval(timer);
    timer = undefined;
  }

  // The foreground program's name is cheap to read, so it is read on every poll, and ps runs only when it
  // changed. A tab is named after its foreground program, and runs while that is not the shell itself: the
  // terminal's foreground process group is then another one than the shell's.
  function poll() {
    for (const shell of shells.values()) {
      if (shell.ended) continue;
      let name: string;
      try {
        name = programName(shell.pty.process);
      } catch {
        continue;
      }
      if (!name || name === shell.foreground) continue;
      shell.foreground = name;
      void inspect(shell, name);
    }
  }

  async function inspect(shell: Shell, name: string) {
    let label = name;
    let running = name !== shell.shellName;
    try {
      const group = await foregroundOf(shell.pty.pid);
      running = group !== shell.pty.pid;
      if (running) label = commandLabel(await commandOf(group)) || name;
    } catch {
      // The program ended before ps saw it, and the next change asks again.
    }
    if (shell.foreground === name && shells.has(shell.id)) rename(shell, label, running);
  }

  function rename(shell: Shell, label: string, running: boolean) {
    if (shell.view.label === label && shell.view.running === running) return;
    shell.view = { ...shell.view, label, running };
    changed();
  }

  return {
    open,
    close,
    attach,
    endSession,
    views,
    onChange(listener) {
      listeners.push(listener);
    },
    stopAll,
  };
}

// The screen as the serialize addon writes it, with two fixes. It writes the alternate screen's cells as if the
// colours were reset but leaves them as the normal screen ended, so a full-screen program's text would come back
// in its last colour. And it leaves out the scroll region (DECSTBM) a program with a fixed header or footer set,
// so the program's next output would scroll over them.
function screenOf(screen: InstanceType<typeof Screen>, serializer: InstanceType<typeof SerializeAddon>): string {
  const cells = serializer.serialize({ scrollback: SCROLLBACK }).replace("\u001b[?1049h\u001b[H", "\u001b[0m\u001b[?1049h\u001b[H");
  return cells + scrollRegion(screen);
}

// Setting the region moves the cursor home, so the cursor goes back where it was. The region lives in xterm's
// internal buffer, which the public API does not show.
function scrollRegion(screen: InstanceType<typeof Screen>): string {
  const buffer: unknown = Reflect.get(Reflect.get(screen, "_core") ?? {}, "buffer");
  const top = Number(buffer && Reflect.get(buffer, "scrollTop"));
  const bottom = Number(buffer && Reflect.get(buffer, "scrollBottom"));
  if (!Number.isInteger(top) || !Number.isInteger(bottom) || (top === 0 && bottom === screen.rows - 1)) return "";
  const { cursorX, cursorY } = screen.buffer.active;
  const row = screen.modes.originMode ? cursorY - top : cursorY;
  return `\u001b[${top + 1};${bottom + 1}r\u001b[${row + 1};${cursorX + 1}H`;
}

// The user's login shell, as the account names it.
function loginShell(): string {
  try {
    const shell = os.userInfo().shell;
    if (shell) return shell;
  } catch {
    // No passwd entry.
  }
  return process.env.SHELL || "/bin/zsh";
}

// The host's environment, without what only the host should see: its port, the X Bench, Vite and npm settings
// it was started with, the agent that started it, and the terminal it was started from.
export function shellEnv(source: NodeJS.ProcessEnv): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [name, value] of Object.entries(source)) {
    if (value === undefined || hostOnly(name)) continue;
    env[name] = value;
  }
  env.TERM = "xterm-256color";
  env.COLORTERM = "truecolor";
  // An app opened from the Finder gets no locale, and the shell would then read every key as ASCII.
  if (!env.LANG && !env.LC_ALL && !env.LC_CTYPE) env.LANG = "en_US.UTF-8";
  return env;
}

// Vite sets NODE_ENV in the dev host, and an agent that started the host leaves its own variables there.
const HOST_ONLY = new Set(["PORT", "INIT_CWD", "NODE_ENV", "VITE_X_BENCH_LABEL", "SAK_BINARY", "SAK_ASSETS", "TERM_PROGRAM", "TERM_PROGRAM_VERSION", "TERM_SESSION_ID", "CLAUDECODE", "CLAUDE_CONFIG_DIR"]);
const HOST_ONLY_PREFIXES = ["X_BENCH_", "npm_", "ELECTRON_", "ITERM_", "VSCODE_", "CLAUDE_CODE_", "CODEX_"];

function hostOnly(name: string): boolean {
  return HOST_ONLY.has(name) || HOST_ONLY_PREFIXES.some((prefix) => name.startsWith(prefix));
}

// A login shell's name starts with a dash.
function programName(value: string): string {
  return path.basename(String(value || "").trim()).replace(/^-/, "");
}

// A command line as a tab shows it: paths shortened to their last part.
export function commandLabel(command: string): string {
  return command
    .trim()
    .split(/\s+/)
    .filter(Boolean)
    .map((word, index) => (index === 0 ? programName(word) : word.includes("/") && !word.endsWith("/") ? path.basename(word) : word))
    .join(" ")
    .slice(0, 60);
}

export function clampSize(size: Partial<TerminalSize> | null | undefined): TerminalSize {
  const clamp = (value: unknown, min: number, max: number, fallback: number) => {
    const number = Math.floor(Number(value));
    return Number.isFinite(number) ? Math.min(max, Math.max(min, number)) : fallback;
  };
  return { cols: clamp(size?.cols, MIN_COLS, MAX_COLS, 80), rows: clamp(size?.rows, MIN_ROWS, MAX_ROWS, 24) };
}

function isFolder(folder: string): boolean {
  try {
    return fs.statSync(folder).isDirectory();
  } catch {
    return false;
  }
}

function ps(args: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile("ps", args, { timeout: 2000 }, (error, stdout) => (error ? reject(error) : resolve(String(stdout).trim())));
  });
}

async function psForeground(shellPid: number): Promise<number> {
  const group = Number(await ps(["-o", "tpgid=", "-p", String(shellPid)]));
  if (!Number.isInteger(group) || group <= 0) throw new Error("No foreground process");
  return group;
}

// The process groups on the shell's terminal other than the shell's own: its jobs, running or stopped.
async function psJobGroups(shellPid: number): Promise<number[]> {
  const tty = await ps(["-o", "tty=", "-p", String(shellPid)]);
  if (!tty || tty.startsWith("?")) return [];
  const rows = await ps(["-t", tty, "-o", "pgid="]);
  const groups = rows.split(/\s+/).map(Number).filter((group) => Number.isInteger(group) && group > 0 && group !== shellPid);
  return [...new Set(groups)];
}

function psCommand(pid: number): Promise<string> {
  return ps(["-o", "args=", "-p", String(pid)]);
}
