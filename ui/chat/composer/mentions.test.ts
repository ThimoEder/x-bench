import assert from "node:assert/strict";
import test from "node:test";
import { applyMention, mentionQuery, relativeTo, sessionFilePath } from "./mentions.ts";

test("an @ token at the cursor is the mention query", () => {
  assert.equal(mentionQuery("see @rea", 8)?.query, "rea");
  assert.equal(mentionQuery("see @!env", 9)?.hidden, true);
  assert.equal(mentionQuery("email me@host", 12), null);
  const next = applyMention("see @rea", 8, "README.md");
  assert.equal(next.text, "see @README.md ");
  assert.equal(next.cursor, "see @README.md ".length);
  assert.equal(relativeTo("/work/app", "/work/app/src/main.js"), "src/main.js");
  assert.equal(sessionFilePath("/work/app", "architecture.md"), "/work/app/architecture.md");
  assert.equal(sessionFilePath("/work/app", "/work/app/architecture.md"), "/work/app/architecture.md");
  assert.equal(sessionFilePath("/work/app", "./notes/plan.md"), "/work/app/notes/plan.md");
  assert.equal(sessionFilePath("/work/app", ""), "");
});
