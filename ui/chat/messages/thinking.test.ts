import assert from "node:assert/strict";
import test from "node:test";
import { latestThinking, previewAsWritten, thinkingSteps } from "./thinking.ts";

test("a thought made of bold headings is a list of steps", () => {
  assert.deepEqual(thinkingSteps("\n\n**Deriving column equations**\n\n**Correcting column equations**\n\n**Checking carry equations.**"), [
    "Deriving column equations",
    "Correcting column equations",
    "Checking carry equations",
  ]);
});

test("a thought with any prose is not a list of steps", () => {
  assert.equal(thinkingSteps("**Planning**\n\nI will read the file first."), null);
  assert.equal(thinkingSteps("Reading the notes."), null);
  assert.equal(thinkingSteps(""), null);
});

test("the latest thinking starts at a sentence and keeps about three lines", () => {
  const long = `${"Early words that scroll away. ".repeat(10)}Now checking the carry. Then the last digit.`;
  const latest = latestThinking(long);
  assert.ok(latest.length <= 240);
  assert.ok(latest.endsWith("Then the last digit."));
  assert.equal(latestThinking("Short one."), "Short one.");
});

test("a preview near code shows as written, so a shell's $$ is never math", () => {
  const open = "Still streaming:\n```bash\necho $$ && echo $$";
  assert.equal(previewAsWritten(open, latestThinking(open)), true);
  const closed = `${"Some words first. ".repeat(20)}\`\`\`bash\necho $$ && kill $$\n\`\`\``;
  assert.equal(previewAsWritten(closed, latestThinking(closed)), true);
  assert.equal(previewAsWritten("**Planning** the $x^2$ case.", "**Planning** the $x^2$ case."), false);
});
