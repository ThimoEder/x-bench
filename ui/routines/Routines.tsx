import { useEffect, useEffectEvent, useRef, useState } from "react";
import type { ComposerCatalog, ProviderView, RoutineRunView, RoutinesView, RoutineView, RunState, SidebarProject, Snapshot } from "../../server/snapshot.ts";
import { describeSchedule, shortWhen } from "../../server/routines/routineSchedule.ts";
import { KeepAwakeSwitch } from "../settings/HostSettings.tsx";
import { RoutineEditor } from "./RoutineEditor.tsx";
import { draftOf, newDraft, STARTERS, type RoutineDraft, type RoutineSeed } from "./routineForm.ts";
import type { ApiCall } from "../launchToken.ts";
import { leaveRef } from "../leaveRef.ts";
import { useCloseOutside } from "../useCloseOutside.ts";

export interface RoutinesProps {
  routines: RoutinesView;
  app: Snapshot["app"];
  projects: readonly SidebarProject[];
  catalog: ComposerCatalog;
  providers: readonly ProviderView[];
  platform?: string;
  call: ApiCall;
  unread: readonly string[];
  // chat: the run is a plain chat, on the Chat surface.
  onOpenRun: (run: Pick<RoutineRunView, "sessionId" | "cwd">, chat: boolean) => void;
  seed: RoutineSeed | null;
  onSeedApplied: () => void;
}

const TRIGGERS: Record<RoutineRunView["trigger"], string> = {
  schedule: "Scheduled",
  "catch-up": "Caught up",
  manual: "Manually",
};

const STATES: Record<RunState, string> = {
  working: "Working",
  waiting: "Waiting for you",
  done: "Done",
  error: "Ended with an error",
  cancelled: "Stopped",
  started: "Started",
  skipped: "Skipped",
  failed: "Did not start",
};

function toneOf(state: RunState): string {
  if (state === "waiting") return "is-waiting";
  if (state === "done") return "is-done";
  if (state === "error" || state === "failed") return "is-failed";
  if (state === "working") return "is-working";
  return "";
}

export function runText(run: RoutineRunView): string {
  const state = STATES[run.state];
  return run.reason && (run.state === "skipped" || run.state === "failed" || run.state === "cancelled" || run.state === "error") ? `${state}: ${run.reason}` : state;
}

function folderName(routine: RoutineView, projects: readonly SidebarProject[]): string {
  if (routine.chat) return "Chat";
  return projects.find((project) => project.cwd === routine.cwd)?.name || routine.cwd.split("/").filter(Boolean).at(-1) || routine.cwd;
}

function modelName(routine: RoutineView, catalog: ComposerCatalog, providers: readonly ProviderView[]): string {
  const model = catalog.models.find((item) => item.provider === routine.provider && item.model === routine.model);
  if (model) return model.name;
  const label = providers.find((item) => item.id === routine.provider)?.label || routine.provider;
  return routine.model ? `${label} ${routine.model}` : label;
}

function modeName(routine: RoutineView, providers: readonly ProviderView[]): string {
  return providers.find((item) => item.id === routine.provider)?.modes.find((mode) => mode.id === routine.mode)?.name || "";
}

// mark is the run the line names, for its dot.
export function routineStatus(routine: RoutineView, now = new Date()): { text: string; tone: string; mark?: RoutineRunView } {
  // A run still working or waiting for you leads, also on a paused routine and behind a newer skip.
  const live = routine.runs.find((run) => run.state === "working" || run.state === "waiting");
  if (routine.pausedReason && !live) return { text: routine.pausedReason, tone: "is-failed" };
  const last = live ?? routine.runs[0];
  const parts: string[] = [];
  let tone = "";
  let mark: RoutineRunView | undefined;
  if (routine.queued) parts.push("Waiting for a free slot");
  else if (last) {
    parts.push(`${runText(last)} (${shortWhen(new Date(last.startedAt), now)})`);
    tone = toneOf(last.state);
    mark = last;
  }
  if (!routine.enabled) parts.push(routine.pausedReason || "Paused");
  else if (routine.nextRunAt) parts.push(`Next: ${shortWhen(new Date(routine.nextRunAt), now)}`);
  return { text: parts.join(" · "), tone, ...(mark ? { mark } : {}) };
}

