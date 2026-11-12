import { memo, useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import type { ReactNode } from "react";
import { createPortal } from "react-dom";
import type { PageMark } from "../../../server/browser/browserTools.ts";
import type { AppMark } from "../../../server/devices/ios/simulatorTools.ts";
import { localBoardTarget } from "../../../server/board/boardLink.ts";
import type { TicketId } from "../../../server/board/ticketId.ts";
import type * as React from "react";
import type { Delivery } from "../../../bridge/reducer.ts";
import type { BackgroundTask } from "../../../bridge/protocol.ts";
import type {
  PresentedAttachment,
  PresentedImage,
  PresentedItem,
  PresentedTextItem,
  PresentedToolItem,
} from "../../../server/present.ts";
import { ChatPlanCard, PermissionCard, PlanIcon } from "./PermissionCard.tsx";
import { QuestionCard } from "./QuestionCard.tsx";
import { addReceipt, askingRow, receiptsAfter, useReceipts } from "./receipts.ts";
import type { Receipt, ReceiptText } from "./receipts.ts";
import { MarkdownInline, MarkdownView, MathText } from "../markdown/MarkdownView.tsx";
import type { MarkdownViewProps } from "../markdown/MarkdownView.tsx";
import { ShotLightbox } from "./ShotLightbox.tsx";
import { fileBadge } from "../composer/attachments.ts";
import { workingLine } from "./activity.ts";
import { userMessageView } from "./reminders.ts";
import type { TaskNotice } from "./reminders.ts";
import { formatElapsed } from "./elapsed.ts";
import { latestThinking, previewAsWritten, thinkingSteps } from "./thinking.ts";
import { sessionFilePath } from "../composer/mentions.ts";
import { GLIDE_MS, followScroll, glideStart, glideTop, transcriptMark } from "./scroll.ts";
import { withToken } from "../../launchToken.ts";
import { desktopBridge, isWebUrl, paneCall } from "../../browser/browserPane.ts";
import { browserLabel } from "../../browser/browserLabel.ts";
import { simulatorLabel } from "../../devices/simulatorLabel.ts";
import { isPlanTool } from "../planTool.ts";
import { folderName } from "../../folder/draftFolder.ts";
import { DraftLine } from "../composer/DraftLine.tsx";
import { useStableCallback } from "../../useStableCallback.ts";
import { useCopy } from "../../useCopy.ts";
import { ArrowDownIcon, CheckIcon, CloseIcon, CopyIcon } from "../../icons.tsx";
import { PendingWrinkle, Wrinkle } from "./Wrinkle.tsx";
import { chatRiseOn } from "../chatRise.ts";
import { hunkRows, shortPath } from "./diff.ts";
import type { SessionCall, TranscriptSession } from "../Transcript.tsx";
import { leaveRef } from "../../leaveRef.ts";

export interface MessageListProps {
  session: TranscriptSession;
  plain: boolean;
  drafting: boolean;
  // The app opened on this new session: its line says welcome first.
  welcome?: boolean;
  // Goes up when the reader sends a message: the list jumps to the end and follows it again.
  followTick?: number;
  onOpenFile?: (sessionId: string, filePath: string) => void;
  onOpenBoard?: (cwd: string, taskId: TicketId | null) => void;
  onSendNow?: (deliveryId: string) => void;
  onRemoveSteer?: (deliveryId: string) => void;
  // A provider's name, for the line where a switched chat moved on.
  providerLabel?: (provider: string) => string;
  // Stops a switch to another provider that is still running.
  onCancelSwitch?: () => void;
  // Stops a background task, such as a subagent that runs in the background.
  onStopTask?: (taskId: string) => void;
  // Answers the agent's requests, which show as cards at the end of the thread.
  act?: SessionCall;
  agentLabel?: string;
  footer?: ReactNode;
}

// The model the session runs on, as its model menu names it.
function currentModelName(session: TranscriptSession): string {
  const option = session.configOptions.find((item) => item.id === "model");
  return option?.options.find((choice) => choice.value === option.currentValue)?.name || String(option?.currentValue ?? "");
}

const RISE: Keyframe[] = [{ opacity: 0, translate: "0 14px", filter: "blur(4px)" }, {}];

// The scrolling transcript. It follows the end while the reader is at the bottom. Scrolled up, it stays
// put and offers a button back to the end, which says so when something new arrived below.
export function MessageList({ session, plain, drafting, welcome = false, followTick = 0, onOpenFile, onOpenBoard, onSendNow, onRemoveSteer, providerLabel = (provider) => provider, onCancelSwitch, onStopTask, act, agentLabel, footer }: MessageListProps) {
  const scroller = useRef<HTMLDivElement | null>(null);
  const stick = useRef(true);
  const pinning = useRef(false);
  const lastTop = useRef(0);
  const glide = useRef(0);
  const mark = transcriptMark(session.transcript);
  const lastMark = useRef(mark);
  const [away, setAway] = useState(false);
  const [fresh, setFresh] = useState(false);

  function pin(el: HTMLElement, top: number) {
    pinning.current = true;
    el.scrollTop = top;
    lastTop.current = el.scrollTop;
    pinning.current = false;
  }

  function scrollToEnd() {
    const el = scroller.current;
    if (!el || !stick.current || glide.current) return;
    const gap = el.scrollHeight - el.scrollTop - el.clientHeight;
    if (gap < 2) {
      lastTop.current = el.scrollTop;
      return;
    }
    pin(el, el.scrollHeight);
  }

  function stopGlide() {
    if (glide.current) cancelAnimationFrame(glide.current);
    glide.current = 0;
  }

  // smooth glides the last window to the end. The reader scrolling up during it stops it.
  function follow(smooth = false) {
    stick.current = true;
    setAway(false);
    setFresh(false);
    stopGlide();
    const el = scroller.current;
    if (!el || !smooth || window.matchMedia("(prefers-reduced-motion: reduce)").matches) {
      scrollToEnd();
      return;
    }
    const end = () => el.scrollHeight - el.clientHeight;
    const start = glideStart(el.scrollTop, end(), el.clientHeight);
    pin(el, start);
    const began = performance.now();
    const step = (now: number) => {
      glide.current = 0;
      if (!stick.current) return;
      const elapsed = now - began;
      pin(el, glideTop(start, end(), elapsed));
      if (elapsed < GLIDE_MS) glide.current = requestAnimationFrame(step);
    };
    glide.current = requestAnimationFrame(step);
  }

  useEffect(() => stopGlide, []);

  useLayoutEffect(() => {
    follow();
    const el = scroller.current;
    const content = el?.firstElementChild;
    if (!el || !content || typeof ResizeObserver === "undefined") return undefined;
    const observer = new ResizeObserver(() => {
      if (!stick.current) return;
      scrollToEnd();
    });
    observer.observe(content);
    observer.observe(el);
    return () => observer.disconnect();
  }, [session.id]);

  useLayoutEffect(() => {
    if (followTick) follow(true);
  }, [followTick]);

  useLayoutEffect(() => {
    if (!stick.current) return;
    scrollToEnd();
  }, [session.revision, session.pendingPermission, session.pendingQuestion]);

  useEffect(() => {
    if (mark === lastMark.current) return;
    lastMark.current = mark;
    if (!stick.current) setFresh(true);
  }, [mark]);

  // A request the agent waits on is news too, even when the transcript did not change.
  const waitingFor = waitingKey(session);
  useEffect(() => {
    if (waitingFor && !stick.current) setFresh(true);
  }, [waitingFor]);

  const steps = subagentSteps(session.transcript);
  const tasks = subagentTasks(session.backgroundTasks);
  const asking = askingRow(session);
  const hidden = asking ? new Set([...steps.folded, asking.id]) : steps.folded;
  const receipts = useReceipts(session.id);
  const answered = (receipt: ReceiptText) => addReceipt(session.id, session, receipt);
  const stretches = session.stretches ?? [];
  const switching = session.switching;
  const empty = session.transcript.length === 0 && stretches.length === 0 && !switching;
  const label = providerLabel;
  const openFileRef = useRef(onOpenFile);
  openFileRef.current = onOpenFile;
  const sessionId = session.id;
  // One function per session, so the memoised Activity blocks keep their props while a turn streams.
  const openFile = useCallback((filePath: string) => openFileRef.current?.(sessionId, filePath), [sessionId]);
  const sendNow = useStableCallback((deliveryId: string) => onSendNow?.(deliveryId));
  const removeSteer = useStableCallback((deliveryId: string) => onRemoveSteer?.(deliveryId));
  const stopTask = useStableCallback((taskId: string) => onStopTask?.(taskId));

  // A chat rises in once as it opens, as soon as it has something to show; what streams in later stays put,
  // and so does a chat just sent from the composer, which holds only its first message.
  const risen = useRef<string | null>(null);
  const asked = !stretches.length && session.transcript.every((item) => item.type === "user");
  useLayoutEffect(() => {
    const el = scroller.current;
    const thread = el?.firstElementChild;
    if (!el || !thread || risen.current === session.id || (session.loading && empty)) return;
    risen.current = session.id;
    if (asked || !chatRiseOn() || window.matchMedia("(prefers-reduced-motion: reduce)").matches) return;
    const view = el.getBoundingClientRect();
    let shown = 0;
    for (const item of thread.children) {
      const box = item.getBoundingClientRect();
      if (box.bottom <= view.top || box.top >= view.bottom) continue;
      item.animate(RISE, { duration: 600, easing: "cubic-bezier(0.22, 1, 0.36, 1)", delay: Math.min(shown++, 8) * 40, fill: "backwards" });
    }
  }, [session.id, session.loading, empty, asked]);

  return (
    <div className="scroll-frame">
      <div
        className="scroll"
        data-testid="transcript"
        ref={scroller}
        onClick={(event) => openLinkInPane(event, session.id, plain, onOpenBoard)}
        onScroll={() => {
          const el = scroller.current;
          if (!el) return;
          const next = followScroll(
            { stick: stick.current, lastTop: lastTop.current },
            {
              pinning: pinning.current,
              scrollTop: el.scrollTop,
              gap: el.scrollHeight - el.scrollTop - el.clientHeight,
            },
          );
          stick.current = next.stick;
          lastTop.current = next.lastTop;
          setAway(!next.stick);
          if (next.stick) setFresh(false);
        }}
      >
        <div className={empty && !session.loading ? "thread empty-thread" : "thread"}>
          {session.loading && empty ? <LoadingThread /> : null}
          {empty && !session.loading ? (
            drafting && !plain ? (
              <DraftLine
                text={session.cwd ? `Ask anything about ${folderName(session.cwd)}` : "Choose a folder, then ask anything."}
                welcome={welcome}
              />
            ) : (
              <p className="empty">{plain ? "Ask anything." : "Ask anything about this folder."}</p>
            )
          ) : null}
          {stretches.map((stretch, index) => {
            const next = stretches[index + 1];
            const earlier = subagentSteps(stretch.items);
            return (
              <div className="stretch" key={`stretch-${index}`} data-testid="earlier-stretch">
                {activityBlocks(stretch.items, earlier.folded, receiptsAfter(receipts, index)).map((block) =>
                  block.type === "receipt" ? (
                    <ReceiptLine key={block.id} receipt={block.receipt} />
                  ) : block.type === "activity" ? (
                    <Activity key={block.id} items={block.items} steps={earlier.byParent} cwd={session.cwd} sessionId={session.id} onOpenFile={onOpenFile ? openFile : undefined} />
                  ) : (
                    <Item key={block.id} item={block.item} sessionId={session.id} cwd={session.cwd} onOpenFile={onOpenFile ? openFile : undefined} onSendNow={sendNow} onRemoveSteer={removeSteer} />
                  ),
                )}
                <Wrinkle
                  sessionId={session.id}
                  stretch={index + 1}
                  start={next ? next.start : (session.start ?? null)}
                  toProvider={next ? next.provider : (session.provider ?? "")}
                  toModel={next ? next.model : currentModelName(session)}
                  label={providerLabel}
                />
              </div>
            );
          })}
          {activityBlocks(session.transcript, hidden, receiptsAfter(receipts, stretches.length)).map((block) =>
            block.type === "receipt" ? (
              <ReceiptLine key={block.id} receipt={block.receipt} />
            ) : block.type === "activity" ? (
              <Activity
                key={block.id}
                items={block.items}
                steps={steps.byParent}
                tasks={tasks}
                cwd={session.cwd}
                sessionId={session.id}
                onOpenFile={onOpenFile ? openFile : undefined}
                onStopTask={onStopTask ? stopTask : undefined}
              />
            ) : (
              <Item
                key={block.id}
                item={block.item}
                sessionId={session.id}
                cwd={session.cwd}
                commands={session.commands}
                onOpenFile={onOpenFile ? openFile : undefined}
                onSendNow={sendNow}
                onRemoveSteer={removeSteer}
              />
            ),
          )}
          {act && session.pendingPermission ? (
            <PermissionCard permission={session.pendingPermission} call={act} agent={agentLabel} diffs={asking?.diffs} cwd={session.cwd} onAnswered={answered} />
          ) : null}
          {act && session.pendingQuestion ? (
            <QuestionCard key={session.pendingQuestion.id} question={session.pendingQuestion} call={act} provider={session.provider} onAnswered={answered} />
          ) : null}
          {act && session.pendingPlan ? <ChatPlanCard plan={session.pendingPlan} cwd={session.cwd} onDecide={(outcome) => act("/api/plan", { outcome })} onAnswered={answered} /> : null}
          {footer}
          {switching ? (
            <>
              <PendingWrinkle switching={switching} stretch={stretches.length + 1} label={providerLabel} onCancel={onCancelSwitch} />
              {(switching.held ?? []).map((text, index) => (
                <div className="message from-user" key={`held-${index}`} data-testid="held-message">
                  <article className="bubble user">
                    <p>{text}</p>
                  </article>
                  <div className="message-actions">
                    <span className="delivery-status">Sends when {label(switching.to)} is ready</span>
                  </div>
                </div>
              ))}
            </>
          ) : null}
        </div>
      </div>
      <button
        type="button"
        className={["jump-latest", away && "shown", fresh && "fresh"].filter(Boolean).join(" ")}
        data-testid="jump-latest"
        aria-label={fresh ? undefined : "Jump to the latest message"}
        onClick={() => follow(true)}
      >
        <span className="jump-label">New messages</span>
        <ArrowDownIcon />
      </button>
    </div>
  );
}

// The widths of the stand-in turns, in percent: the message bubble, then the reply's lines.
const SKELETON_TURNS: readonly (readonly [number, readonly number[]])[] = [
  [52, [94, 86, 62]],
  [38, [90, 74]],
  [60, [96, 88, 92, 48]],
  [30, [84, 66]],
  [46, [92, 80, 57]],
  [56, [88, 94, 71]],
];

// Stand-in turns that fill the pane up to the composer, where the chat's last messages will show, while the
// host loads a chat that has no stored copy to show.
function LoadingThread() {
  return (
    <div className="loading-thread" role="status" aria-label="Loading the chat">
      {SKELETON_TURNS.map(([bubble, lines], turn) => (
        <div className="skeleton-turn" key={turn}>
          <span className="skeleton-bubble" style={{ width: `${bubble}%` }} />
          {lines.map((width, line) => (
            <span className="skeleton-line" key={line} style={{ width: `${width}%` }} />
          ))}
        </div>
      ))}
    </div>
  );
}

export interface TurnCardsProps {
  session: TranscriptSession;
  providerLabel?: string;
  agentLabel?: string;
  running: boolean;
  remote: boolean;
  act: SessionCall;
}

// What sits over the composer during a turn: the working line, and why the last turn failed.
export function TurnCards({ session, providerLabel, agentLabel, running, remote, act }: TurnCardsProps) {
  return (
    <>
      {running || remote ? <WorkingStatus session={session} agent={agentLabel} /> : null}
      <TurnError session={session} title={providerLabel ? `${providerLabel} error` : "Chat error"} running={running} act={act} />
    </>
  );
}

// The error each chat's notice was dismissed on, with the item it came after. A new turn's error shows again.
const dismissedErrors = new Map<string, string>();

function TurnError({ session, title, running, act }: { session: TranscriptSession; title: string; running: boolean; act: SessionCall }) {
  const [, setDismissed] = useState(0);
  const [retrying, setRetrying] = useState(false);
  const error = session.error;
  const dismissal = `${session.transcript.at(-1)?.id ?? ""}\0${error}`;
  if (!error || dismissedErrors.get(session.id) === dismissal) return null;
  const said = running ? "" : lastSaid(session.transcript);
  function retry() {
    setRetrying(true);
    // shortcut: resends the text without its attachments, which the page no longer holds; resend them from the host to keep them.
    void act("/api/prompt", { text: said })
      .catch(() => {})
      .finally(() => setRetrying(false));
  }
  return (
    <div className="turn-error" role="alert" data-testid="turn-error">
      <span className="turn-error-ico" aria-hidden="true">
        <CloseIcon />
      </span>
      <div className="turn-error-text">
        <p className="turn-error-title">{title}</p>
        <p className="turn-error-message">{error.replace(/^Internal error:\s*/i, "") || error}</p>
      </div>
      {said ? (
        <button type="button" className="btn ghost" data-testid="turn-retry" disabled={retrying} onClick={retry}>
          Try again
        </button>
      ) : null}
      <button
        type="button"
        className="icon turn-error-close"
        aria-label="Dismiss"
        data-testid="turn-dismiss"
        onClick={() => {
          dismissedErrors.set(session.id, dismissal);
          setDismissed((count) => count + 1);
        }}
      >
        <CloseIcon />
      </button>
    </div>
  );
}

// The person's last message the agent took in, without the harness's reminders.
function lastSaid(transcript: readonly PresentedItem[]) {
  for (let index = transcript.length - 1; index >= 0; index -= 1) {
    const item = transcript[index];
    if (item?.type !== "user" || item.hidden || (item.delivery && item.delivery.state !== "read")) continue;
    const spoken = userMessageView(item.text).spoken;
    if (spoken) return spoken;
  }
  return "";
}

// Which permission, question or plan the session waits on, or "" for none.
function waitingKey(session: TranscriptSession) {
  const permission = session.pendingPermission;
  if (permission) return `permission:${permission.toolCallId ?? ""}:${permission.options[0]?.optionId ?? ""}`;
  if (session.pendingQuestion) return `question:${session.pendingQuestion.id}`;
  return session.pendingPlan ? `plan:${session.pendingPlan.toolCallId ?? ""}` : "";
}

function ReceiptLine({ receipt }: { receipt: Receipt }) {
  return (
    <p className={receipt.icon === "check" ? "answered" : "answered denied"} data-testid="receipt">
      {receipt.icon === "check" ? <CheckIcon /> : receipt.icon === "plan" ? <PlanIcon /> : <CloseIcon />}
      <span>{receipt.label}</span>
      {receipt.code ? <code>{receipt.detail}</code> : <b>{receipt.detail}</b>}
    </p>
  );
}

function UserPictures({ sessionId, item }: { sessionId: string; item: PresentedTextItem }) {
  const shots = (item.images || []).map((image) => ({ ...image, toolCallId: item.id }));
  const [openIndex, setOpenIndex] = useState<number | null>(null);
  if (!sessionId || !shots.length) return null;
  const open = openIndex != null && shots[openIndex] ? openIndex : null;
  return (
    <>
      <div className="user-pictures">
        {shots.map((shot, offset) => (
          <button
            key={shot.index}
            type="button"
            className="user-picture"
            aria-label="Open image"
            data-testid="user-picture"
            onClick={() => setOpenIndex(offset)}
          >
            <img src={imageSrc(sessionId, shot)} alt="" />
          </button>
        ))}
      </div>
      {open != null ? createPortal(
        <ShotLightbox
          srcs={shots.map((shot) => imageSrc(sessionId, shot))}
          index={open}
          onIndex={setOpenIndex}
          onClose={() => setOpenIndex(null)}
        />,
        document.body,
      ) : null}
    </>
  );
}

function SentAttachments({ files }: { files: PresentedAttachment[] }) {
  return (
    <ul className="sent-files">
      {files.map((file, index) => (
        <li key={`${file.name}-${index}`} className={file.kind === "image" ? "sent-file image" : "sent-file"}>
          {file.preview ? <img src={file.preview} alt="" /> : <span className="attach-kind">{fileBadge(file.name)}</span>}
          <span className="attach-name">{file.name}</span>
        </li>
      ))}
    </ul>
  );
}

// A transcript item as the activity rows read it: a text item has none of the tool fields.
type ActivityItem =
  | PresentedToolItem
  | (PresentedTextItem & {
      toolCallId?: undefined;
      title?: undefined;
      kind?: undefined;
      status?: undefined;
      rawInput?: undefined;
      role?: undefined;
      path?: undefined;
      command?: undefined;
      query?: undefined;
      label?: undefined;
      agent?: undefined;
      args?: undefined;
      diffs?: undefined;
    });

interface NoticeEntry {
  id: string;
  type: "notice";
  notice: TaskNotice;
}

type ActivityEntry = ActivityItem | NoticeEntry;

type Block =
  | { type: "activity"; id: string; items: ActivityEntry[] }
  | { type: "item"; id: string; item: PresentedItem }
  | { type: "receipt"; id: string; receipt: Receipt };

type ActivityRow =
  | { type: "summary"; id: string; items: ActivityItem[] }
  | { type: "repeat"; id: string; items: ActivityItem[] }
  | { type: "notice"; id: string; notice: TaskNotice }
  | { type: "thought"; id: string; item: PresentedTextItem }
  | { type: "edit" | "tool"; id: string; item: ActivityItem }
  | { type: "page"; id: string; page: PageMark }
  | { type: "app"; id: string; app: AppMark };

type Shot = PresentedImage & { toolCallId: string };

// Steps a subagent took, by the subagent's tool call id. A step whose subagent row is in the
// transcript is folded under that row. One whose subagent is not there stays in the flow.
function subagentSteps(transcript: PresentedItem[]) {
  const tools = new Map(transcript.flatMap((item) => (item.type === "tool" ? [[item.toolCallId, item] as const] : [])));
  // A step of a subagent inside a subagent goes under the outermost one that is shown.
  const outermost = (id: string) => {
    let current = id;
    for (let depth = 0; depth < 20; depth += 1) {
      const parent = tools.get(current)?.parentId;
      if (!parent || !tools.has(parent)) return current;
      current = parent;
    }
    return current;
  };
  const byParent = new Map<string, PresentedToolItem[]>();
  const folded = new Set<string>();
  for (const item of transcript) {
    if (item.type !== "tool" || !item.parentId || !tools.has(item.parentId)) continue;
    const top = outermost(item.parentId);
    const list = byParent.get(top) ?? [];
    list.push(item);
    byParent.set(top, list);
    folded.add(item.id);
  }
  return { byParent, folded };
}

type AgentTask = Pick<BackgroundTask, "id" | "status">;

// The background task of each subagent that runs in the background, by its Agent tool call id.
// A background command names its tool call too, and keeps its own row.
function subagentTasks(backgroundTasks: readonly BackgroundTask[] | undefined) {
  return new Map((backgroundTasks ?? []).flatMap((task): [string, AgentTask][] => (task.toolCallId && task.kind === "local_agent" ? [[task.toolCallId, task]] : [])));
}

function activityBlocks(transcript: PresentedItem[], folded: ReadonlySet<string> = new Set(), receipts?: ReadonlyMap<string, Receipt[]>) {
  const blocks: Block[] = [];
  for (const item of transcript) {
    placeItem(blocks, item, folded);
    for (const receipt of receipts?.get(item.id) ?? []) blocks.push({ type: "receipt", id: receipt.id, receipt });
  }
  return blocks;
}

function placeItem(blocks: Block[], item: PresentedItem, folded: ReadonlySet<string>) {
  if (folded.has(item.id)) return;
  if (item.type === "user") {
    const view = userMessageView(item.text);
    if (item.hidden || view.harnessOnly) {
      if (view.notice) pushActivity(blocks, { id: item.id, type: "notice", notice: view.notice });
      return;
    }
  }
  if (item.type === "tool" && (isPlanTool(item.title) || isPlanTool(item.label))) return;
  if (item.type === "thought" || item.type === "tool") {
    pushActivity(blocks, item);
    return;
  }
  blocks.push({ type: "item", id: item.id, item });
}

function pushActivity(blocks: Block[], item: ActivityEntry) {
  const last = blocks.at(-1);
  if (last?.type === "activity") last.items.push(item);
  else blocks.push({ type: "activity", id: item.id, items: [item] });
}

function WorkingStatus({ session, agent = "The agent" }: { session: TranscriptSession; agent?: string }) {
  const line = workingLine(session);
  const pinned = useRef<{ key: string; since: number } | null>(null);
  if (!pinned.current || pinned.current.key !== line.key) {
    pinned.current = { key: line.key, since: line.since ?? Date.now() };
  } else if (typeof line.since === "number" && line.since + 1000 < pinned.current.since) {
    pinned.current = { key: line.key, since: line.since };
  }
  const label = line.label;
  const since = pinned.current.since;
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const tick = () => {
      if (document.visibilityState !== "hidden") setNow(Date.now());
    };
    tick();
    const timer = setInterval(tick, 1000);
    document.addEventListener("visibilitychange", tick);
    return () => {
      clearInterval(timer);
      document.removeEventListener("visibilitychange", tick);
    };
  }, [since, label]);
  const elapsed = formatElapsed(now - since);
  return (
    <p className="turn-status" data-testid="working" aria-label={`${agent} is working. ${label}`}>
      <span className="thinking-dots" aria-hidden="true">
        <span />
        <span />
        <span />
      </span>
      <span className="turn-action" data-testid="working-action">
        <span className="turn-label">{label}</span>
        <span className="turn-timer">{elapsed}</span>
      </span>
    </p>
  );
}

