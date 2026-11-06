// The provider contract, run against a fake of each provider: Grok over an in-process socket,
// Claude and ChatGPT as real processes on stdio. Each case holds for all three, in the app's own names.

import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { ClaudeProvider, type ClaudeOptions, type ClaudeThreadPicks } from "./claude/provider.ts";
import { ChatGptProvider, type ChatGptModelList, type ChatGptOptions } from "./chatgpt/provider.ts";
import { GrokProvider } from "./grok/provider.ts";
import type { CatalogEntry } from "./protocol.ts";
import type { Provider, SessionTools, SideEntry } from "./provider.ts";
import type { RpcHandlers, Transport } from "./rpc.ts";
import type { SessionState } from "./reducer.ts";
import { GROK_DIALECT, createFakeAgent, emptyStore, type FakeStore } from "./testing/fakeAgent.ts";
import { runningTasks } from "../ui/board/tasks.ts";
import { userMessageView } from "../ui/chat/messages/reminders.ts";
import { presentSession } from "../server/present.ts";

const here = path.dirname(fileURLToPath(import.meta.url));

interface Harness {
  provider: Provider;
  // The agent's own names for the app's modes.
  agentMode: (mode: "ask" | "full" | "plan") => string;
  effortId: string;
  // What the mode test sends the agent, where it differs from one call per change.
  modeCalls?: { modes: string[]; config: [string, string][] };
  store(): FakeStore;
  cleanup(): Promise<void>;
}

// Grok's side of a socket: the fake agent, answering on the next tick like a real one.
class FakeSocket implements Transport {
  handlers: RpcHandlers | null = null;
  closed: Promise<void>;
  private resolveClosed: () => void;
  private agent: (message: never) => void;
  private done = false;

  constructor(store: FakeStore) {
    const { promise, resolve } = Promise.withResolvers<void>();
    this.closed = promise;
    this.resolveClosed = resolve;
    this.agent = createFakeAgent(GROK_DIALECT, store, {
      send: (message) => queueMicrotask(() => this.handlers?.onMessage(JSON.stringify(message))),
      crash: () => queueMicrotask(() => this.close()),
    });
  }

  setHandlers(handlers: RpcHandlers) {
    this.handlers = handlers;
  }

  send(value: unknown) {
    if (this.done) throw new Error("closed");
    const message = JSON.parse(JSON.stringify(value)) as never;
    queueMicrotask(() => this.agent(message));
  }

  close() {
    if (this.done) return;
    this.done = true;
    this.handlers?.onClose();
    this.resolveClosed();
  }
}

// Grok's folder for the Grok harness, so it never reads the real ~/.grok.
const grokHome = mkdtempSync(path.join(os.tmpdir(), "grok-home-"));
test.after(() => rmSync(grokHome, { recursive: true, force: true }));

function grokHarness(options: { sessionTools?: SessionTools } = {}): Harness {
  const store = emptyStore();
  const provider = new GrokProvider({ connect: () => new FakeSocket(store), promptSuggestions: false, home: grokHome, ...options });
  return {
    provider,
    agentMode: (mode) => ({ ask: "default", full: "agent", plan: "plan" })[mode],
    effortId: "reasoning_effort",
    store: () => store,
    cleanup: () => provider.stop(),
  };
}

function claudeHarness(settings: Pick<ClaudeOptions, "configDir" | "readSettings" | "sessionTools" | "saveSideAnswer"> = {}): Harness & { file: string; picks: Map<string, ClaudeThreadPicks> } {
  const folder = mkdtempSync(path.join(os.tmpdir(), "x-bench-fake-claude-"));
  const file = path.join(folder, "store.json");
  const picks = new Map<string, ClaudeThreadPicks>();
  const provider = new ClaudeProvider({
    command: process.execPath,
    args: [path.join(here, "testing", "fakeClaude.ts"), file],
    readPicks: (sessionId) => picks.get(sessionId) ?? null,
    savePicks: (sessionId, next) => {
      picks.set(sessionId, next);
    },
    ...settings,
  });
  return {
    provider,
    file,
    picks,
    agentMode: (mode) => ({ ask: "default", full: "bypassPermissions", plan: "plan" })[mode],
    effortId: "effort",
    // Claude opens on the effort its _meta names, so only the later change is a call.
    modeCalls: { modes: ["plan", "bypassPermissions"], config: [["model", "m2"], ["effort", "high"]] },
    store: () => JSON.parse(readFileSync(file, "utf8")) as FakeStore,
    async cleanup() {
      await provider.stop();
      rmSync(folder, { recursive: true, force: true });
    },
  };
}

function chatgptHarness(options: Pick<ChatGptOptions, "sessionTools" | "saveSideAnswer" | "readSideHistory" | "clearSideHistory"> = {}): Harness & { provider: ChatGptProvider; saved: () => ChatGptModelList | null; presets: Map<string, string> } {
  const folder = mkdtempSync(path.join(os.tmpdir(), "x-bench-fake-chatgpt-"));
  const file = path.join(folder, "store.json");
  let models: ChatGptModelList | null = null;
  const presets = new Map<string, string>();
  const provider = new ChatGptProvider({
    command: process.execPath,
    args: [path.join(here, "testing", "fakeChatGpt.ts"), file],
    readModels: () => models,
    saveModels: (next) => {
      models = next;
    },
    readPreset: (sessionId) => presets.get(sessionId),
    savePreset: (sessionId, preset) => {
      presets.set(sessionId, preset);
    },
    ...options,
  });
  return {
    provider,
    saved: () => models,
    presets,
    agentMode: (mode) => ({ ask: "read-only", full: "agent-full-access", plan: "" })[mode],
    effortId: "reasoning_effort",
    modeCalls: {
      modes: ["agent-full-access"],
      config: [["model", "m2"], ["reasoning_effort", "low"], ["collaboration_mode", "plan"], ["collaboration_mode", "default"], ["reasoning_effort", "high"]],
    },
    store: () => JSON.parse(readFileSync(file, "utf8")) as FakeStore,
    async cleanup() {
      await provider.stop();
      rmSync(folder, { recursive: true, force: true });
    },
  };
}

// The fake Codex adapter's store file, from the arguments the harness started it with.
function chatgptStore(provider: ChatGptProvider) {
  return provider.options.args?.[1] ?? "";
}

const harnesses: [string, (options?: { sessionTools?: SessionTools }) => Harness][] = [
  ["grok", grokHarness],
  ["claude", claudeHarness],
  ["chatgpt", chatgptHarness],
];

async function waitFor<T>(read: () => T, what: string, timeoutMs = 5000): Promise<NonNullable<T>> {
  const started = Date.now();
  for (;;) {
    const value = read();
    if (value) return value as NonNullable<T>;
    if (Date.now() - started > timeoutMs) throw new Error(`timed out waiting for ${what}`);
    await new Promise((resolve) => {
      setTimeout(resolve, 10);
    });
  }
}

function listSessions(provider: Provider, cwd?: string): Promise<CatalogEntry[]> {
  return Reflect.apply(Reflect.get(provider, "listSessions"), provider, cwd ? [cwd] : []);
}

function texts(session: SessionState | null) {
  return (session?.transcript ?? []).map((item) => `${item.type}:${item.text ?? item.title ?? ""}`);
}

