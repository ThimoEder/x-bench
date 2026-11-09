import { useEffect, useState } from "react";
import type { FormEvent, ReactNode } from "react";
import type { SakStatus } from "../../server/board/sak/sakClient.ts";
import type { JiraStatus } from "../../server/board/jira/jira.ts";
import type { TrelloStatus } from "../../server/board/trello/trello.ts";

// The fields read from a SakStatus.
type SakView = Partial<Pick<SakStatus, "configured" | "enabled" | "reachable" | "version" | "baseUrl">>;

// The fields read from a TrelloStatus.
type TrelloView = Partial<Pick<TrelloStatus, "configured" | "enabled" | "reachable" | "username">>;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function isFlag(value: unknown): value is boolean | undefined {
  return value === undefined || typeof value === "boolean";
}

function isTrelloView(value: unknown): value is TrelloView {
  return isRecord(value) && isFlag(value.configured) && isFlag(value.enabled) && isFlag(value.reachable);
}

// The fields read from a JiraStatus.
type JiraView = Partial<Pick<JiraStatus, "configured" | "enabled" | "reachable" | "site" | "email">> & { name?: unknown };

function isJiraView(value: unknown): value is JiraView {
  return isRecord(value) && isFlag(value.configured) && isFlag(value.enabled) && isFlag(value.reachable)
    && (value.site === undefined || typeof value.site === "string")
    && (value.email === undefined || typeof value.email === "string");
}

function isSakView(value: unknown): value is SakView {
  return isRecord(value) && isFlag(value.configured) && isFlag(value.enabled) && isFlag(value.reachable)
    && (value.baseUrl === undefined || typeof value.baseUrl === "string");
}

// A host answer the sheet reads. Anything else fails like a failed request.
function checked<T>(value: unknown, guard: (value: unknown) => value is T): T {
  if (guard(value)) return value;
  throw new Error("Request failed");
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : "";
}

export interface BoardSetupProps {
  call: (path: string, body?: unknown, method?: string) => Promise<unknown>;
}

const DEFAULT_SAK = "http://127.0.0.1:4345";

