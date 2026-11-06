import assert from "node:assert/strict";
import test from "node:test";
import type { TranscriptItem } from "../../bridge/reducer.ts";
import {
  estimateTokens,
  anyEntries,
  MESSAGE_LIMIT,
  needsSummary,
  RECENT_LIMIT,
  shorten,
  stripHandoff,
  summaryHandoff,
  SUMMARY_REQUEST,
  TEXT_CEILING,
  textHandoff,
  textLimit,
  WHOLE_LIMIT,
  wholeHandoff,
  wholeLimit,
  withHandoff,
  withoutSummaryTurns,
} from "./handoff.ts";

function user(text: string): TranscriptItem {
  return { id: text.slice(0, 20), type: "user", text, streaming: false };
}

function reply(text: string): TranscriptItem {
  return { id: text.slice(0, 20), type: "assistant", text, streaming: false };
}

function tool(title: string, parentId?: string): TranscriptItem {
  return { id: title, type: "tool", toolCallId: title, title, name: "", kind: "read", status: "completed", rawInput: null, rawOutput: "secret output", facts: { role: "read" }, diffs: [], locations: null, ...(parentId ? { parentId } : {}) };
}

test("the conversation becomes messages and one entry per run of tool calls, without output or thoughts", () => {
  const items: TranscriptItem[] = [
    user("Why does the sidebar flash?"),
    { id: "t", type: "thought", text: "Let me look", streaming: false },
    tool("Read ui/Sidebar.tsx"),
    tool("Read ui/styles.css"),
    tool("Grep inside a subagent", "parent"),
    reply("The row leaves before its transition ends."),
  ];
  const text = wholeHandoff([{ speaker: "Claude", items }]).text;
  assert.match(text, /<message from="User">\nWhy does the sidebar flash\?\n<\/message>\n\n<tools from="Claude">\n\[Read ui\/Sidebar\.tsx\] \[Read ui\/styles\.css\]\n<\/tools>\n\n<message from="Claude">\nThe row leaves/);
  assert.doesNotMatch(text, /Let me look|Grep inside|secret output/);
});

test("a short conversation goes whole, each message in its own tag, naming every provider it ran on", () => {
  const handoff = wholeHandoff([
    { speaker: "Claude", items: [user("Fix it."), reply("| a | b |\n| - | - |\n| 1 | 2 |")] },
    { speaker: "Grok", items: [user("Check it."), reply("Looks right.")] },
  ]);
  assert.match(handoff.text, /^<x-bench-handoff ref="(\w+)">[\s\S]*<\/x-bench-handoff ref="\1">$/);
  assert.match(handoff.text, /ran on Claude, then Grok/);
  assert.match(handoff.text, /<message from="Claude">\n\| a \| b \|\n\| - \| - \|\n\| 1 \| 2 \|\n<\/message>/);
  assert.match(handoff.text, /<message from="Grok">\nLooks right\.\n<\/message>/);
  assert.equal(handoff.summarized, false);
  assert.equal(needsSummary([{ speaker: "Claude", items: [user("Fix it.")] }], null), false);
});

test("whole goes up to 8k tokens, or a quarter of a smaller window", () => {
  assert.equal(wholeLimit(null), WHOLE_LIMIT);
  assert.equal(wholeLimit(1_000_000), WHOLE_LIMIT);
  assert.equal(wholeLimit(16_000), 4_000);
  const long = [{ speaker: "Grok", items: [user("x".repeat(WHOLE_LIMIT * 4 + 400))] }];
  assert.equal(needsSummary(long, null), true);
});

test("a long message keeps its start and end and says how much was left out", () => {
  const text = `START ${"y".repeat(100_000)} END`;
  const short = shorten(text, MESSAGE_LIMIT);
  assert.ok(estimateTokens(short) <= MESSAGE_LIMIT + 20);
  assert.match(short, /^START/);
  assert.match(short, /END$/);
  assert.match(short, /\[… [\d,]+ characters left out …\]/);
  assert.equal(shorten("short", MESSAGE_LIMIT), "short");
});

