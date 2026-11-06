import { useEffect, useEffectEvent, useLayoutEffect, useRef, useState } from "react";
import { useCloseOutside } from "../../useCloseOutside.ts";
import type { ClipboardEvent as ReactClipboardEvent, DragEvent as ReactDragEvent, FormEvent } from "react";
import type { SteerTiming } from "../../../bridge/provider.ts";
import type { PresentedOption } from "../../../server/present.ts";
import type { ComposerCatalog, ProviderView } from "../../../server/snapshot.ts";
import { ProviderMark } from "../messages/providerMark.tsx";
import { switchChoice, withOtherProviders, type SwitchChoice } from "./switchModels.ts";
import { CaretIcon, CloseIcon } from "../../icons.tsx";
import { ChoiceItems, isSwitch, OptionCheck, OptionMenu, SwitchItems, type MenuProps, type OptionEntry } from "../../OptionMenu.tsx";
import { fileBadge, filesFromDataTransfer, hasFileDrag, pathsFromDataTransfer, wireAttachments } from "./attachments.ts";
import type { Attachment, WireAttachment } from "./attachments.ts";
import { btwCommand, planCommand, routineCommand } from "./commands.ts";
import type { SlashCommand } from "./commands.ts";
import { relativeTo } from "./mentions.ts";
import { restoreComposerDraft } from "./composerDrafts.ts";
import { composerGhost } from "../../board/suggestion.ts";
import { useDraft } from "./useDraft.ts";
import { useAttachments } from "./useAttachments.ts";
import { useVoice } from "./useVoice.ts";
import { useSpeechModel } from "../../voice/speechModel.ts";
import { useMentions } from "./useMentions.ts";
import { useSlashCommands } from "./useSlashCommands.ts";
import { screenshotBridge } from "./screenshot.ts";
import { TerminalIcon } from "../../terminal/Terminal.tsx";
import type { SessionCall, TranscriptSession } from "../Transcript.tsx";
import { FOLLOW_UP_NAMES, followUpChoices, useFollowUp, type FollowUp } from "../useFollowUp.ts";
import { leaveRef } from "../../leaveRef.ts";
import { useMediaMatch } from "../../useMediaMatch.ts";

// What the composer hands App when a draft becomes a session.
export interface DraftCommit {
  text: string;
  files: Attachment[];
  modeId?: string;
}

// A composer draft App restores into a session that just opened.
export interface ComposerSeed {
  id: string;
  text?: string;
  files?: Attachment[];
}

// The session fields the composer reads.
export type ComposerSession = Pick<TranscriptSession, "id" | "cwd" | "status" | "modeId" | "configOptions" | "suggestion" | "mentions" | "commands" | "loading" | "switching">;

export interface ComposerProps {
  session: ComposerSession;
  // The provider that runs the session. Its modes fill the approval menu, and its capabilities
  // decide which controls show. Missing on a page that has not heard of providers yet.
  provider?: ProviderView | null;
  // The Chat surface: no @ mentions, slash menu, /plan or approval menu.
  plain: boolean;
  // Alt-hold dictation listens only in the pane that has it.
  hotkey: boolean;
  act: SessionCall;
  // Set on a new-session draft: sending commits the draft instead of prompting.
  onCommit?: (draft: DraftCommit) => void | Promise<unknown>;
  // A config pick on a draft; a session posts /api/config instead.
  onConfig?: (id: string, value: string) => void;
  // A draft got its first text: the page can start the picked provider before the message is sent.
  onWarm?: () => void;
  // Every enabled provider's models. A chat's model menu lists the other providers' after its own.
  catalog?: Partial<ComposerCatalog> | null;
  // A model of another provider was picked: the page confirms, then switches the chat.
  onSwitch?: (choice: SwitchChoice) => void;
  onOpenBtw: (question: string) => void;
  // The reader sent a message to the session.
  onSent?: () => void;
  onRoutine?: (prompt: string) => void;
  seed?: ComposerSeed | null;
  onSeedApplied?: () => void;
  focusComposerId?: string | null;
  focusTick?: number;
}

const FOLLOW_UP_PLACEHOLDERS: Record<FollowUp, string> = {
  queue: "Add a message",
  next: "Add to the next step",
  steer: "Steer the conversation",
};

const FOLLOW_UP_HINTS: Record<FollowUp, string> = {
  queue: "Waits for the turn to end",
  next: "Read at the agent's next step",
  steer: "Joins the turn at once",
};

const FOLLOW_UP_SEND_LABELS: Record<FollowUp, string> = {
  queue: "Queue message",
  next: "Send at the next step",
  steer: "Steer",
};

// Grok's modes, for a page whose snapshot does not list providers yet.
const DEFAULT_MODES: PresentedOption["options"] = [
  { value: "full", name: "Always approve" },
  { value: "acceptEdits", name: "Accept edits" },
  { value: "plan", name: "Plan" },
];

