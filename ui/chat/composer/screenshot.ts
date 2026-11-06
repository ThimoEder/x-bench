// The desktop app on a Mac lets the person pick a region or a window to capture. Null where it cannot,
// and the capture resolves to null when the person cancels with Esc.
export function screenshotBridge(): (() => Promise<File | null>) | null {
  if (typeof window === "undefined") return null;
  const desktop: unknown = Reflect.get(window, "xBenchDesktop");
  const take: unknown = typeof desktop === "object" && desktop !== null ? Reflect.get(desktop, "screenshot") : null;
  if (typeof take !== "function") return null;
  return async () => {
    const bytes: unknown = await Reflect.apply(take, desktop, []);
    return bytes instanceof Uint8Array ? new File([new Uint8Array(bytes)], `Screenshot ${stamp(new Date())}.png`, { type: "image/png" }) : null;
  };
}

function stamp(date: Date) {
  const pad = (value: number) => String(value).padStart(2, "0");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} at ${pad(date.getHours())}.${pad(date.getMinutes())}.${pad(date.getSeconds())}`;
}
