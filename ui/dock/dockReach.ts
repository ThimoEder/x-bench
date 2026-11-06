// Past its usual limit the dock reaches across the chat, up to the sidebar's edge. At the limit the
// edge holds for REACH_DETENT px of pointer travel, giving at most REACH_GIVE px, before it moves on.
export const DOCK_MIN = 320;
export const DOCK_LIMIT = 760;
// The chat keeps this much width beside the dock: its composer still fits with the option menus behind one button.
export const CHAT_MIN = 460;
export const REACH_DETENT = 77;
export const REACH_GIVE = 14;
const REACH_DIM = 0.13;
const REACH_DIM_SPAN = 240;

// The widest the dock sits beside the chat in a workspace this wide, before the workspace is measured the limit.
// The edge holds and the dock reaches across the chat from here, so the reach starts where the dock stops.
export function dockCap(workspace: number): number {
  if (!(workspace > 0)) return DOCK_LIMIT;
  return Math.min(DOCK_LIMIT, Math.max(DOCK_MIN, workspace - CHAT_MIN));
}

// A stored dock width is the width beside the chat up to DOCK_LIMIT, and past it DOCK_LIMIT plus how far the
// dock reaches beyond its cap. A width beside the chat gives way to a narrower cap, and a reach keeps its depth.
export function shownDock(stored: number, workspace: number): number {
  const cap = dockCap(workspace);
  if (stored <= DOCK_LIMIT) return Math.min(stored, cap);
  return Math.min(cap + stored - DOCK_LIMIT, Math.max(cap, workspace));
}

export function storedDock(shown: number, workspace: number): number {
  const cap = dockCap(workspace);
  return shown > cap ? DOCK_LIMIT + shown - cap : shown;
}

export function dockWidthForPull(pull: number, full: number, limit = DOCK_LIMIT): number {
  if (pull <= limit) return Math.max(DOCK_MIN, pull);
  if (full <= limit) return limit;
  if (pull <= limit + REACH_DETENT) {
    return Math.min(full, limit + REACH_GIVE * Math.sqrt((pull - limit) / REACH_DETENT));
  }
  return Math.min(full, pull - REACH_DETENT + REACH_GIVE);
}

export function pullForDockWidth(width: number, limit = DOCK_LIMIT): number {
  return width > limit ? width + REACH_DETENT - REACH_GIVE : width;
}

export function settleDockWidth(width: number): number {
  return width > DOCK_LIMIT && width <= DOCK_LIMIT + REACH_GIVE ? DOCK_LIMIT : width;
}

export function reachDim(width: number, full: number, limit = DOCK_LIMIT): number {
  const over = Math.max(0, Math.min(width, full) - limit);
  const span = Math.max(1, Math.min(full - limit, REACH_DIM_SPAN));
  return REACH_DIM * Math.min(1, over / span);
}
