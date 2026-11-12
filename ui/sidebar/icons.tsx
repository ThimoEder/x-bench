export function SettingsIcon() {
  return (
    <svg width="18" height="18" viewBox="0 0 24 24" aria-hidden="true">
      <path
        d="M12.22 2h-.44a2 2 0 0 0-2 2v.18a2 2 0 0 1-1 1.73l-.43.25a2 2 0 0 1-2 0l-.15-.08a2 2 0 0 0-2.73.73l-.22.38a2 2 0 0 0 .73 2.73l.15.1a2 2 0 0 1 1 1.72v.51a2 2 0 0 1-1 1.74l-.15.09a2 2 0 0 0-.73 2.73l.22.38a2 2 0 0 0 2.73.73l.15-.08a2 2 0 0 1 2 0l.43.25a2 2 0 0 1 1 1.73V20a2 2 0 0 0 2 2h.44a2 2 0 0 0 2-2v-.18a2 2 0 0 1 1-1.73l.43-.25a2 2 0 0 1 2 0l.15.08a2 2 0 0 0 2.73-.73l.22-.39a2 2 0 0 0-.73-2.73l-.15-.08a2 2 0 0 1-1-1.74v-.5a2 2 0 0 1 1-1.74l.15-.09a2 2 0 0 0 .73-2.73l-.22-.38a2 2 0 0 0-2.73-.73l-.15.08a2 2 0 0 1-2 0l-.43-.25a2 2 0 0 1-1-1.73V4a2 2 0 0 0-2-2z"
        fill="none"
        stroke="currentColor"
        strokeWidth="2"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
      <circle cx="12" cy="12" r="3" fill="none" stroke="currentColor" strokeWidth="2" />
    </svg>
  );
}

export function PanelIcon() {
  return (
    <svg width="18" height="18" viewBox="0 0 18 18" aria-hidden="true">
      <rect x="2.2" y="3" width="13.6" height="12" rx="1.6" fill="none" stroke="currentColor" strokeWidth="1.4" />
      <path d="M7 3.2v11.6" stroke="currentColor" strokeWidth="1.4" />
    </svg>
  );
}

export function ChatIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 18 18" aria-hidden="true">
      <path
        d="M3 4.5A1.5 1.5 0 0 1 4.5 3h9A1.5 1.5 0 0 1 15 4.5v6a1.5 1.5 0 0 1-1.5 1.5H8.2L5 14.6V12h-.5A1.5 1.5 0 0 1 3 10.5z"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.5"
        strokeLinejoin="round"
      />
    </svg>
  );
}

export function BuilderIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 18 18" aria-hidden="true">
      <path
        d="M6.5 5.5 3 9l3.5 3.5M11.5 5.5 15 9l-3.5 3.5"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.5"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

export function BoardIcon() {
  return (
    <svg width="12" height="12" viewBox="0 0 12 12" aria-hidden="true">
      <rect x="1.1" y="1.3" width="9.8" height="9.4" rx="1.2" fill="none" stroke="currentColor" strokeWidth="1.1" />
      <path d="M4.35 1.45v9M7.65 1.45v9" stroke="currentColor" strokeWidth="1.1" />
    </svg>
  );
}

