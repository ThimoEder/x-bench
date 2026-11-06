import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

export type RunSips = (command: string, args: string[]) => Promise<unknown>;

export interface JpegOptions {
  // The source's file extension. sips reads the format from it.
  extension: string;
  quality: number;
  // Scales the longer side to this many pixels.
  longest?: number;
  run?: RunSips;
  sips?: string;
}

// Converts an image to JPEG with macOS's sips.
export async function toJpeg(image: Buffer, options: JpegOptions): Promise<Buffer> {
  const run = options.run || runSips;
  const dir = await mkdtemp(path.join(os.tmpdir(), "x-bench-jpeg-"));
  try {
    const source = path.join(dir, `source.${options.extension}`);
    const target = path.join(dir, "target.jpg");
    await writeFile(source, image);
    const args = ["-s", "format", "jpeg", "-s", "formatOptions", String(options.quality)];
    if (options.longest) args.push("-Z", String(options.longest));
    args.push(source, "--out", target);
    await run(options.sips || "/usr/bin/sips", args);
    return await readFile(target);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

function runSips(command: string, args: string[]) {
  return new Promise<void>((resolve, reject) => {
    execFile(command, args, { timeout: 10000 }, (error) => (error ? reject(error) : resolve()));
  });
}