// The box grows with its text up to 200 px, then scrolls. An empty box measures its placeholder,
// so the height depends on the width as much as on the text.
// The wrapper holds its height while the box measures: a collapsed box would let the transcript above
// clamp its scroll and jump on every keystroke.
function fitHeight(el: HTMLTextAreaElement): void {
  const holder = el.parentElement;
  if (holder) holder.style.minHeight = `${holder.offsetHeight}px`;
  el.style.height = "auto";
  el.style.height = `${Math.min(el.scrollHeight, 200)}px`;
  if (holder) holder.style.minHeight = "";
}

// The message box and everything on it: attachments, @ mentions, the slash menu, dictation, ghost text,
// the model, effort and approval menus, queue, next step or steer, stop and send.
export function Composer({ session, provider = null, plain, hotkey, act, onCommit, onConfig, onWarm, catalog = null, onSwitch, onOpenBtw, onSent, onRoutine, seed, onSeedApplied, focusComposerId, focusTick = 0 }: ComposerProps) {
  const box = useRef<HTMLTextAreaElement | null>(null);
  const { draft, attachments, cursor, setCursor, draftRef, filesRef, remember, setDraft, replaceAttachments } = useDraft(session.id);
  const [sending, setSending] = useState(false);
  const [openMenu, setOpenMenu] = useState<string | null>(null);
  const [fileDrop, setFileDrop] = useState(false);
  const picker = useRef<HTMLInputElement | null>(null);
  const screenshot = screenshotBridge();

  const running = session.status === "running";
  // The chat is still loading: the box takes text, and sending waits until the chat has loaded.
  const loading = Boolean(session.loading);
  // The chat's provider was turned off in Settings: the chat stays readable, and its box is disabled
  // until the provider is on again. A new chat reaches a provider that is off only when every provider is off.
  const offNote = provider && provider.enabled === false
    ? onCommit
      ? "No provider is on. Turn one on in Settings."
      : `${provider.label} is off. Turn it on in Settings, or start a new chat on another provider.`
    : "";
  const modeId = session.modeId || provider?.defaultMode || "full";
  const planMode = modeId === "plan";
  const modes = provider ? provider.modes.map((mode) => ({ value: mode.id, name: mode.name })) : DEFAULT_MODES;
  const canPlan = modes.some((mode) => mode.value === "plan");
  const canBtw = provider?.capabilities.btw ?? true;
  const followUpOptions = followUpChoices(provider?.capabilities);
  const [followUp, setFollowUp] = useFollowUp(provider?.id ?? "grok", followUpOptions);
  const drafting = Boolean(onCommit);
  // A chat's model menu also lists the other providers' models: picking one asks to switch, not during a turn.
  const switchable = !drafting && Boolean(onSwitch) && provider;
  const busy = session.status === "running";
  // While the chat moves to another model its menus wait: they belong to the session it is leaving.
  const menus: OptionEntry[] = session.switching
    ? []
    : withSwitches([
        ...session.configOptions
          .filter((option) => option.options.length > 0)
          .map((option): OptionEntry => {
            const switching = option.id === "model" && switchable ? provider : null;
            const shown = switching ? withOtherProviders(option, switching.id, switching.label, catalog) : option;
            return {
              option: shown,
              onChange: (value: string) => {
                const choice = switching ? switchChoice(value, catalog) : null;
                if (choice) {
                  // The combined panel stays open across picks, but a switch goes on in its confirmation.
                  setOpenMenu(null);
                  onSwitch?.(choice);
                } else if (drafting) onConfig?.(option.id, value);
                else act("/api/config", { configId: option.id, value });
              },
              ...(switching && shown !== option
                ? {
                    mark: switching.id,
                    hint: (group: string) => (group && group !== switching.label ? (busy ? "After this turn" : "Switches chat") : null),
                    locked: (group: string) => busy && Boolean(group) && group !== switching.label,
                  }
                : {}),
            };
          }),
        ...(drafting || plain
          ? []
          : [{ option: { id: "approval", name: "Approval", currentValue: modeId, options: modes }, onChange: (value: string) => act("/api/mode", { modeId: value }) }]),
      ]);
  const toolsRow = useRef<HTMLDivElement | null>(null);
  const ruler = useRef<HTMLSpanElement | null>(null);
  const combined = useCombinedOptions(toolsRow, ruler, menus.map((entry) => choiceName(entry.option)).join("|"));
  const { attachError, setAttachError, takeFiles, addPaths, removeAttachment } = useAttachments({ session, filesRef, replaceAttachments });
  const { voiceEnabled, voicePhase, voiceNote, voicePhaseRef, finishVoice, onVoiceClick } = useVoice({ hotkey, box, draftRef, setDraft, setCursor, setAttachError });
  const speechState = useSpeechModel().status?.state;
  const modelComing = speechState === "downloading" || speechState === "unpacking";
  const { mentions, mentionIndex, setMentionIndex, setMentioning, syncMention, insertMark, chooseMention } = useMentions({ session, act, drafting, plain, box, draft, cursor, setDraft, setCursor });
  const { commands, commandIndex, setCommandIndex, slashStart } = useSlashCommands({ session, provider: provider?.id, plain, draft, cursor, mentions, btw: canBtw, routine: Boolean(onRoutine) });
  const ghost = composerGhost({
    suggestion: session.suggestion,
    draft,
    running,
    attachments: attachments.length,
    recording: voicePhase === "recording",
  });
  // A phone keyboard has no Tab key, so on a phone Send fills in the suggestion while the box is empty.
  const fillsGhost = useMediaMatch("(pointer: coarse) and (max-width: 640px)") && Boolean(ghost);

  function takeGhost() {
    setDraft(ghost);
    setCursor(ghost.length);
    requestAnimationFrame(() => {
      const field = box.current;
      if (field && field === document.activeElement) field.setSelectionRange(ghost.length, ghost.length);
    });
  }

  useLayoutEffect(() => {
    const el = box.current;
    if (!el) return;
    fitHeight(el);
  }, [draft]);

  // A new width rewraps the text, so the box measures again, e.g. once a page loaded in a narrow or
  // hidden window widens. Only the width counts: the height fitHeight sets would otherwise call it again.
  useEffect(() => {
    const el = box.current;
    if (!el || typeof ResizeObserver === "undefined") return undefined;
    let width = el.offsetWidth;
    const observer = new ResizeObserver(() => {
      if (el.offsetWidth === width) return;
      width = el.offsetWidth;
      fitHeight(el);
    });
    observer.observe(el);
    return () => observer.disconnect();
  }, []);

  const cursorToEnd = useEffectEvent(() => {
    const el = box.current;
    if (!el || !draft) return;
    const end = draft.length;
    setCursor(end);
    el.setSelectionRange(end, end);
  });
  useLayoutEffect(() => cursorToEnd(), [session.id]);

  useEffect(() => {
    if (focusComposerId !== session.id) return;
    // On a touch screen focus raises the keyboard, so the composer waits for a tap.
    if (window.matchMedia?.("(pointer: coarse)").matches) return;
    box.current?.focus();
  }, [focusComposerId, focusTick, session.id]);

  // Once per draft, on its first text.
  const warmed = useRef(false);
  const warm = useEffectEvent(() => onWarm?.());
  useEffect(() => {
    if (!drafting || warmed.current || !draft.trim()) return;
    warmed.current = true;
    warm();
  }, [drafting, draft]);

  const applySeed = useEffectEvent((next: ComposerSeed) => {
    remember(next.text || "", next.files || []);
    onSeedApplied?.();
  });
  useEffect(() => {
    if (!seed || seed.id !== session.id) return;
    applySeed(seed);
  }, [seed, session.id]);

  async function enterPlan(description: string) {
    if (sending) return;
    const previous = draft;
    const files = filesRef.current.slice();
    if (drafting) {
      if (!session.cwd) return;
      setSending(true);
      const revision = remember("", []);
      setAttachError("");
      try {
        await onCommit?.({ text: description || "", files, modeId: "plan" });
      } catch {
        restoreComposerDraft(session.id, { text: description || previous, attachments: files }, revision);
      } finally {
        setSending(false);
      }
      return;
    }
    setSending(true);
    try {
      if (modeId !== "plan") {
        await act("/api/mode", { modeId: "plan" });
      }
      if (!description) {
        setDraft("");
        return;
      }
      const revision = remember("", []);
      setAttachError("");
      try {
        await post(description, files);
      } catch {
        restoreComposerDraft(session.id, { text: description, attachments: files }, revision);
      }
    } catch {
      setDraft(previous);
    } finally {
      setSending(false);
    }
  }

  function openBtw(question: string) {
    setDraft("");
    onOpenBtw(question);
  }

  function runSlash(command: SlashCommand) {
    if (loading) return;
    if (command?.kind === "skill") {
      replaceSlash(`${command.text ?? `/${command.name}`} `);
      return;
    }
    if (command?.name === "plan") void enterPlan("");
    if (command?.name === "btw") openBtw("");
    if (command?.name === "routine") openRoutine("");
  }

  function openRoutine(prompt: string) {
    setDraft("");
    onRoutine?.(prompt);
  }

  function replaceSlash(text: string) {
    const end = slashStart + text.length;
    setDraft(`${draft.slice(0, slashStart)}${text}${draft.slice(cursor).replace(/^\S*?(?=[.,;:!?)]*(?:\s|$))/, "")}`);
    setCursor(end);
    requestAnimationFrame(() => box.current?.setSelectionRange(end, end));
  }

  // A message sent during a turn goes by the follow-up choice. The host queues one the provider cannot steer.
  function post(text: string, files: Attachment[]) {
    const body: { text: string; attachments?: WireAttachment[]; at?: SteerTiming } = { text };
    if (files.length) body.attachments = wireAttachments(files);
    onSent?.();
    if (!running || followUp === "queue") return act("/api/prompt", body);
    body.at = followUp === "next" ? "next" : "now";
    return act("/api/steer", body);
  }

  async function deliver(text: string) {
    if (sending) return;
    const files = filesRef.current.slice();
    if (!text && !files.length) return;
    if (drafting && !session.cwd) return;
    const revision = remember("", []);
    setAttachError("");
    if (drafting) {
      setSending(true);
      try {
        await onCommit?.({ text, files });
      } catch {
        restoreComposerDraft(session.id, { text, attachments: files }, revision);
      } finally {
        setSending(false);
      }
      return;
    }
    setSending(true);
    try {
      await post(text, files);
    } catch {
      restoreComposerDraft(session.id, { text, attachments: files }, revision);
    } finally {
      setSending(false);
    }
  }

  async function send(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (sending || mentions.length || offNote || loading) return;
    const text = draft.trim();
    if (commands.length) {
      const command = commands[commandIndex] || commands[0];
      if (command !== undefined) runSlash(command);
      return;
    }
    const aside = canBtw ? btwCommand(text) : null;
    if (aside) {
      openBtw(aside.question);
      return;
    }
    const routine = onRoutine ? routineCommand(text) : null;
    if (routine) {
      openRoutine(routine.prompt);
      return;
    }
    const planned = plain || !canPlan ? null : planCommand(text);
    if (planned) {
      await enterPlan(planned.description);
      return;
    }
    await deliver(text);
  }

  function onPaste(event: ReactClipboardEvent<HTMLFormElement>) {
    const list = filesFromDataTransfer(event.clipboardData);
    const paths = list.length ? [] : pathsFromDataTransfer(event.clipboardData);
    if (!list.length && !paths.length) return;
    event.preventDefault();
    const pasted = event.clipboardData.getData("text/plain");
    const uriList = event.clipboardData.getData("text/uri-list");
    if (pasted.trim() && pasted.trim() !== uriList.trim()) insertPastedText(pasted, event.target);
    if (list.length) void takeFiles(list);
    if (paths.length) addPaths(paths);
  }

  function insertPastedText(pasted: string, el: EventTarget | null) {
    const boxEl = hasSelection(el) ? el : box.current;
    const start = boxEl?.selectionStart ?? draft.length;
    const end = boxEl?.selectionEnd ?? start;
    const next = `${draft.slice(0, start)}${pasted}${draft.slice(end)}`;
    const nextCursor = start + pasted.length;
    setDraft(next);
    setCursor(nextCursor);
    requestAnimationFrame(() => boxEl?.setSelectionRange?.(nextCursor, nextCursor));
  }

  function onFileDrag(event: ReactDragEvent<HTMLFormElement>) {
    if (!hasFileDrag(event.dataTransfer)) return false;
    event.preventDefault();
    event.stopPropagation();
    return true;
  }

  return (
    <div className="composer-anchor">
      {mentions.length ? (
        <ul className="mentions" data-testid="mentions">
          {mentions.map((match, index) => (
            <li key={match.path}>
              <button
                type="button"
                className={index === mentionIndex ? "active" : ""}
                onMouseDown={(event) => {
                  event.preventDefault();
                  chooseMention(match);
                }}
              >
                <span>{relativeTo(session.cwd, match.path as string)}</span>
              </button>
            </li>
          ))}
        </ul>
      ) : null}
      {commands.length ? (
        <ul className="slash-menu" data-testid="slash-menu" role="listbox" aria-label="Commands">
          {commands.map((command, index) => (
            <li key={command.name}>
              <button
                type="button"
                role="option"
                data-testid={`slash-${command.name}`}
                aria-selected={index === commandIndex}
                className={index === commandIndex ? "active" : ""}
                title={command.hint}
                onMouseEnter={() => setCommandIndex(index)}
                onMouseDown={(event) => {
                  event.preventDefault();
                  runSlash(command);
                }}
              >
                <span className="slash-name">{command.text ?? `/${command.name}`}</span>
                <span className="slash-hint">{command.argumentHint ? `${command.hint} ${command.argumentHint}` : command.hint}</span>
              </button>
            </li>
          ))}
        </ul>
      ) : null}
      <form
        className={["composer", fileDrop ? "dropping" : "", planMode ? "plan" : ""].filter(Boolean).join(" ")}
        data-mode={modeId}
        onSubmit={send}
        onPaste={onPaste}
        onDragEnter={(event) => {
          if (onFileDrag(event)) setFileDrop(true);
        }}
        onDragOver={(event) => {
          if (onFileDrag(event)) setFileDrop(true);
        }}
        onDragLeave={(event) => {
          if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setFileDrop(false);
        }}
        onDrop={(event) => {
          if (!onFileDrag(event)) return;
          setFileDrop(false);
          const list = filesFromDataTransfer(event.dataTransfer);
          const paths = list.length ? [] : pathsFromDataTransfer(event.dataTransfer);
          if (list.length) void takeFiles(list);
          if (paths.length) addPaths(paths);
        }}
      >
        {attachments.length ? (
          <ul className="attach-list" data-testid="attachments">
            {attachments.map((file) => (
              <li key={file.id} className="attach-chip">
                {file.previewUrl ? <img src={file.previewUrl} alt="" /> : <span className="attach-kind">{fileBadge(file.name)}</span>}
                <span className="attach-name" title={file.name}>
                  {file.name}
                </span>
                <button
                  type="button"
                  className="attach-remove"
                  aria-label={`Remove ${file.name}`}
                  onMouseDown={(event) => {
                    event.preventDefault();
                    event.stopPropagation();
                  }}
                  onClick={(event) => {
                    event.preventDefault();
                    event.stopPropagation();
                    removeAttachment(file.id);
                  }}
                >
                  <CloseIcon />
                </button>
              </li>
            ))}
          </ul>
        ) : null}
        {voiceNote ? (
          <p className={voicePhase === "busy" || voicePhase === "arming" || voiceNote === "No speech heard" ? "voice-status" : "attach-error"} role="status">
            {voiceNote}
          </p>
        ) : null}
        {attachError ? (
          <p className="attach-error" role="status">
            {attachError}
          </p>
        ) : null}
        <div className={voicePhase === "recording" ? "composer-input recording" : "composer-input"}>
        <textarea
          ref={box}
          data-testid="composer"
          rows={1}
          value={draft}
          disabled={Boolean(offNote)}
          title={offNote || undefined}
          placeholder={
            offNote
              ? offNote
              : ghost
                ? ghost
                : voicePhase === "recording"
                  ? ""
                  : running
                    ? FOLLOW_UP_PLACEHOLDERS[followUp]
                    : drafting && !session.cwd
                      ? "Choose a folder"
                      : planMode
                        ? "Describe what to plan"
                        : "Ask anything"
          }
          data-ghost={ghost || undefined}
          onChange={(event) => {
            setDraft(event.target.value);
            setCursor(event.target.selectionStart);
            syncMention(event.target.value, event.target.selectionStart);
          }}
          onSelect={(event) => setCursor(event.currentTarget.selectionStart)}
          onKeyDown={(event) => {
            if (voicePhaseRef.current === "recording" && event.key === "Enter" && !event.shiftKey) {
              event.preventDefault();
              finishVoice();
              return;
            }
            if (event.key === "Tab" && !event.shiftKey && ghost) {
              event.preventDefault();
              takeGhost();
              return;
            }
            if (event.key === "Backspace" && !draft && !mentions.length && filesRef.current.length) {
              event.preventDefault();
              removeAttachment(filesRef.current.at(-1)!.id);
              return;
            }
            if (mentions.length && event.key === "ArrowDown") {
              event.preventDefault();
              setMentionIndex((index) => (index + 1) % mentions.length);
              return;
            }
            if (mentions.length && event.key === "ArrowUp") {
              event.preventDefault();
              setMentionIndex((index) => (index - 1 + mentions.length) % mentions.length);
              return;
            }
            if (mentions.length && event.key === "Enter" && !event.shiftKey) {
              event.preventDefault();
              const mention = mentions[mentionIndex] || mentions[0];
              if (mention !== undefined) chooseMention(mention);
              return;
            }
            if (mentions.length && event.key === "Escape") {
              event.preventDefault();
              setMentioning(false);
              return;
            }
            if (commands.length && event.key === "ArrowDown") {
              event.preventDefault();
              setCommandIndex((index) => (index + 1) % commands.length);
              return;
            }
            if (commands.length && event.key === "ArrowUp") {
              event.preventDefault();
              setCommandIndex((index) => (index - 1 + commands.length) % commands.length);
              return;
            }
            if (commands.length && event.key === "Enter" && !event.shiftKey) {
              event.preventDefault();
              const command = commands[commandIndex] || commands[0];
              if (command !== undefined) runSlash(command);
              return;
            }
            if (commands.length && event.key === "Escape") {
              event.preventDefault();
              replaceSlash("");
              return;
            }
            if (event.key === "Enter" && !event.shiftKey) {
              event.preventDefault();
              event.currentTarget.form?.requestSubmit();
            }
          }}
        />
        {voicePhase === "recording" ? <VoiceWave /> : null}
        </div>
        <div className="composer-bar">
          <div className="composer-tools" ref={toolsRow}>
            <input
              ref={picker}
              type="file"
              multiple
              hidden
              data-testid="attach-input"
              onChange={(event) => {
                const list = [...(event.target.files || [])];
                event.target.value = "";
                if (list.length) void takeFiles(list);
              }}
            />
            <PlusMenu
              open={openMenu === "plus"}
              onToggle={() => setOpenMenu((current) => (current === "plus" ? null : "plus"))}
              onClose={() => setOpenMenu(null)}
              onAttach={() => picker.current?.click()}
              onScreenshot={screenshot ? () => void screenshot().then((file) => file && takeFiles([file])) : null}
              onMark={plain ? null : insertMark}
            />
            {session.switching ? (
              <span className="option-trigger is-static" data-testid="switching-model">
                <ProviderMark provider={session.switching.to} />
                <span>{session.switching.toModel}</span>
              </span>
            ) : null}
            {combined ? (
              <CombinedOptions
                menus={menus}
                open={openMenu === "combined"}
                onToggle={() => setOpenMenu((current) => (current === "combined" ? null : "combined"))}
                onClose={() => setOpenMenu(null)}
              />
            ) : (
              menus.map((entry) => (
                <OptionMenu
                  key={entry.option.id}
                  entry={entry}
                  open={openMenu === entry.option.id}
                  onToggle={() => setOpenMenu((current) => (current === entry.option.id ? null : entry.option.id))}
                  onClose={() => setOpenMenu(null)}
                />
              ))
            )}
            <span className="option-ruler" ref={ruler} aria-hidden="true">
              {menus.map(({ option }) => (
                <span key={option.id} className="option-trigger">
                  <span>{choiceName(option)}</span>
                  <CaretIcon />
                </span>
              ))}
            </span>
          </div>
          <div className="composer-actions">
            {voiceEnabled ? (
              <button
                type="button"
                className={["icon", "voice", voicePhase === "recording" ? "recording" : "", voicePhase === "arming" ? "arming" : "", modelComing && voicePhase === "idle" ? "downloading" : ""].filter(Boolean).join(" ")}
                data-testid="voice"
                aria-pressed={voicePhase === "recording"}
                aria-label={voicePhase === "recording" ? "Stop recording" : voicePhase === "arming" ? "Getting ready" : modelComing ? "Downloading the speech model" : "Dictate"}
                aria-keyshortcuts="Alt"
                title={modelComing ? "Downloading the speech model…" : "Dictate. Hold Alt to talk."}
                disabled={voicePhase === "busy"}
                onClick={onVoiceClick}
              >
                <MicIcon />
                {voicePhase === "recording" ? <span className="voice-dot" /> : null}
              </button>
            ) : null}
            {followUpOptions.length > 1 ? (
              <FollowMenu
                value={followUp}
                choices={followUpOptions}
                open={openMenu === "follow-up"}
                onToggle={() => setOpenMenu((current) => (current === "follow-up" ? null : "follow-up"))}
                onClose={() => setOpenMenu(null)}
                onChange={setFollowUp}
              />
            ) : null}
            {running ? (
              <button type="button" className="send" data-testid="stop" aria-label="Stop" onClick={() => act("/api/cancel")}>
                <StopIcon />
              </button>
            ) : null}
            {fillsGhost ? (
              <button
                type="button"
                className="send fill"
                data-testid="fill-suggestion"
                aria-label="Fill in the suggestion"
                disabled={Boolean(offNote)}
                onClick={(event) => {
                  // React reuses this node as the submit button before the tap's default action runs.
                  event.preventDefault();
                  takeGhost();
                }}
              >
                <FillIcon />
              </button>
            ) : !running || draft.trim() || attachments.length ? (
              <button
                className="send"
                data-testid="send"
                type="submit"
                aria-label={running ? FOLLOW_UP_SEND_LABELS[followUp] : "Send"}
                title={offNote || (loading ? "Sends once the chat has loaded" : undefined)}
                disabled={Boolean(offNote) || loading || sending || (drafting && !session.cwd) || (!draft.trim() && attachments.length === 0)}
              >
                <SendIcon />
              </button>
            ) : null}
          </div>
        </div>
      </form>
    </div>
  );
}

