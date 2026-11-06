import { after, afterEach, test } from "node:test";
import assert from "node:assert/strict";
import { act, createElement } from "react";
import type { MermaidConfig } from "mermaid";
import type { Root } from "react-dom/client";
import type { Outline } from "./diagram.ts";
import { click, installDom, wait } from "../../testing/dom.ts";

// react-dom checks for a DOM when it loads, so it comes in after installDom.
const dom = installDom();
const { createRoot } = await import("react-dom/client");
const { MarkdownView } = await import("./MarkdownView.tsx");
const { diagramConfig, drawnDiagram, naturalWidth, prettyText, repairFlowchart, scopePretty, setDiagramLoaders } = await import("./diagram.ts");

const mounted: Root[] = [];

afterEach(async () => {
  await act(async () => {
    for (const root of mounted.splice(0)) root.unmount();
  });
  document.body.replaceChildren();
  document.documentElement.dataset.theme = "dark";
  setDiagramLoaders(null);
});

after(async () => {
  await dom.happyDOM.abort();
  dom.close();
});

// Stand-ins for Mermaid and beautiful-mermaid that draw each diagram as a tagged svg and record what they did.
function fakes({
  parseError,
  parses,
  prettyFails = false,
  outlines = [null, null],
  converted,
  gate,
}: {
  parseError?: string;
  parses?: (text: string) => boolean;
  prettyFails?: boolean;
  outlines?: [Outline | null, Outline | null];
  converted?: (text: string) => string | null;
  // Mermaid finishes loading only once this settles.
  gate?: Promise<void>;
} = {}) {
  const calls = { loads: 0, prettyLoads: 0, configs: [] as MermaidConfig[], parsed: [] as string[], mermaid: [] as string[], pretty: [] as string[] };
  let config: MermaidConfig = {};
  setDiagramLoaders({
    mermaid: async () => {
      calls.loads += 1;
      await gate;
      return {
        initialize(next: MermaidConfig) {
          config = next;
          calls.configs.push(next);
        },
        async parse(text: string) {
          calls.parsed.push(text);
          if (parseError && !parses?.(text)) throw new Error(parseError);
          return {};
        },
        async render(_id: string, text: string) {
          calls.mermaid.push(text);
          return { svg: `<svg data-by="mermaid" data-dark="${String(config.darkMode)}"><text>${text.length}</text></svg>` };
        },
        outline: async () => outlines[0],
        flowchart: async (text: string) => (converted ? converted(text) : null),
      };
    },
    pretty: async () => {
      calls.prettyLoads += 1;
      return {
        render(text: string) {
          calls.pretty.push(text);
          if (prettyFails) throw new Error("not handled");
          return `<svg data-by="pretty"><text>${text.length}</text></svg>`;
        },
        outline: () => outlines[1],
      };
    },
    // happy-dom drops the inside of an <svg> when DOMPurify parses it; a browser keeps it (see svgSafety.test.ts).
    purify: async () => (svg: string) => svg,
  });
  return calls;
}

async function render(text: string) {
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  mounted.push(root);
  await act(async () => root.render(createElement(MarkdownView, { text })));
  return {
    container,
    update: (next: string) => act(async () => root.render(createElement(MarkdownView, { text: next }))),
  };
}

// Lets the lazy load and the draw settle.
async function settle() {
  await act(async () => {
    await wait(0);
    await wait(0);
  });
}

const DIAGRAM = "flowchart LR\n  A[Start] --> B[Done]";

test("a skill the harness reported shows as a chip where it is written, outside code", async () => {
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  mounted.push(root);
  const skills = [{ name: "review" }];
  await act(async () => root.render(createElement(MarkdownView, { text: "first **look**, then /review. Keep `/review` and /bro", skills })));
  assert.deepEqual([...container.querySelectorAll(".skill-chip")].map((chip) => chip.textContent), ["review"]);
  assert.equal(container.textContent, "first look, then review. Keep /review and /bro");
});

test("a picture on the web shows inline, and a link when it does not load", async () => {
  const { container } = await render("![Firefly](https://a.com/firefly.jpg)");
  const img = container.querySelector("img")!;
  assert.equal(img.getAttribute("src"), "https://a.com/firefly.jpg");
  await act(async () => img.dispatchEvent(new Event("error")));
  assert.equal(container.querySelector("img"), null);
  assert.equal(container.querySelector("a")?.getAttribute("href"), "https://a.com/firefly.jpg");
});

