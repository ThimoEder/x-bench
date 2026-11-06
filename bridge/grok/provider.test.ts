import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test, { mock } from "node:test";
import type { PromptBlock } from "../attachments.ts";
import { presentSession } from "../../server/present.ts";
import { GrokProvider, grokSignedIn } from "./provider.ts";
import { isRecord } from "../protocol.ts";
import type { SessionState } from "../reducer.ts";
import type { RpcHandlers, RpcId } from "../rpc.ts";
import type { Transport } from "./runtime.ts";

// The params fields these tests read from what the bridge sent.
interface SentParams {
  sessionId?: string;
  prompt?: PromptBlock[];
  orderedIds?: string[];
  modeId?: string;
  text?: string;
  generation?: number;
  _meta?: { rules?: string };
}

// One JSON-RPC message the bridge wrote to the fake socket.
interface Sent {
  jsonrpc?: string;
  id?: RpcId;
  method?: string;
  params?: SentParams;
  result?: unknown;
}

type Script = (message: Sent, transport: FakeTransport) => void;

// Checks the envelope. The nested params shape is whatever the bridge built, so it is trusted here.
function isSent(value: unknown): value is Sent {
  if (!isRecord(value)) return false;
  const { id, method, params } = value;
  const idOk = id === undefined || id === null || typeof id === "string" || typeof id === "number";
  return idOk && (method === undefined || typeof method === "string") && (params === undefined || isRecord(params));
}

// Grok's folder for the fake bridges, so their loads never read the real ~/.grok.
const grokHome = mkdtempSync(path.join(tmpdir(), "grok-home-"));
test.after(() => rmSync(grokHome, { recursive: true, force: true }));

// A bridge whose every connect opens a FakeTransport running the script.
function fakeBridge(script: Script) {
  const transports: FakeTransport[] = [];
  const bridge = new GrokProvider({
    home: grokHome,
    connect() {
      const transport = new FakeTransport(script);
      transports.push(transport);
      return transport;
    },
  });
  return { bridge, transports };
}

// The socket the bridge opened last.
function latest(transports: FakeTransport[]): FakeTransport {
  const transport = transports.at(-1);
  assert.ok(transport, "the bridge never connected");
  return transport;
}

function present<T>(value: T | null | undefined, what: string): T {
  assert.ok(value != null, what);
  return value;
}

function sessionOf(bridge: GrokProvider, sessionId: string): SessionState {
  return present(bridge.getSession(sessionId), `no session ${sessionId}`);
}

function findSent(transport: FakeTransport, predicate: (message: Sent) => boolean): Sent {
  return present(transport.sent.find(predicate), "the bridge did not send that message");
}

function paramsOf(message: Sent): SentParams {
  return present(message.params, `${message.method} carried no params`);
}

function blockAt(message: Sent, index: number): PromptBlock {
  return present(paramsOf(message).prompt?.[index], `no prompt block at ${index}`);
}

function blockText(message: Sent, index: number) {
  const block = blockAt(message, index);
  return block.type === "text" ? block.text : undefined;
}

function blockResource(message: Sent, index: number) {
  const block = blockAt(message, index);
  return block.type === "resource" ? block.resource : undefined;
}

// The suggestion request the script noted last. A function, so a test that cleared it reads the field fresh.
function askedSuggestion(transport: FakeTransport): Sent {
  return present(transport.suggest, "no suggestion request was sent");
}

function recordOf(value: unknown): Record<string, unknown> {
  assert.ok(isRecord(value), "expected an object");
  return value;
}

test("forgetSession closes the chat and drops it", async () => {
  const { bridge, transports } = fakeBridge((message, current) => {
    if (message.method === "initialize") {
      current.receive({ jsonrpc: "2.0", id: message.id, result: { protocolVersion: 1 } });
      return;
    }
    if (message.method === "session/new") {
      current.receive({ jsonrpc: "2.0", id: message.id, result: { sessionId: "s1", configOptions: [] } });
      return;
    }
    if (message.id) current.receive({ jsonrpc: "2.0", id: message.id, result: {} });
  });
  try {
    await bridge.start();
    const transport = latest(transports);
    await bridge.createSession({ cwd: "/tmp/proj" });
    bridge.catalog.set("s1", { sessionId: "s1", title: "Hi", cwd: "/tmp/proj", isWorktree: false, sessionKind: null });
    await bridge.forgetSession("s1");
    assert.equal(bridge.getSession("s1"), null);
    assert.equal(bridge.catalog.has("s1"), false);
    assert.equal(transport.sent.some((message) => message.method === "session/close" && message.params?.sessionId === "s1"), true);
  } finally {
    await bridge.stop();
  }
});

test("a session listener that throws leaves a permission request waiting, not failed", async () => {
  const { bridge, transports } = fakeBridge((message, current) => {
    if (message.method === "initialize") {
      current.receive({ jsonrpc: "2.0", id: message.id, result: { protocolVersion: 1 } });
      return;
    }
    if (message.method === "session/new") {
      current.receive({ jsonrpc: "2.0", id: message.id, result: { sessionId: "s1", configOptions: [] } });
      return;
    }
    if (message.id) current.receive({ jsonrpc: "2.0", id: message.id, result: {} });
  });
  const error = mock.method(console, "error", () => {});
  try {
    await bridge.start();
    const transport = latest(transports);
    await bridge.createSession({ cwd: "/tmp/proj" });
    bridge.onSession(() => {
      throw new Error("publish failed");
    });
    transport.receive({
      jsonrpc: "2.0",
      id: "perm-1",
      method: "session/request_permission",
      params: {
        sessionId: "s1",
        options: [{ optionId: "allow-once", name: "Yes", kind: "allow_once" }],
        toolCall: { toolCallId: "call-1", title: "Write a.txt", kind: "edit" },
      },
    });
    assert.equal(sessionOf(bridge, "s1").pendingPermission?.options[0]?.optionId, "allow-once");
    assert.equal(transport.sent.some((message) => message.id === "perm-1"), false);
    const logged = error.mock.calls.map((call) => call.arguments.map(String).join(" ")).join("\n");
    assert.match(logged, /session listener failed: publish failed/);
  } finally {
    error.mock.restore();
    await bridge.stop();
  }
});

test("streams a prompt, answers a permission, and reloads after the socket drops", async () => {
  const { bridge, transports } = fakeBridge(reply);

  try {
    await bridge.start();
    const created = await bridge.createSession({ cwd: "/tmp/proj" });
    assert.equal(created.id, "s1");
    assert.equal(created.modelId, "grok-4.7");
    assert.equal(created.transcript.map((item) => item.text).join(""), "early");

    const pending = bridge.prompt(created.id, "write it");
    await waitFor(() => bridge.getSession("s1")?.pendingPermission);
    const permission = sessionOf(bridge, "s1").pendingPermission;
    assert.equal(permission?.options[0]?.kind, "allow_once");
    assert.deepEqual(permission?.rawInput, { file_path: "a.txt" });

    bridge.answerPermission("s1", "allow-once");
    const finished = await pending;
    assert.equal(finished?.stopReason, "end_turn");
    assert.equal(finished?.transcript.find((item) => item.type === "user")?.text, "write it");
    assert.equal(finished?.transcript.find((item) => item.type === "tool")?.status, "completed");
    assert.equal(finished?.pendingPermission, null);
    const answer = transports[0]?.sent.find((message) => message.id === "perm-1");
    assert.deepEqual(answer?.result, { outcome: { outcome: "selected", optionId: "allow-once" } });

    present(transports[0], "the first transport").close();
    await waitFor(() => transports[1]?.sent.some((message) => message.method === "session/load"));
    await waitFor(() => bridge.getSession("s1")?.transcript.some((item) => item.text === "replayed"));
    assert.equal(bridge.status, "ready");
    assert.deepEqual(
      transports[1]?.sent.map((message) => message.method),
      ["initialize", "session/load", "_x.ai/suggestPrompt"],
    );
    assert.equal(bridge.getSession("s1")?.transcript.some((item) => item.text === "write it"), false);
  } finally {
    await bridge.stop();
  }
});

