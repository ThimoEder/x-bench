import type { ReactNode } from "react";

function Glyph({ size = 14, stroke = "currentColor", width = 2, children }: { size?: number; stroke?: string; width?: number; children: ReactNode }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke={stroke} strokeWidth={width} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      {children}
    </svg>
  );
}

// A ticket's type: task, bug, story or subtask. Anything else draws as a task.
export function TypeIcon({ type, size = 14 }: { type: string; size?: number }) {
  if (type === "bug") {
    return (
      <Glyph size={size} stroke="var(--danger)">
        <circle cx="12" cy="12" r="8.5" />
        <circle cx="12" cy="12" r="3" fill="var(--danger)" />
      </Glyph>
    );
  }
  if (type === "story") {
    return (
      <Glyph size={size} stroke="var(--ok)">
        <path d="M7 3.5h10a1 1 0 0 1 1 1v16l-6-4-6 4v-16a1 1 0 0 1 1-1z" />
      </Glyph>
    );
  }
  if (type === "subtask") {
    return (
      <Glyph size={size} stroke="var(--status-active)">
        <rect x="3.5" y="3.5" width="17" height="17" rx="4" />
        <rect x="9" y="9" width="6" height="6" rx="1.2" />
      </Glyph>
    );
  }
  return (
    <Glyph size={size} stroke="var(--status-active)">
      <rect x="3.5" y="3.5" width="17" height="17" rx="4" />
      <path d="M8.5 12.2l2.4 2.4 4.8-5.2" />
    </Glyph>
  );
}

export function ExternalIcon() {
  return (
    <Glyph size={13}>
      <path d="M14 4h6v6" />
      <path d="M20 4l-9 9" />
      <path d="M18 14v5a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V7a1 1 0 0 1 1-1h5" />
    </Glyph>
  );
}

export function BackIcon() {
  return (
    <Glyph size={16}>
      <path d="M15 5l-7 7 7 7" />
    </Glyph>
  );
}

// Arrows out to the corners; pointing in, it reads as collapse.
export function ExpandIcon({ inward = false }: { inward?: boolean }) {
  return (
    <Glyph size={14}>
      {inward ? <path d="M4 14h6v6M20 10h-6V4M10 14l-6 6M14 10l6-6" /> : <path d="M14 4h6v6M10 20H4v-6M20 4l-7 7M4 20l7-7" />}
    </Glyph>
  );
}

export function MoreIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
      <circle cx="5" cy="12" r="1.7" />
      <circle cx="12" cy="12" r="1.7" />
      <circle cx="19" cy="12" r="1.7" />
    </svg>
  );
}

export function ChevronIcon() {
  return (
    <Glyph size={12} width={2.4}>
      <path d="M6 9l6 6 6-6" />
    </Glyph>
  );
}

export function PlusIcon({ size = 14 }: { size?: number }) {
  return (
    <Glyph size={size}>
      <path d="M12 5v14M5 12h14" />
    </Glyph>
  );
}

export function ChecklistIcon() {
  return (
    <Glyph size={12}>
      <rect x="3.5" y="3.5" width="17" height="17" rx="3" />
      <path d="m8 12 3 3 5-6" />
    </Glyph>
  );
}

export function CommentIcon({ size = 12 }: { size?: number }) {
  return (
    <Glyph size={size}>
      <path d="M4 5.5h16v11H10l-5 4v-4H4z" />
    </Glyph>
  );
}

export function CalendarIcon({ size = 12 }: { size?: number }) {
  return (
    <Glyph size={size}>
      <rect x="3.5" y="5" width="17" height="15.5" rx="2.5" />
      <path d="M3.5 10h17M8 3v4M16 3v4" />
    </Glyph>
  );
}

export function SubtasksIcon() {
  return (
    <Glyph size={12}>
      <path d="M6 4v11a2 2 0 0 0 2 2h4" />
      <rect x="14" y="13.5" width="7" height="7" rx="1.5" />
      <path d="M6 8h6" />
    </Glyph>
  );
}

export function CheckIcon() {
  return (
    <Glyph size={13} width={2.4}>
      <path d="M5 12.5l4.5 4.5L19 7.5" />
    </Glyph>
  );
}

export function AlertIcon() {
  return (
    <Glyph size={13} width={2.2}>
      <circle cx="12" cy="12" r="9" />
      <path d="M12 7.5v5.5M12 16.5v.01" />
    </Glyph>
  );
}

export function ReloadIcon() {
  return (
    <Glyph size={15}>
      <path d="M20 11a8 8 0 1 0-2.3 5.7" />
      <path d="M20 4v7h-7" />
    </Glyph>
  );
}

export function LockIcon() {
  return (
    <Glyph size={11} width={2.2}>
      <rect x="5" y="11" width="14" height="9.5" rx="2" />
      <path d="M8 11V8a4 4 0 0 1 8 0v3" />
    </Glyph>
  );
}

export function EditIcon() {
  return (
    <Glyph size={12}>
      <path d="M4 20h4L19 9l-4-4L4 16z" />
    </Glyph>
  );
}

export function TrashIcon() {
  return (
    <Glyph size={14}>
      <path d="M4 7h16M10 11v6M14 11v6M6 7l1 13h10l1-13M9 7V4h6v3" />
    </Glyph>
  );
}

export function PriorityIcon({ name }: { name: string }) {
  const level = name.toLowerCase();
  if (/highest|high|critical|blocker|major/.test(level)) {
    return (
      <Glyph stroke="var(--danger)" width={2.4}>
        <path d="M6 15l6-6 6 6" />
      </Glyph>
    );
  }
  if (/lowest|low|minor|trivial/.test(level)) {
    return (
      <Glyph stroke="var(--status-active)" width={2.4}>
        <path d="M6 9l6 6 6-6" />
      </Glyph>
    );
  }
  return (
    <Glyph stroke="var(--attention)" width={2.4}>
      <path d="M5 9h14M5 15h14" />
    </Glyph>
  );
}

export function ChatIcon() {
  return (
    <Glyph>
      <path d="M4 5.5h16v11H10l-5 4v-4H4z" />
    </Glyph>
  );
}

export function LinkIcon() {
  return (
    <Glyph size={12}>
      <path d="M9 15l6-6" />
      <path d="M11 6l.46-.54a5 5 0 0 1 7.07 7.07l-.53.47" />
      <path d="M13 18l-.4.53a5.07 5.07 0 0 1-7.13 0 4.97 4.97 0 0 1 0-7.07l.53-.46" />
    </Glyph>
  );
}

export function SlidersIcon() {
  return (
    <Glyph size={15}>
      <path d="M4 7h9M19 7h1M4 17h1M11 17h9" />
      <circle cx="16" cy="7" r="2.5" />
      <circle cx="8" cy="17" r="2.5" />
    </Glyph>
  );
}

export function EyeIcon({ off = false }: { off?: boolean }) {
  return (
    <Glyph size={15}>
      <path d="M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7S2 12 2 12z" />
      <circle cx="12" cy="12" r="3" />
      {off ? <path d="M4 4l16 16" /> : null}
    </Glyph>
  );
}

export function CollapseIcon() {
  return (
    <Glyph size={14}>
      <path d="M5 6l6 6-6 6M19 6l-6 6 6 6" />
    </Glyph>
  );
}

export function GripIcon() {
  return (
    <Glyph size={14} width={3}>
      <path d="M9 6h.01M15 6h.01M9 12h.01M15 12h.01M9 18h.01M15 18h.01" />
    </Glyph>
  );
}
