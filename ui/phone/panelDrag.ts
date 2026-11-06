// Side panels a finger drags on a phone: the sidebar from the left edge and the dock from the right edge.

export type Edge = "left" | "right";

// A panel a drag can move: the side it slides in from, and whether it is open now.
export interface DragPanel {
  element: HTMLElement;
  side: Edge;
  open: boolean;
  // Opens or closes the panel for real once the finger lets go.
  settle: (open: boolean) => void;
}

const EDGE = 28;
const START = 10;
const FLICK = 0.4;
const REST = 100;

// Where the panel sits, in px from its open place, after the finger moved dx from its start.
export function dragOffset(side: Edge, open: boolean, width: number, dx: number): number {
  const closed = side === "left" ? -width : width;
  const next = (open ? 0 : closed) + dx;
  return Math.min(Math.max(next, Math.min(0, closed)), Math.max(0, closed));
}

// Whether the panel ends open: a flick decides by its direction, a slow release by a quarter of the width moved.
export function settlesOpen(side: Edge, open: boolean, width: number, dx: number, velocity: number): boolean {
  const toOpen = side === "left" ? 1 : -1;
  if (Math.abs(velocity) > FLICK) return velocity * toOpen > 0;
  const travel = dx * toOpen;
  return open ? travel > -width / 4 : travel > width / 4;
}

// Whether an element under the touch, or one around it, can still scroll the way a finger moving dx pushes it.
function scrollsSideways(target: EventTarget | null, dx: number): boolean {
  for (let element = target instanceof Element ? target : null; element; element = element.parentElement) {
    if (element.scrollWidth <= element.clientWidth || !/auto|scroll/.test(getComputedStyle(element).overflowX)) continue;
    if (dx > 0 ? element.scrollLeft > 0 : element.scrollLeft + element.clientWidth < element.scrollWidth - 1) return true;
  }
  return false;
}

// Whether the touch began on a control that takes its own drags, which it says with touch-action: none.
function ownsDrag(target: EventTarget | null): boolean {
  for (let element = target instanceof Element ? target : null; element; element = element.parentElement) {
    if (getComputedStyle(element).touchAction === "none") return true;
  }
  return false;
}

// Lets a one-finger horizontal drag move a panel. pick names the panel a drag in that direction from that edge
// moves, or null. Works only on a phone-sized touch screen, where the panels cover the screen.
export function watchDrags(pick: (direction: Edge, edge: Edge | null) => DragPanel | null): () => void {
  const phone = window.matchMedia?.("(pointer: coarse) and (max-width: 640px)");
  let start: { x: number; y: number; time: number; edge: Edge | null; target: EventTarget | null } | null = null;
  let drag: { panel: DragPanel; width: number; dx: number; x: number; time: number; velocity: number } | null = null;

  function onStart(event: TouchEvent) {
    const touch = event.touches[0];
    // A second finger ends the drag where it began.
    if (drag) release(drag.panel.open);
    start = null;
    if (event.touches.length !== 1 || !touch || !phone?.matches) return;
    const edge = touch.clientX <= EDGE ? "left" : touch.clientX >= window.innerWidth - EDGE ? "right" : null;
    start = { x: touch.clientX, y: touch.clientY, time: event.timeStamp, edge, target: event.target };
  }

  function onMove(event: TouchEvent) {
    const touch = event.touches[0];
    if (!start || !touch) return;
    const dx = touch.clientX - start.x;
    if (!drag) {
      const dy = touch.clientY - start.y;
      if (Math.abs(dx) < START && Math.abs(dy) < START) return;
      // Away from the edges, content that can still scroll that way, or a control with its own drag, keeps the gesture.
      const sideways = Math.abs(dx) > Math.abs(dy) && (start.edge || (!scrollsSideways(start.target, dx) && !ownsDrag(start.target)));
      const panel = sideways ? pick(dx > 0 ? "right" : "left", start.edge) : null;
      if (!panel) {
        start = null;
        return;
      }
      drag = { panel, width: panel.element.getBoundingClientRect().width, dx, x: touch.clientX, time: event.timeStamp, velocity: 0 };
      panel.element.classList.add("is-dragging");
    }
    event.preventDefault();
    follow(touch.clientX, event.timeStamp);
  }

  function follow(x: number, time: number) {
    if (!drag || !start) return;
    const elapsed = time - drag.time;
    if (elapsed > 0) drag.velocity = (x - drag.x) / elapsed;
    drag.x = x;
    drag.time = time;
    drag.dx = x - start.x;
    const { panel, width } = drag;
    panel.element.style.transform = `translateX(${dragOffset(panel.side, panel.open, width, drag.dx)}px)`;
  }

  function onEnd(event: TouchEvent) {
    if (!drag) {
      start = null;
      return;
    }
    // The finger's last move can come only with the release, and a finger that rested before lifting flicks nothing.
    const touch = event.changedTouches[0];
    if (touch && touch.clientX !== drag.x) follow(touch.clientX, event.timeStamp);
    else if (event.timeStamp - drag.time > REST) drag.velocity = 0;
    start = null;
    const { panel, width, dx, velocity } = drag;
    release(settlesOpen(panel.side, panel.open, width, dx, velocity));
  }

  function release(open: boolean) {
    if (!drag) return;
    const { panel } = drag;
    drag = null;
    // The transition comes back before the panel's class changes, so it slides on from where the finger left it.
    panel.element.classList.remove("is-dragging");
    panel.settle(open);
    panel.element.style.removeProperty("transform");
  }

  window.addEventListener("touchstart", onStart, { passive: true });
  window.addEventListener("touchmove", onMove, { passive: false });
  window.addEventListener("touchend", onEnd, { passive: true });
  window.addEventListener("touchcancel", onEnd, { passive: true });
  return () => {
    window.removeEventListener("touchstart", onStart);
    window.removeEventListener("touchmove", onMove);
    window.removeEventListener("touchend", onEnd);
    window.removeEventListener("touchcancel", onEnd);
  };
}