test("a grok that exits is started again, and its chats reload idle instead of resuming the dead turn", async () => {
  // A stand-in for grok that only listens on the port it is given, so the bridge sees it come up.
  const dir = mkdtempSync(path.join(tmpdir(), "fake-grok-"));
  const command = path.join(dir, "grok");
  writeFileSync(
    command,
    [
      "#!/usr/bin/env node",
      "const args = process.argv.slice(2);",
      'const [host, port] = args[args.indexOf("--bind") + 1].split(":");',
      'import("node:net").then((net) => net.createServer().listen(Number(port), host));',
    ].join("\n"),
    { mode: 0o755 },
  );
  // The new grok's replay ends where the old one died: on a running tool and a permission request.
  const replayDeadTurn: Script = (message, transport) => {
    if (message.method !== "session/load") {
      reply(message, transport);
      return;
    }
    transport.receive({
      jsonrpc: "2.0",
      method: "session/update",
      params: {
        sessionId: "s1",
        update: { sessionUpdate: "tool_call", toolCallId: "call-1", status: "in_progress", title: "Write a.txt", kind: "edit" },
      },
    });
    transport.receive({
      jsonrpc: "2.0",
      id: "perm-2",
      method: "session/request_permission",
      params: {
        sessionId: "s1",
        options: [{ optionId: "allow-once", name: "Yes", kind: "allow_once" }],
        toolCall: { toolCallId: "call-1", title: "Write a.txt", kind: "edit" },
      },
    });
    transport.receive({ jsonrpc: "2.0", id: message.id, result: { configOptions: [] } });
  };
  const transports: FakeTransport[] = [];
  const reported: [number, boolean][] = [];
  const bridge = new GrokProvider({
    command,
    home: dir,
    onAgentProcess: (pid, running) => reported.push([pid, running]),
    async openSocket() {
      const transport = new FakeTransport(transports.length ? replayDeadTurn : reply);
      transports.push(transport);
      return transport;
    },
  });

  const rosterFile = path.join(dir, "active_sessions.json");
  const roster = () => {
    const rows: unknown = JSON.parse(readFileSync(rosterFile, "utf8"));
    return Array.isArray(rows) ? rows.map((row) => (isRecord(row) ? [row.session_id, row.pid] : null)) : null;
  };

  try {
    await bridge.start();
    // Another live process holds the chat, so it goes on the roster only at a later load.
    writeFileSync(rosterFile, JSON.stringify([{ session_id: "s1", pid: process.pid, cwd: "/tmp/proj" }]));
    const created = await bridge.createSession({ cwd: "/tmp/proj" });
    assert.deepEqual(roster(), [["s1", process.pid]]);
    writeFileSync(rosterFile, "[]");
    const pending = bridge.prompt(created.id, "write it");
    await waitFor(() => bridge.getSession("s1")?.pendingPermission);

    const first = present(bridge.agentPid(), "the first grok pid");
    await bridge.loadSession("s1", "/tmp/proj");
    assert.deepEqual(roster(), [["s1", first]]);
    process.kill(first, "SIGKILL");
    await assert.rejects(pending, /connection closed/);
    await waitFor(() => bridge.status === "ready" && bridge.agentPid() !== first);
    // The Electron app stops the groups of the pids reported running and not exited since.
    assert.deepEqual(reported, [[first, true], [first, false], [bridge.agentPid(), true]]);
    assert.deepEqual(roster(), [["s1", bridge.agentPid()]]);

    assert.equal(transports.length, 2);
    const second = latest(transports);
    assert.deepEqual(
      second.sent.map((message) => message.method).slice(0, 2),
      ["initialize", "session/load"],
    );
    const reloaded = sessionOf(bridge, "s1");
    assert.equal(reloaded.status, "idle");
    assert.equal(reloaded.pendingPermission, null);
    assert.equal(bridge.activityMarks().working.includes("s1"), false);
    assert.deepEqual(findSent(second, (message) => message.id === "perm-2").result, { outcome: { outcome: "cancelled" } });

    const next = bridge.prompt("s1", "try again");
    next.catch(() => {});
    await waitFor(() => second.sent.some((message) => message.method === "session/prompt"));
    assert.equal(second.sent.some((message) => message.method === "_x.ai/interject"), false);
    await bridge.forgetSession("s1");
    assert.deepEqual(roster(), []);
  } finally {
    await bridge.stop();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("start() during a slow reconnect waits for the reload instead of the first-start timeout", async () => {
  const slowLoad: Script = (message, transport) => {
    if (message.method === "session/load") setTimeout(() => reply(message, transport), 300);
    else reply(message, transport);
  };
  const transports: FakeTransport[] = [];
  const bridge = new GrokProvider({
    readyTimeoutMs: 100,
    connect() {
      const transport = new FakeTransport(transports.length ? slowLoad : reply);
      transports.push(transport);
      return transport;
    },
  });
  try {
    await bridge.start();
    await bridge.createSession({ cwd: "/tmp/proj" });
    latest(transports).close();
    await waitFor(() => transports.length === 2);
    assert.equal(bridge.status, "reconnecting");
    await bridge.start();
    assert.equal(bridge.status, "ready");
    assert.equal(transports.length, 2);
  } finally {
    await bridge.stop();
  }
});

test("a saved update log fills the open chat without marking it as our turn", async () => {
  const { bridge, transports } = fakeBridge(quietNew);
  try {
    await bridge.start();
    const transport = latest(transports);
    await bridge.createSession({ cwd: "/tmp/proj" });
    const replayed = bridge.replaySessionLog("s1", [
      note("user_message_chunk", "hello"),
      note("agent_message_chunk", "pong"),
      note("turn_completed", null),
    ]);
    assert.equal(replayed?.status, "idle");
    assert.deepEqual(
      replayed?.transcript.map((item) => item.text),
      ["hello", "pong"],
    );
    bridge.ingestSessionLog("s1", [note("agent_message_chunk", "still going")]);
    assert.equal(bridge.getSession("s1")?.transcript.at(-1)?.text, "still going");
    assert.equal(bridge.getSession("s1")?.status, "idle");
    assert.equal(transport.sent.some((message) => message.method === "session/prompt"), false);
  } finally {
    await bridge.stop();
  }
});

test("an open chat keeps its live turn when opened again", async () => {
  const { bridge, transports } = fakeBridge(heldSession);
  try {
    await bridge.start();
    const transport = latest(transports);
    const created = await bridge.createSession({ cwd: "/tmp/proj" });
    const pending = bridge.prompt(created.id, "work");
    await waitFor(() => bridge.getSession("s1")?.status === "running");
    const again = await bridge.loadSession("s1", "/tmp/proj");
    assert.equal(again?.status, "running");
    assert.equal(again?.transcript.some((item) => item.text === "work"), true);
    assert.equal(transport.sent.some((message) => message.method === "session/load"), false);
    transport.receive({
      jsonrpc: "2.0",
      method: "session/update",
      params: {
        sessionId: "s1",
        update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "stream" } },
      },
    });
    assert.equal(bridge.getSession("s1")?.status, "running");
    assert.equal(bridge.getSession("s1")?.transcript.some((item) => item.text === "stream"), true);
    assert.deepEqual(bridge.activityMarks().working, ["s1"]);
    transport.receive({ jsonrpc: "2.0", id: transport.promptId, result: { stopReason: "end_turn" } });
    await pending;
    assert.equal(bridge.getSession("s1")?.status, "idle");
    assert.deepEqual(bridge.activityMarks().working, []);
  } finally {
    await bridge.stop();
  }
});

test("a saved chat opens finished, and a live tool stays working", async () => {
  const { bridge, transports } = fakeBridge(replaySession);
  try {
    await bridge.start();
    const transport = latest(transports);
    const finished = await bridge.loadSession("done", "/tmp/proj");
    assert.equal(finished?.status, "idle");
    assert.equal(finished?.transcript.at(-1)?.text, "all done");
    assert.equal(finished?.transcript.at(-1)?.streaming, false);
    assert.deepEqual(bridge.activityMarks().working, []);

    const live = await bridge.loadSession("live", "/tmp/proj");
    assert.equal(live?.status, "running");
    assert.equal(live?.transcript.some((item) => item.type === "tool" && item.status === "in_progress"), true);
    assert.deepEqual(bridge.activityMarks().working, ["live"]);

    const warmed = await bridge.loadSession("done", "/tmp/proj");
    assert.equal(warmed?.transcript.at(-1)?.text, "all done");
    assert.equal(transport.sent.filter((message) => message.method === "session/load" && message.params?.sessionId === "done").length, 1);

    transport.receive({
      jsonrpc: "2.0",
      method: "session/update",
      params: {
        sessionId: "done",
        update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "still going" } },
      },
    });
    assert.equal(bridge.getSession("done")?.status, "running");
    assert.equal(bridge.activityMarks().working.includes("done"), true);
  } finally {
    await bridge.stop();
  }
});

