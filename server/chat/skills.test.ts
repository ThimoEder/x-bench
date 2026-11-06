import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { listFolderSkills, parseSkillDocument, skillSlug } from "./skills.ts";

test("a skill document keeps the slash fields and hides model-only skills", () => {
  const folded = parseSkillDocument(`---
name: "Review PR"
description: >-
  Review the branch
  against main
argument-hint: "[--main]"
user-invocable: true
---

# Review

Do the review.
`);
  assert.equal(folded.name, "Review PR");
  assert.equal(folded.description, "Review the branch against main");
  assert.equal(folded.argumentHint, "[--main]");
  assert.equal(folded.userInvocable, true);

  const hidden = parseSkillDocument("---\nname: secret\nuser-invocable: false\n---\n\nHidden.");
  assert.equal(hidden.userInvocable, false);

  const plain = parseSkillDocument("# Title\n\nShip the build.\n\nMore.");
  assert.equal(plain.description, "Ship the build.");
  assert.equal(skillSlug("Ship_It"), "ship-it");
  assert.equal(skillSlug("!!!"), "");
});

test("the open folder lists invocable skills and command files", () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "grok-skills-"));
  const outside = mkdtempSync(path.join(os.tmpdir(), "grok-skills-out-"));
  try {
    writeSkill(root, ".grok/skills/review", `---
name: review
description: Review this branch
argument-hint: "[--main]"
---

Review it.
`);
    writeSkill(root, ".grok/skills/nested/tools/plan", `---
name: plan
description: Plan from the folder
---
`);
    writeSkill(root, ".claude/skills/review", `---
name: review
description: Claude copy loses
---
`);
    writeSkill(root, ".claude/skills/hidden", `---
name: hidden
description: Not a slash command
user-invocable: false
---
`);
    mkdirSync(path.join(root, ".grok/commands"), { recursive: true });
    writeFileSync(
      path.join(root, ".grok/commands/Ship_It.md"),
      "---\nname: ship\ndescription: Ship the build\n---\n\nShip it.\n",
    );
    mkdirSync(path.join(root, ".agents/commands"), { recursive: true });
    writeFileSync(path.join(root, ".agents/commands/notes.md"), "# Notes\n\nLeave a note.\n");
    writeFileSync(path.join(outside, "SKILL.md"), "---\nname: leaked\ndescription: Outside\n---\n");
    mkdirSync(path.join(root, ".grok/skills/leak"), { recursive: true });
    symlinkSync(path.join(outside, "SKILL.md"), path.join(root, ".grok/skills/leak/SKILL.md"));
    mkdirSync(path.join(root, ".cursor"), { recursive: true });
    symlinkSync(outside, path.join(root, ".cursor/skills"));

    assert.deepEqual(listFolderSkills(root), [
      { name: "local:plan", hint: "Plan from the folder", argumentHint: "" },
      { name: "notes", hint: "Leave a note.", argumentHint: "" },
      { name: "review", hint: "Review this branch", argumentHint: "[--main]" },
      { name: "ship", hint: "Ship the build", argumentHint: "" },
    ]);
    assert.deepEqual(listFolderSkills(path.join(root, "missing")), []);
  } finally {
    rmSync(root, { recursive: true, force: true });
    rmSync(outside, { recursive: true, force: true });
  }
});

function writeSkill(root: string, directory: string, text: string): void {
  const dir = path.join(root, directory);
  mkdirSync(dir, { recursive: true });
  writeFileSync(path.join(dir, "SKILL.md"), text);
}
