import assert from "node:assert/strict";
import test from "node:test";
import { isMarkdownPath, parseInline, parseMarkdown, parseMathText, type MarkdownBlock } from "./markdown.ts";

function textAt(blocks: MarkdownBlock[], index: number): string {
  const block = blocks.at(index);
  assert.ok(block?.type === "text", `no text block at ${index}`);
  return block.text;
}

test("markdown files are the ones the plan view can render", () => {
  assert.equal(isMarkdownPath("architecture.md"), true);
  assert.equal(isMarkdownPath("/work/app/PLAN.markdown"), true);
  assert.equal(isMarkdownPath("notes.MD"), true);
  assert.equal(isMarkdownPath("main.js"), false);
  assert.equal(isMarkdownPath("readme.md.bak"), false);
});

test("parseMarkdown keeps prose and fenced code apart", () => {
  const blocks = parseMarkdown("See\n```js\nconst n = 1;\n```\nDone");
  assert.deepEqual(blocks, [
    { type: "text", text: "See" },
    { type: "code", lang: "js", text: "const n = 1;" },
    { type: "text", text: "Done" },
  ]);
});

test("parseInline marks bold and inline code", () => {
  assert.deepEqual(parseInline("say **hi** and `n`"), [
    { type: "text", text: "say " },
    { type: "strong", text: "hi" },
    { type: "text", text: " and " },
    { type: "code", text: "n" },
  ]);
});

test("parseInline marks italic without touching snake_case", () => {
  assert.deepEqual(parseInline("a *note* and file_name"), [
    { type: "text", text: "a " },
    { type: "em", text: "note" },
    { type: "text", text: " and file_name" },
  ]);
});

test("a plan keeps headings, lists, and links", () => {
  const blocks = parseMarkdown("# Title\n\nUse [docs](https://example.com/plan).\n\n- one\n- two\n\n1. first");
  assert.deepEqual(blocks, [
    { type: "heading", level: 1, text: "Title" },
    { type: "text", text: "Use [docs](https://example.com/plan)." },
    { type: "list", ordered: false, items: [{ text: "one" }, { text: "two" }] },
    { type: "list", ordered: true, items: [{ text: "first" }] },
  ]);
  assert.deepEqual(parseInline(blocks[1]?.text), [
    { type: "text", text: "Use " },
    { type: "link", text: "docs", href: "https://example.com/plan" },
    { type: "text", text: "." },
  ]);
  assert.deepEqual(parseInline("skip [x](javascript:alert(1))"), [{ type: "text", text: "skip [x](javascript:alert(1))" }]);
});

test("an indented marker starts a list inside the item above it, to any depth and of either kind", () => {
  assert.deepEqual(parseMarkdown("6. Parent\n\n   1. Child\n   2. Other child\n7. Next"), [
    {
      type: "list",
      ordered: true,
      start: 6,
      items: [
        { text: "Parent", children: [{ type: "list", ordered: true, items: [{ text: "Child" }, { text: "Other child" }] }] },
        { text: "Next" },
      ],
    },
  ]);
  assert.deepEqual(parseMarkdown("- a\n  - b\n    1. c\n\t\t- d\n- e"), [
    {
      type: "list",
      ordered: false,
      items: [
        {
          text: "a",
          children: [
            {
              type: "list",
              ordered: false,
              items: [
                {
                  text: "b",
                  children: [
                    { type: "list", ordered: true, items: [{ text: "c", children: [{ type: "list", ordered: false, items: [{ text: "d" }] }] }] },
                  ],
                },
              ],
            },
          ],
        },
        { text: "e" },
      ],
    },
  ]);
});

