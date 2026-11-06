import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { directChildren, folderPathOf, insideFolder, resolveInFolder } from "./files.ts";

test("direct children drop nested files and sort directories first", () => {
  const nodes = directChildren("/work/app", [
    { name: "main.js", path: "/work/app/src/main.js", type: "file" },
    { name: "README.md", path: "/work/app/README.md", type: "file" },
    { name: "src", path: "/work/app/src", type: "directory" },
    { name: "app", path: "/work/app", type: "directory" },
  ]);
  assert.deepEqual(
    nodes.map((node) => node.name),
    ["src", "README.md"],
  );
  assert.equal(insideFolder("/work/app", "/work/app/src"), true);
  assert.equal(insideFolder("/work/app", "/etc"), false);
  assert.equal(resolveInFolder("/work/app", "src/a.js"), "/work/app/src/a.js");
  assert.equal(resolveInFolder("/work/app", "/work/app/src/a.js"), "/work/app/src/a.js");
  assert.equal(resolveInFolder("/work/app", "../../etc/passwd"), "/etc/passwd");
  assert.equal(resolveInFolder("/work/app", ""), "");
});

test("a file is in the session folder only after .. and symlinks are resolved, and keeps the folder's spelling", () => {
  const base = realpathSync(mkdtempSync(path.join(os.tmpdir(), "x-bench-where-")));
  try {
    const root = path.join(base, "project");
    mkdirSync(path.join(root, "src"), { recursive: true });
    writeFileSync(path.join(root, "src", "a.ts"), "");
    mkdirSync(path.join(base, "outside"));
    writeFileSync(path.join(base, "outside", "b.ts"), "");
    // Another name for the same folder, as /tmp is for /private/tmp on macOS.
    symlinkSync(root, path.join(base, "alias"));
    assert.equal(folderPathOf(root, path.join(root, "src", "a.ts")), path.join(root, "src", "a.ts"));
    assert.equal(folderPathOf(root, path.join(base, "alias", "src", "a.ts")), path.join(root, "src", "a.ts"));
    assert.equal(folderPathOf(path.join(base, "alias"), path.join(root, "src", "a.ts")), path.join(base, "alias", "src", "a.ts"));
    assert.equal(folderPathOf(root, path.join(root, "..", "outside", "b.ts")), null);
    assert.equal(folderPathOf(root, path.join(base, "outside", "b.ts")), null);
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});