for (const [name, make] of harnesses) {
  test(`${name}: its capabilities agree with the methods it has`, async () => {
    const { provider, cleanup } = make();
    try {
      const { capabilities } = provider;
      assert.equal(capabilities.steer, typeof provider.steer === "function");
      assert.equal(capabilities.deliverNext, typeof provider.sendSteerNow === "function" && typeof provider.removeSteer === "function");
      assert.ok(capabilities.steer || !capabilities.steerAttachments);
    } finally {
      await cleanup();
    }
  });

  test(`${name}: streams text, names the session and reports the context window`, async () => {
    const { provider, cleanup } = make();
    try {
      await provider.start();
      const session = await provider.createSession({ cwd: os.tmpdir() });
      await provider.prompt(session.id, "hello");
      const done = provider.getSession(session.id);
      assert.deepEqual(texts(done), ["user:hello", "assistant:pong"]);
      assert.equal(done?.status, "idle");
      assert.equal(provider.catalog.get(session.id)?.title, "Pong chat");
      assert.equal(done?.contextSize, 200000);
      assert.equal(done?.contextUsed, 1200);
    } finally {
      await cleanup();
    }
  });

  test(`${name}: a tool runs after a permission whose request id is 0`, async () => {
    const { provider, cleanup } = make();
    try {
      await provider.start();
      const session = await provider.createSession({ cwd: os.tmpdir() });
      const turn = provider.prompt(session.id, "PERMISSION");
      const waiting = await waitFor(() => provider.getSession(session.id)?.pendingPermission, "the permission");
      assert.equal(waiting.rpcId, 0);
      assert.deepEqual(provider.activityMarks().attention, [session.id]);
      provider.answerPermission(session.id, "allow");
      await turn;
      const done = provider.getSession(session.id);
      assert.equal(done?.pendingPermission, null);
      const tool = done?.transcript.find((item) => item.type === "tool");
      assert.equal(tool?.type === "tool" ? tool.status : null, "completed");
      assert.deepEqual(texts(done).at(-1), "assistant:wrote");
    } finally {
      await cleanup();
    }
  });

  test(`${name}: two permissions asked at once show one after another`, async () => {
    const { provider, cleanup } = make();
    try {
      await provider.start();
      const session = await provider.createSession({ cwd: os.tmpdir() });
      const turn = provider.prompt(session.id, "TWOPERMS");
      await waitFor(() => provider.getSession(session.id)?.contextUsed === 2, "both permissions");
      assert.equal(provider.getSession(session.id)?.pendingPermission?.rpcId, "perm-a");
      provider.answerPermission(session.id, "allow");
      assert.equal(provider.getSession(session.id)?.pendingPermission?.rpcId, "perm-b");
      provider.answerPermission(session.id, "reject");
      await turn;
      const done = provider.getSession(session.id);
      assert.equal(done?.pendingPermission, null);
      assert.equal(texts(done).at(-1), "assistant:perm-a:allow perm-b:reject");
    } finally {
      await cleanup();
    }
  });

  test(`${name}: Stop answers the permission waiting behind the shown one as cancelled`, async () => {
    const { provider, cleanup } = make();
    try {
      await provider.start();
      const session = await provider.createSession({ cwd: os.tmpdir() });
      const turn = provider.prompt(session.id, "TWOPERMS");
      await waitFor(() => provider.getSession(session.id)?.contextUsed === 2, "both permissions");
      assert.equal(provider.getSession(session.id)?.pendingPermission?.rpcId, "perm-a");
      provider.cancel(session.id);
      await turn;
      const done = provider.getSession(session.id);
      assert.equal(done?.pendingPermission, null);
      assert.equal(done?.stopReason, "cancelled");
      assert.equal(texts(done).at(-1), "assistant:perm-b:cancelled");
    } finally {
      await cleanup();
    }
  });

  test(`${name}: a withdrawn permission leaves, shown or waiting, and the other one still shows`, async () => {
    const { provider, cleanup } = make();
    try {
      await provider.start();
      const session = await provider.createSession({ cwd: os.tmpdir() });
      let turn = provider.prompt(session.id, "TWOPERMS WITHDRAW perm-a");
      await waitFor(() => provider.getSession(session.id)?.pendingPermission?.rpcId === "perm-b", "the second permission");
      provider.answerPermission(session.id, "allow");
      await turn;
      assert.equal(texts(provider.getSession(session.id)).at(-1), "assistant:perm-a:withdrawn perm-b:allow");

      turn = provider.prompt(session.id, "TWOPERMS WITHDRAW perm-b");
      await waitFor(() => texts(provider.getSession(session.id)).at(-1) === "assistant:perm-b:withdrawn", "the withdrawal");
      assert.equal(provider.getSession(session.id)?.pendingPermission?.rpcId, "perm-a");
      provider.answerPermission(session.id, "allow");
      await turn;
      const done = provider.getSession(session.id);
      assert.equal(done?.pendingPermission, null);
      assert.equal(texts(done).at(-1), "assistant:perm-b:withdrawn perm-a:allow");
    } finally {
      await cleanup();
    }
  });

  test(`${name}: permissions waiting on a connection that drops do not come back after the reconnect`, async () => {
    const { provider, cleanup } = make();
    try {
      await provider.start();
      const statuses: string[] = [];
      provider.onStatus((status) => statuses.push(status));
      const session = await provider.createSession({ cwd: os.tmpdir() });
      const turn = provider.prompt(session.id, "TWOPERMS DROP");
      await waitFor(() => provider.getSession(session.id)?.pendingPermission?.rpcId === "perm-a", "the first permission");
      await assert.rejects(turn);
      await waitFor(() => statuses.includes("reconnecting") && provider.status === "ready", "the reconnect");
      assert.equal(provider.getSession(session.id)?.pendingPermission, null);
    } finally {
      await cleanup();
    }
  });

  test(`${name}: a question from the agent waits for the person and returns only the form's answers`, async () => {
    const { provider, store, cleanup } = make();
    try {
      await provider.start();
      assert.deepEqual((store().clientCapabilities as { elicitation?: unknown } | undefined)?.elicitation, { form: {} });
      const session = await provider.createSession({ cwd: os.tmpdir() });
      const turn = provider.prompt(session.id, "QUESTION");
      const waiting = await waitFor(() => provider.getSession(session.id)?.pendingElicitation, "the question");
      assert.equal(waiting.message, "Which database?");
      assert.deepEqual(waiting.fields.map((field) => [field.key, field.kind]), [["question_0", "choice"], ["question_0_custom", "text"]]);
      assert.deepEqual(provider.activityMarks().attention, [session.id]);
      assert.equal(presentSession(provider.getSession(session.id)!).activity?.label, "Waiting for your answer");
      assert.throws(() => provider.answerElicitation(session.id, "accept", { question_0: "MySQL" }), /required/);
      provider.answerElicitation(session.id, "accept", { question_0: "SQLite", question_0_custom: "", stray: "x" });
      await turn;
      const done = provider.getSession(session.id);
      assert.equal(done?.pendingElicitation, null);
      assert.equal(texts(done).at(-1), `assistant:${JSON.stringify({ action: "accept", content: { question_0: "SQLite" } })}`);
    } finally {
      await cleanup();
    }
  });

  test(`${name}: two questions asked at once show one after another`, async () => {
    const { provider, cleanup } = make();
    try {
      await provider.start();
      const session = await provider.createSession({ cwd: os.tmpdir() });
      const turn = provider.prompt(session.id, "TWOQUESTIONS");
      await waitFor(() => provider.getSession(session.id)?.pendingElicitation?.rpcId === "ask-a", "the first question");
      provider.answerElicitation(session.id, "accept", { question_0: "Postgres" });
      await waitFor(() => provider.getSession(session.id)?.pendingElicitation?.rpcId === "ask-b", "the second question");
      provider.answerElicitation(session.id, "accept", { question_0: "SQLite" });
      await turn;
      const done = provider.getSession(session.id);
      assert.equal(done?.pendingElicitation, null);
      const answer = (choice: string) => JSON.stringify({ action: "accept", content: { question_0: choice } });
      assert.equal(texts(done).at(-1), `assistant:ask-a:${answer("Postgres")} ask-b:${answer("SQLite")}`);
    } finally {
      await cleanup();
    }
  });

  test(`${name}: Stop answers the shown question and the one waiting behind it as cancelled`, async () => {
    const { provider, cleanup } = make();
    try {
      await provider.start();
      const session = await provider.createSession({ cwd: os.tmpdir() });
      const turn = provider.prompt(session.id, "TWOQUESTIONS");
      await waitFor(() => provider.getSession(session.id)?.contextUsed === 2, "both questions");
      assert.equal(provider.getSession(session.id)?.pendingElicitation?.rpcId, "ask-a");
      provider.cancel(session.id);
      await turn;
      const done = provider.getSession(session.id);
      assert.equal(done?.pendingElicitation, null);
      const cancelled = JSON.stringify({ action: "cancel" });
      assert.equal(texts(done).at(-1), `assistant:ask-b:${cancelled} ask-a:${cancelled}`);
    } finally {
      await cleanup();
    }
  });

  test(`${name}: stopping the turn answers a waiting question as cancelled`, async () => {
    const { provider, cleanup } = make();
    try {
      await provider.start();
      const session = await provider.createSession({ cwd: os.tmpdir() });
      const turn = provider.prompt(session.id, "QUESTION");
      await waitFor(() => provider.getSession(session.id)?.pendingElicitation, "the question");
      provider.cancel(session.id);
      await turn;
      const done = provider.getSession(session.id);
      assert.equal(done?.pendingElicitation, null);
      assert.equal(texts(done).at(-1), `assistant:${JSON.stringify({ action: "cancel" })}`);
    } finally {
      await cleanup();
    }
  });

  test(`${name}: a question the agent withdraws leaves the chat`, async () => {
    const { provider, cleanup } = make();
    try {
      await provider.start();
      const session = await provider.createSession({ cwd: os.tmpdir() });
      await provider.prompt(session.id, "GIVEUP");
      const done = provider.getSession(session.id);
      assert.equal(done?.pendingElicitation, null);
      assert.equal(texts(done).at(-1), "assistant:withdrawn");
      assert.deepEqual(provider.activityMarks().attention, []);
    } finally {
      await cleanup();
    }
  });

  test(`${name}: cancel ends the running turn`, async () => {
    const { provider, cleanup } = make();
    try {
      await provider.start();
      const session = await provider.createSession({ cwd: os.tmpdir() });
      const turn = provider.prompt(session.id, "HANG");
      await waitFor(() => texts(provider.getSession(session.id)).includes("assistant:working"), "the turn to start");
      assert.equal(provider.getSession(session.id)?.status, "running");
      provider.cancel(session.id);
      await turn;
      assert.equal(provider.getSession(session.id)?.status, "idle");
      assert.equal(provider.getSession(session.id)?.stopReason, "cancelled");
    } finally {
      await cleanup();
    }
  });

  test(`${name}: session/load replays a stored session`, async () => {
    const { provider, cleanup } = make();
    try {
      await provider.start();
      const session = await provider.createSession({ cwd: os.tmpdir() });
      await provider.prompt(session.id, "hello");
      await provider.forgetSession(session.id);
      assert.equal(provider.getSession(session.id), null);
      const loaded = await provider.loadSession(session.id, os.tmpdir());
      assert.deepEqual(texts(loaded ?? null), ["user:hello", "assistant:pong"]);
      assert.equal(loaded?.status, "idle");
    } finally {
      await cleanup();
    }
  });

  test(`${name}: reopening an idle session clears its old error and keeps its messages`, async () => {
    const { provider, cleanup } = make();
    try {
      await provider.start();
      const session = await provider.createSession({ cwd: os.tmpdir() });
      await provider.prompt(session.id, "hello");
      await assert.rejects(provider.prompt(session.id, "AUTHFAIL"));
      assert.ok(provider.getSession(session.id)?.error);
      const messages = texts(provider.getSession(session.id));
      const reopened = await provider.loadSession(session.id, os.tmpdir());
      assert.equal(reopened?.error, null);
      assert.deepEqual(texts(reopened ?? null), messages);
      assert.equal(reopened?.status, "idle");
    } finally {
      await cleanup();
    }
  });

  test(`${name}: an agent that stops ends the running turn with an error, and its sessions come back`, async () => {
    const { provider, cleanup } = make();
    try {
      await provider.start();
      const session = await provider.createSession({ cwd: os.tmpdir() });
      await provider.prompt(session.id, "hello");
      await assert.rejects(provider.prompt(session.id, "CRASH"));
      const failed = await waitFor(() => provider.getSession(session.id)?.error, "the turn error");
      assert.ok(failed.length > 0);
      assert.equal(provider.getSession(session.id)?.status, "idle");
      await waitFor(() => provider.status === "ready" && texts(provider.getSession(session.id)).includes("assistant:pong"), "the reload");
      assert.ok(provider.getSession(session.id)?.error);
      await provider.prompt(session.id, "again");
      assert.deepEqual(texts(provider.getSession(session.id)).at(-1), "assistant:pong");
      assert.equal(provider.getSession(session.id)?.error, null);
    } finally {
      await cleanup();
    }
  });

  test(`${name}: modes and config use the app's names and reach the agent in its own`, async () => {
    const { provider, agentMode, effortId, modeCalls, store, cleanup } = make();
    try {
      await provider.start();
      const session = await provider.createSession({ cwd: os.tmpdir(), mode: "plan", model: "m2", effort: "low" });
      assert.equal(session.modeId, "plan");
      assert.equal(session.modelId, "m2");
      assert.equal(session.reasoningEffort, "low");
      assert.ok(session.configOptions.some((option) => option.id === "effort"));
      assert.ok(!session.configOptions.some((option) => option.id === effortId && effortId !== "effort"));
      const full = await provider.setMode(session.id, "full");
      assert.equal(full?.modeId, "full");
      await provider.setConfig(session.id, "effort", "high");
      assert.deepEqual(store().modeCalls, modeCalls?.modes ?? [agentMode("plan"), agentMode("full")]);
      const calls = store().configCalls.filter(([id]) => id !== "fast");
      assert.deepEqual(calls, modeCalls?.config ?? [["model", "m2"], [effortId, "low"], [effortId, "high"]]);
      assert.ok(provider.modes.some((mode) => mode.id === "full"));
    } finally {
      await cleanup();
    }
  });
}

