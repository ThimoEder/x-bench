import assert from "node:assert/strict";
import test from "node:test";
import { createDeviceHubs, type DeviceHub } from "./deviceHubs.ts";
import type { WebSocketConnection } from "../websocket.ts";

function hub(): DeviceHub & { stopped: number } {
  const viewers = new Set<WebSocketConnection>();
  const made = {
    viewers,
    stopped: 0,
    add: (viewer: WebSocketConnection) => void viewers.add(viewer),
    remove: (viewer: WebSocketConnection) => void viewers.delete(viewer),
    stop: () => void made.stopped++,
  };
  return made;
}

const viewer = () => ({}) as WebSocketConnection;

test("viewers of one device share a hub that stops when the last leaves", () => {
  const hubs = createDeviceHubs<ReturnType<typeof hub>>();
  let makes = 0;
  const make = () => (makes++, hub());
  const leaveA = hubs.watch("a", viewer(), make);
  const leaveB = hubs.watch("a", viewer(), make);
  const shared = hubs.get("a");
  assert.equal(makes, 1);
  assert.equal(shared?.viewers.size, 2);
  leaveA();
  assert.equal(shared?.stopped, 0);
  leaveB();
  assert.equal(shared?.stopped, 1);
  assert.equal(hubs.get("a"), undefined);
});

test("a dead hub leaves the registry and the next viewer gets a new one", () => {
  const hubs = createDeviceHubs<ReturnType<typeof hub>>();
  let dead = () => {};
  hubs.watch("a", viewer(), (onDead) => ((dead = onDead), hub()));
  const first = hubs.get("a");
  dead();
  assert.equal(hubs.get("a"), undefined);
  hubs.watch("a", viewer(), hub);
  assert.notEqual(hubs.get("a"), first);
  dead();
  assert.ok(hubs.get("a"), "a stale hub's onDead leaves its replacement alone");
});

test("a device that cannot stream gets no hub", () => {
  const hubs = createDeviceHubs<ReturnType<typeof hub>>();
  const leave = hubs.watch("a", viewer(), () => null);
  assert.equal(hubs.get("a"), undefined);
  leave();
});

test("close stops every hub", () => {
  const hubs = createDeviceHubs<ReturnType<typeof hub>>();
  hubs.watch("a", viewer(), hub);
  hubs.watch("b", viewer(), hub);
  const made = [hubs.get("a"), hubs.get("b")];
  hubs.close();
  assert.deepEqual(made.map((item) => item?.stopped), [1, 1]);
  assert.equal(hubs.get("a"), undefined);
});
