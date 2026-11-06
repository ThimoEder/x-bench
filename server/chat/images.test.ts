import assert from "node:assert/strict";
import test from "node:test";
import type { UserItem } from "../../bridge/reducer.ts";
import { toolImage } from "./images.ts";

const png = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";

test("toolImage returns the stored screenshot bytes", () => {
  const session = {
    transcript: [{ type: "tool", toolCallId: "call-shot", images: [{ mimeType: "image/png", data: png }] }],
  };
  const image = toolImage(session, "call-shot", 0);
  assert.equal(image?.mimeType, "image/png");
  assert.equal(image?.body[0], 0x89);
  assert.equal(toolImage(session, "call-shot", 1), null);
  assert.equal(toolImage(session, "other", 0), null);
  const picture: UserItem = { id: "user-2", type: "user", text: "", streaming: false, images: [{ mimeType: "image/png", data: png }] };
  const mine = toolImage({ transcript: [picture] }, "user-2", 0);
  assert.equal(mine?.mimeType, "image/png");
  assert.equal(mine?.body[0], 0x89);
});
