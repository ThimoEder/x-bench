import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import headless from "@xterm/headless";
import { clampSize, commandLabel, createTerminals, shellEnv, type ShellViewer, type TerminalOptions, type Terminals } from "./terminal.ts";

// zsh with an empty home, so no dotfile of the person running the tests prints into the screen.
const home = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "x-bench-terminal-")));
fs.writeFileSync(path.join(home, ".zshrc"), "PS1='$ '\n");
test.after(() => fs.rmSync(home, { recursive: true, force: true }));

function terminals(t: test.TestContext, options: TerminalOptions = {}): Terminals {
  const made = createTerminals({ shell: "/bin/zsh", env: { PATH: process.env.PATH, HOME: home, ZDOTDIR: home }, pollMs: 50, ...options });
  t.after(() => made.stopAll());
  return made;
}

interface Viewer {
  connection: ShellViewer;
  messages: Record<string, unknown>[];
  closed: boolean;
  // Everything the viewer was shown: the screen it got first, then the output.
  shown(): string;
  send(message: unknown): void;
}

function viewer(): Viewer {
  let listener: (payload: Buffer, text: boolean) => void = () => {};
  const leave: (() => void)[] = [];
  const made: Viewer = {
    messages: [],
    closed: false,
    connection: {
      sendText(text) {
        made.messages.push(JSON.parse(text));
        return true;
      },
      onMessage(next) {
        listener = next;
      },
      onClose(next) {
        leave.push(next);
      },
      close() {
        made.closed = true;
        for (const done of leave) done();
      },
      buffered: () => 0,
    },
    shown: () => made.messages.filter((message) => message.type === "screen" || message.type === "output").map((message) => String(message.data)).join(""),
    send(message) {
      listener(Buffer.from(JSON.stringify(message)), true);
    },
  };
  return made;
}

async function until<T>(read: () => T | null | undefined | false, what: string, timeout = 8000): Promise<T> {
  const started = Date.now();
  for (;;) {
    const value = read();
    if (value) return value;
    if (Date.now() - started > timeout) throw new Error(`Timed out waiting for ${what}`);
    await new Promise((resolve) => {
      setTimeout(resolve, 20);
    });
  }
}

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

// Input typed before the shell's first prompt can be lost.
function prompted(screen: Viewer) {
  return until(() => screen.shown().includes("$ "), "the prompt");
}

// Plays a page's screen and the output after it into a fresh terminal, as the page's xterm does.
async function replay(page: Viewer, cols = 80, rows = 24) {
  const term = new headless.Terminal({ cols, rows, allowProposedApi: true });
  await new Promise<void>((resolve) => {
    term.write(page.shown(), resolve);
  });
  return term;
}

// The shell's pid, as it prints it.
async function shellPid(screen: Viewer): Promise<number> {
  screen.send({ type: "input", data: "echo pid-$$-end\r" });
  const match = await until(() => /pid-(\d+)-end/.exec(screen.shown().replaceAll("echo pid-$$-end", "")), "the shell's pid");
  return Number(match[1]);
}

test("a shell runs in the session's folder, takes input, and a later page gets its screen back", async (t) => {
  const shells = terminals(t);
  const view = shells.open("s1", home, { cols: 80, rows: 24 });
  assert.deepEqual(shells.views(), { s1: [{ id: view.id, label: "zsh", running: false, exitCode: null }] });
  const first = viewer();
  assert.equal(shells.attach(view.id, first.connection), true);
  first.send({ type: "input", data: "pwd; echo answer-$((40 + 2))\r" });
  await until(() => first.shown().includes("answer-42"), "the command's output");
  assert.ok(first.shown().includes(home), "the shell runs in the session's folder");

  const later = viewer();
  shells.attach(view.id, later.connection);
  const screen = await until(() => later.messages.find((message) => message.type === "screen"), "the screen");
  assert.match(String(screen.data), /answer-42/);
  assert.equal(later.messages[0]?.type, "screen", "the screen comes before any live output");
});

test("a full-screen program comes back on its alternate screen, in its own colours", async (t) => {
  const shells = terminals(t);
  const view = shells.open("s1", home, { cols: 80, rows: 24 });
  const first = viewer();
  shells.attach(view.id, first.connection);
  first.send({ type: "input", data: "printf '\\033[?1049h\\033[Hfull-%s\\r\\n\\033[94m~' screen; sleep 5\r" });
  await until(() => first.shown().includes("full-screen"), "the program's screen");
  const later = viewer();
  shells.attach(view.id, later.connection);
  const screen = String((await until(() => later.messages.find((message) => message.type === "screen"), "the screen")).data);

  const page = new headless.Terminal({ cols: 80, rows: 24, allowProposedApi: true });
  await new Promise<void>((resolve) => {
    page.write(screen, resolve);
  });
  assert.equal(page.buffer.active.type, "alternate");
  const line = page.buffer.active.getLine(0);
  assert.equal(line?.translateToString(true), "full-screen");
  assert.equal(line?.getCell(0)?.isFgDefault(), true, "the text keeps the default colour");
  assert.equal(page.buffer.active.getLine(1)?.getCell(0)?.getFgColor(), 12, "the tilde keeps its bright blue");
});

