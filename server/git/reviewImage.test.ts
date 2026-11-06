import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, mkdir, rm, symlink, writeFile } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import {
  byteRange,
  findLocalVideo,
  findReplyVideo,
  readLocalImage,
  readReplyImage,
  readReviewImage,
  repoRelative,
  sendVideo,
  sessionImagePath,
  videoExtension,
} from "./reviewImage.ts";

const png = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
  "base64",
);
const next = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==",
  "base64",
);

test("a review image path stays inside the repository", () => {
  assert.equal(repoRelative("/repo", "shots/a.png"), "shots/a.png");
  assert.equal(repoRelative("/repo", "/repo/shots/a.png"), "shots/a.png");
  assert.equal(repoRelative("/repo", "/repo/notes.txt"), "");
  assert.equal(repoRelative("/repo", "../secret.png"), "");
  assert.equal(repoRelative("/repo", "shots/../../secret.png"), "");
  assert.equal(repoRelative("/repo", "/etc/passwd.png"), "");
  assert.equal(repoRelative("/repo", "shots/a.png\0.png"), "");
});

test("before is the committed picture and after is the working copy", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "review-image-"));
  try {
    await mkdir(path.join(dir, "shots"));
    await writeFile(path.join(dir, "shots", "dot.png"), png);
    await git(dir, ["init", "-b", "main"]);
    await git(dir, ["add", "shots/dot.png"]);
    await git(dir, ["commit", "-m", "add"]);
    await writeFile(path.join(dir, "shots", "dot.png"), next);
    await writeFile(path.join(dir, "gone.png"), png);
    await git(dir, ["add", "gone.png"]);
    await git(dir, ["commit", "-m", "gone"]);
    await rm(path.join(dir, "gone.png"));
    await symlink("/etc/passwd", path.join(dir, "link.png"));

    const before = await readReviewImage({ cwd: dir, filePath: "shots/dot.png", side: "before" });
    const after = await readReviewImage({ cwd: path.join(dir, "shots"), filePath: "shots/dot.png", side: "after" });
    const absolute = await readReviewImage({ cwd: dir, filePath: path.join(dir, "shots", "dot.png"), side: "after" });
    const deleted = await readReviewImage({ cwd: dir, filePath: "gone.png", side: "before" });
    const missing = await readReviewImage({ cwd: dir, filePath: "gone.png", side: "after" });
    const escaped = await readReviewImage({ cwd: dir, filePath: "../dot.png", side: "after" });
    const linked = await readReviewImage({ cwd: dir, filePath: "link.png", side: "after" });

    assert.equal(before?.mimeType, "image/png");
    assert.deepEqual(before?.body, png);
    assert.deepEqual(after?.body, next);
    assert.deepEqual(absolute?.body, next);
    assert.deepEqual(deleted?.body, png);
    assert.equal(missing, null);
    assert.equal(escaped, null);
    assert.equal(linked, null);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("a picture larger than the preview limit is skipped", async () => {
  const image = await readReviewImage({
    cwd: "/repo",
    filePath: "a.png",
    side: "after",
    maxBytes: 3,
    git: async () => "/repo\n",
    locate: async (file) => file,
    read: async () => Buffer.from("1234"),
  });
  assert.equal(image, null);
});

function git(cwd: string, args: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(
      "git",
      ["-C", cwd, ...args],
      {
        env: {
          ...process.env,
          GIT_AUTHOR_NAME: "review",
          GIT_AUTHOR_EMAIL: "review@example.com",
          GIT_COMMITTER_NAME: "review",
          GIT_COMMITTER_EMAIL: "review@example.com",
        },
      },
      (error, stdout, stderr) => {
        if (error) reject(new Error(String(stderr || error.message).trim()));
        else resolve(stdout);
      },
    );
  });
}

test("a local picture is read by its absolute path, wherever it is", async () => {
  const image = await readLocalImage("/tmp/shot.png", {
    locate: async (file) => file,
    size: async () => 4,
    read: async () => Buffer.from("png!"),
  });
  assert.equal(image?.mimeType, "image/png");
  assert.equal(image?.body.toString(), "png!");
});