function TaskChip({ notice }: { notice: TaskNotice }) {
  const tone = notice.tone === "fail" || notice.tone === "ok" ? notice.tone : "quiet";
  return (
    <p className={`activity-row task-completed is-${tone}`} data-testid="task-completed" data-tone={tone}>
      <Diamond filled />
      <span className="task-completed-label">{notice.title}</span>
      {notice.detail ? <span className="task-completed-detail">{notice.detail}</span> : null}
    </p>
  );
}

// Memoised: an unchanged item keeps its identity from snapshot to snapshot (shareEqual in App).
interface ItemProps {
  item: PresentedItem;
  sessionId: string;
  cwd: string;
  // What the session's harness reported. A message that calls one of its skills shows the skill as a chip.
  commands?: readonly unknown[] | undefined;
  onOpenFile?: (filePath: string) => void;
  onSendNow: (deliveryId: string) => void;
  onRemoveSteer: (deliveryId: string) => void;
}

const Item = memo(function Item({ item, sessionId, cwd, commands, onOpenFile, onSendNow, onRemoveSteer }: ItemProps) {
  if (item.type === "user") {
    const view = userMessageView(item.text);
    if (item.hidden || view.harnessOnly) {
      return view.notice ? <TaskChip notice={view.notice} /> : null;
    }
    const files = item.images?.length
      ? (item.attachments || []).filter((file) => file.kind !== "image")
      : item.attachments;
    const bubble = (
      <article className="bubble user" data-testid="user-message">
        {view.spoken ? <Markdown text={view.spoken} skills={commands} /> : null}
        {files?.length ? <SentAttachments files={files} /> : null}
        <UserPictures sessionId={sessionId} item={item} />
      </article>
    );
    return (
      <>
        {view.notice ? <TaskChip notice={view.notice} /> : null}
        <div className="message from-user">
          {bubble}
          <MessageActions text={view.spoken} delivery={item.delivery} onSendNow={onSendNow} onRemove={onRemoveSteer} />
        </div>
      </>
    );
  }
  if (item.type === "assistant") {
    return (
      <div className="message from-agent">
        <AssistantBubble
          item={item}
          cwd={cwd}
          onOpenFile={onOpenFile}
          imageSrc={(filePath) => localImageSrc(sessionId, cwd, filePath)}
          videoSrc={(filePath) => localVideoSrc(sessionId, cwd, filePath)}
        />
        <MessageActions text={item.text} />
      </div>
    );
  }
  return null;
});

