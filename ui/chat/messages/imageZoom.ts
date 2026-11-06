const MIN_SCALE = 1;
const MAX_SCALE = 8;

export interface ZoomView {
  scale: number;
  x: number;
  y: number;
}

export function zoomAt(view: Partial<ZoomView> | null | undefined, px: number, py: number, deltaY: number): ZoomView {
  const given = view?.scale ?? 0;
  const scale = given > 0 ? given : 1;
  const x = view?.x || 0;
  const y = view?.y || 0;
  const next = clamp(scale * Math.exp(-deltaY * 0.0018), MIN_SCALE, MAX_SCALE);
  if (next === scale) return { scale, x, y };
  if (next === MIN_SCALE) return { scale: MIN_SCALE, x: 0, y: 0 };
  const ratio = next / scale;
  return {
    scale: next,
    x: px - (px - x) * ratio,
    y: py - (py - y) * ratio,
  };
}

export function wheelPixels(event: Pick<WheelEvent, "deltaY" | "deltaMode">): number {
  let delta = event.deltaY || 0;
  if (event.deltaMode === 1) delta *= 16;
  if (event.deltaMode === 2) delta *= 400;
  return delta;
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}