test("a list numbered from 1 again under an item that ends with a colon belongs to that item", () => {
  const source = "5. Tests\n6. **Order of work, in one branch:**\n\n1. Parser\n2. View\n\n3. Styles\n\n7. Ship it";
  assert.deepEqual(parseMarkdown(source), [
    {
      type: "list",
      ordered: true,
      start: 5,
      items: [
        { text: "Tests" },
        {
          text: "**Order of work, in one branch:**",
          children: [{ type: "list", ordered: true, items: [{ text: "Parser" }, { text: "View" }, { text: "Styles" }] }],
        },
        { text: "Ship it" },
      ],
    },
  ]);
  assert.deepEqual(parseMarkdown("1. a\n2. b\n\n1. c\n2. d"), [
    { type: "list", ordered: true, items: [{ text: "a" }, { text: "b" }] },
    { type: "list", ordered: true, items: [{ text: "c" }, { text: "d" }] },
  ]);
  assert.deepEqual(parseMarkdown("1. a\n1. b\n1. c"), [{ type: "list", ordered: true, items: [{ text: "a" }, { text: "b" }, { text: "c" }] }]);
});

test("a blank line between items keeps one list, and indented lines stay in their item", () => {
  assert.deepEqual(parseMarkdown("1. **Step**\n   wrapped on\n\n   More about it.\n   And more.\n\n2. Next\n   - sub\n\n   After sub."), [
    {
      type: "list",
      ordered: true,
      items: [
        { text: "**Step**\nwrapped on", children: [{ type: "text", text: "More about it.\nAnd more." }] },
        { text: "Next", children: [{ type: "list", ordered: false, items: [{ text: "sub" }] }, { type: "text", text: "After sub." }] },
      ],
    },
  ]);
  assert.deepEqual(parseMarkdown("- one\n\n- two\nAfter\n\n- three\n\nEnd"), [
    { type: "list", ordered: false, items: [{ text: "one" }, { text: "two" }] },
    { type: "text", text: "After" },
    { type: "list", ordered: false, items: [{ text: "three" }] },
    { type: "text", text: "End" },
  ]);
  assert.deepEqual(parseMarkdown("- a\n\n1. b"), [
    { type: "list", ordered: false, items: [{ text: "a" }] },
    { type: "list", ordered: true, items: [{ text: "b" }] },
  ]);
});

test("a marker or line a little off its list's indent still lands where it belongs", () => {
  assert.deepEqual(parseMarkdown("1. First\n2. Second\n1. Third\n4. Fourth"), [
    { type: "list", ordered: true, items: [{ text: "First" }, { text: "Second" }, { text: "Third" }, { text: "Fourth" }] },
  ]);
  assert.deepEqual(parseMarkdown("- parent\n  - child\n - sibling"), [
    { type: "list", ordered: false, items: [{ text: "parent", children: [{ type: "list", ordered: false, items: [{ text: "child" }] }] }, { text: "sibling" }] },
  ]);
  assert.deepEqual(parseMarkdown("  - first\n- second\n  - nested"), [
    { type: "list", ordered: false, items: [{ text: "first" }, { text: "second", children: [{ type: "list", ordered: false, items: [{ text: "nested" }] }] }] },
  ]);
  assert.deepEqual(parseMarkdown("- a\n   - b\n  - c"), [
    { type: "list", ordered: false, items: [{ text: "a", children: [{ type: "list", ordered: false, items: [{ text: "b" }, { text: "c" }] }] }] },
  ]);
  assert.deepEqual(parseMarkdown("- Item\n\n Summary"), [
    { type: "list", ordered: false, items: [{ text: "Item" }] },
    { type: "text", text: "Summary" },
  ]);
});

test("a bare web address is a link, and the sentence mark stays outside it", () => {
  assert.deepEqual(parseInline("The pull request is open: https://github.com/ThimoEder/x_bench/pull/16"), [
    { type: "text", text: "The pull request is open: " },
    {
      type: "link",
      text: "https://github.com/ThimoEder/x_bench/pull/16",
      href: "https://github.com/ThimoEder/x_bench/pull/16",
    },
  ]);
  assert.deepEqual(parseInline("See https://example.com/docs."), [
    { type: "text", text: "See " },
    { type: "link", text: "https://example.com/docs", href: "https://example.com/docs" },
    { type: "text", text: "." },
  ]);
  assert.deepEqual(parseInline("(https://example.com/a?x=1)."), [
    { type: "text", text: "(" },
    { type: "link", text: "https://example.com/a?x=1", href: "https://example.com/a?x=1" },
    { type: "text", text: ")." },
  ]);
  assert.deepEqual(parseInline("https://en.wikipedia.org/wiki/URL_(disambiguation)."), [
    {
      type: "link",
      text: "https://en.wikipedia.org/wiki/URL_(disambiguation)",
      href: "https://en.wikipedia.org/wiki/URL_(disambiguation)",
    },
    { type: "text", text: "." },
  ]);
});

