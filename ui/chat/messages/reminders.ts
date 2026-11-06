const BLOCK = /<(system-reminder|task-notification)>([\s\S]*?)<\/\1>/gi;
const OPENING = /<(system-reminder|task-notification)>/i;
const NOTIFICATION = /<task-notification>([\s\S]*?)<\/task-notification>/gi;

export interface TaskNotice {
  title: string;
  tone: "ok" | "fail" | "quiet";
  detail: string;
}

export interface UserMessageView {
  spoken: string;
  notice: TaskNotice | null;
  harnessOnly: boolean;
}

// A harness note arrives as a user-role chunk. Task completions become a short chip.
// Any other note that is the whole message stays out of the thread.
export function userMessageView(text: unknown): UserMessageView {
  const raw = typeof text === "string" ? text : "";
  if (!OPENING.test(raw)) {
    return { spoken: raw.trim(), notice: null, harnessOnly: false };
  }
  const notices: (TaskNotice | null)[] = [];
  const spoken = raw
    .replace(BLOCK, (_, tag: string, body: string | undefined) => {
      const inner = String(body || "").trim();
      notices.push(tag.toLowerCase() === "task-notification" ? notificationNotice(inner) : reminderNotice(inner));
      return "";
    })
    .trim();
  const notice = notices.find(Boolean) || null;
  return { spoken, notice, harnessOnly: spoken.length === 0 && notices.length > 0 };
}

// A system reminder can carry Claude Code's task notes inside it.
function reminderNotice(body: string): TaskNotice | null {
  const nested = [...body.matchAll(NOTIFICATION)].map((found) => notificationNotice(String(found[1] || "").trim()));
  return nested.find(Boolean) || taskNotice(body);
}

// Claude Code's note: <status> is completed, failed, killed or stopped, and <summary> names the task in quotes,
// as in: Background command "Wait 20 seconds" completed (exit code 0).
// A subagent's note gets no chip: its row in the thread shows how it ended.
function notificationNotice(body: string): TaskNotice | null {
  const status = tagText(body, "status");
  const summary = tagText(body, "summary");
  const named = summary.match(/^([A-Za-z ]+?) "(.*?)" (?:completed|failed|finished|was |stream ended|ended|script failed|stopped)/);
  const kind = named?.[1] ?? "";
  if (kind === "Agent") return null;
  const outcome = kind === "Monitor" ? { title: "Monitor ended", tone: "quiet" as const } : notificationOutcome(status, summary);
  if (!outcome) return null;
  return { ...outcome, detail: clip(named?.[2] ?? summary) };
}

function notificationOutcome(status: string, summary: string): Outcome | null {
  if (status === "completed") {
    const exit = summary.match(/\(exit code (-?\d+)/);
    return exit && exit[1] !== "0" ? { title: "Task failed", tone: "fail" } : { title: "Task completed", tone: "ok" };
  }
  if (status === "failed") return { title: "Task failed", tone: "fail" };
  if (status === "killed" || status === "stopped") return { title: "Task stopped", tone: "quiet" };
  return null;
}

function tagText(body: string, tag: string): string {
  const found = body.match(new RegExp(`<${tag}>([\\s\\S]*?)</${tag}>`, "i"));
  return unescapeXml(found?.[1] ?? "").trim();
}

function unescapeXml(text: string): string {
  return text.replace(/&(lt|gt|quot|apos|amp);/g, (_, name: string) => ({ lt: "<", gt: ">", quot: '"', apos: "'", amp: "&" })[name] ?? "");
}

function taskNotice(body: string): TaskNotice | null {
  const lines = body.split("\n").map((line) => line.trim()).filter(Boolean);
  if (lines[0]?.startsWith("Background task ") && !/completed \(/.test(lines[0]) && /^completed \(/.test(lines[1] || "")) {
    lines[0] = `${lines[0]} ${lines[1]}`;
    lines.splice(1, 1);
  }
  const head = lines[0] || "";
  const task = head.match(/^Background task "[^"]*" completed \((.*)\)\.$/);
  const monitor = head.match(/^Monitor "[^"]*" ended:/);
  if (!task && !monitor) return null;
  const meta = metaOf(lines.slice(1));
  const outcome: Outcome = task ? taskOutcome(task[1] ?? "") : { title: "Monitor ended", tone: "quiet" };
  return {
    title: outcome.title,
    tone: outcome.tone,
    detail: [clip(meta.name), meta.duration].filter(Boolean).join(" · "),
  };
}

type Outcome = Pick<TaskNotice, "title" | "tone">;

function taskOutcome(outcome: string): Outcome {
  const exit = outcome.match(/^exit code: (-?\d+)$/);
  if (exit) return exit[1] === "0"
    ? { title: "Task completed", tone: "ok" }
    : { title: "Task failed", tone: "fail" };
  if (outcome.startsWith("terminated by signal")) return { title: "Task stopped", tone: "quiet" };
  return { title: "Task completed", tone: "ok" };
}

function metaOf(lines: string[]): { name: string; duration: string } {
  let name = "";
  let duration = "";
  for (const line of lines) {
    const described = splitField(line, "Description: ");
    const commanded = described ? null : splitField(line, "Command: ");
    const field = described || commanded;
    if (!field) continue;
    if (!name) name = field.text;
    if (field.duration) duration = field.duration;
  }
  return { name, duration };
}

function splitField(line: string, prefix: string): { text: string; duration: string } | null {
  if (!line.startsWith(prefix)) return null;
  const rest = line.slice(prefix.length);
  const mark = rest.lastIndexOf(" | Duration: ");
  if (mark < 0) return { text: rest.trim(), duration: "" };
  return { text: rest.slice(0, mark).trim(), duration: rest.slice(mark + " | Duration: ".length).trim() };
}

function clip(value: string): string {
  const text = String(value || "").replace(/\s+/g, " ").trim();
  if (text.length <= 120) return text;
  return `${text.slice(0, 119)}…`;
}
