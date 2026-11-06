import { randomBytes } from "node:crypto";

// Puts a file on an Android device by pushing it beside its place and renaming it there. Another X Bench
// host may be running a server from the same path, and a rename leaves that process its old file.
export async function pushFile(run: (command: string, args: string[]) => Promise<unknown>, adb: string, serial: string, file: string, remote: string): Promise<void> {
  const temp = `${remote}.${randomBytes(4).toString("hex")}`;
  await run(adb, ["-s", serial, "push", file, temp]);
  await run(adb, ["-s", serial, "shell", "mv", "-f", temp, remote]);
}
