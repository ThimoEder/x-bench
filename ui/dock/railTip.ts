import type { PaneRect } from "../browser/browserPane.ts";

type SendTip = (text: string | null, rect: PaneRect | null) => void;

const SHOW_DELAY = 400;
const HIDE_DELAY = 80;

let timer: ReturnType<typeof setTimeout> | undefined;
// While a label shows, the next icon's label follows at once, as native tooltips do.
let shown = false;

// The desktop app draws the rail's hover label in its own window, above the native Browser and Unity views.
export function railTipBridge(): SendTip | null {
  if (typeof window === "undefined") return null;
  const value: unknown = Reflect.get(window, "xBenchDesktop");
  const send: unknown = typeof value === "object" && value !== null ? Reflect.get(value, "railTip") : null;
  return typeof send === "function" ? (text, rect) => Reflect.apply(send, value, [text, rect]) : null;
}

export function showRailTip(send: SendTip, element: HTMLElement, text: string) {
  clearTimeout(timer);
  timer = setTimeout(
    () => {
      const box = element.getBoundingClientRect();
      shown = true;
      send(text, { x: box.left, y: box.top, width: box.width, height: box.height });
    },
    shown ? 0 : SHOW_DELAY,
  );
}

export function hideRailTip(send: SendTip, now = false) {
  clearTimeout(timer);
  const hide = () => {
    shown = false;
    send(null, null);
  };
  if (now) hide();
  else timer = setTimeout(hide, HIDE_DELAY);
}
