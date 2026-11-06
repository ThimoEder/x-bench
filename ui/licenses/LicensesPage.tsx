import { useEffect, useRef, useState, type KeyboardEvent } from "react";
import type { License } from "./licenses.ts";

const FILTERS: [string, (entry: License) => boolean][] = [
  ["All", () => true],
  ["MIT", (entry) => entry.license === "MIT"],
  ["Apache", (entry) => entry.license.includes("Apache")],
  ["ISC", (entry) => entry.license === "ISC"],
  ["BSD", (entry) => entry.license.startsWith("BSD")],
  ["Other", (entry) => !/^(MIT|ISC|Apache-2\.0|BSD-.*)$/.test(entry.license)],
];

// The Open Source Licenses window, which About opens at /licenses.
export function LicensesPage({ licenses }: { licenses: License[] }) {
  const [query, setQuery] = useState("");
  const [filter, setFilter] = useState(0);
  const [pick, setPick] = useState(licenses[0]);
  const listRef = useRef<HTMLUListElement>(null);
  const detailRef = useRef<HTMLElement>(null);

  const needle = query.trim().toLowerCase();
  const shown = licenses.filter((entry) => FILTERS[filter]![1](entry) && (!needle || `${entry.name} ${entry.license}`.toLowerCase().includes(needle)));

  useEffect(() => {
    document.title = "Open Source Licenses";
    function onKey(event: globalThis.KeyboardEvent) {
      if (event.key === "Escape") window.close();
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  useEffect(() => {
    detailRef.current?.scrollTo(0, 0);
    listRef.current?.querySelector(".on")?.scrollIntoView({ block: "nearest" });
  }, [pick]);

  function step(event: KeyboardEvent) {
    if (event.key !== "ArrowDown" && event.key !== "ArrowUp") return;
    event.preventDefault();
    const at = pick ? shown.indexOf(pick) : -1;
    const next = shown[Math.max(0, Math.min(shown.length - 1, at + (event.key === "ArrowDown" ? 1 : -1)))];
    if (next) setPick(next);
  }

  return (
    <div className="licenses">
      <aside className="licenses-side" onKeyDown={step}>
        <label className="licenses-search">
          <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" aria-hidden="true">
            <circle cx="11" cy="11" r="6.5" />
            <path d="m16 16 4 4" />
          </svg>
          <input type="search" autoFocus value={query} placeholder={`Search ${licenses.length} components`} aria-label="Search licenses" onChange={(event) => setQuery(event.target.value)} />
        </label>
        <div className="licenses-chips">
          {FILTERS.map(([label, test], index) => (
            <button key={label} type="button" className={index === filter ? "on" : undefined} aria-pressed={index === filter} onClick={() => setFilter(index)}>
              {label}
              <span>{licenses.filter(test).length}</span>
            </button>
          ))}
        </div>
        <ul className="licenses-list" ref={listRef}>
          {shown.map((entry) => (
            <li key={`${entry.name}@${entry.version}`}>
              <button type="button" className={entry === pick ? "on" : undefined} onClick={() => setPick(entry)}>
                <span className="licenses-name">{entry.name}</span>
                <span className="licenses-tag">{entry.license}</span>
              </button>
            </li>
          ))}
          {shown.length ? null : <li className="licenses-empty">No component matches “{query}”.</li>}
        </ul>
      </aside>
      {pick ? (
        <article className="licenses-detail" ref={detailRef} data-testid="license">
          <header>
            <div>
              <h1>{pick.name}</h1>
              <p>{[pick.version, pick.license].filter(Boolean).join(" · ")}</p>
            </div>
            <a href={pick.url} target="_blank" rel="noreferrer">
              Website
            </a>
          </header>
          {pick.note ? <p className="licenses-note">{pick.note}</p> : null}
          {pick.credits ? (
            <a className="licenses-credits" href={pick.credits} target="_blank" rel="noreferrer">
              Chromium credits ›
            </a>
          ) : null}
          <pre>{pick.text}</pre>
        </article>
      ) : null}
    </div>
  );
}
