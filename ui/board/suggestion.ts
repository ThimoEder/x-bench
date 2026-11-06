export interface GhostInput {
  suggestion: string | null | undefined;
  draft: string;
  running: boolean;
  attachments: number;
  recording: boolean;
}

// Ghost text for the empty composer. The line comes from the agent after a turn.
export function composerGhost({ suggestion, draft, running, attachments, recording }: GhostInput): string {
  if (running || recording || draft || attachments) return "";
  if (typeof suggestion !== "string") return "";
  const text = suggestion.trim();
  return text;
}