test("two sessions can prompt at the same time", async () => {
  const { bridge, transports } = fakeBridge(twoSessions);
  try {
    await bridge.start();
    const transport = latest(transports);
    const first = await bridge.createSession({ cwd: "/tmp/a" });
    const second = await bridge.createSession({ cwd: "/tmp/b" });
    const one = bridge.prompt(first.id, "alpha");
    const two = bridge.prompt(second.id, "beta");
    await waitFor(() => transport.sent.filter((message) => message.method === "session/prompt").length === 2);
    for (const message of transport.sent.filter((item) => item.method === "session/prompt")) {
      transport.receive({
        jsonrpc: "2.0",
        method: "session/update",
        params: {
          sessionId: paramsOf(message).sessionId,
          update: {
            sessionUpdate: "agent_message_chunk",
            content: { type: "text", text: blockText(message, 0) },
          },
        },
      });
      transport.receive({ jsonrpc: "2.0", id: message.id, result: { stopReason: "end_turn" } });
    }
    const [doneOne, doneTwo] = await Promise.all([one, two]);
    assert.match(present(doneOne, "no first session").transcript.map((item) => item.text).join("\n"), /alpha/);
    assert.match(present(doneTwo, "no second session").transcript.map((item) => item.text).join("\n"), /beta/);
    assert.equal(doneOne?.id, "s1");
    assert.equal(doneTwo?.id, "s2");
  } finally {
    await bridge.stop();
  }
});

test("a follow-up stays queued until the running turn finishes", async () => {
  const { bridge, transports } = fakeBridge(queuedFollowUp);
  try {
    await bridge.start();
    const transport = latest(transports);
    const created = await bridge.createSession({ cwd: "/tmp/queue" });
    const first = bridge.prompt(created.id, "first");
    await waitFor(() => transport.firstId);
    const second = bridge.followUp(created.id, "second");
    await waitFor(() => bridge.getSession(created.id)?.queue.some((entry) => entry.text === "second"));
    assert.equal(bridge.getSession(created.id)?.status, "running");

    bridge.editQueued(created.id, "q2", "edited", 0);
    await waitFor(() => transport.sent.some((message) => message.method === "_x.ai/queue/edit"));
    const edit = findSent(transport, (message) => message.method === "_x.ai/queue/edit");
    assert.equal(edit.id, undefined);
    assert.deepEqual(edit.params, { sessionId: created.id, id: "q2", newText: "edited", version: 0 });
    transport.receive({
      jsonrpc: "2.0",
      method: "_x.ai/queue/changed",
      params: {
        sessionId: created.id,
        entries: [{ id: "q2", version: 1, kind: "prompt", text: "edited", position: 0 }],
        runningPromptId: "p1",
        runningText: "first",
      },
    });
    await waitFor(() => bridge.getSession(created.id)?.queue[0]?.text === "edited");

    bridge.removeQueued(created.id, "q2", 1);
    const removed = findSent(transport, (message) => message.method === "_x.ai/queue/remove");
    assert.deepEqual(removed.params, { sessionId: created.id, id: "q2", version: 1 });

    transport.receive({ jsonrpc: "2.0", id: transport.firstId, result: { stopReason: "end_turn" } });
    await new Promise((resolve) => {
      setTimeout(resolve, 30);
    });
    assert.equal(bridge.getSession(created.id)?.status, "running");

    transport.receive({
      jsonrpc: "2.0",
      method: "_x.ai/queue/changed",
      params: { sessionId: created.id, entries: [], runningPromptId: "q2", runningText: "edited" },
    });
    transport.receive({ jsonrpc: "2.0", id: transport.secondId, result: { stopReason: "end_turn" } });
    await second;
    await first;
    assert.equal(bridge.getSession(created.id)?.status, "idle");
    assert.deepEqual(
      bridge.getSession(created.id)?.transcript.filter((item) => item.type === "user").map((item) => item.text),
      ["first", "edited"],
    );
  } finally {
    await bridge.stop();
  }
});