test("a web address inside code, or written as an angle link, stays in its own form", () => {
  assert.deepEqual(parseInline("run `https://example.com` now"), [
    { type: "text", text: "run " },
    { type: "code", text: "https://example.com" },
    { type: "text", text: " now" },
  ]);
  assert.deepEqual(parseInline("Go to <https://example.com/plan>."), [
    { type: "text", text: "Go to " },
    { type: "link", text: "https://example.com/plan", href: "https://example.com/plan" },
    { type: "text", text: "." },
  ]);
  assert.deepEqual(parseInline("skip https://"), [{ type: "text", text: "skip https://" }]);
  assert.deepEqual(parseInline("skip <https://> and <https://?x>"), [
    { type: "text", text: "skip <https://> and <https://?x>" },
  ]);
});

test("a link whose href is not a web address stays text, the address in its label too", () => {
  assert.deepEqual(parseInline("[https://a.com](/rel) here"), [{ type: "text", text: "[https://a.com](/rel) here" }]);
  assert.deepEqual(parseInline("[see](https://a.com/x y)"), [{ type: "text", text: "[see](https://a.com/x y)" }]);
});

test("a short ticket link keeps its href for the chat to resolve", () => {
  assert.deepEqual(parseInline("Waits on [#436](?task=436)."), [
    { type: "text", text: "Waits on " },
    { type: "link", text: "#436", href: "?task=436" },
    { type: "text", text: "." },
  ]);
  assert.deepEqual(parseInline("[see](?task=1&cwd=/etc)"), [{ type: "text", text: "[see](?task=1&cwd=/etc)" }]);
  assert.deepEqual(parseInline("a short [#id](?task=id) link"), [{ type: "text", text: "a short [#id](?task=id) link" }]);
});

test("a bare web address ends before code, bold, and quotes or marks from other scripts", () => {
  assert.deepEqual(parseInline("Open https://example.com/`id` now"), [
    { type: "text", text: "Open " },
    { type: "link", text: "https://example.com/", href: "https://example.com/" },
    { type: "code", text: "id" },
    { type: "text", text: " now" },
  ]);
  assert.deepEqual(parseInline("see https://a.com/**x**"), [
    { type: "text", text: "see " },
    { type: "link", text: "https://a.com/", href: "https://a.com/" },
    { type: "strong", text: "x" },
  ]);
  assert.deepEqual(parseInline("„https://a.com/x“ steht da"), [
    { type: "text", text: "„" },
    { type: "link", text: "https://a.com/x", href: "https://a.com/x" },
    { type: "text", text: "“ steht da" },
  ]);
  assert.deepEqual(parseInline("见 https://a.com/x。下一句"), [
    { type: "text", text: "见 " },
    { type: "link", text: "https://a.com/x", href: "https://a.com/x" },
    { type: "text", text: "。下一句" },
  ]);
  assert.deepEqual(parseInline("Read https://a.com/some_path_here and _this_"), [
    { type: "text", text: "Read " },
    { type: "link", text: "https://a.com/some_path_here", href: "https://a.com/some_path_here" },
    { type: "text", text: " and " },
    { type: "em", text: "this" },
  ]);
});

test("a pipe table becomes rows, and inline code stays inside its cell", () => {
  const source = [
    "Before",
    "",
    "| Agent | What T3 actually runs | How progress is kept |",
    "| --- | --- | --- |",
    "| Codex | `codex app-server` over stdio | A Codex adapter maps `item/agentMessage/delta`. |",
    "| Grok | `grok agent stdio` over ACP | A shared parser handles `session/update`. |",
    "",
    "After",
  ].join("\n");
  assert.deepEqual(parseMarkdown(source), [
    { type: "text", text: "Before" },
    {
      type: "table",
      align: ["left", "left", "left"],
      header: ["Agent", "What T3 actually runs", "How progress is kept"],
      rows: [
        ["Codex", "`codex app-server` over stdio", "A Codex adapter maps `item/agentMessage/delta`."],
        ["Grok", "`grok agent stdio` over ACP", "A shared parser handles `session/update`."],
      ],
    },
    { type: "text", text: "After" },
  ]);
});

