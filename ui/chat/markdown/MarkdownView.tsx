import { Fragment, memo, useEffect, useState } from "react";
import { createPortal } from "react-dom";
import { chatBoardHref, isShortTicketHref, localBoardTarget } from "../../../server/board/boardLink.ts";
import { TicketLink } from "../../board/TicketLink.tsx";
import { ShotLightbox } from "../messages/ShotLightbox.tsx";
import { skillParts } from "../composer/commands.ts";
import { CheckIcon, CopyIcon, SkillIcon } from "../../icons.tsx";
import { useCopy } from "../../useCopy.ts";
import { isDiagramLang, useDiagram } from "./diagram.ts";
import { parseInline, parseMarkdown, parseMathText } from "./markdown.ts";
import type { CellAlign, ListBlock, MarkdownBlock } from "./markdown.ts";
import { renderMath, useMathReady } from "./math.ts";

export interface MarkdownViewProps {
  text: string | null | undefined;
  className?: string;
  // Opens a linked file of this machine, in the review dock or Finder. Without it, a file link is plain text.
  onOpenFile?: (filePath: string) => void;
  // Where the page loads a picture the text shows inline (![alt](/tmp/shot.png)). Without it, or when it answers
  // null, the picture is its name.
  imageSrc?: (filePath: string) => string | null;
  // True for a picture whose address is still being looked up. It shimmers in the picture's place.
  imagePending?: (filePath: string) => boolean;
  // Where the page loads a video the text plays inline (![cut](/tmp/cut.mp4)). Without it, or when it answers
  // null, the video is its name.
  videoSrc?: (filePath: string) => string | null;
  // The commands the session's harness reported. Text that calls one shows it as a chip.
  skills?: readonly unknown[] | undefined;
  // The chat's folder, whose board a short ticket link ([#12](?task=12)) opens. Without it, the link is its text.
  cwd?: string;
}

// The ways a reply reaches this machine's files, passed down to every inline run.
interface Local {
  onOpenFile?: (filePath: string) => void;
  imageSrc?: (filePath: string) => string | null;
  imagePending?: (filePath: string) => boolean;
  videoSrc?: (filePath: string) => string | null;
  skills?: readonly unknown[] | undefined;
  cwd?: string;
}

// Memoised: a streamed chunk re-renders the transcript, and an unchanged reply need not be parsed again.
// Its callers keep onOpenFile, imageSrc, imagePending and videoSrc stable for that.
export const MarkdownView = memo(function MarkdownView({ text, className, onOpenFile, imageSrc, imagePending, videoSrc, skills, cwd }: MarkdownViewProps) {
  const local: Local = { onOpenFile, imageSrc, imagePending, videoSrc, skills, cwd };
  const blocks = parseMarkdown(text);
  if (!blocks.length) return null;
  return (
    <div className={className}>
      <Blocks blocks={blocks} local={local} />
    </div>
  );
});

function Blocks({ blocks, local }: { blocks: MarkdownBlock[]; local: Local }) {
  return blocks.map((block, index) => {
    if (block.type === "quote") {
      return (
        <blockquote key={index}>
          <Blocks blocks={block.blocks} local={local} />
        </blockquote>
      );
    }
    if (block.type === "code") return <CodeBlock key={index} text={block.text} diagram={isDiagramLang(block.lang)} open={block.open === true} />;
    if (block.type === "math") return <MathTex key={index} tex={block.text} display block />;
    if (block.type === "heading") {
      const Tag = `h${block.level}` as "h1" | "h2" | "h3" | "h4" | "h5" | "h6";
      return (
        <Tag key={index}>
          <Inline text={block.text} local={local} />
        </Tag>
      );
    }
    if (block.type === "list") return <List key={index} list={block} local={local} />;
    if (block.type === "table") {
      return (
        <div key={index} className="md-table-wrap">
          <table>
            <thead>
              <tr>
                {block.header.map((cell, cellIndex) => (
                  <th key={cellIndex} scope="col" className={alignClass(block.align[cellIndex])}>
                    <Inline text={cell} local={local} />
                  </th>
                ))}
              </tr>
            </thead>
            {block.rows.length ? (
              <tbody>
                {block.rows.map((row, rowIndex) => (
                  <tr key={rowIndex}>
                    {row.map((cell, cellIndex) => (
                      <td key={cellIndex} className={alignClass(block.align[cellIndex])}>
                        <Inline text={cell} local={local} />
                      </td>
                    ))}
                  </tr>
                ))}
              </tbody>
            ) : null}
          </table>
        </div>
      );
    }
    return (
      <p key={index}>
        <Inline text={block.text} local={local} />
      </p>
    );
  });
}

