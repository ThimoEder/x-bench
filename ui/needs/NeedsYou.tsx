import { useState } from "react";
import type { ProviderView, TicketLinks, Wait } from "../../server/snapshot.ts";
import { shortWhen } from "../../server/routines/routineSchedule.ts";
import { ticketNumber } from "../board/TicketCreate.tsx";
import { ChatPlanCard, PermissionCard, PlanIcon, ShieldIcon } from "../chat/messages/PermissionCard.tsx";
import { QuestionCard, QuestionIcon } from "../chat/messages/QuestionCard.tsx";
import { CaretIcon } from "../icons.tsx";
import type { ApiCall } from "../launchToken.ts";

export interface NeedsYouProps {
  waits: readonly Wait[];
  tickets: TicketLinks;
  providers: readonly ProviderView[];
  call: ApiCall;
  onOpenChat: (wait: Wait) => void;
}

function isPlan(wait: Wait): boolean {
  return Boolean(wait.plan || wait.permission?.plan !== undefined);
}

export function whyOf(wait: Wait): string {
  if (isPlan(wait)) return "has a plan to approve";
  if (wait.question) return "asks a question";
  return wait.permission?.role === "shell" ? "asks to run a command" : "asks for a permission";
}

export function sinceText(since: number, now: Date = new Date()): string {
  const date = new Date(since);
  if (date.toDateString() === now.toDateString()) return date.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
  return shortWhen(date, now);
}

export function NeedsYou({ waits, tickets, providers, call, onOpenChat }: NeedsYouProps) {
  const [openKey, setOpenKey] = useState<string | null>(null);
  return (
    <div className="routines" data-testid="needs-you">
      <div className="routines-scroll">
        <header className="routines-head">
          <div>
            <h1>Needs you</h1>
            <p className="routines-lede">Chats waiting on a decision, in every folder. Each goes on from where it stopped once you decide.</p>
          </div>
        </header>
        {waits.length ? (
          <ul className="waits">
            {waits.map((wait) => (
              <WaitRow
                key={wait.key}
                wait={wait}
                open={openKey === wait.key}
                ticket={tickets.bySession[wait.sessionId]?.[0]}
                agent={providers.find((provider) => provider.id === wait.provider)?.label}
                call={call}
                onToggle={() => setOpenKey(openKey === wait.key ? null : wait.key)}
                onOpenChat={() => onOpenChat(wait)}
              />
            ))}
          </ul>
        ) : (
          <section className="routines-empty">
            <h2>Nothing waits on you</h2>
            <p>A chat that asks for a permission, asks a question or has a plan to approve shows up here.</p>
          </section>
        )}
      </div>
    </div>
  );
}

interface WaitRowProps {
  wait: Wait;
  open: boolean;
  ticket: TicketLinks["bySession"][string][number] | undefined;
  agent: string | undefined;
  call: ApiCall;
  onToggle: () => void;
  onOpenChat: () => void;
}

function WaitRow({ wait, open, ticket, agent, call, onToggle, onOpenChat }: WaitRowProps) {
  const act = (path: string, body: Record<string, unknown> = {}) => call(path, { ...body, sessionId: wait.sessionId });
  const number = ticket ? ticketNumber(ticket) : null;
  return (
    <li className={open ? "is-open" : undefined} data-testid="wait">
      <button type="button" className="wait" aria-expanded={open} onClick={onToggle}>
        <span className="wait-icon">{isPlan(wait) ? <PlanIcon /> : wait.question ? <QuestionIcon /> : <ShieldIcon />}</span>
        <span className="wait-text">
          <span className="wait-title">
            {number ? `${number} ` : ""}
            {wait.title || "New chat"}
          </span>
          <span className="wait-why">{`${wait.folder || "Chat"} · ${whyOf(wait)} · since ${sinceText(wait.since)}`}</span>
        </span>
        <span className="wait-go" aria-hidden="true">
          <CaretIcon />
        </span>
      </button>
      {open ? (
        <div className="wait-body">
          {wait.permission ? <PermissionCard permission={wait.permission} call={act} agent={agent} diffs={wait.diffs} cwd={wait.cwd} /> : null}
          {wait.question ? <QuestionCard question={wait.question} call={act} provider={wait.provider} /> : null}
          {wait.plan ? <ChatPlanCard plan={wait.plan} cwd={wait.cwd} onDecide={(outcome) => act("/api/plan", { outcome })} /> : null}
          <button type="button" className="text-button wait-open" data-testid="wait-open-chat" onClick={onOpenChat}>
            Open chat
          </button>
        </div>
      ) : null}
    </li>
  );
}