test("a local picture must be one by its real name, absolute, and not too large", async () => {
  const never = async (): Promise<Buffer> => {
    throw new Error("must not read");
  };
  const base = { size: async () => 4, read: never };
  assert.equal(await readLocalImage("/tmp/shot.png", { ...base, locate: async () => "/etc/passwd" }), null);
  assert.equal(await readLocalImage("shot.png", { ...base, locate: async (file) => file }), null);
  assert.equal(await readLocalImage("/tmp/notes.txt", { ...base, locate: async (file) => file }), null);
  assert.equal(await readLocalImage("/tmp/shot.png", { ...base, locate: async (file) => file, size: async () => 9 * 1024 * 1024 }), null);
  assert.equal(await readLocalImage("/tmp/folder.png", { ...base, locate: async (file) => file, size: async () => null }), null);
});

test("images/<file> that is missing from the project is the chat's picture", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "x-bench-session-images-"));
  const project = await mkdtemp(path.join(tmpdir(), "x-bench-project-"));
  const id = "01a0f478-5f87-7f63-9495-798c9853d100";
  const dir = path.join(root, encodeURIComponent(project), id);
  try {
    await mkdir(path.join(dir, "images"), { recursive: true });
    await writeFile(path.join(dir, "images", "shot.png"), png);
    await writeFile(path.join(dir, "summary.json"), JSON.stringify({ info: { id, cwd: project } }));
    const asked = path.join(project, "images", "shot.png");
    assert.equal(sessionImagePath(dir, project, asked), path.join(dir, "images", "shot.png"));
    assert.equal(sessionImagePath(dir, project, path.join(project, "shots", "shot.png")), "");
    assert.equal(sessionImagePath(dir, project, path.join(project, "images", "..", "shot.png")), "");
    const found = await readReplyImage(asked, { cwd: project, sessionId: id, sessionRoot: root });
    assert.equal(found?.body.equals(png), true);
    assert.equal(await readReplyImage(path.join(project, "shots", "home.png"), { cwd: project, sessionId: id, sessionRoot: root }), null);
    await mkdir(path.join(project, "images"), { recursive: true });
    await writeFile(path.join(project, "images", "shot.png"), next);
    const projectFile = await readReplyImage(asked, { cwd: project, sessionId: id, sessionRoot: root });
    assert.equal(projectFile?.body.equals(next), true);
  } finally {
    await rm(root, { recursive: true, force: true });
    await rm(project, { recursive: true, force: true });
  }
});

test("a local video must be one by its real name, absolute, and not empty", async () => {
  const same = async (file: string) => file;
  assert.deepEqual(await findLocalVideo("/tmp/cut.MOV", { locate: same, size: async () => 9 * 1024 * 1024 * 1024 }), {
    file: "/tmp/cut.MOV",
    size: 9 * 1024 * 1024 * 1024,
    mimeType: "video/quicktime",
  });
  assert.equal((await findLocalVideo("/tmp/a.m4v", { locate: same, size: async () => 1 }))?.mimeType, "video/mp4");
  assert.equal((await findLocalVideo("/tmp/a.webm", { locate: same, size: async () => 1 }))?.mimeType, "video/webm");
  assert.equal(await findLocalVideo("/tmp/cut.mp4", { locate: async () => "/etc/passwd", size: async () => 1 }), null);
  assert.equal(await findLocalVideo("cut.mp4", { locate: same, size: async () => 1 }), null);
  assert.equal(await findLocalVideo("/tmp/a\nb.mp4", { locate: same, size: async () => 1 }), null);
  assert.equal(await findLocalVideo("/tmp/cut.avi", { locate: same, size: async () => 1 }), null);
  assert.equal(await findLocalVideo("/tmp/cut.mp4", { locate: same, size: async () => 0 }), null);
  assert.equal(await findLocalVideo("/tmp/folder.mp4", { locate: same, size: async () => null }), null);
  assert.equal(videoExtension("/tmp/.mp4"), "");
});