// The Boards tab of Settings: the Local (SAK), Trello and Jira connections.
export function BoardSetup({ call }: BoardSetupProps) {
  const [status, setStatus] = useState<SakView | null>(null);
  const [enabled, setEnabled] = useState(false);
  const [address, setAddress] = useState(DEFAULT_SAK);
  // The address as saved, so Save only turns on once something changed.
  const [savedAddress, setSavedAddress] = useState(DEFAULT_SAK);
  const [token, setToken] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [saved, setSaved] = useState(false);
  const [trelloStatus, setTrelloStatus] = useState<TrelloView | null>(null);
  const [trelloEnabled, setTrelloEnabled] = useState(false);
  const [apiKey, setApiKey] = useState("");
  const [trelloToken, setTrelloToken] = useState("");
  const [trelloBusy, setTrelloBusy] = useState(false);
  const [trelloError, setTrelloError] = useState("");
  const [trelloSaved, setTrelloSaved] = useState(false);

  useEffect(() => {
    let cancel = false;
    call("/api/sak/status", null, "GET")
      .then((next) => {
        if (cancel) return;
        if (!isSakView(next)) throw new Error("Request failed");
        setStatus(next);
        setEnabled(Boolean(next.enabled));
        setAddress(next.baseUrl || DEFAULT_SAK);
        setSavedAddress(next.baseUrl || DEFAULT_SAK);
      })
      .catch((failure: unknown) => {
        if (!cancel) setError(messageOf(failure));
      });
    call("/api/trello/status", null, "GET")
      .then((next) => {
        if (cancel) return;
        if (!isTrelloView(next)) throw new Error("Request failed");
        setTrelloStatus(next);
        setTrelloEnabled(Boolean(next.enabled));
      })
      .catch((failure: unknown) => {
        if (!cancel) setTrelloError(messageOf(failure));
      });
    return () => {
      cancel = true;
    };
  }, [call]);

  async function save(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setBusy(true);
    setError("");
    setSaved(false);
    try {
      const next = checked(await call("/api/sak/connection", {
        baseUrl: address,
        token: token || undefined,
        enabled,
      }, "PUT"), isSakView);
      setStatus(next);
      setEnabled(Boolean(next.enabled));
      setAddress(next.baseUrl || address);
      setSavedAddress(next.baseUrl || address);
      setToken("");
      if (next.enabled && !next.reachable) {
        setError("The local board is not reachable");
        return;
      }
      setSaved(true);
    } catch (failure) {
      setError(messageOf(failure));
    } finally {
      setBusy(false);
    }
  }

  // A saved connection's switch applies at once, as the providers' do. The stored address, key and
  // token stay. Before a connection is saved, the switch goes with the first Save.
  async function toggleSak(next: boolean) {
    setEnabled(next);
    setSaved(false);
    setError("");
    if (!status?.configured) return;
    setBusy(true);
    try {
      const reply = checked(await call("/api/sak/connection", { enabled: next }, "PUT"), isSakView);
      setStatus(reply);
      setEnabled(Boolean(reply.enabled));
      if (reply.enabled && !reply.reachable) setError("The local board is not reachable");
    } catch (failure) {
      setEnabled(Boolean(status.enabled));
      setError(messageOf(failure));
    } finally {
      setBusy(false);
    }
  }

  async function toggleTrello(next: boolean) {
    setTrelloEnabled(next);
    setTrelloSaved(false);
    setTrelloError("");
    if (!trelloStatus?.configured) return;
    setTrelloBusy(true);
    try {
      const reply = checked(await call("/api/trello/connection", { enabled: next }, "PUT"), isTrelloView);
      setTrelloStatus(reply);
      setTrelloEnabled(Boolean(reply.enabled));
      if (reply.enabled && !reply.reachable) setTrelloError("Trello is not reachable");
    } catch (failure) {
      setTrelloEnabled(Boolean(trelloStatus.enabled));
      setTrelloError(messageOf(failure));
    } finally {
      setTrelloBusy(false);
    }
  }

  async function saveTrello(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setTrelloBusy(true);
    setTrelloError("");
    setTrelloSaved(false);
    try {
      const next = checked(await call("/api/trello/connection", {
        apiKey: apiKey || undefined,
        token: trelloToken || undefined,
        enabled: trelloEnabled,
      }, "PUT"), isTrelloView);
      setTrelloStatus(next);
      setTrelloEnabled(Boolean(next.enabled));
      setApiKey("");
      setTrelloToken("");
      if (next.enabled && !next.reachable) {
        setTrelloError("Trello is not reachable");
        return;
      }
      setTrelloSaved(true);
    } catch (failure) {
      setTrelloError(messageOf(failure));
    } finally {
      setTrelloBusy(false);
    }
  }

  // Like the Providers section, Save turns on only once something differs from what is saved.
  // A saved connection's switch applies at once, so only an unsaved one's switch waits for Save.
  const changed = Boolean(status) && ((!status?.configured && enabled !== Boolean(status?.enabled)) || address.trim() !== savedAddress || Boolean(token.trim()));
  const trelloChanged = Boolean(trelloStatus) && ((!trelloStatus?.configured && trelloEnabled !== Boolean(trelloStatus?.enabled)) || Boolean(apiKey.trim()) || Boolean(trelloToken.trim()));
  // With no token, Save on an unset connection has the host set up a SAK board of its own.
  const canSave = changed && Boolean(address.trim()) && (Boolean(token.trim()) || Boolean(status?.configured) || enabled);
  const canSaveTrello = trelloChanged && (Boolean(apiKey.trim()) || Boolean(trelloStatus?.configured)) && (Boolean(trelloToken.trim()) || Boolean(trelloStatus?.configured));
  const statusLine = !status
    ? "Checking…"
    : status.enabled && status.reachable
      ? `Connected${status.version ? ` · ${status.version}` : ""}`
      : status.enabled
        ? "Not reachable"
        : status.configured
          ? "Off"
          : "Off · Not set up";
  const trelloLine = !trelloStatus
    ? "Checking…"
    : trelloStatus.enabled && trelloStatus.reachable
      ? `Connected${trelloStatus.username ? ` · ${trelloStatus.username}` : ""}`
      : trelloStatus.enabled
        ? "Not reachable"
        : trelloStatus.configured
          ? "Off"
          : "Off · Not set up";

  return (
    <div data-testid="setup">
      <p className="sheet-copy">
        A project folder can show a ticket board from one of these services.
      </p>
      <BoardCard
        id="sak"
        name="Local"
        enabled={enabled}
        busy={busy}
        onEnabled={(next) => {
          toggleSak(next).catch(() => {});
        }}
        line={statusLine}
        tone={toneOf(status)}
        error={error}
        saved={saved}
        canSave={!busy && canSave}
        onSubmit={save}
      >
        <label className="sheet-field">
          Address
          <input
            value={address}
            onChange={(event) => {
              setAddress(event.target.value);
              setSaved(false);
            }}
            spellCheck={false}
            autoComplete="off"
          />
        </label>
        <label className="sheet-field">
          Token
          <input
            value={token}
            onChange={(event) => {
              setToken(event.target.value);
              setSaved(false);
            }}
            placeholder={status?.configured ? "Stored token stays if this is empty" : "Leave empty to set up a board on this Mac"}
            spellCheck={false}
            autoComplete="off"
          />
        </label>
        <p className="sheet-copy">
          Powered by <a href="https://git.swipelab.com/sx/sak" target="_blank" rel="noreferrer">SAK</a>
        </p>
      </BoardCard>
      <BoardCard
        id="trello"
        name="Trello"
        enabled={trelloEnabled}
        busy={trelloBusy}
        onEnabled={(next) => {
          toggleTrello(next).catch(() => {});
        }}
        line={trelloLine}
        tone={toneOf(trelloStatus)}
        error={trelloError}
        saved={trelloSaved}
        canSave={!trelloBusy && canSaveTrello}
        onSubmit={saveTrello}
      >
        <label className="sheet-field">
          API key
          <input
            value={apiKey}
            onChange={(event) => {
              setApiKey(event.target.value);
              setTrelloSaved(false);
            }}
            placeholder={trelloStatus?.configured ? "Stored key stays if this is empty" : "Trello API key"}
            spellCheck={false}
            autoComplete="off"
          />
        </label>
        <label className="sheet-field">
          Token
          <input
            value={trelloToken}
            onChange={(event) => {
              setTrelloToken(event.target.value);
              setTrelloSaved(false);
            }}
            placeholder={trelloStatus?.configured ? "Stored token stays if this is empty" : "Trello token"}
            spellCheck={false}
            autoComplete="off"
          />
        </label>
      </BoardCard>
      <JiraSetup call={call} />
    </div>
  );
}