const DELIVERY_LABELS: Record<Delivery["state"], string> = {
  waiting: "Waiting",
  read: "Read",
  unread: "Not read",
};

interface MessageActionsProps {
  text: string;
  // Present on a message steered into a running turn.
  delivery?: Delivery;
  onSendNow?: (deliveryId: string) => void;
  onRemove?: (deliveryId: string) => void;
}

// How long "Read" stays after a message turns read. Then it shows on hover only.
const READ_SHOWS_MS = 3000;

function MessageActions({ text, delivery, onSendNow, onRemove }: MessageActionsProps) {
  const [copied, copy] = useCopy(text);
  const waiting = delivery?.state === "waiting";
  const justRead = useJustRead(delivery?.state);
  return (
    <div className="message-actions">
      <span className="message-tools">
        <button type="button" className="message-tool" aria-label={copied ? "Copied" : "Copy message"} title="Copy" onClick={copy}>
          {copied ? <CheckIcon /> : <CopyIcon />}
        </button>
        {delivery && waiting ? (
          <>
            <button type="button" className="message-tool" aria-label="Delete message" title="Delete" data-testid="delivery-remove" onClick={() => onRemove?.(delivery.id)}>
              <CloseIcon />
            </button>
            <button type="button" className="message-send-now" data-testid="delivery-send-now" onClick={() => onSendNow?.(delivery.id)}>
              Send now
            </button>
          </>
        ) : null}
      </span>
      {delivery ? (
        <span className={delivery.state === "read" && !justRead ? "delivery-status is-quiet" : "delivery-status"} data-testid="delivery-status">
          {DELIVERY_LABELS[delivery.state]}
        </span>
      ) : null}
    </div>
  );
}