function FollowMenu({ value, choices, open, onToggle, onClose, onChange }: MenuProps<FollowUp> & { value: FollowUp; choices: FollowUp[] }) {
  const root = useRef<HTMLDivElement | null>(null);

  useCloseOutside(open, root, onClose);

  return (
    <div className={open ? "option-menu open" : "option-menu"} ref={root}>
      <button
        type="button"
        className="option-trigger"
        data-testid="follow-up"
        aria-label="Message delivery"
        aria-haspopup="listbox"
        aria-expanded={open}
        onClick={onToggle}
      >
        <span>{FOLLOW_UP_NAMES[value]}</span>
        <CaretIcon />
      </button>
      {open ? (
        <ul ref={leaveRef} className="option-list" role="listbox" aria-label="Message delivery">
          <li className="option-title" role="presentation">Message delivery</li>
          {choices.map((choice) => (
            <li key={choice}>
              <button
                type="button"
                role="option"
                aria-selected={choice === value}
                className={choice === value ? "active" : ""}
                onClick={() => {
                  onClose();
                  onChange(choice);
                }}
              >
                <span className="option-text">
                  {FOLLOW_UP_NAMES[choice]}
                  <small>{FOLLOW_UP_HINTS[choice]}</small>
                </span>
                {choice === value ? <OptionCheck /> : null}
              </button>
            </li>
          ))}
        </ul>
      ) : null}
    </div>
  );
}