test("an image-only follow-up keeps its picture on the queue row", async () => {
  const { bridge, transports } = fakeBridge(queuedImage);
  try {
    await bridge.start();
    const transport = latest(transports);
    const created = await bridge.createSession({ cwd: "/tmp/queue-image" });
    const first = bridge.prompt(created.id, "first");
    await waitFor(() => transport.firstId);
    transport.receive({
      jsonrpc: "2.0",
      method: "_x.ai/queue/changed",
      params: {
        sessionId: created.id,
        entries: [{ id: "q1", version: 0, text: "", position: 0 }],
        runningPromptId: "p1",
        runningText: "first",
      },
    });
    const preview = "data:image/png;base64,iVBORw0KGgo";
    const png = Buffer.from("png-bytes").toString("base64");
    const second = bridge.followUp(created.id, "", [{ name: "shot.png", mimeType: "image/png", data: png, preview }]);
    await waitFor(() => bridge.getSession(created.id)?.queue.some((entry) => entry.id === "q2"));
    const queued = bridge.getSession(created.id)?.queue ?? [];
    assert.equal(queued.find((entry) => entry.id === "q1")?.attachments, undefined);
    assert.equal(queued.find((entry) => entry.id === "q2")?.text, "");
    assert.equal(queued.find((entry) => entry.id === "q2")?.attachments?.[0]?.preview, preview);
    const shown = presentSession(sessionOf(bridge, created.id)).queue.find((entry) => entry.id === "q2");
    assert.equal(shown?.attachments?.[0]?.name, "shot.png");
    assert.equal(shown?.attachments?.[0]?.kind, "image");
    assert.equal(shown?.attachments?.[0]?.preview, preview);

    transport.receive({
      jsonrpc: "2.0",
      method: "_x.ai/queue/changed",
      params: {
        sessionId: created.id,
        entries: [
          { id: "q1", version: 0, text: "", position: 0 },
          { id: "q2", version: 1, text: "a caption", position: 1 },
        ],
        runningPromptId: "p1",
        runningText: "first",
      },
    });
    await waitFor(() => bridge.getSession(created.id)?.queue.find((entry) => entry.id === "q2")?.text === "a caption");
    assert.equal(bridge.getSession(created.id)?.queue.find((entry) => entry.id === "q2")?.attachments?.[0]?.preview, preview);
    assert.equal(bridge.getSession(created.id)?.queue.find((entry) => entry.id === "q1")?.attachments, undefined);

    transport.receive({ jsonrpc: "2.0", id: transport.firstId, result: { stopReason: "end_turn" } });
    transport.receive({ jsonrpc: "2.0", id: transport.secondId, result: { stopReason: "end_turn" } });
    await first;
    await second;
  } finally {
    await bridge.stop();
  }
});

test("an image-only follow-up keeps its picture when the running turn's notice arrives first", async () => {
  const { bridge, transports } = fakeBridge(queuedImageBeforeRow);
  try {
    await bridge.start();
    const transport = latest(transports);
    const created = await bridge.createSession({ cwd: "/tmp/queue-image-early" });
    const first = bridge.prompt(created.id, "first");
    await waitFor(() => transport.firstId);
    transport.receive(queueNotice(created.id, [{ id: "q1", version: 0, text: "", position: 0 }], "p1"));
    const preview = "data:image/png;base64,iVBORw0KGgo";
    const png = Buffer.from("png-bytes").toString("base64");
    const second = bridge.followUp(created.id, "", [{ name: "shot.png", mimeType: "image/png", data: png, preview }]);
    await waitFor(() => bridge.getSession(created.id)?.queue.some((entry) => entry.id === "q2"));
    const queued = bridge.getSession(created.id)?.queue ?? [];
    assert.equal(queued.find((entry) => entry.id === "q1")?.attachments, undefined);
    assert.equal(queued.find((entry) => entry.id === "q2")?.attachments?.[0]?.preview, preview);
    transport.receive({ jsonrpc: "2.0", id: transport.firstId, result: { stopReason: "end_turn" } });
    transport.receive({ jsonrpc: "2.0", id: transport.secondId, result: { stopReason: "end_turn" } });
    await first;
    await second;
  } finally {
    await bridge.stop();
  }
});

test("a follow-up that starts running is not given to a later empty row", async () => {
  const { bridge, transports } = fakeBridge(queuedImageStartsRunning);
  try {
    await bridge.start();
    const transport = latest(transports);
    const created = await bridge.createSession({ cwd: "/tmp/queue-image-running" });
    const first = bridge.prompt(created.id, "first");
    await waitFor(() => transport.firstId);
    transport.receive(queueNotice(created.id, [{ id: "q1", version: 0, text: "", position: 0 }], "p1"));
    const preview = "data:image/png;base64,iVBORw0KGgo";
    const png = Buffer.from("png-bytes").toString("base64");
    const second = bridge.followUp(created.id, "", [{ name: "shot.png", mimeType: "image/png", data: png, preview }]);
    await waitFor(() => bridge.getSession(created.id)?.queueRunningId === "p2");
    assert.equal(bridge.getSession(created.id)?.queue.find((entry) => entry.id === "q1")?.attachments, undefined);
    transport.receive(
      queueNotice(
        created.id,
        [
          { id: "q1", version: 0, text: "", position: 0 },
          { id: "q2", version: 0, text: "", position: 1 },
        ],
        "p2",
      ),
    );
    await waitFor(() => bridge.getSession(created.id)?.queue.some((entry) => entry.id === "q2"));
    assert.equal(bridge.getSession(created.id)?.queue.find((entry) => entry.id === "q2")?.attachments, undefined);
    transport.receive({ jsonrpc: "2.0", id: transport.firstId, result: { stopReason: "end_turn" } });
    transport.receive({ jsonrpc: "2.0", id: transport.secondId, result: { stopReason: "end_turn" } });
    await first;
    await second;
  } finally {
    await bridge.stop();
  }
});

test("an image-only follow-up behind a running image-only turn keeps its own picture", async () => {
  const { bridge, transports } = fakeBridge((message, transport) => void queueImageReady(message, transport));
  try {
    await bridge.start();
    const transport = latest(transports);
    const created = await bridge.createSession({ cwd: "/tmp/queue-image-behind-image" });
    const png = Buffer.from("png-bytes").toString("base64");
    const running = "data:image/png;base64,cnVubmluZw";
    const queued = "data:image/png;base64,cXVldWVk";
    const first = bridge.prompt(created.id, "", [{ name: "first.png", mimeType: "image/png", data: png, preview: running }]);
    await waitFor(() => promptsOf(transport).length === 1);
    transport.receive(queueNotice(created.id, [], "p1"));
    const second = bridge.followUp(created.id, "", [{ name: "second.png", mimeType: "image/png", data: png, preview: queued }]);
    await waitFor(() => promptsOf(transport).length === 2);
    transport.receive(queueNotice(created.id, [], "p1"));
    transport.receive(queueNotice(created.id, [{ id: "q1", version: 0, text: "", position: 0 }], "p1"));
    assert.equal(bridge.getSession(created.id)?.queue[0]?.attachments?.[0]?.preview, queued);
    for (const message of promptsOf(transport)) transport.receive({ jsonrpc: "2.0", id: message.id, result: { stopReason: "end_turn" } });
    await first;
    await second;
  } finally {
    await bridge.stop();
  }
});