test("table columns follow the delimiter, including alignment, escapes, and short rows", () => {
  const source = [
    "| abc | defghi |",
    ":-: | -----------:",
    "bar | baz",
    "only",
    "| extra | cells | dropped |",
    "",
    "| f\\|oo  |",
    "| ------ |",
    "| b `\\|` az |",
    "| b **\\|** im |",
  ].join("\n");
  assert.deepEqual(parseMarkdown(source), [
    {
      type: "table",
      align: ["center", "right"],
      header: ["abc", "defghi"],
      rows: [
        ["bar", "baz"],
        ["only", ""],
        ["extra", "cells"],
      ],
    },
    {
      type: "table",
      align: ["left"],
      header: ["f|oo"],
      rows: ["b `|` az", "b **|** im"].map((text) => [text]),
    },
  ]);
});

test("a header that does not match its delimiter stays prose", () => {
  assert.deepEqual(parseMarkdown("| abc | def |\n| --- |\n| bar |"), [
    { type: "text", text: "| abc | def |\n| --- |\n| bar |" },
  ]);
  assert.deepEqual(parseMarkdown("Use a | b in a sentence.\n\nStill prose."), [
    { type: "text", text: "Use a | b in a sentence." },
    { type: "text", text: "Still prose." },
  ]);
});

test("a heading or list ends a table, and a pipe inside code does not split a cell", () => {
  const source = [
    "| left | `a|b` | right |",
    "| --- | --- | --- |",
    "| 1 | 2 | 3 |",
    "- next",
    "",
    "| A | B |",
    "| --- | --- |",
    "# Later",
  ].join("\n");
  assert.deepEqual(parseMarkdown(source), [
    {
      type: "table",
      align: ["left", "left", "left"],
      header: ["left", "`a|b`", "right"],
      rows: [["1", "2", "3"]],
    },
    { type: "list", ordered: false, items: [{ text: "next" }] },
    {
      type: "table",
      align: ["left", "left"],
      header: ["A", "B"],
      rows: [],
    },
    { type: "heading", level: 1, text: "Later" },
  ]);
});

test("a full chat block keeps paragraphs, italic, and a fenced block", () => {
  const source = "Use *italic* and **bold**.\n\nThen:\n```js\nconst n = 1;\n```";
  assert.deepEqual(parseMarkdown(source), [
    { type: "text", text: "Use *italic* and **bold**." },
    { type: "text", text: "Then:" },
    { type: "code", lang: "js", text: "const n = 1;" },
  ]);
  assert.deepEqual(parseInline(textAt(parseMarkdown(source), 0)), [
    { type: "text", text: "Use " },
    { type: "em", text: "italic" },
    { type: "text", text: " and " },
    { type: "strong", text: "bold" },
    { type: "text", text: "." },
  ]);
});

test("lines that start with > become one quote, and its text is parsed again", () => {
  assert.deepEqual(parseMarkdown("Intro\n> **Bugs**\n>\n> - item\n>   continued\n>> nested\nAfter"), [
    { type: "text", text: "Intro" },
    {
      type: "quote",
      blocks: [
        { type: "text", text: "**Bugs**" },
        { type: "list", ordered: false, items: [{ text: "item\ncontinued" }] },
        { type: "quote", blocks: [{ type: "text", text: "nested" }] },
      ],
    },
    { type: "text", text: "After" },
  ]);
});

test("a quote indented under a list item stays in that item", () => {
  assert.deepEqual(parseMarkdown("- item\n  > **detail**\n  > more\n- next\n\n> after"), [
    {
      type: "list",
      ordered: false,
      items: [{ text: "item", children: [{ type: "quote", blocks: [{ type: "text", text: "**detail**\nmore" }] }] }, { text: "next" }],
    },
    { type: "quote", blocks: [{ type: "text", text: "after" }] },
  ]);
});