// True for a few seconds after the state turns read on this page. A message read before it showed stays false.
function useJustRead(state: Delivery["state"] | undefined): boolean {
  const previous = useRef(state);
  const [justRead, setJustRead] = useState(false);
  useEffect(() => {
    const turnedRead = state === "read" && previous.current !== "read";
    previous.current = state;
    if (!turnedRead) return undefined;
    setJustRead(true);
    const timer = setTimeout(() => setJustRead(false), READ_SHOWS_MS);
    return () => clearTimeout(timer);
  }, [state]);
  return justRead;
}

// A reply being streamed comes out at a steady pace, so text that arrives in bunches does not jump.
function AssistantBubble({
  item,
  onOpenFile,
  imageSrc,
  videoSrc,
  cwd,
}: { item: PresentedTextItem } & Pick<MarkdownViewProps, "onOpenFile" | "imageSrc" | "videoSrc" | "cwd">) {
  const text = useSteadyText(item.text, item.streaming);
  return (
    <article className="bubble assistant">
      <MarkdownView text={text} onOpenFile={onOpenFile} imageSrc={imageSrc} videoSrc={videoSrc} cwd={cwd} />
    </article>
  );
}

interface ActivityProps {
  items: ActivityEntry[];
  steps: ReadonlyMap<string, PresentedToolItem[]>;
  tasks?: ReadonlyMap<string, AgentTask>;
  cwd: string;
  sessionId: string;
  onOpenFile?: (filePath: string) => void;
  onStopTask?: (taskId: string) => void;
}

