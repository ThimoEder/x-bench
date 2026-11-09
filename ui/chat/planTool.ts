// The host's update_plan tool, as harnesses title its rows (mcp__x_bench__update_plan, x_bench.update_plan,
// "X Bench Update Plan"). Its steps show in the plan shelf, so the transcript leaves its rows out. The whole
// title has to be the name: a shell command that mentions the tool keeps its row.
const PLAN_TOOL = /^\s*(?:mcp[_.]+)?x[_\s]bench[_./:\s-]+update[_\s]plan\s*$/i;

export function isPlanTool(title: unknown): boolean {
  return PLAN_TOOL.test(String(title || ""));
}
