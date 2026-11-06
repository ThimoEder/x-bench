import { useRef, useState } from "react";
import type { ReactNode } from "react";
import type { PermissionOption } from "../../../bridge/protocol.ts";
import type { PresentedDiff, PresentedPermission, PresentedPlan } from "../../../server/present.ts";
import { MarkdownInline, MarkdownView } from "../markdown/MarkdownView.tsx";
import { CaretIcon } from "../../icons.tsx";
import { useCloseOutside } from "../../useCloseOutside.ts";
import { hunkRows, shortPath } from "./diff.ts";
import type { ReceiptText } from "./receipts.ts";
import { leaveRef } from "../../leaveRef.ts";

// A pending permission; a plan approval also carries the plan text.
export type PermissionCardRequest = Pick<PresentedPermission, "title" | "rawInput" | "options"> &
  Partial<Pick<PresentedPermission, "kind" | "id" | "role" | "path" | "command" | "label">> &
  Partial<Pick<PresentedPlan, "plan" | "planMissing">>;

export interface PermissionCardProps {
  permission: PermissionCardRequest;
  call: (path: string, body: Record<string, string>) => Promise<unknown> | void;
  actionPath?: string;
  actionField?: string;
  // The provider's name, for a request that names no tool.
  agent?: string;
  // The file changes of the tool call that asks, from its row in the thread.
  diffs?: readonly PresentedDiff[];
  cwd?: string;
  onAnswered?: (receipt: ReceiptText) => void;
}

interface Choice {
  key: string;
  label: string;
  title?: string;
  reject: boolean;
  receipt: ReceiptText;
  pick: () => void;
}

const LABELS: Record<string, string> = { allow_once: "Allow once", allow_always: "Always allow", reject_once: "Deny", reject_always: "Always deny" };
const DONE: Record<string, string> = { allow_once: "Allowed once", allow_always: "Always allowed", reject_once: "Denied", reject_always: "Always denied" };
// The app's own tools ask with their kind as the request's kind (server/chat/prompts.ts).
const HOST_KINDS = new Set(["browser", "simulator", "routine"]);

export function PermissionCard({ permission, call, actionPath = "/api/permission", actionField = "optionId", agent, diffs = [], cwd = "", onAnswered }: PermissionCardProps) {
  const planApproval = permission.plan !== undefined || permission.planMissing === true;
  const answer = (option: PermissionOption, receipt: ReceiptText) => () => {
    void Promise.resolve(call(actionPath, { [actionField]: option.optionId, ...(permission.id ? { id: permission.id } : {}) })).then(() => onAnswered?.(receipt), () => {});
  };
  if (planApproval) {
    const { title, body } = planParts(permission.plan ?? "");
    const choices = permission.options.map((option): Choice => {
      const receipt = planAnswer(option, permission.plan ?? "");
      return { key: option.optionId, label: planLabel(option), title: option.name || undefined, reject: isReject(option), receipt, pick: answer(option, receipt) };
    });
    return <PlanCard title={title} plan={permission.plan ? body : undefined} choices={choices} cwd={cwd} />;
  }
  const asked = describe(permission, agent || "The agent", diffs, cwd);
  const always = permission.options.filter((option) => option.kind === "allow_always");
  const scope = always.length === 1 && always[0]?.name && !/^always allow$/i.test(always[0].name) ? alwaysNote(always[0].name) : "";
  const note = [asked.note, scope].filter(Boolean).join(" ");
  const choices = permission.options.map((option): Choice => {
    const reject = isReject(option);
    const receipt: ReceiptText = { icon: reject ? "close" : "check", label: DONE[String(option.kind)] ?? (reject ? "Denied" : "Allowed"), detail: asked.subject, code: true };
    return { key: option.optionId, label: LABELS[String(option.kind)] || option.name || option.optionId, title: option.name || undefined, reject, receipt, pick: answer(option, receipt) };
  });
  return (
    <section className="card perm permission" data-testid="permission" aria-live="polite">
      <div className="card-head">
        <ShieldIcon />
        <h2>{asked.heading}</h2>
      </div>
      {asked.body}
      {note ? <p className="card-note">{note}</p> : null}
      <CardActions choices={choices} testId={(choice) => `permission-${permission.options.find((option) => option.optionId === choice.key)?.kind}`} />
    </section>
  );
}

interface PlanCardProps {
  title: string;
  // The plan without its heading. Undefined when the agent wrote none.
  plan?: string;
  choices: Choice[];
  cwd?: string;
}

function PlanCard({ title, plan, choices, cwd }: PlanCardProps) {
  return (
    <section className="card ask plan-approval" data-testid="plan" aria-live="polite">
      <div className="card-head">
        <PlanIcon />
        <h2>
          <MarkdownInline text={title} />
        </h2>
        <span className="grow" />
        <span className="card-from">Plan · ready to build</span>
      </div>
      {plan ? <MarkdownView className="plan-doc" text={plan} cwd={cwd} /> : <p className="card-note" data-testid="plan-empty">No plan written yet.</p>}
      <CardActions choices={choices} />
    </section>
  );
}

