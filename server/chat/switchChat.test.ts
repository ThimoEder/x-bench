import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import type { Mode, NewSession, Provider } from "../../bridge/provider.ts";
import { emptySession, type SessionState, type TranscriptItem } from "../../bridge/reducer.ts";
import { memoryChatRecords } from "./chatRecords.ts";
import { HANDOFF_OPEN, withHandoff } from "./handoff.ts";
import { createProviders } from "../providers/providers.ts";
import { createSessionIndex } from "./sessionIndex.ts";
import { previewSwitch, switchChat, SwitchCancelled, SwitchError, type SwitchDeps } from "./switchChat.ts";

// A harness with sessions on disk that it can load again, unless the test says they are gone.
function harness(id: string, label: string, modes: Mode[]) {
  let next = 0;
  const open = new Map<string, SessionState>();
  const stored = new Map<string, TranscriptItem[]>();
  const log: string[] = [];
  const prompts: string[] = [];
  // prompt throws, or never ends while it waits on a permission nobody answers.
  const failing = { prompt: false, hang: false };
  // Runs after a session is created, as a harness that files its own sessions (Codex's preset) does.
  const onCreate: { hook?: (sessionId: string) => void } = {};
  const provider = {
    id,
    label,
    capabilities: { loadSession: true },
    modes: modes.map((mode) => ({ id: mode, name: mode })),
    defaultMode: modes[0],
    catalog: new Map(),
    models: () => ({ defaultModel: `${id}-model`, defaultEffort: "", models: [{ value: `${id}-model`, name: `${label} Model`, defaultEffort: "", efforts: [] }] }),
    getSession: (sessionId: string) => open.get(sessionId) ?? null,
    sessions: () => [...open.values()],
    activityMarks: () => ({ working: [], attention: [] }),
    onSession: () => () => {},
    onCatalog: () => () => {},
    onStatus: () => () => {},
    async createSession(options: NewSession) {
      next += 1;
      const session = { ...emptySession({ id: `${id}-${next}`, cwd: options.cwd, configOptions: [], modelId: options.model ?? `${id}-model` }), modeId: options.mode ?? modes[0]! };
      open.set(session.id, session);
      log.push(`create ${session.id} ${session.modeId}`);
      onCreate.hook?.(session.id);
      return session;
    },
    async loadSession(sessionId: string, cwd: string) {
      const items = stored.get(sessionId);
      if (!items) throw new Error("no such session");
      const session = { ...emptySession({ id: sessionId, cwd, configOptions: [], modelId: `${id}-model` }), transcript: items };
      open.set(sessionId, session);
      log.push(`load ${sessionId}`);
      return session;
    },
    async forgetSession(sessionId: string) {
      const session = open.get(sessionId);
      if (session) stored.set(sessionId, session.transcript);
      open.delete(sessionId);
      log.push(`forget ${sessionId}`);
    },
    // Answers every prompt with a summary, as a model asked for one would, unless the test made it fail.
    async prompt(sessionId: string, text: string) {
      if (failing.prompt) throw new Error("usage limit reached");
      if (failing.hang) {
        const waiting = open.get(sessionId)!;
        open.set(sessionId, { ...waiting, status: "running", pendingPermission: { toolCallId: "read" } as unknown as SessionState["pendingPermission"] });
        return new Promise<SessionState | undefined>(() => {});
      }
      const session = open.get(sessionId)!;
      const items: TranscriptItem[] = [
        { id: `${sessionId}-p${session.transcript.length}`, type: "user", text, streaming: false },
        { id: `${sessionId}-r${session.transcript.length}`, type: "assistant", text: "SUMMARY: the sidebar flash is fixed.", streaming: false },
      ];
      open.set(sessionId, { ...session, transcript: [...session.transcript, ...items] });
      log.push(`prompt ${sessionId}`);
      prompts.push(text);
      return open.get(sessionId);
    },
    cancelPermission(sessionId: string) {
      log.push(`cancel permission ${sessionId}`);
      const session = open.get(sessionId);
      if (session) open.set(sessionId, { ...session, pendingPermission: null });
    },
    cancel(sessionId: string) {
      log.push(`cancel ${sessionId}`);
    },
    async setConfig(sessionId: string) {
      return open.get(sessionId);
    },
    async setMode(sessionId: string, mode: Mode) {
      const session = open.get(sessionId);
      if (session) open.set(sessionId, { ...session, modeId: mode });
      return open.get(sessionId);
    },
  };
  const say = (sessionId: string, ...texts: string[]) => {
    const session = open.get(sessionId)!;
    const items = texts.map((text, index): TranscriptItem => ({ id: `${sessionId}-${session.transcript.length + index}`, type: index % 2 ? "assistant" : "user", text, streaming: false }));
    open.set(sessionId, { ...session, transcript: [...session.transcript, ...items] });
  };
  return { provider: provider as unknown as Provider, log, prompts, onCreate, failing, say, lose: (sessionId: string) => stored.delete(sessionId), open };
}

