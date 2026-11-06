import assert from "node:assert/strict";
import test from "node:test";
import { composerGhost } from "./suggestion.ts";

test("the ghost line shows only in an empty idle composer", () => {
  assert.equal(composerGhost({ suggestion: "next", draft: "", running: false, attachments: 0, recording: false }), "next");
  assert.equal(composerGhost({ suggestion: "  next  ", draft: "", running: false, attachments: 0, recording: false }), "next");
  assert.equal(composerGhost({ suggestion: "next", draft: "n", running: false, attachments: 0, recording: false }), "");
  assert.equal(composerGhost({ suggestion: "next", draft: "", running: true, attachments: 0, recording: false }), "");
  assert.equal(composerGhost({ suggestion: "next", draft: "", running: false, attachments: 1, recording: false }), "");
  assert.equal(composerGhost({ suggestion: "next", draft: "", running: false, attachments: 0, recording: true }), "");
  assert.equal(composerGhost({ suggestion: null, draft: "", running: false, attachments: 0, recording: false }), "");
  assert.equal(composerGhost({ suggestion: "  ", draft: "", running: false, attachments: 0, recording: false }), "");
});
