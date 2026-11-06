import assert from "node:assert/strict";
import test from "node:test";
import {
  readComposerDraft,
  resetComposerDrafts,
  restoreComposerDraft,
  subscribeComposerDrafts,
  writeComposerDraft,
} from "./composerDrafts.ts";
import type { Attachment } from "./attachments.ts";

function chip(id: string, name: string): Attachment {
  return { id, name, mimeType: "", kind: "file", size: 0, path: `/tmp/${name}` };
}

test("each thread keeps its own unsent text and attachments", () => {
  resetComposerDrafts();
  const file = chip("a", "note.txt");
  writeComposerDraft("one", { text: "hello", attachments: [file] });
  writeComposerDraft("two", { text: "other", attachments: [] });
  assert.deepEqual(readComposerDraft("one"), { text: "hello", attachments: [file] });
  assert.equal(readComposerDraft("two").text, "other");
  assert.equal(readComposerDraft("missing"), readComposerDraft("also-missing"));
  assert.equal(readComposerDraft("missing").text, "");
  assert.deepEqual(readComposerDraft("missing").attachments, []);
});

test("spaces stay, and an empty composer drops only that thread", () => {
  resetComposerDrafts();
  const file = chip("pic", "pic.png");
  writeComposerDraft("one", { text: "   ", attachments: [] });
  writeComposerDraft("two", { text: "", attachments: [file] });
  assert.equal(readComposerDraft("one").text, "   ");
  assert.deepEqual(readComposerDraft("two").attachments, [file]);
  writeComposerDraft("one", { text: "", attachments: [] });
  writeComposerDraft("two", { text: "", attachments: [] });
  assert.equal(readComposerDraft("one").text, "");
  assert.equal(readComposerDraft("two").attachments.length, 0);
});

test("listeners hear a real change once", () => {
  resetComposerDrafts();
  let calls = 0;
  const stop = subscribeComposerDrafts(() => {
    calls += 1;
  });
  writeComposerDraft("one", { text: "hello", attachments: [] });
  writeComposerDraft("one", { text: "hello", attachments: [] });
  writeComposerDraft("one", { text: "", attachments: [] });
  stop();
  writeComposerDraft("one", { text: "later", attachments: [] });
  assert.equal(calls, 2);
  assert.equal(readComposerDraft("one").text, "later");
});

test("a failed send restores the message only when nothing newer was written", () => {
  resetComposerDrafts();
  const file = chip("a", "note.txt");
  writeComposerDraft("one", { text: "hello", attachments: [file] });
  const cleared = writeComposerDraft("one", { text: "", attachments: [] });
  writeComposerDraft("one", { text: "newer", attachments: [] });
  assert.equal(restoreComposerDraft("one", { text: "hello", attachments: [file] }, cleared), false);
  assert.equal(readComposerDraft("one").text, "newer");

  const again = writeComposerDraft("one", { text: "", attachments: [] });
  assert.equal(restoreComposerDraft("one", { text: "hello", attachments: [file] }, again), true);
  assert.deepEqual(readComposerDraft("one"), { text: "hello", attachments: [file] });
  assert.equal(restoreComposerDraft("one", { text: "hello", attachments: [file] }, again), false);
});
