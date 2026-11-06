import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import zlib from "node:zlib";
import { composePrompt, withThumbnails, type PromptBlock } from "./attachments.ts";

function resourceOf(block: PromptBlock | undefined) {
  assert.ok(block?.type === "resource", "not a resource block");
  return block.resource;
}

test("text, images, and files become prompt blocks", () => {
  const png = Buffer.from("png-bytes").toString("base64");
  const notes = Buffer.from("hello").toString("base64");
  const pdf = Buffer.from("%PDF").toString("base64");
  const prompt = composePrompt("look", [
    { name: "shot.png", mimeType: "image/png", data: png },
    { name: "../notes.txt", mimeType: "text/plain", data: notes },
    { name: "spec.pdf", mimeType: "application/pdf", data: pdf },
  ]);
  assert.equal(prompt.text, "look");
  assert.deepEqual(
    prompt.attachments.map((file) => file.name),
    ["shot.png", "notes.txt", "spec.pdf"],
  );
  assert.deepEqual(prompt.blocks[0], { type: "text", text: "look" });
  assert.deepEqual(prompt.blocks[1], { type: "image", mimeType: "image/png", data: png });
  assert.equal(resourceOf(prompt.blocks[2]).text, "hello");
  assert.equal(resourceOf(prompt.blocks[2]).uri, "attachment:notes.txt");
  assert.equal(resourceOf(prompt.blocks[3]).blob, pdf);
});

test("a picture alone is enough to send", () => {
  const png = Buffer.from("png").toString("base64");
  const prompt = composePrompt("  ", [{ name: "Pasted image.png", mimeType: "image/png", data: png }]);
  assert.equal(prompt.text, "");
  assert.equal(prompt.blocks[0]?.type, "image");
  assert.equal(prompt.attachments[0]?.name, "Pasted image.png");
  assert.equal(prompt.attachments[0]?.kind, "image");
});

test("a copied file path is read from disk", () => {
  const filePath = path.join(os.tmpdir(), `x-bench-paste-${process.pid}.txt`);
  fs.writeFileSync(filePath, "from finder");
  try {
    const prompt = composePrompt("", [{ path: filePath }]);
    assert.equal(prompt.text, "");
    assert.equal(prompt.attachments[0]?.name, path.basename(filePath));
    assert.equal(resourceOf(prompt.blocks[0]).text, "from finder");
  } finally {
    fs.unlinkSync(filePath);
  }
});

test("a picture copied by path keeps that picture as its preview", () => {
  const filePath = path.join(os.tmpdir(), `x-bench-shot-${process.pid}.png`);
  const png = Buffer.from(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
    "base64",
  );
  fs.writeFileSync(filePath, png);
  try {
    const prompt = composePrompt("", [{ path: filePath }]);
    assert.equal(prompt.attachments[0]?.kind, "image");
    assert.equal(prompt.attachments[0]?.preview, `data:image/png;base64,${png.toString("base64")}`);
    assert.equal(prompt.blocks[0]?.type, "image");
  } finally {
    fs.unlinkSync(filePath);
  }
});

test("a large picture copied by path is shrunk to a thumbnail", async () => {
  const filePath = path.join(os.tmpdir(), `x-bench-large-${process.pid}.png`);
  fs.writeFileSync(filePath, noisyPng(240, 240));
  try {
    assert.equal(composePrompt("", [{ path: filePath }]).attachments[0]?.preview, undefined);
    const prompt = await withThumbnails(composePrompt("", [{ path: filePath }]));
    const preview = prompt.attachments[0]?.preview ?? "";
    const block = prompt.blocks[0];
    assert.equal(block?.type, "image");
    if (block?.type === "image") assert.ok(block.data.length > 150000);
    assert.match(preview, /^data:image\/jpeg;base64,/);
    assert.ok(preview.length <= 150000);
  } finally {
    fs.unlinkSync(filePath);
  }
});

test("a preview sent with the picture is kept", () => {
  const png = Buffer.from("png").toString("base64");
  const preview = "data:image/png;base64,iVBORw0KGgo";
  const prompt = composePrompt("", [{ name: "shot.png", mimeType: "image/png", data: png, preview }]);
  assert.equal(prompt.attachments[0]?.preview, preview);
});

test("bad attachments are refused before a prompt is sent", () => {
  assert.throws(() => composePrompt("   ", []), /Write a prompt first/);
  assert.throws(() => composePrompt("hi", [{ name: "x.txt", data: "not base64" }]), /unreadable/);
  assert.throws(() => composePrompt("hi", [{ path: path.join(os.tmpdir(), "missing-x-bench-file.txt") }]), /Couldn't read/);
  assert.throws(() => composePrompt("hi", [{ path: os.tmpdir() }]), /not a file/);
  const tooMany = Array.from({ length: 11 }, (_, index) => ({
    name: `f${index}.txt`,
    mimeType: "text/plain",
    data: Buffer.from("x").toString("base64"),
  }));
  assert.throws(() => composePrompt("hi", tooMany), /up to 10/);
});

function noisyPng(width: number, height: number): Buffer {
  const raw = Buffer.alloc((width * 3 + 1) * height);
  for (let y = 0; y < height; y += 1) {
    const start = y * (width * 3 + 1);
    raw[start] = 0;
    crypto.randomFillSync(raw, start + 1, width * 3);
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;
  ihdr[9] = 2;
  return Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    pngChunk("IHDR", ihdr),
    pngChunk("IDAT", zlib.deflateSync(raw)),
    pngChunk("IEND", Buffer.alloc(0)),
  ]);
}

function pngChunk(type: string, data: Buffer): Buffer {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(zlib.crc32(body));
  return Buffer.concat([length, body, crc]);
}
