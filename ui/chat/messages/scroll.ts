import type { PresentedItem } from "../../../server/present.ts";

// Stay pinned while text arrives. A scroll event can land after that growth, with
// scrollTop still at the old bottom, and must not be read as the user leaving.
export const STICK_GAP = 80;

export interface FollowState {
  stick: boolean;
  lastTop: number;
}

// gap is the distance left to the bottom. pinning marks a scroll the page made itself.
export interface FollowEvent {
  pinning: boolean;
  scrollTop: number;
  gap: number;
}

export function followScroll(state: FollowState, event: FollowEvent): FollowState {
  const scrolledUp = state.lastTop - event.scrollTop > 1;
  const next = { stick: state.stick, lastTop: event.scrollTop };
  if (event.pinning) return next;
  if (scrolledUp) next.stick = event.gap < STICK_GAP;
  else if (event.gap < STICK_GAP) next.stick = true;
  return next;
}

// Changes when the transcript gains an item or its last item grows, so the list can tell the reader
// something new arrived below.
export function transcriptMark(transcript: readonly PresentedItem[]): string {
  const last = transcript.at(-1);
  if (!last) return "0";
  const size = last.type === "tool" ? `${last.status}:${last.outputPreview.length}` : String(last.text.length);
  return `${transcript.length}:${last.id}:${size}`;
}

export const GLIDE_MS = 260;

// A glide to the end starts at most one window above it, so a long way back takes as long as a short one.
export function glideStart(top: number, end: number, view: number): number {
  return Math.max(top, end - view);
}

// end is read again on each frame, so text that arrives during the glide is still reached.
export function glideTop(start: number, end: number, elapsed: number): number {
  const t = Math.min(1, Math.max(0, elapsed / GLIDE_MS));
  return start + (end - start) * (1 - (1 - t) ** 3);
}