test("a quote shows as a blockquote with its Markdown rendered inside", async () => {
  const { container } = await render("> **Bugs**\n>\n> - item\n>   continued");
  const quote = container.querySelector("blockquote")!;
  assert.equal(quote.querySelector("strong")?.textContent, "Bugs");
  assert.equal(quote.querySelector("li")?.textContent, "item\ncontinued");
  assert.equal(container.textContent?.includes(">"), false);
});

test("a quote under a list item shows inside that item", async () => {
  const { container } = await render("- item\n  > detail");
  assert.equal(container.querySelector("li > blockquote")?.textContent, "detail");
});

test("a reply without a diagram never loads Mermaid", async () => {
  const calls = fakes();
  const { container } = await render("Here:\n```js\nconst n = 1;\n```\nand ```mermaid in a sentence.");
  await settle();
  assert.deepEqual([calls.loads, calls.prettyLoads], [0, 0]);
  assert.equal(container.querySelector("[data-testid=diagram]"), null);
  assert.equal(container.querySelector("pre code")?.textContent, "const n = 1;");
});

test("a mermaid block shows a shimmer while it streams and is drawn once it closes", async () => {
  const calls = fakes();
  const view = await render(`Plan:\n\`\`\`mermaid\n${DIAGRAM}`);
  await settle();
  assert.deepEqual([calls.loads, calls.prettyLoads], [0, 0], "a half-written block loads nothing");
  assert.ok(view.container.querySelector("[data-testid=diagram-pending]"));
  assert.equal(view.container.querySelector("pre"), null);

  // The toggle shows the code streamed so far, and goes back to the shimmer.
  const toggle = () => view.container.querySelector("[data-testid=diagram-toggle]") as Element;
  await act(async () => click(toggle()));
  assert.equal(view.container.querySelector("pre code")?.textContent, DIAGRAM);
  await act(async () => click(toggle()));
  assert.ok(view.container.querySelector("[data-testid=diagram-pending]"));

  await view.update(`Plan:\n\`\`\`mermaid\n${DIAGRAM}\n\`\`\`\nDone.`);
  await settle();
  assert.deepEqual(calls.parsed, [DIAGRAM], "Mermaid checks the block");
  assert.deepEqual(calls.pretty, [DIAGRAM], "beautiful-mermaid draws a flowchart");
  assert.deepEqual(calls.mermaid, []);
  assert.ok(view.container.querySelector("[data-testid=diagram] svg[data-by=pretty]"));
  assert.equal(view.container.querySelector("[data-testid=diagram-pending]"), null);
  assert.equal(view.container.querySelector("pre"), null);
  assert.ok(view.container.querySelector("[data-testid=copy-code]"), "the copy button stays");

  // More streamed text after the block does not draw it again.
  await view.update(`Plan:\n\`\`\`mermaid\n${DIAGRAM}\n\`\`\`\nDone. And more.`);
  await settle();
  assert.equal(calls.pretty.length, 1);
});

test("a closed block shows the shimmer until its diagram is drawn", async () => {
  let release = () => {};
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  fakes();
  setDiagramLoaders({
    pretty: async () => {
      await gate;
      return { render: () => '<svg data-by="pretty"></svg>', outline: () => null };
    },
    purify: async () => (svg: string) => svg,
  });
  const { container } = await render(`\`\`\`mermaid\n${DIAGRAM}\n\`\`\``);
  await settle();
  assert.ok(container.querySelector("[data-testid=diagram-pending]"));
  assert.equal(container.querySelector("pre"), null);
  release();
  await settle();
  assert.ok(container.querySelector("[data-testid=diagram] svg[data-by=pretty]"));
});

test("the toggle switches between the diagram and its code", async () => {
  fakes();
  const { container } = await render(`\`\`\`mermaid\n${DIAGRAM}\n\`\`\``);
  await settle();
  const toggle = () => container.querySelector("[data-testid=diagram-toggle]");
  assert.equal(toggle()?.getAttribute("aria-label"), "Show code");

  await act(async () => click(toggle() as Element));
  assert.equal(container.querySelector("[data-testid=diagram]"), null);
  assert.equal(container.querySelector("pre code")?.textContent, DIAGRAM);
  assert.equal(toggle()?.getAttribute("aria-label"), "Show diagram");

  await act(async () => click(toggle() as Element));
  assert.ok(container.querySelector("[data-testid=diagram] svg"));
});

