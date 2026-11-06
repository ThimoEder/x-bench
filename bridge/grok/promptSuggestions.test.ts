import assert from "node:assert/strict";
import test from "node:test";
import { promptSuggestionsEnabled } from "./promptSuggestions.ts";

test("prompt suggestions stay on unless config.toml turns them off", () => {
  assert.equal(promptSuggestionsEnabled(""), true);
  assert.equal(promptSuggestionsEnabled("[ui]\nmax_thoughts_width = 120\n"), true);
  assert.equal(promptSuggestionsEnabled("[ui]\nprompt_suggestions = true\n"), true);
  assert.equal(promptSuggestionsEnabled("[ui]\nprompt_suggestions = false\n"), false);
  assert.equal(promptSuggestionsEnabled("[models]\nprompt_suggestions = false\n[ui]\n"), true);
  assert.equal(promptSuggestionsEnabled("# prompt_suggestions = false\n[ui]\n"), true);
});
