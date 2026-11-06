import { useEffect, useRef, useState } from "react";
import type { OpenSession } from "../../server/snapshot.ts";
import { deskReply, withFirstMessage, type FirstMessage } from "../dock/deskView.ts";
import { draftFolder } from "../folder/draftFolder.ts";
import { createDraftWorktree, keptWorktree, type WorktreePlan } from "../folder/draftWorktree.ts";
import type { ApiCall } from "../launchToken.ts";
import type { PageSnapshot } from "../useSnapshot.ts";
import { wireAttachments, type WireAttachment } from "./composer/attachments.ts";
import type { ComposerSeed, DraftCommit } from "./composer/Composer.tsx";
import { catalogFor, composerOptions, draftChoice, withPick, type DraftPicks } from "./composer/draftConfig.ts";
import type { PickMemory } from "./composer/usePickMemory.ts";
import type { TranscriptSession } from "./Transcript.tsx";

// A new session that no provider has started yet. A folder pick can leave cwd unset.
interface Draft {
  cwd: string | undefined;
  picks: DraftPicks | undefined;
  // A new chat on the Chat tab: it runs in the chat folder, whichever model is picked.
  chat?: boolean;
  worktree?: WorktreePlan;
  // The number of the send under way. Edits keep it, and any other draft or chat on screen lacks it.
  sent?: number;
}

// A chat draft needs no folder. The host puts every chat in ~/.x-bench/chat.
const CHAT_FOLDER = "chat";

interface DraftOptions {
  snapshot: PageSnapshot;
  call: ApiCall;
  memory: PickMemory;
  ready: boolean;
  // The Builder desk is empty and no page covers it.
  landable: boolean;
  setFocusId: (sessionId: string) => void;
  leave: () => void;
  cancelOpening: () => void;
}

