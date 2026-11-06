import { useEffect, useLayoutEffect, useRef, useState } from "react";
import type { CSSProperties, ReactNode } from "react";
import { createPortal } from "react-dom";
import { leaveRef } from "../leaveRef.ts";

// Where a menu opens, fixed in the window: under its … button, or at the pointer after a right-click.
export interface MenuPlace {
  x: number;
  y: number;
  // Where the menu's bottom edge goes when it does not fit below y.
  above: number;
  alignEnd: boolean;
}

// Fixed in the window, so the sidebar's scrolling and clipping leave the menu whole.
// page names what the menu shows, so a new page is placed again and its first item takes focus.
export function FloatingMenu({ place, page, onClose, children }: { place: MenuPlace; page?: string; onClose: () => void; children: ReactNode }) {
  const ref = useRef<HTMLDivElement>(null);
  const [style, setStyle] = useState<CSSProperties>({ left: place.x, top: place.y });

  useLayoutEffect(() => {
    const node = ref.current;
    if (!node) return;
    // The offset size, since the menu opens scaled down.
    const { offsetWidth: width, offsetHeight: height } = node;
    const edge = 6;
    const left = place.alignEnd ? place.x - width : place.x;
    const up = place.y + height > window.innerHeight - edge;
    const top = up ? place.above - height : place.y;
    setStyle({
      left: Math.max(edge, Math.min(left, window.innerWidth - width - edge)),
      top: Math.max(edge, top),
      transformOrigin: `${up ? "bottom" : "top"} ${place.alignEnd ? "right" : "left"}`,
    });
  }, [place, page]);

  // The menu sits at the end of the page, so focus moves into it, and back to where it was once it closes.
  useEffect(() => {
    const opener = document.activeElement;
    return () => {
      const current = document.activeElement;
      if ((!current || current === document.body) && opener instanceof HTMLElement && opener.isConnected) opener.focus({ preventScroll: true });
    };
  }, []);

  useEffect(() => {
    menuItems(ref.current)[0]?.focus({ preventScroll: true });
  }, [page]);

  useLayoutEffect(() => leaveRef(ref.current), []);

  return createPortal(
    <div
      ref={ref}
      className="session-menu is-floating"
      role="menu"
      style={style}
      onContextMenu={(event) => {
        event.preventDefault();
        event.stopPropagation();
      }}
      onKeyDown={(event) => {
        if (event.key === "Tab") {
          event.preventDefault();
          onClose();
          return;
        }
        if (event.key !== "ArrowDown" && event.key !== "ArrowUp") return;
        event.preventDefault();
        const items = menuItems(ref.current);
        const index = items.indexOf(document.activeElement as HTMLButtonElement);
        const step = event.key === "ArrowDown" ? 1 : -1;
        const next = index < 0 ? (step > 0 ? 0 : items.length - 1) : (index + step + items.length) % items.length;
        items[next]?.focus();
      }}
    >
      {children}
    </div>,
    document.body,
  );
}

function menuItems(menu: HTMLElement | null): HTMLButtonElement[] {
  return [...(menu?.querySelectorAll<HTMLButtonElement>('[role="menuitem"]:not(:disabled)') ?? [])];
}
