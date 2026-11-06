// The pull request of a folder's current branch, read with the GitHub CLI.

import { execFile } from "node:child_process";
import { isRecord } from "../../bridge/lenient.ts";
import type { ExecFile } from "./folderGit.ts";
import { toolText, type McpGroup } from "../mcp/mcp.ts";

export type PullStatus = "merged" | "closed" | "conflict" | "failing" | "running" | "draft" | "blocked" | "behind" | "checking" | "ready";

export interface PullRequest {
  number: number;
  url: string;
  title: string;
  head: string;
  // The local branch when it tracks head under another name.
  branch?: string;
  base: string;
  // owner/name of the repository the pull request targets, which a fork's origin is not.
  repo: string;
  status: PullStatus;
  review: string;
  failing: string[];
  pending: string[];
}

const FIELDS = "number,url,title,state,isDraft,mergeable,mergeStateStatus,reviewDecision,headRefName,baseRefName,statusCheckRollup";
// A cancelled run, or one waiting for approval, is not broken code, so it does not count.
const FAILED = new Set(["FAILURE", "ERROR", "TIMED_OUT", "STARTUP_FAILURE"]);

// null when gh is missing or the branch has no pull request. Any other failure, such as being offline or
// signed out, rejects, so the caller can keep what it showed.
export async function readPullRequest(cwd: string, run: ExecFile = execFile): Promise<PullRequest | null> {
  const found = await viewPullRequest(cwd, [], run);
  if (found !== undefined) return found;
  // gh looks up the local branch name, which misses a PR whose head is an upstream branch of another name.
  const upstream = await renamedUpstream(cwd, run);
  if (!upstream) return null;
  const pr = await viewPullRequest(cwd, [upstream.head], run);
  return pr ? { ...pr, branch: upstream.branch } : null;
}

// undefined when gh finds no pull request for the branch.
function viewPullRequest(cwd: string, branch: string[], run: ExecFile): Promise<PullRequest | null | undefined> {
  return new Promise((resolve, reject) => {
    // gh has no -C and reads the branch from its working directory.
    run("gh", ["pr", "view", ...branch, "--json", FIELDS], { timeout: 20000, cwd }, (error, stdout, stderr) => {
      if (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") resolve(null);
        else if (/no pull requests? found/i.test(String(stderr))) resolve(undefined);
        else reject(new Error(String(stderr || error.message).trim() || "gh failed"));
        return;
      }
      try {
        resolve(presentPullRequest(JSON.parse(String(stdout))));
      } catch {
        resolve(null);
      }
    });
  });
}

function renamedUpstream(cwd: string, run: ExecFile): Promise<{ branch: string; head: string } | null> {
  return new Promise((resolve) => {
    run("git", ["rev-parse", "--abbrev-ref", "--symbolic-full-name", "HEAD", "@{u}"], { timeout: 5000, cwd }, (error, stdout) => {
      const [branch, upstream] = String(stdout).trim().split("\n");
      // shortcut: assumes the remote name has no slash, which git allows but is rare.
      const head = upstream?.slice(upstream.indexOf("/") + 1);
      resolve(!error && branch && head && head !== branch ? { branch, head } : null);
    });
  });
}

// Names from GitHub go into the agent's prompt, so each is one short line.
function oneLine(value: unknown): string {
  // eslint-disable-next-line no-control-regex -- newlines and other control characters would break the prompt
  return String(value ?? "").replace(/[\u0000-\u001f\u007f]+/g, " ").trim().slice(0, 120);
}

export function presentPullRequest(data: unknown): PullRequest | null {
  if (!isRecord(data) || typeof data.number !== "number" || typeof data.url !== "string") return null;
  const failing = new Set<string>();
  const pending = new Set<string>();
  for (const check of Array.isArray(data.statusCheckRollup) ? data.statusCheckRollup.filter(isRecord) : []) {
    const name = oneLine(check.name || check.context || "Check");
    // A CheckRun has status and conclusion, a StatusContext only state.
    const result = String(check.conclusion || check.state || "");
    if (FAILED.has(result)) failing.add(name);
    else if ((check.status && check.status !== "COMPLETED") || result === "PENDING" || result === "EXPECTED") pending.add(name);
  }
  return {
    number: data.number,
    url: data.url,
    title: oneLine(data.title),
    head: oneLine(data.headRefName),
    base: oneLine(data.baseRefName),
    repo: data.url.match(/^https?:\/\/[^/]+\/([^/]+\/[^/]+)\/pull\//)?.[1] ?? "",
    // mergeable only says whether the commits merge cleanly. mergeStateStatus adds required reviews and
    // an out-of-date branch, and is UNKNOWN while GitHub still computes it.
    status:
      data.state === "MERGED" ? "merged"
      : data.state === "CLOSED" ? "closed"
      : data.mergeable === "CONFLICTING" || data.mergeStateStatus === "DIRTY" ? "conflict"
      : failing.size ? "failing"
      : pending.size ? "running"
      : data.isDraft ? "draft"
      : data.mergeStateStatus === "BLOCKED" ? "blocked"
      : data.mergeStateStatus === "BEHIND" ? "behind"
      : data.mergeable === "UNKNOWN" || data.mergeStateStatus === "UNKNOWN" ? "checking"
      : "ready",
    review: String(data.reviewDecision || ""),
    failing: [...failing],
    pending: [...pending],
  };
}

const PR_TOOL_SPEC = {
  name: "pr_status",
  title: "Pull request status",
  description:
    "The pull request of this chat's current branch on GitHub: number, url, base, the repository it targets, status (ready, draft, running, failing, conflict, blocked by a required review or rule, behind its base, checking while GitHub computes mergeability, merged, closed), the review decision, and the names of failing and pending checks.",
  inputSchema: { type: "object", properties: {}, additionalProperties: false },
  annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
};

export function pullRequestTools(cwdOf: (sessionId: string) => string | null, read = readPullRequest): McpGroup {
  return {
    instructions: "pr_status of the x_bench MCP server reports the pull request of this chat's branch: checks and merge conflicts.",
    tools: [
      {
        spec: PR_TOOL_SPEC,
        trusted: true,
        async call(_args, { sessionId }) {
          const cwd = sessionId ? cwdOf(sessionId) : null;
          if (!cwd) return toolText("This chat has no folder.", true);
          try {
            const pr = await read(cwd);
            return toolText(pr ? JSON.stringify(pr) : "This branch has no pull request, or gh is not installed.");
          } catch (error) {
            return toolText(`gh could not read the pull request: ${error instanceof Error ? error.message : String(error)}`, true);
          }
        },
      },
    ],
  };
}