// A plan that waits as the session's pendingPlan, answered with one of three outcomes.
export function ChatPlanCard({ plan, cwd, onDecide, onAnswered }: { plan: PresentedPlan; cwd?: string; onDecide: (outcome: string) => Promise<unknown> | void; onAnswered?: (receipt: ReceiptText) => void }) {
  const { title, body } = planParts(plan.plan);
  const choice = (outcome: string, label: string, reject: boolean): Choice => {
    const receipt = chatPlanAnswer(outcome, plan.plan);
    return { key: outcome, label, reject, receipt, pick: () => void Promise.resolve(onDecide(outcome)).then(() => onAnswered?.(receipt), () => {}) };
  };
  const choices = [choice("approved", "Approve", false), choice("cancelled", "Keep planning", true), choice("abandoned", "Quit plan", true)];
  return <PlanCard title={title} plan={plan.plan ? body : undefined} choices={choices} cwd={cwd} />;
}

function CardActions({ choices, testId }: { choices: Choice[]; testId?: (choice: Choice) => string }) {
  // Two answers that would read the same keep the agent's own words.
  const labels = choices.map((choice) => choice.label);
  const shown = choices.map((choice) => (labels.filter((label) => label === choice.label).length > 1 ? { ...choice, label: choice.title || choice.label } : choice));
  const allows = shown.filter((choice) => !choice.reject);
  const primary = allows[0];
  const folded = allows.length > 2 ? allows.slice(1) : [];
  const button = (choice: Choice, extra = "") => (
    <button
      key={choice.key}
      type="button"
      className={`${choice === primary ? "btn primary" : "btn ghost"}${extra}`}
      title={choice.title && choice.title !== choice.label ? choice.title : undefined}
      data-testid={testId?.(choice)}
      onClick={choice.pick}
    >
      {choice.label}
    </button>
  );
  return (
    <div className="card-actions">
      {shown.filter((choice) => choice.reject).map((choice) => button(choice))}
      <span className="grow" />
      {folded.length ? null : allows.slice(1).map((choice) => button(choice))}
      {primary && folded.length ? <SplitButton main={button(primary, " split-main")} choices={folded} testId={testId} /> : primary ? button(primary) : null}
    </div>
  );
}

function SplitButton({ main, choices, testId }: { main: ReactNode; choices: Choice[]; testId?: (choice: Choice) => string }) {
  const [open, setOpen] = useState(false);
  const root = useRef<HTMLDivElement | null>(null);
  useCloseOutside(open, root, () => setOpen(false));
  return (
    <div className="split-button" ref={root}>
      {main}
      <button type="button" className="btn primary split-toggle" aria-label="More ways to go ahead" aria-haspopup="menu" aria-expanded={open} data-testid="more-choices" onClick={() => setOpen((value) => !value)}>
        <CaretIcon />
      </button>
      {open ? (
        <ul ref={leaveRef} className="option-list" role="menu" aria-label="Ways to go ahead">
          <li className="option-title" role="presentation">
            Ways to go ahead
          </li>
          {choices.map((choice) => (
            <li key={choice.key}>
              <button
                type="button"
                role="menuitem"
                title={choice.title && choice.title !== choice.label ? choice.title : undefined}
                data-testid={testId?.(choice)}
                onClick={() => {
                  setOpen(false);
                  choice.pick();
                }}
              >
                {choice.label}
              </button>
            </li>
          ))}
        </ul>
      ) : null}
    </div>
  );
}

interface Asked {
  heading: string;
  body: ReactNode;
  note: string;
  // What the receipt names: the command, the file, the site.
  subject: string;
}

