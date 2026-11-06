import assert from "node:assert/strict";
import test from "node:test";
import { embedFiles, fileRefs, pendingFile, ticketFiles, ticketImageSrc, ticketVideoSrc } from "./ticketEmbeds.ts";

const web = "https://trello.com/1/cards/c1/attachments/a1/download/after.png";
const files = [
  { id: "10001", name: "shot.png", url: "https://site/rest/api/2/attachment/content/10001", type: "image/png" },
  { id: "10002", name: "image-2026 [1].jpg", url: null, type: "image/jpeg" },
  { id: "a1", name: "after.png", url: web, type: "image/png" },
  { id: 9, name: "local.png", url: "/api/files/9", type: "image/png" },
];

test("on a board that embeds by name, a picture named by a ticket file loads from the board API, and any other name stays", () => {
  const text = "Before !shot.png|width=300,alt=\"x\"! and !image-2026 [1].jpg! but not !gone.png! or !wow!";
  assert.deepEqual(fileRefs(text, true), ["shot.png", "image-2026 [1].jpg", "gone.png"]);
  assert.equal(
    embedFiles(text, "APP-1", files, true),
    "Before ![shot.png](/api/board/tasks/APP-1/files/10001) and ![image-2026 1.jpg](/api/board/tasks/APP-1/files/10002) but not !gone.png! or !wow!",
  );
  assert.deepEqual(fileRefs("Done! Shipped it!", true), []);
});

test("on any other board, a name between exclamation marks stays as written", () => {
  assert.deepEqual(fileRefs("See !shot.png!", false), []);
  assert.equal(embedFiles("See !shot.png!", 41, files, false), "See !shot.png!");
});

test("a picture by the url a source gives one of the ticket's files loads from the board API, and any other address stays", () => {
  const text = `![After](${web}), ![here](/api/files/9), ![logo](https://a.com/logo.png) and ![tmp](/tmp/a.png)`;
  assert.deepEqual(fileRefs(text, false), [web, "/api/files/9", "https://a.com/logo.png", "/tmp/a.png"]);
  assert.equal(
    embedFiles(text, "c1", files, false),
    "![After](/api/board/tasks/c1/files/a1), ![here](/api/board/tasks/c1/files/9), ![logo](https://a.com/logo.png) and ![tmp](/tmp/a.png)",
  );
});

test("a clip of the ticket plays from the board API by its url or its name, and a picture stays a picture", () => {
  const clips = [
    { id: 9, name: "run.mov", url: "/api/files/9", type: "video/quicktime" },
    { id: 10, name: "shot.png", url: "/api/files/10", type: "image/png" },
    { id: 11, name: "cut.webm", url: "/api/files/11", type: "video/webm" },
  ];
  assert.equal(
    embedFiles("![run](/api/files/9) ![shot](/api/files/10) !cut.webm! ![gone](/api/files/12)", 41, clips, true),
    "![run](/api/board/tasks/41/files/9.mov) ![shot](/api/board/tasks/41/files/10) ![cut.webm](/api/board/tasks/41/files/11.webm) ![gone](/api/files/12)",
  );
  assert.equal(ticketVideoSrc("/api/board/tasks/41/files/9.mov"), "/api/board/tasks/41/files/9.mov");
  assert.equal(ticketVideoSrc("/tmp/cut.mp4"), null);
});

test("while the file list loads, every picture that needs it points at the pending file", () => {
  const pending = pendingFile("c1");
  assert.equal(pending, "/api/board/tasks/c1/files/pending");
  assert.equal(
    embedFiles(`!shot.png! and ![After](${web}) and ![x](/api/files/9)`, "c1", null, true),
    `![shot.png](${pending}) and ![After](${pending}) and ![x](${pending})`,
  );
});

test("only a file route of the board API loads as a ticket picture", () => {
  assert.equal(ticketImageSrc("/api/board/tasks/APP-1/files/10001"), "/api/board/tasks/APP-1/files/10001");
  assert.equal(ticketImageSrc("/api/files/9"), null);
  assert.equal(ticketImageSrc("/tmp/a.png"), null);
});

test("the file list reads ids, names, urls and types and skips what is no file", () => {
  assert.deepEqual(ticketFiles({ files: [{ id: 9, name: "a.png", url: "/api/files/9", content_type: "image/png", size: 3 }, "x", null] }), [
    { id: 9, name: "a.png", url: "/api/files/9", type: "image/png" },
  ]);
  assert.deepEqual(ticketFiles({ error: "nope" }), []);
});
