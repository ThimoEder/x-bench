import assert from "node:assert/strict";
import test from "node:test";
import { imageExtension, imageRev, imageSides, imageSrc, patchParts, trackImageRev } from "./imageDiff.ts";

test("picture extensions are recognized and other files are not", () => {
  assert.equal(imageExtension("shots/Icon.PNG"), "png");
  assert.equal(imageExtension("a.jpeg"), "jpeg");
  assert.equal(imageExtension("face.webp"), "webp");
  assert.equal(imageExtension("logo.svg"), "svg");
  assert.equal(imageExtension("notes.md"), "");
  assert.equal(imageExtension("archive.tar.png.bak"), "");
  assert.equal(imageExtension(".png"), "");
});

test("an added or deleted picture previews only the side that exists", () => {
  assert.deepEqual(imageSides({ path: "a.png", type: "add" }, "Binary files a/a.png and b/a.png differ"), {
    before: false,
    after: true,
  });
  assert.deepEqual(imageSides({ path: "a.png", type: "deleted" }, ""), { before: true, after: false });
  assert.deepEqual(
    imageSides({ path: "a.png" }, "new file mode 100644\nBinary files /dev/null and b/a.png differ"),
    { before: false, after: true },
  );
  assert.deepEqual(
    imageSides({ path: "a.png" }, "deleted file mode 100644\nBinary files a/a.png and /dev/null differ"),
    { before: true, after: false },
  );
});

test("a changed picture previews both versions and a text file stays a diff", () => {
  const patch = "index aaa..bbb 100644\nBinary files a/a.png and b/a.png differ";
  assert.deepEqual(imageSides({ path: "a.png", type: "edit" }, patch), { before: true, after: true });
  assert.deepEqual(imageSides({ path: "a.png" }, null), { before: true, after: true });
  assert.equal(imageSides({ path: "a.js", type: "edit" }, "Binary files a/a.js and b/a.js differ"), null);
});

test("the preview url points at the review image and changes when the blob pair changes", () => {
  assert.equal(
    imageSrc("ses sion", "shots/a b.png", "before", ""),
    "/api/git/image?sessionId=ses+sion&path=shots%2Fa+b.png&side=before",
  );
  assert.equal(imageRev("index ab12..cd34 100644\nBinary files a/a.png and b/a.png differ"), "ab12..cd34");
  assert.equal(imageRev("@@ -1 +1 @@"), "");
  const first = trackImageRev({ seen: "", shown: "" }, "ab12..cd34");
  assert.deepEqual(first, { seen: "ab12..cd34", shown: "" });
  assert.equal(trackImageRev(first, "ab12..cd34"), first);
  assert.deepEqual(trackImageRev(first, "ab12..ffff"), { seen: "ab12..ffff", shown: "ab12..ffff" });
});

test("a picture keeps the diff header and drops the binary line", () => {
  const binary = [
    "diff --git a/docs/screenshots/radius-with-top.png b/docs/screenshots/radius-with-top.png",
    "new file mode 100644",
    "index 0000000..12e233d",
    "Binary files /dev/null and b/docs/screenshots/radius-with-top.png differ",
  ].join("\n");
  assert.deepEqual(patchParts(binary), {
    header: [
      "diff --git a/docs/screenshots/radius-with-top.png b/docs/screenshots/radius-with-top.png",
      "new file mode 100644",
      "index 0000000..12e233d",
    ].join("\n"),
    body: "",
  });
  const text = [
    "diff --git a/server/index.js b/server/index.js",
    "index 31c5ea5..9922626 100644",
    "--- a/server/index.js",
    "+++ b/server/index.js",
    "@@ -1 +1 @@",
    "-old",
    "+new",
  ].join("\n");
  assert.equal(
    patchParts(text).header,
    ["diff --git a/server/index.js b/server/index.js", "index 31c5ea5..9922626 100644", "--- a/server/index.js", "+++ b/server/index.js"].join("\n"),
  );
  assert.equal(patchParts(text).body, "@@ -1 +1 @@\n-old\n+new");
});

