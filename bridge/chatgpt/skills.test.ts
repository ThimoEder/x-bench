import { test } from "node:test";
import assert from "node:assert/strict";
import { codexSkillText } from "./skills.ts";

test("a /name Codex listed only as $name goes as $name", () => {
  const names = ["review", "$review", "$why", "compact"];
  assert.equal(codexSkillText("/why did we pick SSE", names), "$why did we pick SSE");
  assert.equal(codexSkillText("/why", names), "$why");
  assert.equal(codexSkillText("/review", names), "/review");
  assert.equal(codexSkillText("/compact", names), "/compact");
  assert.equal(codexSkillText("$review the diff", names), "$review the diff");
  assert.equal(codexSkillText("use /why and /review", names), "use $why and /review");
  assert.equal(codexSkillText("see src/why", names), "see src/why");
  assert.equal(codexSkillText("use /why, then /review.", names), "use $why, then /review.");
  assert.equal(codexSkillText("keep `/why` and\n```\n/why\n```\nbut /why", names), "keep `/why` and\n```\n/why\n```\nbut $why");
  assert.equal(codexSkillText("/why", []), "/why");
});
