import { useEffect, useRef, useState } from "react";
import type { CSSProperties } from "react";
import type { PlanEntry } from "../../bridge/protocol.ts";
import { CloseIcon } from "../icons.tsx";

const STEP_NAME: Record<string, string> = { completed: "Done", in_progress: "Doing" };

function StepMark({ status }: { status: string }) {
  return (
    <span className="plan-step-mark" data-status={status} aria-hidden="true">
      <svg width="15" height="15" viewBox="0 0 16 16">
        {status === "completed" ? (
          <>
            <circle cx="8" cy="8" r="7" className="plan-mark-fill" />
            <path d="M4.8 8.2 7 10.3l4.2-4.6" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" />
          </>
        ) : status === "in_progress" ? (
          <>
            <circle cx="8" cy="8" r="6.2" fill="none" className="plan-mark-track" strokeWidth="1.6" />
            <path d="M8 1.8a6.2 6.2 0 0 1 6.2 6.2" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
          </>
        ) : (
          <circle cx="8" cy="8" r="6.2" fill="none" stroke="currentColor" strokeWidth="1.3" strokeDasharray="2.2 2.2" />
        )}
      </svg>
    </span>
  );
}

// The plan each chat's user hid, as its JSON, so it stays hidden until the agent changes it.
const hiddenPlans = new Map<string, string>();

// The agent's step list (its todo list), each with where it stands.
export function PlanSteps({ steps }: { steps: PlanEntry[] }) {
  if (!steps.length) return null;
  return (
    <ol className="plan-steps" data-testid="plan-steps">
      {steps.map((step, index) => {
        const status = step.status || "pending";
        return (
          <li key={`${index}:${step.content ?? ""}`} data-status={status} aria-label={`${STEP_NAME[status] ?? "To do"}: ${step.content ?? ""}`}>
            <StepMark status={status} />
            <span className="plan-step-text">{step.content}</span>
          </li>
        );
      })}
    </ol>
  );
}

// The agent's step list in the composer shelf: one line with the current step and the progress, the whole list when opened.
// A finished plan goes once its turn ends. An unfinished one stays, to show where the agent stopped.
export function PlanShelf({ sessionId, steps, running }: { sessionId: string; steps: PlanEntry[]; running: boolean }) {
  const [open, setOpen] = useState(false);
  const [hidden, setHidden] = useState(() => hiddenPlans.get(sessionId) ?? "");
  const bodyRef = useRef<HTMLDivElement | null>(null);
  // A long list opens on the current step.
  useEffect(() => {
    const list = bodyRef.current?.querySelector<HTMLElement>(".plan-steps");
    const item = list?.querySelector<HTMLElement>('[data-status="in_progress"]') ?? list?.querySelector<HTMLElement>('[data-status="pending"]');
    if (!open || !list || !item) return;
    list.scrollTop = Math.max(0, item.offsetTop - (list.clientHeight - item.offsetHeight) / 2);
  }, [open]);
  const json = JSON.stringify(steps);
  if (hidden && hidden !== json) {
    hiddenPlans.delete(sessionId);
    setHidden("");
  }
  const done = steps.filter((step) => step.status === "completed").length;
  const finished = done === steps.length;
  if (!steps.length || json === hidden || (finished && !running)) return null;
  const current = steps.find((step) => step.status === "in_progress") ?? steps.find((step) => step.status !== "completed");
  return (
    <div className="shelf-plan" data-testid="shelf-plan">
      <div className="shelf-plan-head">
        <button type="button" className="shelf-plan-toggle" aria-expanded={open} aria-label={`${finished ? "All steps done" : current?.content}, ${done} of ${steps.length} steps done`} onClick={() => setOpen(!open)}>
          <span className="shelf-plan-label">
            <span className="shelf-plan-now">
              <StepMark status={finished ? "completed" : current?.status || "pending"} />
              <span className="shelf-plan-now-text">{finished ? `All ${steps.length} steps done` : current?.content}</span>
            </span>
            <span className="shelf-plan-title" aria-hidden="true">Plan · {steps.length} {steps.length === 1 ? "step" : "steps"}</span>
          </span>
          <span className="shelf-plan-count">{done}/{steps.length}</span>
          <span className="shelf-plan-meter" style={{ "--steps": steps.length } as CSSProperties} aria-hidden="true">
            {steps.map((step, index) => <i key={index} data-status={step.status || "pending"} />)}
          </span>
          <svg className="shelf-plan-chev" width="10" height="10" viewBox="0 0 10 10" aria-hidden="true"><path d="M2.2 6.2 5 3.6l2.8 2.6" fill="none" stroke="currentColor" strokeWidth="1.3" /></svg>
        </button>
        <button
          type="button"
          className="shelf-plan-close"
          aria-label="Hide the plan"
          onClick={() => {
            hiddenPlans.set(sessionId, json);
            setHidden(json);
          }}
        >
          <CloseIcon />
        </button>
      </div>
      <div className="shelf-plan-body" ref={bodyRef} inert={!open}>
        <div>
          <PlanSteps steps={steps} />
        </div>
      </div>
    </div>
  );
}