function choiceName(option: PresentedOption) {
  return (option.options.find((choice) => choice.value === option.currentValue) || option.options[0])?.name || option.name;
}

// True on a phone, and where the option menus side by side do not fit next to the bar's buttons. The ruler
// holds the menus' labels as they would show, so the fit is known while they sit behind one button.
function useCombinedOptions(row: React.RefObject<HTMLDivElement | null>, ruler: React.RefObject<HTMLSpanElement | null>, labels: string) {
  const [combined, setCombined] = useState(false);
  useLayoutEffect(() => {
    const tools = row.current;
    const menus = ruler.current;
    if (!tools || !menus) return undefined;
    const phone = typeof window.matchMedia === "function" ? window.matchMedia("(max-width: 640px)") : null;
    const check = () => {
      if (phone?.matches) return setCombined(true);
      if (!tools.clientWidth) return setCombined(false);
      let buttons = 0;
      for (const child of tools.children) {
        if (child instanceof HTMLButtonElement || (child instanceof HTMLElement && child.classList.contains("plus-menu"))) buttons += child.offsetWidth;
      }
      setCombined(buttons + menus.scrollWidth + 4 > tools.clientWidth);
    };
    check();
    const observer = typeof ResizeObserver === "function" ? new ResizeObserver(check) : null;
    observer?.observe(tools);
    phone?.addEventListener("change", check);
    return () => {
      observer?.disconnect();
      phone?.removeEventListener("change", check);
    };
  }, [row, ruler, labels]);
  return combined;
}