const Activity = memo(function Activity({ items, steps, tasks, cwd, sessionId, onOpenFile, onStopTask }: ActivityProps) {
  const rows = activityRows(items);
  const placed: { row: ActivityRow; shots: Shot[]; start: number }[] = [];
  let count = 0;
  for (const row of rows) {
    const shots = shotsForRow(row);
    placed.push({ row, shots, start: count });
    count += shots.length;
  }
  const shots = placed.flatMap((entry) => entry.shots);
  const [openIndex, setOpenIndex] = useState<number | null>(null);
  const open = openIndex != null && shots[openIndex] ? openIndex : null;
  return (
    <div className="activity" data-testid="activity">
      {placed.map(({ row, shots: rowShots, start }) => {
        const onOpen = (offset: number) => setOpenIndex(start + offset);
        if (row.type === "thought") return <ThoughtRow key={row.id} item={row.item} />;
        if (row.type === "notice") return <TaskChip key={row.id} notice={row.notice} />;
        if (row.type === "summary") {
          return <SummaryRow key={row.id} items={row.items} cwd={cwd} sessionId={sessionId} shots={rowShots} onOpen={onOpen} />;
        }
        if (row.type === "repeat") return <ToolRow key={row.id} items={row.items} cwd={cwd} sessionId={sessionId} shots={rowShots} onOpen={onOpen} />;
        if (row.type === "edit") return <EditRow key={row.id} item={row.item} cwd={cwd} onOpenFile={onOpenFile} />;
        if (row.type === "page") return <PageCard key={row.id} page={row.page} sessionId={sessionId} />;
        if (row.type === "app") return <AppCard key={row.id} app={row.app} sessionId={sessionId} />;
        const taken = row.item.toolCallId ? steps.get(row.item.toolCallId) : undefined;
        const task = row.item.toolCallId ? tasks?.get(row.item.toolCallId) : undefined;
        const starting = row.item.role === "subagent" && (row.item.status === "in_progress" || row.item.status === "pending");
        if (taken?.length || task || starting) return <SubagentRow key={row.id} item={row.item} steps={taken ?? []} cwd={cwd} task={task} onStop={onStopTask} />;
        return <ToolRow key={row.id} items={[row.item]} cwd={cwd} sessionId={sessionId} shots={rowShots} onOpen={onOpen} />;
      })}
      {open != null ? createPortal(
        <ShotLightbox
          srcs={shots.map((shot) => imageSrc(sessionId, shot))}
          index={open}
          onIndex={setOpenIndex}
          onClose={() => setOpenIndex(null)}
        />,
        document.body,
      ) : null}
    </div>
  );
}, sameActivity);

// activityBlocks and subagentSteps build new lists on every render, around items that keep their
// identity (shareEqual in App). A block is the same when its entries and its subagents' steps are.
function sameActivity(previous: ActivityProps, next: ActivityProps): boolean {
  if (previous.cwd !== next.cwd || previous.sessionId !== next.sessionId || previous.onOpenFile !== next.onOpenFile || previous.onStopTask !== next.onStopTask) return false;
  if (!sameList(previous.items, next.items, sameEntry)) return false;
  return next.items.every((item) => {
    if (item.type !== "tool" || !item.toolCallId) return true;
    const before = previous.tasks?.get(item.toolCallId);
    const after = next.tasks?.get(item.toolCallId);
    if (before?.id !== after?.id || before?.status !== after?.status) return false;
    return sameList(previous.steps.get(item.toolCallId), next.steps.get(item.toolCallId), Object.is);
  });
}

function sameEntry(left: ActivityEntry, right: ActivityEntry): boolean {
  if (left === right) return true;
  // A notice is made from its hidden user item on every render.
  if (left.type !== "notice" || right.type !== "notice") return false;
  return left.id === right.id && left.notice.title === right.notice.title && left.notice.tone === right.notice.tone && left.notice.detail === right.notice.detail;
}

function sameList<T>(left: readonly T[] | undefined, right: readonly T[] | undefined, same: (a: T, b: T) => boolean): boolean {
  if (!left || !right) return left === right;
  return left.length === right.length && left.every((value, index) => same(value, right[index] as T));
}