function RunMark({ run, unread }: { run: RoutineRunView; unread: readonly string[] }) {
  const state = run.state;
  const seen = !run.sessionId || !unread.includes(run.sessionId);
  const kind = state === "working" ? "working" : state === "waiting" ? "attention" : state === "done" && !seen ? "unread" : state === "error" || state === "failed" ? "run-failed" : "run-quiet";
  return (
    <span className="routine-run-mark" aria-hidden="true">
      <span className={`status-dot ${kind}`} />
    </span>
  );
}

function ArrowIcon() {
  return (
    <svg width="12" height="12" viewBox="0 0 12 12" aria-hidden="true">
      <path d="M4.5 2.5 8 6l-3.5 3.5" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

function RunRow({ run, now, unread, call, onOpenRun }: { run: RoutineRunView; now: Date; unread: readonly string[] } & Pick<RoutinesProps, "call" | "onOpenRun">) {
  const [menu, setMenu] = useState(false);
  const [confirm, setConfirm] = useState(false);
  const wrap = useRef<HTMLSpanElement>(null);
  useCloseOutside(menu, wrap, () => setMenu(false));
  const when = shortWhen(new Date(run.startedAt), now);
  const worktreeNote = run.worktreeRemoved ? "Worktree removed" : run.worktreeKept;

  function remove(worktree: boolean) {
    setMenu(false);
    call("/api/delete", { sessionId: run.sessionId, worktree }).catch(() => {});
  }

  const line = (
    <>
      <RunMark run={run} unread={unread} />
      <span className="routine-run-line">
        <span className="routine-run-when">{when}</span>
        <span className="routine-run-trigger">{TRIGGERS[run.trigger]}</span>
        <span className={`routine-run-state ${toneOf(run.state)}`}>{runText(run)}</span>
        {worktreeNote ? (
          <span className="routine-run-worktree" title={worktreeNote}>
            {worktreeNote}
          </span>
        ) : null}
      </span>
    </>
  );
  return (
    <li>
      {run.sessionId && run.cwd ? (
        <button type="button" className="routine-run is-open" aria-label={`Open the run from ${when}: ${runText(run)}`} onClick={() => onOpenRun(run, run.chat)}>
          {line}
          <span className="routine-run-go" aria-hidden="true">
            Open chat
            <ArrowIcon />
          </span>
        </button>
      ) : (
        <div className="routine-run">{line}</div>
      )}
      {run.sessionId ? (
        <span ref={wrap} className="routine-menu-wrap">
          <button
            type="button"
            className="icon routine-more"
            aria-label={`Actions for the run from ${when}`}
            aria-expanded={menu}
            onClick={() => {
              setConfirm(false);
              setMenu(!menu);
            }}
          >
            …
          </button>
          {menu ? (
            <div ref={leaveRef} className="session-menu routine-menu" role="menu">
              <button type="button" role="menuitem" className="danger" onClick={() => (confirm ? remove(false) : setConfirm(true))}>
                {confirm ? "Delete this chat" : "Delete chat"}
              </button>
              {confirm && run.ownWorktree ? (
                <button type="button" role="menuitem" className="danger" onClick={() => remove(true)}>
                  Delete the worktree too
                </button>
              ) : null}
            </div>
          ) : null}
        </span>
      ) : null}
    </li>
  );
}

export function Routines({ routines, app, projects, catalog, providers, platform, call, unread, onOpenRun, seed, onSeedApplied }: RoutinesProps) {
  const [selected, setSelected] = useState<string | null>(null);
  const [editing, setEditing] = useState<RoutineDraft | null>(null);
  const [menuId, setMenuId] = useState<string | null>(null);
  const [confirmId, setConfirmId] = useState<string | null>(null);
  const [running, setRunning] = useState<string | null>(null);
  const list = routines.list;
  const now = new Date();

  const applySeed = useEffectEvent((next: RoutineSeed) => {
    setEditing(newDraft({ seed: next, projects, catalog, providers }));
    onSeedApplied();
  });
  useEffect(() => {
    if (seed) applySeed(seed);
  }, [seed]);

  useEffect(() => {
    if (!menuId) return undefined;
    function close(event: PointerEvent) {
      if (!(event.target instanceof Element) || !event.target.closest(".routine-menu-wrap")) {
        setMenuId(null);
        setConfirmId(null);
      }
    }
    document.addEventListener("pointerdown", close);
    return () => document.removeEventListener("pointerdown", close);
  }, [menuId]);

  function create(starter?: (typeof STARTERS)[number]) {
    const draft = newDraft({ projects, catalog, providers });
    setEditing(starter ? { ...draft, name: starter.name, prompt: starter.prompt, preset: starter.preset, at: starter.at } : draft);
  }

  async function runNow(routine: RoutineView) {
    setRunning(routine.id);
    setSelected(routine.id);
    try {
      await call("/api/routines/run", { id: routine.id });
    } catch {
      // The banner and the run's history say why.
    } finally {
      setRunning(null);
    }
  }

  function setEnabled(routine: RoutineView, enabled: boolean) {
    call("/api/routines/update", { id: routine.id, enabled }).catch(() => {});
  }

  function remove(routine: RoutineView) {
    if (confirmId !== routine.id) {
      setConfirmId(routine.id);
      return;
    }
    setMenuId(null);
    setConfirmId(null);
    call("/api/routines/delete", { id: routine.id }).catch(() => {});
  }

  const scheduler = routines.scheduler;
  const schedulerNote = scheduler.here
    ? ""
    : scheduler.port
      ? `Routines run on schedule in X Bench on port ${scheduler.port}. Run now works here.`
      : scheduler.takesPart
        ? "Starting the schedule…"
        : "Scheduled runs are off in this window. Start it with --routines to run them here. Run now works.";

  return (
    <div className="routines" data-testid="routines">
      <div className="routines-scroll">
        <header className="routines-head">
          <div>
            <h1>Routines</h1>
            <p className="routines-lede">Prompts X Bench sends on a schedule while it is open. Each run starts a new chat.</p>
          </div>
          {list.length ? (
            <button type="button" className="primary" data-testid="new-routine" onClick={() => create()}>
              New routine
            </button>
          ) : null}
        </header>
        {schedulerNote ? <p className="routines-note" data-testid="routines-scheduler">{schedulerNote}</p> : null}
        {list.length === 0 ? (
          <section className="routines-empty">
            <h2>Run a prompt on a schedule</h2>
            <p>A routine sends its prompt at the times you pick and opens a chat for every run. Start from one of these, or write your own.</p>
            <div className="routine-starters">
              {STARTERS.map((starter) => (
                <button key={starter.name} type="button" className="routine-starter" onClick={() => create(starter)}>
                  <strong>{starter.name}</strong>
                  <span>{starter.prompt}</span>
                </button>
              ))}
            </div>
            <button type="button" className="primary" data-testid="new-routine" onClick={() => create()}>
              New routine
            </button>
          </section>
        ) : (
          <ul className="routine-list">
            {list.map((routine) => {
              const open = selected === routine.id;
              const status = routineStatus(routine, now);
              const meta = [describeSchedule(routine.schedule), folderName(routine, projects) + (routine.chat || routine.start === "folder" ? "" : " · worktree"), modelName(routine, catalog, providers), modeName(routine, providers)]
                .filter(Boolean)
                .join(" · ");
              return (
                <li key={routine.id} className={["routine-row", open ? "is-open" : "", routine.enabled ? "" : "is-paused"].filter(Boolean).join(" ")}>
                  <div className="routine-line">
                    <button type="button" className="routine-main" aria-expanded={open} onClick={() => setSelected(open ? null : routine.id)}>
                      <span className="routine-name">{routine.name}</span>
                      <span className="routine-meta">{meta}</span>
                      {status.text ? (
                        <span className={`routine-status ${status.tone}`}>
                          {status.mark ? <RunMark run={status.mark} unread={unread} /> : null}
                          <span>{status.text}</span>
                        </span>
                      ) : null}
                    </button>
                    <div className="routine-actions">
                      <button type="button" className="text-button" data-testid="routine-run" disabled={running === routine.id} onClick={() => runNow(routine)}>
                        {running === routine.id ? "Starting…" : "Run now"}
                      </button>
                      <button
                        type="button"
                        role="switch"
                        className={routine.enabled ? "routine-switch-toggle is-on" : "routine-switch-toggle"}
                        aria-checked={routine.enabled}
                        aria-label={routine.enabled ? `Pause ${routine.name}` : `Turn ${routine.name} on`}
                        onClick={() => setEnabled(routine, !routine.enabled)}
                      >
                        <span aria-hidden="true" />
                      </button>
                      <span className="routine-menu-wrap">
                        <button
                          type="button"
                          className="icon routine-more"
                          aria-label={`Actions for ${routine.name}`}
                          aria-expanded={menuId === routine.id}
                          onClick={() => {
                            setConfirmId(null);
                            setMenuId((current) => (current === routine.id ? null : routine.id));
                          }}
                        >
                          …
                        </button>
                        {menuId === routine.id ? (
                          <div ref={leaveRef} className="session-menu routine-menu" role="menu">
                            <button
                              type="button"
                              role="menuitem"
                              onClick={() => {
                                setMenuId(null);
                                setEditing(draftOf(routine, catalog));
                              }}
                            >
                              Edit
                            </button>
                            <button
                              type="button"
                              role="menuitem"
                              onClick={() => {
                                setMenuId(null);
                                const { id: _id, ...copy } = draftOf(routine, catalog);
                                setEditing({ ...copy, name: `${routine.name} copy`.slice(0, 120) });
                              }}
                            >
                              Duplicate
                            </button>
                            <button type="button" role="menuitem" className="danger" onClick={() => remove(routine)}>
                              {confirmId === routine.id ? "Delete this routine" : "Delete"}
                            </button>
                          </div>
                        ) : null}
                      </span>
                    </div>
                  </div>
                  {open ? (
                    <div className="routine-runs">
                      <p className="routine-prompt-text">{routine.prompt}</p>
                      {routine.runs.length ? (
                        <ul>
                          {routine.runs.map((run) => (
                            <RunRow key={run.id} run={run} now={now} unread={unread} call={call} onOpenRun={onOpenRun} />
                          ))}
                        </ul>
                      ) : (
                        <p className="routine-runs-empty">No runs yet.</p>
                      )}
                    </div>
                  ) : null}
                </li>
              );
            })}
          </ul>
        )}
        {app.desktop ? (
          <section className="routines-settings" aria-label="Keep awake">
            <KeepAwakeSwitch app={app} call={call} />
          </section>
        ) : null}
      </div>
      {editing ? (
        <RoutineEditor
          key={editing.id || "new"}
          draft={editing}
          catalog={catalog}
          providers={providers}
          projects={projects}
          {...(platform ? { platform } : {})}
          desktop={routines.desktop}
          call={call}
          onClose={() => setEditing(null)}
          onSaved={(id) => {
            setEditing(null);
            if (id) setSelected(id);
          }}
        />
      ) : null}
    </div>
  );
}