// On/off options show as switches at the foot of the effort menu.
export function withSwitches(entries: OptionEntry[]): OptionEntry[] {
  const effort = entries.find((entry) => entry.option.id === "effort");
  const switches = entries.filter((entry) => isSwitch(entry.option));
  if (!effort || !switches.length) return entries;
  return entries.filter((entry) => !switches.includes(entry)).map((entry) => (entry === effort ? { ...entry, switches } : entry));
}

// A few short choices, such as reasoning effort, read as one row of buttons.
function fitsInRow(option: PresentedOption) {
  return option.options.length <= 5 && option.options.every((choice) => !choice.group && !choice.older && choice.name.length <= 12);
}

// Every option menu behind one button, named by the first two choices that are not the approval mode,
// such as the model and its reasoning effort. It stays open across picks, so both can change at once.
function CombinedOptions({ menus, open, onToggle, onClose }: { menus: OptionEntry[]; open: boolean; onToggle: () => void; onClose: () => void }) {
  const root = useRef<HTMLDivElement | null>(null);
  const named = menus.filter((entry) => entry.option.id !== "approval");
  const label = (named.length ? named : menus).slice(0, 2).map((entry) => choiceName(entry.option)).join(" · ");

  useCloseOutside(open, root, onClose);

  return (
    <div className={open ? "option-menu open" : "option-menu"} ref={root}>
      <button
        type="button"
        className="option-trigger"
        data-testid="config-combined"
        aria-label={menus.map((entry) => `${entry.option.name}: ${choiceName(entry.option)}`).join(", ")}
        aria-haspopup="dialog"
        aria-expanded={open}
        onClick={onToggle}
      >
        <span>{label}</span>
        <CaretIcon />
      </button>
      {open ? (
        <>
          <div ref={leaveRef} className="option-scrim" aria-hidden="true" onClick={onClose} />
          <div ref={leaveRef} className="option-panel" role="dialog" aria-label="Chat options">
            {menus.map(({ option, onChange, hint, locked, switches }) => (
              <section key={option.id} className="option-section">
                <h3>{option.name}</h3>
                {fitsInRow(option) ? (
                  <div className="option-segments" role="radiogroup" aria-label={option.name}>
                    {option.options.map((choice) => (
                      <button
                        key={choice.value}
                        type="button"
                        role="radio"
                        aria-checked={choice.value === option.currentValue}
                        onClick={() => {
                          if (choice.value !== option.currentValue) onChange(choice.value);
                        }}
                      >
                        {choice.name}
                      </button>
                    ))}
                  </div>
                ) : (
                  <ul className="option-choices" role="listbox" aria-label={option.name}>
                    <ChoiceItems
                      option={option}
                      hint={hint}
                      locked={locked}
                      onPick={(value) => {
                        if (value !== option.currentValue) onChange(value);
                      }}
                    />
                  </ul>
                )}
                {switches?.length ? (
                  <ul className="option-choices">
                    <SwitchItems switches={switches} />
                  </ul>
                ) : null}
              </section>
            ))}
          </div>
        </>
      ) : null}
    </div>
  );
}

