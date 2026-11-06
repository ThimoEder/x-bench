import { useCallback, useEffect, useEffectEvent, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { DeviceView } from "../devices/DeviceView.tsx";
import { BrowserView } from "../browser/BrowserView.tsx";
import { UnityView } from "../unity/UnityView.tsx";
import { TerminalTab, useShellChoice } from "../terminal/TerminalTab.tsx";
import { DiffStack } from "../git/DiffStack.tsx";
import { MarkdownToggle, useMarkdownPreview } from "../git/MarkdownToggle.tsx";
import { markdownImageSrc } from "../git/markdownDiff.ts";
import { sessionFilePath } from "../chat/composer/mentions.ts";
import { LIST_RATIO_KEY, LIST_RATIO_MAX, LIST_RATIO_MIN, clampRatio, storedListRatio } from "./dockSplit.ts";
import { FileIcon, FileTree } from "../folder/FileTree.tsx";
import { GitChanges } from "../git/GitChanges.tsx";
import { MarkdownView } from "../chat/markdown/MarkdownView.tsx";
import { isMarkdownPath } from "../chat/markdown/markdown.ts";
import { patchRecord, reviewPatches, samePatches } from "../git/diffFollow.ts";
import { imageExtension, imageSrc } from "../git/imageDiff.ts";
import { ShotLightbox } from "../chat/messages/ShotLightbox.tsx";
import { planOpensTab, planTabMemory } from "../chat/planTab.ts";
import { PlanSteps } from "../chat/PlanShelf.tsx";
import { useThumb } from "../useThumb.ts";
import { dockPlaces, paneRatio } from "./dockMemory.ts";
import { WIDE_DOCK, closePane, dropTab, dropZone, zoneInset } from "./dockPanes.ts";
import { openTerminalLink } from "../terminal/terminalPlace.ts";
import { apiFetch, type CallOptions } from "../launchToken.ts";
import { useStableCallback } from "../useStableCallback.ts";
import type * as React from "react";
import type { ReactNode } from "react";
import type { FileNode } from "../../server/folder/files.ts";
import type { PlanEntry } from "../../bridge/protocol.ts";
import type { BrowserView as BrowserState, DeviceFocus, OpenSession, ShellView } from "../../server/snapshot.ts";
import type { DeviceViewProps } from "../devices/DeviceView.tsx";
import type { DiffFocus } from "../git/DiffStack.tsx";
import type { ChangeScope, ListedFile } from "../git/GitChanges.tsx";
import type { DockPlace, DockSplit, DockTab } from "./dockMemory.ts";
import type { DockLayout, DropZone } from "./dockPanes.ts";
import { remotePage } from "../launchToken.ts";
import { hideRailTip, railTipBridge, showRailTip } from "./railTip.ts";

// A file another pane asked the dock to show. nonce changes on every request.
export interface OpenedFile {
  sessionId: string;
  path: string;
  nonce: number;
}

export interface DockProps {
  session: OpenSession;
  call: DeviceViewProps["call"];
  onClose: () => void;
  onOpen?: () => void;
  open?: boolean;
  // Holds the rail outside the dock, so it stays while the dock is closed. Without one the rail sits in the dock.
  railHost?: HTMLElement | null;
  reviewNonce?: number;
  openedFile?: OpenedFile | null;
  browser?: BrowserState | null;
  deviceFocus?: DeviceFocus | null;
  // The name of the session's agent, for the Browser tab.
  agent?: string;
  // The session's shells, for the Terminal tab.
  shells?: ShellView[];
  // Changes when the shelf asks for the Terminal tab.
  terminalNonce?: number;
  // False while the terminal is a panel under the desk, which hides the Terminal tab.
  terminalInDock?: boolean;
  onMoveTerminal?: () => void;
  // The surfaces the dock's panes show, each time they change.
  onTabs?: (tabs: DockTab[]) => void;
  // A phone shows one pane, so a saved split waits for a wider screen and the rail's tabs don't drag.
  phone?: boolean;
}

// title is a FileNode name when the tree picked the file, which the host forwards unchecked.
interface FileView {
  kind: "file" | "markdown" | "image";
  title: unknown;
  text: string;
  path?: string;
  error?: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

// /api/file answers { path, content } with content a string.
function fileContent(data: unknown): string {
  return (isRecord(data) && typeof data.content === "string" && data.content) || "";
}

// /api/git/diffs answers { patches: GitPatch[] }.
function patchRows(data: unknown): unknown[] {
  const rows = isRecord(data) ? data.patches : undefined;
  return Array.isArray(rows) ? rows : [];
}

// /api/git/diff answers { patch: GitPatch | null }.
function patchText(data: unknown): string {
  const patch = isRecord(data) ? data.patch : undefined;
  return (isRecord(patch) && typeof patch.patch === "string" && patch.patch) || "";
}

// call rejects with an Error (or fetch's TypeError), whose message is a string.
function errorMessage(error: unknown): string {
  return (isRecord(error) && typeof error.message === "string" && error.message) || "";
}

// Hidden for now: the Unity tab is an experiment and not yet a full feature. To bring it back, set this to Reflect.has(window, "xBenchDesktop").
const unityAvailable = false;

// The tab a chat comes back to.
function restoredTab(place: DockPlace | undefined, browser: boolean, terminal: boolean, device: boolean): DockTab {
  const tab = place?.tab ?? "changes";
  if (tab === "unity" && !unityAvailable) return "changes";
  if (tab === "browser" && !browser) return "changes";
  if (tab === "device" && !device) return "changes";
  return tab === "terminal" && !terminal ? "changes" : tab;
}

const NO_SHELLS: ShellView[] = [];
const PANE_STEPS: Record<string, number> = { ArrowUp: -0.04, ArrowLeft: -0.04, ArrowDown: 0.04, ArrowRight: 0.04 };

export function Dock({ session, call, onClose, onOpen, open = false, railHost = null, reviewNonce = 0, openedFile = null, browser = null, deviceFocus = null, agent, shells = NO_SHELLS, terminalNonce = 0, terminalInDock = true, onMoveTerminal, onTabs, phone = false }: DockProps) {
  // Grok asks to approve a plan with its own request. Claude asks with a permission that carries the plan.
  const planPermission = session.pendingPermission?.plan ? session.pendingPermission : null;
  const planWaiting = Boolean(session.pendingPlan || planPermission);
  // The plan document the agent is writing or wrote, and its step list (a todo list). The Plan tab shows
  // them whenever there are any, and a plan waiting for approval, which the thread's card answers.
  const planDoc = session.planDoc?.text.trim() ? session.planDoc : null;
  const steps = session.plan ?? [];
  const hasPlan = planWaiting || Boolean(planDoc) || steps.length > 0;
  // A page opened through remote access has no live device view: its stream stays on the Mac.
  const hasDevice = !remotePage();
  const [tab, setTab] = useState<DockTab>(() => restoredTab(dockPlaces.get(session.id), Boolean(browser), terminalInDock, hasDevice));
  const running = useRef(session.status === "running");
  running.current = session.status === "running";
  const [tip] = useState(railTipBridge);
  const [changeScope, setChangeScope] = useState<ChangeScope>("head");
  const [changesSlot, setChangesSlot] = useState<HTMLElement | null>(null);
  const [changeFiles, setChangeFiles] = useState<ListedFile[]>([]);
  const [patches, setPatches] = useState<Record<string, string>>({});
  const [activePath, setActivePath] = useState<unknown>("");
  const [focus, setFocus] = useState<DiffFocus | null>(null);
  const [view, setView] = useState<FileView | null>(null);
  const [filePreview, setFilePreview] = useMarkdownPreview("x-bench-file-preview", true);
  const [reviewRoot, setReviewRoot] = useState("");
  const viewPath = sessionFilePath(session.cwd, view?.path);
  const viewImageSrc = useCallback((href: string) => markdownImageSrc(session.id, viewPath, href), [session.id, viewPath]);
  const [listRatio, setListRatio] = useState<number>(storedListRatio);
  const [splitDrag, setSplitDrag] = useState(false);
  const [split, setSplit] = useState<DockSplit | null>(() => dockPlaces.get(session.id)?.split ?? null);
  const [drag, setDrag] = useState<{ tab: DockTab; pane?: 0 | 1 } | null>(null);
  const [zone, setZone] = useState<DropZone | null>(null);
  const [paneDrag, setPaneDrag] = useState(false);
  const [device, setDevice] = useState("");
  const [shell, setShell] = useShellChoice(session.id);
  const onTabsRef = useRef(onTabs);
  onTabsRef.current = onTabs;
  // The chat the dock's state was restored for. Until it matches the session, nothing is saved.
  const [placeOf, setPlaceOf] = useState<string | null>(null);
  const fileTicket = useRef(0);
  const patchTicket = useRef(0);
  // The load still waiting for its answer. A newer load would drop that answer, so a load slower than the watch would never land.
  const patchWaiting = useRef(0);
  // The latest list a watch brought while a load was waiting, loaded once that load lands if the list changed meanwhile.
  const patchAgain = useRef<ListedFile[] | null>(null);
  const bulkRef = useRef(true);
  const filesKeyRef = useRef("");
  const sessionRef = useRef(session.id);
  sessionRef.current = session.id;
  const scopeRef = useRef(changeScope);
  scopeRef.current = changeScope;

  const restoreDock = useEffectEvent(() => {
    const place = dockPlaces.get(session.id);
    patchTicket.current += 1;
    filesKeyRef.current = "";
    bulkRef.current = true;
    setPlaceOf(session.id);
    setTab(restoredTab(place, Boolean(browser), terminalInDock, hasDevice));
    setSplit(place?.split ?? null);
    setChangeFiles([]);
    setPatches({});
    setChangeScope(place?.scope ?? "head");
    setActivePath(place?.change ?? "");
    setFocus(place?.change ? { path: place.change, nonce: Date.now() } : null);
    setDevice(place?.device ?? "");
    if (!place?.file) {
      fileTicket.current += 1;
      setView(null);
      return undefined;
    }
    return loadFile(place.file, true);
  });
  useEffect(() => restoreDock(), [session.id]);

  useEffect(() => {
    if (placeOf !== session.id) return;
    dockPlaces.save(session.id, {
      tab,
      split: split ?? undefined,
      scope: changeScope,
      change: typeof activePath === "string" ? activePath : undefined,
      file: view?.path,
      device: device || undefined,
    });
  }, [placeOf, session.id, tab, split, changeScope, activePath, view?.path, device]);

  // A split whose surface is gone, such as Browser in a plain browser, waits hidden until it comes back.
  const available: Record<DockTab, boolean> = {
    plan: hasPlan,
    changes: true,
    files: true,
    terminal: terminalInDock,
    browser: Boolean(browser),
    device: hasDevice,
    unity: unityAvailable,
  };
  const second = !phone && split && split.tab !== tab && available[split.tab] ? split : null;
  const layout: DockLayout = { tab, split: second };

  useEffect(() => {
    if (placeOf === session.id) onTabsRef.current?.(second?.tab ? [tab, second.tab] : [tab]);
  }, [placeOf, session.id, tab, second?.tab]);

  function showTab(next: DockTab) {
    if (next === second?.tab) return;
    // A phone hides the split, so picking its surface swaps it with the shown one and the split returns on a wider screen.
    if (split && next === split.tab && next !== tab) setSplit({ ...split, tab });
    setTab(next);
  }

  // With the rail inside the dock, as on a phone, the shown tab's icon leaves the dock open.
  function pickFromRail(next: DockTab) {
    const shown = next === tab || next === second?.tab;
    if (!open) onOpen?.();
    else if (railHost && shown && second) return arrange(closePane(layout, next === tab ? 0 : 1));
    else if (railHost && shown) return onClose();
    showTab(next);
  }

  function arrange(next: DockLayout) {
    setTab(next.tab);
    setSplit(next.split);
    setDrag(null);
    setZone(null);
  }

  // Only requests made while the dock is mounted act, so a remount keeps the restored state.
  const openTab = useEffectEvent(showTab);
  const seenReview = useRef(reviewNonce);
  useEffect(() => {
    if (reviewNonce === seenReview.current) return;
    seenReview.current = reviewNonce;
    openTab("changes");
    if (second?.tab === "files" || (tab === "files" && second?.tab === "changes")) return;
    fileTicket.current += 1;
    setView(null);
  }, [reviewNonce, tab, second?.tab]);

  // The terminal moved under the desk: the dock leaves its Terminal tab.
  useEffect(() => {
    if (!terminalInDock) setTab((current) => (current === "terminal" ? "changes" : current));
  }, [terminalInDock]);

  const seenTerminal = useRef(terminalNonce);
  useEffect(() => {
    if (terminalNonce === seenTerminal.current) return;
    seenTerminal.current = terminalNonce;
    openTab("terminal");
  }, [terminalNonce]);

  // A page opened in a new tab of this chat: the Browser tab comes up.
  const browserFocus = browser?.focus.count ?? 0;
  const seenFocus = useRef(browserFocus);
  useEffect(() => {
    if (browserFocus === seenFocus.current) return;
    seenFocus.current = browserFocus;
    if (browser?.focus.owner === session.id) openTab("browser");
  }, [browserFocus, browser?.focus.owner, session.id]);

  // An app an agent launched in this chat, or a launched app's card: the Device tab comes up on its device.
  const deviceCount = deviceFocus?.count ?? 0;
  const seenDevice = useRef(deviceCount);
  useEffect(() => {
    if (deviceCount === seenDevice.current) return;
    seenDevice.current = deviceCount;
    if (deviceFocus?.owner !== session.id || !hasDevice) return;
    if (deviceFocus.device) setDevice(deviceFocus.device);
    openTab("device");
  }, [deviceCount, deviceFocus?.owner, deviceFocus?.device, hasDevice, session.id]);

  useEffect(() => {
    if (!hasPlan) setTab((current) => (current === "plan" ? "changes" : current));
  }, [session.id, hasPlan]);

  // A plan the agent starts writing while this session is in view opens the Plan tab, so it fills as it is
  // written. A session switched to, or reloaded, keeps the tab the person had (see planTab.ts).
  const planMemory = useRef(planTabMemory());
  useEffect(() => {
    if (planOpensTab(planMemory.current, session.id, planDoc?.id ?? null, running.current)) openTab("plan");
  }, [session.id, planDoc?.id]);

  const seenFile = useRef(openedFile?.nonce);
  const openRequestedFile = useEffectEvent(() => {
    if (!openedFile || openedFile.nonce === seenFile.current) return undefined;
    seenFile.current = openedFile.nonce;
    if (openedFile.sessionId !== session.id || !openedFile.path) return undefined;
    showTab("files");
    return loadFile(openedFile.path, false);
  });
  useEffect(() => openRequestedFile(), [openedFile?.nonce, openedFile?.path, openedFile?.sessionId]);

  // Shows a file in Files and reads it. A restored file that no longer reads is closed quietly.
  // Returns the effect cleanup that drops a late answer.
  function loadFile(target: string, restored: boolean): () => void {
    const ticket = ++fileTicket.current;
    const title = fileName(target);
    let cancel = false;
    setView(presentFile(title, "", target));
    if (!imageExtension(target)) {
      bound("/api/file", { path: target }, undefined, { silent: restored })
        .then((data) => {
          if (cancel || ticket !== fileTicket.current) return;
          setView(presentFile(title, fileContent(data), target));
        })
        .catch((error: unknown) => {
          if (cancel || ticket !== fileTicket.current) return;
          setView(restored ? null : { kind: "file", title, text: "", error: errorMessage(error) || "Couldn't read the file" });
        });
    }
    return () => {
      cancel = true;
    };
  }

  function bound(path: string, body: Record<string, unknown>, method?: string, options?: CallOptions): Promise<unknown> {
    return call(path, { sessionId: session.id, ...body }, method, options);
  }
  const diffCall = useStableCallback(bound);

  function chooseScope(next: ChangeScope) {
    patchTicket.current += 1;
    filesKeyRef.current = "";
    setChangeFiles([]);
    setPatches({});
    setChangeScope(next);
  }

  function onReviewFiles(files: ListedFile[], root: string) {
    setReviewRoot(root);
    const list = Array.isArray(files) ? files : [];
    const full = list.map((file) => `${file.path}\0${file.additions || 0}\0${file.deletions || 0}`).join("\n");
    if (full !== filesKeyRef.current) {
      filesKeyRef.current = full;
      setChangeFiles(list);
    }
    if (list.length) loadPatches(list);
    else setPatches((current) => (Object.keys(current).length ? {} : current));
  }

  async function loadPatches(files: ListedFile[]) {
    if (patchWaiting.current && patchWaiting.current === patchTicket.current) {
      patchAgain.current = files;
      return;
    }
    const ticket = ++patchTicket.current;
    const filesKey = filesKeyRef.current;
    patchWaiting.current = ticket;
    patchAgain.current = null;
    const sessionId = sessionRef.current;
    const base = scopeRef.current;
    const paths = files.map((file) => file.path).filter(Boolean);
    try {
      const rows = await reviewPatches({
        bulk: bulkRef.current
          ? async (wanted: unknown[]) => {
            const response = await apiFetch("/api/git/diffs", {
              method: "POST",
              headers: { "content-type": "application/json" },
              body: JSON.stringify({ sessionId, paths: wanted, base }),
            });
            if (response.status === 404) {
              bulkRef.current = false;
              return null;
            }
            if (!response.ok) throw new Error("Diffs failed");
            const data: unknown = await response.json();
            return patchRows(data);
          }
          : null,
        one: async (path: unknown) => {
          const data = await call("/api/git/diff", { sessionId, path, base });
          return patchText(data);
        },
      }, paths);
      if (ticket !== patchTicket.current || sessionRef.current !== sessionId) return;
      const filled = paths.map((path) => ({ path, patch: rows.find((row): row is Record<string, unknown> => isRecord(row) && row.path === path)?.patch || "" }));
      setPatches((current) => (samePatches(current, filled) ? current : patchRecord(filled)));
    } catch {
      // Keep the diffs already on screen. The next watch tries again.
    } finally {
      if (patchWaiting.current === ticket) {
        const again = patchAgain.current;
        patchWaiting.current = 0;
        patchAgain.current = null;
        if (again && ticket === patchTicket.current && filesKeyRef.current !== filesKey) void loadPatches(again);
      }
    }
  }

  function selectChange(file: ListedFile) {
    if (!file?.path) return;
    setActivePath(file.path);
    setFocus({ path: file.path, nonce: Date.now() });
  }

  async function openFile(node: FileNode) {
    if (node.type === "directory") return;
    const ticket = ++fileTicket.current;
    showTab("files");
    if (imageExtension(node.path)) {
      setView(presentFile(node.name, "", node.path));
      return;
    }
    try {
      const data = await bound("/api/file", { path: node.path });
      if (ticket !== fileTicket.current) return;
      setView(presentFile(node.name, fileContent(data), node.path));
    } catch (error: unknown) {
      if (ticket !== fileTicket.current) return;
      setView({ kind: "file", title: node.name, text: "", error: errorMessage(error) || "Couldn't read the file" });
    }
  }

  useEffect(() => {
    try {
      localStorage.setItem(LIST_RATIO_KEY, String(listRatio));
    } catch {
      // The split still holds for this visit.
    }
  }, [listRatio]);

  function trackRatio(event: React.PointerEvent<HTMLDivElement>, sideways: boolean, onRatio: (ratio: number) => void, onDragging: (dragging: boolean) => void) {
    event.preventDefault();
    const box = event.currentTarget.parentElement;
    if (!box) return;
    onDragging(true);
    try {
      event.currentTarget.setPointerCapture(event.pointerId);
    } catch {
      // Window listeners still track the drag.
    }
    function move(ev: PointerEvent) {
      const bounds = box!.getBoundingClientRect();
      const size = sideways ? bounds.width : bounds.height;
      if (!size) return;
      onRatio((sideways ? ev.clientX - bounds.left : ev.clientY - bounds.top) / size);
    }
    function stop() {
      onDragging(false);
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", stop);
    }
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", stop);
  }

  function onSplitKey(event: React.KeyboardEvent<HTMLDivElement>) {
    if (event.key === "ArrowUp") {
      event.preventDefault();
      setListRatio((ratio) => clampRatio(ratio - 0.04));
    } else if (event.key === "ArrowDown") {
      event.preventDefault();
      setListRatio((ratio) => clampRatio(ratio + 0.04));
    } else if (event.key === "Home") {
      event.preventDefault();
      setListRatio(LIST_RATIO_MIN);
    } else if (event.key === "End") {
      event.preventDefault();
      setListRatio(LIST_RATIO_MAX);
    }
  }

  function onPaneKey(event: React.KeyboardEvent<HTMLDivElement>) {
    const step = PANE_STEPS[event.key];
    if (!step) return;
    event.preventDefault();
    setSplit((current) => current && { ...current, ratio: paneRatio(current.ratio + step) });
  }

  // The cover over the panes catches the drop, and hides the Browser and Unity views, which draw over the page.
  function startDrag(event: React.DragEvent<HTMLElement>, dragged: DockTab, pane?: 0 | 1) {
    event.dataTransfer?.setData("application/x-dock-tab", dragged);
    if (event.dataTransfer) event.dataTransfer.effectAllowed = "move";
    // Chrome ends a drag whose dragstart changes the page under the pointer.
    setTimeout(() => setDrag({ tab: dragged, pane }));
  }

  function endDrag() {
    setDrag(null);
    setZone(null);
  }

  function dragOver(event: React.DragEvent<HTMLDivElement>) {
    if (!drag) return;
    event.preventDefault();
    const box = event.currentTarget.getBoundingClientRect();
    if (!box.width || !box.height) return;
    const next = dropZone(layout, (event.clientX - box.left) / box.width, (event.clientY - box.top) / box.height, box.width >= WIDE_DOCK);
    setZone((current) => (current?.pane === next.pane && current.edge === next.edge ? current : next));
  }

  const sideways = second ? second.edge === "left" || second.edge === "right" : false;

  function pane(shown: DockTab, index: 0 | 1, leading: boolean) {
    // A chat whose folder is gone has no folder for these tabs to read.
    const folderGone = session.folderGone && (shown === "changes" || shown === "files" || shown === "terminal") ? session.folderGone : null;
    const changesOpen = !folderGone && shown === "changes" && changeFiles.length > 0;
    const fileOpen = !folderGone && Boolean(view) && shown === "files";
    const showView = changesOpen || fileOpen;
    return (
      <div key={index} className="dock-pane" style={second && leading ? { flex: `0 0 ${Math.round(second.ratio * 1000) / 10}%` } : undefined}>
        {second ? (
          <DockHead
            tab={shown}
            closeLabel={`Close ${TAB_NAMES[shown]}`}
            onClose={() => arrange(closePane(layout, index))}
            onDragStart={(event) => startDrag(event, shown, index)}
            onDragEnd={endDrag}
            toolsRef={shown === "changes" ? setChangesSlot : undefined}
          />
        ) : (
          <DockHead tab={shown} closeLabel="Close review" onClose={onClose} toolsRef={shown === "changes" ? setChangesSlot : undefined} />
        )}
        <div
          className={showView ? (splitDrag ? "dock-body has-view is-dragging" : "dock-body has-view") : "dock-body"}
          style={showView ? { "--dock-list": `${Math.round(listRatio * 1000) / 10}%` } : undefined}
        >
          {shown === "unity" ? <UnityView visible={open} cwd={session.cwd} /> : null}
          {shown === "device" && hasDevice ? <DeviceView call={call} active={open} device={device} onDevice={setDevice} /> : null}
          {folderGone ? (
            <div className="dock-gone" data-testid="dock-gone">
              <p>{folderGone.home ? "This worktree was removed." : "This chat's folder is gone."}</p>
              <p className="dock-gone-path">{folderGone.path}</p>
              <p>Continue the chat in a folder to see its {shown === "terminal" ? "terminal" : shown === "files" ? "files" : "changes"} here.</p>
            </div>
          ) : null}
          {!folderGone && shown === "terminal" && terminalInDock && placeOf === session.id ? (
            <TerminalTab
              sessionId={session.id}
              cwd={session.cwd}
              shells={shells}
              shellId={shell}
              onShell={setShell}
              call={(path, body) => bound(path, body)}
              active={open}
              onMove={onMoveTerminal}
              onLink={(event, uri) => openTerminalLink(event, uri, session.id, Boolean(browser?.available))}
            />
          ) : null}
          {shown === "browser" && browser ? <BrowserView browser={browser} sessionId={session.id} agent={agent} visible={open} /> : null}
          {shown === "plan" ? <PlanOverview doc={session.pendingPlan?.plan || planPermission?.plan || planDoc?.text || ""} steps={steps} writing={session.status === "running"} /> : null}
          {folderGone || shown === "plan" || shown === "device" || shown === "browser" || shown === "terminal" || shown === "unity" ? null : (
          <div className="dock-list">
            {shown === "changes" ? (
              <GitChanges
                session={session}
                call={bound}
                onStack={onReviewFiles}
                onSelect={selectChange}
                activePath={activePath}
                watch={open}
                reviewNonce={reviewNonce}
                scope={changeScope}
                onScope={chooseScope}
                headSlot={changesSlot}
              />
            ) : null}
            {shown === "files" ? <FileTree session={session} call={bound} onPick={openFile} picked={view?.path} /> : null}
          </div>
          )}
          {showView ? (
            <div
              className="dock-split"
              role="separator"
              aria-orientation="horizontal"
              aria-label="Resize preview"
              aria-valuemin={Math.round((1 - LIST_RATIO_MAX) * 100)}
              aria-valuemax={Math.round((1 - LIST_RATIO_MIN) * 100)}
              aria-valuenow={Math.round((1 - listRatio) * 100)}
              tabIndex={0}
              onPointerDown={(event) => trackRatio(event, false, (ratio) => setListRatio(clampRatio(ratio)), setSplitDrag)}
              onKeyDown={onSplitKey}
              onDoubleClick={() => setListRatio(0.38)}
            />
          ) : null}
          {changesOpen ? (
            <DiffStack
              files={changeFiles}
              patches={patches}
              focus={focus}
              resetNonce={reviewNonce}
              onActive={setActivePath}
              sessionId={session.id}
              base={changeScope}
              call={diffCall}
              root={reviewRoot || session.cwd}
            />
          ) : null}
          {fileOpen && view ? (
            <div className="dock-view" data-testid="dock-view">
              <p className="dock-title">
                <FileIcon />
                <span className="dock-title-name">{view.path?.startsWith(`${session.cwd}/`) ? view.path.slice(session.cwd.length + 1) : (view.title as ReactNode)}</span>
                {view.kind === "markdown" && !view.error ? <MarkdownToggle off="Source" preview={filePreview} onChange={setFilePreview} /> : null}
              </p>
              {view.error ? (
                <p className="dock-empty">{view.error}</p>
              ) : view.kind === "markdown" && filePreview ? (
                <MarkdownView className="plan-doc" text={view.text} imageSrc={viewImageSrc} />
              ) : view.kind === "image" ? (
                <FileImage sessionId={session.id} filePath={view.path} title={view.title} />
              ) : (
                <pre className="file-text">
                  {view.text.replace(/\n$/, "").split("\n").map((line, index) => (
                    <span key={index} className="file-line">
                      <i>{index + 1}</i>
                      {line}
                    </span>
                  ))}
                </pre>
              )}
            </div>
          ) : null}
        </div>
      </div>
    );
  }

  const splitLeads = second?.edge === "top" || second?.edge === "left";
  const panesClass = ["dock-panes", sideways ? "is-sideways" : "", paneDrag ? "is-resizing" : ""].filter(Boolean).join(" ");
  const rail = (
    <DockRail
      tab={tab}
      split={second?.tab}
      open={open}
      onPick={pickFromRail}
      tip={tip}
      hasPlan={hasPlan}
      terminalInDock={terminalInDock}
      running={shells.some((item) => item.running)}
      browser={Boolean(browser)}
      hasDevice={hasDevice}
      onDragTab={phone ? undefined : startDrag}
      onDragEnd={endDrag}
      onPaneDrop={drag?.pane === undefined ? undefined : () => arrange(closePane(layout, drag.pane!))}
    />
  );
  return (
    <aside className={second ? "dock is-split" : "dock"} data-testid="dock">
      {railHost ? createPortal(rail, railHost) : rail}
      <div className={panesClass} data-testid="dock-panes">
        {second && splitLeads ? pane(second.tab, 1, true) : pane(tab, 0, true)}
        {second ? (
          <div
            key="split"
            className="dock-split"
            role="separator"
            aria-orientation={sideways ? "vertical" : "horizontal"}
            aria-label="Resize panes"
            aria-valuemin={20}
            aria-valuemax={80}
            aria-valuenow={Math.round(second.ratio * 100)}
            tabIndex={0}
            onPointerDown={(event) => trackRatio(event, sideways, (ratio) => setSplit((current) => current && { ...current, ratio: paneRatio(ratio) }), setPaneDrag)}
            onKeyDown={onPaneKey}
            onDoubleClick={() => setSplit((current) => current && { ...current, ratio: 0.5 })}
          />
        ) : null}
        {second ? (splitLeads ? pane(tab, 0, false) : pane(second.tab, 1, false)) : null}
        {drag || paneDrag ? (
          <div
            className="dock-drop"
            data-testid="dock-drop"
            onDragEnter={dragOver}
            onDragOver={dragOver}
            onDragLeave={() => setZone(null)}
            // A drag whose source went away mid-drag sends no dragend, which would leave the cover up.
            onPointerDown={endDrag}
            onDrop={(event) => {
              event.preventDefault();
              if (drag && zone) arrange(dropTab(layout, drag.tab, zone));
              else endDrag();
            }}
          >
            {zone ? <div className="dock-drop-zone" style={{ inset: zoneInset(layout, zone) }} /> : null}
          </div>
        ) : null}
      </div>
    </aside>
  );
}

const TAB_NAMES: Record<DockTab, string> = {
  plan: "Plan",
  changes: "Changes",
  files: "Files",
  terminal: "Terminal",
  browser: "Browser",
  device: "Device",
  unity: "Unity",
};

const TAB_ICONS: Record<DockTab, ReactNode> = {
  plan: (
    <>
      <path d="M6.7 4.3h6.3M6.7 8h6.3M6.7 11.7h6.3M2.7 4.3l.8.8L5 3.6M2.7 8l.8.8L5 7.3" />
      <circle cx="3.8" cy="11.7" r=".7" />
    </>
  ),
  changes: <path d="M9.3 2.3H4.7A1.7 1.7 0 0 0 3 4v8a1.7 1.7 0 0 0 1.7 1.7h6.6a1.7 1.7 0 0 0 1.7-1.7V6zM8 5.3V9M6.1 7.1h3.8M6.1 11h3.8" />,
  files: <path d="M2.5 4.5v8h11V6H8L6.5 4.5z" />,
  terminal: (
    <>
      <rect x="2" y="3" width="12" height="10" rx="2.3" />
      <path d="M4.7 6.3l2 1.7-2 1.7M8.3 10h3" />
    </>
  ),
  browser: (
    <>
      <circle cx="8" cy="8" r="5.5" />
      <path d="M2.5 8h11M8 2.5c2 2 2 9 0 11M8 2.5c-2 2-2 9 0 11" />
    </>
  ),
  device: <path d="M6.1 2h3.8c.9 0 1.6.7 1.6 1.6v8.8c0 .9-.7 1.6-1.6 1.6H6.1c-.9 0-1.6-.7-1.6-1.6V3.6c0-.9.7-1.6 1.6-1.6zM7 12h2" />,
  unity: <path d="M8 2l5.2 3v6L8 14l-5.2-3V5zM8 8v6M8 8l5.2-3M8 8L2.8 5" />,
};

function TabIcon({ id }: { id: DockTab }) {
  return (
    <svg width="18" height="18" viewBox="0 0 16 16" aria-hidden="true" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round">
      {TAB_ICONS[id]}
    </svg>
  );
}

interface DockHeadProps {
  tab: DockTab;
  closeLabel: string;
  onClose: () => void;
  onDragStart?: (event: React.DragEvent<HTMLElement>) => void;
  onDragEnd?: () => void;
  // Receives the slot the pane renders its own controls into.
  toolsRef?: (node: HTMLElement | null) => void;
}

function DockHead({ tab, closeLabel, onClose, onDragStart, onDragEnd, toolsRef }: DockHeadProps) {
  return (
    <header className="dock-head" draggable={onDragStart ? true : undefined} onDragStart={onDragStart} onDragEnd={onDragEnd}>
      <h2 className="dock-heading">
        {tab === "changes" ? null : <TabIcon id={tab} />}
        {TAB_NAMES[tab]}
      </h2>
      {toolsRef ? <div className="dock-tools" ref={toolsRef} /> : null}
      <button type="button" className="icon" aria-label={closeLabel} onClick={onClose}>
        <CloseIcon />
      </button>
    </header>
  );
}

interface RailProps {
  tab?: DockTab;
  // False while the dock is closed, which leaves no tab picked.
  open?: boolean;
  // The second pane's surface.
  split?: DockTab;
  onPick: (tab: DockTab) => void;
  tip: ReturnType<typeof railTipBridge>;
  hasPlan: boolean;
  terminalInDock: boolean;
  running: boolean;
  browser: boolean;
  hasDevice: boolean;
  onDragTab?: (event: React.DragEvent<HTMLElement>, tab: DockTab) => void;
  onDragEnd?: () => void;
  // Set while a pane's title is dragged, which closes the pane when dropped on the rail.
  onPaneDrop?: () => void;
  disabled?: boolean;
}

// The icon rail, shared by the dock and its loading state.
function DockRail({ tab, split, open = true, onPick, tip, hasPlan, terminalInDock, running, browser, hasDevice, onDragTab, onDragEnd, onPaneDrop, disabled = false }: RailProps) {
  const rail = open ? { tab, split, onPick, tip, onDragTab, onDragEnd, disabled } : { onPick, tip, disabled };
  const railRef = useRef<HTMLElement>(null);
  useThumb(railRef, "y", tab ? `[data-tab="${tab}"]` : null, open);
  return (
    <nav
      ref={railRef}
      className={["dock-rail", onPaneDrop ? "is-drop" : "", tip ? "" : "has-labels"].filter(Boolean).join(" ")}
      role="tablist"
      aria-orientation="vertical"
      aria-multiselectable={split ? true : undefined}
      onDragOver={onPaneDrop ? (event) => event.preventDefault() : undefined}
      onDrop={
        onPaneDrop
          ? (event) => {
            event.preventDefault();
            onPaneDrop();
          }
          : undefined
      }
    >
      {hasPlan ? <RailTab id="plan" {...rail} /> : null}
      <RailTab id="changes" {...rail} />
      <RailTab id="files" {...rail} />
      {terminalInDock ? (
        <>
          <span className="dock-rail-gap" aria-hidden="true" />
          <RailTab id="terminal" {...rail}>
            {running ? <span className="terminal-running" aria-label="A command is running" /> : null}
          </RailTab>
        </>
      ) : null}
      {browser || hasDevice || unityAvailable ? <span className="dock-rail-gap" aria-hidden="true" /> : null}
      {browser ? <RailTab id="browser" {...rail} /> : null}
      {hasDevice ? <RailTab id="device" {...rail} /> : null}
      {unityAvailable ? <RailTab id="unity" {...rail} /> : null}
      <span className="dock-rail-thumb" data-thumb aria-hidden="true" />
    </nav>
  );
}

// The dock while its chat loads: the head and rail on the tab the chat will open on.
// A tab picked meanwhile is saved, so the dock opens on it.
export function DockLoading({ sessionId, onClose, onOpen, open = true, railHost = null, browser, terminalInDock, running }: Pick<DockProps, "onClose" | "onOpen" | "open" | "railHost"> & { sessionId: string; browser: boolean; terminalInDock: boolean; running: boolean }) {
  const hasDevice = !remotePage();
  const [tab, setTab] = useState(() => restoredTab(dockPlaces.get(sessionId), browser, terminalInDock, hasDevice));
  const [tip] = useState(railTipBridge);
  const split = dockPlaces.get(sessionId)?.split?.tab;
  function pick(next: DockTab) {
    if (!open) onOpen?.();
    else if (railHost && next === tab) return onClose();
    dockPlaces.save(sessionId, { tab: next });
    setTab(next);
  }
  const rail = (
    <DockRail
      tab={tab}
      split={split === tab ? undefined : split}
      open={open}
      onPick={pick}
      tip={tip}
      hasPlan={false}
      terminalInDock={terminalInDock}
      running={running}
      browser={browser}
      hasDevice={hasDevice}
    />
  );
  return (
    <aside className="dock" aria-busy="true">
      <DockHead tab={tab} closeLabel="Close review" onClose={onClose} />
      {railHost ? createPortal(rail, railHost) : rail}
      <div className="dock-body" />
    </aside>
  );
}

// The rail while Builder shows no chat: the tabs a new chat would have, greyed out.
export function IdleRail({ browser, terminalInDock }: { browser: boolean; terminalInDock: boolean }) {
  const [tip] = useState(railTipBridge);
  return <DockRail onPick={() => {}} tip={tip} hasPlan={false} terminalInDock={terminalInDock} running={false} browser={browser} hasDevice={!remotePage()} disabled />;
}

// The desktop app draws the hover label in its own window, since the native Browser and Unity views cover the page; a plain browser shows the tab's label beside the rail.
interface RailTabProps extends Pick<RailProps, "split" | "onPick" | "tip" | "onDragTab" | "onDragEnd" | "disabled"> {
  id: DockTab;
  tab?: DockTab;
  children?: ReactNode;
}

function RailTab({ id, tab, split, onPick, tip, onDragTab, onDragEnd, disabled = false, children }: RailTabProps) {
  const selected = tab === id || split === id;
  const label = disabled ? `Open a chat to use ${TAB_NAMES[id]}` : TAB_NAMES[id];
  // An icon that goes away under the pointer fires no pointerleave, so its label would stay up.
  useEffect(
    () => () => {
      if (tip) hideRailTip(tip, true);
    },
    [tip],
  );
  return (
    <button
      type="button"
      role="tab"
      aria-selected={selected}
      data-tab={id}
      className={selected ? "active" : ""}
      aria-disabled={disabled || undefined}
      draggable={Boolean(onDragTab)}
      onDragStart={(event) => {
        if (tip) hideRailTip(tip, true);
        onDragTab?.(event, id);
      }}
      onDragEnd={onDragEnd}
      onClick={() => {
        if (tip) hideRailTip(tip, true);
        if (!disabled) onPick(id);
      }}
      title={tip || !disabled ? undefined : label}
      onPointerEnter={(event) => {
        if (tip) showRailTip(tip, event.currentTarget, label);
      }}
      onPointerLeave={() => {
        if (tip) hideRailTip(tip);
      }}
    >
      <TabIcon id={id} />
      <span className="dock-rail-label">{TAB_NAMES[id]}</span>
      {children}
    </button>
  );
}

// The plan and its steps: one waiting for approval, or the plan document the agent writes.
function PlanOverview({ doc, steps, writing }: { doc: string; steps: PlanEntry[]; writing: boolean }) {
  return (
    <section className="dock-plan" data-testid="plan-overview">
      {doc ? <MarkdownView className="plan-doc" text={doc} /> : null}
      <PlanSteps steps={steps} />
      {!doc && !steps.length ? <p className="dock-empty">{writing ? "The plan is being written." : "No plan yet."}</p> : null}
    </section>
  );
}


function presentFile(title: unknown, text: string, filePath: string): FileView {
  if (imageExtension(filePath || title)) return { kind: "image", title, path: filePath, text: "" };
  return { kind: isMarkdownPath(String(filePath || title || "")) ? "markdown" : "file", title, text, path: filePath };
}

function FileImage({ sessionId, filePath, title }: { sessionId: string; filePath: string | undefined; title: unknown }) {
  const src = imageSrc(sessionId, filePath, "after", undefined);
  const [failed, setFailed] = useState(false);
  const [open, setOpen] = useState(false);
  if (failed) return <p className="dock-empty">Couldn't preview this picture</p>;
  return (
    <div className="diff-images" data-testid="file-image">
      <figure className="diff-image">
        <button type="button" className="diff-image-link" aria-label={`Open ${title}`} onClick={() => setOpen(true)}>
          <img src={src} alt={title as string | undefined} onError={() => setFailed(true)} />
        </button>
      </figure>
      {open
        ? createPortal(
            <ShotLightbox srcs={[src]} index={0} onIndex={() => {}} onClose={() => setOpen(false)} />,
            document.body,
          )
        : null}
    </div>
  );
}

function fileName(file: unknown): string {
  const parts = String(file || "").split(/[/\\]/).filter(Boolean);
  return parts.at(-1) || "File";
}

function CloseIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 16 16" aria-hidden="true">
      <path d="M4 4.2 12 12.2M12 4.2 4 12.2" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
    </svg>
  );
}
