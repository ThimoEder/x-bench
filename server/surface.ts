// The window shows one surface at a time. The other surface's panes stay parked
// on the same desk object, and a later switch puts those ids back.

import type { Desk } from "./desk.ts";
import type { Surface } from "./snapshot.ts";

export interface Surfaces {
  surface(): Surface;
  parked(mode: Surface): string[];
  allowsBeside(): boolean;
  show(next: unknown): Surface;
  drop(id: string): void;
}

export interface SurfaceOptions {
  // False for a session that left the bridge, so it is not restored.
  alive?: (id: string) => boolean;
}

export function createSurfaces(desk: Desk, { alive = () => true }: SurfaceOptions = {}): Surfaces {
  const parked: Record<Surface, string[]> = { builder: [], chat: [] };
  let surface: Surface = "builder";

  return {
    surface() {
      return surface;
    },
    parked(mode) {
      return [...parked[mode]];
    },
    allowsBeside() {
      return surface === "builder";
    },
    show(next) {
      if (next !== "builder" && next !== "chat") throw new Error("Unknown surface");
      if (next === surface) return surface;
      parked[surface] = desk.ids();
      surface = next;
      desk.clear();
      const limit = next === "chat" ? 1 : 2;
      for (const id of parked[next].slice(0, limit)) {
        if (!alive(id)) continue;
        if (!desk.add(id).ok) break;
      }
      return surface;
    },
    drop(id) {
      desk.remove(id);
      parked.builder = parked.builder.filter((item) => item !== id);
      parked.chat = parked.chat.filter((item) => item !== id);
    },
  };
}