function activityRows(items: ActivityEntry[]) {
  const rows: ActivityRow[] = [];
  let quiet: ActivityItem[] = [];
  function flush() {
    const first = quiet[0];
    if (first === undefined) return;
    rows.push({ type: "summary", id: first.id, items: quiet });
    quiet = [];
  }
  for (const item of items) {
    if (item.type === "notice") {
      flush();
      rows.push({ type: "notice", id: item.id, notice: item.notice });
    } else if (item.type === "thought") {
      flush();
      rows.push({ type: "thought", id: item.id, item });
    } else if (item.type === "tool" && item.page) {
      flush();
      rows.push({ type: "page", id: item.id, page: item.page });
    } else if (item.type === "tool" && item.app) {
      flush();
      rows.push({ type: "app", id: item.id, app: item.app });
    } else if (isQuiet(item)) {
      quiet.push(item);
    } else if (isEdit(item)) {
      flush();
      rows.push({ type: "edit", id: item.id, item });
    } else {
      flush();
      const last = rows.at(-1);
      if (last?.type === "repeat" && foldsInto(last.items[0], item)) last.items.push(item);
      else if (last?.type === "tool" && foldsInto(last.item, item)) rows[rows.length - 1] = { type: "repeat", id: last.id, items: [last.item, item] };
      else rows.push({ type: "tool", id: item.id, item });
    }
  }
  flush();
  return rows;
}

// Back-to-back calls of one tool share a row. A subagent keeps its own row for its steps.
function foldsInto(previous: ActivityItem | undefined, item: ActivityItem) {
  if (previous === undefined || previous.role === "subagent" || item.role === "subagent") return false;
  return previous.title === item.title && toolLabel(previous) === toolLabel(item);
}

// A reply's text can arrive in bursts. Each burst is revealed at a steady pace, so the text runs along instead of jumping.
// Text that stops streaming finishes its reveal first. Text that was never live shows at once.
const REVEAL_MS = 1200;
const REVEAL_TICK_MS = 40;

// A streamed reply catches up with each burst in about REVEAL_MS.
function useSteadyText(text: string, live: boolean): string {
  // What is there when the bubble mounts shows at once (after a page reload, say). Only what comes after is revealed.
  const [shown, setShown] = useState(() => text.length);
  const target = useRef(text.length);
  // Characters per tick, set when a burst arrives.
  const rate = useRef(2);
  if (text.length !== target.current) {
    rate.current = Math.max(2, Math.ceil(Math.max(0, text.length - shown) / (REVEAL_MS / REVEAL_TICK_MS)));
    target.current = text.length;
  }
  const revealing = live || shown < text.length;
  useEffect(() => {
    if (!revealing) return undefined;
    const timer = setInterval(() => {
      setShown((current) => (current >= target.current ? target.current : Math.min(target.current, current + rate.current)));
    }, REVEAL_TICK_MS);
    return () => clearInterval(timer);
  }, [revealing]);
  return revealing ? text.slice(0, shown) : text;
}

// While the model thinks, the window shows where it is heading now: its newest sentences, changed at most
// every THINKING_UPDATE_MS with a short fade, never a racing scroll. The whole thought is readable after.
const THINKING_UPDATE_MS = 1500;

// A thought made of step headings (Codex) shows its last three steps, the newest one brightest.
const THINKING_STEPS = 3;

function ThoughtRow({ item }: { item: PresentedTextItem }) {
  const steps = thinkingSteps(item.text);
  const latest = useAtMostEvery(steps ? steps.slice(-THINKING_STEPS).join("\n") : latestThinking(item.text), THINKING_UPDATE_MS, item.streaming);
  if (item.streaming) {
    return (
      <div className="activity-row thinking">
        <div className="thinking-label">
          <Diamond />
          <span className="activity-label">Thinking...</span>
        </div>
        {latest && steps ? (
          <ol className="thinking-preview thinking-steps" data-testid="thinking-preview">
            {latest.split("\n").map((step, index, shown) => (
              // By its place in the whole thought: Codex can repeat a heading, and a new step still fades in.
              <li key={steps.length - shown.length + index} className={index === shown.length - 1 ? "thinking-latest is-current" : undefined}>
                <MathText text={step} />
              </li>
            ))}
          </ol>
        ) : latest ? (
          <p className="thinking-preview" data-testid="thinking-preview">
            <span key={latest} className="thinking-latest">
              {previewAsWritten(item.text, latest) ? latest : <MarkdownInline text={latest} />}
            </span>
          </p>
        ) : null}
      </div>
    );
  }
  return (
    <details className="activity-row">
      <summary>
        <Diamond filled />
        <span className="activity-label">{thoughtLabel(item)}</span>
      </summary>
      {steps ? (
        <ol className="activity-detail thought-steps">
          {steps.map((step, index) => <li key={`${index}:${step}`}><MathText text={step} /></li>)}
        </ol>
      ) : item.text ? (
        <MarkdownView className="activity-detail thought-detail" text={item.text} />
      ) : null}
    </details>
  );
}

interface ShotRowProps {
  cwd: string;
  sessionId: string;
  shots?: Shot[];
  onOpen?: (offset: number) => void;
}

function SummaryRow({ items, cwd, sessionId, shots = [], onOpen }: ShotRowProps & { items: ActivityItem[] }) {
  const live = items.some((item) => item.status === "in_progress");
  const reads = items.filter((item) => item.role === "read").length;
  const searches = items.length - reads;
  return (
    <div className="tool-block">
      <details className={live ? "activity-row live" : "activity-row"} data-testid="tool">
        <summary>
          {live ? <span className="live-mark">&gt;</span> : <Diamond filled />}
          <span className="activity-label">{summaryLabel(reads, searches)}</span>
        </summary>
        <ul className="quiet-list">
          {items.map((item) => (
            <li key={item.id}>{quietDetail(item, cwd)}</li>
          ))}
        </ul>
      </details>
      <ChatShots sessionId={sessionId} shots={shots} onOpen={onOpen} />
    </div>
  );
}

function callInput(item: ActivityItem) {
  const named = [item.command, item.path].filter(Boolean).join(" ");
  if (named || !item.rawInput) return named;
  return typeof item.rawInput === "string" ? item.rawInput : JSON.stringify(item.rawInput);
}

function EditRow({ item, cwd, onOpenFile }: { item: ActivityItem; cwd: string; onOpenFile?: (filePath: string) => void }) {
  const live = item.status === "in_progress";
  const diffs = item.diffs?.length ? item.diffs : [{ path: item.path ?? "", oldText: "", newText: "" }];
  return (
    <div className={live ? "edit-block live" : "edit-block"} data-testid="tool">
      {diffs.map((diff, index) => {
        const raw = diff.path || item.path || "";
        const full = sessionFilePath(cwd, raw);
        const shown = shortPath(cwd, raw);
        return (
          <div key={`${diff.path || item.id}:${index}`}>
            <div className="activity-row edit">
              {live ? <span className="live-mark">&gt;</span> : <Diamond filled />}
              <span className="edit-verb">{!diff.oldText && diff.newText ? "Write" : "Edit"}</span>
              {full && onOpenFile ? (
                <button type="button" className="edit-path" title={full} aria-label={`Open ${shown}`} onClick={() => onOpenFile(full)}>
                  {shown}
                </button>
              ) : (
                <span className="edit-path">{shown}</span>
              )}
            </div>
            <EditDiff oldText={diff.oldText} newText={diff.newText} />
          </div>
        );
      })}
    </div>
  );
}