test("quotes nest at most fifty deep, and a longer run of markers stays text", () => {
  let blocks = parseMarkdown(">".repeat(5000) + " x");
  for (let depth = 0; depth < 50; depth++) {
    const quote = blocks[0];
    assert.ok(quote?.type === "quote");
    blocks = quote.blocks;
  }
  assert.deepEqual(blocks, [{ type: "text", text: ">".repeat(4950) + " x" }]);
});

test("a fence inside a quote stays code in the quote, and a > inside a fence stays code", () => {
  assert.deepEqual(parseMarkdown("> Run:\n> ```sh\n> > not a quote\n> ```\n\n```\n> $ ls\n```"), [
    {
      type: "quote",
      blocks: [
        { type: "text", text: "Run:" },
        { type: "code", lang: "sh", text: "> not a quote" },
      ],
    },
    { type: "code", lang: "", text: "> $ ls" },
  ]);
  assert.deepEqual(parseMarkdown("> ```js\n> let a"), [{ type: "quote", blocks: [{ type: "code", lang: "js", text: "let a", open: true }] }]);
});

test("parseInline turns a link to an absolute path into a file link, with its line apart", () => {
  assert.deepEqual(parseInline("Created [goodbye.txt](/tmp/probe/goodbye.txt) beside it."), [
    { type: "text", text: "Created " },
    { type: "file", text: "goodbye.txt", path: "/tmp/probe/goodbye.txt" },
    { type: "text", text: " beside it." },
  ]);
  assert.deepEqual(parseInline("[app.ts](/repo/server/app.ts:42)"), [{ type: "file", text: "app.ts", path: "/repo/server/app.ts", line: 42 }]);
  assert.deepEqual(parseInline("[app.ts](/repo/app.ts#L7)"), [{ type: "file", text: "app.ts", path: "/repo/app.ts", line: 7 }]);
  assert.deepEqual(parseInline("[my notes](</repo/my notes.md>)"), [{ type: "file", text: "my notes", path: "/repo/my notes.md" }]);
  assert.deepEqual(parseInline("[a b](file:///repo/a%20b.ts)"), [{ type: "file", text: "a b", path: "/repo/a b.ts" }]);
});

test("parseInline keeps a link that is neither a web address nor an absolute path as text", () => {
  assert.deepEqual(parseInline("see [notes](notes.md) and [x](//host/y)"), [{ type: "text", text: "see [notes](notes.md) and [x](//host/y)" }]);
});

test("parseInline shows a local or web picture inline, and anything else as written", () => {
  assert.deepEqual(parseInline("Here: ![Emulator screen](/tmp/shot.png)"), [
    { type: "text", text: "Here: " },
    { type: "image", text: "Emulator screen", path: "/tmp/shot.png" },
  ]);
  assert.deepEqual(parseInline("![](file:///tmp/a%20b.jpg)"), [{ type: "image", text: "a b.jpg", path: "/tmp/a b.jpg" }]);
  assert.deepEqual(parseInline("![shot](shots/home.png)"), [{ type: "image", text: "shot", path: "shots/home.png" }]);
  assert.deepEqual(parseInline("![logo](https://a.com/logo.png)"), [{ type: "webImage", text: "logo", href: "https://a.com/logo.png" }]);
  assert.deepEqual(parseInline("![](https://a.com/t.JPG?resize=768)"), [{ type: "webImage", text: "t.JPG?resize=768", href: "https://a.com/t.JPG?resize=768" }]);
  assert.deepEqual(parseInline("![logo](ftp://a.com/logo.png)"), [{ type: "link", text: "logo", href: "ftp://a.com/logo.png" }]);
  assert.deepEqual(parseInline("![notes](/tmp/notes.txt)"), [{ type: "text", text: "![notes](/tmp/notes.txt)" }]);
  assert.deepEqual(parseInline("![board](/api/files/9)"), [{ type: "text", text: "![board](/api/files/9)" }]);
  assert.deepEqual(parseInline("![jira](/api/board/tasks/APP-1/files/10001)"), [{ type: "image", text: "jira", path: "/api/board/tasks/APP-1/files/10001" }]);
});