export function CaretIcon() {
  return (
    <svg width="10" height="10" viewBox="0 0 10 10" aria-hidden="true">
      <path d="M2.2 3.6 5 6.4 7.8 3.6" fill="none" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

export function WorktreeIcon({ name }: { name: string }) {
  return (
    <span className="session-worktree" role="img" aria-label={name}>
      <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
        <path d="M21 17h-8l-3.5 -5h-6.5" />
        <path d="M21 7h-8l-3.495 5" />
        <path d="M18 10l3 -3l-3 -3" />
        <path d="M18 20l3 -3l-3 -3" />
      </svg>
    </span>
  );
}

export function FolderIcon({ open }: { open: boolean }) {
  return (
    <svg width="15" height="15" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.3" strokeLinejoin="round" aria-hidden="true">
      {open ? (
        <>
          <path d="M2 11.5V4.5c0-.8.7-1.5 1.5-1.5h2.8l1.4 1.5h4.3c.8 0 1.5.7 1.5 1.5v1" />
          <path d="M2 11.5 3.6 7.6c.2-.4.6-.6 1-.6h9.6c.5 0 .8.5.6 1l-1.4 3.8c-.2.4-.6.7-1 .7H3.3" />
        </>
      ) : (
        <path d="M2 4.5c0-.8.7-1.5 1.5-1.5h2.8l1.4 1.5h4.8c.8 0 1.5.7 1.5 1.5v5.5c0 .8-.7 1.5-1.5 1.5h-9c-.8 0-1.5-.7-1.5-1.5z" />
      )}
    </svg>
  );
}

export function PinIcon() {
  return (
    <span className="session-pin" role="img" aria-label="Pinned">
      <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
        <path d="M12 17v5" />
        <path d="M9 10.76a2 2 0 0 1-1.11 1.79l-1.78.9A2 2 0 0 0 5 15.24V16a1 1 0 0 0 1 1h12a1 1 0 0 0 1-1v-.76a2 2 0 0 0-1.11-1.79l-1.78-.9A2 2 0 0 1 15 10.76V7a1 1 0 0 1 1-1 2 2 0 0 0 0-4H8a2 2 0 0 0 0 4 1 1 0 0 1 1 1z" />
      </svg>
    </span>
  );
}

export function ArchiveIcon() {
  return (
    <span className="archive-mark" role="img" aria-label="Archived">
      <svg width="14" height="14" viewBox="0 0 14 14" aria-hidden="true">
        <path d="M1.8 2.6h10.4v2H1.8z" fill="none" stroke="currentColor" strokeWidth="1.2" strokeLinejoin="round" />
        <path d="M2.8 4.6h8.4V11.4H2.8z" fill="none" stroke="currentColor" strokeWidth="1.2" strokeLinejoin="round" />
        <path d="M5.4 7.4h3.2" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" />
      </svg>
    </span>
  );
}

export function MoreIcon() {
  return (
    <svg width="15" height="15" viewBox="0 0 16 16" aria-hidden="true">
      <circle cx="3.15" cy="8" r="1.15" fill="currentColor" />
      <circle cx="8" cy="8" r="1.15" fill="currentColor" />
      <circle cx="12.85" cy="8" r="1.15" fill="currentColor" />
    </svg>
  );
}

export function ComposeIcon() {
  return (
    <svg width="15" height="15" viewBox="0 0 16 16" aria-hidden="true">
      <path
        d="M2.7 4.15h6.1M2.7 7.05h3.15"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.35"
        strokeLinecap="round"
      />
      <path
        d="M2.7 4.15V12.2c0 .55.45 1 1 1h5.05"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.35"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
      <path
        d="M8.55 10.15 12.7 6a1.05 1.05 0 0 0-1.48-1.48L7.07 8.67l-.62 2.1 2.1-.62Z"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.35"
        strokeLinejoin="round"
      />
    </svg>
  );
}

export function CloseIcon() {
  return (
    <svg width="12" height="12" viewBox="0 0 16 16" aria-hidden="true">
      <path d="M4 4l8 8M12 4l-8 8" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
    </svg>
  );
}

export function SearchIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 16 16" aria-hidden="true">
      <circle cx="7" cy="7" r="4.6" fill="none" stroke="currentColor" strokeWidth="1.6" />
      <path d="M10.4 10.4 14 14" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
    </svg>
  );
}

export function ClockIcon() {
  return (
    <svg width="15" height="15" viewBox="0 0 16 16" aria-hidden="true">
      <circle cx="8" cy="8" r="5.6" fill="none" stroke="currentColor" strokeWidth="1.4" />
      <path d="M8 5v3.2l2.1 1.3" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

export function HandIcon() {
  return (
    <svg width="15" height="15" viewBox="0 0 16 16" aria-hidden="true">
      <path
        d="M5 8V3.6a1 1 0 0 1 2 0V7M7 7V2.8a1 1 0 0 1 2 0V7M9 7V3.6a1 1 0 0 1 2 0v5.2M5 8.2 3.9 7.1a1 1 0 0 0-1.5 1.3l2.3 3.4A4 4 0 0 0 8 13.5h.2A2.8 2.8 0 0 0 11 10.7V8.8"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.4"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

export function PlusIcon() {
  return (
    <svg width="15" height="15" viewBox="0 0 16 16" aria-hidden="true">
      <path d="M8 3.2v9.6M3.2 8h9.6" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
    </svg>
  );
}
