import assert from "node:assert/strict";
import test from "node:test";
import { MCP_SERVER, answerMcp, createHostTools, toolText, type McpTool } from "./mcp.ts";

const echo: McpTool = {
  trusted: true,
  spec: { name: "echo", description: "Echo", inputSchema: { type: "object" } },
  call: (args, { sessionId }) => toolText(`${sessionId}: ${JSON.stringify(args)}`),
};

const asking: McpTool = {
  spec: { name: "asking", description: "Asks", inputSchema: { type: "object" } },
  call: async () => {
    throw new Error("The person said no.");
  },
};

const context = { sessionId: "s1", signal: new AbortController().signal };

test("each grant names its session through a fresh key, behind the launch token", () => {
  const host = createHostTools([
    { instructions: "Use echo.", tools: [echo] },
    { instructions: "Use asking.", tools: [asking] },
  ]);
  const tools = host.sessionTools({ port: 4321, token: "secret" });
  const fresh = tools.grant(null, "/work");
  const loaded = tools.grant("s9", "/work");
  const [server] = fresh.servers;
  assert.ok(server);
  assert.equal(server.name, MCP_SERVER);
  assert.match(server.url, /^http:\/\/127\.0\.0\.1:4321\/api\/mcp\/[A-Za-z0-9_-]{20,}$/);
  assert.deepEqual(server.headers, [{ name: "x-bench-token", value: "secret" }]);
  assert.deepEqual(fresh.trusted, [{ server: MCP_SERVER, tool: "echo" }], "only trusted tools skip the harness's prompt");
  assert.equal(fresh.instructions, "Use echo.\n\nUse asking.");
  assert.notEqual(loaded.servers[0]?.url, server.url);

  const key = server.url.split("/").at(-1) ?? "";
  assert.equal(host.knowsKey(key), true);
  assert.equal(host.sessionFor(key), null, "a new session is not bound before session/new answers");
  fresh.bind("s1");
  assert.equal(host.sessionFor(key), "s1");
  assert.equal(host.knowsKey("other"), false);

  // Loading the session again replaces its keys: the harness calls the new one.
  const reloaded = tools.grant("s1", "/work").servers[0]?.url.split("/").at(-1) ?? "";
  assert.equal(host.knowsKey(key), false);
  assert.equal(host.sessionFor(reloaded), "s1");
  assert.equal(host.knowsKey(loaded.servers[0]?.url.split("/").at(-1) ?? ""), true, "another session's key stays");

  host.forget("s1");
  assert.equal(host.knowsKey(reloaded), false, "a deleted session's keys stop working");
});

test("a chat in a folder without the review dock gets no builder-only tools or their lines", () => {
  const host = createHostTools(
    [
      { instructions: "Use echo.", tools: [echo] },
      { instructions: "Use asking.", tools: [asking], builderOnly: true },
    ],
    { builder: (cwd) => cwd !== "/chat" },
  );
  const tools = host.sessionTools({ port: 4321, token: "secret" });
  const keyOf = (grant: { servers: { url: string }[] }) => grant.servers[0]?.url.split("/").at(-1) ?? "";
  const chat = tools.grant("c1", "/chat");
  assert.equal(chat.instructions, "Use echo.");
  assert.deepEqual(host.toolsFor(keyOf(chat)).map((tool) => tool.spec.name), ["echo"]);
  const builder = tools.grant("b1", "/work");
  assert.deepEqual(host.toolsFor(keyOf(builder)).map((tool) => tool.spec.name), ["echo", "asking"]);
  chat.bind("c1");
  assert.deepEqual(host.toolsFor(keyOf(chat)).map((tool) => tool.spec.name), ["echo"], "binding keeps the grant's tools");
  assert.deepEqual(host.toolsFor("other"), []);
});

test("a group behind a setting reaches the chats that open while the setting is on", () => {
  let on = false;
  const host = createHostTools([{ instructions: "Use echo.", tools: [echo] }, { instructions: "Use asking.", tools: [asking], enabled: () => on }]);
  const tools = host.sessionTools({ port: 4321, token: "secret" });
  const namesOf = (grant: { servers: { url: string }[] }) => host.toolsFor(grant.servers[0]?.url.split("/").at(-1) ?? "").map((tool) => tool.spec.name);
  const before = tools.grant("s1", "/work");
  assert.equal(before.instructions, "Use echo.");
  on = true;
  assert.deepEqual(namesOf(tools.grant("s2", "/work")), ["echo", "asking"]);
  assert.deepEqual(namesOf(before), ["echo"], "an open chat keeps the tools it got");
});

test("the MCP server answers initialize, ping and tools/list, and nothing for notifications", async () => {
  const tools = [echo, asking];
  const init = await answerMcp({ jsonrpc: "2.0", id: 0, method: "initialize", params: { protocolVersion: "2025-03-26" } }, tools, context);
  assert.ok(init && "result" in init);
  assert.equal(init.id, 0);
  assert.equal((init.result as { protocolVersion: string }).protocolVersion, "2025-03-26");
  const future = await answerMcp({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2099-01-01" } }, tools, context);
  assert.ok(future && "result" in future);
  assert.equal((future.result as { protocolVersion: string }).protocolVersion, "2025-11-25");

  assert.deepEqual(await answerMcp({ jsonrpc: "2.0", id: "p", method: "ping" }, tools, context), { jsonrpc: "2.0", id: "p", result: {} });
  const listed = await answerMcp({ jsonrpc: "2.0", id: 2, method: "tools/list" }, tools, context);
  assert.ok(listed && "result" in listed);
  assert.deepEqual((listed.result as { tools: { name: string }[] }).tools.map((tool) => tool.name), ["echo", "asking"]);

  assert.equal(await answerMcp({ jsonrpc: "2.0", method: "notifications/initialized" }, tools, context), null);
  assert.equal(await answerMcp({ jsonrpc: "2.0", id: 3, result: {} }, tools, context), null);
  assert.equal((await answerMcp({ jsonrpc: "2.0", id: 4, method: "resources/list" }, tools, context))?.error?.code, -32601);
  assert.equal((await answerMcp({ jsonrpc: "2.0", id: 5, method: "tools/call", params: { name: "other" } }, tools, context))?.error?.code, -32602);
  assert.equal((await answerMcp("nope", tools, context))?.error?.code, -32600);
});

test("a tool's result goes back as is, and a tool that throws answers with its message as an error", async () => {
  const tools = [echo, asking];
  const echoed = await answerMcp({ jsonrpc: "2.0", id: 6, method: "tools/call", params: { name: "echo", arguments: { a: 1 } } }, tools, context);
  assert.deepEqual(echoed?.result, toolText('s1: {"a":1}'));
  const thrown = await answerMcp({ jsonrpc: "2.0", id: 7, method: "tools/call", params: { name: "asking" } }, tools, context);
  assert.deepEqual(thrown?.result, toolText("The person said no.", true));
});
