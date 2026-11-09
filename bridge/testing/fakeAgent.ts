// A small ACP agent for tests: enough of Grok, the Claude adapter or the Codex adapter to run the
// provider contract. It is not a model. A prompt's text picks what it does:
//   PERMISSION  asks a permission with request id 0, then writes once it is answered
//   TWOPERMS    asks two permissions at once (perm-a, perm-b) and says each answer as it comes back.
//               Context used 2 follows both. WITHDRAW perm-a or WITHDRAW perm-b withdraws that one right away,
//               and DROP stops the agent
//   QUESTION    asks a form (elicitation/create, request id "ask-1"), then says what came back
//   TWOQUESTIONS asks the same form twice at once (ask-a, ask-b) and says each answer as it comes back.
//               Context used 2 follows both, so a test can tell they have arrived
//   GIVEUP      asks the same form, withdraws it with $/cancel_request, then ends the turn
//   GROKASK     asks with Grok's _x.ai/ask_user_question (request id "ask-1"), then says what came back
//   HANG        runs until session/cancel, then ends the turn as cancelled
//   SILENT      like HANG, but sends nothing at all before the cancel
//   (new) a cwd containing FAILNEW makes session/new fail
//   CRASH       stops the agent (the stdio fake exits, the socket fake closes)
//   THINK       is silent for 300 ms, then sends its thinking and the answer, like a short Claude think
//   SUBAGENT    runs a Codex subagent in a session of its own and finishes it. With ASK, the subagent asks a permission (id 0)
//   AGENT       runs a Claude subagent (the Agent tool) and finishes it
//   TASK        starts a background task, ends the turn, then finishes the task (Claude's async_task_*)
//   IMAGE <p>   looks at the picture at path p, as Codex's view_image does: a tool linking to the file
//   PLANDOC     writes a plan as Codex does in plan mode (plan_update, growing), then its steps
//   PLANREVIEW  finishes Codex's plan review tool call, which has no title
//   SELF        ends the turn, then runs one of its own and says the thread is idle, as Codex does
//   AUTHFAIL    fails the turn because the account is signed out, and leaves nothing in the thread
//   QUIET       ends the turn, then sends one more line, so the app sees a turn Codex no longer runs
//   (steer) FAILSTEER is refused with outcome failed, as the Codex adapter answers a steer it could not deliver
//   (steer) Claude Code takes a steer of priority now in at once, and one of priority next after an interrupt.
//           A next steer it has not taken in yet can be cancelled. A steer at now containing NONOW fails.
//   anything    streams "pong" in two chunks and names the session
// Sessions and their history live in the store, so a restarted agent can load them.

export interface FakeStore {
  sessions: Record<string, { cwd: string; history: unknown[]; mode: string; config: Record<string, string>; open?: boolean }>;
  modeCalls: string[];
  configCalls: [string, string][];
  // The _meta, mcpServers and systemPrompt of each session/new and session/load, in order.
  metas: { method: string; meta: unknown; mcpServers?: unknown; systemPrompt?: unknown }[];
  next: number;
  // Config ids the agent refuses to change, as a failing set.
  refuse?: string[];
  // What the client said it can show, in its last initialize.
  clientCapabilities?: unknown;
  // The CLAUDE_CONFIG_DIR each start of the fake Claude adapter got, in order.
  configDirs?: string[];
  // The _meta.steering of each steer, in order.
  steers?: unknown[];
  // The reply to each question the agent asked, in order.
  answers?: unknown[];
  forks?: { sessionId: string; source: string; meta: unknown; mcpServers: unknown; systemPrompt: unknown }[];
  deleted?: string[];
  sideReplies?: unknown[];
}

export interface FakeDialect {
  // The agent's own mode ids, in order. The first is where a new session starts.
  modes: string[];
  // The agent's config id for effort.
  effortId: string;
  // Claude lists a fast mode option. A session starts with it on, as when the user's settings saved it.
  fast?: boolean;
  // The Codex adapter: its preset (the mode) is a config option too, plan is a collaboration mode, fast
  // mode starts off, a turn ends with the thread going idle, and a steer with no turn starts one.
  codex?: boolean;
}