function setup() {
  const folder = mkdtempSync(path.join(os.tmpdir(), "x-bench-switch-"));
  const claude = harness("claude", "Claude", ["ask", "acceptEdits", "plan", "auto", "full"]);
  const grok = harness("grok", "Grok", ["full", "acceptEdits", "plan"]);
  const index = createSessionIndex(path.join(folder, "sessions.json"));
  const records = memoryChatRecords();
  const providers = createProviders([grok.provider, claude.provider], index, undefined, records);
  const deps: SwitchDeps = { providers, ensureProvider: async () => {}, rules: () => undefined, windows: () => ({}), blocked: () => null };
  return { folder, claude, grok, index, providers, records, deps };
}

async function claudeChat(world: ReturnType<typeof setup>) {
  const chat = await world.claude.provider.createSession({ cwd: "/w", mode: "ask" });
  world.providers.remember(chat, world.providers.get("claude")!);
  world.claude.say(chat.id, "Why does the sidebar flash?", "The row leaves too early.");
  return chat.id;
}

test("a Claude chat continues on Grok under its own id, with Claude's stretch frozen and handed over", async () => {
  const world = setup();
  try {
    const chatId = await claudeChat(world);
    const preview = previewSwitch(world.deps, { chatId, provider: "grok" });
    assert.equal(preview.resumes, false);
    assert.equal(preview.to, "Grok Model");
    assert.ok(preview.tokens > 0 && preview.tokens < preview.cap);

    await switchChat(world.deps, { chatId, provider: "grok" });

    assert.deepEqual(world.claude.log.slice(-1), [`forget ${chatId}`]);
    // Grok has no Ask first, so the chat lands in Grok's default mode.
    assert.deepEqual(world.grok.log, ["create grok-1 full"]);
    const view = world.providers.getSession(chatId);
    assert.equal(view?.id, chatId);
    assert.equal(world.providers.forSession(chatId).id, "grok");
    assert.equal(world.index.chatOf("grok-1")?.id, chatId);
    const record = world.records.get(chatId)!;
    assert.equal(record.stretches.length, 1);
    assert.equal(record.stretches[0]?.items.length, 2);
    assert.ok(record.pending?.startsWith(HANDOFF_OPEN));
    assert.match(record.pending ?? "", /<message from="Claude">\nThe row leaves too early\./);
    assert.equal(record.start?.resumed, false);
  } finally {
    rmSync(world.folder, { recursive: true, force: true });
  }
});

test("back on Claude, Claude picks up its own session and reads only what Grok said", async () => {
  const world = setup();
  try {
    const chatId = await claudeChat(world);
    await switchChat(world.deps, { chatId, provider: "grok" });
    // The first message on Grok carried the handoff in front of the person's words.
    world.grok.say("grok-1", withHandoff(world.records.get(chatId)!.pending!, "Check the reduced-motion case."), "transitionend never fires there.");

    const preview = previewSwitch(world.deps, { chatId, provider: "claude" });
    assert.equal(preview.resumes, true);
    await switchChat(world.deps, { chatId, provider: "claude" });

    assert.deepEqual(world.claude.log.slice(-1), [`load ${chatId}`]);
    assert.equal(world.providers.forSession(chatId).id, "claude");
    const record = world.records.get(chatId)!;
    assert.equal(record.stretches.length, 2);
    assert.equal(record.stretches[1]?.items[0]?.type === "user" && record.stretches[1].items[0].text, "Check the reduced-motion case.");
    assert.equal(record.start?.resumed, true);
    // The replayed history of Claude's own stretch is left out of the live transcript.
    assert.equal(record.skip, 2);
    assert.match(record.pending ?? "", /<message from="Grok">\ntransitionend never fires there\./);
    assert.doesNotMatch(record.pending ?? "", /The row leaves too early/);
    assert.equal(world.providers.ids.toApp("grok-1"), chatId);
  } finally {
    rmSync(world.folder, { recursive: true, force: true });
  }
});

