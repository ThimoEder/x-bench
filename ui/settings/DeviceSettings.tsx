import { useEffect, useEffectEvent, useState } from "react";
import type { ToolStatus } from "../../server/devices/simulator.ts";

export interface DeviceSettingsProps {
  call: (path: string, body?: unknown, method?: string) => Promise<unknown>;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function isFound(value: unknown): boolean {
  return isRecord(value) && typeof value.found === "boolean";
}

function isToolStatus(value: unknown): value is ToolStatus {
  return isRecord(value) && isFound(value.xcode) && isFound(value.helper) && isFound(value.adb) && isFound(value.emulator);
}

interface Row {
  id: string;
  name: string;
  found: boolean;
  // What it is when found, what it gives when missing.
  detail: string;
  missing: string;
  install?: string;
}

function rowsOf(status: ToolStatus): { title: string; rows: Row[] }[] {
  return [
    {
      title: "iOS simulators",
      rows: [
        { id: "xcode", name: "Xcode", found: status.xcode.found, detail: status.xcode.version, missing: "Install Xcode from the App Store to build apps and run simulators." },
        {
          id: "helper",
          name: "Simulator helper",
          found: status.helper.found,
          detail: "Built in · live video, touches and the screen's tree",
          missing: "X Bench's own helper is missing from this build, so iOS simulators are view only. In a checkout, build it with desktop/devices/sim-helper/build.sh (needs Xcode and XcodeGen).",
        },
      ],
    },
    {
      title: "Android",
      rows: [
        { id: "adb", name: "adb", found: status.adb.found, detail: status.adb.version, missing: "Install Android Studio, or its platform tools, to reach Android devices and emulators." },
        { id: "emulator", name: "Emulator", found: status.emulator.found, detail: status.emulator.path, missing: "Install the Android emulator in Android Studio to start virtual devices." },
        {
          id: "android-helper",
          name: "Android helper",
          found: isFound(status.androidHelper) && status.androidHelper.found,
          detail: "Built in · emulator video, the screen's tree and screenshots",
          missing: "X Bench's own Android helper is missing from this build. Run desktop/devices/android-helper/build.sh in a checkout. Without it, the screen's tree and screenshots take seconds.",
        },
      ],
    },
  ];
}

// The Devices tab of Settings: what the simulator tools and the Device tab find on this Mac.
export function DeviceSettings({ call }: DeviceSettingsProps) {
  const [status, setStatus] = useState<ToolStatus | null>(null);
  const [error, setError] = useState("");
  const [copied, setCopied] = useState("");
  const [checking, setChecking] = useState(false);

  async function check() {
    setChecking(true);
    try {
      const next = await call("/api/devices/tools", null, "GET");
      if (!isToolStatus(next)) throw new Error("Request failed");
      setStatus(next);
      setError("");
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : "Request failed");
    } finally {
      setChecking(false);
    }
  }

  const checkOnOpen = useEffectEvent(check);
  useEffect(() => {
    void checkOnOpen();
  }, []);

  function copy(command: string) {
    void navigator.clipboard?.writeText(command).then(() => setCopied(command));
  }

  if (!status) {
    return (
      <div data-testid="device-settings">
        {error ? <p className="sheet-error">{error}</p> : <p className="setup-status">Checking tools…</p>}
      </div>
    );
  }

  return (
    <div data-testid="device-settings">
      <p className="sheet-copy">Tools the Device tab and the agents' simulator tools use. Install a missing one in a terminal, then check again.</p>
      {rowsOf(status).map((group) => (
        <section key={group.title} className="provider-block">
          <header className="provider-head">
            <h3>{group.title}</h3>
          </header>
          {group.rows.map((row) => (
            <div key={row.id} className="device-tool" data-testid={`device-tool-${row.id}`}>
              <p className="provider-state" data-tone={row.found ? "ok" : "warn"}>
                <span className="provider-dot" aria-hidden="true" />
                <span>
                  <strong>{row.name}</strong> {row.found ? row.detail || "Found" : "Not found"}
                </span>
              </p>
              {row.found ? null : <p className="provider-note">{row.missing}</p>}
              {!row.found && row.install ? (
                <div className="device-install">
                  <code>{row.install}</code>
                  <button type="button" onClick={() => copy(row.install ?? "")}>
                    {copied === row.install ? "Copied" : "Copy"}
                  </button>
                </div>
              ) : null}
            </div>
          ))}
        </section>
      ))}
      <button type="button" className="device-recheck" disabled={checking} onClick={() => void check()}>
        {checking ? <><span className="update-spin" aria-hidden="true" />Checking…</> : "Check again"}
      </button>
      {error ? <p className="sheet-error">{error}</p> : null}
    </div>
  );
}
