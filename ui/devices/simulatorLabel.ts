// Labels for the simulator tools' rows in the transcript, named the way each harness spells an MCP tool
// (mcp__x_bench__simulator_tap, x_bench__simulator_tap, mcp.x_bench.simulator_tap).

import { fieldsOf, hostOf, short } from "../browser/browserLabel.ts";

const TOOL =
  /x_bench[_./:\s-]+simulator_(list_devices|boot|build_status|build|install|launch|screenshot|read_screen|tap|swipe|touch_path|type|press|open_url|app_log|appearance)\b/;

const BUTTONS: Record<string, string> = {
  side: "the side button",
  app_switch: "Recent apps",
  volume_up: "Volume up",
  volume_down: "Volume down",
  enter: "Return",
};

export function simulatorLabel(title: unknown, args: object | undefined): string | null {
  const match = TOOL.exec(String(title || ""));
  if (!match) return null;
  const field = fieldsOf(args);
  switch (match[1]) {
    case "list_devices":
      return "List devices";
    case "boot":
      return field("device") ? `Start ${short(field("device"))}` : "Start a device";
    case "build":
      return field("scheme") ? `Build ${short(field("scheme"))}` : "Build the app";
    case "build_status":
      return field("build_id") ? `Check build ${short(field("build_id"))}` : "Check the build";
    case "install": {
      const file = field("app_path").replace(/\/+$/, "").split("/").pop();
      return file ? `Install ${short(file)}` : "Install an app";
    }
    case "launch":
      return field("app_id") ? `Launch ${short(field("app_id"))}` : "Launch an app";
    case "screenshot":
      return "Take a screenshot";
    case "read_screen":
      return field("filter") === "interactive" ? "Read the screen's controls" : "Read the screen";
    case "tap": {
      const verb = Number(field("hold_seconds")) > 0 ? "Long-press" : "Tap";
      const where = place(field, "");
      return where ? `${verb} ${where}` : `${verb} the screen`;
    }
    case "swipe": {
      const from = place(field, "from_");
      const to = place(field, "to_");
      if (!field("from_ref") && !field("to_ref")) {
        const direction = directionOf(field);
        if (direction) return `Swipe ${direction}`;
      }
      return from && to ? `Swipe from ${from} to ${to}` : "Swipe on the screen";
    }
    case "touch_path": {
      const second: unknown = args ? Reflect.get(args, "points2") : undefined;
      return Array.isArray(second) && second.length ? "Pinch" : "Drag along a path";
    }
    case "type": {
      const into = field("ref") ? ` into ${field("ref")}` : "";
      const submit = field("submit") === "true" ? " and press Return" : "";
      return field("text") ? `Type "${short(field("text"))}"${into}${submit}` : `Type${into || " on the device"}${submit}`;
    }
    case "press": {
      const button = field("button");
      const verb = Number(field("hold_seconds")) > 0 ? "Hold" : "Press";
      if (!button) return `${verb} a button`;
      return `${verb} ${BUTTONS[button] ?? button.charAt(0).toUpperCase() + button.slice(1)}`;
    }
    case "open_url": {
      const url = field("url");
      if (!url) return "Open a link";
      return `Open ${/^https?:/i.test(url) ? hostOf(url) : short(url)}`;
    }
    case "app_log":
      return field("app_id") ? `Read ${short(field("app_id"))}'s log` : "Read the app's log";
    default:
      return field("mode") ? `Switch to ${field("mode")} mode` : "Switch light or dark mode";
  }
}

// A ref like e4, or x and y in points; prefix picks swipe's from_ or to_ fields.
function place(field: (name: string) => string, prefix: string): string {
  if (field(`${prefix}ref`)) return field(`${prefix}ref`);
  const x = field(`${prefix}x`);
  const y = field(`${prefix}y`);
  return x && y ? `(${Math.round(Number(x))}, ${Math.round(Number(y))})` : "";
}

// The finger's direction: a finger moving up scrolls the content down.
function directionOf(field: (name: string) => string): string | null {
  const values = ["from_x", "from_y", "to_x", "to_y"].map((name) => field(name));
  if (values.some((value) => value === "" || !Number.isFinite(Number(value)))) return null;
  const [fromX, fromY, toX, toY] = values.map(Number) as [number, number, number, number];
  const dx = toX - fromX;
  const dy = toY - fromY;
  if (!dx && !dy) return null;
  if (Math.abs(dy) >= Math.abs(dx)) return dy < 0 ? "up" : "down";
  return dx < 0 ? "left" : "right";
}
