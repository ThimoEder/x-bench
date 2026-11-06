// The page's side of the browser pane. The Electron app draws the pane's web pages over the page, where the
// Browser tab reports its rectangle through the preload (desktop/preload.cjs). Its tabs come in the
// snapshot, and its buttons and links go to the host's /api/browser routes.

import { useEffect, type RefObject } from "react";
import { apiFetch } from "../launchToken.ts";

export interface PaneRect {
  x: number;
  y: number;
  width: number;
  height: number;
  radius?: number;
}

interface DesktopBridge {
  // owner is the chat whose current tab draws there.
  browserBounds(bounds: PaneRect | null, owner?: string): void;
  browserFreeze(): Promise<PanePicture | null>;
}

// A data URL of the shown tab, and the rectangle the view drew it in, in page pixels.
export interface PanePicture {
  src: string;
  x: number;
  y: number;
  width: number;
  height: number;
}

function isPicture(value: unknown): value is PanePicture {
  if (typeof value !== "object" || value === null) return false;
  const src: unknown = Reflect.get(value, "src");
  return typeof src === "string" && src.startsWith("data:image/") && ["x", "y", "width", "height"].every((key) => Number.isFinite(Reflect.get(value, key)));
}

let bridge: DesktopBridge | null | undefined;

export function desktopBridge(): DesktopBridge | null {
  if (bridge !== undefined) return bridge;
  if (typeof window === "undefined") return null;
  const value: unknown = Reflect.get(window, "xBenchDesktop");
  const send: unknown = typeof value === "object" && value !== null ? Reflect.get(value, "browserBounds") : null;
  const freeze: unknown = typeof value === "object" && value !== null ? Reflect.get(value, "browserFreeze") : null;
  bridge =
    typeof send === "function"
      ? {
        browserBounds: (bounds, owner) => Reflect.apply(send, value, [bounds, owner ?? null]),
        browserFreeze: async () => {
          const shot: unknown = typeof freeze === "function" ? await Reflect.apply(freeze, value, []) : null;
          return isPicture(shot) ? shot : null;
        },
      }
      : null;
  return bridge;
}

export async function paneCall(path: string, body: Record<string, unknown>): Promise<string> {
  try {
    const response = await apiFetch(path, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
    if (response.ok) return "";
    const data: unknown = await response.json().catch(() => null);
    const error = typeof data === "object" && data !== null ? Reflect.get(data, "error") : null;
    return typeof error === "string" && error ? error : "The browser did not answer";
  } catch {
    return "The browser did not answer";
  }
}

export function isWebUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return url.protocol === "http:" || url.protocol === "https:";
  } catch {
    return false;
  }
}

// The rectangle the pane may draw in: the element's box, unless the page puts something over it (a menu,
// a dialog, the lightbox), since the web page would cover it.
export function paneRect(element: HTMLElement): PaneRect | null {
  const box = paneBox(element);
  return box && !paneCovered(element, box) ? box : null;
}

function paneBox(element: HTMLElement): PaneRect | null {
  const box = element.getBoundingClientRect();
  if (box.width < 2 || box.height < 2) return null;
  const radius = Number.parseFloat(getComputedStyle(element).borderTopLeftRadius) || 0;
  return { x: box.left, y: box.top, width: box.width, height: box.height, radius };
}

function paneCovered(element: HTMLElement, box: PaneRect): boolean {
  const inset = 6;
  for (const fx of [0, 0.5, 1]) {
    for (const fy of [0, 0.5, 1]) {
      const top = document.elementFromPoint(box.x + inset + fx * (box.width - inset * 2), box.y + inset + fy * (box.height - inset * 2));
      if (!top || !element.contains(top)) return true;
    }
  }
  // A menu can overlap the pane between the sample points.
  for (const menu of document.querySelectorAll('[role="menu"]')) {
    const over = menu.getBoundingClientRect();
    if (!element.contains(menu) && over.right > box.x && over.left < box.x + box.width && over.bottom > box.y && over.top < box.y + box.height) return true;
  }
  return false;
}

