import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import pkg from "../../package.json" with { type: "json" };
import { CloseIcon } from "../icons.tsx";

export function AboutButton() {
  const buttonRef = useRef<HTMLButtonElement>(null);
  const [open, setOpen] = useState(false);

  useEffect(() => {
    if (!open) return undefined;
    const button = buttonRef.current;
    function onKey(event: KeyboardEvent) {
      if (event.key === "Escape") setOpen(false);
    }
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("keydown", onKey);
      button?.focus();
    };
  }, [open]);

  return (
    <>
      <button ref={buttonRef} type="button" className="icon" data-testid="open-about" aria-label="About X Bench" title="About X Bench" onClick={() => setOpen(true)}>
        <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" aria-hidden="true">
          <circle cx="12" cy="12" r="8.5" />
          <path d="M12 11v5.2" />
          <path d="M12 7.8h.01" strokeWidth="2.4" />
        </svg>
      </button>
      {open ? createPortal(<About onClose={() => setOpen(false)} />, document.body) : null}
    </>
  );
}

function About({ onClose }: { onClose: () => void }) {
  return (
    <div className="sheet-scrim" onMouseDown={onClose}>
      <section className="sheet about" role="dialog" aria-modal="true" aria-labelledby="about-title" data-testid="about" onMouseDown={(event) => event.stopPropagation()}>
        <button type="button" className="icon about-close" aria-label="Close" autoFocus onClick={onClose}>
          <CloseIcon />
        </button>
        <span className="about-icon" aria-hidden="true" />
        <h2 id="about-title">X Bench</h2>
        <p className="about-version">Version {pkg.version}</p>
        <a className="about-maker" href="https://github.com/ThimoEder" target="_blank" rel="noreferrer">
          <span className="about-avatar" aria-hidden="true">TE</span>
          <span>
            <small>Made by</small>
            <b>Thimo Eder</b>
          </span>
        </a>
        <div className="about-links">
          <a className="about-link" href="https://xbench.dev" target="_blank" rel="noreferrer">
            <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" aria-hidden="true">
              <circle cx="12" cy="12" r="8.5" />
              <path d="M3.5 12h17M12 3.5c2.5 2.6 3.5 5.4 3.5 8.5s-1 5.9-3.5 8.5c-2.5-2.6-3.5-5.4-3.5-8.5s1-5.9 3.5-8.5z" />
            </svg>
            Website
          </a>
          <a className="about-link" href="https://github.com/ThimoEder/x-bench" target="_blank" rel="noreferrer">
            <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" aria-hidden="true">
              <circle cx="7" cy="6" r="2.2" />
              <circle cx="7" cy="18" r="2.2" />
              <circle cx="17" cy="8" r="2.2" />
              <path d="M7 8.2v7.6M17 10.2c0 3.8-4 4.3-9.2 6.1" />
            </svg>
            GitHub
          </a>
        </div>
        <p className="about-legal">© {new Date().getFullYear()} Thimo Eder · MIT License</p>
        <p className="about-legal">Not affiliated with Anthropic, OpenAI or xAI.</p>
        <div className="about-licenses">
          <a href="/licenses" target="_blank" rel="noreferrer">
            Open source licenses
          </a>
          <a href="https://xbench.dev/privacy.html" target="_blank" rel="noreferrer">
            Privacy
          </a>
          <a href="https://xbench.dev/impressum.html" target="_blank" rel="noreferrer">
            Imprint
          </a>
        </div>
      </section>
    </div>
  );
}