for (const [name, make] of [["claude", claudeHarness], ["chatgpt", chatgptHarness]] as const) {
  test(`${name}: a message sent during a turn waits in the app's queue, and can be edited first`, async () => {
  const { provider, store, cleanup } = make();
  try {
    await provider.start();
    const session = await provider.createSession({ cwd: os.tmpdir() });
    const turn = provider.prompt(session.id, "HANG");
    await waitFor(() => provider.getSession(session.id)?.status === "running", "the turn");
    const later = provider.followUp(session.id, "later");
    const queued = await waitFor(() => provider.getSession(session.id)?.queue[0], "the queued message");
    assert.equal(queued.text, "later");
    assert.deepEqual(provider.activityMarks().working, [session.id]);
    provider.editQueued(session.id, queued.id, "later, edited", queued.version);
    assert.equal(provider.getSession(session.id)?.queue[0]?.text, "later, edited");
    provider.cancel(session.id);
    await turn;
    await later;
    const done = provider.getSession(session.id);
    assert.deepEqual(texts(done).slice(-2), ["user:later, edited", "assistant:pong"]);
    assert.deepEqual(done?.queue, []);
    // The agent got the held message only once the turn had ended, never as a second prompt beside it.
    const prompts = JSON.stringify(store().sessions[session.id]?.history ?? []);
    assert.equal(prompts.split("later").length - 1, 1);
  } finally {
    await cleanup();
  }
  });
}

test("claude: an image-only follow-up shows the picture on the queue", async () => {
  const { provider, cleanup } = claudeHarness();
  try {
    await provider.start();
    const session = await provider.createSession({ cwd: os.tmpdir() });
    const turn = provider.prompt(session.id, "HANG");
    await waitFor(() => provider.getSession(session.id)?.status === "running", "the turn");
    const preview = "data:image/png;base64,iVBORw0KGgo";
    const png = Buffer.from("png-bytes").toString("base64");
    const later = provider.followUp(session.id, "", [{ name: "shot.png", mimeType: "image/png", data: png, preview }]);
    const queued = await waitFor(() => provider.getSession(session.id)?.queue[0], "the queued image");
    assert.equal(queued.text, "");
    assert.equal(queued.attachments?.[0]?.name, "shot.png");
    assert.equal(queued.attachments?.[0]?.kind, "image");
    assert.equal(queued.attachments?.[0]?.preview, preview);
    provider.editQueued(session.id, queued.id, "with a caption", queued.version);
    const edited = provider.getSession(session.id)?.queue[0];
    assert.equal(edited?.text, "with a caption");
    assert.equal(edited?.attachments?.[0]?.preview, preview);
    const shown = presentSession(provider.getSession(session.id) as SessionState);
    assert.equal(shown.queue[0]?.attachments?.[0]?.preview, preview);
    provider.removeQueued(session.id, queued.id, queued.version);
    provider.cancel(session.id);
    await turn;
    await later;
  } finally {
    await cleanup();
  }
});

test("claude: its modes map ask to default and full to bypassPermissions, and a session starts in auto", () => {
  const provider = new ClaudeProvider();
  assert.deepEqual(provider.modes.map((mode) => mode.id), ["ask", "acceptEdits", "plan", "auto", "full"]);
  assert.equal(provider.defaultMode, "auto");
});

test("claude: fast mode is switched off and hidden once off, since it bills usage credits", async () => {
  const { provider, store, cleanup } = claudeHarness();
  try {
    await provider.start();
    const session = await provider.createSession({ cwd: os.tmpdir() });
    await waitFor(() => store().configCalls.some(([id, value]) => id === "fast" && value === "off"), "fast mode off");
    await waitFor(() => !provider.getSession(session.id)?.configOptions.some((option) => option.id === "fast"), "fast mode hidden");
    await provider.forgetSession(session.id);
    // Loaded again, the fake reports it off now, so nothing is sent a second time.
    const before = store().configCalls.length;
    await provider.loadSession(session.id, os.tmpdir());
    assert.equal(store().configCalls.length, before);
  } finally {
    await cleanup();
  }
});

test("claude: a session that loads again gets the model, effort and approval mode the person chose", async () => {
  const { provider, store, picks, cleanup } = claudeHarness();
  try {
    await provider.start();
    const session = await provider.createSession({ cwd: os.tmpdir(), mode: "full", model: "m2", effort: "low" });
    assert.deepEqual(picks.get(session.id), { model: "m2", effort: "low", mode: "bypassPermissions" });
    await provider.prompt(session.id, "hello");
    await provider.forgetSession(session.id);
    // The load answers once they are set again, so the menus never show Claude's defaults.
    const loaded = await provider.loadSession(session.id, os.tmpdir());
    assert.equal(loaded?.modeId, "full");
    assert.equal(loaded?.modelId, "m2");
    assert.equal(loaded?.reasoningEffort, "low");
    assert.equal(store().sessions[session.id]?.mode, "bypassPermissions");
    assert.equal(store().sessions[session.id]?.config.model, "m2");
    assert.equal(store().sessions[session.id]?.config.effort, "low");
  } finally {
    await cleanup();
  }
});

test("claude: an approval mode picked while a session loads again wins over the saved one", async () => {
  const { provider, picks, cleanup } = claudeHarness();
  try {
    await provider.start();
    const session = await provider.createSession({ cwd: os.tmpdir(), mode: "full", model: "m2", effort: "low" });
    await provider.forgetSession(session.id);
    const loading = provider.loadSession(session.id, os.tmpdir());
    await provider.setMode(session.id, "ask");
    const loaded = await loading;
    assert.equal(loaded?.modeId, "ask");
    assert.equal(picks.get(session.id)?.mode, "default");
  } finally {
    await cleanup();
  }
});

test("claude: a model picked by an alias Claude accepts is kept when the session loads again", async () => {
  const { provider, picks, cleanup } = claudeHarness();
  try {
    await provider.start();
    const session = await provider.createSession({ cwd: os.tmpdir() });
    await provider.setConfig(session.id, "model", "M2");
    assert.equal(picks.get(session.id)?.model, "m2");
    await provider.forgetSession(session.id);
    const loaded = await provider.loadSession(session.id, os.tmpdir());
    assert.equal(loaded?.modelId, "m2");
  } finally {
    await cleanup();
  }
});

test("claude: a new session that opens on the chosen effort keeps it when it loads again", async () => {
  const { provider, picks, cleanup } = claudeHarness();
  try {
    await provider.start();
    const session = await provider.createSession({ cwd: os.tmpdir(), effort: "low" });
    assert.equal(picks.get(session.id)?.effort, "low");
    await provider.forgetSession(session.id);
    const loaded = await provider.loadSession(session.id, os.tmpdir());
    assert.equal(loaded?.reasoningEffort, "low");
  } finally {
    await cleanup();
  }
});

test("claude: a load that sets the model again, which turns fast mode back on, answers once fast mode is off", async () => {
  const { provider, picks, cleanup } = claudeHarness();
  try {
    await provider.start();
    const session = await provider.createSession({ cwd: os.tmpdir() });
    await provider.forgetSession(session.id);
    picks.set(session.id, { model: "m2" });
    const loaded = await provider.loadSession(session.id, os.tmpdir());
    assert.equal(loaded?.modelId, "m2");
    assert.ok(!loaded?.configOptions.some((option) => option.id === "fast"));
  } finally {
    await cleanup();
  }
});

test("claude: after the adapter restarts, a session is on its chosen model, effort and mode before Claude is ready again", async () => {
  const { provider, store, cleanup } = claudeHarness();
  try {
    await provider.start();
    const session = await provider.createSession({ cwd: os.tmpdir(), mode: "auto", model: "m2", effort: "low" });
    await provider.prompt(session.id, "hello");
    await assert.rejects(provider.prompt(session.id, "CRASH"));
    // Ready comes only after the reload set the choices again, so a held message never goes before them.
    await waitFor(() => provider.status === "ready" && texts(provider.getSession(session.id)).includes("assistant:pong"), "the reload");
    assert.equal(provider.getSession(session.id)?.modeId, "auto");
    assert.equal(provider.getSession(session.id)?.modelId, "m2");
    assert.equal(provider.getSession(session.id)?.reasoningEffort, "low");
    assert.equal(store().sessions[session.id]?.mode, "auto");
    assert.equal(store().sessions[session.id]?.config.model, "m2");
    assert.equal(store().sessions[session.id]?.config.effort, "low");
  } finally {
    await cleanup();
  }
});

