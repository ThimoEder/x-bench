import { useEffect, useState } from "react";
import type { FormEvent, Key, ReactNode } from "react";
import type { SakStatus } from "../../server/board/sak/sakClient.ts";
import type { TrelloBoardChoice, TrelloStatus } from "../../server/board/trello/trello.ts";

type Source = "sak" | "trello" | "jira";

// The two fields read from a SakStatus, a TrelloStatus or a JiraStatus.
type ConnectionStatus = Partial<Pick<SakStatus & TrelloStatus, "enabled" | "reachable">>;

// A SAK project as SAK sent it, a Trello board, or a Jira board with its project key.
type BoardChoice = Partial<Record<keyof TrelloBoardChoice | "project", unknown>>;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function isFlag(value: unknown): value is boolean | undefined {
  return value === undefined || typeof value === "boolean";
}

function isStatus(value: unknown): value is ConnectionStatus {
  return isRecord(value) && isFlag(value.enabled) && isFlag(value.reachable);
}

function readStatus(value: unknown): ConnectionStatus | null {
  return isStatus(value) ? value : null;
}

function isChoiceList(value: unknown): value is BoardChoice[] {
  return Array.isArray(value) && value.every(isRecord);
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : "";
}

// A loose value as React turns it into a key.
function keyOf(value: unknown): Key | null | undefined {
  if (value === undefined || value === null || typeof value === "string" || typeof value === "number" || typeof value === "bigint") return value;
  return String(value);
}

// A loose value as React renders it. An object, which React cannot render, renders nothing.
function nodeOf(value: unknown): ReactNode {
  if (value === undefined || value === null || typeof value === "string" || typeof value === "number" || typeof value === "boolean" || typeof value === "bigint") return value;
  if (Array.isArray(value)) return value.map(nodeOf);
  return null;
}

const SKELETON_ROWS = [58, 42, 66, 36, 50];

export interface CreateBoardProps {
  cwd: string;
  name: string;
  call: (path: string, body?: unknown, method?: string) => Promise<unknown>;
  onClose: () => void;
  onCreated: (cwd: string) => void;
  onSetup: () => void;
}

