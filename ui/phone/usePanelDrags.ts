import { useEffect } from "react";
import { flushSync } from "react-dom";
import { useStableCallback } from "../useStableCallback.ts";
import { watchDrags, type DragPanel, type Edge } from "./panelDrag.ts";

interface Panel {
  open: boolean;
  setOpen: (open: boolean) => void;
}

// On a phone a drag from the left edge pulls in the sidebar and one from the right edge pulls in Review.
// Dragging the other way pushes them out. Without a dock there is no Review to pull in.
export function usePanelDrags(blocked: boolean, sidebar: Panel, dock: Panel | null) {
  const pickDrag = useStableCallback((direction: Edge, edge: Edge | null): DragPanel | null => {
    if (blocked) return null;
    const sidebarNode = document.querySelector<HTMLElement>(".sidebar");
    const dockNode = document.querySelector<HTMLElement>(".dock-slot");
    const panel = (element: HTMLElement | null, side: Edge, open: boolean, settle: (open: boolean) => void) =>
      element ? { element, side, open, settle: (next: boolean) => flushSync(() => settle(next)) } : null;
    if (direction === "right") {
      if (dock?.open) return panel(dockNode, "right", true, dock.setOpen);
      if (!sidebar.open && edge === "left") return panel(sidebarNode, "left", false, sidebar.setOpen);
    } else {
      if (sidebar.open) return panel(sidebarNode, "left", true, sidebar.setOpen);
      if (dock && !dock.open && edge === "right") return panel(dockNode, "right", false, dock.setOpen);
    }
    return null;
  });
  useEffect(() => watchDrags(pickDrag), [pickDrag]);
}