test("a program with a fixed footer keeps it after a page comes back", async (t) => {
  const shells = terminals(t);
  const view = shells.open("s1", home, { cols: 80, rows: 24 });
  const first = viewer();
  shells.attach(view.id, first.connection);
  await prompted(first);
  first.send({ type: "input", data: "printf '\\033[?1049h\\033[H\\033[2Jhead\\r\\nb\\r\\nc\\r\\nd\\r\\nfooter\\033[2;4r\\033[4;1H'; sleep 1.5; printf '\\r\\nNEW'; sleep 5\r" });
  await until(() => first.shown().includes("footer"), "the program's screen");
  const later = viewer();
  shells.attach(view.id, later.connection);
  await until(() => later.messages.some((message) => message.type === "output" && String(message.data).includes("NEW")), "output after the page came back");
  const page = await replay(later);
  const lines = [0, 1, 2, 3, 4].map((row) => page.buffer.active.getLine(row)?.translateToString(true));
  assert.deepEqual(lines, ["head", "c", "d", "NEW", "footer"]);
});

test("a program's question to the terminal is answered while no page watches", async (t) => {
  const shells = terminals(t);
  const view = shells.open("s1", home, { cols: 80, rows: 24 });
  const first = viewer();
  shells.attach(view.id, first.connection);
  await prompted(first);
  first.send({ type: "input", data: "sleep 0.5; printf '\\033[6n'; read -s -d R reply; echo answered-$#reply\r" });
  first.connection.close();
  await new Promise((resolve) => {
    setTimeout(resolve, 1500);
  });
  const later = viewer();
  shells.attach(view.id, later.connection);
  await until(() => /answered-\d/.test(later.shown()), "the program to get its answer");
});

test("a page's size reaches the shell", async (t) => {
  const shells = terminals(t);
  const view = shells.open("s1", home, { cols: 80, rows: 24 });
  const screen = viewer();
  shells.attach(view.id, screen.connection, { cols: 100, rows: 30 });
  screen.send({ type: "input", data: "stty size\r" });
  await until(() => screen.shown().includes("30 100"), "the size the page attached with");
  screen.send({ type: "resize", cols: 132, rows: 40 });
  screen.send({ type: "input", data: "stty size\r" });
  await until(() => screen.shown().includes("40 132"), "the size after a resize");
});

test("a tab is named after the program in its foreground, and runs until the program ends", async (t) => {
  const shells = terminals(t);
  const view = shells.open("s1", home, { cols: 80, rows: 24 });
  const screen = viewer();
  shells.attach(view.id, screen.connection);
  screen.send({ type: "input", data: "sleep 30\r" });
  await until(() => shells.views().s1?.[0]?.running, "the running mark");
  assert.equal(shells.views().s1?.[0]?.label, "sleep 30");
  screen.send({ type: "input", data: "\u0003" });
  await until(() => shells.views().s1?.[0]?.running === false, "the mark to clear after Ctrl-C");
  assert.equal(shells.views().s1?.[0]?.label, "zsh");
});

test("closing a tab ends its shell, and other sessions keep theirs", async (t) => {
  const shells = terminals(t);
  const first = shells.open("s1", home, { cols: 80, rows: 24 });
  const second = shells.open("s2", home, { cols: 80, rows: 24 });
  const screen = viewer();
  shells.attach(first.id, screen.connection);
  const pid = await shellPid(screen);

  assert.equal(shells.close("s2", first.id), false, "a shell closes only from its own session");
  assert.equal(shells.close("s1", first.id), true);
  assert.equal(screen.closed, true);
  assert.deepEqual(Object.keys(shells.views()), ["s2"]);
  await until(() => !alive(pid), "the shell to end");
  assert.equal(shells.views().s2?.[0]?.id, second.id);

  const late = viewer();
  assert.equal(shells.attach(first.id, late.connection), false);
  assert.deepEqual(late.messages, [{ type: "gone" }]);
});

test("leaving a shell closes its tab whatever the last command returned, and a shell that fails at start keeps it", async (t) => {
  const shells = terminals(t, { quickExitMs: 0 });
  const left = shells.open("s1", home, { cols: 80, rows: 24 });
  const screen = viewer();
  shells.attach(left.id, screen.connection);
  screen.send({ type: "input", data: "false; exit $?\r" });
  await until(() => !shells.views().s1, "the tab to close");
  assert.deepEqual(screen.messages.at(-1), { type: "exit", code: 1 });
  assert.equal(screen.closed, true);

  const broken = terminals(t, { shell: "/usr/bin/false" });
  const failed = broken.open("s1", home, { cols: 80, rows: 24 });
  await until(() => broken.views().s1?.[0]?.exitCode === 1, "the failed shell's code");
  const later = viewer();
  broken.attach(failed.id, later.connection);
  await until(() => later.messages.some((message) => message.type === "exit"), "the exit code for a later page");
});

