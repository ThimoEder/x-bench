// Labels for the browser tools' rows in the transcript, from the tool's title and its arguments (the
// row's args). Harnesses name an MCP tool after its server (mcp__x_bench__browser_click,
// x_bench.browser_click), and other servers have browser_* tools too.

const TOOL = /x_bench[_./:\s-]+browser_(navigate|read_page|find|click|type|form_input|press_key|hover|drag|scroll_to|scroll|wait|screenshot|console|network|evaluate|resize|tabs)\b/;

export function browserLabel(title: unknown, args: object | undefined): string | null {
  const match = TOOL.exec(String(title || ""));
  if (!match) return null;
  const field = fieldsOf(args);
  switch (match[1]) {
    case "navigate": {
      const url = field("url");
      if (url === "back" || url === "forward") return `Go ${url} in the browser`;
      if (url === "reload") return "Reload the page";
      return url ? `Open ${hostOf(url)}` : "Open a page";
    }
    case "read_page":
      return field("mode") === "text" ? "Read the page's text" : "Read the page";
    case "find":
      return field("query") ? `Find "${short(field("query"))}" on the page` : "Find on the page";
    case "click": {
      const clicks = field("clicks");
      if (clicks === "3") return "Triple-click on the page";
      if (clicks === "2") return "Double-click on the page";
      return field("button") === "right" ? "Right-click on the page" : "Click on the page";
    }
    case "form_input":
      return field("value") ? `Set a field to "${short(field("value"))}"` : "Set a form field";
    case "hover":
      return "Hover on the page";
    case "drag":
      return "Drag on the page";
    case "scroll_to":
      return "Scroll to an element";
    case "wait":
      return field("text") ? `Wait for "${short(field("text"))}"` : "Wait";
    case "console":
      return field("only_errors") === "true" ? "Read console errors" : "Read the console";
    case "network":
      return field("request_id") ? "Read a response" : "Read network requests";
    case "evaluate":
      return "Run JavaScript on the page";
    case "resize": {
      const size = field("preset") || (field("width") ? `${field("width")}×${field("height") || "…"}` : "");
      const scheme = field("color_scheme");
      return ["View", size && `at ${size}`, scheme && scheme !== "auto" && `in ${scheme} mode`].filter(Boolean).join(" ") || "Change the viewport";
    }
    case "type":
      return field("text") ? `Type "${short(field("text"))}"` : "Type on the page";
    case "press_key":
      return field("keys") ? `Press ${short(field("keys"))}` : "Press keys";
    case "scroll":
      return `Scroll ${field("direction") || "the page"}`;
    case "screenshot":
      return "Take a screenshot";
    default: {
      const action = field("action");
      if (action === "switch" || action === "close") return `${action === "switch" ? "Switch to" : "Close"} tab ${field("tab")}`;
      return "List browser tabs";
    }
  }
}

// Reads one of a tool's arguments as text, or "" when it is missing or not a plain value.
export function fieldsOf(args: object | undefined): (name: string) => string {
  return (name) => {
    const value = args ? Reflect.get(args, name) : undefined;
    return typeof value === "string" || typeof value === "number" || typeof value === "boolean" ? String(value) : "";
  };
}

export function hostOf(url: string): string {
  try {
    return new URL(/^[a-z][a-z0-9+.-]*:\/\//i.test(url) ? url : `https://${url}`).host || url;
  } catch {
    return url;
  }
}

export function short(text: string): string {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length > 40 ? `${flat.slice(0, 40)}…` : flat;
}
