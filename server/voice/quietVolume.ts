import { runProcess } from "../runProcess.ts";
import type { RunCommand } from "../runProcess.ts";

// Turns the Mac's output volume down while the user dictates, and back up after, so every sound gets quieter.

// The share of the volume a take keeps, unless the page asks for another.
export const QUIET_LEVEL = 0.2;
// Longer than the longest take, so a page that goes away mid-take still gets its volume back.
export const QUIET_HOLD_MS = 150_000;
// How long shutdown waits for a volume change already running. The app kills the host after 5 s.
export const SHUTDOWN_WAIT_MS = 2_000;
// The ended takes kept, so a lower that arrives after its own restore is ignored.
const ENDED_KEPT = 50;

// The output volume before the lowering, and the volume set.
export interface Lowered {
  from: number;
  to: number;
}

export interface QuietVolume {
  // A take started: the first one turns the volume down to level (0 to 1) of what it was.
  lower(take: string, level?: number): Promise<void>;
  // A take ended: after the last one, the volume comes back unless the user changed it since.
  restore(take: string): Promise<void>;
  // Shutdown: restores what was turned down at once, without waiting for a lowering still running.
  restoreAll(): Promise<void>;
}

export interface QuietVolumeOptions {
  run?: RunCommand;
  platform?: NodeJS.Platform;
  holdMs?: number;
  shutdownWaitMs?: number;
}

// An output without volume control (some HDMI and USB devices) and a muted one are left alone.
const SCRIPT = String.raw`
function run(argv) {
  const input = JSON.parse(argv[0]);
  const mac = Application.currentApplication();
  mac.includeStandardAdditions = true;
  const settings = mac.getVolumeSettings();
  const now = settings.outputVolume;
  if (typeof now !== "number") return "null";
  const fade = (from, to) => {
    for (let i = 1; i <= 5; i++) {
      mac.setVolume(null, { outputVolume: Math.round(from + ((to - from) * i) / 5) });
      if (i < 5) delay(0.04);
    }
  };
  if (input.restore) {
    // macOS mutes the output at volume 0 and unmutes it at any other volume.
    const ours = Math.abs(now - input.restore.to) <= 1 && (!settings.outputMuted || input.restore.to === 0);
    if (ours) fade(now, input.restore.from);
    return "null";
  }
  if (settings.outputMuted) return "null";
  const to = Math.round(now * input.level);
  if (to >= now) return "null";
  fade(now, to);
  return JSON.stringify({ from: now, to: mac.getVolumeSettings().outputVolume });
}
`;

export function createQuietVolume({ run = runProcess, platform = process.platform, holdMs = QUIET_HOLD_MS, shutdownWaitMs = SHUTDOWN_WAIT_MS }: QuietVolumeOptions = {}): QuietVolume {
  // The takes recording now, each with the timer that ends it when its page never does.
  const takes = new Map<string, ReturnType<typeof setTimeout>>();
  const ended = new Set<string>();
  let lowered: Lowered | null = null;
  let quiet = false;
  let level = QUIET_LEVEL;
  // Lowering and restoring run one after the other, so a short take restores what its lower turned down.
  let queue: Promise<void> = Promise.resolve();

  function enqueue(step: () => Promise<void>) {
    queue = queue.then(step, step);
    return queue;
  }

  async function script(input: { level?: number; restore?: Lowered }): Promise<Lowered | null> {
    try {
      const { stdout } = await run("osascript", ["-l", "JavaScript", "-e", SCRIPT, JSON.stringify(input)], { timeoutMs: 15_000 });
      return JSON.parse(stdout.toString("utf8")) as Lowered | null;
    } catch (error) {
      console.error(`quiet volume: ${error instanceof Error ? error.message : String(error)}`);
      return null;
    }
  }

  // Brings the volume in line with whether any take is recording.
  function settle() {
    return enqueue(async () => {
      if (takes.size && !quiet) {
        quiet = true;
        lowered = await script({ level });
      } else if (!takes.size && quiet) {
        quiet = false;
        const back = lowered;
        lowered = null;
        if (back) await script({ restore: back });
      }
    });
  }

  function end(take: string) {
    clearTimeout(takes.get(take));
    takes.delete(take);
    ended.add(take);
    if (ended.size > ENDED_KEPT) ended.delete(ended.values().next().value as string);
  }

  function lower(take: string, wanted = QUIET_LEVEL) {
    if (platform !== "darwin" || ended.has(take) || takes.has(take)) return Promise.resolve();
    if (!takes.size) level = Math.min(1, Math.max(0, wanted));
    const timer = setTimeout(() => void restore(take), holdMs);
    timer.unref?.();
    takes.set(take, timer);
    return settle();
  }

  function restore(take: string) {
    end(take);
    return settle();
  }

  async function restoreAll() {
    for (const take of [...takes.keys()]) end(take);
    const back = lowered;
    lowered = null;
    const draining = settle();
    const restoring = back ? script({ restore: back }) : Promise.resolve();
    let timer: ReturnType<typeof setTimeout> | undefined;
    await Promise.race([
      Promise.all([restoring, draining]),
      new Promise((resolve) => {
        timer = setTimeout(resolve, shutdownWaitMs);
      }),
    ]);
    clearTimeout(timer);
  }

  return { lower, restore, restoreAll };
}
