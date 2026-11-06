import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { runningTasks } from "./tasks.ts";
import type { RunningTask } from "./tasks.ts";

export interface TaskControlProps {
  session: Parameters<typeof runningTasks>[0];
  onEnd?: (task: RunningTask) => void | Promise<unknown>;
}

export function TaskControl({ session, onEnd }: TaskControlProps) {
  const tasks = runningTasks(session);
  const [open, setOpen] = useState(false);
  const [ending, setEnding] = useState(false);
  const buttonRef = useRef<HTMLButtonElement | null>(null);
  const panelRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    if (!tasks.length) setOpen(false);
  }, [tasks.length]);

  useLayoutEffect(() => {
    if (!open) return undefined;
    const panel = panelRef.current;
    const trigger = buttonRef.current;
    if (!panel || !trigger) return undefined;

    const place = () => {
      const rect = trigger.getBoundingClientRect();
      const width = Math.min(360, window.innerWidth - 16);
      const left = Math.max(8, rect.right - width);
      const height = panel.offsetHeight;
      const top = Math.max(8, rect.top - height - 8);
      panel.style.top = `${top}px`;
      panel.style.left = `${left}px`;
      panel.style.width = `${width}px`;
      panel.classList.add("placed");
    };

    place();
    window.addEventListener("resize", place);
    window.addEventListener("scroll", place, true);
    return () => {
      window.removeEventListener("resize", place);
      window.removeEventListener("scroll", place, true);
    };
  }, [open, tasks.length]);

  useEffect(() => {
    if (!open) return undefined;
    function onPointer(event: PointerEvent) {
      const target = event.target as Node | null;
      if (buttonRef.current?.contains(target) || panelRef.current?.contains(target)) return;
      setOpen(false);
    }
    function onKey(event: KeyboardEvent) {
      if (event.key !== "Escape") return;
      setOpen(false);
      buttonRef.current?.focus();
    }
    document.addEventListener("pointerdown", onPointer);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("pointerdown", onPointer);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  if (!tasks.length) return null;

  async function end(task: RunningTask) {
    if (ending) return;
    setEnding(true);
    try {
      await onEnd?.(task);
    } catch {
      // The session banner shows the error. The row stays so it can be ended again.
    } finally {
      setEnding(false);
    }
  }

  const countLabel = `${tasks.length} running ${tasks.length === 1 ? "task" : "tasks"}`;
  const agents = tasks.filter((task) => task.agent);
  const commands = tasks.filter((task) => !task.agent);
  const groups = [
    { title: "Agents", tasks: agents },
    { title: "Commands", tasks: commands },
  ].filter((group) => group.tasks.length);

  function show(rowId: string) {
    setOpen(false);
    const row = document.querySelector(`[data-subagent="${CSS.escape(rowId)}"]`);
    if (!row) return;
    row.scrollIntoView({ behavior: "smooth", block: "center" });
    row.classList.add("flash");
    setTimeout(() => row.classList.remove("flash"), 1400);
  }

  return (
    <>
      <button
        ref={buttonRef}
        type="button"
        className={open ? "task-trigger open" : "task-trigger"}
        data-testid="task-trigger"
        aria-label={countLabel}
        aria-expanded={open}
        aria-haspopup="dialog"
        onClick={() => setOpen((value) => !value)}
      >
        <span className={agents.length ? "task-pulse agent" : "task-pulse"} aria-hidden="true" />
        <span className="task-badge">{tasks.length}</span>
        <span className="task-word" aria-hidden="true">running</span>
      </button>
      {open
        ? createPortal(
            <div
              ref={panelRef}
              className="task-overlay"
              role="dialog"
              aria-modal="false"
              aria-label="Running"
              data-testid="task-overlay"
            >
              {groups.map((group) => (
                <section key={group.title} aria-label={group.title}>
                  <div className="task-overlay-head">
                    <span>{group.title}</span>
                    <span className="task-count">{group.tasks.length}</span>
                  </div>
                  <ul>
                    {group.tasks.map((task) => (
                      <li key={task.id} className={task.rowId ? "jumps" : undefined}>
                        <span className={task.agent ? "task-pulse agent" : "task-pulse"} aria-hidden="true" />
                        {task.rowId ? (
                          <button type="button" className="task-label" title="Show in the thread" onClick={() => show(task.rowId ?? "")}>
                            <TaskText task={task} />
                          </button>
                        ) : (
                          <span className="task-label" title={task.label}>
                            <TaskText task={task} />
                          </span>
                        )}
                        <button
                          type="button"
                          className="task-end"
                          data-testid="task-end"
                          disabled={ending}
                          onClick={() => end(task)}
                        >
                          {ending ? (task.agent ? "Stopping…" : "Ending…") : task.agent ? "Stop" : "End"}
                        </button>
                      </li>
                    ))}
                  </ul>
                </section>
              ))}
            </div>,
            document.body,
          )
        : null}
    </>
  );
}

function TaskText({ task }: { task: RunningTask }) {
  return (
    <>
      <span className="task-name">{task.label}</span>
      {task.step ? <span className="task-step">{task.step}</span> : null}
    </>
  );
}