test("when Claude's earlier session is gone, it starts a new one with the whole chat", async () => {
  const world = setup();
  try {
    const chatId = await claudeChat(world);
    await switchChat(world.deps, { chatId, provider: "grok" });
    world.claude.lose(chatId);
    await switchChat(world.deps, { chatId, provider: "claude" });

    assert.match(world.claude.log.at(-1) ?? "", /^create claude-2/);
    const record = world.records.get(chatId)!;
    assert.equal(record.start?.resumed, false);
    assert.equal(record.skip, 0);
    assert.match(record.pending ?? "", /The row leaves too early/);
  } finally {
    rmSync(world.folder, { recursive: true, force: true });
  }
});

test("a chat does not switch while its turn runs, or to the provider it runs on", async () => {
  const world = setup();
  try {
    const chatId = await claudeChat(world);
    assert.throws(() => previewSwitch(world.deps, { chatId, provider: "claude" }), SwitchError);
    world.claude.open.set(chatId, { ...world.claude.open.get(chatId)!, status: "running" });
    await assert.rejects(switchChat(world.deps, { chatId, provider: "grok" }), /Wait for the turn to end/);
  } finally {
    rmSync(world.folder, { recursive: true, force: true });
  }
});

test("past the cap, the model the chat leaves writes a summary, which the new one reads with the latest entries", async () => {
  const world = setup();
  try {
    const chatId = await claudeChat(world);
    world.claude.say(chatId, ...Array.from({ length: 30 }, (_, index) => `entry ${index} ${"x".repeat(300)}`));
    // A 4k window lets at most 1k tokens go whole.
    const deps = { ...world.deps, windows: () => ({ "grok-model": { size: 4000, compactAt: 80 } }) };
    const preview = previewSwitch(deps, { chatId, provider: "grok", model: "grok-model" });
    assert.equal(preview.summarize, true);
    assert.ok(preview.tokens > preview.cap);

    await switchChat(deps, { chatId, provider: "grok", model: "grok-model" });

    assert.ok(world.claude.log.includes(`prompt ${chatId}`));
    const record = world.records.get(chatId)!;
    assert.equal(record.start?.summarized, true);
    assert.match(record.pending ?? "", /SUMMARY: the sidebar flash is fixed\./);
    assert.match(record.pending ?? "", /entry 29/);
    // The summary and the last two exchanges, without the thirty entries before them.
    assert.doesNotMatch(record.pending ?? "", /entry 10 /);
    // The frozen stretch is the chat as it was, without the summary turn.
    assert.ok(record.stretches[0]!.items.every((item) => item.type !== "assistant" || !item.text.startsWith("SUMMARY")));
  } finally {
    rmSync(world.folder, { recursive: true, force: true });
  }
});

test("a preset the new harness filed under its own session moves to the chat, and that row goes", async () => {
  const world = setup();
  try {
    const chatId = await claudeChat(world);
    world.grok.onCreate.hook = (sessionId) => world.index.record({ id: sessionId, provider: "grok", harnessMode: "plan-preset" });
    await switchChat(world.deps, { chatId, provider: "grok" });
    assert.equal(world.index.get(chatId)?.harnessMode, "plan-preset");
    assert.equal(world.index.get("grok-1"), null);
  } finally {
    rmSync(world.folder, { recursive: true, force: true });
  }
});

test("when the earlier session is gone and the whole chat is past the limit, the old model still summarizes", async () => {
  const world = setup();
  try {
    const chatId = await claudeChat(world);
    world.claude.say(chatId, ...Array.from({ length: 12 }, (_, index) => `claude entry ${index} ${"x".repeat(3000)}`));
    await switchChat(world.deps, { chatId, provider: "grok" });
    world.grok.say("grok-1", "Short question.", "Short answer.");
    world.claude.lose(chatId);
    // Grok's own stretch is short, so the preview expects no summary. The resume fails, and the whole chat is long.
    assert.equal(previewSwitch(world.deps, { chatId, provider: "claude" }).summarize, false);
    await switchChat(world.deps, { chatId, provider: "claude" });
    assert.ok(world.grok.log.includes("prompt grok-1"));
    assert.equal(world.records.get(chatId)?.start?.summarized, true);
  } finally {
    rmSync(world.folder, { recursive: true, force: true });
  }
});

