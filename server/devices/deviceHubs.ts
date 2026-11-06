// One stream hub per device, shared by every viewer of that device. The last viewer to leave stops it.

import type { WebSocketConnection } from "../websocket.ts";

export interface DeviceHub {
  viewers: Set<WebSocketConnection>;
  add(viewer: WebSocketConnection): void;
  remove(viewer: WebSocketConnection): void;
  stop(): void;
}

export interface DeviceHubs<H extends DeviceHub> {
  get(key: string): H | undefined;
  delete(key: string): void;
  // make gets the hub's onDead and answers null when the device cannot stream, which leaves the viewer out.
  watch(key: string, viewer: WebSocketConnection, make: (onDead: () => void) => H | null): () => void;
  close(): void;
}

export function createDeviceHubs<H extends DeviceHub>(): DeviceHubs<H> {
  const hubs = new Map<string, H>();

  function watch(key: string, viewer: WebSocketConnection, make: (onDead: () => void) => H | null): () => void {
    let hub = hubs.get(key);
    if (!hub) {
      let made: H | null = null;
      made = make(() => {
        if (made && hubs.get(key) === made) hubs.delete(key);
      });
      if (!made) return () => {};
      hub = made;
      hubs.set(key, made);
    }
    const joined = hub;
    joined.add(viewer);
    return () => {
      joined.remove(viewer);
      if (!joined.viewers.size) {
        if (hubs.get(key) === joined) hubs.delete(key);
        joined.stop();
      }
    };
  }

  function close() {
    for (const hub of hubs.values()) hub.stop();
    hubs.clear();
  }

  return { get: (key) => hubs.get(key), delete: (key) => hubs.delete(key), watch, close };
}
