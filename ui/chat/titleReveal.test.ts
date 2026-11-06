import assert from "node:assert/strict";
import test from "node:test";
import { isPlaceholderTitle, nextTitleReveal } from "./titleReveal.ts";

test("a placeholder title is the stand-in shown before a chat is named", () => {
  assert.equal(isPlaceholderTitle("Untitled"), true);
  assert.equal(isPlaceholderTitle("  untitled "), true);
  assert.equal(isPlaceholderTitle("New session"), true);
  assert.equal(isPlaceholderTitle("New chat"), true);
  assert.equal(isPlaceholderTitle(""), true);
  assert.equal(isPlaceholderTitle(null), true);
  assert.equal(isPlaceholderTitle("Fix the login redirect"), false);
});

test("only the change from a placeholder to a real title reveals", () => {
  assert.deepEqual(nextTitleReveal("Untitled", "Fix the login redirect"), {
    from: "Untitled",
    to: "Fix the login redirect",
  });
  assert.deepEqual(nextTitleReveal("New session", "Name the chat"), {
    from: "New session",
    to: "Name the chat",
  });
  assert.deepEqual(nextTitleReveal("New chat", "Name the chat"), {
    from: "New chat",
    to: "Name the chat",
  });
  assert.equal(nextTitleReveal("Untitled", "New session"), null);
  assert.equal(nextTitleReveal("Fix the login redirect", "Rename the chat"), null);
  assert.equal(nextTitleReveal("Fix the login redirect", "Untitled"), null);
  assert.equal(nextTitleReveal("Untitled", "Untitled"), null);
  assert.equal(nextTitleReveal("Untitled", "  "), null);
});
