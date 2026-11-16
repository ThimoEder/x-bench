import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { OFFER_ARCHIVE_TOOL, createArchiveOffers, offerArchiveTools } from "./archiveOffer.ts";
import { answerMcp } from "../mcp/mcp.ts";

function scratchFile() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "x-bench-archive-offers-"));
  test.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return path.join(dir, "archive-offers.json");
}

test("an offer is kept per session in the file until it is cleared", () => {
  const file = scratchFile();
  const store = createArchiveOffers(file);
  let changes = 0;
  store.onChange(() => (changes += 1));

  store.offer("s1");
  store.offer("s1");
  store.offer("s2");
  assert.equal(store.has("s1"), true);
  assert.deepEqual(JSON.parse(fs.readFileSync(file, "utf8")), { sessions: ["s1", "s2"] });
  // A second store on the same file, like another host on the same home, reads the same.
  const other = createArchiveOffers(file);
  assert.equal(other.has("s2"), true);

  other.clear("s2");
  assert.equal(store.changedOnDisk(), true);
  assert.equal(store.has("s2"), false);
  store.clear("s1");
  store.clear("missing");
  assert.deepEqual(JSON.parse(fs.readFileSync(file, "utf8")), { sessions: [] });
  assert.equal(changes, 3);
});

test("offer_archive raises the offer for its chat, and waits for a chat that is still opening", async () => {
  const store = createArchiveOffers(scratchFile());
  assert.equal(offerArchiveTools(store).builderOnly, true);
  const call = async (sessionId: string | null) => {
    const reply = await answerMcp({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: OFFER_ARCHIVE_TOOL, arguments: {} } }, offerArchiveTools(store).tools, { sessionId, signal: new AbortController().signal });
    assert.ok(reply && "result" in reply, "no result");
    return reply.result as { content: { text: string }[]; isError: boolean };
  };

  const unbound = await call(null);
  assert.equal(unbound.isError, true);
  assert.equal(store.has("s1"), false);

  const ok = await call("s1");
  assert.equal(ok.isError, false);
  assert.match(ok.content[0]?.text ?? "", /Nothing is archived by itself/);
  assert.equal(store.has("s1"), true);
  assert.equal((await call("s1")).isError, false);
});