test("a follow-up goes out after an earlier one that is still making its thumbnail", async () => {
  const dir = mkdtempSync(path.join(tmpdir(), "queue-order-"));
  const filePath = path.join(dir, "large.png");
  writeFileSync(filePath, Buffer.alloc(200000, 7));
  const { bridge, transports } = fakeBridge((message, transport) => void queueImageReady(message, transport));
  try {
    await bridge.start();
    const transport = latest(transports);
    const created = await bridge.createSession({ cwd: "/tmp/queue-order" });
    const first = bridge.prompt(created.id, "first");
    await waitFor(() => transport.firstId);
    const picture = bridge.followUp(created.id, "", [{ path: filePath }]);
    const words = bridge.followUp(created.id, "after the picture");
    await waitFor(() => promptsOf(transport).length === 3);
    const [, pictureSent, wordsSent] = promptsOf(transport);
    assert.equal(blockAt(present(pictureSent, "the picture"), 0).type, "image");
    assert.equal(blockText(present(wordsSent, "the words"), 0), "after the picture");
    for (const message of promptsOf(transport)) transport.receive({ jsonrpc: "2.0", id: message.id, result: { stopReason: "end_turn" } });
    await first;
    await picture;
    await words;
  } finally {
    await bridge.stop();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("sendQueuedNow moves that message to the front and cancels the turn", async () => {
  const { bridge, transports } = fakeBridge(sendNowScript);
  try {
    await bridge.start();
    const transport = latest(transports);
    const created = await bridge.createSession({ cwd: "/tmp/send-now" });
    transport.receive({
      jsonrpc: "2.0",
      method: "_x.ai/queue/changed",
      params: {
        sessionId: created.id,
        entries: [
          { id: "q1", version: 0, text: "first", position: 0 },
          { id: "q2", version: 0, text: "second", position: 1 },
        ],
        runningPromptId: "p1",
        runningText: "running",
      },
    });
    await bridge.sendQueuedNow(created.id, "q2");
    const reorder = findSent(transport, (message) => message.method === "_x.ai/queue/reorder");
    const cancel = findSent(transport, (message) => message.method === "session/cancel");
    assert.deepEqual(reorder.params?.orderedIds, ["q2", "q1"]);
    assert.equal(cancel.params?.sessionId, created.id);
    assert.ok(transport.sent.indexOf(reorder) < transport.sent.indexOf(cancel));
  } finally {
    await bridge.stop();
  }
});

test("setMode switches the session approval mode", async () => {
  const { bridge, transports } = fakeBridge(modeScript);
  try {
    await bridge.start();
    const transport = latest(transports);
    const created = await bridge.createSession({ cwd: "/tmp/mode" });
    assert.equal(created.modeId, "full");
    const updated = await bridge.setMode(created.id, "plan");
    assert.equal(updated?.modeId, "plan");
    const sent = findSent(transport, (message) => message.method === "session/set_mode");
    assert.deepEqual(sent.params, { sessionId: created.id, modeId: "plan" });
  } finally {
    await bridge.stop();
  }
});

test("steer injects a message into the running turn", async () => {
  const { bridge, transports } = fakeBridge(queuedFollowUp);
  try {
    await bridge.start();
    const transport = latest(transports);
    const created = await bridge.createSession({ cwd: "/tmp/steer" });
    const pending = bridge.prompt(created.id, "first");
    await waitFor(() => transport.firstId);
    const steered = await bridge.steer(created.id, "nudge");
    assert.equal(recordOf(steered).status, "queued");
    await waitFor(() => bridge.getSession(created.id)?.transcript.some((item) => item.text === "nudge"));
    transport.receive({ jsonrpc: "2.0", id: transport.firstId, result: { stopReason: "end_turn" } });
    const finished = await pending;
    assert.equal(finished?.status, "idle");
    assert.equal(finished?.transcript.filter((item) => item.type === "user").map((item) => item.text).join("|"), "first|nudge");
  } finally {
    await bridge.stop();
  }
});

test("exit_plan_mode shows the plan and answers with an outcome", async () => {
  const { bridge, transports } = fakeBridge(planExit);
  try {
    await bridge.start();
    const transport = latest(transports);
    const created = await bridge.createSession({ cwd: "/tmp/plan" });
    const pending = bridge.prompt(created.id, "plan it");
    await waitFor(() => bridge.getSession(created.id)?.pendingPlan);
    assert.match(present(sessionOf(bridge, created.id).pendingPlan, "no pending plan").plan, /Add hello/);
    bridge.answerPlan(created.id, "approved");
    const finished = await pending;
    assert.equal(finished?.pendingPlan, null);
    const answer = transport.sent.find((message) => message.id === "plan-1");
    assert.deepEqual(answer?.result, { outcome: "approved" });
  } finally {
    await bridge.stop();
  }
});

test("a prompt carries pasted images and files", async () => {
  const { bridge, transports } = fakeBridge((message, socket) => {
    if (message.method === "initialize") {
      socket.receive({ jsonrpc: "2.0", id: message.id, result: { protocolVersion: 1 } });
      return;
    }
    if (message.method === "session/new") {
      socket.receive({ jsonrpc: "2.0", id: message.id, result: { sessionId: "s1", configOptions: [] } });
      return;
    }
    if (message.method === "session/prompt") {
      socket.receive({ jsonrpc: "2.0", id: message.id, result: { stopReason: "end_turn" } });
    }
  });
  try {
    await bridge.start();
    const transport = latest(transports);
    const created = await bridge.createSession({ cwd: "/tmp/files" });
    const png = Buffer.from("png-bytes").toString("base64");
    const notes = Buffer.from("hello").toString("base64");
    await bridge.prompt(created.id, "look", [
      { name: "shot.png", mimeType: "image/png", data: png },
      { name: "../notes.txt", mimeType: "text/plain", data: notes },
    ]);
    const message = findSent(transport, (item) => item.method === "session/prompt");
    assert.equal(blockText(message, 0), "look");
    assert.deepEqual(blockAt(message, 1), { type: "image", mimeType: "image/png", data: png });
    assert.equal(blockResource(message, 2)?.text, "hello");
    assert.equal(blockResource(message, 2)?.uri, "attachment:notes.txt");
    const user = bridge.getSession(created.id)?.transcript.find((item) => item.type === "user");
    assert.equal(user?.text, "look");
    assert.deepEqual(
      user?.attachments?.map((file) => file.name),
      ["shot.png", "notes.txt"],
    );
  } finally {
    await bridge.stop();
  }
});

test("a finished turn fills the composer suggestion, and a late reply does not", async () => {
  const { bridge, transports } = fakeBridge((message, current) => {
    if (message.method === "initialize") {
      current.receive({ jsonrpc: "2.0", id: message.id, result: { protocolVersion: 1 } });
      return;
    }
    if (message.method === "session/new") {
      current.receive({ jsonrpc: "2.0", id: message.id, result: { sessionId: "s1", configOptions: [] } });
      return;
    }
    if (message.method === "session/prompt") {
      current.promptId = message.id;
      return;
    }
    if (message.method === "_x.ai/suggestPrompt") current.suggest = message;
  });
  try {
    await bridge.start();
    const transport = latest(transports);
    const created = await bridge.createSession({ cwd: "/tmp/proj" });
    const pending = bridge.prompt(created.id, "count");
    await waitFor(() => transport.promptId);
    transport.receive({ jsonrpc: "2.0", id: transport.promptId, result: { stopReason: "end_turn" } });
    await pending;
    await waitFor(() => transport.suggest);
    const asked = askedSuggestion(transport);
    assert.equal(asked.params?.sessionId, "s1");
    assert.equal(asked.params?.generation, 2);
    const again = bridge.prompt("s1", "more");
    await waitFor(() => bridge.getSession("s1")?.status === "running");
    transport.receive({
      jsonrpc: "2.0",
      id: asked.id,
      result: { suggestion: "stale", generation: 1 },
    });
    await new Promise((resolve) => {
      setTimeout(resolve, 30);
    });
    assert.equal(bridge.getSession("s1")?.suggestion, null);
    transport.suggest = null;
    transport.receive({ jsonrpc: "2.0", id: transport.promptId, result: { stopReason: "end_turn" } });
    await again;
    await waitFor(() => transport.suggest?.params?.generation === 4);
    transport.receive({
      jsonrpc: "2.0",
      id: askedSuggestion(transport).id,
      result: { suggestion: "next", generation: 4 },
    });
    await waitFor(() => bridge.getSession("s1")?.suggestion === "next");
  } finally {
    await bridge.stop();
  }
});

test("prompt suggestions stay off when the agent disables them", async () => {
  const { bridge, transports } = fakeBridge((message, current) => {
    if (message.method === "initialize") {
      current.receive({ jsonrpc: "2.0", id: message.id, result: { protocolVersion: 1 } });
      return;
    }
    if (message.method === "session/new") {
      current.receive({ jsonrpc: "2.0", id: message.id, result: { sessionId: "s1", configOptions: [] } });
      return;
    }
    if (message.method === "session/prompt") current.promptId = message.id;
  });
  try {
    await bridge.start();
    const transport = latest(transports);
    await bridge.createSession({ cwd: "/tmp/proj" });
    transport.receive({
      jsonrpc: "2.0",
      method: "_x.ai/settings/update",
      params: { prompt_suggestions_enabled: false },
    });
    const pending = bridge.prompt("s1", "count");
    await waitFor(() => transport.promptId);
    transport.receive({ jsonrpc: "2.0", id: transport.promptId, result: { stopReason: "end_turn" } });
    await pending;
    await new Promise((resolve) => {
      setTimeout(resolve, 30);
    });
    assert.equal(transport.sent.some((message) => message.method === "_x.ai/suggestPrompt"), false);
    assert.equal(bridge.getSession("s1")?.suggestion, null);
  } finally {
    await bridge.stop();
  }
});

function sendNowScript(message: Sent, transport: FakeTransport) {
  if (message.method === "initialize") {
    transport.receive({ jsonrpc: "2.0", id: message.id, result: { protocolVersion: 1 } });
    return;
  }
  if (message.method === "session/new") {
    transport.receive({ jsonrpc: "2.0", id: message.id, result: { sessionId: "s1", configOptions: [] } });
    return;
  }
  if (message.method === "_x.ai/queue/reorder") {
    const { orderedIds, sessionId } = paramsOf(message);
    assert.ok(orderedIds, "the reorder carried no ids");
    const entries = orderedIds.map((id, position) => ({
      id,
      version: 0,
      text: id === "q2" ? "second" : "first",
      position,
    }));
    transport.receive({
      jsonrpc: "2.0",
      method: "_x.ai/queue/changed",
      params: { sessionId, entries, runningPromptId: "p1", runningText: "running" },
    });
  }
}

function modeScript(message: Sent, transport: FakeTransport) {
  if (message.method === "initialize") {
    transport.receive({ jsonrpc: "2.0", id: message.id, result: { protocolVersion: 1 } });
    return;
  }
  if (message.method === "session/new") {
    transport.receive({ jsonrpc: "2.0", id: message.id, result: { sessionId: "s1", configOptions: [] } });
    return;
  }
  if (message.method === "session/set_mode") {
    transport.receive({
      jsonrpc: "2.0",
      method: "session/update",
      params: {
        sessionId: paramsOf(message).sessionId,
        update: { sessionUpdate: "current_mode_update", currentModeId: paramsOf(message).modeId },
      },
    });
    transport.receive({ jsonrpc: "2.0", id: message.id, result: {} });
  }
}

function promptsOf(transport: FakeTransport) {
  return transport.sent.filter((message) => message.method === "session/prompt");
}

function queueNotice(
  sessionId: string,
  entries: { id: string; version: number; text: string; position: number }[],
  runningPromptId: string,
) {
  return {
    jsonrpc: "2.0",
    method: "_x.ai/queue/changed",
    params: { sessionId, entries, runningPromptId, runningText: "" },
  };
}

function queuedImageBeforeRow(message: Sent, transport: FakeTransport) {
  if (!queueImageReady(message, transport)) return;
  if (message.method === "session/prompt" && blockAt(message, 0).type === "image") {
    transport.secondId = message.id;
    const sessionId = paramsOf(message).sessionId ?? "";
    assert.ok(sessionId);
    const older = [{ id: "q1", version: 0, text: "", position: 0 }];
    transport.receive(queueNotice(sessionId, older, "p1"));
    transport.receive(queueNotice(sessionId, [...older, { id: "q2", version: 0, text: "", position: 1 }], "p1"));
  }
}

function queuedImageStartsRunning(message: Sent, transport: FakeTransport) {
  if (!queueImageReady(message, transport)) return;
  if (message.method === "session/prompt" && blockAt(message, 0).type === "image") {
    transport.secondId = message.id;
    const sessionId = paramsOf(message).sessionId ?? "";
    assert.ok(sessionId);
    transport.receive(queueNotice(sessionId, [{ id: "q1", version: 0, text: "", position: 0 }], "p2"));
  }
}

function queueImageReady(message: Sent, transport: FakeTransport) {
  if (message.method === "initialize") {
    transport.receive({
      jsonrpc: "2.0",
      id: message.id,
      result: { protocolVersion: 1, agentCapabilities: { loadSession: true } },
    });
    return false;
  }
  if (message.method === "session/new") {
    transport.receive({
      jsonrpc: "2.0",
      id: message.id,
      result: { sessionId: "s1", configOptions: [] },
    });
    return false;
  }
  if (message.method === "session/prompt" && blockText(message, 0) === "first") {
    transport.firstId = message.id;
    return false;
  }
  return true;
}

function queuedImage(message: Sent, transport: FakeTransport) {
  if (message.method === "initialize") {
    transport.receive({
      jsonrpc: "2.0",
      id: message.id,
      result: { protocolVersion: 1, agentCapabilities: { loadSession: true } },
    });
    return;
  }
  if (message.method === "session/new") {
    transport.receive({
      jsonrpc: "2.0",
      id: message.id,
      result: { sessionId: "s1", configOptions: [] },
    });
    return;
  }
  if (message.method === "session/prompt" && blockText(message, 0) === "first") {
    transport.firstId = message.id;
    transport.receive({
      jsonrpc: "2.0",
      method: "_x.ai/queue/changed",
      params: {
        sessionId: paramsOf(message).sessionId,
        entries: [],
        runningPromptId: "p1",
        runningText: "first",
      },
    });
    return;
  }
  if (message.method === "session/prompt" && blockAt(message, 0).type === "image") {
    transport.secondId = message.id;
    transport.receive({
      jsonrpc: "2.0",
      method: "_x.ai/queue/changed",
      params: {
        sessionId: paramsOf(message).sessionId,
        entries: [
          { id: "q1", version: 0, text: "", position: 0 },
          { id: "q2", version: 0, text: "", position: 1 },
        ],
        runningPromptId: "p1",
        runningText: "first",
      },
    });
  }
}

function queuedFollowUp(message: Sent, transport: FakeTransport) {
  if (message.method === "initialize") {
    transport.receive({
      jsonrpc: "2.0",
      id: message.id,
      result: { protocolVersion: 1, agentCapabilities: { loadSession: true } },
    });
    return;
  }
  if (message.method === "session/new") {
    transport.receive({
      jsonrpc: "2.0",
      id: message.id,
      result: { sessionId: "s1", configOptions: [] },
    });
    return;
  }
  if (message.method === "_x.ai/interject") {
    transport.receive({
      jsonrpc: "2.0",
      method: "_x.ai/session/interjection",
      params: { sessionId: paramsOf(message).sessionId, text: paramsOf(message).text },
    });
    transport.receive({ jsonrpc: "2.0", id: message.id, result: { status: "queued" } });
    return;
  }
  if (message.method === "session/prompt" && blockText(message, 0) === "first") {
    transport.firstId = message.id;
    transport.receive({
      jsonrpc: "2.0",
      method: "_x.ai/queue/changed",
      params: {
        sessionId: paramsOf(message).sessionId,
        entries: [],
        runningPromptId: "p1",
        runningText: "first",
      },
    });
    return;
  }
  if (message.method === "session/prompt" && blockText(message, 0) === "second") {
    transport.secondId = message.id;
    transport.receive({
      jsonrpc: "2.0",
      method: "_x.ai/queue/changed",
      params: {
        sessionId: paramsOf(message).sessionId,
        entries: [{ id: "q2", version: 0, kind: "prompt", text: "second", position: 0 }],
        runningPromptId: "p1",
        runningText: "first",
      },
    });
  }
}

function planExit(message: Sent, transport: FakeTransport) {
  if (message.method === "initialize") {
    transport.receive({
      jsonrpc: "2.0",
      id: message.id,
      result: { protocolVersion: 1, agentCapabilities: { loadSession: true } },
    });
    return;
  }
  if (message.method === "session/new") {
    transport.receive({
      jsonrpc: "2.0",
      id: message.id,
      result: { sessionId: "s1", configOptions: [] },
    });
    return;
  }
  if (message.method === "session/prompt") {
    transport.receive({
      jsonrpc: "2.0",
      id: "plan-1",
      method: "_x.ai/exit_plan_mode",
      params: { sessionId: "s1", toolCallId: "call-1", planContent: "# Add hello\n" },
    });
    transport.promptId = message.id;
    return;
  }
  if (message.id === "plan-1" && message.result) {
    transport.receive({ jsonrpc: "2.0", id: transport.promptId, result: { stopReason: "end_turn" } });
  }
}

function note(kind: string, text: string | null) {
  if (kind === "turn_completed") {
    return {
      method: "_x.ai/session/update",
      params: { sessionId: "s1", update: { sessionUpdate: "turn_completed", stopReason: "end_turn" } },
    };
  }
  return {
    method: "session/update",
    params: {
      sessionId: "s1",
      update: { sessionUpdate: kind, content: { type: "text", text } },
    },
  };
}

function quietNew(message: Sent, transport: FakeTransport) {
  if (message.method === "initialize") {
    transport.receive({ jsonrpc: "2.0", id: message.id, result: { protocolVersion: 1 } });
    return;
  }
  if (message.method === "session/new") {
    transport.receive({ jsonrpc: "2.0", id: message.id, result: { sessionId: "s1", configOptions: [] } });
  }
}

function heldSession(message: Sent, transport: FakeTransport) {
  if (message.method === "initialize") {
    transport.receive({
      jsonrpc: "2.0",
      id: message.id,
      result: { protocolVersion: 1, agentCapabilities: { loadSession: true } },
    });
    return;
  }
  if (message.method === "session/new") {
    transport.receive({ jsonrpc: "2.0", id: message.id, result: { sessionId: "s1", configOptions: [] } });
    return;
  }
  if (message.method === "session/prompt") transport.promptId = message.id;
}

function replaySession(message: Sent, transport: FakeTransport) {
  if (message.method === "initialize") {
    transport.receive({
      jsonrpc: "2.0",
      id: message.id,
      result: { protocolVersion: 1, agentCapabilities: { loadSession: true } },
    });
    return;
  }
  if (message.method !== "session/load") return;
  const sessionId = paramsOf(message).sessionId;
  if (sessionId === "done") {
    transport.receive({
      jsonrpc: "2.0",
      method: "session/update",
      params: {
        sessionId,
        update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "all done" } },
      },
    });
  } else {
    transport.receive({
      jsonrpc: "2.0",
      method: "session/update",
      params: {
        sessionId,
        update: { sessionUpdate: "tool_call", toolCallId: "call-1", status: "in_progress", title: "Run tests", kind: "execute" },
      },
    });
  }
  transport.receive({ jsonrpc: "2.0", id: message.id, result: { configOptions: [] } });
}

function twoSessions(message: Sent, transport: FakeTransport) {
  if (message.method === "initialize") {
    transport.receive({
      jsonrpc: "2.0",
      id: message.id,
      result: { protocolVersion: 1, agentCapabilities: { loadSession: true } },
    });
    return;
  }
  if (message.method === "session/new") {
    transport.count = (transport.count || 0) + 1;
    const id = transport.count === 1 ? "s1" : "s2";
    transport.receive({
      jsonrpc: "2.0",
      id: message.id,
      result: { sessionId: id, configOptions: [{ id: "model", currentValue: "grok-4.7", options: [] }] },
    });
  }
}

function reply(message: Sent, transport: FakeTransport) {
  if (message.method === "initialize") {
    transport.receive({
      jsonrpc: "2.0",
      id: message.id,
      result: { protocolVersion: 1, agentCapabilities: { loadSession: true } },
    });
    return;
  }
  if (message.method === "session/new") {
    transport.receive({
      jsonrpc: "2.0",
      method: "session/update",
      params: {
        sessionId: "s1",
        update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "early" } },
      },
    });
    transport.receive({
      jsonrpc: "2.0",
      id: message.id,
      result: {
        sessionId: "s1",
        configOptions: [{ id: "model", name: "Model", currentValue: "grok-4.7", options: [] }],
      },
    });
    return;
  }
  if (message.method === "session/prompt") {
    transport.promptId = message.id;
    transport.receive({
      jsonrpc: "2.0",
      id: "perm-1",
      method: "session/request_permission",
      params: {
        sessionId: "s1",
        options: [{ optionId: "allow-once", name: "Yes", kind: "allow_once" }],
        toolCall: { toolCallId: "call-1", title: "Write a.txt", kind: "edit", rawInput: { file_path: "a.txt" } },
      },
    });
    return;
  }
  if (message.id === "perm-1" && message.result) {
    transport.receive({
      jsonrpc: "2.0",
      method: "session/update",
      params: {
        sessionId: "s1",
        update: { sessionUpdate: "tool_call_update", toolCallId: "call-1", status: "completed", title: "Write a.txt" },
      },
    });
    transport.receive({ jsonrpc: "2.0", id: transport.promptId, result: { stopReason: "end_turn" } });
    return;
  }
  if (message.method === "session/load") {
    transport.receive({
      jsonrpc: "2.0",
      method: "session/update",
      params: {
        sessionId: paramsOf(message).sessionId,
        update: { sessionUpdate: "user_message_chunk", content: { type: "text", text: "replayed" } },
      },
    });
    transport.receive({
      jsonrpc: "2.0",
      id: message.id,
      result: { configOptions: [{ id: "model", currentValue: "grok-4.7", options: [] }] },
    });
  }
}