test("parseInline plays a local video inline and keeps a web video a link", () => {
  assert.deepEqual(parseInline("Cut: ![cut](/tmp/advert.mp4)"), [
    { type: "text", text: "Cut: " },
    { type: "video", text: "cut", path: "/tmp/advert.mp4" },
  ]);
  assert.deepEqual(parseInline("![](file:///tmp/a%20b.MOV)"), [{ type: "video", text: "a b.MOV", path: "/tmp/a b.MOV" }]);
  assert.deepEqual(parseInline("![clip](clips/run.webm) ![](/tmp/x.m4v)"), [
    { type: "video", text: "clip", path: "clips/run.webm" },
    { type: "text", text: " " },
    { type: "video", text: "x.m4v", path: "/tmp/x.m4v" },
  ]);
  assert.deepEqual(parseInline("![ad](https://a.com/ad.mp4)"), [{ type: "link", text: "ad", href: "https://a.com/ad.mp4" }]);
  assert.deepEqual(parseInline("![x](//host/x.mp4)"), [{ type: "text", text: "![x](//host/x.mp4)" }]);
  assert.deepEqual(parseInline("![x](/tmp/x.avi)"), [{ type: "text", text: "![x](/tmp/x.avi)" }]);
});

test("an exclamation mark right before a web link stays", () => {
  assert.deepEqual(parseInline("Done![PR](https://github.com/ThimoEder/x_bench/pull/26)"), [
    { type: "text", text: "Done!" },
    { type: "link", text: "PR", href: "https://github.com/ThimoEder/x_bench/pull/26" },
  ]);
});

test("a fence that has not closed yet is an open code block", () => {
  assert.deepEqual(parseMarkdown("Plan:\n```mermaid\nflowchart LR\n  A --> B"), [
    { type: "text", text: "Plan:" },
    { type: "code", lang: "mermaid", text: "flowchart LR\n  A --> B", open: true },
  ]);
  assert.deepEqual(parseMarkdown("```js\na\n```\nthen\n```mermaid\nA\n```"), [
    { type: "code", lang: "js", text: "a" },
    { type: "text", text: "then" },
    { type: "code", lang: "mermaid", text: "A" },
  ]);
  // Only a fence that starts a line opens a block, and one with nothing under it yet shows nothing.
  assert.deepEqual(parseMarkdown("wrap it in ``` fences"), [{ type: "text", text: "wrap it in ``` fences" }]);
  assert.deepEqual(parseMarkdown("Next:\n```merm"), [{ type: "text", text: "Next:" }]);
});

test("a longer fence wraps fences inside it", () => {
  const doc = "Here:\n````markdown\n# Steps\n```bash\nnpm test\n```\n````\nDone.";
  assert.deepEqual(parseMarkdown(doc), [
    { type: "text", text: "Here:" },
    { type: "code", lang: "markdown", text: "# Steps\n```bash\nnpm test\n```" },
    { type: "text", text: "Done." },
  ]);
  assert.deepEqual(parseMarkdown("````markdown\n```bash\nnpm test\n```\nmore"), [
    { type: "code", lang: "markdown", text: "```bash\nnpm test\n```\nmore", open: true },
  ]);
});

test("math in the four forms is an inline part", () => {
  assert.deepEqual(parseInline(String.raw`So \(1089\times9=9801\) and \(A=1\).`), [
    { type: "text", text: "So " },
    { type: "math", text: String.raw`1089\times9=9801`, display: false },
    { type: "text", text: " and " },
    { type: "math", text: "A=1", display: false },
    { type: "text", text: "." },
  ]);
  assert.deepEqual(parseInline(String.raw`Euler: $e^{i\pi}+1=0$, then $$x^2$$ and \[a+b\].`), [
    { type: "text", text: "Euler: " },
    { type: "math", text: String.raw`e^{i\pi}+1=0`, display: false },
    { type: "text", text: ", then " },
    { type: "math", text: "x^2", display: true },
    { type: "text", text: " and " },
    { type: "math", text: "a+b", display: true },
    { type: "text", text: "." },
  ]);
  assert.deepEqual(parseInline("the $n$-th, **$x$**, $a_1$ and $b_1$"), [
    { type: "text", text: "the " },
    { type: "math", text: "n", display: false },
    { type: "text", text: "-th, " },
    { type: "strong", text: "$x$" },
    { type: "text", text: ", " },
    { type: "math", text: "a_1", display: false },
    { type: "text", text: " and " },
    { type: "math", text: "b_1", display: false },
  ]);
});

