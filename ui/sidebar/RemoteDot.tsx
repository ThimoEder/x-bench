import { useRef, useState } from "react";
import { useCloseOutside } from "../useCloseOutside.ts";
import type { RemoteLinkState, RemoteState } from "../../server/snapshot.ts";
import { remotePage, type ApiCall } from "../launchToken.ts";
import { leaveRef } from "../leaveRef.ts";

export interface RemoteDotProps {
  remote: RemoteState | undefined;
  call?: ApiCall;
  onOpenSettings?: () => void;
}

export type RemoteTone = "ngrok" | "local" | "both" | "starting" | "failed" | "off";

const LINKS = [
  { kind: "ngrok", name: "Remote" },
  { kind: "local", name: "Local" },
] as const;

// Green while ngrok is up, yellow while only the local network is, green with a 2 while both are.
export function remoteTone(remote: RemoteState): RemoteTone {
  const enabled = [remote.ngrok, remote.local].filter((link) => link.enabled);
  if (enabled.some((link) => link.state === "failed")) return "failed";
  const ngrok = remote.ngrok.enabled && remote.ngrok.state === "on";
  const local = remote.local.enabled && remote.local.state === "on";
  if (ngrok && local) return "both";
  if (ngrok) return "ngrok";
  if (local) return "local";
  return enabled.length ? "starting" : "off";
}

export function linkLine(link: RemoteLinkState): string {
  if (!link.enabled) return "Off";
  if (link.state === "on") return link.url.replace(/^https?:\/\//, "");
  if (link.state === "starting") return link.error || "Starting…";
  if (link.state === "failed") return link.error || "Did not start";
  return "Off";
}

export function remoteLine(remote: RemoteState): string {
  const on = [remote.ngrok, remote.local].filter((link) => link.enabled);
  return on.length ? on.map(linkLine).join(" · ") : "Off";
}

// The sidebar's dot for remote access: its color is the tunnels' state, and a click opens a switch for each
// tunnel that is set up.
export function RemoteDot({ remote, call, onOpenSettings }: RemoteDotProps) {
  const rootRef = useRef<HTMLSpanElement | null>(null);
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);

  useCloseOutside(open, rootRef, () => setOpen(false));

  if (!remote || !(remote.ngrok.available || remote.local.available) || remotePage()) return null;
  const tone = remoteTone(remote);
  const line = remoteLine(remote);

  async function toggle(kind: "ngrok" | "local", enabled: boolean) {
    if (!call) return;
    setBusy(true);
    try {
      await call("/api/remote/enabled", { kind, enabled });
    } catch {
      // The dot keeps showing the tunnel's real state.
    } finally {
      setBusy(false);
    }
  }

  return (
    <span className="gear-menu remote-dot-menu" ref={rootRef}>
      <button
        type="button"
        className="icon remote-dot"
        data-tone={tone}
        data-testid="remote-dot"
        aria-label={`Remote access: ${line}`}
        title={`Remote access: ${line}`}
        aria-haspopup="dialog"
        aria-expanded={open}
        onClick={() => setOpen((current) => !current)}
      >
        <span className="remote-dot-mark" aria-hidden="true">
          {tone === "both" ? <b className="remote-dot-count">2</b> : null}
        </span>
      </button>
      {open ? (
        <div ref={leaveRef} className="session-menu remote-menu" role="dialog" aria-label="Remote access" data-testid="remote-menu">
          {LINKS.filter(({ kind }) => remote[kind].available).map(({ kind, name }) => (
            <div key={kind}>
              <div className="remote-menu-head">
                <strong>{name}</strong>
                <label className="provider-switch">
                  <input
                    type="checkbox"
                    role="switch"
                    checked={remote[kind].enabled}
                    disabled={busy}
                    data-testid={`remote-menu-switch-${kind}`}
                    onChange={(event) => void toggle(kind, event.target.checked)}
                  />
                  {remote[kind].enabled ? "On" : "Off"}
                </label>
              </div>
              <p className="remote-menu-line" data-tone={remote[kind].enabled ? remote[kind].state : "off"}>{linkLine(remote[kind])}</p>
            </div>
          ))}
          <button
            type="button"
            role="menuitem"
            onClick={() => {
              setOpen(false);
              onOpenSettings?.();
            }}
          >
            Remote settings
          </button>
        </div>
      ) : null}
    </span>
  );
}
