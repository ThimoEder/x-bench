import { after, test } from "node:test";
import assert from "node:assert/strict";
import { installDom } from "../../testing/dom.ts";

const dom = installDom();
const { cleanCss, fetches, keepToItself } = await import("./svgSafety.ts");

after(async () => {
  await dom.happyDOM.abort();
  dom.close();
});

const SVG = 'xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink"';

test("paint that points outside the page is dropped, from attributes and from style", () => {
  // What beautiful-mermaid makes of `style A fill:url(…)` and `linkStyle 0 stroke:url(…)`.
  const kept = keepToItself(
    `<svg ${SVG}><rect fill="url(https://evil.example/fill.png)" stroke="#f00"/><polyline stroke="url('https://evil.example/line.png')" stroke-width="2"/><text fill="URL(https://evil.example/text.png)">A</text><g style="fill: url(https://evil.example/g.png); opacity: 0.5"/></svg>`,
  );
  assert.ok(kept);
  assert.doesNotMatch(kept, /evil\.example/);
  assert.match(kept, /stroke="#f00"/);
  assert.match(kept, /stroke-width="2"/);
  assert.match(kept, /<text>A<\/text>/);
});

test("a <style> block cannot import or fetch, but keeps its other rules", () => {
  // What Mermaid makes of `classDef hot fill:url(…)`, plus beautiful-mermaid's own font import.
  const kept = keepToItself(
    `<svg ${SVG}><style>@import url('https://fonts.example/css'); #d .hot > * { fill: url(https://evil.example/c.png) !important; } #d .node rect { fill: #eee; }</style><g/></svg>`,
  );
  assert.ok(kept);
  // The fetching functions are renamed to one the browser does not know, which drops the declaration.
  assert.doesNotMatch(kept, /url\(|@import/i);
  assert.match(kept, /x-blocked\(https:\/\/evil\.example\/c\.png\)/);
  assert.match(kept, /#d \.node rect \{ fill: #eee; \}/);
  assert.equal(cleanCss(".a { fill: url(#grad) }"), ".a { fill: url(#grad) }", "a reference inside the diagram stays");
});

test("escapes and comments do not hide a fetch", () => {
  for (const css of [String.raw`fill: u\72 l(https://evil.example/a.png)`, String.raw`fill: \75\72\6c(https://evil.example/b.png)`, "fill: url/**/(https://evil.example/c.png)", "background: image-set('https://evil.example/d.png' 1x)", "@IMPORT 'https://evil.example/e.css';"]) {
    // url/**/( is no function to the browser, but it is blocked all the same: better too much than too little.
    assert.equal(fetches(css), true, css);
  }
  const kept = keepToItself(`<svg ${SVG}><rect fill="u\\72 l(https://evil.example/a.png)"/></svg>`);
  assert.doesNotMatch(kept ?? "", /evil\.example/);
});

test("only links inside the diagram stay", () => {
  const kept = keepToItself(
    `<svg ${SVG}><defs><marker id="m"/></defs><use href="#m"/><use xlink:href="https://evil.example/sprite.svg#x"/><image href="https://evil.example/i.png"/><a href="javascript:alert(1)"><text>a</text></a><polyline marker-end="url(#m)"/><g data-id="https://example.com/not-a-link"/></svg>`,
  );
  assert.ok(kept);
  assert.doesNotMatch(kept, /evil\.example|javascript:/);
  assert.match(kept, /<use href="#m"\/>/);
  assert.match(kept, /marker-end="url\(#m\)"/);
  assert.match(kept, /data-id="https:\/\/example\.com\/not-a-link"/, "data attributes are not addresses");
});

test("scripts, handlers, embedded HTML media and animations that could set an address go", () => {
  const kept = keepToItself(
    `<svg ${SVG} onload="alert(1)"><script>alert(2)</script><foreignObject><div xmlns="http://www.w3.org/1999/xhtml"><img src="https://evil.example/f.png"/>label</div></foreignObject><a href="#x"><set attributeName="href" to="https://evil.example/s"/><animate attributeName="href" values="https://evil.example/t"/></a></svg>`,
  );
  assert.ok(kept);
  assert.doesNotMatch(kept, /alert|evil\.example|<img|<set|<animate|onload/);
  assert.match(kept, /label/);
});

test("markup that is not SVG, or not well-formed, is refused", () => {
  assert.equal(keepToItself("<svg><g></svg>"), null);
  assert.equal(keepToItself("<div>not a diagram</div>"), null);
  // innerHTML writes a no-break space as &nbsp;, which XML does not know by name.
  // A browser writes it back as the character itself, happy-dom as &nbsp;; either is fine in the page.
  assert.match(keepToItself(`<svg ${SVG}><text>a&nbsp;b</text></svg>`) ?? "", /a(?: |&nbsp;|&#160;)b/);
});