test("claude: fast mode that cannot be switched off stays in the menu, with a notice", async () => {
  const { provider, file, cleanup } = claudeHarness();
  try {
    writeFileSync(file, JSON.stringify({ ...emptyStore(), refuse: ["fast"] }));
    await provider.start();
    const session = await provider.createSession({ cwd: os.tmpdir() });
    const shown = await waitFor(
      () => provider.getSession(session.id)?.transcript.find((item) => item.type === "assistant" && item.text.includes("Fast mode is still on")),
      "fast mode notice",
    );
    assert.match(shown.type === "assistant" ? shown.text : "", /refused/);
    assert.equal(provider.getSession(session.id)?.configOptions.find((option) => option.id === "fast")?.currentValue, "on");
  } finally {
    await cleanup();
  }
});

test("claude: a config folder that is not there stops the start, so Claude never runs on a new account", async () => {
  const missing = path.join(os.tmpdir(), "x-bench-no-such-claude-folder");
  const { provider, cleanup } = claudeHarness({ configDir: missing });
  try {
    await assert.rejects(provider.start(), /Claude's config folder .*x-bench-no-such-claude-folder is missing/);
    assert.match((await provider.detect()).message ?? "", /is missing/);
  } finally {
    await cleanup();
  }
});

test("claude: settings are read when they matter, so a problem the settings report stops the start", async () => {
  let problem = "claude.json does not read.";
  const { provider, cleanup } = claudeHarness({ readSettings: () => (problem ? { problem } : {}) });
  try {
    await assert.rejects(provider.start(), /claude\.json does not read/);
    problem = "";
    await provider.start();
    assert.equal(provider.status, "ready");
  } finally {
    await cleanup();
  }
});

test("claude: a background task shows while it runs and ends when Claude says so", async () => {
  const { provider, cleanup } = claudeHarness();
  try {
    await provider.start();
    const session = await provider.createSession({ cwd: os.tmpdir() });
    await provider.prompt(session.id, "TASK");
    assert.deepEqual(provider.getSession(session.id)?.backgroundTasks, [{ id: "task-1", kind: "local_bash", status: "running", label: "sleep 1 && echo done" }]);
    await waitFor(() => provider.getSession(session.id)?.backgroundTasks[0]?.status === "completed", "the task to finish");
    // Claude reports on the finished task in a turn of its own, which must end too.
    await waitFor(() => texts(provider.getSession(session.id)).includes("assistant:The task is done."), "Claude's report");
    await waitFor(() => provider.getSession(session.id)?.status === "idle", "Claude's own turn to end");
    // The thread gets the chip a reload shows for Claude Code's <task-notification> note, after the reply it
    // finished during, which stays one message.
    const transcript = provider.getSession(session.id)?.transcript ?? [];
    assert.deepEqual(transcript.slice(-2).map((item) => item.type), ["assistant", "user"]);
    const note = transcript.at(-1);
    assert.equal(note?.type === "user" && note.hidden, true);
    assert.deepEqual(userMessageView(note?.text).notice, { title: "Task completed", tone: "ok", detail: "sleep 1 && echo done" });
    assert.deepEqual(provider.activityMarks().working, []);
  } finally {
    await cleanup();
  }
});

test("claude: send now stops the turn and sends the chosen queued message next", async () => {
  const { provider, cleanup } = claudeHarness();
  try {
    await provider.start();
    const session = await provider.createSession({ cwd: os.tmpdir() });
    const turn = provider.prompt(session.id, "HANG");
    await waitFor(() => provider.getSession(session.id)?.status === "running", "the turn");
    const first = provider.followUp(session.id, "first");
    const second = provider.followUp(session.id, "second");
    const chosen = await waitFor(() => provider.getSession(session.id)?.queue.find((entry) => entry.text === "second"), "the queue");
    await provider.sendQueuedNow(session.id, chosen.id);
    await turn;
    await second;
    await first;
    const done = provider.getSession(session.id);
    assert.equal(done?.stopReason, "end_turn");
    assert.deepEqual(texts(done).filter((line) => line.startsWith("user:")), ["user:HANG", "user:second", "user:first"]);
    assert.deepEqual(done?.queue, []);
  } finally {
    await cleanup();
  }
});

test("claude: steer joins the running turn, and after the turn it is an ordinary prompt", async () => {
  const { provider, cleanup } = claudeHarness();
  try {
    await provider.start();
    const session = await provider.createSession({ cwd: os.tmpdir() });
    const turn = provider.prompt(session.id, "HANG");
    await waitFor(() => provider.getSession(session.id)?.status === "running", "the turn");
    await provider.steer?.(session.id, "go left");
    await waitFor(() => texts(provider.getSession(session.id)).some((line) => line.includes("steered: go left")), "the steered text");
    provider.cancel(session.id);
    await turn;
    await provider.steer?.(session.id, "hello");
    const done = provider.getSession(session.id);
    assert.equal(done?.status, "idle");
    assert.deepEqual(texts(done).slice(-2), ["user:hello", "assistant:pong"]);
  } finally {
    await cleanup();
  }
});

test("claude: a subagent shows in the task row while it runs", async () => {
  const { provider, cleanup } = claudeHarness();
  try {
    await provider.start();
    const session = await provider.createSession({ cwd: os.tmpdir() });
    const turn = provider.prompt(session.id, "AGENT");
    await waitFor(() => provider.getSession(session.id)?.transcript.some((item) => item.type === "tool" && item.title === "Read the notes"), "the subagent");
    const tool = provider.getSession(session.id)?.transcript.find((item) => item.type === "tool");
    assert.deepEqual(tool?.type === "tool" ? tool.facts : null, { role: "subagent", label: "Read the notes", agent: "general-purpose" });
    await waitFor(() => provider.getSession(session.id)?.transcript.some((item) => item.type === "tool" && item.toolCallId === "read-9"), "the subagent's step");
    const step = provider.getSession(session.id)?.transcript.find((item) => item.type === "tool" && item.toolCallId === "read-9");
    assert.equal(step?.type === "tool" ? step.parentId : null, "agent-1");
    // The task row reads the session as the page gets it.
    const current = provider.getSession(session.id);
    assert.ok(current);
    assert.deepEqual(runningTasks(presentSession(current)), [{ id: tool?.id, label: "Read the notes", agent: true, step: "Read notes.txt", rowId: tool?.id }]);
    provider.cancel(session.id);
    await turn;
  } finally {
    await cleanup();
  }
});

test("claude: its next-prompt suggestion becomes ghost text once the turn is over", async () => {
  const { provider, cleanup } = claudeHarness();
  try {
    await provider.start();
    const session = await provider.createSession({ cwd: os.tmpdir() });
    await provider.prompt(session.id, "hello");
    await waitFor(() => provider.getSession(session.id)?.suggestion, "the suggestion");
    assert.equal(provider.getSession(session.id)?.suggestion, "and then?");
  } finally {
    await cleanup();
  }
});

test("chatgpt: its next-prompt suggestion becomes ghost text once the turn is over", async () => {
  const { provider, cleanup } = chatgptHarness();
  try {
    await provider.start();
    const session = await provider.createSession({ cwd: os.tmpdir() });
    await provider.prompt(session.id, "hello");
    await waitFor(() => provider.getSession(session.id)?.suggestion, "the suggestion");
    assert.equal(provider.getSession(session.id)?.suggestion, "and then?");
  } finally {
    await cleanup();
  }
});

test("claude: board rules go on Claude Code's own system prompt, again on every load", async () => {
  const { provider, store, cleanup } = claudeHarness();
  try {
    await provider.start();
    const session = await provider.createSession({ cwd: os.tmpdir(), rules: "  Move tickets on the board.  " });
    await provider.forgetSession(session.id);
    await provider.loadSession(session.id, os.tmpdir(), { rules: "Move tickets on the board." });
    await provider.prompt(session.id, "CRASH").catch(() => {});
    await waitFor(() => store().metas.filter((entry) => entry.method === "session/load").length === 2 && provider.status === "ready", "the reload");
    const appended = store().metas.map((entry) => (entry.meta as { systemPrompt?: { append?: string } } | null)?.systemPrompt?.append);
    assert.deepEqual(appended, ["Move tickets on the board.", "Move tickets on the board.", "Move tickets on the board."]);
    const plain = await provider.createSession({ cwd: os.tmpdir() });
    assert.equal((store().metas.at(-1)?.meta as { systemPrompt?: unknown } | undefined)?.systemPrompt, undefined);
    assert.ok(plain.id);
  } finally {
    await cleanup();
  }
});

// The host's tools as the provider sees them: each grant has its own URL, and records the id it is bound to.
function recordingTools() {
  const grants: (string | null)[] = [];
  const bound: string[] = [];
  const tools: SessionTools = {
    grant(sessionId) {
      grants.push(sessionId);
      const key = `k${grants.length}`;
      return {
        servers: [{ type: "http", name: "x_bench", url: `http://127.0.0.1:1/api/mcp/${key}`, headers: [{ name: "x-bench-token", value: "t" }] }],
        trusted: [{ server: "x_bench", tool: "suggest_task" }],
        instructions: "Suggest follow-up tasks.",
        bind(id) {
          bound.push(`${key}:${id}`);
        },
      };
    },
  };
  return { tools, grants, bound };
}

for (const [name, make] of harnesses) {
  test(`${name}: every session/new and session/load carries the host's MCP server, and a new one learns its id`, async () => {
    const recorded = recordingTools();
    const { provider, store, cleanup } = make({ sessionTools: recorded.tools });
    try {
      await provider.start();
      const session = await provider.createSession({ cwd: os.tmpdir() });
      await provider.forgetSession(session.id);
      await provider.loadSession(session.id, os.tmpdir());
      assert.deepEqual(recorded.grants, [null, session.id]);
      assert.deepEqual(recorded.bound, [`k1:${session.id}`]);
      const urls = store().metas.map((entry) => (entry.mcpServers as { url: string }[] | null)?.map((server) => server.url));
      assert.deepEqual(urls, [["http://127.0.0.1:1/api/mcp/k1"], ["http://127.0.0.1:1/api/mcp/k2"]]);
    } finally {
      await cleanup();
    }
  });
}

test("grok: the host tools' line joins the rules of a new session", async () => {
  const { provider, store, cleanup } = grokHarness({ sessionTools: recordingTools().tools });
  try {
    await provider.start();
    await provider.createSession({ cwd: os.tmpdir(), rules: "Move tickets." });
    await provider.createSession({ cwd: os.tmpdir() });
    assert.deepEqual(store().metas.map((entry) => (entry.meta as { rules?: string } | null)?.rules), ["Move tickets.\n\nSuggest follow-up tasks.", "Suggest follow-up tasks."]);
  } finally {
    await cleanup();
  }
});

test("claude: the host's trusted tools run without asking, and its line joins the system prompt", async () => {
  const { provider, store, cleanup } = claudeHarness({ sessionTools: recordingTools().tools });
  try {
    await provider.start();
    const session = await provider.createSession({ cwd: os.tmpdir(), rules: "Move tickets." });
    await provider.forgetSession(session.id);
    await provider.loadSession(session.id, os.tmpdir(), { rules: "Move tickets." });
    for (const entry of store().metas) {
      const meta = entry.meta as { systemPrompt?: { append?: string }; claudeCode?: { options?: { allowedTools?: string[] } } };
      assert.equal(meta.systemPrompt?.append, "Move tickets.\n\nSuggest follow-up tasks.");
      assert.deepEqual(meta.claudeCode?.options?.allowedTools, ["mcp__x_bench__suggest_task"]);
    }
  } finally {
    await cleanup();
  }
});

test("chatgpt: the host's trusted tools run without Codex's own prompt", async () => {
  const { provider, store, cleanup } = chatgptHarness({ sessionTools: recordingTools().tools });
  try {
    await provider.start();
    const session = await provider.createSession({ cwd: os.tmpdir() });
    await provider.forgetSession(session.id);
    await provider.loadSession(session.id, os.tmpdir());
    for (const entry of store().metas) {
      const servers = entry.mcpServers as { name: string; _meta?: unknown }[];
      assert.deepEqual(servers[0]?._meta, { "x-bench/codex": { tools: { suggest_task: { approval_mode: "approve" } } } });
    }
  } finally {
    await cleanup();
  }
});

test("claude: delete removes the stored session", async () => {
  const { provider, store, cleanup } = claudeHarness();
  try {
    await provider.start();
    const session = await provider.createSession({ cwd: os.tmpdir() });
    await provider.prompt(session.id, "hello");
    await provider.deleteSession?.(session.id);
    await provider.forgetSession(session.id);
    assert.equal(store().sessions[session.id], undefined);
  } finally {
    await cleanup();
  }
});

test("claude: a side question is answered from the conversation, also during a turn, and the thread stays as it was", async () => {
  const saved: SideEntry[] = [];
  const { provider, cleanup } = claudeHarness({ saveSideAnswer: (_sessionId, entry) => saved.push(entry) });
  try {
    await provider.start();
    const session = await provider.createSession({ cwd: os.tmpdir() });
    await provider.prompt(session.id, "hello");
    const before = provider.getSession(session.id)?.transcript;
    const answer = await provider.sideQuestion?.(session.id, " what did I say? ");
    assert.equal(answer?.answer, "You said: hello");
    assert.deepEqual(provider.getSession(session.id)?.transcript, before);
    assert.deepEqual(saved.map((entry) => [entry.question, entry.answer]), [["what did I say?", "You said: hello"]]);
    const turn = provider.prompt(session.id, "HANG");
    await waitFor(() => provider.getSession(session.id)?.status === "running", "the turn");
    assert.equal((await provider.sideQuestion?.(session.id, "and now?"))?.answer, "You said: hello, HANG");
    assert.equal(provider.getSession(session.id)?.status, "running");
    provider.cancel(session.id);
    await turn;
    await assert.rejects(provider.sideQuestion!(session.id, "NOANSWER"), /Claude gave no answer/);
    // A clear while Claude answers, and a chat deleted meanwhile, keep no history.
    const cleared = provider.sideQuestion!(session.id, "and now?");
    provider.clearSideHistory?.(session.id);
    await cleared;
    const asking = provider.sideQuestion!(session.id, "and now?");
    await provider.forgetSession(session.id);
    await asking;
    assert.equal(saved.length, 2);
  } finally {
    await cleanup();
  }
});

test("claude: a background task can be stopped on its own, without a turn", async () => {
  const { provider, cleanup } = claudeHarness();
  try {
    await provider.start();
    const session = await provider.createSession({ cwd: os.tmpdir() });
    await provider.prompt(session.id, "TASK");
    assert.equal(provider.getSession(session.id)?.backgroundTasks[0]?.status, "running");
    await provider.stopTask?.(session.id, "task-1");
    await waitFor(() => provider.getSession(session.id)?.backgroundTasks[0]?.status === "stopped", "the task to stop");
    // The adapter's notice shows as a line, and no turn starts.
    await waitFor(() => texts(provider.getSession(session.id)).includes("assistant:**Task stopped by user:** sleep 1 && echo done"), "the notice");
    assert.equal(provider.getSession(session.id)?.transcript.some((item) => item.type === "user" && item.hidden), false);
    assert.equal(provider.getSession(session.id)?.status, "idle");
  } finally {
    await cleanup();
  }
});

test("claude: a thought is timed from when Claude went quiet, not from its first chunk", async () => {
  const { provider, cleanup } = claudeHarness();
  try {
    await provider.start();
    const session = await provider.createSession({ cwd: os.tmpdir() });
    await provider.prompt(session.id, "THINK");
    const current = provider.getSession(session.id);
    assert.ok(current);
    const thought = presentSession(current).transcript.find((item) => item.type === "thought");
    assert.equal(thought?.type === "thought" ? thought.text : null, "Mulling it over.");
    const duration = thought && "durationMs" in thought ? (thought.durationMs ?? 0) : 0;
    assert.ok(duration >= 250, `the thought lasted ${duration} ms`);
  } finally {
    await cleanup();
  }
});

test("claude: a restart after the adapter dies keeps the account this start checked, whatever the settings say now", async () => {
  const account = mkdtempSync(path.join(os.tmpdir(), "x-bench-claude-account-"));
  let settings: { configDir?: string; problem?: string } = { configDir: account };
  const { provider, store, cleanup } = claudeHarness({ readSettings: () => settings });
  try {
    await provider.start();
    await provider.createSession({ cwd: os.tmpdir() });
    // The settings file breaks while Claude runs. Read now, it would name no folder, which is the default ~/.claude.
    settings = { problem: "claude.json does not read." };
    const pid = (provider as ClaudeProvider).agentPid();
    assert.ok(pid);
    process.kill(pid, "SIGKILL");
    await waitFor(() => (store().configDirs ?? []).length === 2 && provider.status === "ready", "the restarted adapter");
    assert.deepEqual(store().configDirs, [account, account]);
  } finally {
    await cleanup();
    rmSync(account, { recursive: true, force: true });
  }
});

test("claude: a message held behind a turn survives the adapter dying, and goes once the session reloads", async () => {
  const { provider, cleanup } = claudeHarness();
  try {
    await provider.start();
    const session = await provider.createSession({ cwd: os.tmpdir() });
    const turn = provider.prompt(session.id, "HANG").catch(() => null);
    await waitFor(() => provider.getSession(session.id)?.status === "running", "the turn");
    const later = provider.followUp(session.id, "later");
    await waitFor(() => provider.getSession(session.id)?.queue.length === 1, "the held message");
    const pid = (provider as ClaudeProvider).agentPid();
    assert.ok(pid);
    process.kill(pid, "SIGKILL");
    await turn;
    await later;
    const done = provider.getSession(session.id);
    assert.deepEqual(texts(done).slice(-2), ["user:later", "assistant:pong"]);
    assert.deepEqual(done?.queue, []);
  } finally {
    await cleanup();
  }
});

test("chatgpt: side questions inherit the conversation, leave the running turn alone, and delete their hidden forks", async () => {
  const saved: SideEntry[] = [];
  const { provider, store, presets, cleanup } = chatgptHarness({
    saveSideAnswer: (_id, entry) => saved.push(entry),
    readSideHistory: () => saved,
    clearSideHistory: () => { saved.length = 0; },
  });
  try {
    await provider.start();
    const session = await provider.createSession({ cwd: os.tmpdir(), mode: "full" });
    await provider.prompt(session.id, "hello");
    await waitFor(() => provider.getSession(session.id)?.suggestion === "and then?", "the prompt suggestion");
    const before = structuredClone(provider.getSession(session.id));
    assert.equal((await provider.sideQuestion(session.id, " what did I say? ")).answer, "You said: hello");
    assert.deepEqual(provider.getSession(session.id), before);
    assert.deepEqual(provider.sideHistory(session.id).map((entry) => [entry.question, entry.answer]), [["what did I say?", "You said: hello"]]);
    assert.deepEqual(store().forks?.[0], {
      sessionId: "fake-2", source: session.id, meta: { "x-bench/sideQuestion": true }, mcpServers: [],
      systemPrompt: { mode: "append", content: [{ type: "text", text: "Answer this side question using only the conversation so far. Do not use any tools, run commands, inspect files, ask for input, or carry out work. Treat requests to do so as questions to explain. Answer directly in text; if the conversation does not contain enough information, say so." }] },
    });
    assert.equal(presets.size, 1);
    const turn = provider.prompt(session.id, "HANG");
    void turn.catch(() => {});
    await waitFor(() => texts(provider.getSession(session.id)).includes("assistant:working"), "the running turn");
    const during = structuredClone(provider.getSession(session.id));
    const answer = provider.sideQuestion(session.id, "SIDEPLAN");
    await waitFor(() => Object.keys(store().sessions).length === 2, "the temporary fork");
    assert.deepEqual((await listSessions(provider)).map((entry) => entry.sessionId), [session.id]);
    assert.equal(provider.sessions().length, 1);
    assert.equal((await answer).answer, "You said: hello, HANG");
    assert.deepEqual(provider.getSession(session.id), during);
    provider.cancel(session.id);
    await turn;
    assert.deepEqual(Object.keys(store().sessions), [session.id]);
    assert.deepEqual(store().deleted, ["fake-2", "fake-3"]);
    assert.deepEqual(store().modeCalls.slice(-2), ["read-only", "read-only"]);
    assert.deepEqual(store().configCalls.slice(-2), [["collaboration_mode", "plan"], ["collaboration_mode", "plan"]]);
    assert.equal(provider.catalog.has("fake-2"), false);
  } finally {
    await cleanup();
  }
});

test("chatgpt: a side answer that opens with a lead-in keeps the plan that follows", async () => {
  const { provider, store, cleanup } = chatgptHarness();
  try {
    await provider.start();
    const session = await provider.createSession({ cwd: os.tmpdir(), mode: "full" });
    await provider.prompt(session.id, "hello");
    assert.equal((await provider.sideQuestion(session.id, "SIDEMIXED")).answer, "You said: hello");
    assert.deepEqual(Object.keys(store().sessions), [session.id]);
  } finally {
    await cleanup();
  }
});

test("chatgpt: side-question errors clean up forks, and clearing or forgetting a chat discards late history", async () => {
  const saved: SideEntry[] = [];
  const { provider, store, cleanup } = chatgptHarness({ saveSideAnswer: (_id, entry) => saved.push(entry) });
  try {
    await provider.start();
    const session = await provider.createSession({ cwd: os.tmpdir() });
    await provider.prompt(session.id, "hello");
    await assert.rejects(provider.sideQuestion(session.id, "  "), /Ask a question first/);
    await assert.rejects(provider.sideQuestion(session.id, "NOANSWER"), /ChatGPT gave no answer/);
    await assert.rejects(provider.sideQuestion(session.id, "FAILSIDE"), /side question failed/);
    await assert.rejects(provider.sideQuestion(session.id, "SIDETOOL"), /tried to use a tool/);
    assert.deepEqual(store().sideReplies, [{ outcome: { outcome: "cancelled" } }, { action: "decline" }]);
    assert.equal(provider.getSession(session.id)?.pendingPermission, null);
    assert.equal(provider.getSession(session.id)?.pendingElicitation, null);
    const cleared = provider.sideQuestion(session.id, "why?");
    provider.clearSideHistory(session.id);
    await cleared;
    const forgotten = provider.sideQuestion(session.id, "why?");
    await provider.forgetSession(session.id);
    await forgotten;
    assert.deepEqual(saved, []);
    assert.deepEqual(Object.keys(store().sessions), [session.id]);
    assert.equal(store().deleted?.length, 5);
  } finally {
    await cleanup();
  }
});

test("chatgpt: its modes map to Codex's presets, plan to its collaboration mode, and a session starts in auto", async () => {
  const { provider, store, cleanup } = chatgptHarness();
  try {
    assert.deepEqual(provider.modes.map((mode) => mode.id), ["ask", "acceptEdits", "plan", "auto", "full"]);
    assert.equal(provider.defaultMode, "auto");
    await provider.start();
    const session = await provider.createSession({ cwd: os.tmpdir() });
    assert.equal(session.modeId, "auto");
    // The approval menu covers the preset and plan, and fast mode stays out while it is off.
    assert.deepEqual(session.configOptions.map((option) => option.id), ["model", "effort"]);
    await provider.setMode(session.id, "ask");
    await provider.setMode(session.id, "plan");
    assert.equal(provider.getSession(session.id)?.modeId, "plan");
    await provider.setMode(session.id, "acceptEdits");
    assert.equal(provider.getSession(session.id)?.modeId, "acceptEdits");
    assert.deepEqual(store().modeCalls, ["read-only", "workspace-write"]);
    assert.deepEqual(store().configCalls, [["collaboration_mode", "plan"], ["collaboration_mode", "default"]]);
    // A reload of a planning session stays in plan, whatever preset Codex reports under it.
    await provider.setMode(session.id, "plan");
    await provider.prompt(session.id, "hello");
    await provider.forgetSession(session.id);
    const loaded = await provider.loadSession(session.id, os.tmpdir());
    assert.equal(loaded?.modeId, "plan");
  } finally {
    await cleanup();
  }
});

test("chatgpt: a session that loads again gets the preset the person chose back, also under plan", async () => {
  const { provider, store, presets, cleanup } = chatgptHarness();
  try {
    await provider.start();
    const session = await provider.createSession({ cwd: os.tmpdir(), mode: "ask" });
    assert.equal(presets.get(session.id), "read-only");
    await provider.prompt(session.id, "hello");
    // Codex forgets the preset when the session loads again.
    await provider.forgetSession(session.id);
    // The load answers once the chosen preset is set again, so the menu never shows Codex's default.
    const loaded = await provider.loadSession(session.id, os.tmpdir());
    assert.equal(loaded?.modeId, "ask");
    assert.equal(store().sessions[session.id]?.mode, "read-only");
    // Planning on top of it: the reload keeps plan, and the preset under it is set again.
    await provider.setMode(session.id, "plan");
    await provider.forgetSession(session.id);
    await provider.loadSession(session.id, os.tmpdir());
    await waitFor(() => store().sessions[session.id]?.mode === "read-only", "the preset under plan");
    assert.equal(provider.getSession(session.id)?.modeId, "plan");
    await provider.setMode(session.id, "full");
    assert.equal(presets.get(session.id), "agent-full-access");
  } finally {
    await cleanup();
  }
});

test("chatgpt: after the adapter restarts, a session is on its chosen preset before Codex is ready again", async () => {
  const { provider, store, cleanup } = chatgptHarness();
  try {
    await provider.start();
    const session = await provider.createSession({ cwd: os.tmpdir(), mode: "ask" });
    await provider.prompt(session.id, "hello");
    await assert.rejects(provider.prompt(session.id, "CRASH"));
    // Ready comes only after the reload set the preset again, so a held message never goes before it.
    await waitFor(() => provider.status === "ready" && texts(provider.getSession(session.id)).includes("assistant:pong"), "the reload");
    assert.equal(provider.getSession(session.id)?.modeId, "ask");
    assert.equal(store().sessions[session.id]?.mode, "read-only");
  } finally {
    await cleanup();
  }
});

test("chatgpt: a failed new session does not make another session's model the new-chat default", async () => {
  const { provider, saved, cleanup } = chatgptHarness();
  try {
    await provider.start();
    const first = await provider.createSession({ cwd: os.tmpdir() });
    assert.equal(saved()?.defaultModel, "m1");
    await assert.rejects(provider.createSession({ cwd: path.join(os.tmpdir(), "FAILNEW") }));
    // The next config report is another session's, after a model change there.
    await provider.setConfig(first.id, "model", "m2");
    assert.equal(saved()?.defaultModel, "m1");
  } finally {
    await cleanup();
  }
});

test("chatgpt: a picture Codex looked at shows on its tool row, read from the file it names", async () => {
  const { provider, cleanup } = chatgptHarness();
  const folder = mkdtempSync(path.join(os.tmpdir(), "x-bench-shot-"));
  const shot = path.join(folder, "shot.png");
  const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==", "base64");
  writeFileSync(shot, png);
  try {
    await provider.start();
    const session = await provider.createSession({ cwd: os.tmpdir() });
    await provider.prompt(session.id, `IMAGE ${shot}`);
    const tool = provider.getSession(session.id)?.transcript.find((item) => item.type === "tool");
    assert.equal(tool?.type === "tool" ? tool.images?.[0]?.mimeType : null, "image/png");
    assert.equal(tool?.type === "tool" ? tool.images?.[0]?.data : null, png.toString("base64"));
  } finally {
    await cleanup();
    rmSync(folder, { recursive: true, force: true });
  }
});

test("chatgpt: board rules and the host tools' line are appended to Codex's instructions, again on every load", async () => {
  const { provider, store, cleanup } = chatgptHarness({ sessionTools: recordingTools().tools });
  try {
    await provider.start();
    const ruled = await provider.createSession({ cwd: os.tmpdir(), rules: "Move tickets." });
    await provider.createSession({ cwd: os.tmpdir() });
    await provider.prompt(ruled.id, "hello");
    await provider.forgetSession(ruled.id);
    await provider.loadSession(ruled.id, os.tmpdir(), { rules: "Move tickets." });
    const appended = store().metas.map((entry) => (entry.systemPrompt as { mode: string; content: { text: string }[] } | null)?.content.map((block) => block.text).join(""));
    assert.deepEqual(appended, ["Move tickets.\n\nSuggest follow-up tasks.", "Suggest follow-up tasks.", "Move tickets.\n\nSuggest follow-up tasks."]);
    assert.ok(store().metas.every((entry) => (entry.systemPrompt as { mode?: string } | null)?.mode === "append"));
    // The prompt goes as typed, so Codex names the thread after it.
    const sent = store().sessions[ruled.id]?.history.find((line) => JSON.stringify(line).includes("user_message_chunk"));
    assert.equal((sent as { params: { update: { content: { text: string } } } }).params.update.content.text, "hello");
  } finally {
    await cleanup();
  }
});

test("grok: closing a chat with a waiting question cancels it in Grok's shape", async () => {
  const { provider, store, cleanup } = grokHarness();
  try {
    await provider.start();
    const session = await provider.createSession({ cwd: os.tmpdir() });
    void provider.prompt(session.id, "GROKASK").catch(() => {});
    await waitFor(() => provider.getSession(session.id)?.pendingElicitation, "the question");
    await provider.forgetSession(session.id);
    assert.deepEqual(store().answers, [{ outcome: "cancelled" }]);
  } finally {
    await cleanup();
  }
});

test("grok: its ask_user_question shows as the question card and gets Grok's own answer back", async () => {
  const { provider, cleanup } = grokHarness();
  try {
    await provider.start();
    const session = await provider.createSession({ cwd: os.tmpdir() });
    const turn = provider.prompt(session.id, "GROKASK");
    const waiting = await waitFor(() => provider.getSession(session.id)?.pendingElicitation, "the question");
    assert.equal(waiting.message, "Which database?");
    assert.deepEqual(waiting.actions.map((choice) => choice.id), ["chat_about_this"]);
    assert.deepEqual(provider.activityMarks().attention, [session.id]);
    provider.answerElicitation(session.id, "accept", { question_0: "SQLite", question_0_custom: "WAL mode" });
    await turn;
    const done = provider.getSession(session.id);
    assert.equal(done?.pendingElicitation, null);
    assert.equal(
      texts(done).at(-1),
      `assistant:${JSON.stringify({ outcome: "accepted", answers: { "Which database?": "SQLite" }, annotations: { "Which database?": { notes: "WAL mode" } } })}`,
    );
  } finally {
    await cleanup();
  }
});

test("grok: stopping the turn answers its question as cancelled", async () => {
  const { provider, cleanup } = grokHarness();
  try {
    await provider.start();
    const session = await provider.createSession({ cwd: os.tmpdir() });
    const turn = provider.prompt(session.id, "GROKASK");
    await waitFor(() => provider.getSession(session.id)?.pendingElicitation, "the question");
    provider.cancel(session.id);
    await turn;
    assert.equal(texts(provider.getSession(session.id)).at(-1), `assistant:${JSON.stringify({ outcome: "cancelled" })}`);
  } finally {
    await cleanup();
  }
});

test("chatgpt: a subagent in a session of its own is a task row with its steps folded under it", async () => {
  const { provider, store, cleanup } = chatgptHarness();
  try {
    await provider.start();
    assert.deepEqual((store().clientCapabilities as { subagents?: unknown } | undefined)?.subagents, {});
    const session = await provider.createSession({ cwd: os.tmpdir() });
    await provider.prompt(session.id, "SUBAGENT");
    const done = provider.getSession(session.id);
    const tools = done?.transcript.flatMap((item) => (item.type === "tool" ? [item] : [])) ?? [];
    const child = `${session.id}:child`;
    assert.deepEqual(
      tools.map((tool) => [tool.toolCallId, tool.facts.role, tool.facts.agent, tool.title, tool.status, tool.parentId]),
      [
        [child, "subagent", "Explorer", "Read the notes", "completed", undefined],
        ["read-7", "read", undefined, "Read notes.txt", "completed", child],
      ],
    );
    // The subagent's reply and its own session stay out of the chat and the session list.
    assert.deepEqual(texts(done).slice(-1), ["assistant:done"]);
    assert.equal(provider.catalog.has(child), false);
    // A background command the subagent starts belongs to the parent chat.
    assert.deepEqual(done?.backgroundTasks.map((task) => [task.id, task.status]), [["task-7", "running"]]);
  } finally {
    await cleanup();
  }
});

test("chatgpt: a subagent's permission shows in its parent's chat", async () => {
  const { provider, cleanup } = chatgptHarness();
  try {
    await provider.start();
    const session = await provider.createSession({ cwd: os.tmpdir() });
    const turn = provider.prompt(session.id, "SUBAGENT ASK");
    await waitFor(() => provider.getSession(session.id)?.pendingPermission, "the subagent's permission");
    provider.answerPermission(session.id, "allow");
    await turn;
    const write = provider.getSession(session.id)?.transcript.find((item) => item.type === "tool" && item.toolCallId === "call-1");
    assert.deepEqual(write?.type === "tool" ? [write.status, write.parentId] : null, ["completed", `${session.id}:child`]);
  } finally {
    await cleanup();
  }
});

test("chatgpt: a plan Codex writes is one reply that grows, the session's plan document, and its steps", async () => {
  const { provider, store, cleanup } = chatgptHarness();
  try {
    await provider.start();
    // Codex sends plans as plan_update only to a client that says it shows them.
    assert.deepEqual((store().clientCapabilities as { plan?: unknown } | undefined)?.plan, {});
    const session = await provider.createSession({ cwd: os.tmpdir() });
    await provider.prompt(session.id, "PLANDOC");
    const done = provider.getSession(session.id);
    assert.deepEqual(texts(done).filter((line) => line.startsWith("assistant:")), ["assistant:1. Read the notes\n2. Write the summary"]);
    assert.deepEqual(done?.planDoc, { id: "plan-item-1", text: "1. Read the notes\n2. Write the summary" });
    assert.deepEqual(done?.plan?.map((step) => step.status), ["completed", "in_progress"]);
  } finally {
    await cleanup();
  }
});

test("chatgpt: Codex's plan review shows as a named row", async () => {
  const { provider, cleanup } = chatgptHarness();
  try {
    await provider.start();
    const session = await provider.createSession({ cwd: os.tmpdir() });
    await provider.prompt(session.id, "PLANREVIEW");
    assert.ok(texts(provider.getSession(session.id)).includes("tool:Plan review"));
  } finally {
    await cleanup();
  }
});

test("chatgpt: a turn Codex runs by itself ends when Codex says the thread is idle", async () => {
  const { provider, cleanup } = chatgptHarness();
  try {
    await provider.start();
    const session = await provider.createSession({ cwd: os.tmpdir() });
    await provider.prompt(session.id, "SELF");
    await waitFor(() => texts(provider.getSession(session.id)).includes("assistant:On my own."), "Codex's own turn");
    await waitFor(() => provider.getSession(session.id)?.status === "idle", "the turn to end");
  } finally {
    await cleanup();
  }
});

test("claude: a next-step message waits until Claude reads it, and can be sent now or deleted meanwhile", async () => {
  const { provider, store, cleanup } = claudeHarness();
  try {
    await provider.start();
    const session = await provider.createSession({ cwd: os.tmpdir() });
    const turn = provider.prompt(session.id, "HANG");
    await waitFor(() => provider.getSession(session.id)?.status === "running", "the turn");
    const deliveries = () =>
      (provider.getSession(session.id)?.transcript ?? []).flatMap((item) =>
        item.type === "user" && item.delivery ? [{ itemId: item.id, text: item.text, ...item.delivery }] : [],
      );

    await provider.steer?.(session.id, "go left", { at: "now" });
    await waitFor(() => deliveries()[0]?.state === "read", "the steer read at once");
    await provider.steer?.(session.id, "then right", { at: "next" });
    await provider.steer?.(session.id, "never mind", { at: "next" });
    const [now, right, dropped] = deliveries();
    assert.deepEqual([right?.state, dropped?.state], ["waiting", "waiting"]);
    assert.deepEqual(store().steers, [
      { idleBehavior: "promptRequired", priority: "now", uuid: now?.id },
      { idleBehavior: "promptRequired", priority: "next", uuid: right?.id },
      { idleBehavior: "promptRequired", priority: "next", uuid: dropped?.id },
    ]);

    await provider.removeSteer?.(session.id, String(dropped?.id));
    assert.deepEqual(deliveries().map((delivery) => delivery.text), ["go left", "then right"]);

    // Send now takes the message out of Claude's queue and steers it again at once, in the same bubble.
    await provider.sendSteerNow?.(session.id, String(right?.id));
    await waitFor(() => deliveries()[1]?.state === "read", "the message sent now read");
    assert.equal(deliveries()[1]?.itemId, right?.itemId);
    assert.deepEqual(store().steers?.at(-1), { idleBehavior: "promptRequired", priority: "now", uuid: deliveries()[1]?.id });

    provider.cancel(session.id);
    await turn;
  } finally {
    await cleanup();
  }
});

test("claude: Stop takes a waiting next-step message out of Claude's queue, so Claude never runs it", async () => {
  const { provider, cleanup } = claudeHarness();
  try {
    await provider.start();
    const session = await provider.createSession({ cwd: os.tmpdir() });
    const turn = provider.prompt(session.id, "HANG");
    await waitFor(() => provider.getSession(session.id)?.status === "running", "the turn");
    await provider.steer?.(session.id, "later", { at: "next" });
    provider.cancel(session.id);
    await turn;
    const user = provider.getSession(session.id)?.transcript.find((item) => item.type === "user" && item.text === "later");
    assert.equal(user?.type === "user" ? user.delivery?.state : null, "unread");
  } finally {
    await cleanup();
  }
});

test("claude: a Send now that fails keeps the message as Not read, so it can be sent again", async () => {
  const { provider, cleanup } = claudeHarness();
  try {
    await provider.start();
    const session = await provider.createSession({ cwd: os.tmpdir() });
    const turn = provider.prompt(session.id, "HANG");
    await waitFor(() => provider.getSession(session.id)?.status === "running", "the turn");
    await provider.steer?.(session.id, "NONOW then right", { at: "next" });
    const bubble = () => {
      const item = provider.getSession(session.id)?.transcript.find((entry) => entry.type === "user" && entry.text === "NONOW then right");
      return item?.type === "user" ? item : undefined;
    };
    const itemId = bubble()?.id;
    await assert.rejects(async () => provider.sendSteerNow?.(session.id, String(bubble()?.delivery?.id)), /steer refused/);
    assert.equal(bubble()?.id, itemId);
    assert.equal(bubble()?.delivery?.state, "unread");
    provider.cancel(session.id);
    await turn;
  } finally {
    await cleanup();
  }
});

test("claude: Delete and Send now do nothing once Claude has read the message", async () => {
  const { provider, store, cleanup } = claudeHarness();
  try {
    await provider.start();
    const session = await provider.createSession({ cwd: os.tmpdir() });
    const turn = provider.prompt(session.id, "HANG");
    await waitFor(() => provider.getSession(session.id)?.status === "running", "the turn");
    await provider.steer?.(session.id, "go left", { at: "now" });
    const delivery = () => {
      const item = provider.getSession(session.id)?.transcript.find((entry) => entry.type === "user" && entry.text === "go left");
      return item?.type === "user" ? item.delivery : undefined;
    };
    await waitFor(() => delivery()?.state === "read", "the steer read");
    const id = String(delivery()?.id);
    await provider.removeSteer?.(session.id, id);
    await provider.sendSteerNow?.(session.id, id);
    assert.deepEqual(delivery(), { id, state: "read" });
    assert.equal(store().steers?.length, 1);
    provider.cancel(session.id);
    await turn;
  } finally {
    await cleanup();
  }
});

test("chatgpt: steer joins the running turn as the person's message, and one that finds no turn starts its own", async () => {
  const { provider, store, cleanup } = chatgptHarness();
  try {
    await provider.start();
    const session = await provider.createSession({ cwd: os.tmpdir() });
    const turn = provider.prompt(session.id, "HANG");
    await waitFor(() => provider.getSession(session.id)?.status === "running", "the turn");
    assert.deepEqual(await provider.steer(session.id, "faster"), { outcome: "injected" });
    await waitFor(() => texts(provider.getSession(session.id)).some((line) => line.includes("steered: faster")), "the steer");
    assert.ok(texts(provider.getSession(session.id)).includes("user:faster"));
    // A steer Codex could not deliver is an error, not a message that silently vanishes.
    await assert.rejects(provider.steer(session.id, "FAILSTEER"), /could not take the message/);
    provider.cancel(session.id);
    await turn;
    // Codex ended its turn, but one more line makes the app see it running: the steer finds no turn.
    await provider.prompt(session.id, "QUIET");
    await waitFor(() => provider.getSession(session.id)?.status === "running", "the line after the turn");
    assert.deepEqual(await provider.steer(session.id, "late"), { outcome: "startedNewTurn" });
    await waitFor(() => texts(provider.getSession(session.id)).includes("user:late"), "the late message");
    await waitFor(() => provider.getSession(session.id)?.status === "idle", "Codex's turn to end");
    // It went as a steer, not as a prompt.
    assert.doesNotMatch(JSON.stringify(store().sessions[session.id]?.history ?? []), /"late"/);
  } finally {
    await cleanup();
  }
});

test("chatgpt: an older session's board rules stay out of its transcript, with no empty message", async () => {
  const { provider, store, cleanup } = chatgptHarness();
  try {
    await provider.start();
    const session = await provider.createSession({ cwd: os.tmpdir() });
    await provider.prompt(session.id, "hello");
    await provider.stop();
    // Like older sessions: their rules went with the first prompt, in its block or a block of their own.
    const file = JSON.parse(readFileSync(chatgptStore(provider), "utf8")) as FakeStore;
    const tagged = "<x-bench-board-rules>\nRules\n</x-bench-board-rules>";
    const rulesOnly = { jsonrpc: "2.0", method: "session/update", params: { sessionId: session.id, update: { sessionUpdate: "user_message_chunk", content: { type: "text", text: tagged } } } };
    const prompt = file.sessions[session.id]?.history.find((line) => JSON.stringify(line).includes("user_message_chunk")) as { params: { update: { content: { text: string } } } };
    prompt.params.update.content.text = `${tagged}\n\n${prompt.params.update.content.text}`;
    file.sessions[session.id]?.history.unshift(rulesOnly);
    writeFileSync(chatgptStore(provider), JSON.stringify(file));
    await provider.start();
    const loaded = await provider.loadSession(session.id, os.tmpdir());
    assert.deepEqual(texts(loaded ?? null), ["user:hello", "assistant:pong"]);
    assert.ok(store().sessions[session.id]);
  } finally {
    await cleanup();
  }
});

test("chatgpt: a picture link that leads to another kind of file shows nothing", async () => {
  const { provider, cleanup } = chatgptHarness();
  const folder = mkdtempSync(path.join(os.tmpdir(), "x-bench-shot-"));
  writeFileSync(path.join(folder, "secret.txt"), "SECRET-TEXT");
  symlinkSync(path.join(folder, "secret.txt"), path.join(folder, "link.png"));
  try {
    await provider.start();
    const session = await provider.createSession({ cwd: os.tmpdir() });
    await provider.prompt(session.id, `IMAGE ${path.join(folder, "link.png")}`);
    const tool = provider.getSession(session.id)?.transcript.find((item) => item.type === "tool");
    assert.equal(tool?.type === "tool" ? (tool.images?.length ?? 0) : -1, 0);
  } finally {
    await cleanup();
    rmSync(folder, { recursive: true, force: true });
  }
});

test("chatgpt: only an explicit sign-in failure reads as signed out", () => {
  const provider = new ChatGptProvider();
  const explain = (text: string) => Reflect.apply(Reflect.get(provider, "explainError"), provider, [new Error(text)]) as string;
  assert.match(explain("Authentication required"), /codex login/);
  assert.match(explain("Authentication required: not logged in"), /codex login/);
  for (const text of ["MCP server github returned 401 Unauthorized", "author field failed validation", "invalid params: auth header missing", "request failed with status 401"]) {
    assert.equal(explain(text), text, text);
  }
});

test("chatgpt: a signed-out turn says to sign in with codex in a terminal", async () => {
  const { provider, cleanup } = chatgptHarness();
  try {
    await provider.start();
    const session = await provider.createSession({ cwd: os.tmpdir() });
    await assert.rejects(provider.prompt(session.id, "AUTHFAIL"), /codex login/);
    assert.match(provider.getSession(session.id)?.error ?? "", /not signed in/);
  } finally {
    await cleanup();
  }
});

test("chatgpt: the model menu keeps Codex's list and the model a new session opens on", async () => {
  const { provider, saved, cleanup } = chatgptHarness();
  try {
    assert.deepEqual(provider.models().models.map((model) => model.value), ["default"]);
    await provider.start();
    const session = await provider.createSession({ cwd: os.tmpdir(), model: "m2", effort: "low" });
    assert.equal(saved()?.defaultModel, "m1");
    assert.equal(saved()?.defaultEffort, "high");
    const catalog = provider.models();
    assert.equal(catalog.defaultModel, "m1");
    assert.deepEqual(catalog.models.map((model) => model.value), ["m1", "m2"]);
    assert.equal(catalog.models[0]?.defaultEffort, "high");
    // Reloading a session on another model does not make that model the new-chat default.
    await provider.forgetSession(session.id);
    await provider.loadSession(session.id, os.tmpdir());
    assert.equal(saved()?.defaultModel, "m1");
    await provider.deleteSession(session.id);
    assert.deepEqual(await listSessions(provider, os.tmpdir()), []);
  } finally {
    await cleanup();
  }
});

test("chatgpt: the usage meter reads Codex's plan window from a short codex app-server", async () => {
  const folder = mkdtempSync(path.join(os.tmpdir(), "x-bench-fake-app-server-"));
  const starts = path.join(folder, "starts");
  const fake = (used: string) => ({ command: process.execPath, args: [path.join(here, "testing", "fakeCodexAppServer.ts"), starts, used] });
  const provider = new ChatGptProvider({ appServer: fake("90") });
  const authStatus = (kind: string, label?: string) =>
    Reflect.apply(Reflect.get(provider, "handleNotification"), provider, [{ method: "_auth/status_update", params: { authStatus: { kind, label } } }]);
  try {
    const [first, second] = await Promise.all([provider.accountUsage(), provider.accountUsage()]);
    assert.deepEqual(first, {
      percent: 90,
      period: "five-hour",
      resetsAt: new Date(1790820111 * 1000).toISOString(),
      tier: "ChatGPT Plus",
      windows: [
        { period: "five-hour", percent: 90, resetsAt: new Date(1790820111 * 1000).toISOString() },
        { period: "weekly", percent: 17, resetsAt: new Date(1791234524 * 1000).toISOString() },
      ],
    });
    assert.deepEqual(second, first);
    assert.equal(readFileSync(starts, "utf8").trim().split("\n").length, 1);

    // Codex could not reach ChatGPT, or did not start: the meter keeps what it shows.
    provider.options.appServer = fake("offline");
    assert.equal(await provider.accountUsage(), undefined);
    provider.options.appServer = { command: path.join(folder, "missing"), args: [] };
    assert.equal(await provider.accountUsage(), undefined);

    // Codex refused (signed out, an API key account) or has no windows: the meter goes.
    provider.options.appServer = fake("error");
    assert.equal(await provider.accountUsage(), null);
    provider.options.appServer = fake("90");
    assert.deepEqual(await provider.accountUsage(), first);
    provider.options.appServer = fake("none");
    assert.equal(await provider.accountUsage(), null);

    // A turn that failed for want of a sign-in does not stop the reads once codex login has run.
    provider.options.appServer = fake("90");
    Reflect.apply(Reflect.get(provider, "explainError"), provider, [new Error("Authentication required")]);
    assert.deepEqual(await provider.accountUsage(), first);

    // After the adapter's first report, another account or a sign-out drops the read under way and asks for a new one.
    let changes = 0;
    provider.onUsageChange(() => {
      changes += 1;
    });
    authStatus("account", "ChatGPT Plus");
    assert.equal(changes, 0);
    const beforeSwitch = provider.accountUsage();
    authStatus("api_key", "API key");
    assert.equal(changes, 1);
    assert.equal(await beforeSwitch, undefined);
    authStatus("api_key", "API key");
    assert.equal(changes, 1);
    authStatus("none");
    assert.equal(changes, 2);

    // A stopped provider drops the read under way, and reads again once asked.
    const pending = provider.accountUsage();
    await provider.stop();
    assert.equal(await pending, undefined);
    assert.deepEqual(await provider.accountUsage(), first);
  } finally {
    rmSync(folder, { recursive: true, force: true });
  }
});