function describe(permission: PermissionCardRequest, who: string, diffs: readonly PresentedDiff[], cwd: string): Asked {
  const title = permission.title.replace(/`/g, "");
  if (HOST_KINDS.has(permission.kind ?? "")) {
    const detail = typeof permission.rawInput === "string" ? permission.rawInput : "";
    const url = /https?:\/\/\S+/.exec(detail)?.[0];
    return {
      heading: `${who} wants to ${title.charAt(0).toLowerCase()}${title.slice(1)}`,
      body: permission.kind === "browser" ? (
        <div className="perm-url">
          <GlobeIcon />
          <span>{detail}</span>
        </div>
      ) : detail ? (
        <pre className="cmd">{detail}</pre>
      ) : null,
      note: "",
      subject: (url && hostOf(url)) || title,
    };
  }
  const command = permission.command;
  if (command) {
    const line = command.split("\n")[0] ?? "";
    return {
      heading: `${who} wants to run a command`,
      body: <pre className="cmd">{command}</pre>,
      note: permission.label ? sentence(permission.label) : "",
      subject: line.length > 60 ? `${line.slice(0, 59)}…` : line,
    };
  }
  const path = diffs[0]?.path || permission.path || "";
  if (permission.role === "edit" || diffs.length) {
    const shown = path ? shortPath(cwd, path) : "";
    return {
      heading: shown ? `${who} wants to edit ${shown}` : `${who} wants to edit a file`,
      body: diffs.length ? diffs.map((diff) => <PermDiff key={diff.path} diff={diff} cwd={cwd} named={diffs.length > 1} />) : <pre className="cmd">{formatInput(permission.rawInput)}</pre>,
      note: "",
      subject: shown || title,
    };
  }
  return {
    heading: title || `${who} wants to use a tool`,
    body: permission.rawInput ? <pre className="cmd">{formatInput(permission.rawInput)}</pre> : null,
    note: "",
    subject: title || "the tool",
  };
}

// Enough lines for the whole of most edits, which the person approves before they happen.
const PERM_DIFF_LINES = 600;

function PermDiff({ diff, cwd, named }: { diff: PresentedDiff; cwd: string; named: boolean }) {
  const { rows, cut } = hunkRows(diff.oldText, diff.newText, PERM_DIFF_LINES);
  return (
    <>
      {named ? <p className="perm-path">{shortPath(cwd, diff.path)}</p> : null}
      <div className="perm-diff">
        {rows.map((row, index) => (
          <div key={index} className={`dl ${row.type}`}>
            <span className="n">{row.ln}</span>
            <span className="s">{row.type === "add" ? "+" : row.type === "del" ? "−" : " "}</span>
            <span className="c">{row.text || " "}</span>
          </div>
        ))}
      </div>
      {cut || diff.truncated ? <p className="card-note perm-cut">The rest of this change is not shown.</p> : null}
    </>
  );
}

// What Always allow covers, in the agent's words: "Yes, and don't ask again for npm commands".
function alwaysNote(name: string) {
  const rest = name.replace(/^yes,\s*(?:and\s+)?(?:allow\s+)?/i, "");
  return /^always allow/i.test(rest) ? sentence(rest) : `Always allow: ${sentence(rest)}`;
}

function sentence(text: string) {
  const trimmed = text.trim();
  return /[.!?]$/.test(trimmed) || !trimmed ? trimmed : `${trimmed}.`;
}

function isReject(option: PermissionOption) {
  return String(option.kind || "").startsWith("reject");
}

// A plan's first heading names it, and the card shows the rest.
function planParts(text: string): { title: string; body: string } {
  const heading = /^\s*#{1,6}\s+(.+)(?:\n|$)/.exec(text);
  return heading ? { title: (heading[1] ?? "").trim(), body: text.slice(heading[0].length) } : { title: "Approve this plan", body: text };
}

// A plan answer in the card's words: the agent's "Yes, and use auto mode" reads "Approve, use auto mode".
function planLabel(option: PermissionOption) {
  if (isReject(option)) return "Keep planning";
  if (option.kind === "allow_once") return "Approve";
  const rest = /^yes,\s*(?:and\s+)?(.+)$/i.exec(option.name ?? "")?.[1];
  return rest ? `Approve, ${rest}` : option.name || "Approve";
}

// The receipt of a plan the agent asks to leave plan mode with through a permission.
function planAnswer(option: PermissionOption, plan: string): ReceiptText {
  const detail = planParts(plan).title.replace(/`/g, "");
  if (isReject(option)) return { icon: "plan", label: "Kept planning", detail, code: false };
  const label = planLabel(option);
  return { icon: "check", label: label.startsWith("Approve") ? label.replace("Approve", "Plan approved") : "Plan approved", detail, code: false };
}

// The receipt of a plan that waits as the session's pendingPlan, answered approved, cancelled or abandoned.
function chatPlanAnswer(outcome: string, plan: string): ReceiptText {
  const detail = planParts(plan).title.replace(/`/g, "");
  if (outcome === "approved") return { icon: "check", label: "Plan approved", detail, code: false };
  return outcome === "abandoned" ? { icon: "close", label: "Quit the plan", detail, code: false } : { icon: "plan", label: "Kept planning", detail, code: false };
}

function hostOf(url: string) {
  try {
    return new URL(url).host;
  } catch {
    return "";
  }
}

function formatInput(raw: unknown): string {
  return typeof raw === "string" ? raw : JSON.stringify(raw, null, 2);
}

function ShieldIcon() {
  return (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinejoin="round" aria-hidden="true">
      <path d="M12 3 5 6v5.5c0 4.3 3 7.7 7 9.5 4-1.8 7-5.2 7-9.5V6z" />
    </svg>
  );
}

export function PlanIcon() {
  return (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M10 6.5h9.5M10 12h9.5M10 17.5h9.5" />
      <path d="m4 6.5 1.2 1.2L7.5 5.4M4 12l1.2 1.2 2.3-2.3" />
      <circle cx="5.7" cy="17.5" r="1.1" />
    </svg>
  );
}

function GlobeIcon() {
  return (
    <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" aria-hidden="true">
      <circle cx="12" cy="12" r="8.5" />
      <path d="M3.5 12h17M12 3.5c2.5 2.6 3.5 5.4 3.5 8.5s-1 5.9-3.5 8.5c-2.5-2.6-3.5-5.4-3.5-8.5s1-5.9 3.5-8.5z" />
    </svg>
  );
}
