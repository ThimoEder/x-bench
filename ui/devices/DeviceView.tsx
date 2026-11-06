import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import type * as React from "react";
import { containedPoint, devicePoint } from "../../server/devices/deviceMath.ts";
import { apiFetch, withToken, type CallOptions } from "../launchToken.ts";
import type { ClipboardEvent as ReactClipboardEvent, KeyboardEvent as ReactKeyboardEvent, PointerEvent as ReactPointerEvent } from "react";
import type { Device, Point, Size } from "../../server/devices/deviceMath.ts";
import { DevicePicker, sortStartable, type StartableDevice } from "./DevicePicker.tsx";
import { hidUsage } from "./hidKeys.ts";

export interface DeviceViewProps {
  call: (path: string, body?: Record<string, unknown>, method?: string, options?: CallOptions) => Promise<unknown>;
  active: boolean;
  // The device the chat showed last, and where the shown device is reported.
  device?: string;
  onDevice?: (id: string) => void;
}


type ToolbarKey = { key: string; label: string; icon: () => React.ReactElement };

const IOS_KEYS: ToolbarKey[] = [
  { key: "home", label: "Home button", icon: HomeIcon },
  { key: "lock", label: "Lock the screen", icon: LockIcon },
  { key: "siri", label: "Siri", icon: SiriIcon },
];

const ANDROID_KEYS: ToolbarKey[] = [
  { key: "back", label: "Back", icon: BackIcon },
  { key: "home", label: "Home button", icon: HomeIcon },
  { key: "app_switch", label: "Recent apps", icon: RecentsIcon },
];

// The screen's corner radius and the bezel around it, as shares of the screen's width.
function shapeOf(device: Device | null): { radius: number; bezel: number } {
  if (device?.platform === "android") return { radius: 0.07, bezel: 0.012 };
  if (device?.name.startsWith("iPad")) return { radius: 0.025, bezel: 0.01 };
  return { radius: 0.14, bezel: 0.012 };
}

// The largest screen, with its bezel, that fits the stage.
function fitScreen(stage: Size, screen: Size, bezel: number): Size | null {
  if (!(stage.width > 0) || !(stage.height > 0) || !(screen.width > 0) || !(screen.height > 0)) return null;
  const ratio = screen.height / screen.width;
  const width = Math.min(stage.width / (1 + 2 * bezel), stage.height / (ratio + 2 * bezel));
  return { width: Math.floor(width), height: Math.floor(width * ratio) };
}

function saveName(device: Device): string {
  const at = new Date();
  const two = (value: number) => String(value).padStart(2, "0");
  return `${device.name.split(" · ")[0]} ${at.getFullYear()}-${two(at.getMonth() + 1)}-${two(at.getDate())} at ${two(at.getHours())}.${two(at.getMinutes())}.${two(at.getSeconds())}.jpg`;
}

