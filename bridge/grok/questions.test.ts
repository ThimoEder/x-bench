import assert from "node:assert/strict";
import test from "node:test";
import { AskParams, grokQuestionForm, grokQuestionReply } from "./questions.ts";

const asked = AskParams.parse({
  sessionId: "s1",
  toolCallId: "call-1",
  mode: "default",
  questions: [
    { question: "Which database?", options: [{ label: "SQLite", description: "One file." }, { label: "Postgres" }], multiSelect: null },
    { question: "Which extras?", header: "Extras", options: [{ label: "Auth" }, { label: "Search" }], multiSelect: true },
  ],
});
const questions = asked.questions ?? [];

test("Grok's questions read as picks, each with its Other box, and chat about this", () => {
  const form = grokQuestionForm(questions, asked.mode);
  assert.equal(form.message, "");
  assert.deepEqual(form.fields.map((field) => [field.key, field.kind, field.title, field.description]), [
    ["question_0", "choice", "", "Which database?"],
    ["question_0_custom", "text", "Other", "Your own answer, or a note on your pick."],
    ["question_1", "multi", "Extras", "Which extras?"],
    ["question_1_custom", "text", "Other", "Your own answer, added to your picks."],
  ]);
  assert.deepEqual(form.fields[0]?.options[0], { value: "SQLite", label: "SQLite", description: "One file." });
  assert.deepEqual(form.actions.map((choice) => choice.id), ["chat_about_this"]);
  assert.deepEqual(grokQuestionForm(questions, "plan").actions.map((choice) => choice.id), ["chat_about_this", "skip_interview"]);
  assert.equal(grokQuestionForm(questions.slice(0, 1), "default").message, "Which database?");
});

test("an answer goes back keyed by question, with Other as the answer, a note, or one more pick", () => {
  const form = grokQuestionForm(questions, asked.mode).fields;
  assert.deepEqual(grokQuestionReply(questions, form, "accept", { question_0: "SQLite", question_0_custom: "WAL mode", question_1: ["Auth"], question_1_custom: "Tags" }), {
    outcome: "accepted",
    answers: { "Which database?": "SQLite", "Which extras?": ["Auth", "Tags"] },
    annotations: { "Which database?": { notes: "WAL mode" } },
  });
  assert.deepEqual(grokQuestionReply(questions, form, "accept", { question_0_custom: "DuckDB", question_1: ["Nope"] }), {
    outcome: "accepted",
    answers: { "Which database?": "DuckDB" },
  });
});

test("chat about this and skip interview carry the picks so far, and skip or stop decline", () => {
  const form = grokQuestionForm(questions, "plan").fields;
  assert.deepEqual(grokQuestionReply(questions, form, "chat_about_this", { question_0: "Postgres" }), {
    outcome: "chat_about_this",
    partial_answers: { "Which database?": "Postgres" },
  });
  assert.deepEqual(grokQuestionReply(questions, form, "skip_interview", {}), { outcome: "skip_interview", partial_answers: {} });
  assert.deepEqual(grokQuestionReply(questions, form, "decline"), { outcome: "cancelled" });
  assert.deepEqual(grokQuestionReply(questions, form, "cancel"), { outcome: "cancelled" });
});
