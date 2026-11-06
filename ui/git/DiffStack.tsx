import { memo, useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { pathAtScroll } from "./diffFollow.ts";
import { imageExtension, imageRev, imageSides, imageSrc, patchParts, trackImageRev } from "./imageDiff.ts";
import { ShotLightbox } from "../chat/messages/ShotLightbox.tsx";
import { MarkdownView } from "../chat/markdown/MarkdownView.tsx";
import { isMarkdownPath } from "../chat/markdown/markdown.ts";
import { patchText } from "./GitChanges.tsx";
import { diffLines } from "./diffLines.ts";
import { markdownChunks, markdownImageSrc } from "./markdownDiff.ts";
import { MarkdownToggle, useMarkdownPreview } from "./MarkdownToggle.tsx";
import type { ReactNode } from "react";
import type { ScrollSection } from "./diffFollow.ts";
import type { ChangeScope, ListedFile } from "./GitChanges.tsx";
import type { CallOptions } from "../launchToken.ts";

type DiffCall = (path: string, body: Record<string, unknown>, method?: string, options?: CallOptions) => Promise<unknown>;

// Paths are ListedFile paths, which git forwards unchecked.
export interface DiffFocus {
  path: unknown;
  nonce: number;
}

export interface DiffStackProps {
  files: ListedFile[];
  patches: Record<string, string>;
  focus: DiffFocus | null;
  resetNonce?: number;
  onActive?: (path: unknown) => void;
  sessionId?: string;
  base?: ChangeScope;
  // Keep it stable: the stack is memoised.
  call?: DiffCall;
  root?: string;
}

type LoadState = "off" | "loading" | "ready" | "error";

interface LoadPhase {
  before: LoadState;
  after: LoadState;
}

type ImageSide = "before" | "after";

// Memoised: the dock re-renders with every streamed chunk, and its props only change with the review.
export const DiffStack = memo(function DiffStack({ files, patches, focus, resetNonce = 0, onActive, sessionId = "", base = "head", call, root = "" }: DiffStackProps) {
  const [preview, setPreview] = useMarkdownPreview("x-bench-diff-preview", false);
  const scrollerRef = useRef<HTMLDivElement | null>(null);
  const activeRef = useRef<unknown>(files[0]?.path || "");
  const filesRef = useRef(files);
  const onActiveRef = useRef(onActive);
  const [activePath, setActivePath] = useState<unknown>(activeRef.current);
  // The files whose rows are built: each one once it comes within a screen of the view. Built rows stay, so the scroll keeps its place.
  const [near, setNear] = useState<ReadonlySet<string>>(() => new Set());
  filesRef.current = files;
  onActiveRef.current = onActive;
  const fileKey = files.map((file) => file.path).join("\n");

  useLayoutEffect(() => {
    const scroller = scrollerRef.current;
    if (!files.length) {
      activeRef.current = "";
      setActivePath("");
      onActiveRef.current?.("");
      return;
    }
    const known = files.some((file) => file.path === activeRef.current);
    const atScroll = scroller ? pathAtScroll(scroller.scrollTop, measure(scroller)) : "";
    const next = known ? activeRef.current : files.some((file) => file.path === atScroll) ? atScroll : files[0]?.path ?? "";
    if (next !== activeRef.current) {
      activeRef.current = next;
      setActivePath(next);
    }
    if (next) onActiveRef.current?.(next);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- fileKey stands for the file paths
  }, [fileKey]);

  useLayoutEffect(() => {
    if (!resetNonce) return;
    const scroller = scrollerRef.current;
    if (scroller) scroller.scrollTop = 0;
    const first = filesRef.current[0]?.path || "";
    if (!first) return;
    activeRef.current = first;
    setActivePath(first);
    onActiveRef.current?.(first);
  }, [resetNonce]);

  useLayoutEffect(() => {
    if (!focus?.nonce || !focus.path) return undefined;
    const scroller = scrollerRef.current;
    const section = sectionNode(scroller, focus.path);
    if (!scroller || !section) return undefined;
    scroller.scrollTop = section.offsetTop;
    // The patches around the file get built and take their real height a few frames later, which moves it, so it is held at the top.
    let frames = 0;
    let frame = requestAnimationFrame(function hold() {
      if (scroller.scrollTop !== section.offsetTop) scroller.scrollTop = section.offsetTop;
      if (++frames < 12) frame = requestAnimationFrame(hold);
    });
    const release = () => cancelAnimationFrame(frame);
    const inputs = ["wheel", "touchstart", "keydown", "pointerdown"];
    for (const input of inputs) scroller.addEventListener(input, release, { passive: true });
    if (focus.path !== activeRef.current) {
      activeRef.current = focus.path;
      setActivePath(focus.path);
      onActiveRef.current?.(focus.path);
    }
    return () => {
      release();
      for (const input of inputs) scroller.removeEventListener(input, release);
    };
  }, [focus?.nonce, focus?.path]);

  useEffect(() => {
    const scroller = scrollerRef.current;
    if (!scroller) return undefined;
    const listed = new Set(filesRef.current.map((file) => String(file.path)));
    setNear((current) => ([...current].every((path) => listed.has(path)) ? current : new Set([...current].filter((path) => listed.has(path)))));
    const observer = new IntersectionObserver((entries) => {
      const shown = entries.filter((entry) => entry.isIntersecting).map((entry) => entry.target.getAttribute("data-diff-path") || "");
      setNear((current) => (shown.every((path) => current.has(path)) ? current : new Set([...current, ...shown])));
    }, { root: scroller, rootMargin: "100% 0px" });
    for (const section of scroller.querySelectorAll("[data-diff-path]")) observer.observe(section);
    return () => observer.disconnect();
  }, [fileKey]);

  useEffect(() => {
    const scroller = scrollerRef.current;
    if (!scroller) return undefined;
    let frame = 0;
    function onScroll() {
      if (frame) return;
      frame = requestAnimationFrame(() => {
        frame = 0;
        const path = pathAtScroll(scroller!.scrollTop, measure(scroller!));
        if (!path || path === activeRef.current) return;
        activeRef.current = path;
        setActivePath(path);
        onActiveRef.current?.(path);
      });
    }
    scroller.addEventListener("scroll", onScroll, { passive: true });
    return () => {
      scroller.removeEventListener("scroll", onScroll);
      if (frame) cancelAnimationFrame(frame);
    };
  }, [fileKey]);

  return (
    <div className="dock-view diff-stack" data-testid="diff-stack">
      <div className="diff-scroll" ref={scrollerRef} data-testid="diff-scroll">
        {files.map((file) => (
          <section
            key={file.path as string}
            className={file.path === activePath ? "diff-file is-current" : "diff-file"}
            data-diff-path={file.path}
            data-testid="diff-file"
          >
            <h3 className="diff-file-title">
              <FileTitle file={file} />
              {call && isMarkdownPath(String(file.path)) ? <MarkdownToggle off="Diff" preview={preview} onChange={setPreview} /> : null}
            </h3>
            <div className="diff-file-body">
              {!near.has(String(file.path)) ? null : call && preview && isMarkdownPath(String(file.path)) ? (
                <MarkdownDiff file={file} patch={patches[String(file.path)]} base={base} call={call} sessionId={sessionId} root={root} />
              ) : (
                <DiffBody file={file} patch={patches[String(file.path)]} sessionId={sessionId} base={base} />
              )}
            </div>
          </section>
        ))}
      </div>
    </div>
  );
});

function FileTitle({ file }: { file: ListedFile }) {
  return (
    <>
      <span className="git-path">{file.path as ReactNode}</span>
      <span className="git-stat">
        {file.additions ? <span className="add">+{file.additions as ReactNode}</span> : null}
        {file.deletions ? <span className="del">−{file.deletions as ReactNode}</span> : null}
      </span>
    </>
  );
}

// Memoised: the stack re-renders whenever the current file changes, and redrawing every patch then stalls a large review.
const DiffBody = memo(function DiffBody({ file, patch, sessionId, base }: { file: ListedFile; patch: string | undefined; sessionId: string; base: ChangeScope }) {
  if (sessionId && imageExtension(file?.path)) return <ImageDiff file={file} patch={patch} sessionId={sessionId} base={base} />;
  return <PatchText text={patch} />;
});

interface MarkdownDiffProps {
  file: ListedFile;
  patch: string | undefined;
  base: ChangeScope;
  call: DiffCall;
  sessionId: string;
  root: string;
}

function MarkdownDiff({ file, patch, base, call, sessionId, root }: MarkdownDiffProps) {
  const [whole, setWhole] = useState<string | null>(null);
  const filePath = `${root}/${String(file.path)}`;
  const imageSrc = useCallback((href: string) => markdownImageSrc(sessionId, filePath, href), [sessionId, filePath]);
  useEffect(() => {
    let live = true;
    call("/api/git/diff", { path: file.path, base, whole: true }, undefined, { silent: true })
      .then((data) => live && setWhole(patchText(data)))
      .catch(() => live && setWhole(""));
    return () => {
      live = false;
    };
  }, [file.path, patch, base, call]);
  if (whole == null) return <p className="diff-wait">Loading preview…</p>;
  const chunks = markdownChunks(whole);
  if (!chunks.length) return <PatchText text={patch} />;
  return (
    <div className="plan-doc md-diff">
      {chunks.map((chunk, index) => (
        <div key={index} className="md-chunk" data-change={chunk.change}>
          <MarkdownView text={chunk.text} imageSrc={imageSrc} />
        </div>
      ))}
    </div>
  );
}

function loadPhase(beforeSrc: string, afterSrc: string): LoadPhase {
  return { before: beforeSrc ? "loading" : "off", after: afterSrc ? "loading" : "off" };
}

function ImageDiff({ file, patch, sessionId, base }: { file: ListedFile; patch: string | undefined; sessionId: string; base: ChangeScope }) {
  const sides = imageSides({ path: file.path, type: file.type }, patch);
  const rev = imageRev(patch);
  const [tracked, setTracked] = useState({ seen: "", shown: "" });
  const beforeSrc = sides?.before ? imageSrc(sessionId, file.path, "before", tracked.shown, base) : "";
  const afterSrc = sides?.after ? imageSrc(sessionId, file.path, "after", tracked.shown) : "";
  const sources = `${beforeSrc}\n${afterSrc}`;
  const [sourceKey, setSourceKey] = useState(sources);
  const [phase, setPhase] = useState(() => loadPhase(beforeSrc, afterSrc));
  if (sourceKey !== sources) {
    setSourceKey(sources);
    setPhase(loadPhase(beforeSrc, afterSrc));
  }

  useEffect(() => {
    setTracked((current) => trackImageRev(current, rev));
  }, [rev]);

  const pending = phase.before === "loading" || phase.after === "loading";
  const alive = phase.before === "ready" || phase.after === "ready";
  const [openSrc, setOpenSrc] = useState("");
  const slides = readySlides(beforeSrc, afterSrc, phase);
  const openIndex = slides.indexOf(openSrc);
  const parts = patchParts(patch);
  if (!pending && !alive) return <PatchText text={patch} />;

  function mark(side: ImageSide, next: LoadState) {
    setPhase((current) => (current[side] === next ? current : { ...current, [side]: next }));
  }

  return (
    <div data-testid="diff-image">
      {parts.header ? <PatchText text={parts.header} /> : null}
      {pending && !alive ? <p className="diff-wait">Loading preview…</p> : null}
      <div className="diff-images">
        {beforeSrc ? (
          <ImageFrame
            side="before"
            label={sides?.after ? "Before" : "Deleted"}
            alt={file.path}
            src={beforeSrc}
            onOpen={() => setOpenSrc(beforeSrc)}
            onReady={() => mark("before", "ready")}
            onError={() => mark("before", "error")}
          />
        ) : null}
        {afterSrc ? (
          <ImageFrame
            side="after"
            label={sides?.before ? "After" : ""}
            alt={file.path}
            src={afterSrc}
            onOpen={() => setOpenSrc(afterSrc)}
            onReady={() => mark("after", "ready")}
            onError={() => mark("after", "error")}
          />
        ) : null}
      </div>
      {parts.body ? <PatchText text={parts.body} /> : null}
      {openIndex >= 0
        ? createPortal(
            <ShotLightbox
              srcs={slides}
              index={openIndex}
              onIndex={(next) => setOpenSrc(slides[next] || "")}
              onClose={() => setOpenSrc("")}
            />,
            document.body,
          )
        : null}
    </div>
  );
}

function readySlides(beforeSrc: string, afterSrc: string, phase: LoadPhase): string[] {
  const slides: string[] = [];
  if (beforeSrc && phase.before === "ready") slides.push(beforeSrc);
  if (afterSrc && phase.after === "ready") slides.push(afterSrc);
  return slides;
}

interface ImageFrameProps {
  side: ImageSide;
  label: string;
  alt: unknown;
  src: string;
  onOpen: () => void;
  onReady: () => void;
  onError: () => void;
}

function ImageFrame({ side, label, alt, src, onOpen, onReady, onError }: ImageFrameProps) {
  const [shown, setShown] = useState(src);
  const [ready, setReady] = useState(false);
  if (shown !== src) {
    setShown(src);
    setReady(false);
  }
  return (
    <figure className="diff-image" data-side={side} hidden={!ready}>
      {label ? <figcaption>{label}</figcaption> : null}
      <button type="button" className="diff-image-link" aria-label={`Open ${alt}`} onClick={onOpen}>
        <img
          src={src}
          alt={alt as string}
          onLoad={() => {
            setReady(true);
            onReady();
          }}
          onError={onError}
        />
      </button>
    </figure>
  );
}

function PatchText({ text }: { text: string | null | undefined }) {
  if (text == null) return <p className="diff-wait">Loading diff…</p>;
  if (!text) return <p className="diff-wait">No patch</p>;
  const rows = diffLines(text);
  if (rows) {
    return (
      <pre className="diff-text">
        {rows.map((row, index) =>
          row.kind === "hunk" ? (
            <span key={index} className="diff-hunk">
              {row.text}
              {"\n"}
            </span>
          ) : (
            <span key={index} className={`diff-line ${row.kind}`}>
              <i>{row.number}</i>
              <i>{row.kind === "add" ? "+" : row.kind === "del" ? "−" : ""}</i>
              {row.text || " "}
              {"\n"}
            </span>
          ),
        )}
      </pre>
    );
  }
  return (
    <pre className="diff-text">
      {text.split("\n").map((line, index) => (
        <span key={index} className={lineClass(line)}>
          {line || " "}
          {"\n"}
        </span>
      ))}
    </pre>
  );
}

function measure(scroller: HTMLElement): ScrollSection[] {
  return [...scroller.querySelectorAll<HTMLElement>("[data-diff-path]")].map((node) => ({
    path: node.dataset.diffPath ?? "",
    top: node.offsetTop,
  }));
}

function sectionNode(scroller: HTMLElement | null, path: unknown): HTMLElement | null {
  if (!scroller || !path) return null;
  return [...scroller.querySelectorAll<HTMLElement>("[data-diff-path]")].find((node) => node.dataset.diffPath === path) || null;
}

function lineClass(line: string): string {
  if (line.startsWith("+") && !line.startsWith("+++")) return "add";
  if (line.startsWith("-") && !line.startsWith("---")) return "del";
  if (line.startsWith("@@") || line.startsWith("diff ") || line.startsWith("index ")) return "meta";
  return "";
}