test("a new session keeps extra rules on the system prompt and omits them when empty", async () => {
  const { bridge, transports } = fakeBridge((message, current) => {
    if (message.method === "initialize") {
      current.receive({ jsonrpc: "2.0", id: message.id, result: { protocolVersion: 1 } });
      return;
    }
    if (message.method === "session/new") {
      const id = paramsOf(message)._meta?.rules ? "ruled" : "plain";
      current.receive({ jsonrpc: "2.0", id: message.id, result: { sessionId: id, configOptions: [] } });
    }
  });
  try {
    await bridge.start();
    const transport = latest(transports);
    await bridge.createSession({ cwd: "/tmp/plain" });
    await bridge.createSession({ cwd: "/tmp/board", rules: "  Move tickets through the local board.  " });
    await bridge.createSession({ cwd: "/tmp/blank", rules: "   " });
    const created = transport.sent.filter((message) => message.method === "session/new");
    assert.deepEqual(created[0]?.params, { cwd: "/tmp/plain", mcpServers: [] });
    assert.deepEqual(created[1]?.params, {
      cwd: "/tmp/board",
      mcpServers: [],
      _meta: { rules: "Move tickets through the local board." },
    });
    assert.equal(Object.hasOwn(paramsOf(present(created[2], "a third session/new")), "_meta"), false);
  } finally {
    await bridge.stop();
  }
});