// The + menu: attach files, take a screenshot where the desktop app can, and in a session mention a file or run a command.
function PlusMenu({ open, onToggle, onClose, onAttach, onScreenshot, onMark }: Omit<MenuProps<never>, "onChange"> & {
  onAttach: () => void;
  onScreenshot: (() => void) | null;
  onMark: ((mark: "@" | "/") => void) | null;
}) {
  const root = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    if (!open) return undefined;
    function onPointerDown(event: PointerEvent) {
      if (!root.current?.contains(event.target as Node | null)) onClose();
    }
    function onKey(event: KeyboardEvent) {
      if (event.key === "Escape") onClose();
    }
    document.addEventListener("pointerdown", onPointerDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("pointerdown", onPointerDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [open, onClose]);

  const items: { label: string; icon: React.ReactNode; mark?: string; run: () => void }[] = [
    { label: "Attach files", icon: <PaperclipIcon />, run: onAttach },
    ...(onScreenshot ? [{ label: "Take a screenshot", icon: <CameraIcon />, run: onScreenshot }] : []),
    ...(onMark
      ? [
          { label: "Mention a file", icon: <FileIcon />, mark: "@", run: () => onMark("@") },
          { label: "Run a command", icon: <TerminalIcon />, mark: "/", run: () => onMark("/") },
        ]
      : []),
  ];
  return (
    <div className={open ? "plus-menu open" : "plus-menu"} ref={root}>
      <button type="button" className="icon" data-testid="plus" aria-label="Add" aria-haspopup="menu" aria-expanded={open} onClick={onToggle}>
        <PlusIcon />
      </button>
      {open ? (
        <ul ref={leaveRef} className="option-list plus-list" role="menu" aria-label="Add">
          {items.map((item) => (
            <li key={item.label}>
              <button
                type="button"
                role="menuitem"
                onClick={() => {
                  onClose();
                  item.run();
                }}
              >
                {item.icon}
                <span>{item.label}</span>
                {item.mark ? <kbd>{item.mark}</kbd> : null}
              </button>
            </li>
          ))}
        </ul>
      ) : null}
    </div>
  );
}

function PaperclipIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 16 16" aria-hidden="true">
      <path
        d="M6.2 8.6 10 4.8a2.1 2.1 0 0 1 3 3L7.2 13.6a3.2 3.2 0 0 1-4.5-4.5l5.6-5.6"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.5"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

function CameraIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 16 16" aria-hidden="true">
      <path d="M2 5.6c0-.7.5-1.2 1.2-1.2h1.9l1-1.6h3.8l1 1.6h1.9c.7 0 1.2.5 1.2 1.2v6.2c0 .7-.5 1.2-1.2 1.2H3.2c-.7 0-1.2-.5-1.2-1.2z" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinejoin="round" />
      <circle cx="8" cy="8.6" r="2.3" fill="none" stroke="currentColor" strokeWidth="1.4" />
    </svg>
  );
}

function FileIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 16 16" aria-hidden="true">
      <path d="M9 1.9H4.6c-.6 0-1.1.5-1.1 1.1v10c0 .6.5 1.1 1.1 1.1h6.8c.6 0 1.1-.5 1.1-1.1V5.4zM9 1.9v3.5h3.5" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinejoin="round" />
    </svg>
  );
}

function PlusIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 16 16" aria-hidden="true">
      <path d="M8 3.2v9.6M3.2 8h9.6" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
    </svg>
  );
}

function VoiceWave() {
  return (
    <div className="voice-wave" aria-hidden="true">
      {Array.from({ length: 23 }, (_, index) => (
        <span key={index} style={{ animationDelay: `${(index % 12) * -0.07}s` }} />
      ))}
    </div>
  );
}

function MicIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 16 16" aria-hidden="true">
      <rect x="5.25" y="1.6" width="5.5" height="8.2" rx="2.75" fill="none" stroke="currentColor" strokeWidth="1.5" />
      <path d="M3.4 7.4a4.6 4.6 0 0 0 9.2 0M8 12v2.2" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
    </svg>
  );
}

function SendIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 16 16" aria-hidden="true">
      <path d="M8 12.4V3.6M8 3.6 4.4 7.1M8 3.6l3.6 3.5" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

function FillIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 16 16" aria-hidden="true">
      <path d="M3.5 4.5v3a1.8 1.8 0 0 0 1.8 1.8h7.2M9.6 6.4l2.9 2.9-2.9 2.9" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

function StopIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 16 16" aria-hidden="true">
      <rect x="3.5" y="3.5" width="9" height="9" rx="1.6" fill="currentColor" />
    </svg>
  );
}

// The paste target when it is a text field with a caret.
function hasSelection(el: EventTarget | null): el is HTMLTextAreaElement | HTMLInputElement {
  return el != null && "selectionStart" in el && el.selectionStart != null;
}