test("past the limit, the summary goes first, then the last two exchanges with long messages shortened", () => {
  const paste = `Here are six files.\n${"code ".repeat(40_000)}`;
  const stretches = [
    { speaker: "Claude", items: [user("Write the overview."), reply("Overview with tables."), user("Old question."), reply("Old answer.")] },
    { speaker: "Grok", items: [user(paste), reply("Received 19 8787"), user("Which port?"), reply("8787.")] },
  ];
  const handoff = summaryHandoff(stretches, "## Goal\nAn overview of X Bench.");
  assert.equal(handoff.summarized, true);
  assert.equal(handoff.cut, true);
  assert.match(handoff.text, /<summary>\n## Goal\nAn overview of X Bench\.\n<\/summary>/);
  // The reply after the paste stays a message of its own.
  assert.match(handoff.text, /<message from="Grok">\nReceived 19 8787\n<\/message>/);
  assert.match(handoff.text, /characters left out/);
  assert.doesNotMatch(handoff.text, /Old question/);
  assert.ok(handoff.tokens < RECENT_LIMIT + 1_000);
});

test("without a summary only the latest exchanges go, and the handoff says the rest is left out", () => {
  const handoff = summaryHandoff([{ speaker: "Grok", items: [user("a"), reply("b"), user("c"), reply("d"), user("e"), reply("f")] }], null);
  assert.equal(handoff.summarized, false);
  assert.match(handoff.text, /The earlier part is left out/);
  assert.doesNotMatch(handoff.text, /<message from="User">\na\n/);
  assert.match(handoff.text, /<message from="Grok">\nf\n<\/message>/);
});

test("the message bubble shows only the person's words", () => {
  const sent = withHandoff(wholeHandoff([{ speaker: "Claude", items: [user("context")] }]).text, "Take a second look.");
  assert.equal(stripHandoff(sent), "Take a second look.");
  assert.equal(stripHandoff("Plain message"), "Plain message");
  // A handoff carried inside an earlier stretch is not sent on again.
  assert.match(wholeHandoff([{ speaker: "Grok", items: [user(sent)] }]).text, /<message from="User">\nTake a second look\.\n<\/message>/);
});

test("as text, the newest entries go first, a long answer stays whole, and only an outlier is shortened", () => {
  const answer = `| a | b |\n| - | - |\n${"| row | value |\n".repeat(400)}`;
  const paste = `PASTE ${"z".repeat(200_000)} END`;
  const handoff = textHandoff(
    [
      { speaker: "Claude", items: [user("oldest question"), reply("oldest answer")] },
      { speaker: "Grok", items: [user(paste), reply(answer), user("latest question"), reply("latest answer")] },
    ],
    20_000,
  );
  assert.equal(handoff.summarized, false);
  assert.ok(handoff.tokens <= 20_000 + 200);
  // The table answer is about 1.6k tokens, well under a third of the limit, so it goes whole.
  assert.ok(handoff.text.includes(answer));
  assert.match(handoff.text, /PASTE[\s\S]*characters left out[\s\S]*END/);
  assert.match(handoff.text, /latest answer/);
});

test("as text, older entries are left out once the limit is used, and the handoff says so", () => {
  const many = Array.from({ length: 60 }, (_, index) => user(`entry ${index} ${"w".repeat(2000)}`));
  const handoff = textHandoff([{ speaker: "Grok", items: many }], 5_000);
  assert.equal(handoff.cut, true);
  assert.match(handoff.text, /newest entries only/);
  assert.match(handoff.text, /entry 59 /);
  assert.doesNotMatch(handoff.text, /entry 0 /);
  assert.equal(textLimit(1_000_000), TEXT_CEILING);
  assert.equal(textLimit(128_000), 32_000);
});

test("a summary turn left in a session is never shown or passed on", () => {
  const items: TranscriptItem[] = [user("Fix it."), reply("Fixed."), user(SUMMARY_REQUEST), reply("# Partial summa"), user("Next question."), reply("Answer.")];
  assert.deepEqual(withoutSummaryTurns(items).map((item) => item.text), ["Fix it.", "Fixed.", "Next question.", "Answer."]);
  assert.doesNotMatch(wholeHandoff([{ speaker: "Claude", items }]).text, /Partial summa/);
});

test("a hidden notice the harness adds inside a summary turn does not end it", () => {
  const notice: TranscriptItem = { id: "n", type: "user", text: "<task-notification>done</task-notification>", streaming: false, hidden: true };
  const items: TranscriptItem[] = [user("Fix it."), user(SUMMARY_REQUEST), notice, reply("# Partial summa"), user("Next.")];
  assert.deepEqual(withoutSummaryTurns(items).map((item) => item.text), ["Fix it.", "Next."]);
});

test("a message that quotes the handoff's closing tag neither ends the handoff nor shows in the bubble", () => {
  const quoting = reply('It is "</x-bench-handoff>" and "</message>".');
  const handoff = wholeHandoff([{ speaker: "Claude", items: [user("What closes it?"), quoting] }]);
  assert.match(handoff.text, /<\\\/message>/);
  assert.equal(stripHandoff(withHandoff(handoff.text, "Next question")), "Next question");
  // So a summary request sent with a handoff is still recognized and hidden.
  assert.deepEqual(withoutSummaryTurns([user(withHandoff(handoff.text, SUMMARY_REQUEST)), reply("# Summary")]), []);
});

test("stretches with nothing but thoughts or hidden notices hold nothing to hand over", () => {
  const thought: TranscriptItem = { id: "t", type: "thought", text: "hmm", streaming: false };
  assert.equal(anyEntries([{ speaker: "Grok", items: [thought] }, { speaker: "Claude", items: [] }]), false);
  assert.equal(anyEntries([{ speaker: "Grok", items: [user("hi")] }]), true);
});
