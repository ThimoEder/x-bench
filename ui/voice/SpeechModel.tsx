import { useEffect, useRef } from "react";
import { closeSpeechModel, formatMegabytes, refreshSpeechModel, speechModelAction, useSpeechModel } from "./speechModel.ts";

// Asks before the speech model downloads and shows the download.
export function SpeechModel() {
  const { status, open, note } = useSpeechModel();
  const main = useRef<HTMLButtonElement | null>(null);
  const state = status?.state;

  useEffect(() => {
    if (!open) return;
    function onKey(event: KeyboardEvent) {
      if (event.key === "Escape") closeSpeechModel();
    }
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [open]);

  useEffect(() => {
    if (open) main.current?.focus();
  }, [open, state]);

  if (!open) return null;
  const share = status?.total ? Math.min(100, Math.round((status.received / status.total) * 100)) : 0;
  return (
    <div className="speech-scrim" onMouseDown={(event) => event.target === event.currentTarget && closeSpeechModel()}>
      <div className="switch-confirm" role="dialog" aria-modal="true" aria-labelledby="speech-title" data-testid="speech-model">
        <h3 id="speech-title">Speech model for dictation</h3>
        <ul>
          <li>
            Dictation needs <b>Parakeet TDT 0.6B INT8</b>, a speech model from NVIDIA (CC-BY-4.0, through sherpa-onnx).
          </li>
          <li>Speech is transcribed on this Mac and is not sent anywhere.</li>
          <li>It is about 465 MB to download and 640 MB on disk, stored in ~/.x-bench/models.</li>
        </ul>
        {state === "downloading" ? (
          <div className="switch-cost" data-testid="speech-progress">
            <span>Downloading</span>
            <span className="switch-meter" role="progressbar" aria-label="Download" aria-valuemin={0} aria-valuemax={100} aria-valuenow={share}>
              <i style={{ width: `${share}%` }} />
            </span>
            <span>{status?.total ? `${formatMegabytes(status.received)} of ${formatMegabytes(status.total)}` : formatMegabytes(status?.received || 0)}</span>
          </div>
        ) : state === "unpacking" || state === "loading" ? (
          <p className="switch-note" role="status">
            {state === "unpacking" ? "Unpacking…" : "Loading…"}
          </p>
        ) : state === "ready" ? (
          <p className="switch-note" role="status">
            Ready. {formatMegabytes(status?.size || 0)} on disk.
          </p>
        ) : null}
        {state === "error" || note ? (
          <p className="switch-error" role="alert">
            {note || status?.error}
          </p>
        ) : null}
        <div className="switch-actions">
          {state === "downloading" || state === "unpacking" ? (
            <>
              <button type="button" className="ghost" onClick={() => void speechModelAction("cancel")}>
                Cancel
              </button>
              <button type="button" className="primary" ref={main} onClick={closeSpeechModel}>
                Hide
              </button>
            </>
          ) : state === "ready" ? (
            <button type="button" className="primary" ref={main} onClick={closeSpeechModel}>
              Done
            </button>
          ) : (
            <>
              <button type="button" className="ghost" onClick={closeSpeechModel}>
                Not now
              </button>
              <button
                type="button"
                className="primary"
                ref={main}
                data-testid="speech-download"
                disabled={!status || state === "loading"}
                onClick={() => void speechModelAction("download")}
              >
                {state === "error" ? "Retry" : "Download"}
              </button>
            </>
          )}
        </div>
      </div>
    </div>
  );
}

export function SpeechModelSetting() {
  const { status, note } = useSpeechModel();
  const state = status?.state;

  useEffect(() => {
    refreshSpeechModel().catch(() => {});
  }, []);

  const share = status?.total ? Math.min(100, Math.round((status.received / status.total) * 100)) : 0;
  const summary =
    state === "ready"
      ? `Ready, ${formatMegabytes(status?.size || 0)} on disk`
      : state === "downloading"
        ? status?.total
          ? `${formatMegabytes(status.received)} of ${formatMegabytes(status.total)}`
          : formatMegabytes(status?.received || 0)
        : state === "unpacking"
          ? "Unpacking…"
          : state === "loading"
            ? "Loading…"
            : state === "error"
              ? "Download failed"
              : state === "missing"
                ? "Not downloaded"
                : "";
  return (
    <>
      <div className="settings-switch-row" data-testid="speech-model-setting">
        <span className="speech-setting-label">
          Speech model
          <small role="status">{summary}</small>
        </span>
        {state === "downloading" || state === "unpacking" ? (
          <button type="button" className="text-button" onClick={() => void speechModelAction("cancel")}>
            Cancel
          </button>
        ) : state === "ready" ? (
          <button type="button" className="text-button" data-testid="speech-remove" onClick={() => void speechModelAction("remove")}>
            Remove
          </button>
        ) : (
          <span className="speech-setting-actions">
            {state === "error" ? (
              <button type="button" className="text-button" onClick={() => void speechModelAction("remove")}>
                Remove
              </button>
            ) : null}
            <button type="button" className="text-button" data-testid="speech-download" disabled={!status || state === "loading"} onClick={() => void speechModelAction("download")}>
              {state === "error" ? "Retry" : "Download"}
            </button>
          </span>
        )}
      </div>
      {state === "downloading" ? (
        <span className="switch-meter speech-setting-meter" role="progressbar" aria-label="Download" aria-valuemin={0} aria-valuemax={100} aria-valuenow={share}>
          <i style={{ width: `${share}%` }} />
        </span>
      ) : null}
      {state === "error" || note ? (
        <p className="sheet-error" role="alert">
          {note || status?.error}
        </p>
      ) : null}
      <p className="provider-hint">
        Parakeet TDT 0.6B INT8 from NVIDIA (CC-BY-4.0, through sherpa-onnx). About 465 MB to download and 640 MB on disk, in
        ~/.x-bench/models. Speech is transcribed on this Mac and is not sent anywhere.
      </p>
    </>
  );
}