test("a side question does not enter the transcript, even while a turn is running", async () => {
  const { bridge, transports } = fakeBridge((message, current) => {
    if (message.method === "initialize") {
      current.receive({ jsonrpc: "2.0", id: message.id, result: { protocolVersion: 1 } });
      return;
    }
    if (message.method === "session/new") {
      current.receive({ jsonrpc: "2.0", id: message.id, result: { sessionId: "s1", configOptions: [] } });
      return;
    }
    if (message.method === "_x.ai/btw") {
      current.receive({ jsonrpc: "2.0", id: message.id, result: { result: { answer: "bridge.js" } } });
      return;
    }
    if (message.method === "session/prompt") current.promptId = message.id;
  });
  try {
    await bridge.start();
    const transport = latest(transports);
    const created = await bridge.createSession({ cwd: "/tmp/proj" });
    const pending = bridge.prompt(created.id, "work");
    const aside = await bridge.sideQuestion(created.id, " which file? ");
    assert.deepEqual(aside, { id: null, answer: "bridge.js" });
    const session = sessionOf(bridge, created.id);
    assert.equal(session.status, "running");
    assert.deepEqual(session.transcript.map((item) => item.text), ["work"]);
    assert.equal(transport.sent.filter((message) => message.method === "session/prompt").length, 1);
    const sent = findSent(transport, (message) => message.method === "_x.ai/btw");
    assert.deepEqual(sent.params, { sessionId: "s1", question: "which file?" });
    await assert.rejects(bridge.sideQuestion(created.id, "  "), /Ask a question first/);
    transport.receive({ jsonrpc: "2.0", id: transport.promptId, result: { stopReason: "end_turn" } });
    await pending;
  } finally {
    await bridge.stop();
  }
});