test("a model asked to summarize before its first message reads the handoff it was given with the request", async () => {
  const world = setup();
  try {
    const chatId = await claudeChat(world);
    world.claude.say(chatId, ...Array.from({ length: 12 }, (_, index) => `claude entry ${index} ${"x".repeat(3000)}`));
    await switchChat(world.deps, { chatId, provider: "grok" });
    world.claude.lose(chatId);
    const handed = world.records.get(chatId)!.pending!;
    // Straight back, before anything was sent on Grok: Claude's session is gone, so Grok summarizes the whole chat.
    await switchChat(world.deps, { chatId, provider: "claude" });
    assert.equal(world.grok.prompts.length, 1);
    assert.ok(world.grok.prompts[0]!.startsWith(handed));
  } finally {
    rmSync(world.folder, { recursive: true, force: true });
  }
});

test("asked to, the old model summarizes even a chat short enough to go whole", async () => {
  const world = setup();
  try {
    const chatId = await claudeChat(world);
    assert.equal(previewSwitch(world.deps, { chatId, provider: "grok" }).summarize, false);
    const steps: string[] = [];
    await switchChat(world.deps, { chatId, provider: "grok", handoff: "summary" }, { summarizing: () => steps.push("summarizing"), committing: () => steps.push("committing"), cancelled: false });
    assert.deepEqual(steps, ["summarizing", "committing"]);
    assert.ok(world.claude.log.includes(`prompt ${chatId}`));
    assert.equal(world.records.get(chatId)?.start?.summarized, true);
  } finally {
    rmSync(world.folder, { recursive: true, force: true });
  }
});

test("a switch cancelled while the old model summarizes leaves the chat where it was", async () => {
  const world = setup();
  try {
    const chatId = await claudeChat(world);
    let cancelled = false;
    const control = {
      summarizing: () => {
        cancelled = true;
      },
      committing: () => {},
      get cancelled() {
        return cancelled;
      },
    };
    await assert.rejects(switchChat(world.deps, { chatId, provider: "grok", handoff: "summary" }, control), SwitchCancelled);
    assert.equal(world.providers.forSession(chatId).id, "claude");
    assert.equal(world.records.get(chatId), null);
    // The session it opened on Grok is let go, and Claude's stays open.
    assert.deepEqual(world.grok.log, ["create grok-1 full", "forget grok-1"]);
    assert.ok(world.claude.open.has(chatId));
  } finally {
    rmSync(world.folder, { recursive: true, force: true });
  }
});

// A Claude chat long enough to need a summary on its way to Grok.
async function longClaudeChat(world: ReturnType<typeof setup>) {
  const chatId = await claudeChat(world);
  world.claude.say(chatId, ...Array.from({ length: 12 }, (_, index) => `claude entry ${index} ${"x".repeat(3000)}`));
  return chatId;
}

test("when the old model cannot run a turn, a long chat goes as text and the old model is not asked", async () => {
  const world = setup();
  try {
    const chatId = await longClaudeChat(world);
    const deps = { ...world.deps, blocked: (provider: Provider) => (provider.id === "claude" ? "Claude has reached its usage limit" : null) };
    const preview = previewSwitch(deps, { chatId, provider: "grok" });
    assert.equal(preview.summarize, false);
    assert.equal(preview.blocked, "Claude has reached its usage limit");
    assert.ok(preview.textTokens > 0);
    await switchChat(deps, { chatId, provider: "grok" });
    assert.equal(world.claude.prompts.length, 0);
    const record = world.records.get(chatId)!;
    assert.equal(record.start?.summarized, false);
    assert.match(record.pending ?? "", /claude entry 11/);
  } finally {
    rmSync(world.folder, { recursive: true, force: true });
  }
});

test("the person can skip the summary of a long chat", async () => {
  const world = setup();
  try {
    const chatId = await longClaudeChat(world);
    assert.equal(previewSwitch(world.deps, { chatId, provider: "grok" }).summarize, true);
    await switchChat(world.deps, { chatId, provider: "grok", handoff: "text" });
    assert.equal(world.claude.prompts.length, 0);
    assert.equal(world.records.get(chatId)?.start?.summarized, false);
  } finally {
    rmSync(world.folder, { recursive: true, force: true });
  }
});