test("dollar amounts, shell variables and escaped dollars stay text", () => {
  for (const text of ["It costs $5 and $10.", "From $5-$10 a seat.", "Set $HOME/$USER or $PATH:$HOME.", "A lone $ and $$ sign.", "Spaced $ x $ is not math."]) {
    assert.deepEqual(parseInline(text), [{ type: "text", text }], text);
  }
  assert.deepEqual(parseInline(String.raw`Pay \$5 or \$x\$.`), [{ type: "text", text: "Pay $5 or $x$." }]);
});

test("math inside a code span or a fence stays code", () => {
  assert.deepEqual(parseInline("Run `echo $x$` and `a $b` c$ d."), [
    { type: "text", text: "Run " },
    { type: "code", text: "echo $x$" },
    { type: "text", text: " and " },
    { type: "code", text: "a $b" },
    { type: "text", text: " c$ d." },
  ]);
  assert.deepEqual(parseMarkdown("```tex\n$$x^2$$\n```"), [{ type: "code", lang: "tex", text: "$$x^2$$" }]);
});

test("display math on its own lines is a block, even a line that looks like a list item", () => {
  assert.deepEqual(parseMarkdown("The sum:\n$$\na\n+ b\n$$\nand\n\\[\n1089 \\times 9 = 9801\n\\]\n\n$$ y $$"), [
    { type: "text", text: "The sum:" },
    { type: "math", text: "a\n+ b" },
    { type: "text", text: "and" },
    { type: "math", text: "1089 \\times 9 = 9801" },
    { type: "math", text: "y" },
  ]);
  // Still streaming: no closer yet, so the lines stay text.
  assert.deepEqual(parseMarkdown("Next:\n$$\nx^2"), [{ type: "text", text: "Next:\n$$\nx^2" }]);
  // A line with more after its closer is a paragraph with display math in it.
  assert.deepEqual(parseMarkdown("$$x$$ and $$y$$"), [{ type: "text", text: "$$x$$ and $$y$$" }]);
});

test("the thinking detail's text keeps everything but math as it is written", () => {
  assert.deepEqual(parseMathText("try `$a$` then **$b$** and \\(c\\), not $5 or $6"), [
    { type: "text", text: "try `$a$` then **" },
    { type: "math", text: "b", display: false },
    { type: "text", text: "** and " },
    { type: "math", text: "c", display: false },
    { type: "text", text: ", not $5 or $6" },
  ]);
  assert.deepEqual(parseMathText("no math"), [{ type: "text", text: "no math" }]);
  const fenced = "Run:\n```bash\necho $$\necho $$ $b$\n```\nthen $c$";
  assert.deepEqual(parseMathText(fenced), [
    { type: "text", text: "Run:\n```bash\necho $$\necho $$ $b$\n```\nthen " },
    { type: "math", text: "c", display: false },
  ]);
  const open = "Still streaming:\n```bash\necho $$ && echo $$";
  assert.deepEqual(parseMathText(open), [{ type: "text", text: open }]);
  assert.deepEqual(parseMathText("Drop a lone ``` line, then $x$\nand a ``` closer"), [
    { type: "text", text: "Drop a lone ``` line, then " },
    { type: "math", text: "x", display: false },
    { type: "text", text: "\nand a ``` closer" },
  ]);
});

