import { useLayoutEffect } from "react";
import type { PointerEvent as ReactPointerEvent, RefObject } from "react";

// A springy thumb under the picked button of a switch or rail: it slides with an overshoot,
// swells while pressed (CSS), and squishes along its axis when it lands somewhere new.
// The track holds its buttons and one [data-thumb] element, and is the buttons' offset parent.

export type Axis = "x" | "y";

const SQUISH: Record<Axis, Keyframe[]> = {
  x: [{ scale: "1 1" }, { scale: "1.34 0.84", offset: 0.3 }, { scale: "0.95 1.05", offset: 0.66 }, { scale: "1 1" }],
  y: [{ scale: "1 1" }, { scale: "0.84 1.34", offset: 0.3 }, { scale: "1.05 0.95", offset: 0.66 }, { scale: "1 1" }],
};

const landed = new WeakMap<HTMLElement, number>();

const offset = (button: HTMLElement, axis: Axis) => (axis === "x" ? button.offsetLeft : button.offsetTop);

function reduced() {
  return Boolean(window.matchMedia?.("(prefers-reduced-motion: reduce)").matches);
}

function place(thumb: HTMLElement, button: HTMLElement, axis: Axis) {
  const at = offset(button, axis);
  const before = landed.get(thumb);
  landed.set(thumb, at);
  // A new thumb has no place to slide from, so it lands without its transition.
  if (before === undefined) thumb.style.transition = "none";
  thumb.style.setProperty("--x", `${button.offsetLeft}px`);
  thumb.style.setProperty("--y", `${button.offsetTop}px`);
  thumb.style.width = `${button.offsetWidth}px`;
  thumb.style.height = `${button.offsetHeight}px`;
  if (before === undefined) {
    void thumb.offsetWidth;
    thumb.style.transition = "";
  }
  if (before !== undefined && Math.abs(before - at) > 1 && !reduced()) thumb.animate?.(SQUISH[axis], { duration: 600, easing: "ease-out" });
}

// Index of the stop nearest to at.
export function nearestStop(stops: number[], at: number): number {
  return stops.reduce((best, stop, index) => (Math.abs(stop - at) < Math.abs(stops[best]! - at) ? index : best), 0);
}

// Places the thumb over the button that matches picked, hidden while shown is false or nothing matches.
export function useThumb(track: RefObject<HTMLElement | null>, axis: Axis, picked: string | null, shown = true) {
  useLayoutEffect(() => {
    const thumb = track.current?.querySelector<HTMLElement>("[data-thumb]");
    // A render mid-drag leaves the thumb under the pointer.
    if (!thumb || thumb.classList.contains("is-dragging")) return;
    const button = picked ? track.current?.querySelector<HTMLElement>(picked) : null;
    thumb.dataset.thumb = button && shown ? "on" : "off";
    if (button) place(thumb, button, axis);
  });
}

// Drag the thumb across the buttons; on release it lands on the nearest one and picks it.
export function slideThumb(event: ReactPointerEvent<HTMLElement>, axis: Axis, buttons: string, onPick: (button: HTMLElement) => void) {
  const track = event.currentTarget;
  const thumb = track.querySelector<HTMLElement>("[data-thumb]");
  if (event.button !== 0 || !thumb) return;
  const box = thumb.getBoundingClientRect();
  if (event.clientX < box.left || event.clientX > box.right || event.clientY < box.top || event.clientY > box.bottom) return;
  const stops = [...track.querySelectorAll<HTMLElement>(buttons)];
  if (!stops.length) return;
  const at = (ev: PointerEvent | ReactPointerEvent) => (axis === "x" ? ev.clientX : ev.clientY);
  const across = (ev: PointerEvent | ReactPointerEvent) => (axis === "x" ? ev.clientY : ev.clientX);
  const start = at(event);
  const crossStart = across(event);
  const base = landed.get(thumb) ?? 0;
  const lo = Math.min(...stops.map((stop) => offset(stop, axis)));
  const hi = Math.max(...stops.map((stop) => offset(stop, axis)));
  let moved = false;
  let last = start;
  let pos = base;
  let calm: ReturnType<typeof setTimeout> | undefined;
  const move = (ev: PointerEvent) => {
    const now = at(ev);
    if (!moved && (Math.abs(now - start) < 4 || Math.abs(across(ev) - crossStart) > Math.abs(now - start))) return;
    moved = true;
    thumb.classList.add("is-dragging");
    pos = Math.min(hi, Math.max(lo, base + now - start));
    thumb.style.setProperty(`--${axis}`, `${pos}px`);
    thumb.style.setProperty("--stretch", Math.min(Math.abs(now - last) / 50, 0.28).toFixed(3));
    last = now;
    clearTimeout(calm);
    calm = setTimeout(() => thumb.style.setProperty("--stretch", "0"), 90);
  };
  const up = () => {
    window.removeEventListener("pointermove", move);
    window.removeEventListener("pointerup", up);
    window.removeEventListener("pointercancel", up);
    clearTimeout(calm);
    thumb.classList.remove("is-dragging");
    thumb.style.setProperty("--stretch", "0");
    if (!moved) return;
    // The release also clicks the button under it, which must not pick that one instead.
    const swallow = (click: MouseEvent) => click.stopPropagation();
    track.addEventListener("click", swallow, { capture: true, once: true });
    setTimeout(() => track.removeEventListener("click", swallow, true), 0);
    const near = stops[nearestStop(stops.map((stop) => offset(stop, axis)), pos)]!;
    landed.set(thumb, pos);
    place(thumb, near, axis);
    onPick(near);
  };
  window.addEventListener("pointermove", move);
  window.addEventListener("pointerup", up);
  window.addEventListener("pointercancel", up);
}