test("images/<file> that is missing from the project is the chat's video", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "x-bench-session-videos-"));
  const project = await mkdtemp(path.join(tmpdir(), "x-bench-project-"));
  const id = "01a0f478-5f87-7f63-9495-798c9853d101";
  const dir = path.join(root, encodeURIComponent(project), id);
  try {
    await mkdir(path.join(dir, "images"), { recursive: true });
    await writeFile(path.join(dir, "images", "cut.mp4"), "video");
    await writeFile(path.join(dir, "images", "shot.png"), png);
    await writeFile(path.join(dir, "summary.json"), JSON.stringify({ info: { id, cwd: project } }));
    const found = await findReplyVideo(path.join(project, "images", "cut.mp4"), { cwd: project, sessionId: id, sessionRoot: root });
    assert.equal(found?.size, 5);
    assert.equal(found?.mimeType, "video/mp4");
    assert.equal(await findReplyVideo(path.join(project, "images", "shot.png"), { cwd: project, sessionId: id, sessionRoot: root }), null);
    assert.equal(await findReplyVideo(path.join(project, "clips", "cut.mp4"), { cwd: project, sessionId: id, sessionRoot: root }), null);
  } finally {
    await rm(root, { recursive: true, force: true });
    await rm(project, { recursive: true, force: true });
  }
});

test("a Range header asks for one span of the file", () => {
  assert.equal(byteRange(undefined, 10), null);
  assert.deepEqual(byteRange("bytes=0-", 10), { start: 0, end: 9 });
  assert.deepEqual(byteRange("bytes=2-4", 10), { start: 2, end: 4 });
  assert.deepEqual(byteRange("bytes=8-100", 10), { start: 8, end: 9 });
  assert.deepEqual(byteRange("bytes=-3", 10), { start: 7, end: 9 });
  assert.deepEqual(byteRange("bytes=-30", 10), { start: 0, end: 9 });
  assert.equal(byteRange("bytes=10-", 10), "unsatisfiable");
  assert.equal(byteRange("bytes=-0", 10), "unsatisfiable");
  assert.equal(byteRange("bytes=5-2", 10), null);
  assert.equal(byteRange("bytes=0-1,4-5", 10), null);
  assert.equal(byteRange("items=0-1", 10), null);
});

test("a video streams whole, or the span a Range request asks for", async () => {
  const folder = await mkdtemp(path.join(tmpdir(), "x-bench-video-"));
  const file = path.join(folder, "cut.mp4");
  await writeFile(file, "0123456789");
  const video = { file, size: 10, mimeType: "video/mp4" };
  const server: Server = createServer((req, res) => sendVideo(req, res, video));
  await new Promise<void>((resolve) => {
    server.listen(0, "127.0.0.1", resolve);
  });
  const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/`;
  try {
    const whole = await fetch(url);
    assert.equal(whole.status, 200);
    assert.equal(whole.headers.get("accept-ranges"), "bytes");
    assert.equal(whole.headers.get("content-type"), "video/mp4");
    assert.equal(whole.headers.get("content-length"), "10");
    assert.equal(await whole.text(), "0123456789");

    const part = await fetch(url, { headers: { Range: "bytes=2-5" } });
    assert.equal(part.status, 206);
    assert.equal(part.headers.get("content-range"), "bytes 2-5/10");
    assert.equal(part.headers.get("content-length"), "4");
    assert.equal(await part.text(), "2345");

    const tail = await fetch(url, { headers: { Range: "bytes=7-" } });
    assert.equal(tail.status, 206);
    assert.equal(tail.headers.get("content-range"), "bytes 7-9/10");
    assert.equal(await tail.text(), "789");

    const beyond = await fetch(url, { headers: { Range: "bytes=10-" } });
    assert.equal(beyond.status, 416);
    assert.equal(beyond.headers.get("content-range"), "bytes */10");
    assert.equal(await beyond.text(), "");
  } finally {
    await new Promise((resolve) => {
      server.close(resolve);
    });
    await rm(folder, { recursive: true, force: true });
  }
});
