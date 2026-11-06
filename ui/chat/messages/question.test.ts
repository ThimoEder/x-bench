import assert from "node:assert/strict";
import test from "node:test";
import type { FormField } from "../../../bridge/elicitation.ts";
import { choose, initialValues, isCompanion, missingAnswer, soleChoice, steps, toggle } from "./question.ts";

function field(key: string, kind: FormField["kind"], extra: Partial<FormField> = {}): FormField {
  return { key, kind, title: key, description: "", required: false, options: [], secret: false, default: null, answerFor: null, ...extra };
}

test("a lone single pick answers on the pick, one with an Other box waits for Submit", () => {
  const lone = [field("q", "choice")];
  assert.equal(soleChoice(lone), lone[0]);
  const fields = [field("q", "choice"), field("q_custom", "text")];
  assert.equal(isCompanion(fields, 1), true);
  assert.equal(soleChoice(fields), null);
});

test("several questions, a multi-select or a required text box wait for Submit", () => {
  assert.equal(soleChoice([field("a", "choice"), field("b", "choice")]), null);
  assert.equal(soleChoice([field("a", "multi")]), null);
  assert.equal(soleChoice([field("a", "choice", { options: [{ value: "x", label: "X", description: "", preview: "**x**" }] })]), null);
  const fields = [field("a", "choice"), field("b", "text", { required: true })];
  assert.equal(isCompanion(fields, 1), false);
  assert.equal(soleChoice(fields), null);
});

test("required fields hold Submit until they have an answer", () => {
  const fields = [field("name", "text", { required: true }), field("tags", "multi", { required: true })];
  assert.equal(missingAnswer(fields, { name: "x", tags: [] }), true);
  assert.equal(missingAnswer(fields, { name: " ", tags: ["a"] }), true);
  assert.equal(missingAnswer(fields, { name: "x", tags: ["a"] }), false);
});

test("defaults fill the form, switches start off, and a multi-select toggles", () => {
  assert.deepEqual(initialValues([field("size", "choice", { default: "m" }), field("ok", "boolean"), field("note", "text")]), { size: "m", ok: false });
  const once = toggle({}, "tags", "a");
  assert.deepEqual(once, { tags: ["a"] });
  assert.deepEqual(toggle(toggle(once, "tags", "b"), "tags", "a"), { tags: ["b"] });
});

test("a single pick clears when picked again, and a typed answer stands in for a required pick", () => {
  assert.deepEqual(choose({ db: "SQLite", note: "x" }, "db", "SQLite"), { note: "x" });
  assert.deepEqual(choose({ db: "SQLite" }, "db", "Postgres"), { db: "Postgres" });
  const fields = [field("db", "choice", { required: true }), field("db_note", "text", { answerFor: "db" })];
  assert.equal(missingAnswer(fields, {}), true);
  assert.equal(missingAnswer(fields, { db_note: "DuckDB" }), false);
});

test("a form splits into one step per question, each with its Other box", () => {
  const fields = [field("a", "choice"), field("a_custom", "text"), field("b", "multi"), field("b_custom", "text"), field("c", "text", { required: true })];
  assert.deepEqual(steps(fields).map((step) => step.map((item) => item.key)), [["a", "a_custom"], ["b", "b_custom"], ["c"]]);
});