test("a summary that fails sends the chat as text and notes it", async () => {
  const world = setup();
  try {
    const chatId = await longClaudeChat(world);
    world.claude.failing.prompt = true;
    await switchChat(world.deps, { chatId, provider: "grok" });
    const record = world.records.get(chatId)!;
    assert.equal(record.start?.summaryFailed, true);
    assert.equal(record.start?.summarized, false);
    assert.match(record.pending ?? "", /claude entry 11/);
    assert.match(record.pending ?? "", /claude entry 0 /);
  } finally {
    rmSync(world.folder, { recursive: true, force: true });
  }
});

test("a picked-up session that never got its handoff is handed everything before it too", async () => {
  const world = setup();
  try {
    const chatId = await claudeChat(world);
    await switchChat(world.deps, { chatId, provider: "grok" });
    // Nothing sent on Grok, straight back to Claude, a message there, then on to Grok again.
    await switchChat(world.deps, { chatId, provider: "claude" });
    world.claude.say(chatId, "A later question.", "A later answer.");
    await switchChat(world.deps, { chatId, provider: "grok" });
    assert.match(world.grok.log.at(-1) ?? "", /^load grok-1/);
    const pending = world.records.get(chatId)!.pending ?? "";
    assert.match(pending, /The row leaves too early/);
    assert.match(pending, /A later answer/);
  } finally {
    rmSync(world.folder, { recursive: true, force: true });
  }
});

test("a window still holding the old session cannot move a switched chat back when its turn ends", async () => {
  const world = setup();
  try {
    const chatId = await claudeChat(world);
    await switchChat(world.deps, { chatId, provider: "grok" });
    // What another window's idle event from Claude's copy of the chat would record.
    world.providers.remember({ ...emptySession({ id: chatId, cwd: "/w", configOptions: [] }) }, world.providers.get("claude")!);
    const row = world.index.get(chatId);
    assert.deepEqual([row?.provider, row?.harnessId], ["grok", "grok-1"]);
  } finally {
    rmSync(world.folder, { recursive: true, force: true });
  }
});

test("a summary turn that waits on a permission is stopped after its time, and the chat goes as text", async () => {
  const world = setup();
  try {
    const chatId = await longClaudeChat(world);
    world.claude.failing.hang = true;
    await switchChat({ ...world.deps, summaryMs: 30 }, { chatId, provider: "grok" });
    assert.deepEqual(world.claude.log.filter((line) => line.startsWith("cancel")), [`cancel permission ${chatId}`, `cancel ${chatId}`]);
    const record = world.records.get(chatId)!;
    assert.equal(record.start?.summaryFailed, true);
    assert.match(record.pending ?? "", /claude entry 11/);
  } finally {
    rmSync(world.folder, { recursive: true, force: true });
  }
});

test("a switch whose record cannot be saved leaves the chat on its provider and lets the new session go", async () => {
  const world = setup();
  try {
    const chatId = await claudeChat(world);
    const refusing = { ...world.records, save: () => false };
    const providers = createProviders([world.grok.provider, world.claude.provider], world.index, undefined, refusing);
    await assert.rejects(switchChat({ ...world.deps, providers }, { chatId, provider: "grok" }), /could not be saved/);
    assert.equal(world.index.get(chatId)?.provider, "claude");
    assert.equal(world.index.get(chatId)?.harnessId, chatId);
    assert.deepEqual(world.grok.log, ["create grok-1 full", "forget grok-1"]);
    assert.ok(world.claude.open.has(chatId));
  } finally {
    rmSync(world.folder, { recursive: true, force: true });
  }
});

test("a switch back with nothing new on the other model hands nothing over", async () => {
  const world = setup();
  try {
    const chatId = await claudeChat(world);
    await switchChat(world.deps, { chatId, provider: "grok" });
    await switchChat(world.deps, { chatId, provider: "claude", handoff: "summary" });
    const record = world.records.get(chatId)!;
    assert.equal(record.pending, null);
    assert.equal(record.start?.tokens, 0);
    assert.equal(world.grok.prompts.length, 0);
  } finally {
    rmSync(world.folder, { recursive: true, force: true });
  }
});