test("ending a background task asks Grok to kill it by its task id", async () => {
  const { bridge, transports } = fakeBridge((message, current) => {
    if (message.method === "initialize") {
      current.receive({ jsonrpc: "2.0", id: message.id, result: { protocolVersion: 1 } });
      return;
    }
    if (message.method === "session/new") {
      current.receive({ jsonrpc: "2.0", id: message.id, result: { sessionId: "s1", configOptions: [] } });
      return;
    }
    if (message.method === "_x.ai/task/kill") {
      current.receive({ jsonrpc: "2.0", id: message.id, result: { result: { taskId: "t1", outcome: "killed" } } });
    }
  });
  try {
    await bridge.start();
    const created = await bridge.createSession({ cwd: "/tmp/proj" });
    await bridge.stopTask(created.id, "t1");
    const sent = findSent(latest(transports), (message) => message.method === "_x.ai/task/kill");
    assert.deepEqual(sent.params, { sessionId: "s1", taskId: "t1" });
  } finally {
    await bridge.stop();
  }
});

test("a catalog folder change moves the open session onto that worktree", async () => {
  const { bridge, transports } = fakeBridge((message, current) => {
    if (message.method === "initialize") {
      current.receive({ jsonrpc: "2.0", id: message.id, result: { protocolVersion: 1 } });
      return;
    }
    if (message.method === "session/new") {
      current.receive({ jsonrpc: "2.0", id: message.id, result: { sessionId: "s1", configOptions: [] } });
    }
  });
  try {
    await bridge.start();
    const transport = latest(transports);
    await bridge.createSession({ cwd: "/repo" });
    sessionOf(bridge, "s1").transcript.push({ id: "user-1", type: "user", text: "hi", streaming: false });
    transport.receive({
      jsonrpc: "2.0",
      method: "_x.ai/sessions/changed",
      params: {
        upserted: [{ sessionId: "s1", cwd: "/repo/.grok/worktrees/topic", title: "Topic", isWorktree: true }],
      },
    });
    assert.equal(bridge.getSession("s1")?.cwd, "/repo/.grok/worktrees/topic");
    assert.equal(bridge.getSession("s1")?.transcript[0]?.text, "hi");
    assert.equal(bridge.catalog.get("s1")?.title, "Topic");
    transport.receive({
      jsonrpc: "2.0",
      method: "_x.ai/sessions/changed",
      params: { upserted: [{ sessionId: "s1", title: "Renamed" }] },
    });
    assert.equal(bridge.getSession("s1")?.cwd, "/repo/.grok/worktrees/topic");
  } finally {
    await bridge.stop();
  }
});

class FakeTransport implements Transport {
  script: Script;
  sent: Sent[];
  handlers: RpcHandlers | null;
  closed: Promise<void>;
  resolveClosed: () => void;
  // Ids and requests the scripts note so a test can answer them later.
  promptId?: RpcId;
  firstId?: RpcId;
  secondId?: RpcId;
  suggest?: Sent | null;
  count?: number;

  constructor(script: Script) {
    this.script = script;
    this.sent = [];
    this.handlers = null;
    const { promise, resolve } = Promise.withResolvers<void>();
    this.closed = promise;
    this.resolveClosed = resolve;
  }

  setHandlers(handlers: RpcHandlers) {
    this.handlers = handlers;
  }

  send(value: unknown) {
    if (!isSent(value)) throw new Error("the bridge sent something other than a JSON-RPC object");
    this.sent.push(value);
    queueMicrotask(() => this.script(value, this));
  }

  receive(message: unknown) {
    if (!this.handlers) throw new Error("the bridge has not attached its handlers");
    this.handlers.onMessage(JSON.stringify(message));
  }

  close() {
    this.handlers?.onClose();
    this.resolveClosed();
  }
}

function waitFor(predicate: () => unknown) {
  const started = Date.now();
  return new Promise<void>((resolve, reject) => {
    const timer = setInterval(() => {
      if (predicate()) {
        clearInterval(timer);
        resolve();
      } else if (Date.now() - started > 2000) {
        clearInterval(timer);
        reject(new Error("timed out waiting for bridge state"));
      }
    }, 10);
  });
}

test("grok models says whether Grok is signed in, and anything else is unknown", () => {
  assert.equal(grokSignedIn("You are logged in with grok.com.\n\nDefault model: grok-4.7\n"), true);
  assert.equal(grokSignedIn("You are not authenticated.\n\nDefault model: grok-4.6\n"), false);
  assert.equal(grokSignedIn("Available models:\n  * grok-4.7\n"), null);
  assert.equal(grokSignedIn(null), null);
});

test("a missing grok reports the command that installs it", async () => {
  const detected = await new GrokProvider({ command: "/nonexistent/grok" }).detect();
  assert.equal(detected.installed, false);
  assert.match(detected.command ?? "", /x\.ai\/cli\/install\.sh/);
});