// A subagent and the steps it took. While it runs, a card shows its newest steps. Once it ends, a row folds them.
function SubagentRow({ item, steps, cwd, task, onStop }: { item: ActivityItem; steps: PresentedToolItem[]; cwd: string; task?: AgentTask; onStop?: (taskId: string) => void }) {
  const [all, setAll] = useState(false);
  // A subagent in the background ends its Agent call at once; its task says whether it still runs.
  const live = task ? task.status === "running" : item.status === "in_progress" || item.status === "pending";
  const count = `${steps.length} ${steps.length === 1 ? "step" : "steps"}`;
  const stepLabel = (step: PresentedToolItem) => (step.role === "read" ? <>Read {quietDetail(step, cwd)}</> : toolLabel(step));
  if (live) {
    const shown = all ? steps : steps.slice(-3);
    return (
      <div className="tool-block">
        <div className="subagent-card" data-subagent={item.id} data-testid="subagent">
          <div className="subagent-head">
            <span className="task-pulse agent" aria-hidden="true" />
            <span className="activity-label">{toolLabel(item)}</span>
            {item.agent ? <span className="subagent-type">{item.agent}</span> : null}
            <span className="subagent-steps">{count}</span>
          </div>
          {shown.length ? (
            <ul className={all ? "subagent-live all" : "subagent-live"} data-testid="subagent-steps">
              {shown.map((step, index) => (
                <li key={step.id} className={index === shown.length - 1 ? "now" : undefined}>
                  {stepLabel(step)}
                </li>
              ))}
            </ul>
          ) : null}
          {steps.length > 3 || (task && onStop) ? (
            <div className="subagent-foot">
              {steps.length > 3 ? (
                <button type="button" className="subagent-more" onClick={() => setAll((value) => !value)}>
                  {all ? "Show less" : "Show all"}
                </button>
              ) : null}
              {task && onStop ? (
                <button type="button" className="task-end" onClick={() => onStop(task.id)}>
                  Stop
                </button>
              ) : null}
            </div>
          ) : null}
        </div>
      </div>
    );
  }
  const status = task?.status ?? item.status;
  const outcome = status === "failed" ? "failed" : status === "stopped" || status === "killed" || status === "cancelled" ? "stopped" : "";
  return (
    <div className="tool-block">
      <details className="activity-row" data-testid="subagent">
        <summary>
          <span className={`subagent-mark ${outcome || "done"}`} aria-hidden="true">
            {outcome === "failed" ? "✕" : outcome === "stopped" ? "■" : "✓"}
          </span>
          <span className="activity-label">{toolLabel(item)}</span>
          <span className="subagent-steps">
            {count}
            {outcome ? ` · ${outcome}` : ""}
          </span>
        </summary>
        <ul className="quiet-list" data-testid="subagent-steps">
          {steps.map((step) => (
            <li key={step.id}>{stepLabel(step)}</li>
          ))}
        </ul>
      </details>
    </div>
  );
}

// A page the browser tools opened: its picture, title and address. Open brings it up in the browser pane.
function PageCard({ page, sessionId }: { page: PageMark; sessionId: string }) {
  const [pictureGone, setPictureGone] = useState(false);
  const [menu, setMenu] = useState(false);
  const inPane = Boolean(desktopBridge());
  const host = hostOf(page.url);
  function open() {
    if (inPane) void paneCall("/api/browser/open", { url: page.url, tab: page.tab, sessionId });
    else if (isWebUrl(page.url)) window.open(page.url, "_blank", "noopener");
  }
  return (
    <div className="page-card" data-testid="page-card">
      {page.thumb && !pictureGone ? (
        <button type="button" className="page-card-shot" aria-label={`Open ${page.title || host}`} onClick={open}>
          <img src={withToken(`/api/browser/thumb/${page.thumb}`)} alt="" loading="lazy" onError={() => setPictureGone(true)} />
        </button>
      ) : null}
      <div className="page-card-foot">
        <div className="page-card-text">
          <p className="page-card-title">{page.title || host || page.url}</p>
          <p className="page-card-where">
            {host}
            {inPane ? " · Opened in Browser" : ""}
          </p>
        </div>
        <button type="button" className="page-card-open" onClick={open}>
          Open
        </button>
        <div className="page-card-more">
          <button type="button" className="icon" aria-label="More" aria-expanded={menu} onClick={() => setMenu((value) => !value)} onBlur={() => setTimeout(() => setMenu(false), 150)}>
            <MoreIcon />
          </button>
          {menu ? (
            <div ref={leaveRef} className="page-card-menu" role="menu">
              {isWebUrl(page.url) ? (
                <button type="button" role="menuitem" onClick={() => window.open(page.url, "_blank", "noopener")}>
                  Open in your browser
                </button>
              ) : null}
              <button type="button" role="menuitem" onClick={() => void navigator.clipboard?.writeText(page.url)}>
                Copy link
              </button>
            </div>
          ) : null}
        </div>
      </div>
    </div>
  );
}

// An app the simulator tools launched: the device's screen just after, the app's name and the device. Open
// brings the Device tab up on that device.
function AppCard({ app, sessionId }: { app: AppMark; sessionId: string }) {
  const [pictureGone, setPictureGone] = useState(false);
  function open() {
    void paneCall("/api/devices/focus", { sessionId, device: app.device });
  }
  return (
    <div className="page-card app-card" data-testid="app-card">
      {app.thumb && !pictureGone ? (
        <button type="button" className="app-card-shot" aria-label={`Show ${app.name} on ${app.deviceName}`} onClick={open}>
          <img src={withToken(`/api/browser/thumb/${app.thumb}`)} alt="" loading="lazy" onError={() => setPictureGone(true)} />
        </button>
      ) : null}
      <div className="page-card-foot">
        <div className="page-card-text">
          <p className="page-card-title">{app.name || app.appId}</p>
          <p className="page-card-where">
            {app.deviceName || app.device} · Opened in Device
          </p>
        </div>
        <button type="button" className="page-card-open" onClick={open}>
          Show
        </button>
      </div>
    </div>
  );
}

function hostOf(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return "";
  }
}

// A link in the transcript opens in the app's browser pane, and a link to a board opens that board here.
// Cmd-click and other modified clicks keep the default, which opens the person's own browser.
function openLinkInPane(event: React.MouseEvent<HTMLElement>, sessionId: string, plain: boolean | undefined, onOpenBoard?: MessageListProps["onOpenBoard"]) {
  if (event.defaultPrevented || event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
  const target = event.target instanceof Element ? event.target.closest("a[href]") : null;
  const href = target instanceof HTMLAnchorElement ? target.href : "";
  const board = localBoardTarget(href, window.location.origin);
  if (board.cwd !== null && onOpenBoard) {
    event.preventDefault();
    onOpenBoard(board.cwd, board.taskId);
    return;
  }
  if (plain || !desktopBridge()) return;
  if (!href || !isWebUrl(href) || new URL(href).origin === window.location.origin) return;
  event.preventDefault();
  void paneCall("/api/browser/open", { url: href, newTab: true, sessionId }).then((error) => {
    if (error) window.open(href, "_blank", "noopener");
  });
}

function MoreIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 16 16" aria-hidden="true">
      <circle cx="8" cy="3.5" r="1.2" fill="currentColor" />
      <circle cx="8" cy="8" r="1.2" fill="currentColor" />
      <circle cx="8" cy="12.5" r="1.2" fill="currentColor" />
    </svg>
  );
}

