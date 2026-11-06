import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import type { Device } from "../../server/devices/deviceMath.ts";
import { leaveRef } from "../leaveRef.ts";
import { CaretIcon } from "../icons.tsx";

// A simulator or emulator that is not running, as /api/devices/available lists it.
export interface StartableDevice {
  id: string;
  platform: "ios" | "android";
  name: string;
  os: string;
}

export interface DevicePickerProps {
  devices: Device[];
  selectedId: string;
  // The device being started, while it boots.
  starting: string | null;
  onSelect: (id: string) => void;
  onStart: (device: StartableDevice) => void;
  loadStartable: () => Promise<StartableDevice[]>;
}

type Platform = StartableDevice["platform"];

const STARTS: { platform: Platform; label: string }[] = [
  { platform: "ios", label: "Start iOS Simulator" },
  { platform: "android", label: "Start Android Emulator" },
];

// The Device tab's device menu: the running devices, and below a line a submenu per platform with the
// devices that can be started.
export function DevicePicker({ devices, selectedId, starting, onSelect, onStart, loadStartable }: DevicePickerProps) {
  const [open, setOpen] = useState(false);
  const [sub, setSub] = useState<Platform | null>(null);
  const [startable, setStartable] = useState<StartableDevice[] | null>(null);
  const [failed, setFailed] = useState("");
  // Where the open submenu sits on the window. It is drawn over the whole window, since the dock clips.
  const [place, setPlace] = useState<{ top: number; left: number } | null>(null);
  const root = useRef<HTMLDivElement | null>(null);
  const subRoot = useRef<HTMLDivElement | null>(null);
  const subRef = useCallback((node: HTMLDivElement | null) => {
    subRoot.current = node;
    const leave = leaveRef(node);
    return () => {
      subRoot.current = null;
      leave?.();
    };
  }, []);
  const items = useRef(new Map<Platform, HTMLButtonElement>());
  const selected = devices.find((device) => device.id === selectedId) || null;

  useEffect(() => {
    if (!open) {
      setSub(null);
      return undefined;
    }
    let cancelled = false;
    setFailed("");
    loadStartable()
      .then((rows) => {
        if (!cancelled) setStartable(rows);
      })
      .catch((error: unknown) => {
        if (!cancelled) setFailed(error instanceof Error ? error.message : "Couldn't list the devices");
      });
    function onPointerDown(event: PointerEvent) {
      const target = event.target as Node | null;
      if (!root.current?.contains(target) && !subRoot.current?.contains(target)) setOpen(false);
    }
    function onKey(event: KeyboardEvent) {
      if (event.key === "Escape") setOpen(false);
    }
    document.addEventListener("pointerdown", onPointerDown);
    document.addEventListener("keydown", onKey);
    return () => {
      cancelled = true;
      document.removeEventListener("pointerdown", onPointerDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [open, loadStartable]);

  // Beside its item, to the right when it fits and else to the left, and within the window's height.
  useLayoutEffect(() => {
    const item = sub ? items.current.get(sub) : undefined;
    const menu = subRoot.current;
    if (!item || !menu) {
      setPlace(null);
      return;
    }
    const at = item.getBoundingClientRect();
    const width = menu.offsetWidth;
    const height = menu.offsetHeight;
    const gap = 6;
    const left = at.right + gap + width <= window.innerWidth - 8 ? at.right + gap : Math.max(8, at.left - gap - width);
    menu.style.transformOrigin = left > at.left ? "top left" : "top right";
    const top = Math.max(8, Math.min(at.top - 4, window.innerHeight - 8 - height));
    setPlace((current) => (current && current.top === top && current.left === left ? current : { top, left }));
  }, [sub, startable, failed]);

  const label = starting ? `Starting ${starting}…` : selected ? `${selected.name}${selected.state === "unauthorized" ? " (not allowed)" : ""}` : devices.length ? "Choose a device" : "No device running";

  function pick(id: string) {
    setOpen(false);
    onSelect(id);
  }

  function start(device: StartableDevice) {
    setOpen(false);
    onStart(device);
  }

  return (
    <div className="device-menu" ref={root}>
      <button type="button" className="device-picker" aria-label="Device" aria-haspopup="menu" aria-expanded={open} data-device={selectedId} onClick={() => setOpen((value) => !value)}>
        <span>{label}</span>
        <CaretIcon />
      </button>
      {open ? (
        <div ref={leaveRef} className="device-menu-list" role="menu" aria-label="Devices">
          {devices.length ? (
            devices.map((device) => (
              <button
                key={device.id}
                type="button"
                role="menuitemradio"
                aria-checked={device.id === selectedId}
                data-device={device.id}
                className={device.id === selectedId ? "active" : ""}
                onClick={() => pick(device.id)}
                onPointerEnter={() => setSub(null)}
              >
                {device.name}
                {device.state === "unauthorized" ? " (not allowed)" : ""}
              </button>
            ))
          ) : (
            <p className="device-menu-note">No simulator or emulator is running.</p>
          )}
          <hr className="device-menu-line" />
          {STARTS.map(({ platform, label: title }) => {
            const rows = (startable ?? []).filter((device) => device.platform === platform);
            return (
              <div key={platform} className="device-menu-start" onPointerEnter={() => setSub(platform)}>
                <button
                  ref={(node) => {
                    if (node) items.current.set(platform, node);
                    else items.current.delete(platform);
                  }}
                  type="button"
                  role="menuitem"
                  aria-haspopup="menu"
                  aria-expanded={sub === platform}
                  className={sub === platform ? "active" : ""}
                  onClick={() => setSub(sub === platform ? null : platform)}
                >
                  <span>{title}</span>
                  <ChevronIcon />
                </button>
                {sub === platform ? createPortal(
                  <div
                    ref={subRef}
                    className="device-submenu"
                    role="menu"
                    aria-label={title}
                    style={place ? { top: place.top, left: place.left } : { top: 0, left: 0, visibility: "hidden" }}
                  >
                    {failed ? <p className="device-menu-note">{failed}</p> : null}
                    {!failed && !startable ? <p className="device-menu-note">Looking for devices…</p> : null}
                    {!failed && startable && !rows.length ? <p className="device-menu-note">{platform === "ios" ? "No other simulator is available." : "No other emulator is set up in Android Studio."}</p> : null}
                    {rows.map((device) => (
                      <button key={device.id} type="button" role="menuitem" onClick={() => start(device)}>
                        <span>{device.name}</span>
                        {device.platform === "ios" && device.os ? <span className="device-menu-os">{device.os}</span> : null}
                      </button>
                    ))}
                  </div>,
                  document.body,
                ) : null}
              </div>
            );
          })}
        </div>
      ) : null}
    </div>
  );
}

// iOS simulators by system, newest first, then by name; emulators by name.
export function sortStartable(devices: StartableDevice[]): StartableDevice[] {
  const version = (os: string) => os.replace(/[^\d.]/g, "").split(".").map(Number);
  return [...devices].sort((a, b) => {
    if (a.platform !== b.platform) return a.platform === "ios" ? -1 : 1;
    const left = version(a.os);
    const right = version(b.os);
    for (let index = 0; index < Math.max(left.length, right.length); index += 1) {
      const diff = (right[index] ?? 0) - (left[index] ?? 0);
      if (diff) return diff;
    }
    return a.name.localeCompare(b.name);
  });
}

function ChevronIcon() {
  return (
    <svg width="10" height="10" viewBox="0 0 10 10" aria-hidden="true">
      <path d="M3.8 2.2 6.4 5 3.8 7.8" fill="none" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}
