import { useEffect, useState } from "react";
import type { FormEvent } from "react";
import type { ComposerCatalog, ProviderView, SidebarProject } from "../../server/snapshot.ts";
import { describeSchedule, HOUR_STEPS, nextSlot, shortWhen } from "../../server/routines/routineSchedule.ts";
import { composerOptions, draftChoice } from "../chat/composer/draftConfig.ts";
import { FolderMenu } from "../folder/FolderMenu.tsx";
import { OptionMenu } from "../OptionMenu.tsx";
import { bodyOf, DAY_LETTERS, DAY_NAMES, modeHint, PRESETS, problemOf, routineModes, scheduleOf, type RoutineDraft } from "./routineForm.ts";
import type { ApiCall } from "../launchToken.ts";

export interface RoutineEditorProps {
  draft: RoutineDraft;
  catalog: ComposerCatalog;
  providers: readonly ProviderView[];
  projects: readonly SidebarProject[];
  platform?: string;
  desktop: boolean;
  call: ApiCall;
  onClose: () => void;
  // After a save, with the saved routine's id.
  onSaved: (routineId: string, draft: RoutineDraft) => void;
}

const MINUTES = [0, 5, 10, 15, 20, 30, 45];

function idOf(data: unknown): string {
  if (typeof data !== "object" || data === null) return "";
  const routine = (data as { routine?: unknown }).routine;
  if (typeof routine !== "object" || routine === null) return "";
  const id = (routine as { id?: unknown }).id;
  return typeof id === "string" ? id : "";
}

