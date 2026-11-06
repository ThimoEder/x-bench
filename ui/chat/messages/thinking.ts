// What the thinking window shows while a model thinks.
//
// Claude sends a running summary: the window shows its newest sentences. Codex (ChatGPT) sends only a
// bold heading per reasoning step ("**Checking carry equations**"), a new one every few seconds: the
// window shows those as a short list of steps, the newest one last.

// The steps of a thought made only of bold headings, one per paragraph. null for any other thought.
export function thinkingSteps(text: string | null | undefined): string[] | null {
  const paragraphs = String(text || "").split(/\n\s*\n/).map((part) => part.trim()).filter(Boolean);
  if (!paragraphs.length) return null;
  const steps: string[] = [];
  for (const paragraph of paragraphs) {
    const heading = /^\*\*([^*\n]+?)\*\*$/.exec(paragraph)?.[1]?.trim().replace(/\.$/, "");
    if (!heading) return null;
    steps.push(heading);
  }
  return steps;
}

// Whether the preview shows its text as written, not as Markdown with math: when it holds a fence marker, or
// the thought has a fence still open. Flattened to a few lines, code would read as Markdown, and a shell's
// $$ as math.
export function previewAsWritten(thought: string | null | undefined, preview: string): boolean {
  if (preview.includes("```")) return true;
  return (String(thought || "").match(/```/g)?.length ?? 0) % 2 === 1;
}

// The last sentences of a thought, about three lines' worth, starting at a sentence where one starts.
export function latestThinking(text: string | null | undefined, max = 240): string {
  const flat = String(text || "").replace(/\s+/g, " ").trim();
  if (flat.length <= max) return flat;
  const tail = flat.slice(-max);
  const start = tail.search(/[.!?:]\s+\S/);
  if (start >= 0 && start < tail.length - 60) return tail.slice(start + 1).trim();
  return `… ${tail.slice(tail.indexOf(" ") + 1)}`;
}
