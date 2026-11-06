import assert from "node:assert/strict";
import test from "node:test";
import { answerMcp } from "../mcp/mcp.ts";
import { CHAT_ID_TOOL } from "./sharedRules.ts";
import { chatIdTools } from "./ticketLinks.ts";

async function chatId(sessionId: string | null) {
  const reply = await answerMcp(
    { jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: CHAT_ID_TOOL, arguments: {} } },
    chatIdTools().tools,
    { sessionId, signal: new AbortController().signal },
  );
  assert.ok(reply && "result" in reply, "no result");
  return reply.result;
}

test("the chat_id tool answers the chat its MCP key belongs to, without asking", async () => {
  assert.deepEqual(await chatId("sess-4"), { content: [{ type: "text", text: "sess-4" }], isError: false });
  assert.deepEqual(await chatId(null), { content: [{ type: "text", text: "This chat is still opening. Try again in a moment." }], isError: true });
  assert.equal(chatIdTools().tools[0]?.trusted, true);
});