test("file links, pictures and math in one line each keep their own part", () => {
  assert.deepEqual(parseInline(String.raw`See [a.ts](/r/a.ts:3), ![s](/tmp/s.png) and \(x^2\) for $5, then $y$.`), [
    { type: "text", text: "See " },
    { type: "file", text: "a.ts", path: "/r/a.ts", line: 3 },
    { type: "text", text: ", " },
    { type: "image", text: "s", path: "/tmp/s.png" },
    { type: "text", text: " and " },
    { type: "math", text: "x^2", display: false },
    { type: "text", text: " for $5, then " },
    { type: "math", text: "y", display: false },
    { type: "text", text: "." },
  ]);
});

test("a fence that never closes is code up to the end, math inside it too", () => {
  assert.deepEqual(parseMarkdown("Still streaming:\n```bash\necho $$ && echo $$"), [
    { type: "text", text: "Still streaming:" },
    { type: "code", lang: "bash", text: "echo $$ && echo $$", open: true },
  ]);
  // Backticks inside a line do not open a fence to the end.
  assert.deepEqual(parseMarkdown("use ``` inside a line"), [{ type: "text", text: "use ``` inside a line" }]);
});

test("a code span holds backticks shorter or longer than its own", () => {
  assert.deepEqual(parseInline("a lone ` ``` ` line and ``a`b`` and `n`, then ````"), [
    { type: "text", text: "a lone " },
    { type: "code", text: "```" },
    { type: "text", text: " line and " },
    { type: "code", text: "a`b" },
    { type: "text", text: " and " },
    { type: "code", text: "n" },
    { type: "text", text: ", then ````" },
  ]);
});

test("backticks inside lines do not pair up into a code block", () => {
  const prose = "It stops a lone removed ``` line.\n\nTreat opening and closing ``` lines as boundaries.";
  assert.deepEqual(parseMarkdown(prose), [
    { type: "text", text: "It stops a lone removed ``` line." },
    { type: "text", text: "Treat opening and closing ``` lines as boundaries." },
  ]);
  assert.deepEqual(parseMarkdown("```js\na ``` b\n```\nafter"), [
    { type: "code", lang: "js", text: "a ``` b" },
    { type: "text", text: "after" },
  ]);
  assert.deepEqual(parseMarkdown("See\r\n```js\r\nconst n = 1;\r\n```\r\nDone"), [
    { type: "text", text: "See" },
    { type: "code", lang: "js", text: "const n = 1;\r" },
    { type: "text", text: "Done" },
  ]);
  assert.deepEqual(parseMathText("Run:\r\n```bash\r\necho $$\r\n```\r\nthen $c$").at(-1), {
    type: "math",
    text: "c",
    display: false,
  });
  assert.deepEqual(parseMarkdown("- ```dart\n  a();\n  ```\n> ```go\n> b()\n> ```\nend"), [
    { type: "text", text: "-" },
    { type: "code", lang: "dart", text: "  a();" },
    { type: "quote", blocks: [{ type: "code", lang: "go", text: "b()" }] },
    { type: "text", text: "end" },
  ]);
  // A fence line with a language closes the block, so a stray closer after it cannot open one to the end.
  assert.deepEqual(parseMarkdown("```md\nA\n  ```text\nB\n  ```\nC\n```\nD"), [
    { type: "code", lang: "md", text: "A" },
    { type: "text", text: "text\nB" },
    { type: "code", lang: "", text: "C" },
    { type: "text", text: "D" },
  ]);
  assert.deepEqual(parseMarkdown("1. Run:\n   ```bash\n   npm test\n   ```"), [
    { type: "list", ordered: true, items: [{ text: "Run:" }] },
    { type: "code", lang: "bash", text: "   npm test" },
  ]);
  assert.deepEqual(parseMarkdown("- ```sh\n  a\n\n  b\nafter ``` x\n- next"), [
    { type: "text", text: "-" },
    { type: "code", lang: "sh", text: "  a\n\n  b" },
    { type: "text", text: "after ``` x" },
    { type: "list", ordered: false, items: [{ text: "next" }] },
  ]);
  assert.deepEqual(parseMarkdown("- ```sh\n  a"), [{ type: "text", text: "-" }, { type: "code", lang: "sh", text: "  a", open: true }]);
});