const JIRA_TOKENS = "https://id.atlassian.com/manage-profile/security/api-tokens";

function JiraSetup({ call }: BoardSetupProps) {
  const [status, setStatus] = useState<JiraView | null>(null);
  const [enabled, setEnabled] = useState(false);
  const [site, setSite] = useState("");
  const [email, setEmail] = useState("");
  const [token, setToken] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [saved, setSaved] = useState(false);

  function show(next: JiraView) {
    setStatus(next);
    setEnabled(Boolean(next.enabled));
    setSite(next.site || "");
    setEmail(next.email || "");
  }

  useEffect(() => {
    let cancel = false;
    call("/api/jira/status", null, "GET")
      .then((next) => {
        if (!cancel) show(checked(next, isJiraView));
      })
      .catch((failure: unknown) => {
        if (!cancel) setError(messageOf(failure));
      });
    return () => {
      cancel = true;
    };
  }, [call]);

  async function toggle(next: boolean) {
    setEnabled(next);
    setSaved(false);
    setError("");
    if (!status?.configured) return;
    setBusy(true);
    try {
      const reply = checked(await call("/api/jira/connection", { enabled: next }, "PUT"), isJiraView);
      setStatus(reply);
      setEnabled(Boolean(reply.enabled));
      if (reply.enabled && !reply.reachable) setError("Jira is not reachable");
    } catch (failure) {
      setEnabled(Boolean(status.enabled));
      setError(messageOf(failure));
    } finally {
      setBusy(false);
    }
  }

  async function save(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setBusy(true);
    setError("");
    setSaved(false);
    try {
      const next = checked(await call("/api/jira/connection", {
        baseUrl: site,
        email,
        token: token || undefined,
        enabled,
      }, "PUT"), isJiraView);
      show(next);
      setToken("");
      if (next.enabled && !next.reachable) {
        setError("Jira is not reachable. Check the site, email and API token.");
        return;
      }
      setSaved(true);
    } catch (failure) {
      setError(messageOf(failure));
    } finally {
      setBusy(false);
    }
  }

  const changed = Boolean(status) && ((!status?.configured && enabled !== Boolean(status?.enabled))
    || site.trim() !== (status?.site || "") || email.trim() !== (status?.email || "") || Boolean(token.trim()));
  const canSave = changed && Boolean(site.trim()) && Boolean(email.trim()) && (Boolean(token.trim()) || Boolean(status?.configured));
  const line = !status
    ? "Checking…"
    : status.enabled && status.reachable
      ? `Connected${typeof status.name === "string" && status.name ? ` · ${status.name}` : ""}`
      : status.enabled
        ? "Not reachable"
        : status.configured
          ? "Off"
          : "Off · Not set up";

  return (
    <BoardCard
      id="jira"
      name="Jira"
      enabled={enabled}
      busy={busy}
      onEnabled={(next) => {
        toggle(next).catch(() => {});
      }}
      line={line}
      tone={toneOf(status)}
      error={error}
      saved={saved}
      canSave={!busy && canSave}
      onSubmit={save}
    >
      <label className="sheet-field">
        Site
        <input
          value={site}
          onChange={(event) => {
            setSite(event.target.value);
            setSaved(false);
          }}
          placeholder="https://example.atlassian.net"
          spellCheck={false}
          autoComplete="off"
        />
      </label>
      <label className="sheet-field">
        Email
        <input
          value={email}
          onChange={(event) => {
            setEmail(event.target.value);
            setSaved(false);
          }}
          placeholder="Your Atlassian email"
          spellCheck={false}
          autoComplete="off"
        />
      </label>
      <label className="sheet-field">
        API token
        <input
          type="password"
          value={token}
          onChange={(event) => {
            setToken(event.target.value);
            setSaved(false);
          }}
          placeholder={status?.configured ? "Stored token stays for the same site" : "Jira API token"}
          spellCheck={false}
          autoComplete="off"
          data-testid="jira-token"
        />
      </label>
      <p className="sheet-copy">
        Create a token at <a href={JIRA_TOKENS} target="_blank" rel="noreferrer">id.atlassian.com</a>.
      </p>
    </BoardCard>
  );
}