test("ending a session ends its shells, and stopping all ends a shell that ignores the hangup", async (t) => {
  const shells = terminals(t);
  const view = shells.open("s1", home, { cols: 80, rows: 24 });
  const stubborn = shells.open("s2", home, { cols: 80, rows: 24 });
  const screen = viewer();
  const stubbornScreen = viewer();
  shells.attach(view.id, screen.connection);
  shells.attach(stubborn.id, stubbornScreen.connection);
  const pid = await shellPid(screen);
  const stubbornPid = await shellPid(stubbornScreen);

  shells.endSession("s1");
  assert.deepEqual(Object.keys(shells.views()), ["s2"]);
  await until(() => !alive(pid), "the session's shell to end");

  stubbornScreen.send({ type: "input", data: "trap '' HUP; echo trapped\r" });
  await until(() => stubbornScreen.shown().includes("\ntrapped") || stubbornScreen.shown().includes("\r\ntrapped"), "the trap");
  await shells.stopAll();
  assert.deepEqual(shells.views(), {});
  assert.equal(alive(stubbornPid), false);
});

test("closing a tab ends its background jobs, even when the shell keeps them from the hangup", async (t) => {
  const shells = terminals(t);
  const view = shells.open("s1", home, { cols: 80, rows: 24 });
  const screen = viewer();
  shells.attach(view.id, screen.connection);
  await prompted(screen);
  screen.send({ type: "input", data: "setopt NO_HUP; sleep 300 & job=$!; echo job-$job-end\r" });
  const match = await until(() => /job-(\d+)-end/.exec(screen.shown()), "the job's pid");
  const job = Number(match[1]);
  // Until it runs sleep, the job is zsh's fresh fork, which drops a hangup.
  await until(() => execFileSync("ps", ["-o", "comm=", "-p", String(job)], { encoding: "utf8" }).trim().endsWith("sleep"), "the job to run sleep");
  shells.close("s1", view.id);
  await until(() => !alive(job), "the background job to end");
});

test("clearing empties the screen a later page gets", async (t) => {
  const shells = terminals(t);
  const view = shells.open("s1", home, { cols: 80, rows: 24 });
  const screen = viewer();
  shells.attach(view.id, screen.connection);
  screen.send({ type: "input", data: "echo before-clear\r" });
  await until(() => screen.shown().includes("\nbefore-clear") || screen.shown().includes("\r\nbefore-clear"), "the output");
  screen.send({ type: "clear" });
  const later = viewer();
  shells.attach(view.id, later.connection);
  const shown = String((await until(() => later.messages.find((message) => message.type === "screen"), "the screen")).data);
  assert.equal(shown.includes("before-clear"), false);
});

test("a shell needs its folder", (t) => {
  const shells = terminals(t);
  assert.throws(() => shells.open("s1", path.join(home, "missing"), { cols: 80, rows: 24 }), /folder is gone/);
  assert.deepEqual(shells.views(), {});
});

test("the shell gets the host's PATH, without the host's own settings", () => {
  const env = shellEnv({
    PATH: "/opt/homebrew/bin:/usr/bin",
    HOME: "/Users/me",
    PORT: "8798",
    X_BENCH_UI: "dist",
    VITE_X_BENCH_LABEL: "Terminal",
    X_BENCH_SAK: "/tmp/sak.json",
    npm_lifecycle_event: "dev",
    ELECTRON_RUN_AS_NODE: "1",
    NODE_ENV: "development",
    CLAUDECODE: "1",
    CLAUDE_CODE_ENTRYPOINT: "cli",
    CLAUDE_CONFIG_DIR: "/Users/me/.claude-personal",
    CODEX_SANDBOX: "seatbelt",
    TERM_PROGRAM: "Apple_Terminal",
    TERM: "dumb",
  });
  assert.deepEqual(env, {
    PATH: "/opt/homebrew/bin:/usr/bin",
    HOME: "/Users/me",
    TERM: "xterm-256color",
    COLORTERM: "truecolor",
    LANG: "en_US.UTF-8",
  });
  assert.equal(shellEnv({ LC_ALL: "de_DE.UTF-8" }).LANG, undefined);
});

test("a tab's name shortens paths and a size stays in bounds", () => {
  assert.equal(commandLabel("npm run dev"), "npm run dev");
  assert.equal(commandLabel("/opt/homebrew/bin/node /Users/me/x_bench/node_modules/.bin/vite --port 5173"), "node vite --port 5173");
  assert.equal(commandLabel("-zsh"), "zsh");
  assert.deepEqual(clampSize({ cols: 0, rows: 9999 }), { cols: 2, rows: 300 });
  assert.deepEqual(clampSize({ cols: "abc" as unknown as number }), { cols: 80, rows: 24 });
});
