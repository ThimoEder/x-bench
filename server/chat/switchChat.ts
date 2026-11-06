// Moves a chat to another provider. The chat keeps its id. Its session so far is frozen as it shows on screen
// and closed in its harness, which keeps it on disk. The new provider picks up its own earlier session of this
// chat when it has one, else starts a new one, and its first message carries the conversation it missed.

import type { Mode, Provider } from "../../bridge/provider.ts";
import type { SessionState } from "../../bridge/reducer.ts";
import type { ChatRecord, FrozenStretch } from "./chatRecords.ts";
import { anyEntries, needsSummary, withoutSummaryTurns, stripHandoff, summaryHandoff, SUMMARY_REQUEST, textHandoff, textLimit, wholeHandoff, wholeLimit, withHandoff, type Handoff, type Spoken } from "./handoff.ts";
import { presentSession, type ContextWindows, type PresentedItem } from "../present.ts";
import type { Providers } from "../providers/providers.ts";

export interface SwitchDeps {
  providers: Providers;
  ensureProvider(provider: Provider): Promise<void>;
  // The board rules of a builder chat's folder. Undefined for the Chat tab.
  rules(cwd: string): string | undefined;
  windows(): ContextWindows;
  // Why a provider cannot run a turn now (off, failed, or its plan used up), or null when it can.
  blocked(provider: Provider): string | null;
  // How long a summary turn may take. SUMMARY_MS unless a test needs it short.
  summaryMs?: number;
}

export interface SwitchRequest {
  chatId: string;
  provider: string;
  model?: string;
  effort?: string;
  // How the new model learns the conversation, when the person picked it: the old model's summary, or the
  // conversation as text without a turn on the old model. Unset, it follows the length and the old model.
  handoff?: "summary" | "text";
}

// A switch while it runs, as the page shows it.
export interface Switching {
  from: string;
  fromModel: string;
  to: string;
  toModel: string;
  startedAt: number;
  // The old model is writing the summary.
  summarizing: boolean;
  // Past the point a cancel can undo: the old session is closing.
  committing: boolean;
  // Messages sent meanwhile, which go out once the new model is ready. The host adds them when it presents the chat.
  held?: string[];
}

// What the host can see and do while a switch runs.
export interface SwitchControl {
  summarizing(): void;
  // The old session closes next. A cancel after this has nothing left to undo it with.
  committing(): void;
  // The person cancelled. The switch stops at its next step and the chat stays where it was.
  readonly cancelled: boolean;
}

export class SwitchCancelled extends Error {
  constructor() {
    super("The switch was cancelled.");
  }
}

// What the confirmation tells before the switch.
export interface SwitchPreview {
  from: string;
  to: string;
  // The new provider has a session of this chat it can pick up.
  resumes: boolean;
  // The conversation the new provider missed, whole.
  tokens: number;
  // The most that goes whole. Past it, the model the chat runs on now writes a summary first.
  cap: number;
  // What happens unless the person picks the other way: a summary, else the conversation as text.
  summarize: boolean;
  // Why the model the chat runs on now cannot summarize, when it cannot.
  blocked: string | null;
  // The conversation as text without a summary, for the way the person did not get by default.
  textTokens: number;
}

export class SwitchError extends Error {
  readonly status: number;
  constructor(message: string, status = 409) {
    super(message);
    this.status = status;
  }
}

const EMPTY: ChatRecord = { stretches: [], start: null, skip: 0, pending: null, handoffs: {} };

// The model's name as the session's model menu shows it.
export function modelName(session: Pick<SessionState, "configOptions" | "modelId">): string {
  const option = session.configOptions.find((item) => item.id === "model");
  const value = option?.currentValue ?? session.modelId;
  return option?.options?.find((choice) => choice.value === value)?.name || String(value || "");
}

function catalogName(provider: Provider, model: string | undefined) {
  const catalog = provider.models();
  const value = model || catalog.defaultModel;
  return catalog.models.find((choice) => choice.value === value)?.name || value || provider.label;
}

// Image bytes stay with the session that made them, which is closed once the chat moves on. A message keeps
// only the person's words of a handoff it carried.
function frozenItems(items: PresentedItem[]): PresentedItem[] {
  return items.map((item) => {
    const { images: _images, ...rest } = item;
    return (rest.type === "user" ? { ...rest, text: stripHandoff(rest.text) } : rest) as PresentedItem;
  });
}

interface Plan {
  live: Provider;
  target: Provider;
  current: SessionState;
  record: ChatRecord;
  frozen: FrozenStretch[];
  // The latest earlier stretch on the target provider, which it can pick up.
  resume: number;
  missed(resumed: boolean): Spoken[];
}

