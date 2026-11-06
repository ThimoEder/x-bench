import type { DockSplit, DockTab, PaneEdge } from "./dockMemory.ts";

// The dock's panes: the first pane's surface, and the second pane, if any. A surface shows in one pane at a time.
export interface DockLayout {
  tab: DockTab;
  split: DockSplit | null;
}

// Where a dragged surface lands. On a single pane, edge opens a new pane on that side of the dock. Once there
// are two, the surface replaces pane: 0 is the first pane, 1 the split's.
export interface DropZone {
  pane: 0 | 1;
  edge: PaneEdge | null;
}

// From this width the panes may sit side by side.
export const WIDE_DOCK = 640;

function across(edge: PaneEdge): boolean {
  return edge === "left" || edge === "right";
}

function splitLeads(split: DockSplit): boolean {
  return split.edge === "top" || split.edge === "left";
}

// x and y are the pointer's place as fractions of the dock's panes.
export function dropZone(layout: DockLayout, x: number, y: number, wide: boolean): DropZone {
  const { split } = layout;
  if (split) {
    const leading = (across(split.edge) ? x : y) < split.ratio;
    return { pane: leading === splitLeads(split) ? 1 : 0, edge: null };
  }
  const near: [PaneEdge, number][] = [["top", y], ["bottom", 1 - y]];
  if (wide) near.push(["left", x], ["right", 1 - x]);
  const [edge] = near.reduce((best, next) => (next[1] < best[1] ? next : best));
  return { pane: 0, edge };
}

// The only open surface detaches to its side, and Changes, or Files for Changes itself, fills the pane it left.
// With two panes, a surface dropped on the other pane swaps the two.
export function dropTab(layout: DockLayout, tab: DockTab, zone: DropZone): DockLayout {
  const { split } = layout;
  if (!split) {
    if (!zone.edge) return layout;
    const rest = tab !== layout.tab ? layout.tab : tab === "changes" ? "files" : "changes";
    return { tab: rest, split: { tab, edge: zone.edge, ratio: 0.5 } };
  }
  const target = zone.pane === 0 ? layout.tab : split.tab;
  if (tab === target) return layout;
  if (tab === layout.tab || tab === split.tab) return { tab: split.tab, split: { ...split, tab: layout.tab } };
  return zone.pane === 0 ? { tab, split } : { tab: layout.tab, split: { ...split, tab } };
}

export function closePane(layout: DockLayout, pane: 0 | 1): DockLayout {
  if (!layout.split) return layout;
  return { tab: pane === 0 ? layout.split.tab : layout.tab, split: null };
}

export function zoneInset(layout: DockLayout, zone: DropZone): string {
  const { split } = layout;
  if (!split) {
    const half = { top: "0 0 50% 0", bottom: "50% 0 0 0", left: "0 50% 0 0", right: "0 0 0 50%" };
    return zone.edge ? half[zone.edge] : "0";
  }
  const lead = Math.round(split.ratio * 100);
  const leading = (zone.pane === 1) === splitLeads(split);
  if (across(split.edge)) return leading ? `0 ${100 - lead}% 0 0` : `0 0 0 ${lead}%`;
  return leading ? `0 0 ${100 - lead}% 0` : `${lead}% 0 0 0`;
}
