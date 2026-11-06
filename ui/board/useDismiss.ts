import { useEffect, useRef } from "react";

// While open, a pointer down outside any element matching inside, or Esc, calls close.
export function useDismiss(open: boolean, inside: string, close: () => void): void {
  const closeRef = useRef(close);
  closeRef.current = close;
  useEffect(() => {
    if (!open) return undefined;
    function onPointer(event: PointerEvent) {
      if (event.target instanceof Element && event.target.closest(inside)) return;
      closeRef.current();
    }
    function onKey(event: KeyboardEvent) {
      if (event.key === "Escape") closeRef.current();
    }
    window.addEventListener("pointerdown", onPointer);
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("pointerdown", onPointer);
      window.removeEventListener("keydown", onKey);
    };
  }, [open, inside]);
}