// An item shows its first line, then the paragraphs and lists indented under it.
function List({ list, local }: { list: ListBlock; local: Local }) {
  const items = list.items.map((item, index) => (
    <li key={index}>
      <Inline text={item.text} local={local} />
      {item.children?.map((child, childIndex) =>
        child.type === "list" ? (
          <List key={childIndex} list={child} local={local} />
        ) : child.type === "quote" ? (
          <blockquote key={childIndex}>
            <Blocks blocks={child.blocks} local={local} />
          </blockquote>
        ) : (
          <p key={childIndex}>
            <Inline text={child.text} local={local} />
          </p>
        ),
      )}
    </li>
  ));
  return list.ordered ? <ol start={list.start}>{items}</ol> : <ul>{items}</ul>;
}

// One line of Markdown with no blocks: bold, italic, code and links, for a line inside other text.
export function MarkdownInline({ text }: { text: string }) {
  return <Inline text={text} local={{}} />;
}

// A mermaid block is drawn as a diagram once it closes, with a toggle back to its code. Until then (while it
// streams, and while the diagram is drawn) a shimmer holds its place; the toggle shows the code so far.
// A block Mermaid cannot draw stays code, with a note under it that says why.
const CodeBlock = memo(function CodeBlock({ text, diagram = false, open = false }: { text: string; diagram?: boolean; open?: boolean }) {
  const drawn = useDiagram(diagram && !open ? text : null);
  const [showCode, setShowCode] = useState(false);
  const [copied, copy] = useCopy(text);

  const svg = drawn && "svg" in drawn ? drawn.svg : null;
  const error = drawn && "error" in drawn ? drawn.error : null;
  // A diagram on its way: the block is still streaming, or it is closed and not drawn yet.
  const pending = diagram && (open || drawn === undefined);
  const toggles = svg != null || pending;
  const picture = toggles && !showCode;

  return (
    <div className={toggles ? "code-block has-diagram" : "code-block"}>
      {picture && svg != null ? (
        <div className="diagram" role="img" aria-label="Diagram" data-testid="diagram" dangerouslySetInnerHTML={{ __html: svg }} />
      ) : picture ? (
        <div className="diagram-pending" role="status" aria-label="Drawing diagram" data-testid="diagram-pending" style={{ height: pendingHeight(text) }} />
      ) : (
        <pre className="code">
          <code>{text}</code>
        </pre>
      )}
      {error != null ? (
        <p className="diagram-note" data-testid="diagram-error">
          Couldn't draw this diagram: {error}
        </p>
      ) : null}
      {toggles ? (
        <button
          type="button"
          className="code-toggle"
          aria-label={picture ? "Show code" : "Show diagram"}
          title={picture ? "Show code" : "Show diagram"}
          data-testid="diagram-toggle"
          onClick={() => setShowCode(picture)}
        >
          {picture ? <CodeIcon /> : <DiagramIcon />}
        </button>
      ) : null}
      <button
        type="button"
        className={copied ? "code-copy is-copied" : "code-copy"}
        aria-label={copied ? "Copied" : "Copy code"}
        data-testid="copy-code"
        onClick={copy}
      >
        {copied ? <CheckIcon /> : <CopyIcon />}
      </button>
    </div>
  );
});

// The shimmer grows with the code that has streamed in so far, within bounds, so the diagram that replaces
// it moves the reply as little as it can.
function pendingHeight(text: string): number {
  return Math.min(280, Math.max(120, text.split("\n").length * 22));
}

function CodeIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 16 16" aria-hidden="true">
      <path d="M5.5 4.5 2 8l3.5 3.5M10.5 4.5 14 8l-3.5 3.5" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

function DiagramIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 16 16" aria-hidden="true">
      <rect x="2" y="2.5" width="5" height="3.5" rx="1" fill="none" stroke="currentColor" strokeWidth="1.4" />
      <rect x="9" y="10" width="5" height="3.5" rx="1" fill="none" stroke="currentColor" strokeWidth="1.4" />
      <path d="M4.5 6v2.5a1.5 1.5 0 0 0 1.5 1.5h3" fill="none" stroke="currentColor" strokeWidth="1.4" />
    </svg>
  );
}

function alignClass(align: CellAlign | undefined): string | undefined {
  if (align === "center" || align === "right") return `align-${align}`;
  return undefined;
}

// Plain text with its math drawn, for the thinking detail.
export const MathText = memo(function MathText({ text }: { text: string }) {
  return parseMathText(text).map((part, index) =>
    part.type === "math" ? <MathTex key={index} tex={part.text} display={part.display} /> : part.text,
  );
});

