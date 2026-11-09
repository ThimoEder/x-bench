import { useEffect, useRef, useState } from "react";

export interface UpdateRelease {
  version: string;
  size: number;
  notes: { heading: string; notes: string[] }[];
}

// What desktop/updater/updater.js reports. version is the running app's.
export interface UpdateState {
  phase: "idle" | "checking" | "current" | "available" | "downloading" | "verifying" | "ready" | "error";
  version: string;
  release?: UpdateRelease;
  progress?: number;
  error?: string;
}

export interface UpdateBridge {
  updateCheck(): void;
  updateInstall(): void;
  updateRestart(): void;
  onUpdate(listener: (state: UpdateState) => void): () => void;
}

// The desktop app's updater, or null in a plain browser and on a paired phone.
export function updateBridge(): UpdateBridge | null {
  if (typeof window === "undefined") return null;
  const value: unknown = Reflect.get(window, "xBenchDesktop");
  if (typeof value !== "object" || value === null || typeof Reflect.get(value, "onUpdate") !== "function") return null;
  return value as UpdateBridge;
}

export function useWaitingUpdate(bridge: UpdateBridge | null) {
  const [version, setVersion] = useState<string | null>(null);
  useEffect(
    () => bridge?.onUpdate((state) => setVersion(state.phase === "available" || state.phase === "ready" ? state.release?.version ?? null : null)),
    [bridge],
  );
  return version;
}

function chatsRunning(count: number) {
  return count === 1 ? "1 chat is running" : `${count} chats are running`;
}

function untilDone(count: number) {
  return count === 1 ? "the running chat finishes" : `the ${count} running chats finish`;
}

interface UpdateCardProps {
  bridge: UpdateBridge;
  // Chats in the middle of a turn, working or waiting for an approval, which a restart stops.
  running: number;
  onClose: () => void;
}

// Only Restart anyway stops running chats. Otherwise the app restarts into the update once no chat is running.
export function UpdateCard({ bridge, running, onClose }: UpdateCardProps) {
  const [state, setState] = useState<UpdateState | null>(null);
  const [confirming, setConfirming] = useState(false);
  // "ready" restarts as soon as the update is ready, "idle" once no chat is running either.
  const [restartWhen, setRestartWhen] = useState<"ready" | "idle" | null>(null);

  useEffect(() => {
    const stop = bridge.onUpdate(setState);
    bridge.updateCheck();
    return stop;
  }, [bridge]);

  const ready = state?.phase === "ready";
  const restarted = useRef(false);
  useEffect(() => {
    if (restarted.current || !ready || !(restartWhen === "ready" || (restartWhen === "idle" && running === 0))) return;
    restarted.current = true;
    bridge.updateRestart();
  }, [bridge, ready, restartWhen, running]);

  function update(when: "ready" | "idle") {
    setConfirming(false);
    setRestartWhen(when);
    if (state?.phase === "available") bridge.updateInstall();
  }

  if (!state) return null;
  const release = state.release;
  const busy = state.phase === "downloading" || state.phase === "verifying" || (ready && restartWhen !== null);
  let body;
  if (confirming) {
    body = (
      <>
        <strong>{chatsRunning(running)}</strong>
        <p>Restarting stops their turns. The chats are kept.</p>
        <div className="update-actions">
          <button type="button" className="primary" data-testid="update-anyway" onClick={() => update("ready")}>Restart anyway</button>
          <button type="button" className="update-button" data-testid="update-later" onClick={() => update("idle")}>When they finish</button>
        </div>
      </>
    );
  } else if (state.phase === "idle" || state.phase === "checking") {
    body = <strong><span className="update-spin" aria-hidden="true" />Checking for updates…</strong>;
  } else if (state.phase === "current") {
    body = (
      <>
        <strong className="update-ok">✓ X Bench is up to date</strong>
        <p>You have the newest version, {state.version}.</p>
      </>
    );
  } else if (state.phase === "available" && release) {
    body = (
      <>
        <strong><span className="update-dot" aria-hidden="true" />X Bench {release.version} is available</strong>
        <p>{Math.max(1, Math.round(release.size / 1e6))} MB. You have {state.version}.</p>
        {release.notes.length ? (
          <div className="update-notes">
            {release.notes.map((section) => (
              <section key={section.heading}>
                {section.heading ? <h4>{section.heading}</h4> : null}
                <ul>{section.notes.map((note) => <li key={note}>{note}</li>)}</ul>
              </section>
            ))}
          </div>
        ) : null}
        <div className="update-actions">
          <button type="button" className="primary" data-testid="update-install" onClick={() => (running ? setConfirming(true) : update("idle"))}>
            Update and restart
          </button>
          <button type="button" className="update-button" onClick={onClose}>Later</button>
        </div>
      </>
    );
  } else if (state.phase === "downloading" || state.phase === "verifying") {
    const progress = state.phase === "verifying" ? 100 : state.progress ?? 0;
    body = (
      <>
        <strong><span className="update-spin" aria-hidden="true" />Updating X Bench</strong>
        <div className="update-bar" role="progressbar" aria-valuenow={progress} aria-valuemin={0} aria-valuemax={100}>
          <div style={{ width: `${progress}%` }} />
        </div>
        <span className="provider-hint">{state.phase === "verifying" ? "Checking the update…" : `Downloading ${release?.version ?? ""} · ${progress}%`}</span>
      </>
    );
  } else if (ready && restartWhen === "idle" && running > 0) {
    body = (
      <>
        <strong><span className="update-spin" aria-hidden="true" />Restarting soon</strong>
        <p>X Bench restarts when {untilDone(running)}.</p>
        <div className="update-actions">
          <button type="button" className="update-button" onClick={() => setRestartWhen("ready")}>Restart now</button>
          <button type="button" className="text-button" onClick={() => setRestartWhen(null)}>Cancel</button>
        </div>
      </>
    );
  } else if (ready) {
    body = (
      <>
        <strong><span className="update-dot" aria-hidden="true" />Update ready</strong>
        <p>X Bench {release?.version} is downloaded.</p>
        <div className="update-actions">
          <button type="button" className="primary" data-testid="update-restart" onClick={() => (running ? setConfirming(true) : update("idle"))}>Restart</button>
        </div>
      </>
    );
  } else {
    body = (
      <>
        <strong className="update-bad">Update didn't work</strong>
        <p>{state.error}</p>
        <div className="update-actions">
          <button type="button" className="update-button" onClick={() => bridge.updateCheck()}>Try again</button>
        </div>
      </>
    );
  }

  return (
    <div className="update-card" role="dialog" aria-label="Updates" data-testid="update-card" data-phase={state.phase}>
      {busy ? null : (
        <button type="button" className="update-close" aria-label="Close" onClick={onClose}>×</button>
      )}
      {body}
    </div>
  );
}