// ok when the connection is on and answers, warn when it is on and does not, off otherwise.
function toneOf(status: { enabled?: boolean; reachable?: boolean } | null): "ok" | "warn" | "off" {
  if (!status?.enabled) return "off";
  return status.reachable ? "ok" : "warn";
}

interface BoardCardProps {
  id: string;
  name: string;
  enabled: boolean;
  // A change is on its way to the host.
  busy: boolean;
  onEnabled: (enabled: boolean) => void;
  line: string;
  tone: "ok" | "warn" | "off";
  error: string;
  saved: boolean;
  canSave: boolean;
  onSubmit: (event: FormEvent<HTMLFormElement>) => void;
  children: ReactNode;
}

// One board source, drawn like a provider on the Providers tab: name and switch, status, fields, save.
function BoardCard({ id, name, enabled, busy, onEnabled, line, tone, error, saved, canSave, onSubmit, children }: BoardCardProps) {
  return (
    <form className={enabled ? "provider-block" : "provider-block is-off"} data-testid={`board-${id}`} onSubmit={onSubmit}>
      <header className="provider-head">
        <h3>{name}</h3>
        <label className="provider-switch">
          <input type="checkbox" role="switch" checked={enabled} disabled={busy} data-testid={`board-enabled-${id}`} onChange={(event) => onEnabled(event.target.checked)} />
          {enabled ? "On" : "Off"}
        </label>
      </header>
      <p className="provider-state" data-tone={tone} data-testid={`board-state-${id}`}>
        <span className="provider-dot" aria-hidden="true" />
        {line}
      </p>
      {children}
      {error ? <p className="sheet-error">{error}</p> : null}
      {saved && !error ? <p className="setup-ok">Saved.</p> : null}
      <div className="sheet-actions provider-actions">
        <button type="submit" className="primary" data-testid={`save-board-${id}`} disabled={!canSave}>
          Save {name}
        </button>
      </div>
    </form>
  );
}