function plan(deps: SwitchDeps, request: SwitchRequest): Plan {
  const { providers } = deps;
  const live = providers.forSession(request.chatId);
  const current = live.getSession(request.chatId);
  if (!current) throw new SwitchError("No session is open", 400);
  if (current.status === "running") throw new SwitchError("Wait for the turn to end before switching the model.");
  const target = providers.get(request.provider);
  if (!target) throw new SwitchError("Unknown provider", 400);
  if (target.id === live.id) throw new SwitchError("The chat already runs on this provider.", 400);
  if (!providers.isEnabled(target)) throw new SwitchError(`${target.label} is off. Turn it on in Settings.`);
  const record = providers.records.get(request.chatId) ?? EMPTY;
  const presented = presentSession(current, deps.windows());
  const now: FrozenStretch = {
    provider: live.id,
    harnessId: providers.ids.toHarness(request.chatId),
    model: modelName(current),
    modelId: current.modelId ?? "",
    items: frozenItems(withoutSummaryTurns(presented.transcript.slice(record.skip))),
    // The session never got the handoff it was given: no message was sent on it.
    ...(record.pending ? { unsent: true } : {}),
    start: record.start,
  };
  const frozen = [...record.stretches, now];
  const resume = target.capabilities.loadSession ? frozen.map((stretch) => stretch.provider).lastIndexOf(target.id) : -1;
  const label = (stretch: FrozenStretch) => providers.get(stretch.provider)?.label || stretch.provider;
  return {
    live,
    target,
    current,
    record,
    frozen,
    resume,
    // A picked-up session that never got its handoff missed everything before its own stretch too.
    missed(resumed) {
      const from = resumed && !frozen[resume]?.unsent ? frozen.slice(resume + 1) : frozen;
      return from.map((stretch) => ({ speaker: label(stretch), items: stretch.items }));
    },
  };
}

function windowOf(deps: SwitchDeps, model: string | undefined, session?: SessionState | null) {
  return (model ? deps.windows()[model]?.size : undefined) ?? session?.contextSize ?? null;
}

export function previewSwitch(deps: SwitchDeps, request: SwitchRequest): SwitchPreview {
  const planned = plan(deps, request);
  const window = windowOf(deps, request.model || planned.target.models().defaultModel);
  const missed = planned.missed(planned.resume >= 0);
  const blocked = deps.blocked(planned.live);
  return {
    from: modelName(planned.current) || planned.live.label,
    to: catalogName(planned.target, request.model),
    resumes: planned.resume >= 0,
    tokens: wholeHandoff(missed).tokens,
    cap: wholeLimit(window),
    summarize: needsSummary(missed, window) && !blocked,
    blocked,
    textTokens: textHandoff(missed, textLimit(window)).tokens,
  };
}

// Ends a session's turn, answering a permission or plan request first: a turn waiting on one may not end on
// session/cancel alone.
export function stopTurn(provider: Provider, sessionId: string) {
  const session = provider.getSession(sessionId);
  while (provider.getSession(sessionId)?.pendingPermission) provider.cancelPermission(sessionId);
  if (session?.pendingPlan) provider.answerPlan?.(sessionId, "cancelled");
  if (session?.status === "running") provider.cancel(sessionId);
}

// Ends a session's turn and its background tasks, which outlive a cancel and, in some harnesses, session/close.
export async function stopWork(provider: Provider, sessionId: string) {
  // A cancelled turn starts the next queued message, so the queue empties first.
  for (const entry of provider.getSession(sessionId)?.queue ?? []) provider.removeQueued(sessionId, entry.id, entry.version);
  stopTurn(provider, sessionId);
  const running = provider.getSession(sessionId)?.backgroundTasks.filter((task) => task.status === "running") ?? [];
  await Promise.all(running.map((task) => provider.stopTask?.(sessionId, task.id).catch(() => {})));
}

// The most a summary turn may take before the switch hands over text instead. The page hides the session while
// it moves, so nobody could answer a turn that waits on the person.
export const SUMMARY_MS = 4 * 60_000;