// The composer focus and the restored text it holds apply to open chats too.
export function useDraftSession({ snapshot, call, memory, ready, landable, setFocusId, leave, cancelOpening }: DraftOptions) {
  const [draft, setDraft] = useState<Draft | null>(null);
  // The draft on screen, and the number of the send under way. A send whose draft the user left opens its session in the background.
  const draftNow = useRef<Draft | null>(null);
  draftNow.current = draft;
  const sends = useRef(0);
  const sendingDraft = useRef<number | null>(null);
  const [landingCwd, setLandingCwd] = useState<string | null>(null);
  const startedOnDraft = useRef<boolean | null>(null);
  const [handoff, setHandoff] = useState<OpenSession | null>(null);
  const [firstMessage, setFirstMessage] = useState<FirstMessage | null>(null);
  const [seed, setSeed] = useState<ComposerSeed | null>(null);
  const [focusComposerId, setFocusComposerId] = useState<string | null>(null);
  const [focusTick, setFocusTick] = useState(0);
  const [busy, setBusy] = useState(false);
  const catalog = catalogFor({ composer: snapshot.composer, providers: snapshot.providers });

  // With nothing open, the Builder shows a new session in the folder worked in last.
  // It stays out of draft, so a session opened from the sidebar replaces it once it arrives.
  const landing = landable && !draft && !handoff;
  const lastFolder = draftFolder(snapshot.projects);
  const shownDraft: Draft | null = draft ?? (landing ? { cwd: landingCwd ?? lastFolder, picks: undefined } : null);
  // Whether the app opened on this pane, decided once with the first snapshot. The line then says welcome first.
  if (ready && startedOnDraft.current === null) startedOnDraft.current = landing;
  const drafting = Boolean(shownDraft) && !handoff;

  useEffect(() => {
    if (!handoff) return;
    if (!snapshot.open.some((session) => session.id === handoff.id)) return;
    setHandoff(null);
  }, [handoff, snapshot.open]);

  // The first message leaves once the host's copy of its session shows a message.
  useEffect(() => {
    if (!firstMessage?.sessionId) return;
    const session = snapshot.open.find((item) => item.id === firstMessage.sessionId);
    if (session?.transcript.some((item) => item.type === "user") || session?.error) setFirstMessage(null);
  }, [firstMessage, snapshot.open]);

  useEffect(() => {
    if (!landing) return;
    focusComposer("draft");
  }, [landing]);

  useEffect(() => {
    // The first real folder is settled, so a session updated elsewhere does not move it while the user types.
    // "No folder yet" is not settled: a folder that turns up later still fills in.
    if (!landing) setLandingCwd(null);
    else if (lastFolder) setLandingCwd((current) => current ?? lastFolder);
  }, [landing, lastFolder]);

  function focusComposer(id: string) {
    setFocusComposerId(id);
    setFocusTick((tick) => tick + 1);
  }

  function freshDesk() {
    leave();
    setSeed(null);
    setHandoff(null);
    cancelOpening();
    focusComposer("draft");
  }

  function openDraft(folder?: string) {
    freshDesk();
    setDraft((current) => {
      const shown = current ?? shownDraft;
      if (shown && typeof folder !== "string") return shown;
      return {
        cwd: typeof folder === "string" ? folder : draftFolder(snapshot.projects),
        picks: shown?.picks,
      };
    });
  }

  // A new chat starts as a draft, so its model menu can pick any provider. Sending opens it.
  function startChat() {
    freshDesk();
    setDraft((current) => ({ cwd: CHAT_FOLDER, picks: current?.picks, chat: true }));
  }

  function drop() {
    setDraft(null);
    setHandoff(null);
  }

  function draftWorktree(shown: Draft): WorktreePlan {
    return shown.worktree ?? { on: memory.worktreeLast, gitRef: "" };
  }

  function planDraftWorktree(worktree: WorktreePlan) {
    setFocusComposerId("draft");
    setDraft((current) => {
      const shown = current ?? shownDraft;
      return shown ? { ...shown, worktree } : current;
    });
  }

  function setDraftConfig(id: string, value: string) {
    setDraft((stored) => {
      const current = stored ?? shownDraft;
      if (!current) return stored;
      memory.rememberPick(id, value);
      return { ...current, picks: withPick(catalog, current.picks, id, value) };
    });
  }

  // Starts the provider a draft will send to, so the first message does not wait for it.
  function warmDraft(picks: DraftPicks | undefined = shownDraft?.picks) {
    const choice = draftChoice(catalog, memory.remembered(picks));
    if (choice) call("/api/warm", { provider: choice.provider }).catch(() => {});
  }

  async function commitDraft({ text, files, modeId }: DraftCommit) {
    let folder = shownDraft?.cwd;
    const choice = draftChoice(catalog, memory.remembered(shownDraft?.picks));
    if (!shownDraft || !folder) throw new Error("Choose a folder");
    leave();
    setBusy(true);
    const sending = String(text || "").trim() || files?.length;
    if (sending) {
      setFirstMessage({
        sessionId: null,
        text: text || "",
        attachments: (files || []).map((file) => ({ name: file.name, kind: file.kind, mimeType: file.mimeType, ...(file.preview ? { preview: file.preview } : {}) })),
      });
    }
    const planned = shownDraft && !shownDraft.chat ? { ...shownDraft, worktree: draftWorktree(shownDraft) } : null;
    const mine = ++sends.current;
    const marked: Draft = { ...(planned ?? shownDraft), sent: mine };
    sendingDraft.current = mine;
    draftNow.current = marked;
    setDraft(marked);
    const left = () => draftNow.current?.sent !== mine;
    try {
      if (planned) {
        const moved = await createDraftWorktree(marked, choice?.provider, text || "", call);
        if (moved !== marked) {
          folder = moved.cwd;
          if (!left()) setDraft(moved);
        }
      }
      // The picked model decides the provider the session runs on.
      const picked = {
        ...(choice ? { provider: choice.provider, model: choice.model, effort: choice.effort } : {}),
        ...(modeId ? { mode: modeId } : {}),
      };
      const background = left() ? { background: true } : {};
      const data = deskReply(await call("/api/session", { ...(shownDraft?.chat ? { chat: true } : { cwd: folder }), ...picked, ...background }));
      const sessionId = data.sessionId;
      if (!sessionId) throw new Error("Couldn't start the chat");
      if (planned) memory.rememberWorktree(planned.worktree.on || Boolean(planned.worktree.made));
      // The host opens the session off the desk when a newer load or session overtook it.
      const opened = (data.open || []).find((session) => session.id === sessionId);
      if (opened && !left()) {
        if (sending) setFirstMessage((current) => (current ? { ...current, sessionId } : current));
        // Keep this session on screen until the event stream lists it. Writing it
        // into the snapshot here lets a late, older event uncover the previous chat.
        setHandoff(opened);
        setFocusId(sessionId);
        focusComposer(sessionId);
        setDraft(null);
      } else {
        setFirstMessage(null);
        if (!left()) setDraft(null);
      }
      try {
        const body: { sessionId: string; text: string; attachments?: WireAttachment[] } = { sessionId, text: text || "" };
        if (files?.length) body.attachments = wireAttachments(files);
        if (sending) await call("/api/prompt", body);
      } catch {
        setFirstMessage(null);
        setSeed({ id: sessionId, text: text || "", files: files || [] });
      }
    } catch (error) {
      // The composer puts the text back.
      setFirstMessage(null);
      throw error;
    } finally {
      sendingDraft.current = null;
      setBusy(false);
    }
  }

  const picks = shownDraft ? memory.remembered(shownDraft.picks) : undefined;
  const session: TranscriptSession | null = drafting && shownDraft
    ? withFirstMessage<TranscriptSession>({
        id: "draft",
        // Transcript types cwd as a string; a draft's is unset only if a folder reply had none.
        cwd: shownDraft.cwd as string,
        title: shownDraft.chat ? "New chat" : "New session",
        transcript: [],
        status: "idle",
        configOptions: composerOptions(catalog, picks),
        // The picked model's provider, so the box follows it. With no provider on there is none.
        provider: draftChoice(catalog, picks)?.provider ?? "",
        queue: [],
        revision: 0,
        modeId: "full",
      }, firstMessage && !firstMessage.sessionId && shownDraft.sent === sendingDraft.current ? firstMessage : null, "draft")
    : null;

  const paneProps = {
    onCommit: commitDraft,
    onConfig: (id: string, value: string) => {
      setDraftConfig(id, value);
      // Picking a model says which provider comes next.
      if (id === "model") warmDraft({ ...(shownDraft?.picks || {}), model: value });
    },
    onWarm: () => warmDraft(),
    onCwd: (next: string | undefined) =>
      setDraft((current) => {
        const worktree = keptWorktree(current?.worktree);
        return { cwd: next, picks: current?.picks, ...(worktree ? { worktree } : {}), ...(current?.sent ? { sent: current.sent } : {}) };
      }),
    worktree: shownDraft ? draftWorktree(shownDraft) : undefined,
    onWorktree: planDraftWorktree,
    welcome: startedOnDraft.current === true,
  };

  return {
    draft, shownDraft, drafting, session, paneProps, handoff, firstMessage, busy,
    seed, clearSeed: () => setSeed(null), focusComposerId, focusTick,
    openDraft, startChat, drop,
  };
}
