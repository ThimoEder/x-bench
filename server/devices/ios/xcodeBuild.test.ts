import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { createBuilds } from "./xcodeBuild.ts";

// A stand-in for xcodebuild: a shell script that prints like it and leaves a .app where -derivedDataPath points.
function fakeXcodebuild(dir: string, body: string): string {
  const script = path.join(dir, "xcodebuild.sh");
  fs.writeFileSync(script, `#!/bin/sh\nwhile [ "$1" != "-derivedDataPath" ]; do shift; done\nderived="$2"\n${body}\n`);
  return script;
}

function scratch(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "x-bench-builds-"));
  test.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

test("a failed build reports its compile errors and warnings once each", async () => {
  const dir = scratch();
  const script = fakeXcodebuild(dir, `echo "/src/App.swift:3:5: error: cannot find 'nmae' in scope"\necho "/src/App.swift:3:5: error: cannot find 'nmae' in scope"\necho "/src/App.swift:9:1: warning: unused variable"\necho "** BUILD FAILED **"\nexit 65`);
  const builds = createBuilds({ command: { file: "/bin/sh", prefix: [script] }, dir: path.join(dir, "out") });
  const started = builds.start({ cwd: dir, scheme: "Sample", device: "16CCC597-962C-4BF1-902E-8C412D8C45C2" });
  assert.equal(started.state, "running");
  const done = await builds.wait(started.id, 10_000);
  assert.equal(done?.state, "failed");
  assert.deepEqual(done?.errors, ["/src/App.swift:3:5: error: cannot find 'nmae' in scope"]);
  assert.equal(done?.warnings, 1);
  assert.ok(fs.readFileSync(done?.log ?? "", "utf8").includes("BUILD FAILED"));
});

test("a finished build names the newest .app it made", async () => {
  const dir = scratch();
  const script = fakeXcodebuild(dir, `mkdir -p "$derived/Build/Products/Debug-iphonesimulator/Sample.app"\necho "** BUILD SUCCEEDED **"`);
  const builds = createBuilds({ command: { file: "/bin/sh", prefix: [script] }, dir: path.join(dir, "out") });
  const started = builds.start({ cwd: dir, scheme: "Sample" });
  const done = await builds.wait(started.id, 10_000);
  assert.equal(done?.state, "succeeded");
  assert.ok(done?.appPath.endsWith(path.join("Debug-iphonesimulator", "Sample.app")));
  assert.equal(await builds.wait("nope", 0), null);
});