test("a block Mermaid cannot parse shows its code and a short note", async () => {
  const calls = fakes({ parseError: "Parse error on line 2:\n...A[Start --> \n-----------^\nExpecting 'SQE'" });
  const { container } = await render("```mermaid\nflowchart LR\n  A[Start --> \n```");
  await settle();
  assert.deepEqual(calls.pretty, [], "beautiful-mermaid never sees a broken block");
  assert.equal(container.querySelector("[data-testid=diagram]"), null);
  assert.equal(container.querySelector("[data-testid=diagram-toggle]"), null);
  assert.equal(container.querySelector("pre code")?.textContent, "flowchart LR\n  A[Start --> ");
  assert.equal(container.querySelector("[data-testid=diagram-error]")?.textContent, "Couldn't draw this diagram: Parse error on line 2");
});

test("a flowchart label with brackets in it is quoted, so it draws", async () => {
  const written = "flowchart LR\n  subgraph host [Node host (server/)]\n    A --> B\n  end";
  const calls = fakes({ parseError: "Parse error on line 2", parses: (text) => !/\[Node host \(/.test(text) });
  const { container } = await render(`\`\`\`mermaid\n${written}\n\`\`\``);
  await settle();
  assert.deepEqual(calls.parsed, [written, 'flowchart LR\n  subgraph host ["Node host (server/)"]\n    A --> B\n  end']);
  assert.ok(container.querySelector("[data-testid=diagram] svg"));
  // The code behind the toggle is the block as the agent wrote it.
  await act(async () => click(container.querySelector("[data-testid=diagram-toggle]") as Element));
  assert.equal(container.querySelector("pre code")?.textContent, written);
});

test("repairFlowchart quotes labels with brackets, and nothing else", () => {
  assert.equal(repairFlowchart("flowchart LR\n  subgraph h [Host (server/)]\n  end"), 'flowchart LR\n  subgraph h ["Host (server/)"]\n  end');
  assert.equal(repairFlowchart("graph TD\n  A[Call f(x)] --> B{Ready (yet)?}\n  B -->|yes (1)| C"), 'graph TD\n  A["Call f(x)"] --> B{"Ready (yet)?"}\n  B -->|"yes (1)"| C');
  const kept = 'flowchart LR\n  A["Call f(x)"] --> B[(Database)]\n  B --> C{{Hex}}\n  C --> D[[Sub]]\n  D -->|plain| E[Plain]';
  assert.equal(repairFlowchart(kept), kept);
  assert.equal(repairFlowchart("sequenceDiagram\n  A->>B: f(x) [y]"), "sequenceDiagram\n  A->>B: f(x) [y]");
});

test("the real Mermaid falls back to code on a broken block", async () => {
  const { container } = await render("```mermaid\nflowchart LR\n  A[Start --> \n```");
  // The first import of Mermaid takes a moment.
  for (let i = 0; i < 100 && !container.querySelector("[data-testid=diagram-error]"); i++) {
    await act(async () => wait(50));
  }
  assert.match(container.querySelector("[data-testid=diagram-error]")?.textContent ?? "", /^Couldn't draw this diagram: Parse error on line \d+$/);
  assert.ok(container.querySelector("pre code"));
});

test("a kind beautiful-mermaid does not draw goes to Mermaid, and is drawn again in the other theme", async () => {
  const calls = fakes();
  const pie = 'pie title Pets\n  "Dogs" : 3\n  "Cats" : 2';
  const { container } = await render(`\`\`\`mermaid\n${pie}\n\`\`\``);
  await settle();
  assert.equal(calls.prettyLoads, 0);
  assert.equal(container.querySelector("[data-testid=diagram] svg")?.getAttribute("data-dark"), "true");

  await act(async () => {
    document.documentElement.dataset.theme = "light";
    await wait(0);
  });
  await settle();
  assert.equal(calls.configs.at(-1)?.darkMode, false);
  assert.equal(container.querySelector("[data-testid=diagram] svg")?.getAttribute("data-dark"), "false");
  assert.equal(container.querySelector("pre"), null, "the code never flashes up");
});

test("a C4 diagram is drawn by beautiful-mermaid as the flowchart it is told as", async () => {
  const c4 = 'C4Context\n  Person(u, "User")\n  System(s, "App")\n  Rel(u, s, "Uses")';
  const calls = fakes({ converted: (text) => (text === c4 ? 'flowchart TB\n  n0(["User"])\n  n1["App"]\n  n0 -->|"Uses"| n1' : null) });
  const { container } = await render(`\`\`\`mermaid\n${c4}\n\`\`\``);
  await settle();
  assert.deepEqual(calls.pretty, ['flowchart TB\n  n0(["User"])\n  n1["App"]\n  n0 -->|"Uses"| n1']);
  assert.deepEqual(calls.mermaid, []);
  assert.ok(container.querySelector("[data-testid=diagram] svg[data-by=pretty]"));
  // The code behind the toggle is still the C4 the agent wrote.
  await act(async () => click(container.querySelector("[data-testid=diagram-toggle]") as Element));
  assert.equal(container.querySelector("pre code")?.textContent, c4);
});

test("a beautiful-mermaid diagram follows the theme without being drawn again", async () => {
  const calls = fakes();
  const { container } = await render(`\`\`\`mermaid\n${DIAGRAM}\n\`\`\``);
  await settle();
  await act(async () => {
    document.documentElement.dataset.theme = "light";
    await wait(0);
  });
  await settle();
  assert.equal(calls.pretty.length, 1);
  assert.ok(container.querySelector("[data-testid=diagram] svg[data-by=pretty]"));
});

test("a diagram beautiful-mermaid cannot draw falls back to Mermaid", async () => {
  const calls = fakes({ prettyFails: true });
  const { container } = await render(`\`\`\`mermaid\n${DIAGRAM}\n\`\`\``);
  await settle();
  assert.deepEqual(calls.mermaid, [DIAGRAM]);
  assert.ok(container.querySelector("[data-testid=diagram] svg[data-by=mermaid]"));
});

test("a flowchart beautiful-mermaid reads differently from Mermaid goes to Mermaid", async () => {
  const calls = fakes({ outlines: [{ nodes: ["A", "B", "C"], edges: 2 }, { nodes: ["A", "B"], edges: 1 }] });
  const { container } = await render("```mermaid\nflowchart LR\n  A --> B\n  A --o C\n```");
  await settle();
  assert.deepEqual(calls.pretty, []);
  assert.ok(container.querySelector("[data-testid=diagram] svg[data-by=mermaid]"));
});

test("diagram text cannot loosen Mermaid's security", () => {
  const config = diagramConfig("dark");
  assert.equal(config.securityLevel, "strict");
  assert.equal(config.htmlLabels, false);
  assert.equal(config.startOnLoad, false);
  // Keys in secure are ignored in %%{init}%% directives and front matter.
  for (const key of ["securityLevel", "htmlLabels", "dompurifyConfig", "theme", "themeVariables", "themeCSS", "darkMode"]) {
    assert.ok(config.secure?.includes(key), key);
  }
});

test("two blocks with the same diagram draw it once", async () => {
  const calls = fakes();
  const { container } = await render(`\`\`\`mermaid\n${DIAGRAM}\n\`\`\`\n\nAgain:\n\n\`\`\`mermaid\n${DIAGRAM}\n\`\`\``);
  await settle();
  assert.equal(container.querySelectorAll("[data-testid=diagram] svg").length, 2);
  assert.equal(calls.pretty.length, 1);
});

test("a Mermaid diagram keeps its own width instead of shrinking to its box", () => {
  const svg = '<svg id="d1" width="100%" xmlns="http://www.w3.org/2000/svg" style="max-width: 812.5px;" viewBox="0 0 812.5 90"><rect width="100%"/></svg>';
  assert.equal(naturalWidth(svg), '<svg id="d1" width="812.5" xmlns="http://www.w3.org/2000/svg" style="max-width: 812.5px;" viewBox="0 0 812.5 90"><rect width="100%"/></svg>');
  assert.equal(naturalWidth('<svg width="100%"><g/></svg>'), '<svg width="100%"><g/></svg>');
});

test("beautiful-mermaid draws flowchart, sequence, state, class, ER and xychart; Mermaid the rest", () => {
  assert.equal(prettyText("flowchart LR\n  A --> B"), "flowchart LR\n  A --> B");
  assert.equal(prettyText("graph TD;\n  A --> B"), "graph TD\n  A --> B");
  assert.equal(prettyText("flowchart\n  A --> B"), "flowchart TD\n  A --> B", "Mermaid's default direction");
  assert.equal(prettyText('flowchart LR\n  accTitle: Flow\n  accDescr {\n    Two steps\n  }\n  A --> B\n  click A "https://example.com"'), "flowchart LR\n  A --> B");
  assert.equal(prettyText("---\ntitle: Flow\n---\n%%{init: {'theme': 'forest'}}%%\nsequenceDiagram\n  A->>B: hi"), "sequenceDiagram\n  A->>B: hi");
  assert.equal(prettyText("sequenceDiagram\n    actor User\n    User->>UI: hi"), "sequenceDiagram\n    participant User\n    User->>UI: hi", "an actor is a box");
  for (const header of ["stateDiagram-v2", "stateDiagram", "classDiagram", "erDiagram", "xychart-beta", "xychart"]) {
    assert.ok(prettyText(`${header}\n  x`), header);
  }
  for (const header of ["pie", "gantt", "mindmap", "gitGraph", "C4Context", "timeline", "journey", "flowchart-elk TD"]) {
    assert.equal(prettyText(`${header}\n  x`), null, header);
  }
});

test("a beautiful-mermaid svg keeps to itself on the page", () => {
  const svg = [
    '<svg xmlns="http://www.w3.org/2000/svg" width="10" style="--bg:var(--sidebar)">',
    "<style>",
    "  @import url('https://fonts.googleapis.com/css2?family=Inter&amp;display=swap');",
    "  text { font-family: 'Inter', system-ui, sans-serif; }",
    "  svg {",
    "    --_text: var(--fg);",
    "  }",
    "</style>",
    '<defs><marker id="arrowhead"><polygon points="0 0" /></marker></defs>',
    '<g class="node" data-id="arrowhead"><polyline marker-end="url(#arrowhead)" /></g>',
    "</svg>",
  ].join("\n");
  const scoped = scopePretty(svg, "x-1");
  assert.doesNotMatch(scoped, /@import|googleapis/);
  assert.match(scoped, /^<svg id="x-1" /);
  assert.match(scoped, /#x-1 text \{ font-family: inherit; \}/);
  assert.match(scoped, /#x-1 \{\n\s*--_text: var\(--fg\);/);
  assert.doesNotMatch(scoped, /(^|\n)\s*(svg|text) \{/);
  assert.match(scoped, /<marker id="x-1-arrowhead">/);
  assert.match(scoped, /marker-end="url\(#x-1-arrowhead\)"/);
  assert.match(scoped, /data-id="arrowhead"/, "node data stays as it was");
});

test("a diagram's colours cannot make the page fetch from outside", async () => {
  // DOMPurify is left out in happy-dom (see the fakes); keepToItself, which removes the addresses, is real.
  setDiagramLoaders({ purify: async () => (svg: string) => svg });
  // Mermaid's flowchart parser refuses url() in style lines, but state and class diagrams take it, and
  // beautiful-mermaid writes it into the fill.
  const blocks = [
    "stateDiagram-v2\n  [*] --> A\n  A --> B\n  classDef bad fill:url(https://evil.example/s.png),stroke:url(//evil.example/t.png)\n  class A bad",
    "classDiagram\n  class Animal\n  class Dog\n  Animal <|-- Dog\n  style Animal fill:url(https://evil.example/c.png)",
  ];
  const { container } = await render(blocks.map((block) => `\`\`\`mermaid\n${block}\n\`\`\``).join("\n\n"));
  for (let i = 0; i < 100 && container.querySelectorAll("[data-testid=diagram], [data-testid=diagram-error]").length < blocks.length; i++) {
    await act(async () => wait(50));
  }
  for (const block of blocks) {
    const drawnSvg = drawnDiagram(block, "dark");
    assert.ok(drawnSvg && "svg" in drawnSvg, `${block.split("\n")[0]}: ${drawnSvg && "error" in drawnSvg ? drawnSvg.error : "not drawn"}`);
    assert.match(drawnSvg.svg, /<svg/);
    assert.doesNotMatch(drawnSvg.svg, /url\(\s*['"]?\s*(?:https?:)?\/\/|@import/i, block.split("\n")[0]);
  }
});

test("a Mermaid diagram keeps the colours of the theme it was asked for, even if the theme changes before it is drawn", async () => {
  let release = () => {};
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const calls = fakes({ gate });
  const root = document.documentElement;
  root.style.setProperty("--text", "#eeeeee");
  const pie = 'pie\n  "Model" : 62\n  "Tools" : 24';
  const { container } = await render(`\`\`\`mermaid\n${pie}\n\`\`\``);
  await settle();
  // The page turns light while Mermaid is still loading.
  await act(async () => {
    root.dataset.theme = "light";
    root.style.setProperty("--text", "#111111");
    await wait(0);
  });
  release();
  await settle();
  root.style.removeProperty("--text");
  const dark = calls.configs.find((config) => config.darkMode === true);
  assert.equal(dark?.themeVariables?.textColor, "#eeeeee", "the dark diagram is drawn with the dark palette");
  const light = calls.configs.find((config) => config.darkMode === false);
  assert.equal(light?.themeVariables?.textColor, "#111111");
  assert.equal(container.querySelector("[data-testid=diagram] svg")?.getAttribute("data-dark"), "false");
});

const DIAGRAM_WITH_HTML ='flowchart LR\n  A["<img src=x onerror=alert(1)>"] --> B[Done]\n  click A "javascript:alert(2)"';

test("the real libraries draw a flowchart with its labels as text only", async () => {
  // happy-dom drops the root <svg> inside DOMPurify (a real browser keeps it), so this runs without it.
  setDiagramLoaders({ purify: async () => (svg: string) => svg });
  const { container } = await render(`\`\`\`mermaid\n${DIAGRAM_WITH_HTML}\n\`\`\``);
  for (let i = 0; i < 100 && !container.querySelector("[data-testid=diagram], [data-testid=diagram-error]"); i++) {
    await act(async () => wait(50));
  }
  const svg = container.querySelector("[data-testid=diagram] svg");
  assert.ok(svg, container.querySelector("[data-testid=diagram-error]")?.textContent ?? "not drawn");
  // happy-dom leaves svg <text> out of the page, so the drawn markup is checked as it was drawn.
  const drawnSvg = drawnDiagram(DIAGRAM_WITH_HTML, "dark");
  assert.ok(drawnSvg && "svg" in drawnSvg);
  const html = drawnSvg.svg;
  assert.equal(svg.querySelector("img"), null);
  assert.ok(svg.id);
  assert.match(html, new RegExp(`^<svg[^>]*\\sid="${svg.id}"`));
  assert.doesNotMatch(html, /onerror="|javascript:|googleapis|<script/i);
  // The label is text, and the click line is not drawn as a node of its own.
  assert.deepEqual([...html.matchAll(/<text[^>]*>([^<]*)<\/text>/g)].map((match) => match[1]), ["&lt;img src=x onerror=alert(1)&gt;", "Done"]);
  assert.match(html, new RegExp(`#${svg.id} text \\{ font-family: inherit; \\}`));
});

test("a local video plays inline, and shows its name without a source or once it fails", async () => {
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  mounted.push(root);
  const text = "Cut: ![advert](/tmp/advert.mp4)";
  await act(async () => root.render(createElement(MarkdownView, { text, videoSrc: (file: string) => `/api/file/video?path=${file}` })));
  const video = container.querySelector("video.md-video") as HTMLVideoElement;
  assert.equal(video.getAttribute("src"), "/api/file/video?path=/tmp/advert.mp4");
  assert.equal(video.hasAttribute("controls"), true);
  assert.equal(video.getAttribute("preload"), "metadata");
  await act(async () => video.dispatchEvent(new Event("error")));
  assert.equal(container.querySelector("video"), null);
  assert.equal(container.querySelector(".md-file")?.textContent, "advert");

  await act(async () => root.render(createElement(MarkdownView, { text: "![advert](/tmp/other.mp4)" })));
  assert.equal(container.querySelector("video"), null);
  assert.equal(container.querySelector(".md-file")?.getAttribute("title"), "/tmp/other.mp4");
});

test("a nested list sits inside its item, and an ordered list keeps its first number", async () => {
  const { container } = await render("6. Order of work:\n\n1. Parser\n   - `pushText`\n\n   Then the view.\n2. View\n7. Ship");
  const top = container.querySelector(":scope > div > ol") as HTMLOListElement;
  assert.equal(top.getAttribute("start"), "6");
  assert.equal(top.children.length, 2);
  const inner = top.querySelector(":scope > li > ol") as HTMLOListElement;
  assert.equal(inner.hasAttribute("start"), false);
  assert.deepEqual([...inner.children].map((li) => li.firstChild?.textContent), ["Parser", "View"]);
  assert.equal(inner.querySelector(":scope > li > ul > li > code")?.textContent, "pushText");
  assert.equal(inner.querySelector(":scope > li > p")?.textContent, "Then the view.");
  assert.equal(top.lastElementChild?.textContent, "Ship");
});