export function CreateBoard({ cwd, name, call, onClose, onCreated, onSetup }: CreateBoardProps) {
  const [source, setSource] = useState<Source>("sak");
  const [sak, setSak] = useState<ConnectionStatus | null>(null);
  const [trello, setTrello] = useState<ConnectionStatus | null>(null);
  const [jira, setJira] = useState<ConnectionStatus | null>(null);
  const [projects, setProjects] = useState<BoardChoice[] | null>(null);
  const [boards, setBoards] = useState<BoardChoice[] | null>(null);
  const [jiraBoards, setJiraBoards] = useState<BoardChoice[] | null>(null);
  const [picked, setPicked] = useState<unknown>(null);
  const [query, setQuery] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  useEffect(() => {
    let cancel = false;
    const check = async (
      statusPath: string,
      listPath: string,
      setStatus: (status: ConnectionStatus | null) => void,
      show: (list: BoardChoice[]) => void,
      reportError = false,
    ) => {
      const status = await call(statusPath, null, "GET").catch((failure: unknown) => ({ error: messageOf(failure) }));
      if (cancel) return;
      if (reportError && isRecord(status) && typeof status.error === "string" && status.error) setError(status.error);
      setStatus(isRecord(status) && status.error ? null : readStatus(status));
      if (!isStatus(status) || !status.enabled || !status.reachable) return;
      const list = await call(listPath, null, "GET").catch(() => []);
      if (!cancel) show(isChoiceList(list) ? list : []);
    };
    void check("/api/sak/status", "/api/sak/projects", setSak, setProjects, true);
    void check("/api/trello/status", "/api/trello/boards", setTrello, setBoards);
    void check("/api/jira/status", "/api/jira/boards", setJira, setJiraBoards);
    return () => {
      cancel = true;
    };
  }, [call]);

  useEffect(() => {
    function onKey(event: KeyboardEvent) {
      if (event.key === "Escape") onClose();
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  function chooseSource(next: Source) {
    setSource(next);
    setPicked(null);
    setQuery("");
    setError("");
  }

  async function match(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!pickedShown) return;
    setBusy(true);
    setError("");
    try {
      const body = source === "sak" ? { cwd, projectId: picked } : { cwd, provider: source, boardId: picked };
      await call("/api/board/boards", body);
      onCreated(cwd);
    } catch (failure) {
      setError(messageOf(failure));
    } finally {
      setBusy(false);
    }
  }

  async function createProject() {
    setBusy(true);
    setError("");
    try {
      const body = source === "trello"
        ? { cwd, provider: "trello", title: name || "Project" }
        : { cwd, title: name || "Project" };
      await call("/api/board/boards", body);
      onCreated(cwd);
    } catch (failure) {
      setError(messageOf(failure));
      if (source === "sak") {
        try {
          const list = await call("/api/sak/projects", null, "GET");
          setProjects(isChoiceList(list) ? list : []);
        } catch {
          // The match list stays as it was if SAK cannot be read again.
        }
      }
    } finally {
      setBusy(false);
    }
  }

  const sakReady = Boolean(sak?.enabled && sak?.reachable);
  const trelloReady = Boolean(trello?.enabled && trello?.reachable);
  const jiraReady = Boolean(jira?.enabled && jira?.reachable);
  const ready = source === "jira" ? jiraReady : source === "trello" ? trelloReady : sakReady;
  const choices = source === "jira" ? jiraBoards : source === "trello" ? boards : projects;
  const status = source === "jira" ? jira : source === "trello" ? trello : sak;
  const blocked = source === "jira"
    ? jira
      ? jira.enabled
        ? "Jira is not reachable. Open setup to check the site, email and API token."
        : "Add your Jira site, email and API token in setup. This folder can match a board after that."
      : "Checking Jira…"
    : source === "trello"
    ? trello
      ? trello.enabled
        ? "Trello is not reachable. Open setup to check the key and token."
        : "Add a Trello key and token in setup. This folder can match a board after that."
      : "Checking Trello…"
    : sak
      ? sak.enabled
        ? "The local board is not reachable. Open setup to check the connection."
        : "Enable the local board in setup. This folder can match a board after that."
      : "Checking the local board…";
  const copy = source === "jira"
    ? `Match ${name} to one of your Jira boards. New boards are made in Jira.`
    : source === "trello"
      ? `Match ${name} to a Trello board, or create one for this folder.`
      : `Match ${name} to a local board, or create one for this folder.`;
  const listName = source === "jira" ? "Jira boards" : source === "trello" ? "Trello boards" : "local boards";
  const needle = query.trim().toLowerCase();
  const shown = choices?.filter((item) => [item.title, item.project, source === "sak" ? item.id : null].some((value) => keyOf(value)?.toString().toLowerCase().includes(needle)));
  const pickedShown = Boolean(picked) && Boolean(shown?.some((item) => item.id === picked));
  const empty = !choices ? "" : choices.length === 0 ? `No ${listName} yet.` : shown?.length === 0 ? `No ${listName} match “${query.trim()}”.` : "";

  return (
    <div className="sheet-scrim" onMouseDown={onClose}>
      <div
        className="sheet"
        role="dialog"
        aria-modal="true"
        aria-labelledby="create-board-title"
        onMouseDown={(event) => event.stopPropagation()}
      >
        <h2 id="create-board-title">Create board</h2>
        <div className="sheet-switch" role="tablist" aria-label="Board source">
          <button type="button" role="tab" aria-selected={source === "sak"} className={source === "sak" ? "is-picked" : ""} onClick={() => chooseSource("sak")}>
            Local
          </button>
          <button type="button" role="tab" aria-selected={source === "trello"} className={source === "trello" ? "is-picked" : ""} onClick={() => chooseSource("trello")}>
            Trello
          </button>
          <button type="button" role="tab" aria-selected={source === "jira"} className={source === "jira" ? "is-picked" : ""} onClick={() => chooseSource("jira")}>
            Jira
          </button>
        </div>
        <p className="sheet-copy">{ready ? copy : blocked}</p>
        {ready ? (
          <form onSubmit={match}>
            <div className="sheet-field">
              <input
                type="search"
                value={query}
                onChange={(event) => setQuery(event.target.value)}
                placeholder={`Search ${listName}`}
                aria-label={`Search ${listName}`}
                autoFocus
              />
            </div>
            <div className="sheet-projects" role="listbox" aria-label={choices ? listName : `Loading ${listName}`} aria-busy={!choices}>
              {choices ? null : SKELETON_ROWS.map((width) => (
                <span className="sheet-project sheet-skeleton" key={width} aria-hidden="true">
                  <span className="skeleton-line" style={{ width: `${width}%` }} />
                </span>
              ))}
              {empty ? <p className="sheet-copy">{empty}</p> : null}
              {shown?.map((item) => (
                <button
                  key={keyOf(item.id)}
                  type="button"
                  role="option"
                  aria-selected={picked === item.id}
                  className={picked === item.id ? "sheet-project is-picked" : "sheet-project"}
                  onClick={() => setPicked(item.id)}
                >
                  <span>{nodeOf(item.title)}</span>
                  {source === "sak" ? <span className="sheet-id">{nodeOf(item.id)}</span> : null}
                  {source === "jira" && item.project ? <span className="sheet-id">{nodeOf(item.project)}</span> : null}
                </button>
              ))}
            </div>
            {error ? <p className="sheet-error">{error}</p> : null}
            <div className="sheet-actions">
              <button type="button" className="text-button" onClick={onClose} disabled={busy}>Cancel</button>
              {source === "jira" ? null : (
                <button type="button" className="text-button" disabled={busy} onClick={createProject}>
                  {source === "trello" ? `New Trello board “${name || "Project"}”` : `New local board “${name || "Project"}”`}
                </button>
              )}
              <button type="submit" className="primary" disabled={busy || !pickedShown}>Match</button>
            </div>
          </form>
        ) : (
          <>
            {error ? <p className="sheet-error">{error}</p> : null}
            <div className="sheet-actions">
              <button type="button" className="text-button" onClick={onClose}>Cancel</button>
              <button type="button" className="primary" onClick={onSetup} disabled={!status}>Open setup</button>
            </div>
          </>
        )}
      </div>
    </div>
  );
}
