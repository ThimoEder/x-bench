// When a written plan opens the review dock's Plan tab. Only a plan that first appears while its session
// is in view and running does: the agent is writing it now. A session switched to, or reloaded, shows the
// plans it already had without taking the dock away from what the person looks at.

export interface PlanTabMemory {
  // The session the dock showed last time.
  session: string | null;
  // The plan ids the dock has seen, per session.
  seen: Map<string, Set<string>>;
}

export function planTabMemory(): PlanTabMemory {
  return { session: null, seen: new Map() };
}

// True when this plan should open the Plan tab. Call it whenever the session or its plan id changes.
export function planOpensTab(memory: PlanTabMemory, sessionId: string, planId: string | null, running: boolean): boolean {
  const switched = memory.session !== sessionId;
  memory.session = sessionId;
  let seen = memory.seen.get(sessionId);
  if (!seen) {
    seen = new Set();
    memory.seen.set(sessionId, seen);
  }
  if (!planId || seen.has(planId)) return false;
  seen.add(planId);
  return !switched && running;
}