export const GROK_DIALECT: FakeDialect = { modes: ["agent", "acceptEdits", "plan"], effortId: "reasoning_effort" };
export const CLAUDE_DIALECT: FakeDialect = { modes: ["default", "acceptEdits", "plan", "auto", "bypassPermissions"], effortId: "effort", fast: true };
export const CHATGPT_DIALECT: FakeDialect = { modes: ["agent", "read-only", "workspace-write", "agent-full-access"], effortId: "reasoning_effort", codex: true };

export function emptyStore(): FakeStore {
  return { sessions: {}, modeCalls: [], configCalls: [], metas: [], next: 1 };
}

type Send = (message: unknown) => void;

interface Message {
  id?: string | number | null;
  method?: string;
  params?: Record<string, unknown>;
  result?: unknown;
  error?: unknown;
}

export function createFakeAgent(dialect: FakeDialect, store: FakeStore, { send, crash }: { send: Send; crash: () => void }) {
  let waiting: { promptId: Message["id"]; sessionId: string } | null = null;
  let hanging: { promptId: Message["id"]; sessionId: string } | null = null;
  let asking: { promptId: Message["id"]; sessionId: string } | null = null;
  let pair: { promptId: Message["id"]; sessionId: string; open: string[] } | null = null;
  // Claude steers of priority next, by uuid, until the running turn takes them in.
  let waitingSteers: { sessionId: string; uuid: string }[] = [];

  function reply(id: Message["id"], result: unknown) {
    send({ jsonrpc: "2.0", id, result });
  }

  function update(sessionId: string, body: Record<string, unknown>, record = true) {
    const message = { jsonrpc: "2.0", method: "session/update", params: { sessionId, update: body } };
    if (record) store.sessions[sessionId]?.history.push(message);
    send(message);
  }

  function configOptions(sessionId: string) {
    const session = store.sessions[sessionId];
    const codex = dialect.codex
      ? [
          { id: "mode", name: "Mode", currentValue: session?.mode, options: dialect.modes.map((value) => ({ value, name: value })) },
          { id: "collaboration_mode", name: "Collaboration mode", currentValue: session?.config.collaboration_mode ?? "default", options: [{ value: "default", name: "Default" }, { value: "plan", name: "Plan" }] },
          { id: "fast-mode", name: "Fast mode", currentValue: session?.config["fast-mode"] ?? "off", options: [{ value: "off", name: "Off" }, { value: "on", name: "On" }] },
        ]
      : [];
    return [
      ...codex,
      { id: "model", name: "Model", currentValue: session?.config.model ?? "m1", options: [{ value: "m1", name: "Model One" }, { value: "m2", name: "Model Two" }] },
      {
        id: dialect.effortId,
        name: "Effort",
        currentValue: session?.config[dialect.effortId] ?? "high",
        options: [{ value: "low", name: "Low" }, { value: "high", name: "High" }],
      },
      ...(dialect.fast
        ? [{ id: "fast", name: "Fast mode", currentValue: session?.config.fast ?? "on", options: [{ value: "on", name: "On" }, { value: "off", name: "Off" }] }]
        : []),
    ];
  }

  function modes(sessionId: string) {
    return { currentModeId: store.sessions[sessionId]?.mode, availableModes: dialect.modes.map((id) => ({ id, name: id })) };
  }

  // Claude Code's command_lifecycle frame, as the adapter forwards it raw.
  function commandFrame(sessionId: string, uuid: string, state: "started" | "completed" | "cancelled") {
    send({ jsonrpc: "2.0", method: "_claude/sdkMessage", params: { sessionId, message: { type: "command_lifecycle", state, command_uuid: uuid } } });
  }

  // Codex says when its thread goes idle, after every turn.
  function idle(sessionId: string) {
    if (dialect.codex) update(sessionId, { sessionUpdate: "session_info_update", _meta: { codex: { threadStatus: { type: "idle" } } } }, false);
  }

  function ask(sessionId: string, id = "ask-1") {
    send({
      jsonrpc: "2.0",
      id,
      method: "elicitation/create",
      params: {
        sessionId,
        toolCallId: "call-ask",
        mode: "form",
        message: "Which database?",
        requestedSchema: {
          type: "object",
          properties: {
            question_0: { type: "string", title: "Database", oneOf: [{ const: "Postgres", title: "Postgres" }, { const: "SQLite", title: "SQLite" }] },
            question_0_custom: { type: "string", title: "Other" },
          },
          required: ["question_0"],
        },
      },
    });
  }

  return function handle(message: Message) {
    const params = message.params ?? {};
    const sessionId = String(params.sessionId ?? "");
    if (!message.method && (message.id === "side-permission" || message.id === "side-question")) store.sideReplies = [...(store.sideReplies ?? []), message.result];
    if (!message.method && message.id === "ask-1") store.answers = [...(store.answers ?? []), message.result];
    if (!message.method && message.id === "ask-1" && asking) {
      const target = asking;
      asking = null;
      const said = message.error ? "withdrawn" : JSON.stringify(message.result);
      update(target.sessionId, { sessionUpdate: "agent_message_chunk", content: { type: "text", text: said } });
      reply(target.promptId, { stopReason: "end_turn" });
      idle(target.sessionId);
      return;
    }
    if (!message.method && pair && typeof message.id === "string" && pair.open.includes(message.id)) {
      const result = message.result as { outcome?: { outcome?: string; optionId?: string } } | undefined;
      const said = message.error ? "withdrawn" : result?.outcome ? (result.outcome.optionId ?? result.outcome.outcome) : JSON.stringify(result);
      update(pair.sessionId, { sessionUpdate: "agent_message_chunk", content: { type: "text", text: `${pair.open.length === 2 ? "" : " "}${message.id}:${said}` } });
      pair.open = pair.open.filter((id) => id !== message.id);
      if (pair.open.length === 0) {
        reply(pair.promptId, { stopReason: "end_turn" });
        idle(pair.sessionId);
        pair = null;
      }
      return;
    }
    if (!message.method) {
      // An answer to the permission request with id 0.
      if (message.id === 0 && waiting) {
        const outcome = (message.result as { outcome?: { optionId?: string } } | undefined)?.outcome;
        const target = waiting;
        waiting = null;
        update(target.sessionId, { sessionUpdate: "tool_call_update", toolCallId: "call-1", status: "completed", title: "Write note.txt", kind: "edit" });
        update(target.sessionId, { sessionUpdate: "agent_message_chunk", content: { type: "text", text: outcome?.optionId === "allow" ? "wrote" : "skipped" } });
        reply(target.promptId, { stopReason: "end_turn" });
        idle(target.sessionId);
      }
      return;
    }
    switch (message.method) {
      case "initialize":
        store.clientCapabilities = params.clientCapabilities ?? null;
        reply(message.id, { protocolVersion: 1, agentCapabilities: { loadSession: true }, agentInfo: { name: "fake", version: "1" } });
        return;
      case "session/new": {
        store.metas.push({ method: "session/new", meta: params._meta ?? null, mcpServers: params.mcpServers ?? null, systemPrompt: params.systemPrompt ?? null });
        if (String(params.cwd ?? "").includes("FAILNEW")) {
          send({ jsonrpc: "2.0", id: message.id, error: { code: -32603, message: "could not start a thread" } });
          return;
        }
        const id = `fake-${store.next++}`;
        // Like Claude: a new session opens on the effort its _meta names.
        const effort = (params._meta as { claudeCode?: { options?: { effort?: unknown } } } | undefined)?.claudeCode?.options?.effort;
        const config: Record<string, string> = dialect.fast && typeof effort === "string" ? { [dialect.effortId]: effort } : {};
        store.sessions[id] = { cwd: String(params.cwd ?? ""), history: [], mode: dialect.modes[0] ?? "", config, open: true };
        reply(message.id, { sessionId: id, modes: modes(id), configOptions: configOptions(id) });
        return;
      }
      case "session/fork": {
        const source = store.sessions[sessionId];
        if (!source) {
          send({ jsonrpc: "2.0", id: message.id, error: { code: -32002, message: "Resource not found" } });
          return;
        }
        const id = `fake-${store.next++}`;
        store.sessions[id] = { ...source, history: structuredClone(source.history), config: { ...source.config }, open: true };
        store.forks = [...(store.forks ?? []), { sessionId: id, source: sessionId, meta: params._meta, mcpServers: params.mcpServers, systemPrompt: params.systemPrompt }];
        reply(message.id, { sessionId: id, modes: modes(id), configOptions: configOptions(id) });
        return;
      }
      case "session/load": {
        store.metas.push({ method: "session/load", meta: params._meta ?? null, mcpServers: params.mcpServers ?? null, systemPrompt: params.systemPrompt ?? null });
        const session = store.sessions[sessionId];
        if (!session) {
          send({ jsonrpc: "2.0", id: message.id, error: { code: -32002, message: "Resource not found" } });
          return;
        }
        // Like Codex: its thread keeps the collaboration mode but not the preset, which is back on the default.
        if (dialect.codex) session.mode = dialect.modes[0] ?? "";
        // Like Claude: a load comes back on the default model, effort and permission mode.
        if (dialect.fast) {
          session.mode = dialect.modes[0] ?? "";
          delete session.config.model;
          delete session.config[dialect.effortId];
        }
        for (const line of session.history) send(line);
        reply(message.id, { modes: modes(sessionId), configOptions: configOptions(sessionId) });
        return;
      }
      case "_session/btw": {
        // Like the patched Claude adapter: Claude Code answers from the conversation, which does not change.
        const said = (store.sessions[sessionId]?.history ?? [])
          .map((line) => (line as { params?: { update?: { sessionUpdate?: string; content?: { text?: string } } } }).params?.update)
          .filter((update) => update?.sessionUpdate === "user_message_chunk")
          .map((update) => update?.content?.text ?? "");
        // NOANSWER: Claude Code gave none, as when the side question was cancelled.
        const question = String(params.question ?? "");
        setTimeout(() => reply(message.id, { response: question.includes("NOANSWER") ? null : `You said: ${said.join(", ")}` }), 10);
        return;
      }
      case "session/set_mode":
        store.modeCalls.push(String(params.modeId));
        if (store.sessions[sessionId]) store.sessions[sessionId].mode = String(params.modeId);
        // The Codex adapter takes a moment to answer (it asks the app-server), which a race would show.
        if (dialect.codex) setTimeout(() => reply(message.id, {}), 80);
        else reply(message.id, {});
        return;
      case "session/set_config_option": {
        store.configCalls.push([String(params.configId), String(params.value)]);
        if (store.refuse?.includes(String(params.configId))) {
          send({ jsonrpc: "2.0", id: message.id, error: { code: -32603, message: "refused" } });
          return;
        }
        // Like Claude: a value in another case is taken as the listed one.
        const listed = configOptions(sessionId)
          .find((option) => option.id === params.configId)
          ?.options.find((choice) => choice.value.toLowerCase() === String(params.value).toLowerCase());
        const value = dialect.fast && listed ? listed.value : String(params.value);
        if (store.sessions[sessionId]) store.sessions[sessionId].config[String(params.configId)] = value;
        // Like Claude after a switch to Opus: fast mode is back on.
        if (dialect.fast && params.configId === "model" && value === "m2" && store.sessions[sessionId]) store.sessions[sessionId].config.fast = "on";
        reply(message.id, { configOptions: configOptions(sessionId) });
        return;
      }
      case "session/cancel":
        if (asking && asking.sessionId === sessionId) {
          reply(asking.promptId, { stopReason: "cancelled" });
          asking = null;
          idle(sessionId);
        }
        for (const steer of waitingSteers.filter((item) => item.sessionId === sessionId)) commandFrame(sessionId, steer.uuid, "started");
        waitingSteers = waitingSteers.filter((item) => item.sessionId !== sessionId);
        if (hanging && hanging.sessionId === sessionId) {
          reply(hanging.promptId, { stopReason: "cancelled" });
          hanging = null;
          idle(sessionId);
        }
        // Like the Claude adapter: a stopped turn withdraws the permissions it still waits on.
        if (pair && pair.sessionId === sessionId) {
          for (const id of pair.open) send({ jsonrpc: "2.0", method: "$/cancel_request", params: { requestId: id } });
          reply(pair.promptId, { stopReason: "cancelled" });
          pair = null;
          idle(sessionId);
        }
        return;
      case "_session/steering": {
        const steered = (Array.isArray(params.prompt) ? params.prompt : []).map((block) => (block as { text?: string }).text ?? "").join("");
        // Like the Codex adapter: a steer it cannot deliver is an outcome, not an error.
        if (dialect.codex && steered.includes("FAILSTEER")) {
          reply(message.id, { outcome: "failed" });
          return;
        }
        // Like the Codex adapter: with no turn running, the steer starts one of its own.
        if (dialect.codex && (!hanging || hanging.sessionId !== sessionId)) {
          reply(message.id, { outcome: "startedNewTurn" });
          update(sessionId, { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "pong" } });
          idle(sessionId);
          return;
        }
        // Like the Claude adapter: joins a running turn, or asks for a prompt when none runs.
        if (!hanging || hanging.sessionId !== sessionId) {
          reply(message.id, { outcome: "promptRequired", reason: "noRunningTurn" });
          return;
        }
        const blocks = Array.isArray(params.prompt) ? params.prompt : [];
        const text = blocks.map((block) => (block as { text?: string }).text ?? "").join("");
        update(sessionId, { sessionUpdate: "agent_message_chunk", content: { type: "text", text: ` (steered: ${text})` } });
        if (dialect.codex) {
          reply(message.id, { outcome: "injected" });
          return;
        }
        const steering = (params._meta as { steering?: { priority?: string; uuid?: string } } | undefined)?.steering;
        if (steering?.priority === "now" && text.includes("NONOW")) {
          send({ jsonrpc: "2.0", id: message.id, error: { code: -32603, message: "steer refused" } });
          return;
        }
        store.steers = [...(store.steers ?? []), steering ?? null];
        reply(message.id, { outcome: "injected", ...(steering?.uuid ? { uuid: steering.uuid } : {}) });
        if (!steering?.uuid) return;
        if (steering.priority === "next") waitingSteers.push({ sessionId, uuid: steering.uuid });
        else commandFrame(sessionId, steering.uuid, "started");
        return;
      }
      case "_session/steering/cancel": {
        const waiting = waitingSteers.some((item) => item.uuid === params.uuid);
        waitingSteers = waitingSteers.filter((item) => item.uuid !== params.uuid);
        reply(message.id, { cancelled: waiting });
        if (waiting) commandFrame(sessionId, String(params.uuid), "cancelled");
        return;
      }
      case "_session/async_task/stop":
        // Like the adapter: the task stops, and its state update says so.
        update(sessionId, { sessionUpdate: "async_task_state_update", asyncTaskId: String(params.asyncTaskId), state: "stopped" }, false);
        update(sessionId, { sessionUpdate: "notice", severity: "info", title: "Task stopped by user", description: "sleep 1 && echo done" }, false);
        reply(message.id, {});
        return;
      case "session/list":
        reply(message.id, {
          sessions: Object.entries(store.sessions)
            .filter(([, session]) => !params.cwd || session.cwd === params.cwd)
            .map(([id, session]) => ({ sessionId: id, cwd: session.cwd, title: null, updatedAt: null })),
        });
        return;
      case "session/delete": {
        store.deleted = [...(store.deleted ?? []), sessionId];
        delete store.sessions[sessionId];
        reply(message.id, {});
        return;
      }
      case "session/close":
        if (store.sessions[sessionId]) store.sessions[sessionId].open = false;
        reply(message.id, {});
        return;
      case "session/prompt": {
        const blocks = Array.isArray(params.prompt) ? params.prompt : [];
        const text = blocks.map((block) => (block as { text?: string }).text ?? "").join("");
        if (store.forks?.some((fork) => fork.sessionId === sessionId)) {
          if (text.includes("FAILSIDE")) {
            send({ jsonrpc: "2.0", id: message.id, error: { code: -32603, message: "side question failed" } });
            return;
          }
          if (text.includes("SIDETOOL")) {
            update(sessionId, { sessionUpdate: "tool_call", toolCallId: "side-tool", title: "Read files", kind: "read", status: "pending" });
            send({ jsonrpc: "2.0", id: "side-permission", method: "session/request_permission", params: { sessionId, toolCall: { toolCallId: "side-tool" }, options: [{ optionId: "allow", name: "Allow", kind: "allow_once" }] } });
            send({ jsonrpc: "2.0", id: "side-question", method: "elicitation/create", params: { sessionId, mode: "form", message: "May I read files?", requestedSchema: {} } });
          }
          const said = (store.sessions[sessionId]?.history ?? [])
            .map((line) => (line as { params?: { update?: { sessionUpdate?: string; content?: { text?: string } } } }).params?.update)
            .filter((update) => update?.sessionUpdate === "user_message_chunk")
            .map((update) => update?.content?.text ?? "");
          setTimeout(() => {
            if (!text.includes("NOANSWER")) {
              if (text.includes("SIDEMIXED")) {
                update(sessionId, { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "Let me explain." } });
                update(sessionId, { sessionUpdate: "plan_update", plan: { type: "markdown", planId: "side-plan", content: `You said: ${said.join(", ")}` } });
              } else if (text.includes("SIDEPLAN")) update(sessionId, { sessionUpdate: "plan_update", plan: { type: "markdown", planId: "side-plan", content: `You said: ${said.join(", ")}` } });
              else {
                update(sessionId, { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "You said: " } });
                update(sessionId, { sessionUpdate: "agent_message_chunk", content: { type: "text", text: said.join(", ") } });
              }
            }
            reply(message.id, { stopReason: "end_turn" });
            idle(sessionId);
          }, 40);
          return;
        }
        // A turn Codex refuses (signed out) leaves nothing in its thread.
        if (text.includes("AUTHFAIL")) {
          send({ jsonrpc: "2.0", id: message.id, error: { code: -32000, message: "Authentication required: not logged in" } });
          return;
        }
        // The Codex adapter keeps each prompt block as its own input, and replays each as its own chunk.
        const recorded = dialect.codex ? blocks.map((block) => (block as { text?: string }).text ?? "") : [text];
        for (const part of recorded) {
          store.sessions[sessionId]?.history.push({
            jsonrpc: "2.0",
            method: "session/update",
            params: { sessionId, update: { sessionUpdate: "user_message_chunk", content: { type: "text", text: part } } },
          });
        }
        if (text.includes("QUIET")) {
          // Like Codex after a turn ended while the app has not seen the end: the reply is done, one more line comes.
          reply(message.id, { stopReason: "end_turn" });
          setTimeout(() => update(sessionId, { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "Still here." } }, false), 20);
          return;
        }
        if (text.includes("IMAGE ")) {
          const file = text.slice(text.indexOf("IMAGE ") + 6).trim();
          const link = { type: "resource_link", name: file, uri: file };
          update(sessionId, { sessionUpdate: "tool_call", toolCallId: "view-1", name: "view_image", kind: "read", title: `View Image ${file}`, status: "completed", content: [{ type: "content", content: link }], locations: [{ path: file }] });
          update(sessionId, { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "An icon." } });
          reply(message.id, { stopReason: "end_turn" });
          idle(sessionId);
          return;
        }
        if (text.includes("PLANDOC")) {
          // Like the Codex adapter to a client that shows plans: the written plan grows, then its steps.
          const doc = (content: string) => update(sessionId, { sessionUpdate: "plan_update", plan: { type: "markdown", planId: "plan-item-1", content } });
          doc("1. Read the notes");
          doc("1. Read the notes\n2. Write the summary");
          update(sessionId, { sessionUpdate: "plan", entries: [{ content: "Read the notes", status: "completed", priority: "medium" }, { content: "Write the summary", status: "in_progress", priority: "medium" }] });
          reply(message.id, { stopReason: "end_turn" });
          idle(sessionId);
          return;
        }
        if (text.includes("PLANREVIEW")) {
          // Like the Codex adapter once the plan card is answered: the review's tool call, with no title.
          update(sessionId, { sessionUpdate: "tool_call_update", toolCallId: "plan-review:item-1", status: "completed", rawOutput: "User approved the plan." });
          reply(message.id, { stopReason: "end_turn" });
          idle(sessionId);
          return;
        }
        if (text.includes("SELF")) {
          reply(message.id, { stopReason: "end_turn" });
          setTimeout(() => {
            update(sessionId, { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "On my own." } }, false);
            setTimeout(() => idle(sessionId), 30);
          }, 30);
          return;
        }
        if (text.includes("CRASH")) {
          crash();
          return;
        }
        if (text.includes("THINK")) {
          setTimeout(() => {
            update(sessionId, { sessionUpdate: "agent_thought_chunk", content: { type: "text", text: "Mulling " } });
            update(sessionId, { sessionUpdate: "agent_thought_chunk", content: { type: "text", text: "it over." } });
            update(sessionId, { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "Done." } });
            reply(message.id, { stopReason: "end_turn" });
          }, 300);
          return;
        }
        if (text.includes("SUBAGENT")) {
          // Like codex-acp to a client that shows subagent sessions: the subagent runs in a session of its own.
          const child = `${sessionId}:child`;
          update(sessionId, { sessionUpdate: "subagent_spawned", subagentSessionId: child, name: "Explorer", task: "Read the notes\nand say what they hold", capabilities: {} });
          update(child, { sessionUpdate: "tool_call", toolCallId: "read-7", kind: "read", title: "Read notes.txt", status: "completed" });
          update(child, { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "the notes say hi" } });
          update(child, { sessionUpdate: "session_info_update", title: "Explorer" });
          update(child, { sessionUpdate: "async_task_spawned", asyncTaskId: "task-7", name: "sleep", taskType: "shell", description: "sleep 9", toolCallId: "shell-7" }, false);
          if (text.includes("ASK")) {
            waiting = { promptId: message.id, sessionId: child };
            update(child, { sessionUpdate: "tool_call", toolCallId: "call-1", title: "Write note.txt", kind: "edit", status: "pending" });
            const options = [{ optionId: "allow", name: "Allow", kind: "allow_once" }];
            send({ jsonrpc: "2.0", id: 0, method: "session/request_permission", params: { sessionId: child, toolCall: { toolCallId: "call-1", title: "Write note.txt", kind: "edit" }, options } });
            return;
          }
          update(sessionId, { sessionUpdate: "subagent_state_update", subagentSessionId: child, state: "completed" });
          update(sessionId, { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "done" } });
          reply(message.id, { stopReason: "end_turn" });
          idle(sessionId);
          return;
        }
        if (text.includes("AGENT")) {
          const meta = { claudeCode: { toolName: "Agent" } };
          update(sessionId, { sessionUpdate: "tool_call", toolCallId: "agent-1", kind: "think", title: "Task", status: "pending", _meta: meta });
          update(sessionId, { sessionUpdate: "tool_call_update", toolCallId: "agent-1", title: "Read the notes", rawInput: { description: "Read the notes", subagent_type: "general-purpose" }, _meta: meta });
          // A step the subagent takes names its subagent's tool call.
          update(sessionId, { sessionUpdate: "tool_call", toolCallId: "read-9", kind: "read", title: "Read notes.txt", status: "completed", _meta: { claudeCode: { toolName: "Read", parentToolUseId: "agent-1" } } });
          hanging = { promptId: message.id, sessionId };
          return;
        }
        if (text.includes("MONITOR")) {
          update(sessionId, { sessionUpdate: "async_task_spawned", asyncTaskId: "monitor-1", name: "monitor", taskType: "local_monitor", description: "Watch the log", canStop: false }, false);
          update(sessionId, { sessionUpdate: "async_task_progress", asyncTaskId: "monitor-1", state: "running" }, false);
          reply(message.id, { stopReason: "end_turn" });
          return;
        }
        if (text.includes("TASK")) {
          update(sessionId, { sessionUpdate: "async_task_spawned", asyncTaskId: "task-1", name: "sleep", taskType: "local_bash", description: "sleep 1 && echo done" }, false);
          reply(message.id, { stopReason: "end_turn" });
          setTimeout(() => {
            // Like Claude: a turn of its own about the finished task, ended by the cost of that turn. The task
            // ends while the reply streams, and the task list drops it before Claude Code's own end state arrives.
            update(sessionId, { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "The task " } }, false);
            update(sessionId, { sessionUpdate: "async_task_state_update", asyncTaskId: "task-1", state: "stopped" }, false);
            update(sessionId, { sessionUpdate: "async_task_state_update", asyncTaskId: "task-1", state: "completed" }, false);
            update(sessionId, { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "is done." } }, false);
            update(sessionId, { sessionUpdate: "usage_update", used: 1300, size: 200000, cost: { amount: 0.01, currency: "USD" }, _meta: { "_claude/origin": { kind: "task-notification" } } }, false);
          }, 50);
          return;
        }
        if (text.includes("IDLECOMPACT")) {
          reply(message.id, { stopReason: "end_turn" });
          setTimeout(() => {
            // Like the adapter's idle compaction: a /compact of its own whose turn ends without a cost.
            commandFrame(sessionId, "compact-1", "started");
            update(sessionId, { sessionUpdate: "tool_call", toolCallId: "compact-tool", kind: "think", title: "Compact conversation", status: "in_progress" }, false);
            update(sessionId, { sessionUpdate: "tool_call_update", toolCallId: "compact-tool", status: "completed" }, false);
            update(sessionId, { sessionUpdate: "usage_update", used: 900, size: 200000 }, false);
            commandFrame(sessionId, "compact-1", "completed");
          }, 50);
          return;
        }
        if (text.includes("SILENT")) {
          // Like Codex before it started the turn: nothing comes until the cancel.
          hanging = { promptId: message.id, sessionId };
          return;
        }
        if (text.includes("TWOQUESTIONS")) {
          pair = { promptId: message.id, sessionId, open: ["ask-a", "ask-b"] };
          for (const id of pair.open) ask(sessionId, id);
          update(sessionId, { sessionUpdate: "usage_update", used: 2, size: 200000 }, false);
          return;
        }
        if (text.includes("QUESTION")) {
          asking = { promptId: message.id, sessionId };
          ask(sessionId);
          return;
        }
        if (text.includes("GROKASK")) {
          asking = { promptId: message.id, sessionId };
          send({
            jsonrpc: "2.0",
            id: "ask-1",
            method: "_x.ai/ask_user_question",
            params: {
              sessionId,
              toolCallId: "call-ask",
              mode: "default",
              questions: [{ question: "Which database?", options: [{ label: "Postgres" }, { label: "SQLite" }], multiSelect: null }],
            },
          });
          return;
        }
        if (text.includes("GIVEUP")) {
          asking = { promptId: message.id, sessionId };
          ask(sessionId);
          send({ jsonrpc: "2.0", method: "$/cancel_request", params: { requestId: "ask-1" } });
          return;
        }
        if (text.includes("HANG")) {
          hanging = { promptId: message.id, sessionId };
          update(sessionId, { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "working" } });
          return;
        }
        if (text.includes("TWOPERMS")) {
          pair = { promptId: message.id, sessionId, open: ["perm-a", "perm-b"] };
          for (const id of pair.open) {
            send({
              jsonrpc: "2.0",
              id,
              method: "session/request_permission",
              params: {
                sessionId,
                toolCall: { toolCallId: `call-${id}`, title: `Write ${id}.txt`, kind: "edit" },
                options: [
                  { optionId: "allow", name: "Allow", kind: "allow_once" },
                  { optionId: "reject", name: "Reject", kind: "reject_once" },
                ],
              },
            });
          }
          update(sessionId, { sessionUpdate: "usage_update", used: 2, size: 200000 }, false);
          const withdrawn = /WITHDRAW (perm-[ab])/.exec(text)?.[1];
          if (withdrawn) send({ jsonrpc: "2.0", method: "$/cancel_request", params: { requestId: withdrawn } });
          if (text.includes("DROP")) setTimeout(crash, 50);
          return;
        }
        if (text.includes("PERMISSION")) {
          waiting = { promptId: message.id, sessionId };
          update(sessionId, { sessionUpdate: "tool_call", toolCallId: "call-1", title: "Write note.txt", kind: "edit", status: "pending" });
          send({
            jsonrpc: "2.0",
            id: 0,
            method: "session/request_permission",
            params: {
              sessionId,
              toolCall: { toolCallId: "call-1", title: "Write note.txt", kind: "edit" },
              options: [
                { optionId: "allow", name: "Allow", kind: "allow_once" },
                { optionId: "reject", name: "Reject", kind: "reject_once" },
              ],
            },
          });
          return;
        }
        update(sessionId, { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "po" } });
        update(sessionId, { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "ng" } });
        update(sessionId, { sessionUpdate: "session_info_update", title: "Pong chat" }, false);
        update(sessionId, { sessionUpdate: "usage_update", used: 1200, size: 200000 }, false);
        reply(message.id, { stopReason: "end_turn" });
        idle(sessionId);
        // Like the Claude and Codex adapters: the predicted next prompt comes after the turn.
        if (dialect.fast || dialect.codex) update(sessionId, { sessionUpdate: "session_info_update", _meta: { promptSuggestions: { suggestions: [{ text: "and then?" }] } } }, false);
        return;
      }
      default:
        if (message.id !== undefined) send({ jsonrpc: "2.0", id: message.id, error: { code: -32601, message: `not implemented: ${message.method}` } });
    }
  };
}
