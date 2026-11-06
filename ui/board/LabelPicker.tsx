import { useId, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { CheckIcon, PlusIcon } from "./boardIcons.tsx";
import { cssValue, keyOf, nodeOf, type BoardLabel } from "./boardData.ts";
import { useDismiss } from "./useDismiss.ts";
import { leaveRef } from "../leaveRef.ts";

export interface LabelPickerProps {
  labels: BoardLabel[];
  // Label ids as strings.
  picked: ReadonlySet<string>;
  disabled?: boolean;
  onToggle: (label: BoardLabel, on: boolean) => void;
  onManage: () => void;
}

// A pick leaves the menu open. The menu hangs on the page at the pill, so a scrolling column or pane does not cut it off.
export function LabelPicker({ labels, picked, disabled = false, onToggle, onManage }: LabelPickerProps) {
  const [open, setOpen] = useState(false);
  const own = useId();
  const buttonRef = useRef<HTMLButtonElement | null>(null);
  const menuRef = useRef<HTMLDivElement | null>(null);
  useDismiss(open, `[data-label-picker="${own}"]`, () => setOpen(false));

  // Below the pill, or above it when the window has no room below. It follows the pill as a pick, a scroll or a
  // board reload moves it, so this runs on every render.
  useLayoutEffect(() => {
    const menu = menuRef.current;
    const button = buttonRef.current;
    if (!open || !menu || !button) return undefined;
    function place() {
      if (!menu || !button) return;
      const rect = button.getBoundingClientRect();
      const below = rect.bottom + 6 + menu.offsetHeight <= window.innerHeight - 8;
      menu.style.top = `${below ? rect.bottom + 6 : Math.max(8, rect.top - 6 - menu.offsetHeight)}px`;
      menu.style.left = `${Math.max(8, Math.min(rect.left, window.innerWidth - menu.offsetWidth - 8))}px`;
      menu.style.transformOrigin = below ? "top left" : "bottom left";
    }
    place();
    window.addEventListener("scroll", place, true);
    window.addEventListener("resize", place);
    return () => {
      window.removeEventListener("scroll", place, true);
      window.removeEventListener("resize", place);
    };
  });

  return (
    <span className="label-picker" data-label-picker={own}>
      <button
        ref={buttonRef}
        type="button"
        className="board-pill is-spare"
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={() => setOpen((value) => !value)}
      >
        <PlusIcon size={11} />
        Label
      </button>
      {open
        ? createPortal(
            <div
              ref={(node) => {
                menuRef.current = node;
                const leave = leaveRef(node);
                return () => {
                  menuRef.current = null;
                  leave?.();
                };
              }}
              className="ticket-menu label-menu"
              role="menu"
              aria-label="Labels"
              data-label-picker={own}
            >
              {labels.length ? (
                labels.map((label) => {
                  const on = picked.has(String(label.id));
                  return (
                    <button key={keyOf(label.id)} type="button" role="menuitemcheckbox" aria-checked={on} disabled={disabled} onClick={() => onToggle(label, !on)}>
                      <i style={{ background: cssValue(label.color || "var(--faint)") }} />
                      {nodeOf(label.title)}
                      {on ? (
                        <span className="ticket-menu-check">
                          <CheckIcon />
                        </span>
                      ) : null}
                    </button>
                  );
                })
              ) : (
                <p className="ticket-menu-note">No labels on this board yet.</p>
              )}
              <hr />
              <button
                type="button"
                role="menuitem"
                className="label-menu-manage"
                onClick={() => {
                  setOpen(false);
                  onManage();
                }}
              >
                <PlusIcon size={13} />
                Manage labels…
              </button>
            </div>,
            document.body,
          )
        : null}
    </span>
  );
}