// One call, or calls of one tool in a row: one line with a count, and each call's input when opened.
// Equal inputs in a row share a line. A row keeps its open state when a call joins it.
function ToolRow({ items, sessionId, shots = [], onOpen }: ShotRowProps & { items: ActivityItem[] }) {
  const first = items[0] as ActivityItem;
  const live = items.some((item) => item.status === "in_progress");
  const detail = items.length === 1 ? toolDetail(first) : "";
  const inputs: { text: string; count: number }[] = [];
  for (const item of items.length > 1 ? items : []) {
    const text = callInput(item);
    const last = inputs.at(-1);
    if (last?.text === text) last.count += 1;
    else inputs.push({ text, count: 1 });
  }
  const shown = inputs.filter((input) => input.text);
  return (
    <div className="tool-block">
      <details className={live ? "activity-row live" : first.role === "shell" ? "activity-row is-shell" : "activity-row"} data-testid="tool">
        <summary>
          {live ? <span className="live-mark">&gt;</span> : <Diamond filled />}
          <span className="activity-label">
            {toolLabel(first)}
            {items.length > 1 ? <span className="repeat-count"> × {items.length}</span> : null}
          </span>
        </summary>
        {detail ? <pre className="activity-detail input">{detail}</pre> : null}
        {shown.length ? (
          <ul className="quiet-list repeat-inputs">
            {shown.map((input, index) => (
              <li key={index}>
                <code>{input.text}</code>
                {input.count > 1 ? <span className="repeat-count"> × {input.count}</span> : null}
              </li>
            ))}
          </ul>
        ) : null}
      </details>
      <ChatShots sessionId={sessionId} shots={shots} onOpen={onOpen} />
    </div>
  );
}

function shotsForRow(row: ActivityRow) {
  if (row.type === "summary" || row.type === "repeat") return row.items.flatMap(shotsOf);
  if (row.type === "tool") return shotsOf(row.item);
  return [];
}

function shotsOf(item: ActivityItem) {
  if (!item.toolCallId || !item.images?.length) return [];
  return item.images.map((image) => ({ ...image, toolCallId: item.toolCallId }));
}

function ChatShots({ sessionId, shots, onOpen }: { sessionId: string; shots: Shot[]; onOpen?: (offset: number) => void }) {
  if (!sessionId || !shots.length) return null;
  return (
    <div className="chat-shots">
      {shots.map((shot, offset) => (
        <button
          key={`${shot.toolCallId}-${shot.index}`}
          type="button"
          className="chat-shot"
          aria-label="Open image"
          onClick={() => onOpen?.(offset)}
        >
          <img src={imageSrc(sessionId, shot)} alt="" />
        </button>
      ))}
    </div>
  );
}

// A picture a reply shows inline, by its path on this machine. A relative one is in the session folder.
function localImageSrc(sessionId: string, cwd: string, filePath: string) {
  const params = new URLSearchParams({ sessionId, path: sessionFilePath(cwd, filePath) });
  return withToken(`/api/file/image?${params.toString()}`);
}

// A video a reply plays inline, found the way localImageSrc finds a picture.
function localVideoSrc(sessionId: string, cwd: string, filePath: string) {
  const params = new URLSearchParams({ sessionId, path: sessionFilePath(cwd, filePath) });
  return withToken(`/api/file/video?${params.toString()}`);
}

function imageSrc(sessionId: string, shot: Shot) {
  return withToken(`/api/images/${encodeURIComponent(sessionId)}/${encodeURIComponent(shot.toolCallId)}/${shot.index}`);
}

const EditDiff = memo(function EditDiff({ oldText, newText }: { oldText: string; newText: string }) {
  const { rows } = hunkRows(oldText, newText);
  if (!rows.length) return null;
  return (
    <div className="edit-diff">
      {rows.map((row, index) => (
        <div key={index} className={`edit-line ${row.type}`}>
          <span className="ln">{row.ln}</span>
          <span className="src">{row.text || " "}</span>
        </div>
      ))}
    </div>
  );
});

function thoughtLabel(item: PresentedTextItem) {
  if (item.streaming) return "Thinking...";
  if (item.durationMs == null) return "Thought";
  const seconds = item.durationMs / 1000;
  const shown = seconds < 10 ? seconds.toFixed(1) : String(Math.round(seconds));
  return `Thought for ${shown}s`;
}

// value, changed at most once every ms while live, so a stream of small pieces does not flicker.
function useAtMostEvery(value: string, ms: number, live: boolean): string {
  const [shown, setShown] = useState(value);
  const last = useRef(0);
  useEffect(() => {
    if (!live) {
      setShown(value);
      return undefined;
    }
    const wait = last.current + ms - Date.now();
    if (wait <= 0) {
      last.current = Date.now();
      setShown(value);
      return undefined;
    }
    const timer = setTimeout(() => {
      last.current = Date.now();
      setShown(value);
    }, wait);
    return () => clearTimeout(timer);
  }, [value, ms, live]);
  return shown;
}

function summaryLabel(reads: number, searches: number) {
  const parts: string[] = [];
  if (reads) parts.push(`Read ${reads} ${reads === 1 ? "file" : "files"}`);
  if (searches) parts.push(`Searched ${searches} ${searches === 1 ? "pattern" : "patterns"}`);
  return parts.join(", ");
}

function isQuiet(item: ActivityItem) {
  return item.role === "read" || (item.role === "search" && Boolean(item.query));
}

function isEdit(item: ActivityItem) {
  return item.role === "edit";
}

function toolLabel(item: ActivityItem) {
  const plain = browserLabel(item.title, item.args) ?? simulatorLabel(item.title, item.args);
  if (plain) return plain;
  if (item.role === "shell") {
    if (item.label) return `Run ${item.label}`;
    const command = (item.command || item.title || "command").split("\n")[0] ?? "";
    return `Run ${command.replace(/^Execute\s+/, "").replace(/^`|`$/g, "")}`.slice(0, 90);
  }
  if (item.role === "list") return `List ${baseName(item.path) || "directory"}`;
  return item.label || item.title || "Tool";
}

function quietDetail(item: ActivityItem, cwd: string): ReactNode {
  if (item.role === "read") return shortPath(cwd, item.path || item.title || "");
  return item.query || item.title;
}

function baseName(path: string | undefined) {
  return (path ?? "").split("/").filter(Boolean).at(-1) || "";
}

function Diamond({ filled = false }: { filled?: boolean }) {
  return (
    <svg className={filled ? "diamond filled" : "diamond"} width="11" height="11" viewBox="0 0 11 11" aria-hidden="true">
      <path d="M5.5 1.15 9.85 5.5 5.5 9.85 1.15 5.5Z" fill={filled ? "currentColor" : "none"} stroke="currentColor" strokeWidth="1.15" />
    </svg>
  );
}

function Markdown({ text, onOpenFile, imageSrc, videoSrc, skills }: Pick<MarkdownViewProps, "text" | "onOpenFile" | "imageSrc" | "videoSrc" | "skills">) {
  return <MarkdownView text={text} onOpenFile={onOpenFile} imageSrc={imageSrc} videoSrc={videoSrc} skills={skills} />;
}

function toolDetail(item: ActivityItem) {
  const named = [item.command, item.path].filter(Boolean).join("\n");
  if (named) return named;
  if (!item.rawInput) return "";
  return typeof item.rawInput === "string" ? item.rawInput : JSON.stringify(item.rawInput, null, 2);
}
