import assert from "node:assert/strict";
import test, { mock } from "node:test";
import { RpcClient } from "./rpc.ts";

type Inbound = (raw: unknown) => void;

test("a prompt with no deadline stays open until the agent answers", async () => {
  const rpc = new RpcClient();
  let inbound: Inbound = () => {};
  rpc.attach({
    send() {},
    setHandlers({ onMessage }) {
      inbound = onMessage;
    },
  });
  let settled = false;
  const pending = rpc.request("session/prompt", { sessionId: "s1" }, 0).then(
    (result) => {
      settled = true;
      return result;
    },
    (error) => {
      settled = true;
      throw error;
    },
  );
  await new Promise((resolve) => {
    setTimeout(resolve, 40);
  });
  assert.equal(settled, false);
  inbound(JSON.stringify({ jsonrpc: "2.0", id: 1, result: { stopReason: "end_turn" } }));
  assert.deepEqual(await pending, { stopReason: "end_turn" });
});

test("an agent error string is included in the rejection", async () => {
  const rpc = new RpcClient();
  let inbound: Inbound = () => {};
  rpc.attach({
    send() {},
    setHandlers({ onMessage }) {
      inbound = onMessage;
    },
  });
  const pending = rpc.request("_x.ai/btw", { sessionId: "missing" }, 0);
  inbound(JSON.stringify({ jsonrpc: "2.0", id: 1, error: { code: -32602, message: "Invalid params", data: "session not found" } }));
  await assert.rejects(pending, /Invalid params: session not found/);
});

test("a positive deadline still rejects when the agent stays quiet", async () => {
  const rpc = new RpcClient();
  rpc.attach({
    send() {},
    setHandlers() {},
  });
  await assert.rejects(rpc.request("session/prompt", {}, 20), /timeout waiting for session\/prompt/);
});

test("a request with an id that is not a JSON-RPC id is answered, not dropped", () => {
  const rpc = new RpcClient();
  const sent: unknown[] = [];
  let inbound: Inbound = () => {};
  rpc.attach({
    send(value) {
      sent.push(value);
    },
    setHandlers({ onMessage }) {
      inbound = onMessage;
    },
  });
  let handled = false;
  rpc.onRequest = () => {
    handled = true;
  };
  rpc.onNotification = () => {
    handled = true;
  };
  inbound(JSON.stringify({ jsonrpc: "2.0", id: { odd: 1 }, method: "session/request_permission", params: {} }));
  assert.equal(handled, false);
  assert.deepEqual(sent, [{ jsonrpc: "2.0", id: { odd: 1 }, error: { code: -32600, message: "Invalid request id" } }]);
});

test("a listener that throws sees each message once, and the error is logged", () => {
  const rpc = new RpcClient();
  let inbound: Inbound = () => {};
  rpc.attach({
    send() {},
    setHandlers({ onMessage }) {
      inbound = onMessage;
    },
  });
  const seen: string[] = [];
  rpc.onNotification = (message) => {
    const params = message.params;
    const text = params && typeof params === "object" && "text" in params ? String(params.text) : "";
    seen.push(text);
    throw new Error("handler failed");
  };
  const error = mock.method(console, "error", () => {});
  try {
    const frame = (text: string) => JSON.stringify({ jsonrpc: "2.0", method: "session/update", params: { text } });
    inbound(frame("X"));
    inbound(`ready\n${frame("Y")}`);
    assert.deepEqual(seen, ["X", "Y"]);
    const logged = error.mock.calls.map((call) => call.arguments.map(String).join(" ")).join("\n");
    assert.match(logged, /rpc listener failed \(session\/update\): handler failed/);
    assert.equal(error.mock.calls.length, 2);
  } finally {
    error.mock.restore();
  }
});