export function sameRect(a: PaneRect | null, b: PaneRect | null): boolean {
  if (!a || !b) return a === b;
  return (["x", "y", "width", "height"] as const).every((key) => Math.round(a[key]) === Math.round(b[key]));
}

const STILL_LINGER = 150;

// While shown, the pane follows the slot every frame, through dock resizes, slides and window resizes,
// draws owner's current tab there, and hides while anything covers the slot.
export function usePaneBounds(slot: RefObject<HTMLElement | null>, owner: string, shown: boolean): void {
  useEffect(() => {
    const bridge = desktopBridge();
    if (!bridge) return undefined;
    if (!shown) {
      bridge.browserBounds(null);
      return undefined;
    }
    let sent: PaneRect | null = null;
    let frame = 0;
    let closed = false;
    let freezing = false;
    let covered = false;
    // pictured: the capture for the cover now over the pane is done. painted: the slot shows a picture.
    let pictured = false;
    let painted = false;
    // The picture stays a moment after the cover leaves, until the view shows again.
    let clearAt = 0;
    const follow = () => {
      const element = slot.current;
      const box = element ? paneBox(element) : null;
      covered = Boolean(element && box && paneCovered(element, box));
      if (covered) clearAt = 0;
      else {
        pictured = false;
        if (painted && element) {
          clearAt ||= performance.now() + STILL_LINGER;
          if (performance.now() >= clearAt) {
            paint(element, null);
            painted = false;
            clearAt = 0;
          }
        }
      }
      let next = covered ? null : box;
      // The view stays up until the picture is in, so the page never shows the slot blank.
      if (element && covered && sent && !pictured) {
        next = sent;
        if (!freezing) {
          freezing = true;
          void picture(bridge).then((shot) => {
            freezing = false;
            if (closed || !covered) return;
            paint(element, shot);
            painted = Boolean(shot);
            pictured = true;
          });
        }
      }
      if (!sameRect(next, sent)) {
        sent = next;
        bridge.browserBounds(next, owner);
      }
      frame = requestAnimationFrame(follow);
    };
    follow();
    return () => {
      closed = true;
      cancelAnimationFrame(frame);
      bridge.browserBounds(null);
      // eslint-disable-next-line react-hooks/exhaustive-deps -- the cleanup clears whichever element the slot holds by then
      if (slot.current) paint(slot.current, null);
    };
  }, [shown, owner, slot]);
}

// The shown tab's picture, decoded so it paints the moment the view hides. A capture that takes too long gives none.
async function picture(bridge: DesktopBridge): Promise<PanePicture | null> {
  const timeout = new Promise<null>((resolve) => {
    setTimeout(() => resolve(null), 800);
  });
  const shot = await Promise.race([bridge.browserFreeze().catch(() => null), timeout]);
  if (shot) {
    const image = new Image();
    image.src = shot.src;
    await image.decode().catch(() => {});
  }
  return shot;
}

// The picture fills the view's own rectangle, which may reach past the slot. Chromium paints the slot from its
// corner rounded to device pixels, so the offset counts from that rounded corner.
function paint(element: HTMLElement, shot: PanePicture | null) {
  if (!shot) {
    for (const name of ["--still", "--still-x", "--still-y", "--still-width", "--still-height"]) element.style.removeProperty(name);
    return;
  }
  const box = element.getBoundingClientRect();
  const ratio = window.devicePixelRatio || 1;
  const snap = (value: number) => Math.round(value * ratio) / ratio;
  element.style.setProperty("--still", `url("${shot.src}")`);
  element.style.setProperty("--still-x", `${shot.x - snap(box.left)}px`);
  element.style.setProperty("--still-y", `${shot.y - snap(box.top)}px`);
  element.style.setProperty("--still-width", `${shot.width}px`);
  element.style.setProperty("--still-height", `${shot.height}px`);
}
