// H.264 access units to every viewer of one device, in the Device tab's stream messages: size and codec as
// text, then frames as a key flag byte and the length-prefixed NAL units. A viewer that joins or falls
// behind waits for the next key frame, and needKey asks the source for one.

import type { Size } from "./deviceMath.ts";
import { annexBNals, annexBToLength, avcCodec, type AvcCodec } from "./h264.ts";
import type { WebSocketConnection } from "../websocket.ts";

const BACKLOG = 1_000_000;

export interface VideoFanout {
  viewers: Set<WebSocketConnection>;
  add(viewer: WebSocketConnection): void;
  remove(viewer: WebSocketConnection): void;
  // One access unit in Annex B, with SPS and PPS before key frames, and the picture's size in pixels.
  frame(data: Buffer, size: Size): void;
  // Tells the viewers why, and closes their sockets so the page opens a new stream.
  end(reason: string): void;
}

export function createVideoFanout(needKey: () => void): VideoFanout {
  const viewers = new Set<WebSocketConnection>();
  const waitingForKey = new Set<WebSocketConnection>();
  let codec: AvcCodec | null = null;
  let config: Buffer[] = [];
  let size: Size | null = null;

  function sendCodec(viewer: WebSocketConnection) {
    if (size) viewer.sendText(JSON.stringify({ type: "size", format: "h264", width: size.width, height: size.height }));
    if (codec) viewer.sendText(JSON.stringify({ type: "codec", codec: codec.codec, description: codec.description.toString("base64") }));
  }

  function frame(data: Buffer, picture: Size) {
    const nals = annexBNals(data).filter((nal) => nal.length);
    const parameters = nals.filter((nal) => [7, 8].includes((nal[0] ?? 0) & 0x1f));
    if (parameters.length) {
      config = [...config.filter((nal) => !parameters.some((next) => ((next[0] ?? 0) & 0x1f) === ((nal[0] ?? 0) & 0x1f))), ...parameters];
      const joined = Buffer.concat(config.flatMap((nal) => [Buffer.from([0, 0, 0, 1]), nal]));
      const next = avcCodec(joined);
      const changed = size?.width !== picture.width || size.height !== picture.height;
      if (next && (changed || next.codec + next.description.toString("base64") !== (codec ? codec.codec + codec.description.toString("base64") : ""))) {
        codec = next;
        size = { width: Math.round(picture.width), height: Math.round(picture.height) };
        for (const viewer of viewers) sendCodec(viewer);
      }
    }
    const pictures = nals.filter((nal) => [1, 5].includes((nal[0] ?? 0) & 0x1f));
    if (!pictures.length || !codec) return;
    const key = pictures.some((nal) => ((nal[0] ?? 0) & 0x1f) === 5);
    const body = annexBToLength(Buffer.concat(pictures.flatMap((nal) => [Buffer.from([0, 0, 0, 1]), nal])));
    const message = Buffer.concat([Buffer.from([key ? 1 : 0]), body]);
    for (const viewer of viewers) {
      if (key) waitingForKey.delete(viewer);
      if (waitingForKey.has(viewer)) continue;
      if (!key && viewer.buffered() > BACKLOG) {
        waitingForKey.add(viewer);
        needKey();
        continue;
      }
      viewer.send(message);
    }
  }

  function add(viewer: WebSocketConnection) {
    viewers.add(viewer);
    sendCodec(viewer);
    waitingForKey.add(viewer);
  }

  function remove(viewer: WebSocketConnection) {
    viewers.delete(viewer);
    waitingForKey.delete(viewer);
  }

  function end(reason: string) {
    const text = JSON.stringify({ type: "error", message: reason });
    for (const viewer of [...viewers]) {
      viewer.sendText(text);
      viewer.close();
    }
    viewers.clear();
    waitingForKey.clear();
  }

  return { viewers, add, remove, frame, end };
}