// KaTeX's markup, rendered with trust off (see math.ts). Display math inside a paragraph stays a span.
// Until KaTeX has loaded the expression shows as its source, and it stays so if KaTeX cannot draw it.
function MathTex({ tex, display, block = false }: { tex: string; display: boolean; block?: boolean }) {
  const ready = useMathReady();
  const html = ready ? renderMath(tex, display) : null;
  const Tag = block ? "div" : "span";
  const className = display ? "math math-display" : "math";
  if (html == null) return <Tag className={`${className} ${ready ? "math-source" : "math-loading"}`}>{tex}</Tag>;
  return <Tag className={className} dangerouslySetInnerHTML={{ __html: html }} />;
}

function Inline({ text, local }: { text: string; local: Local }) {
  const { onOpenFile, imageSrc, imagePending, videoSrc } = local;
  return parseInline(text).map((part, index) => {
    if (part.type === "code") return <code key={index}>{part.text}</code>;
    if (part.type === "math") return <MathTex key={index} tex={part.text} display={part.display} />;
    // Bold or italic text can hold an address or code of its own.
    if (part.type === "strong") {
      return (
        <strong key={index}>
          <Inline text={part.text} local={local} />
        </strong>
      );
    }
    if (part.type === "em") {
      return (
        <em key={index}>
          <Inline text={part.text} local={local} />
        </em>
      );
    }
    if (part.type === "image") {
      if (imagePending?.(part.path)) return <span key={index} className="skeleton-line md-image-pending" role="status" aria-label={`Loading ${part.text}`} />;
      const src = imageSrc?.(part.path);
      if (src) return <InlineImage key={index} src={src} alt={part.text} />;
      return <span key={index} className="md-file" title={part.path}>{part.text}</span>;
    }
    if (part.type === "webImage") return <InlineImage key={index} src={part.href} alt={part.text} href={part.href} />;
    if (part.type === "video") {
      const src = videoSrc?.(part.path);
      if (src) return <InlineVideo key={index} src={src} title={part.text} />;
      return <span key={index} className="md-file" title={part.path}>{part.text}</span>;
    }
    if (part.type === "file") {
      const where = part.line ? `${part.path}:${part.line}` : part.path;
      return onOpenFile ? (
        <button key={index} type="button" className="md-file" title={where} onClick={() => onOpenFile(part.path)}>
          {part.text}
        </button>
      ) : (
        <span key={index} className="md-file" title={where}>
          {part.text}
        </span>
      );
    }
    if (part.type === "link") {
      const href = chatBoardHref(part.href, window.location.origin, local.cwd);
      const board = localBoardTarget(href, window.location.origin);
      if (board.taskId !== null) {
        return (
          <TicketLink key={index} href={href} cwd={board.cwd} taskId={board.taskId}>
            {part.text}
          </TicketLink>
        );
      }
      if (isShortTicketHref(href)) return part.text;
      return (
        <a key={index} href={href} target="_blank" rel="noreferrer">
          {part.text}
        </a>
      );
    }
    if (!local.skills?.length) return part.text;
    return (
      <Fragment key={index}>
        {skillParts(part.text, local.skills).map((piece, at) =>
          typeof piece === "string" ? (
            piece
          ) : (
            <span key={at} className="skill-chip" data-testid="skill-chip">
              <SkillIcon />
              {piece.skill}
            </span>
          ),
        )}
      </Fragment>
    );
  });
}

// A picture a reply shows inline. It opens in the zoom view. One that does not load shows its name,
// as a link when it is on the web.
function InlineImage({ src, alt, href }: { src: string; alt: string; href?: string }) {
  const [failed, setFailed] = useState(false);
  const [loaded, setLoaded] = useState(false);
  const [open, setOpen] = useState(false);
  useEffect(() => {
    setFailed(false);
    setLoaded(false);
  }, [src]);
  if (failed && href) {
    return (
      <a href={href} target="_blank" rel="noreferrer">
        {alt}
      </a>
    );
  }
  if (failed) return <span className="md-file" title="The picture is not there any more">{alt}</span>;
  return (
    <>
      <button type="button" className={loaded ? "md-image" : "md-image skeleton-line md-image-loading"} aria-label={`Open ${alt}`} onClick={() => setOpen(true)}>
        <img src={src} alt={alt} loading="lazy" referrerPolicy="no-referrer" onLoad={() => setLoaded(true)} onError={() => setFailed(true)} />
      </button>
      {open ? createPortal(<ShotLightbox srcs={[src]} index={0} onIndex={() => {}} onClose={() => setOpen(false)} />, document.body) : null}
    </>
  );
}

// A video a reply plays inline. One that does not load shows its name.
function InlineVideo({ src, title }: { src: string; title: string }) {
  const [failed, setFailed] = useState(false);
  useEffect(() => setFailed(false), [src]);
  if (failed) return <span className="md-file" title="The video is not there any more">{title}</span>;
  return <video className="md-video" src={src} controls preload="metadata" aria-label={title} onError={() => setFailed(true)} />;
}