// Asks the model the chat runs on now to summarize it, as one last turn of its session. null when it cannot. A
// handoff that session has not been sent yet goes with the request, so it summarizes what it was handed too.
async function summaryOf(deps: SwitchDeps, provider: string, harnessId: string, unsent: string | null): Promise<string | null> {
  const harness = deps.providers.harness(provider);
  if (!harness) return null;
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const before = harness.getSession(harnessId)?.transcript.length ?? 0;
    const turn = harness.prompt(harnessId, unsent ? withHandoff(unsent, SUMMARY_REQUEST) : SUMMARY_REQUEST);
    const late = new Promise<"late">((done) => {
      timer = setTimeout(() => done("late"), deps.summaryMs ?? SUMMARY_MS);
    });
    if ((await Promise.race([turn, late])) === "late") {
      stopTurn(harness, harnessId);
      return null;
    }
    const after = harness.getSession(harnessId)?.transcript.slice(before) ?? [];
    const text = after
      .filter((item) => item.type === "assistant")
      .map((item) => item.text)
      .join("\n\n")
      .trim();
    return text || null;
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

export async function switchChat(deps: SwitchDeps, request: SwitchRequest, control?: SwitchControl): Promise<void> {
  const { providers } = deps;
  const planned = plan(deps, request);
  const { live, current, frozen, resume } = planned;
  const target = providers.harness(planned.target.id)!;
  const cwd = current.cwd;
  const rules = deps.rules(cwd);
  const mode: Mode = target.modes.some((choice) => choice.id === current.modeId) ? (current.modeId as Mode) : providers.defaultMode(target);
  const oldHarness = frozen.at(-1)!.harnessId;
  await deps.ensureProvider(planned.target);

  let session: SessionState | undefined;
  let resumed = false;
  if (resume >= 0) {
    try {
      session = await target.loadSession(frozen[resume]!.harnessId, cwd, rules ? { rules } : {});
      resumed = Boolean(session);
    } catch {
      session = undefined;
    }
    if (session) {
      try {
        if (request.model) session = (await target.setConfig(session.id, "model", request.model)) ?? session;
        if (request.effort) session = (await target.setConfig(session.id, "effort", request.effort)) ?? session;
        if (session.modeId !== mode) session = (await target.setMode(session.id, mode)) ?? session;
      } catch {
        // The picked session runs on its own model or mode, which its menus show.
      }
    }
  }
  if (!session) {
    session = await target.createSession({ cwd, model: request.model, effort: request.effort, mode, ...(rules ? { rules } : {}) });
  }
  const opened = session;
  // Lets go of the session this switch opened. A new one goes from the harness too.
  const release = async () => {
    try {
      await target.forgetSession(opened.id);
      if (!resumed) await target.deleteSession?.(opened.id);
    } catch {
      // The chat stays where it was either way.
    }
  };
  const stop = async () => {
    await release();
    throw new SwitchCancelled();
  };
  if (control?.cancelled) await stop();
  const skip = resumed ? session.transcript.length : 0;
  const missedNow = planned.missed(resumed);
  // A picked-up session missed the stretches after its own, a new one all of them. Empty ones need no handoff.
  const missed = anyEntries(missedNow);
  // Past the limit, or when asked, the old model summarizes before its session closes. A summary that fails, an
  // old model that cannot run a turn, or the person's choice sends the conversation as text instead.
  const window = windowOf(deps, request.model, session);
  const long = needsSummary(missedNow, window);
  const way = request.handoff ?? (long && !deps.blocked(live) ? "summary" : "text");
  let handoff: Handoff;
  let summaryFailed = false;
  if (missed && way === "summary") {
    control?.summarizing();
    const summary = await summaryOf(deps, live.id, oldHarness, planned.record.pending);
    if (control?.cancelled) await stop();
    summaryFailed = !summary;
    // The summary turn handed the old session what it had not been sent, so picking it up later need not again.
    if (summary && planned.record.pending) {
      const { unsent: _sent, ...left } = frozen.at(-1)!;
      frozen[frozen.length - 1] = left;
    }
    handoff = summary ? summaryHandoff(missedNow, summary) : textHandoff(missedNow, textLimit(window));
  } else {
    handoff = long ? textHandoff(missedNow, textLimit(window)) : wholeHandoff(missedNow);
  }

  if (control?.cancelled) await stop();
  control?.committing();

  // The record, then the index, and the old session closes last: a save that fails leaves the chat where it was.
  const index = frozen.length;
  const saved = providers.records.save(request.chatId, {
    stretches: frozen,
    start: { fromProvider: live.id, fromModel: modelName(current), tokens: missed ? handoff.tokens : 0, resumed, summarized: handoff.summarized, cut: handoff.cut, ...(summaryFailed ? { summaryFailed } : {}) },
    skip,
    pending: missed ? handoff.text : null,
    handoffs: missed ? { ...planned.record.handoffs, [String(index)]: handoff.text } : planned.record.handoffs,
  });
  const row = providers.index.get(request.chatId);
  // A harness that notes its sessions itself (Codex's approval preset) filed the new one as its own row, before
  // the chat ran on it. The chat takes that row's preset, and the row goes.
  const filed = session.id !== request.chatId ? providers.index.get(session.id) : null;
  if (saved) {
    try {
      providers.index.record({
        id: request.chatId,
        provider: target.id,
        harnessId: session.id,
        cwd,
        title: row?.title || providers.catalogTitle(request.chatId) || "",
        updatedAt: new Date().toISOString(),
        ...(filed?.harnessMode ? { harnessMode: filed.harnessMode } : {}),
      });
    } catch {
      // Checked below, from the file.
    }
  }
  if (!saved || providers.index.get(request.chatId)?.harnessId !== session.id) {
    if (saved) {
      if (planned.record === EMPTY) providers.records.drop(request.chatId);
      else providers.records.save(request.chatId, planned.record);
    }
    await release();
    throw new SwitchError("The chat could not be saved, so it stays where it was.", 500);
  }
  if (filed) providers.index.drop(session.id);
  try {
    await providers.harness(live.id)?.forgetSession(oldHarness);
  } catch {
    // The old session stays open in its harness until that harness stops. The chat has moved on either way.
  }
}
