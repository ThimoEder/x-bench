import { after, test } from "node:test";
import assert from "node:assert/strict";
import { act, createElement } from "react";
import { installDom } from "../../testing/dom.ts";

// react-dom checks for a DOM when it loads, so it comes in after installDom.
const dom = installDom();
const { createRoot } = await import("react-dom/client");
const { MarkdownView, MathText } = await import("./MarkdownView.tsx");
const { loadMath } = await import("./math.ts");

after(async () => {
  await dom.happyDOM.abort();
  dom.close();
});

async function render(element: ReturnType<typeof createElement>) {
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  await act(async () => root.render(element));
  await act(async () => loadMath());
  return {
    container,
    async unmount() {
      await act(async () => root.unmount());
      container.remove();
    },
  };
}

const reply = [
  String.raw`Codex writes \(1089\times9=9801\) and \(A=1\), Claude writes $e^{i\pi}+1=0$.`,
  "",
  "$$",
  String.raw`\sum_{k=1}^{n} k = \frac{n(n+1)}{2}`,
  "$$",
  "",
  String.raw`\[x^2 + y^2 = r^2\]`,
  "",
  "It costs $5 and $10, and `$x$` stays code.",
].join("\n");

test("a reply draws the four forms as math and leaves prices and code alone", async () => {
  const view = await render(createElement(MarkdownView, { text: reply }));
  const math = [...view.container.querySelectorAll(".math")];
  assert.equal(math.length, 5);
  assert.equal(math.filter((node) => node.querySelector(".katex")).length, 5);
  assert.equal(view.container.querySelectorAll(".katex-display").length, 2);
  assert.equal(view.container.querySelector("div.math-display")?.querySelector("annotation")?.textContent, String.raw`\sum_{k=1}^{n} k = \frac{n(n+1)}{2}`);
  const prose = view.container.querySelectorAll("p");
  assert.equal(prose[prose.length - 1]?.textContent, "It costs $5 and $10, and $x$ stays code.");
  assert.equal(view.container.querySelector("p code")?.textContent, "$x$");
  await view.unmount();
});

test("a malformed expression shows its source and the rest of the reply still draws", async () => {
  const view = await render(createElement(MarkdownView, { text: String.raw`Broken $\frac{1$ here, fine $x^2$ there.` }));
  const error = view.container.querySelector(".katex-error");
  assert.equal(error?.textContent, String.raw`\frac{1`);
  assert.equal(view.container.querySelectorAll(".katex").length, 1);
  assert.match(view.container.textContent ?? "", /^Broken .* here, fine .* there\.$/);
  await view.unmount();
});

test("math cannot add links, pictures, classes or ids", async () => {
  const view = await render(
    createElement(MarkdownView, {
      text: String.raw`$\href{javascript:alert(1)}{x}$ $\url{https://example.com}$ $\includegraphics{/etc/passwd}$ $\htmlClass{pwn}{y}$ $\htmlId{pwn}{z}$`,
    }),
  );
  assert.equal(view.container.querySelector("a, img, script, [onerror], [onclick], .pwn, #pwn"), null);
  for (const command of ["\\href", "\\url", "\\includegraphics", "\\htmlClass", "\\htmlId"]) {
    assert.ok(view.container.textContent?.includes(command), command);
  }
  assert.ok(view.container.querySelector('[style*="var(--danger)"]'));
  await view.unmount();
});

test("the thinking detail draws math and keeps the rest as written", async () => {
  const view = await render(createElement("p", null, createElement(MathText, { text: "So **\\(A=1\\)**, not `$b$` or $5." })));
  assert.equal(view.container.querySelectorAll(".katex").length, 1);
  assert.match(view.container.textContent ?? "", /^So \*\*.*\*\*, not `\$b\$` or \$5\.$/);
  await view.unmount();
});