// The host's /api/devices/tools answer, read for whether X Bench's simulator helper is there for touches.
function touchesReach(data: unknown): boolean {
  return isRecord(data) && isRecord(data.helper) && data.helper.found === true;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function isDevice(value: unknown): value is Device {
  return (
    isRecord(value) &&
    typeof value.id === "string" &&
    (value.platform === "ios" || value.platform === "android") &&
    typeof value.name === "string" &&
    typeof value.state === "string"
  );
}

// /api/devices/available answers { devices: StartableDevice[] }.
function startableDevices(data: unknown): StartableDevice[] {
  const rows = isRecord(data) && Array.isArray(data.devices) ? data.devices : [];
  return rows.filter(
    (row): row is StartableDevice =>
      isRecord(row) && typeof row.id === "string" && (row.platform === "ios" || row.platform === "android") && typeof row.name === "string" && typeof row.os === "string",
  );
}

// The host answers { devices: Device[] }.
function listedDevices(data: unknown): Device[] {
  const rows = isRecord(data) ? data.devices : undefined;
  return Array.isArray(rows) && rows.every(isDevice) ? rows : [];
}

// The wanted device while it is listed, else the first one ready.
function chosen(rows: Device[], wanted: string): string {
  if (!rows.length || (wanted && rows.some((device) => device.id === wanted))) return wanted;
  const ready = rows.find((device) => device.state === "booted" || device.state === "device");
  return ready?.id || rows[0]?.id || "";
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : "";
}

function errorOf(data: unknown): string {
  return isRecord(data) && typeof data.error === "string" ? data.error : "";
}

export function DeviceView({ call, active, device: picked = "", onDevice }: DeviceViewProps) {
  const callRef = useRef(call);
  callRef.current = call;
  const [devices, setDevices] = useState<Device[]>([]);
  const [selectedId, setSelectedId] = useState(picked);
  const [src, setSrc] = useState("");
  const [error, setError] = useState("");
  const imgRef = useRef<HTMLImageElement | null>(null);
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const screenRef = useRef<Size | null>(null);
  const streamRef = useRef<WebSocket | null>(null);
  const origin = useRef<Point | null>(null);
  // Whether the gesture under way is a pinch, chosen when the finger goes down.
  const pinching = useRef(false);
  const lastPoint = useRef<Point | null>(null);
  const started = useRef(0);
  const keysDown = useRef(new Set<number>());
  const [streaming, setStreaming] = useState(false);
  const [touchable, setTouchable] = useState<boolean | null>(null);
  // Counts up to open the stream again after it closed, as it does when the host restarts.
  const [reconnect, setReconnect] = useState(0);
  // Stream opens in a row that closed, for the wait before the next one.
  const tries = useRef(0);
  const [notice, setNotice] = useState("");
  // The name of a device the person started from the menu, while it boots.
  const [starting, setStarting] = useState<string | null>(null);
  const selected = devices.find((device) => device.id === selectedId) || null;
  const selectedRef = useRef(selectedId);
  selectedRef.current = selectedId;
  // The selected device's name, and the device that left while shown.
  const named = useRef("");
  if (selected) named.current = selected.name;
  const lost = useRef<{ id: string; name: string } | null>(null);
  const ios = selected?.platform === "ios" && selected.state === "booted";
  const androidLive = selected?.platform === "android" && selected.state === "device";
  const interactive = (selected?.platform === "android" && selected.state === "device") || (ios && touchable === true);
  const stageRef = useRef<HTMLDivElement | null>(null);
  const [stage, setStage] = useState<Size>({ width: 0, height: 0 });
  // The picture's size, for the screen's shape before and while it streams.
  const [picture, setPicture] = useState<Size>({ width: 0, height: 0 });
  // Whether the on-screen keyboard shows while the device reports a hardware keyboard, null while unknown.
  const [keyboard, setKeyboard] = useState<boolean | null>(null);
  const shape = shapeOf(selected);
  const fitted = fitScreen(stage, picture.width ? picture : { width: 402, height: 874 }, shape.bezel);

  useLayoutEffect(() => {
    const node = stageRef.current;
    if (!node) return undefined;
    const observer = new ResizeObserver(() => setStage({ width: node.clientWidth, height: node.clientHeight }));
    observer.observe(node);
    setStage({ width: node.clientWidth, height: node.clientHeight });
    return () => observer.disconnect();
  }, []);

  function measured(width: number, height: number) {
    setPicture((current) => (current.width === width && current.height === height ? current : { width, height }));
  }

  useEffect(() => {
    setKeyboard(null);
    if (!active || !androidLive) return undefined;
    let cancelled = false;
    callRef.current("/api/devices/input", { id: selectedId, action: "keyboard-state" }, "POST", { quiet: true })
      .then((data) => {
        if (!cancelled && isRecord(data) && typeof data.keyboard === "boolean") setKeyboard(data.keyboard);
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [active, androidLive, selectedId]);

  useEffect(() => {
    if (!active || !ios) return;
    let cancelled = false;
    callRef.current("/api/devices/tools", undefined, "GET", { quiet: true })
      .then((data) => {
        if (!cancelled) setTouchable(touchesReach(data));
      })
      .catch(() => {
        if (!cancelled) setTouchable(false);
      });
    return () => {
      cancelled = true;
    };
  }, [active, ios]);

  const devicesRef = useRef(devices);
  devicesRef.current = devices;
  const onDeviceRef = useRef(onDevice);
  onDeviceRef.current = onDevice;

  // A device the dock picked forgets the one that left, unless the dock only echoes this view's own fallback.
  useEffect(() => {
    if (picked !== selectedRef.current) lost.current = null;
    setSelectedId(chosen(devicesRef.current, picked));
  }, [picked]);

  useEffect(() => {
    if (selectedId) onDeviceRef.current?.(selectedId);
  }, [selectedId]);

  useEffect(() => {
    if (!active) return undefined;
    let cancelled = false;
    async function load() {
      try {
        const data = await callRef.current("/api/devices", undefined, "POST", { quiet: true });
        if (cancelled) return;
        const rows = listedDevices(data);
        setDevices(rows);
        setSelectedId(nextSelection(rows));
      } catch (loadError) {
        if (!cancelled) setError(messageOf(loadError) || "Couldn't list devices");
      }
    }
    // A device that leaves while shown, as an emulator does when it restarts, comes back into view on its return.
    function nextSelection(rows: Device[]): string {
      const current = selectedRef.current;
      const away = lost.current;
      const back = away ? rows.find((device) => (device.id === away.id || device.name === away.name) && (device.state === "booted" || device.state === "device")) : undefined;
      if (back) {
        lost.current = null;
        return back.id;
      }
      const next = chosen(rows, current);
      if (current && next !== current && !away) lost.current = { id: current, name: named.current };
      return next;
    }

    load();
    const timer = setInterval(load, 3000);
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, [active]);

  useEffect(() => {
    if (!active || streaming || !selected || selected.state === "unauthorized" || selected.state === "offline") {
      setSrc("");
      return undefined;
    }
    const controller = new AbortController();
    let cancelled = false;
    let objectUrl = "";
    const id = selected.id;

    async function loop() {
      while (!cancelled) {
        const started = Date.now();
        try {
          const response = await apiFetch(`/api/devices/frame?id=${encodeURIComponent(id)}`, { signal: controller.signal });
          if (!response.ok) {
            const data: unknown = await response.json().catch(() => ({}));
            throw new Error(errorOf(data) || "Couldn't read the screen");
          }
          const width = Number(response.headers.get("x-screen-width")) || 0;
          const height = Number(response.headers.get("x-screen-height")) || 0;
          const blob = await response.blob();
          if (cancelled) return;
          const next = URL.createObjectURL(blob);
          if (objectUrl) URL.revokeObjectURL(objectUrl);
          objectUrl = next;
          screenRef.current = width && height ? { width, height } : null;
          setSrc(next);
          setError("");
        } catch (frameError) {
          if (cancelled || (frameError instanceof Error && frameError.name === "AbortError")) return;
          setError(messageOf(frameError) || "Couldn't read the screen");
        }
        const pause = Math.max(40, 160 - (Date.now() - started));
        await new Promise((resolve) => {
          setTimeout(resolve, pause);
        });
      }
    }

    loop();
    return () => {
      cancelled = true;
      controller.abort();
      if (objectUrl) URL.revokeObjectURL(objectUrl);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- restarts only when the device or its state changes
  }, [active, streaming, selected?.id, selected?.state]);

  useEffect(() => {
    const live = selected && ((selected.platform === "android" && selected.state === "device") || (selected.platform === "ios" && selected.state === "booted"));
    if (!active || !selected || !live) {
      setStreaming(false);
      return undefined;
    }
    const canvas = canvasRef.current;
    const ctx = canvas?.getContext("2d");
    let decoder: VideoDecoder | null = null;
    let configured = false;
    let timestamp = 0;
    let closed = false;
    let retry: ReturnType<typeof setTimeout> | undefined;
    const socket = new WebSocket(`${location.protocol === "https:" ? "wss" : "ws"}://${location.host}${withToken(`/api/devices/stream?id=${encodeURIComponent(selected.id)}`)}`);
    socket.binaryType = "arraybuffer";
    streamRef.current = socket;

    function configure(message: Record<string, unknown>) {
      if (typeof VideoDecoder === "undefined") throw new Error("This browser cannot play the stream");
      if (!decoder) {
        decoder = new VideoDecoder({
          output(frame) {
            if (!ctx || !canvas || closed) {
              frame.close();
              return;
            }
            if (canvas.width !== frame.displayWidth || canvas.height !== frame.displayHeight) {
              canvas.width = frame.displayWidth;
              canvas.height = frame.displayHeight;
              measured(frame.displayWidth, frame.displayHeight);
            }
            ctx.drawImage(frame, 0, 0);
            frame.close();
            tries.current = 0;
            setStreaming(true);
            setError("");
          },
          error() {
            setStreaming(false);
          },
        });
      }
      const description = Uint8Array.from(atob(String(message.description)), (char) => char.charCodeAt(0));
      decoder.configure({ codec: String(message.codec), description, optimizeForLatency: true });
      configured = true;
    }

    socket.onmessage = (event: MessageEvent<unknown>) => {
      if (typeof event.data === "string") {
        const message: unknown = JSON.parse(event.data);
        if (!isRecord(message)) return;
        if (message.type === "size" && canvas) {
          canvas.width = Number(message.width);
          canvas.height = Number(message.height);
          measured(canvas.width, canvas.height);
          screenRef.current = null;
        }
        if (message.type === "codec") {
          try {
            configure(message);
          } catch (streamError) {
            setError(messageOf(streamError) || "Couldn't play the stream");
          }
        }
        if (message.type === "error") {
          setStreaming(false);
          setError(String(message.message || "The stream stopped"));
        }
        return;
      }
      if (!(event.data instanceof ArrayBuffer)) return;
      if (!configured || !decoder) return;
      const bytes = new Uint8Array(event.data);
      try {
        decoder.decode(new EncodedVideoChunk({
          type: bytes[0] === 1 ? "key" : "delta",
          timestamp,
          data: bytes.subarray(1),
        }));
        timestamp += 33333;
      } catch {
        configured = false;
        setStreaming(false);
      }
    };
    socket.onclose = () => {
      if (closed) return;
      setStreaming(false);
      // The device may still be coming back, as after an emulator or adb restart, so tries slow down.
      retry = setTimeout(() => setReconnect((count) => count + 1), Math.min(10_000, 1000 * 2 ** Math.min(tries.current, 4)));
      tries.current += 1;
    };

    return () => {
      closed = true;
      clearTimeout(retry);
      streamRef.current = null;
      socket.close();
      if (decoder && decoder.state !== "closed") decoder.close();
      setStreaming(false);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- reconnects only when the device or its state changes
  }, [active, selected?.id, selected?.platform, selected?.state, reconnect]);

  function readPoint(event: ReactPointerEvent<HTMLDivElement>): Point | null {
    const node = streaming ? canvasRef.current : imgRef.current;
    const imageWidth = streaming ? node?.width : imgRef.current?.naturalWidth;
    const imageHeight = streaming ? node?.height : imgRef.current?.naturalHeight;
    if (!imageWidth || !imageHeight || !node) return null;
    const box = node.getBoundingClientRect();
    const fitted = containedPoint({
      containerWidth: box.width,
      containerHeight: box.height,
      imageWidth,
      imageHeight,
      clientX: event.clientX - box.left,
      clientY: event.clientY - box.top,
    });
    if (streaming) return fitted;
    return devicePoint(fitted, { width: imageWidth, height: imageHeight }, screenRef.current);
  }

  // pinch puts a second finger mirrored across the screen's center, like holding Option in Simulator.app.
  function sendTouch(action: "down" | "move" | "up", point: Point, pinch = false): boolean {
    const canvas = canvasRef.current;
    const socket = streamRef.current;
    if (!canvas || !socket || socket.readyState !== WebSocket.OPEN) return false;
    socket.send(JSON.stringify({
      type: "touch",
      action,
      x: point.x,
      y: point.y,
      width: canvas.width,
      height: canvas.height,
      ...(pinch ? { pinch: true } : {}),
    }));
    return true;
  }

  function onPointerDown(event: ReactPointerEvent<HTMLDivElement>) {
    event.preventDefault();
    window.getSelection()?.removeAllRanges();
    if (!interactive) return;
    event.currentTarget.focus({ preventScroll: true });
    const point = readPoint(event);
    if (!point) return;
    event.currentTarget.setPointerCapture(event.pointerId);
    origin.current = point;
    lastPoint.current = point;
    started.current = Date.now();
    setNotice("");
    pinching.current = event.altKey;
    if (streaming) sendTouch("down", point, pinching.current);
  }

  function onPointerMove(event: ReactPointerEvent<HTMLDivElement>) {
    if (!streaming || !origin.current) return;
    const point = readPoint(event);
    if (!point) return;
    lastPoint.current = point;
    sendTouch("move", point, pinching.current);
  }

  function onPointerUp(event: ReactPointerEvent<HTMLDivElement>) {
    const start = origin.current;
    origin.current = null;
    if (!start || !selected) return;
    const end = readPoint(event) || start;
    const held = Date.now() - started.current;
    if (streaming) {
      sendTouch("up", end, pinching.current);
      return;
    }
    const moved = (end.x - start.x) ** 2 + (end.y - start.y) ** 2 > 144;
    const body = moved
      ? { id: selected.id, action: "swipe", x: start.x, y: start.y, x2: end.x, y2: end.y, ms: held }
      : { id: selected.id, action: "tap", x: start.x, y: start.y, ms: held };
    callRef.current("/api/devices/input", body).catch((inputError: unknown) => setNotice(messageOf(inputError)));
  }

  // The browser took the pointer away, as when the window lost focus mid-drag: the finger lifts where it was.
  function onPointerCancel() {
    const at = lastPoint.current;
    origin.current = null;
    if (streaming && at) sendTouch("up", at, pinching.current);
  }

  function sendKeyboard(action: "down" | "up", code: number): boolean {
    const socket = streamRef.current;
    if (!socket || socket.readyState !== WebSocket.OPEN) return false;
    socket.send(JSON.stringify({ type: "keyboard", action, code }));
    return true;
  }

  function releaseKeys() {
    for (const code of keysDown.current) sendKeyboard("up", code);
    keysDown.current.clear();
  }

  function copyFromDevice(cut: boolean) {
    if (!selected) return;
    callRef.current("/api/devices/input", { id: selected.id, action: cut ? "cut" : "copy" })
      .then((data) => (isRecord(data) && typeof data.text === "string" ? navigator.clipboard.writeText(data.text) : undefined))
      .catch((copyError: unknown) => setNotice(messageOf(copyError) || "Couldn't copy from the simulator"));
  }

  function onPaste(event: ReactClipboardEvent<HTMLDivElement>) {
    const text = event.clipboardData.getData("text/plain");
    if (!interactive || !ios || !selected || !text) return;
    event.preventDefault();
    callRef.current("/api/devices/input", { id: selected.id, action: "paste", text }).catch((pasteError: unknown) => setNotice(messageOf(pasteError)));
  }

  // Command shortcuts stay with X Bench except Command-K for the on-screen keyboard, and select all, copy and cut
  // on iOS. Command-V arrives as a paste event.
  function onKeyDown(event: ReactKeyboardEvent<HTMLDivElement>) {
    if (!interactive) return;
    if (event.metaKey) {
      if (event.shiftKey || event.altKey || event.ctrlKey) return;
      if (event.code === "KeyK") {
        event.preventDefault();
        if (!event.repeat) toggleKeyboard();
      } else if (ios && (event.code === "KeyC" || event.code === "KeyX")) {
        event.preventDefault();
        if (!event.repeat) copyFromDevice(event.code === "KeyX");
      } else if (ios && streaming && event.code === "KeyA") {
        event.preventDefault();
        if (!event.repeat) for (const [action, code] of [["down", 227], ["down", 4], ["up", 4], ["up", 227]] as const) sendKeyboard(action, code);
      }
      return;
    }
    const code = ios && streaming ? hidUsage(event.code) : undefined;
    if (code === undefined) return;
    event.preventDefault();
    if (event.repeat || keysDown.current.has(code)) return;
    if (sendKeyboard("down", code)) keysDown.current.add(code);
  }

  // The browser holds back key ups while Command is down, so letting go of Command lets go of the rest.
  function onKeyUp(event: ReactKeyboardEvent<HTMLDivElement>) {
    if (event.key === "Meta") {
      releaseKeys();
      return;
    }
    const code = hidUsage(event.code);
    if (code === undefined || !keysDown.current.delete(code)) return;
    event.preventDefault();
    sendKeyboard("up", code);
  }

  function toggleAppearance() {
    if (!selected) return;
    callRef.current("/api/devices/input", { id: selected.id, action: "appearance" }).catch((inputError: unknown) => setNotice(messageOf(inputError)));
  }

  function toggleKeyboard() {
    if (!selected) return;
    callRef.current("/api/devices/input", { id: selected.id, action: "keyboard", ...(keyboard === null ? {} : { show: !keyboard }) })
      .then((data) => {
        if (isRecord(data) && typeof data.keyboard === "boolean") setKeyboard(data.keyboard);
      })
      .catch((inputError: unknown) => setNotice(messageOf(inputError)));
  }

  function shake() {
    if (!selected) return;
    callRef.current("/api/devices/input", { id: selected.id, action: "shake" }).catch((inputError: unknown) => setNotice(messageOf(inputError)));
  }

  async function saveScreenshot() {
    if (!selected) return;
    try {
      const response = await apiFetch(`/api/devices/frame?id=${encodeURIComponent(selected.id)}`);
      if (!response.ok) throw new Error(errorOf(await response.json().catch(() => ({}))) || "Couldn't read the screen");
      const url = URL.createObjectURL(await response.blob());
      const link = document.createElement("a");
      link.href = url;
      link.download = saveName(selected);
      link.click();
      setTimeout(() => URL.revokeObjectURL(url), 1000);
    } catch (saveError) {
      setNotice(messageOf(saveError) || "Couldn't save the screenshot");
    }
  }

  function sendKey(key: string) {
    if (!selected) return;
    const socket = streamRef.current;
    if (streaming && socket?.readyState === WebSocket.OPEN) {
      socket.send(JSON.stringify({ type: "key", key }));
      return;
    }
    callRef.current("/api/devices/input", { id: selected.id, action: "key", key }).catch(() => {});
  }

  const loadStartable = useCallback(async (): Promise<StartableDevice[]> => {
    const data = await callRef.current("/api/devices/available", undefined, "GET", { silent: true });
    return sortStartable(startableDevices(data));
  }, []);

  // Boots the device, then shows it once the host lists it as running.
  async function startDevice(device: StartableDevice) {
    setStarting(device.name);
    setNotice("");
    try {
      const data = await callRef.current("/api/devices/boot", { id: device.id }, "POST", { silent: true });
      const id = isRecord(data) && typeof data.id === "string" ? data.id : "";
      const rows = listedDevices(await callRef.current("/api/devices", undefined, "POST", { quiet: true }));
      setDevices(rows);
      if (id) {
        lost.current = rows.some((row) => row.id === id) ? null : { id, name: device.name };
        setSelectedId(id);
      }
    } catch (startError) {
      setNotice(messageOf(startError) || `Couldn't start ${device.name}`);
    } finally {
      setStarting(null);
    }
  }

  const keys = ios ? IOS_KEYS : ANDROID_KEYS;
  // A device is picked and its first picture is on the way: the phone shows with a spinner on its screen.
  const loading = Boolean(starting) || (Boolean(selected) && !src && !streaming && !error && selected?.state !== "unauthorized");
  const frameStyle = fitted
    ? {
        width: fitted.width,
        height: fitted.height,
        padding: Math.round(fitted.width * shape.bezel),
        borderRadius: Math.round(fitted.width * (shape.radius + shape.bezel)),
      }
    : undefined;

  return (
    <section className="device-pane" data-testid="device-view">
      <div className="device-bar">
        <DevicePicker
          devices={devices}
          selectedId={selectedId}
          starting={starting}
          onSelect={(id) => {
            lost.current = null;
            setSelectedId(id);
          }}
          onStart={(device) => void startDevice(device)}
          loadStartable={loadStartable}
        />
        {ios && touchable === false ? <span className="device-status">View only · See Settings → Devices</span> : null}
      </div>
      <div
        ref={stageRef}
        className="device-stage"
        tabIndex={interactive ? 0 : undefined}
        onKeyDown={onKeyDown}
        onKeyUp={onKeyUp}
        onBlur={releaseKeys}
        onPaste={onPaste}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onPointerCancel={onPointerCancel}
        onDragStart={(event) => event.preventDefault()}
      >
        <div className={src || streaming || loading ? "device-frame" : "device-frame is-empty"} style={frameStyle}>
          <div className={starting ? "device-screen is-starting" : "device-screen"} style={fitted ? { borderRadius: Math.round(fitted.width * shape.radius) } : undefined}>
            <canvas
              ref={canvasRef}
              className={streaming ? "" : "device-stream-wait"}
              data-testid="device-stream"
              draggable={false}
            />
            {src && !streaming ? (
              <img
                ref={imgRef}
                src={src}
                alt=""
                data-testid="device-screen"
                draggable={false}
                onLoad={(event) => measured(event.currentTarget.naturalWidth, event.currentTarget.naturalHeight)}
              />
            ) : null}
            {loading ? <span className="device-loading" role="status" aria-label="Loading the screen" /> : null}
          </div>
        </div>
        {src || streaming || loading || !(error || notice || selected?.state === "unauthorized") ? null : (
          <p className="dock-empty">{selected?.state === "unauthorized" ? "Allow USB debugging on the emulator." : error || notice}</p>
        )}
        {(error || notice) && (src || streaming) ? <p className="device-error">{error || notice}</p> : null}
      </div>
      {selected && (src || streaming) ? (
        <div className="device-keys" role="toolbar" aria-label="Device controls">
          {interactive
            ? keys.map((item) => (
                <button key={item.key} type="button" className="icon" aria-label={item.label} data-tip={item.label} onClick={() => sendKey(item.key)}>
                  <item.icon />
                </button>
              ))
            : null}
          {interactive ? <span className="device-keys-gap" /> : null}
          {interactive ? (
            <button
              type="button"
              className="icon"
              aria-label={keyboard ? "Hide the on-screen keyboard" : "Show the on-screen keyboard"}
              aria-pressed={keyboard === true}
              data-tip={keyboard ? "Hide the on-screen keyboard (⌘K)" : "Show the on-screen keyboard (⌘K)"}
              onClick={toggleKeyboard}
            >
              <KeyboardIcon />
            </button>
          ) : null}
          {interactive && ios ? (
            <button type="button" className="icon" aria-label="Shake the device" data-tip="Shake the device" onClick={shake}>
              <ShakeIcon />
            </button>
          ) : null}
          <button type="button" className="icon" aria-label="Switch light and dark mode" data-tip="Switch light and dark mode" onClick={toggleAppearance}>
            <AppearanceIcon />
          </button>
          <button type="button" className="icon" aria-label="Save a screenshot" data-tip="Save a screenshot" onClick={() => void saveScreenshot()}>
            <CameraIcon />
          </button>
        </div>
      ) : null}
    </section>
  );
}

function HomeIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 16 16" aria-hidden="true">
      <path d="M2.75 7.4 8 3l5.25 4.4M4.25 6.3v6.95h2.6V9.7h2.3v3.55h2.6V6.3" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

function LockIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 16 16" aria-hidden="true">
      <rect x="3.25" y="7" width="9.5" height="6.75" rx="1.6" fill="none" stroke="currentColor" strokeWidth="1.4" />
      <path d="M5.5 7V5.2a2.5 2.5 0 0 1 5 0V7" fill="none" stroke="currentColor" strokeWidth="1.4" />
    </svg>
  );
}

function SiriIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 16 16" aria-hidden="true">
      <path d="M2.5 8h1.2M5.2 5.5v5M8 3v10M10.8 5.5v5M12.3 8h1.2" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" />
    </svg>
  );
}

function BackIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 16 16" aria-hidden="true">
      <path d="M10.5 3.5 5.5 8l5 4.5" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

function RecentsIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 16 16" aria-hidden="true">
      <rect x="3.25" y="3.25" width="9.5" height="9.5" rx="1.6" fill="none" stroke="currentColor" strokeWidth="1.4" />
    </svg>
  );
}

function ShakeIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 16 16" aria-hidden="true">
      <rect x="5.25" y="2.75" width="5.5" height="10.5" rx="1.4" fill="none" stroke="currentColor" strokeWidth="1.4" />
      <path d="M2.5 5.5c-.7.8-.7 4.2 0 5M13.5 5.5c.7.8.7 4.2 0 5" fill="none" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" />
    </svg>
  );
}

function KeyboardIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 16 16" aria-hidden="true">
      <rect x="1.75" y="4" width="12.5" height="8" rx="1.6" fill="none" stroke="currentColor" strokeWidth="1.3" />
      <path d="M4.25 6.6h.01M6.75 6.6h.01M9.25 6.6h.01M11.75 6.6h.01M4.25 9.4h.01M11.75 9.4h.01M6.4 9.4h3.2" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
    </svg>
  );
}

function AppearanceIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 16 16" aria-hidden="true">
      <circle cx="8" cy="8" r="5.25" fill="none" stroke="currentColor" strokeWidth="1.4" />
      <path d="M8 2.75a5.25 5.25 0 0 1 0 10.5z" fill="currentColor" />
    </svg>
  );
}

function CameraIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 16 16" aria-hidden="true">
      <path d="M2.75 5.75a1.5 1.5 0 0 1 1.5-1.5h1.3l1-1.5h2.9l1 1.5h1.3a1.5 1.5 0 0 1 1.5 1.5v5.5a1.5 1.5 0 0 1-1.5 1.5h-7.5a1.5 1.5 0 0 1-1.5-1.5z" fill="none" stroke="currentColor" strokeWidth="1.3" strokeLinejoin="round" />
      <circle cx="8" cy="8.4" r="2.1" fill="none" stroke="currentColor" strokeWidth="1.3" />
    </svg>
  );
}
