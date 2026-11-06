import assert from "node:assert/strict";
import test from "node:test";
import { btwCommand, matchingCommands, skillParts, planCommand, routineCommand, slashQuery } from "./commands.ts";

test("a slash token at the cursor opens the command menu", () => {
  assert.deepEqual(slashQuery("/"), { query: "", start: 0 });
  assert.deepEqual(slashQuery("/pl"), { query: "pl", start: 0 });
  assert.deepEqual(slashQuery("/Plan"), { query: "plan", start: 0 });
  assert.equal(slashQuery("/plan "), null);
  assert.equal(slashQuery("/plan design auth"), null);
  assert.equal(slashQuery("/plan\nnext"), null);
  assert.deepEqual(slashQuery("please /rev"), { query: "rev", start: 7 });
  assert.deepEqual(slashQuery("first\n/rev then", 10), { query: "rev", start: 6 });
  assert.equal(slashQuery("see src/rev"), null);
  assert.equal(slashQuery("open /Users/me"), null);
});

test("/plan enters plan mode and can carry a description", () => {
  assert.deepEqual(planCommand("/plan"), { description: "" });
  assert.deepEqual(planCommand("  /PLAN  "), { description: "" });
  assert.deepEqual(planCommand("/plan design auth"), { description: "design auth" });
  assert.deepEqual(planCommand("/plan\nlook at the composer"), { description: "look at the composer" });
  assert.equal(planCommand("/planet"), null);
  assert.equal(planCommand("please /plan"), null);
  assert.equal(planCommand(""), null);
});

test("plan is offered while the slash token matches", () => {
  assert.deepEqual(matchingCommands("").map((command) => command.name), ["plan", "btw", "routine"]);
  assert.deepEqual(matchingCommands("ro").map((command) => command.name), ["routine"]);
  assert.deepEqual(matchingCommands("pl").map((command) => command.name), ["plan"]);
  assert.deepEqual(matchingCommands("bt").map((command) => command.name), ["btw"]);
  assert.deepEqual(matchingCommands("nope"), []);
  assert.deepEqual(matchingCommands(null), []);
});

test("folder skills are slash commands and do not take over /plan", () => {
  const skills = [
    { name: "review", hint: "Review this branch", argumentHint: "[--main]" },
    { name: "local:plan", hint: "Plan from the folder" },
  ];
  assert.deepEqual(
    matchingCommands("", skills).map((command) => command.name),
    ["plan", "btw", "routine", "review", "local:plan"],
  );
  assert.equal(matchingCommands("re", skills)[0]?.kind, "skill");
  assert.equal(matchingCommands("re", skills)[0]?.hint, "Review this branch");
  assert.deepEqual(matchingCommands("plan", skills).map((command) => command.name), ["plan"]);
  assert.deepEqual(matchingCommands("local:pl", skills).map((command) => command.name), ["local:plan"]);
});

test("the harness's commands come first, keep /plan and /btw ours, and a folder skill shows once", () => {
  const skills = [{ name: "folder-only", hint: "From the folder" }, { name: "architect" }, { name: "compact" }];
  const reported = [
    { name: "plan", description: "Codex plan" },
    { name: "compact", description: "Summarize" },
    { name: "$architect", description: "Design first" },
    { name: "compact", description: "Twice" },
    { name: "$slides:Presentations", description: "Decks" },
  ];
  assert.deepEqual(
    matchingCommands("", skills, reported).map((command) => command.name),
    ["plan", "btw", "routine", "compact", "$architect", "$slides:Presentations", "folder-only"],
  );
  assert.equal(matchingCommands("plan", skills, reported)[0]?.hint, "Switch to plan mode");
  assert.deepEqual(matchingCommands("arch", skills, reported).map((command) => command.name), ["$architect"]);
  assert.deepEqual(matchingCommands("slides:pres", skills, reported).map((command) => command.name), ["$slides:Presentations"]);
  assert.deepEqual(matchingCommands("fold", skills, []).map((command) => command.name), ["folder-only"]);
});

test("a Codex $name skill shows as /name, unless a command already has that name", () => {
  const reported = [{ name: "review" }, { name: "$review" }, { name: "$architect" }, { name: "$plan" }];
  const shown = (query: string) => matchingCommands(query, [], reported).map((command) => command.text ?? `/${command.name}`);
  assert.deepEqual(shown("arch"), ["/architect"]);
  assert.deepEqual(shown("review"), ["/review", "$review"]);
  assert.deepEqual(shown("plan"), ["/plan", "$plan"]);
});

test("a sent message splits around the reported skills it calls, anywhere in it", () => {
  const reported = [{ name: "bro" }, { name: "$why" }, { name: "plugin:fix" }];
  assert.deepEqual(skillParts("/bro test", reported), [{ skill: "bro" }, " test"]);
  assert.deepEqual(skillParts("$why did we\npick SSE", reported), [{ skill: "why" }, " did we\npick SSE"]);
  assert.deepEqual(skillParts("/bro", reported), [{ skill: "bro" }]);
  assert.deepEqual(skillParts("say /bro, then /why.", reported), ["say ", { skill: "bro" }, ", then ", { skill: "why" }, "."]);
  assert.deepEqual(skillParts("run /plugin:fix now", reported), ["run ", { skill: "plugin:fix" }, " now"]);
  assert.deepEqual(skillParts("$bro test", reported), ["$bro test"]);
  assert.deepEqual(skillParts("/usr/bin/env and src/bro", reported), ["/usr/bin/env and src/bro"]);
  assert.deepEqual(skillParts("/bro test", undefined), ["/bro test"]);
});

test("/btw takes the whole message aside, including a token in the middle", () => {
  assert.deepEqual(btwCommand("/btw"), { question: "" });
  assert.deepEqual(btwCommand("  /BTW  "), { question: "" });
  assert.deepEqual(btwCommand("/btw which file was that?"), { question: "which file was that?" });
  assert.deepEqual(btwCommand("fix the retry loop first. /btw what does WBC stand for?"), {
    question: "fix the retry loop first. what does WBC stand for?",
  });
  assert.equal(btwCommand("/btwx"), null);
  assert.equal(btwCommand("/btw/foo"), null);
  assert.equal(btwCommand("/plan design"), null);
  assert.equal(btwCommand(""), null);
});

test("/routine takes the rest of the message as the routine's prompt", () => {
  assert.deepEqual(routineCommand("/routine Check the open PRs.\nList them."), { prompt: "Check the open PRs.\nList them." });
  assert.deepEqual(routineCommand("  /ROUTINE  "), { prompt: "" });
  assert.equal(routineCommand("/routines"), null);
  assert.equal(routineCommand("Make this a /routine"), null);
});
