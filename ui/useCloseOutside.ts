import { type RefObject, useEffect, useRef } from "react";

// While open, a pointer down outside root, or Esc, calls close.
export function useCloseOutside(open: boolean, root: RefObject<Element | null>, close: () => void): void {
  const closeRef = useRef(close);
  closeRef.current = close;
  useEffect(() => {
    if (!open) return undefined;
    function onPointerDown(event: PointerEvent) {
      if (!root.current?.contains(event.target as Node | null)) closeRef.current();
    }
    function onKey(event: KeyboardEvent) {
      if (event.key === "Escape") closeRef.current();
    }
    document.addEventListener("pointerdown", onPointerDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("pointerdown", onPointerDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [open, root]);
}
