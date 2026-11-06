import assert from "node:assert/strict";
import test from "node:test";
import { formContent, formFields } from "./elicitation.ts";

test("Claude's AskUserQuestion form reads as picks with their Other box", () => {
  const form = formFields({
    type: "object",
    properties: {
      question_0: {
        type: "string",
        title: "Auth",
        description: "Which auth method?",
        oneOf: [
          { const: "OAuth", title: "OAuth", description: "Sign in with a provider" },
          { const: "Password", title: "Password" },
        ],
      },
      question_0_custom: { type: "string", title: "Other", description: "Type your own answer (optional)." },
      question_1: { type: "array", title: "Features", items: { anyOf: [{ const: "Logs", title: "Logs" }, { const: "Metrics", title: "Metrics" }] } },
    },
  });
  assert.deepEqual(form.map((field) => [field.key, field.kind, field.title, field.description, field.required]), [
    ["question_0", "choice", "Auth", "Which auth method?", false],
    ["question_0_custom", "text", "Other", "Type your own answer (optional).", false],
    ["question_1", "multi", "Features", "", false],
  ]);
  assert.deepEqual(form[0]?.options, [
    { value: "OAuth", label: "OAuth", description: "Sign in with a provider" },
    { value: "Password", label: "Password", description: "" },
  ]);
});

test("A choice keeps the preview its _meta carries", () => {
  const form = formFields({
    type: "object",
    properties: {
      layout: {
        type: "string",
        oneOf: [
          { const: "Grid", title: "Grid", _meta: { "_claude/askUserQuestionOption": { preview: "```\n[a] [b]\n```" } } },
          { const: "List", title: "List", _meta: { "_claude/askUserQuestionOption": { preview: 3 } } },
        ],
      },
    },
  });
  assert.deepEqual(form[0]?.options, [
    { value: "Grid", label: "Grid", description: "", preview: "```\n[a] [b]\n```" },
    { value: "List", label: "List", description: "" },
  ]);
});

test("Codex's question puts its header in title and its question in description, and keeps secrets secret", () => {
  const form = formFields({
    type: "object",
    required: ["name", "token"],
    properties: {
      name: { type: "string", title: "What should the app be called?", description: "Name", _meta: { codex: { isOther: false, isSecret: false } } },
      token: { type: "string", title: "Paste the token", _meta: { codex: { isSecret: true } } },
    },
  });
  assert.deepEqual(form.map((field) => [field.title, field.description, field.required, field.secret]), [
    ["Name", "What should the app be called?", true, false],
    ["Paste the token", "", true, true],
  ]);
});

test("an MCP server's plain enums, numbers and switches read too, and unknown types drop out", () => {
  const form = formFields({
    type: "object",
    properties: {
      size: { type: "string", enum: ["s", "m"], enumNames: ["Small", "Medium"], default: "m" },
      count: { type: "integer", description: "How many?" },
      ok: { type: "boolean", title: "Confirm" },
      blob: { type: "object" },
    },
  });
  assert.deepEqual(form.map((field) => [field.key, field.kind, field.title, field.default]), [
    ["size", "choice", "size", "m"],
    ["count", "integer", "How many?", null],
    ["ok", "boolean", "Confirm", null],
  ]);
  assert.deepEqual(form[0]?.options.map((option) => option.label), ["Small", "Medium"]);
  assert.deepEqual(formFields(null), []);
});

test("an answer keeps only the form's fields, its options and its types", () => {
  const form = formFields({
    type: "object",
    properties: {
      pick: { type: "string", oneOf: [{ const: "a" }, { const: "b" }] },
      many: { type: "array", items: { enum: ["x", "y"] } },
      note: { type: "string" },
      count: { type: "integer" },
      ok: { type: "boolean" },
    },
  });
  assert.deepEqual(formContent(form, { pick: "c", many: ["x", "z", "x"], note: "  ", count: "4.7", ok: true, extra: 1 }), {
    many: ["x"],
    count: 4,
    ok: true,
  });
  assert.deepEqual(formContent(form, { pick: "b", note: "hi" }), { pick: "b", note: "hi" });
  assert.deepEqual(formContent(form, "nope"), {});
});

test("Codex's note box answers its question when nothing is picked, and stays a note beside a pick", () => {
  const form = formFields({
    type: "object",
    required: ["db"],
    properties: {
      db: { type: "string", title: "Which database?", description: "Database", oneOf: [{ const: "Postgres" }, { const: "SQLite" }] },
      db_note: {
        type: "string",
        title: "Additional answer or note",
        _meta: { codex: { questionId: "db", role: "user_note" }, jetbrains: { air: { version: 1, customAnswer: true } } },
      },
    },
  });
  assert.deepEqual(form.map((field) => field.answerFor), [null, "db"]);
  assert.deepEqual(formContent(form, { db_note: " DuckDB " }), { db: "DuckDB" });
  assert.deepEqual(formContent(form, { db: "SQLite", db_note: "WAL mode" }), { db: "SQLite", db_note: "WAL mode" });
});
