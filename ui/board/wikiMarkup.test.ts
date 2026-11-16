import assert from "node:assert/strict";
import test from "node:test";
import { parseMarkdown } from "../chat/markdown/markdown.ts";
import { wikiToMarkdown } from "./wikiMarkup.ts";

test("wiki headings, code, bold and links become Markdown", () => {
  assert.equal(wikiToMarkdown("h2. Finding"), "## Finding");
  assert.equal(
    wikiToMarkdown("A search for {{FLAG_SECURE}} and {{a*b*c}} is *very {{x}} bold*, 2 * 3 * 4 is not"),
    "A search for `FLAG_SECURE` and `a*b*c` is **very `x` bold**, 2 * 3 * 4 is not",
  );
  assert.equal(wikiToMarkdown("See [the docs|https://a.com/b|tip], [https://a.com] and [~accountid:1]"), "See [the docs](https://a.com/b), https://a.com and [~accountid:1]");
  assert.equal(wikiToMarkdown("[docs|https://a.com/Function_(math)]"), "[docs](https://a.com/Function_%28math%29)");
  assert.equal(wikiToMarkdown("bq. said once\n{quote}\nsaid\n* twice\n{quote}"), "> said once\n> said\n> - twice");
});

test("wiki lists nest by the length of their marker", () => {
  assert.equal(wikiToMarkdown("# one\n## inner\n#* dot\n* _Severity:_ Low\n** deep"), "1. one\n  1. inner\n  - dot\n- _Severity:_ Low\n  - deep");
  assert.equal(wikiToMarkdown("*bold* start, #5 and - item"), "**bold** start, #5 and - item");
});

test("a wiki table draws as a Markdown table", () => {
  assert.deepEqual(parseMarkdown(wikiToMarkdown("||Name||*Use*||\n|a|[b|https://b.com]|")), [
    { type: "table", align: ["left", "left"], header: ["Name", "**Use**"], rows: [["a", "[b](https://b.com)"]] },
  ]);
});

test("a wiki code block becomes a fence with its text untouched", () => {
  assert.equal(wikiToMarkdown("Run:\n{code:java|title=A.java}\n# not *a* list {{x}}\n{code}\nh3. Then"), "Run:\n\n```java\n# not *a* list {{x}}\n```\n\n### Then");
  assert.equal(wikiToMarkdown("{noformat}\nh1. raw\n{noformat}"), "\n```\nh1. raw\n```\n");
  assert.equal(wikiToMarkdown("Use {{code}} and {{code}} here"), "Use `code` and `code` here");
  assert.equal(wikiToMarkdown("{code}\nwrite {{code}} twice\n{code}"), "\n```\nwrite {{code}} twice\n```\n");
});

test("Markdown in the text stays as written", () => {
  const text = "**Fixed** in ![after](/api/files/9), `*x*` and [PR](https://a.com/1)\n```\n# comment\n```";
  assert.equal(wikiToMarkdown(text), text);
});
