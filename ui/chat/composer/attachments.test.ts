import assert from "node:assert/strict";
import { Buffer } from "node:buffer";
import test from "node:test";
import {
  attachmentFromPath,
  attachmentRecord,
  filesFromDataTransfer,
  mergeAttachments,
  pathsFromDataTransfer,
  wireAttachments,
  withoutAttachment,
  MAX_ATTACHMENT_BYTES,
  type Attachment,
  type AttachmentResult,
  type DataAttachment,
} from "./attachments.ts";

function accepted(result: AttachmentResult): DataAttachment {
  assert.ok(result.attachment, `refused: ${result.error}`);
  return result.attachment;
}

function refused(result: AttachmentResult): string {
  assert.ok(result.error, "the file was accepted");
  return result.error;
}

function dataAt(list: Attachment[], index: number): DataAttachment {
  const item = list.at(index);
  assert.ok(item?.data !== undefined, `no data attachment at ${index}`);
  return item;
}

test("paste collects clipboard files once, including images copied as items", () => {
  const image = { name: "image.png", size: 4, type: "image/png", lastModified: 1 };
  const again = { name: "image.png", size: 4, type: "image/png", lastModified: 9 };
  const notes = { name: "notes.txt", size: 5, type: "text/plain", lastModified: 2 };
  const transfer = {
    files: [image, notes],
    items: [
      { kind: "file", getAsFile: () => again },
      { kind: "string", getAsFile: () => null },
    ],
  };
  assert.deepEqual(filesFromDataTransfer(transfer), [image, notes]);
});

test("removing a paste lets the same image keep its name", () => {
  const image = (id: string) =>
    accepted(
      attachmentRecord({
        name: "image.png",
        mimeType: "image/png",
        bytes: Uint8Array.from([1, 2, 3, 4]),
        id,
      }),
    );
  const first = mergeAttachments([], [image("1"), image("2")]);
  assert.deepEqual(
    first.attachments.map((file) => file.name),
    ["image.png"],
  );
  assert.match(dataAt(first.attachments, 0).previewUrl, /^data:image\/png;base64,/);
  const cleared = withoutAttachment(first.attachments, dataAt(first.attachments, 0).id);
  const again = mergeAttachments(cleared, [image("3")]);
  assert.deepEqual(
    again.attachments.map((file) => file.name),
    ["image.png"],
  );
});

test("a copied Finder file URL becomes a path attachment", () => {
  const transfer = {
    getData(type: string) {
      if (type !== "text/uri-list") return "";
      return "# comment\nfile:///Users/me/My%20Shot.png\nfile:///Users/me/notes.txt\n";
    },
  };
  assert.deepEqual(pathsFromDataTransfer(transfer), ["/Users/me/My Shot.png", "/Users/me/notes.txt"]);
  const chip = attachmentFromPath({ filePath: "/Users/me/My Shot.png", id: "a" });
  assert.equal(chip.name, "My Shot.png");
  assert.equal(chip.kind, "image");
  assert.equal(chip.path, "/Users/me/My Shot.png");
  assert.deepEqual(wireAttachments([chip]), [{ name: "My Shot.png", mimeType: "image/png", path: "/Users/me/My Shot.png" }]);
});

test("plain text paste is not treated as files", () => {
  assert.deepEqual(filesFromDataTransfer({ files: [], items: [], getData: () => "see notes.txt" }), []);
  assert.deepEqual(pathsFromDataTransfer({ getData: () => "" }), []);
});

test("several files can be attached and removed", () => {
  const first = accepted(
    attachmentRecord({
      name: "shot.png",
      mimeType: "image/png",
      bytes: Uint8Array.from([1, 2, 3, 4]),
      id: "1",
    }),
  );
  const second = accepted(
    attachmentRecord({
      name: "shot.png",
      mimeType: "",
      bytes: Uint8Array.from([5]),
      id: "2",
    }),
  );
  const third = accepted(
    attachmentRecord({
      name: "notes.txt",
      mimeType: "text/plain",
      bytes: Uint8Array.from([104, 105]),
      id: "3",
    }),
  );
  const merged = mergeAttachments([first], [second, third]);
  assert.deepEqual(
    merged.attachments.map((file) => file.name),
    ["shot.png", "shot 2.png", "notes.txt"],
  );
  assert.equal(merged.attachments[1]?.kind, "image");
  assert.equal(withoutAttachment(merged.attachments, "2").some((file) => file.id === "2"), false);
  assert.equal(wireAttachments([third])[0]?.data, Buffer.from("hi").toString("base64"));
});

test("an empty or oversized paste is refused", () => {
  assert.match(refused(attachmentRecord({ name: "empty.png", mimeType: "image/png", bytes: new Uint8Array(), id: "e" })), /empty/);
  const huge = attachmentRecord({
    name: "big.png",
    mimeType: "image/png",
    bytes: new ArrayBuffer(MAX_ATTACHMENT_BYTES + 1),
    id: "b",
  });
  assert.match(refused(huge), /8 MB/);
});
