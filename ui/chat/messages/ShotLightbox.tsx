import { useEffect, useRef, useState } from "react";
import type { MouseEvent as ReactMouseEvent, PointerEvent as ReactPointerEvent } from "react";
import { wheelPixels, zoomAt } from "./imageZoom.ts";
import type { ZoomView } from "./imageZoom.ts";

export interface ShotLightboxProps {
  srcs: string[];
  index: number;
  onIndex: (index: number) => void;
  onClose: () => void;
}

interface PanDrag {
  id: number;
  x: number;
  y: number;
  ox: number;
  oy: number;
  moved: boolean;
}

export function ShotLightbox({ srcs, index, onIndex, onClose }: ShotLightboxProps) {
  const src = srcs[index] || "";
  const frame = useRef<HTMLDivElement | null>(null);
  const view = useRef<ZoomView>({ scale: 1, x: 0, y: 0 });
  const [shown, setShown] = useState(view.current);
  const [trackedSrc, setTrackedSrc] = useState(src);
  const drag = useRef<PanDrag | null>(null);
  const onIndexRef = useRef(onIndex);
  const onCloseRef = useRef(onClose);
  const indexRef = useRef(index);
  const lengthRef = useRef(srcs.length);
  onIndexRef.current = onIndex;
  onCloseRef.current = onClose;
  indexRef.current = index;
  lengthRef.current = srcs.length;

  if (src !== trackedSrc) {
    const reset = { scale: 1, x: 0, y: 0 };
    view.current = reset;
    drag.current = null;
    setTrackedSrc(src);
    setShown(reset);
  }

  function show(next: ZoomView) {
    view.current = next;
    setShown(next);
  }

  useEffect(() => {
    function onKey(event: KeyboardEvent) {
      if (event.key === "Escape") {
        onCloseRef.current();
        return;
      }
      const length = lengthRef.current;
      if (length < 2 || (event.key !== "ArrowRight" && event.key !== "ArrowLeft")) return;
      const next = indexRef.current + (event.key === "ArrowRight" ? 1 : -1);
      if (next < 0 || next >= length) return;
      event.preventDefault();
      onIndexRef.current(next);
    }
    window.addEventListener("keydown", onKey);
    const node = frame.current!;
    function onWheel(event: WheelEvent) {
      event.preventDefault();
      const rect = node.getBoundingClientRect();
      const px = event.clientX - rect.left - rect.width / 2;
      const py = event.clientY - rect.top - rect.height / 2;
      show(zoomAt(view.current, px, py, wheelPixels(event)));
    }
    node.addEventListener("wheel", onWheel, { passive: false });
    return () => {
      window.removeEventListener("keydown", onKey);
      node.removeEventListener("wheel", onWheel);
    };
  }, []);

  function onPointerDown(event: ReactPointerEvent<HTMLImageElement>) {
    if (event.button !== 0 || view.current.scale <= 1) return;
    drag.current = {
      id: event.pointerId,
      x: event.clientX,
      y: event.clientY,
      ox: view.current.x,
      oy: view.current.y,
      moved: false,
    };
    event.currentTarget.setPointerCapture(event.pointerId);
    event.stopPropagation();
  }

  function onPointerMove(event: ReactPointerEvent<HTMLImageElement>) {
    const current = drag.current;
    if (!current || current.id !== event.pointerId) return;
    const dx = event.clientX - current.x;
    const dy = event.clientY - current.y;
    if (Math.hypot(dx, dy) > 3) current.moved = true;
    show({ ...view.current, x: current.ox + dx, y: current.oy + dy });
  }

  function onPointerUp() {
    drag.current = null;
  }

  function move(event: ReactMouseEvent<HTMLButtonElement>, next: number) {
    event.stopPropagation();
    if (next < 0 || next >= srcs.length) return;
    onIndex(next);
  }

  const zoomed = shown.scale > 1;
  const multiple = srcs.length > 1;
  return (
    <div
      ref={frame}
      className="shot-lightbox"
      role="dialog"
      aria-modal="true"
      data-testid="shot-lightbox"
      aria-label={multiple ? `Image ${index + 1} of ${srcs.length}` : "Image"}
      onClick={onClose}
    >
      {multiple ? (
        <button
          type="button"
          className="shot-nav prev"
          data-testid="shot-prev"
          aria-label="Previous image"
          aria-disabled={index === 0}
          onClick={(event) => move(event, index - 1)}
        >
          <ShotChevron direction="left" />
        </button>
      ) : null}
      <img
        src={src}
        alt=""
        className={zoomed ? "is-zoomed" : undefined}
        style={{ transform: `translate(${shown.x}px, ${shown.y}px) scale(${shown.scale})` }}
        onClick={(event) => event.stopPropagation()}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
      />
      {multiple ? (
        <button
          type="button"
          className="shot-nav next"
          data-testid="shot-next"
          aria-label="Next image"
          aria-disabled={index === srcs.length - 1}
          onClick={(event) => move(event, index + 1)}
        >
          <ShotChevron direction="right" />
        </button>
      ) : null}
    </div>
  );
}

function ShotChevron({ direction }: { direction: "left" | "right" }) {
  const left = direction === "left";
  return (
    <svg width="18" height="18" viewBox="0 0 18 18" aria-hidden="true">
      <path
        d={left ? "M11 4.2 6.2 9 11 13.8" : "M7 4.2 11.8 9 7 13.8"}
        fill="none"
        stroke="currentColor"
        strokeWidth="1.7"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}
