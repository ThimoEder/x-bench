import { after, afterEach, test } from "node:test";
import assert from "node:assert/strict";
import { act, createElement } from "react";
import type { Root } from "react-dom/client";
import { installDom, typeInto } from "../../testing/dom.ts";
import type { FormField } from "../../../bridge/elicitation.ts";
import type { PresentedQuestion } from "../../../server/present.ts";

const dom = installDom();
const { createRoot } = await import("react-dom/client");
const { QuestionCard } = await import("./QuestionCard.tsx");

const mounted: Root[] = [];

afterEach(async () => {
  await act(async () => {
    for (const root of mounted.splice(0)) root.unmount();
  });
  document.body.replaceChildren();
});

after(async () => {
  await dom.happyDOM.abort();
  dom.close();
});

function field(key: string, kind: FormField["kind"], extra: Partial<FormField> = {}): FormField {
  return { key, kind, title: key, description: "", required: false, options: [], secret: false, default: null, answerFor: null, ...extra };
}

const SIZES = [
  { value: "s", label: "Small", description: "" },
  { value: "m", label: "Medium", description: "" },
];

async function mount(fields: FormField[]) {
  const calls: (Record<string, unknown> | undefined)[] = [];
  const receipts: unknown[] = [];
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  mounted.push(root);
  const question: PresentedQuestion = { id: "q-1", message: "Which size?", fields, actions: [] };
  await act(async () => {
    root.render(
      createElement(QuestionCard, {
        question,
        call: async (_path: string, body?: Record<string, unknown>) => {
          calls.push(body);
          return {};
        },
        onAnswered: (receipt: unknown) => receipts.push(receipt),
      }),
    );
  });
  const option = (label: string) => [...container.querySelectorAll<HTMLButtonElement>(".question-option")].find((button) => button.textContent === label)!;
  const click = (label: string) => act(async () => option(label).click());
  const press = (testId: string) => act(async () => container.querySelector<HTMLButtonElement>(`[data-testid="${testId}"]`)!.click());
  const button = (testId: string) => container.querySelector<HTMLButtonElement>(`[data-testid="${testId}"]`);
  return { calls, receipts, option, click, press, button, container };
}

test("a lone pick answers with its default when the default is clicked", async () => {
  const card = await mount([field("size", "choice", { options: SIZES, default: "m" })]);
  await card.click("Medium");
  assert.deepEqual(card.calls, [{ id: "q-1", action: "accept", content: { size: "m" } }]);
});

test("a pick with an Other box clears when clicked again", async () => {
  const card = await mount([field("size", "choice", { options: SIZES }), field("size_custom", "text")]);
  await card.click("Small");
  assert.equal(card.option("Small").getAttribute("aria-pressed"), "true");
  await card.click("Small");
  assert.equal(card.option("Small").getAttribute("aria-pressed"), "false");
  assert.deepEqual(card.calls, []);
});

test("a choice's preview opens under the picked choice, and under the first before a pick", async () => {
  const options = [
    { value: "s", label: "Small", description: "", preview: "**small** mockup" },
    { value: "m", label: "Medium", description: "", preview: "**medium** mockup" },
  ];
  const card = await mount([field("size", "choice", { options })]);
  const preview = () => card.container.querySelector(".question-preview");
  assert.equal(preview()?.textContent, "small mockup");
  assert.equal(preview()?.previousElementSibling, card.option("Small"));
  await card.click("Medium");
  assert.equal(preview()?.textContent, "medium mockup");
  assert.equal(preview()?.previousElementSibling, card.option("Medium"));
  assert.deepEqual(card.calls, []);
});

test("several questions show one at a time, keep their answers on Back, and submit together", async () => {
  const card = await mount([
    field("size", "choice", { title: "Size", description: "Which size?", options: SIZES, required: true }),
    field("size_custom", "text"),
    field("extras", "multi", { title: "Extras", description: "Any extras?", options: [{ value: "x", label: "Extra", description: "" }] }),
  ]);
  assert.match(card.container.querySelector('[data-testid="question-step"]')?.textContent ?? "", /1 \/ 2/);
  assert.equal(card.container.querySelector("h2")?.textContent, "Which size?");
  assert.equal(card.button("question-next")?.disabled, true);
  await card.click("Small");
  await card.press("question-next");
  assert.equal(card.container.querySelector("h2")?.textContent, "Any extras?");
  await card.press("question-back");
  assert.equal(card.option("Small").getAttribute("aria-pressed"), "true");
  await card.press("question-next");
  await card.click("Extra");
  await card.press("question-submit");
  assert.deepEqual(card.calls, [{ id: "q-1", action: "accept", content: { size: "s", extras: ["x"] } }]);
});

test("an answer leaves a receipt with the picks and the person's own words, and Skip one that says so", async () => {
  const card = await mount([field("os", "multi", { options: [{ value: "mac", label: "macOS 26", description: "" }, { value: "ios", label: "iOS simulator", description: "" }] }), field("os_custom", "text", { title: "Other" })]);
  await card.click("macOS 26");
  await card.click("iOS simulator");
  const other = card.container.querySelector<HTMLInputElement>(".ask-own input")!;
  await act(async () => typeInto(other, "Windows"));
  assert.ok(card.container.querySelector(".ask-own.sel"));
  await card.press("question-submit");
  assert.deepEqual(card.receipts, [{ icon: "check", label: "Which size?", detail: "macOS 26, iOS simulator, “Windows”", code: false }]);
  await card.press("question-skip");
  assert.deepEqual(card.receipts.at(-1), { icon: "check", label: "Which size?", detail: "Skipped", code: false });
});

test("a switch left off reads No in the receipt", async () => {
  const card = await mount([field("diagnostics", "boolean", { title: "Share diagnostics" })]);
  await card.press("question-submit");
  assert.equal((card.receipts[0] as { detail: string }).detail, "Share diagnostics: No");
});
