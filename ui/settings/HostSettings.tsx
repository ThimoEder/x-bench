import type { Snapshot } from "../../server/snapshot.ts";

type Post = (path: string, body: Record<string, unknown>) => Promise<unknown>;

// The switch shows the host's saved value, so Settings › General, the Routines page and every other window show the
// same one. A change applies once the host publishes it.

export function PlanToolSwitch({ app, call }: { app: Snapshot["app"]; call: Post }) {
  return (
    <label className="routine-check">
      <input type="checkbox" data-testid="plan-tool" checked={app.planTool} onChange={(event) => call("/api/settings", { planTool: event.target.checked }).catch(() => {})} />
      <span>
        Plan steps
        <small>Agents keep a step list above the composer while they work. Applies to new and reopened chats. Restart X Bench after changing it.</small>
      </span>
    </label>
  );
}

// Only the app can hold the Mac awake, so a browser tab's host has no such switch.
export function KeepAwakeSwitch({ app, call }: { app: Snapshot["app"]; call: Post }) {
  if (!app.desktop) return null;
  return (
    <label className="routine-check">
      <input type="checkbox" data-testid="keep-awake" checked={app.keepAwake} onChange={(event) => call("/api/settings", { keepAwake: event.target.checked }).catch(() => {})} />
      <span>
        Keep this Mac awake while X Bench is open
        <small>So long turns, background tasks and routines keep going. Closing the lid still puts the Mac to sleep.</small>
      </span>
    </label>
  );
}