// The dialog that creates or changes a routine. A new routine's main button saves it and runs it once, so the
// person sees the first run and answers what it asks before the schedule takes over.
export function RoutineEditor({ draft: initial, catalog, providers, projects, platform, desktop, call, onClose, onSaved }: RoutineEditorProps) {
  const [draft, setDraft] = useState<RoutineDraft>(initial);
  const [menu, setMenu] = useState<string | null>(null);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const editing = Boolean(draft.id);
  const options = composerOptions(catalog, draft.picks);
  const choice = draftChoice(catalog, draft.picks);
  const providerId = editing && !draft.modelTouched ? draft.provider : (choice?.provider ?? "");
  const provider = providers.find((item) => item.id === providerId);
  const modes = routineModes(providers, providerId);
  const mode = modes.some((item) => item.value === draft.mode) ? draft.mode : (modes.find((item) => item.value === provider?.defaultMode)?.value ?? modes[0]?.value ?? "");
  const schedule = scheduleOf(draft);
  const next = draft.preset === "manual" ? null : nextSlot(schedule, new Date());

  useEffect(() => {
    function onKey(event: KeyboardEvent) {
      if (event.key !== "Escape" || menu || busy) return;
      // Escape in the folder search closes only the search.
      if (event.target instanceof Element && event.target.closest(".branch-popover")) return;
      onClose();
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [menu, busy, onClose]);

  function change(patch: Partial<RoutineDraft>) {
    setError("");
    setDraft((current) => ({ ...current, ...patch }));
  }

  function pick(id: string, value: string) {
    if (id === "model") {
      const model = catalog.models.find((item) => item.value === value);
      setDraft((current) => ({ ...current, modelTouched: true }));
      const efforts = new Set((model?.efforts ?? []).map((item) => item.value));
      const keepEffort = draft.picks.effort && efforts.has(draft.picks.effort);
      const nextProvider = model?.provider ?? "";
      const nextModes = routineModes(providers, nextProvider);
      change({
        picks: { model: value, ...(keepEffort ? { effort: draft.picks.effort } : {}) },
        ...(nextModes.some((item) => item.value === draft.mode) ? {} : { mode: providers.find((item) => item.id === nextProvider)?.defaultMode ?? "" }),
      });
      return;
    }
    if (id === "effort") change({ picks: { ...draft.picks, effort: value }, modelTouched: true });
    if (id === "approval") change({ mode: value });
  }

  function toggleDay(day: number) {
    change({ days: draft.days.includes(day) ? draft.days.filter((item) => item !== day) : [...draft.days, day] });
  }

  async function save(runNow: boolean, event?: FormEvent) {
    event?.preventDefault();
    const problem = problemOf(draft, catalog);
    if (problem) {
      setError(problem);
      return;
    }
    setBusy(true);
    setError("");
    let id = draft.id || "";
    try {
      const data = await call(editing ? "/api/routines/update" : "/api/routines", bodyOf({ ...draft, mode }, catalog));
      id = id || idOf(data);
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : "Couldn't save the routine");
      setBusy(false);
      return;
    }
    // The routine exists from here on, so another Save changes it instead of creating a second one.
    if (!draft.id && id) setDraft((current) => ({ ...current, id }));
    if (runNow && id) {
      try {
        await call("/api/routines/run", { id });
      } catch (failure) {
        setError(`Saved, but the first run did not start: ${failure instanceof Error ? failure.message : "something went wrong"}`);
        setBusy(false);
        return;
      }
    }
    setBusy(false);
    onSaved(id, draft);
  }

  const menuProps = (id: string) => ({
    open: menu === id,
    onToggle: () => setMenu((current) => (current === id ? null : id)),
    onClose: () => setMenu(null),
  });

  return (
    <div className="sheet-scrim routine-scrim" onMouseDown={() => !busy && onClose()}>
      <form
        className="sheet routine-sheet"
        role="dialog"
        aria-modal="true"
        aria-labelledby="routine-editor-title"
        data-testid="routine-editor"
        onMouseDown={(event) => event.stopPropagation()}
        onSubmit={(event) => save(false, event)}
      >
        <h2 id="routine-editor-title">{editing ? "Edit routine" : "New routine"}</h2>
        <label className="sheet-field">
          Name
          <input data-testid="routine-name" value={draft.name} maxLength={120} placeholder="Dependency check" autoFocus={!editing} onChange={(event) => change({ name: event.target.value })} />
        </label>
        <div className="sheet-field">
          <span id="routine-prompt-label">Prompt</span>
          <div className="routine-prompt">
            <textarea
              data-testid="routine-prompt"
              aria-labelledby="routine-prompt-label"
              rows={5}
              value={draft.prompt}
              placeholder="Check for outdated dependencies with security fixes, update them, and run the tests."
              onChange={(event) => change({ prompt: event.target.value })}
            />
            <div className="routine-chips">
              {options.map((option) => (
                <OptionMenu key={option.id} entry={{ option, onChange: (value) => pick(option.id, value) }} {...menuProps(option.id)} />
              ))}
              {modes.length ? (
                <OptionMenu entry={{ option: { id: "approval", name: "Approval", currentValue: mode, options: modes }, onChange: (value) => pick("approval", value) }} {...menuProps("approval")} />
              ) : null}
            </div>
          </div>
          {provider && !provider.enabled ? (
            <span className="routine-hint" data-testid="routine-provider-off">
              {provider.label} is off in Settings, so its runs fail until you turn it on. Picking a model moves the routine to that model's provider.
            </span>
          ) : provider ? (
            <span className="routine-hint">{modeHint(mode, provider.label)}</span>
          ) : null}
        </div>
        <div className="routine-where">
          <div className="sheet-field">
            <span>Runs in</span>
            <div className="sheet-switch routine-switch" role="radiogroup" aria-label="Runs in">
              <button type="button" role="radio" aria-checked={!draft.chat} className={draft.chat ? "" : "is-picked"} onClick={() => change({ chat: false })}>
                A project
              </button>
              <button type="button" role="radio" aria-checked={draft.chat} className={draft.chat ? "is-picked" : ""} onClick={() => change({ chat: true })}>
                A chat
              </button>
            </div>
          </div>
          {draft.chat ? null : (
            <>
              <div className="sheet-field">
                <span>Folder</span>
                <FolderMenu cwd={draft.cwd} projects={projects} {...(platform ? { platform } : {})} call={call} onChange={(cwd) => change({ cwd: cwd || "" })} />
              </div>
              <label className="sheet-field">
                Start in
                <select data-testid="routine-start" value={draft.start} onChange={(event) => change({ start: event.target.value === "folder" ? "folder" : "worktree" })}>
                  <option value="worktree">New worktree from main</option>
                  <option value="folder">Folder as it is</option>
                </select>
              </label>
            </>
          )}
        </div>
        {!draft.chat && draft.start === "worktree" && draft.preset === "hourly" ? (
          <p className="routine-hint">Each run leaves its worktree in place, so an hourly routine adds one every hour.</p>
        ) : null}
        <div className="sheet-field">
          <span>Schedule</span>
          <div className="routine-presets" role="radiogroup" aria-label="Schedule">
            {PRESETS.map((preset) => (
              <button
                key={preset.id}
                type="button"
                role="radio"
                aria-checked={draft.preset === preset.id}
                className={draft.preset === preset.id ? "is-picked" : ""}
                onClick={() => change({ preset: preset.id })}
              >
                {preset.name}
              </button>
            ))}
          </div>
        </div>
        {draft.preset === "hourly" ? (
          <div className="routine-when">
            <label>
              Every
              <select aria-label="Hours between runs" value={draft.hours} onChange={(event) => change({ hours: Number(event.target.value) })}>
                {HOUR_STEPS.map((hours) => (
                  <option key={hours} value={hours}>{hours === 1 ? "hour" : `${hours} hours`}</option>
                ))}
              </select>
            </label>
            <label>
              at
              <select aria-label="Minute" value={draft.minute} onChange={(event) => change({ minute: Number(event.target.value) })}>
                {MINUTES.map((minute) => (
                  <option key={minute} value={minute}>:{String(minute).padStart(2, "0")}</option>
                ))}
              </select>
            </label>
          </div>
        ) : null}
        {draft.preset === "daily" || draft.preset === "weekdays" || draft.preset === "weekly" || draft.preset === "custom" ? (
          <div className="routine-when">
            {draft.preset === "weekly" ? (
              <label>
                On
                <select aria-label="Day" value={draft.weekday} onChange={(event) => change({ weekday: Number(event.target.value) })}>
                  {DAY_NAMES.map((name, day) => (
                    <option key={name} value={day}>{name}</option>
                  ))}
                </select>
              </label>
            ) : null}
            <label>
              At
              <input type="time" aria-label="Time" value={draft.at} onChange={(event) => change({ at: event.target.value || draft.at })} />
            </label>
            {draft.preset === "custom" ? (
              <span className="routine-days" role="group" aria-label="Days">
                {DAY_LETTERS.map((letter, day) => (
                  <button
                    key={DAY_NAMES[day]}
                    type="button"
                    aria-label={DAY_NAMES[day]}
                    aria-pressed={draft.days.includes(day)}
                    className={draft.days.includes(day) ? "is-picked" : ""}
                    onClick={() => toggleDay(day)}
                  >
                    {letter}
                  </button>
                ))}
              </span>
            ) : null}
          </div>
        ) : null}
        {draft.preset === "once" ? (
          <div className="routine-when">
            <label>
              On
              <input type="datetime-local" aria-label="Day and time" value={draft.once} onChange={(event) => change({ once: event.target.value })} />
            </label>
          </div>
        ) : null}
        <p className="routine-next" data-testid="routine-next">
          {draft.preset === "manual"
            ? "Runs only when you press Run now."
            : next
              ? `${describeSchedule(schedule)}. Next run: ${shortWhen(next, new Date())}.`
              : `${describeSchedule(schedule)}. That time has passed.`}
        </p>
        {draft.preset === "manual" ? null : (
          <label className="routine-check">
            <input type="checkbox" checked={draft.catchUp} onChange={(event) => change({ catchUp: event.target.checked })} />
            <span>
              Run once when X Bench opens if a run was missed
              <small>Routines run while X Bench is open. A missed run can come hours late, so say in the prompt if the time matters.</small>
            </span>
          </label>
        )}
        <label className="routine-check">
          <input type="checkbox" data-testid="routine-notify" checked={draft.notify} onChange={(event) => change({ notify: event.target.checked })} />
          <span>
            Notify me when a run ends, waits for me, or does not start
            {desktop ? null : <small>Notifications come from the X Bench app.</small>}
          </span>
        </label>
        {error ? <p className="sheet-error" role="alert">{error}</p> : null}
        <div className="sheet-actions">
          <button type="button" className="text-button" onClick={onClose} disabled={busy}>Cancel</button>
          {editing ? (
            <button type="submit" className="primary" data-testid="routine-save" disabled={busy}>{busy ? "Saving…" : "Save"}</button>
          ) : (
            <>
              <button type="submit" className="text-button" data-testid="routine-save" disabled={busy}>Save</button>
              <button type="button" className="primary" data-testid="routine-save-run" disabled={busy} onClick={() => save(true)}>{busy ? "Starting…" : "Save and run now"}</button>
            </>
          )}
        </div>
      </form>
    </div>
  );
}
