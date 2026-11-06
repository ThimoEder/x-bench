// A drawn diagram goes into the page as markup, and its text came from an agent or a Markdown file. Neither
// library keeps it from pointing outside the page: a `style` or `classDef` value like
// `fill:url(https://…)` ends up in an attribute or a <style> rule, and the browser fetches it when the diagram
// shows. keepToItself removes every such reference before the markup is inserted, whichever library drew it.
// It works on the SVG as XML, so what it checks is the tree the browser will build, not a guess from text.

const XLINK = "http://www.w3.org/1999/xlink";

// Elements that load or run something, carry HTML into the drawing, or (the animation elements) could set
// an address at run time. Neither library draws with them.
const DROP = new Set([
  "script", "iframe", "object", "embed", "img", "audio", "video", "source", "track", "link", "meta", "base", "form", "input",
  "button", "textarea", "select", "portal", "frame", "frameset", "applet",
  "set", "animate", "animatemotion", "animatetransform", "animatecolor", "discard", "handler", "listener",
]);

// Attributes whose value is an address. Only a reference inside the diagram (#id) stays.
const ADDRESS = new Set(["href", "src", "srcset", "action", "formaction", "poster", "background", "data", "codebase", "cite", "ping", "longdesc", "lowsrc", "dynsrc"]);

// CSS functions that fetch: url() other than url(#…), the image functions, and src().
const FETCHING = /(?<![\w-])((?:-webkit-)?image-set|url|image|cross-fade|element|src)\s*\((?!\s*['"]?\s*#)/gi;

// The SVG as it should go into the page, or null when it cannot be read as SVG (and so cannot be checked).
export function keepToItself(svg: string): string | null {
  // innerHTML writes a no-break space as &nbsp;, which XML does not know.
  const doc = new DOMParser().parseFromString(svg.replace(/&nbsp;/g, "&#160;"), "image/svg+xml");
  const root = doc.documentElement;
  if (!root || root.localName !== "svg" || doc.getElementsByTagName("parsererror").length) return null;
  for (const element of [root, ...root.querySelectorAll("*")]) {
    const name = element.localName.toLowerCase();
    if (DROP.has(name)) {
      element.remove();
      continue;
    }
    if (name === "style") element.textContent = cleanCss(element.textContent ?? "");
    for (const attr of [...element.attributes]) {
      const local = attr.localName.toLowerCase();
      const address = ADDRESS.has(local) || attr.namespaceURI === XLINK;
      if (local.startsWith("on") || (address && !attr.value.trim().startsWith("#")) || fetches(attr.value)) {
        element.removeAttributeNode(attr);
      }
    }
  }
  return new XMLSerializer().serializeToString(root);
}

// Whether a CSS value (an attribute, or a rule) would fetch something, escapes and comments decoded first,
// since `u\72 l(` and `url(` are the same function to the browser.
export function fetches(css: string): boolean {
  const plain = readable(css);
  FETCHING.lastIndex = 0;
  return FETCHING.test(plain) || /@import/i.test(plain);
}

// A <style> block with every fetching function renamed to one the browser does not know, which drops that
// declaration, and every @import turned into an at-rule it ignores. A block that fetches nothing is left
// as it was.
export function cleanCss(css: string): string {
  if (!fetches(css)) return css;
  return readable(css).replace(FETCHING, "x-blocked(").replace(/@import/gi, "@x-blocked");
}

function readable(css: string): string {
  return css.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\\([0-9a-fA-F]{1,6})\s?|\\([^\n0-9a-fA-F])/g, (_all, hex: string | undefined, char: string | undefined) => {
    if (char != null) return char;
    const code = parseInt(hex ?? "", 16);
    return code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : "�";
  });
}
