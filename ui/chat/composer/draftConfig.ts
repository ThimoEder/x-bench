import type { PresentedOption, PresentedSession } from "../../../server/present.ts";
import type { ComposerCatalog, ComposerModel, Snapshot } from "../../../server/snapshot.ts";

// What a new chat's pickers have chosen so far.
// model is the catalog value, "<provider>:<model>".
export interface DraftPicks {
  model?: string;
  effort?: string;
}

export interface EffortMemory {
  seeded: boolean;
  seen: Record<string, string>;
  last: string;
}

// A new chat has no session yet, so the model menus are built from the
// catalog of every enabled provider's models the server read. A pick replaces the recommended effort until send.
// The fallback covers a server that has not republished the catalog yet.
export const fallbackCatalog: ComposerCatalog = {
  defaultModel: "grok:grok-4.7",
  defaultEffort: "high",
  models: [
    {
      value: "grok:grok-4.7",
      name: "Grok 4.7",
      provider: "grok",
      model: "grok-4.7",
      group: "Grok",
      defaultEffort: "high",
      efforts: [
        { value: "xhigh", name: "Extra High" },
        { value: "high", name: "High" },
        { value: "medium", name: "Medium" },
        { value: "low", name: "Low" },
      ],
    },
    {
      value: "grok:grok-4.7-build-fast",
      name: "Grok 4.7 Fast",
      provider: "grok",
      model: "grok-4.7-build-fast",
      group: "Grok",
      defaultEffort: "high",
      efforts: [
        { value: "xhigh", name: "Extra High" },
        { value: "high", name: "High" },
        { value: "medium", name: "Medium" },
        { value: "low", name: "Low" },
      ],
    },
    {
      value: "grok:grok-4.6",
      name: "Grok 4.6",
      provider: "grok",
      model: "grok-4.6",
      group: "Grok",
      defaultEffort: "high",
      efforts: [
        { value: "xhigh", name: "Extra High" },
        { value: "high", name: "High" },
        { value: "medium", name: "Medium" },
        { value: "low", name: "Low" },
      ],
    },
    {
      value: "grok:grok-4.5",
      name: "Grok 4.5",
      provider: "grok",
      model: "grok-4.5",
      group: "Grok",
      defaultEffort: "high",
      efforts: [
        { value: "high", name: "High" },
        { value: "medium", name: "Medium" },
        { value: "low", name: "Low" },
      ],
    },
  ],
};

// The page's first snapshot is empty until the server publishes. The fallback is Grok's own list,
// so it stands in only while Grok is on: with every provider off, a new chat has no models.
export function catalogFor(snapshot: Partial<Snapshot> | null | undefined): ComposerCatalog {
  if (snapshot?.composer?.models?.length) return snapshot.composer;
  const providers = snapshot?.providers ?? [];
  if (providers.length && !providers.some((provider) => provider.id === "grok" && provider.enabled)) {
    return { defaultModel: "", defaultEffort: "", models: [] };
  }
  return fallbackCatalog;
}

// The fields an effort is read from.
type EffortSource = {
  id?: string;
  configOptions?: readonly Pick<PresentedOption, "id" | "currentValue">[] | null;
  reasoningEffort?: string | null;
};

export function sessionEffort(session: EffortSource | null | undefined): string {
  const option = (session?.configOptions || []).find((item) => item.id === "effort");
  // Effort is a select option, so its value is a string.
  if (typeof option?.currentValue === "string" && option.currentValue) return option.currentValue;
  return session?.reasoningEffort || "";
}

// Every snapshot arrives as a fresh array. The stamp changes only when an open
// session or its effort does, so App does not reset the effort memory per message.
export function effortStamp(sessions: readonly (EffortSource | null | undefined)[] | null | undefined): string {
  return (sessions || []).map((session) => `${session?.id || ""}\0${sessionEffort(session)}`).join("\n");
}

// The recommended effort is the model's own default. While the app is open,
// the effort last chosen on a chat replaces it for the next new session.
export function rememberEffort(
  memory: EffortMemory | null | undefined,
  sessions: readonly Partial<PresentedSession>[] | null | undefined,
  focusId: string | null | undefined,
): EffortMemory {
  const seen = { ...(memory?.seen || {}) };
  let last = memory?.last || "";
  const fresh = !memory?.seeded;
  let changed = "";
  for (const session of sessions || []) {
    if (!session?.id) continue;
    const effort = sessionEffort(session);
    if (!effort) continue;
    const previous = seen[session.id];
    seen[session.id] = effort;
    if (previous !== undefined && previous !== effort) changed = effort;
  }
  if (fresh) {
    const list = sessions || [];
    if (!list.length) return { seeded: false, seen, last };
    const focus = list.find((session) => session.id === focusId) || list[0];
    const effort = sessionEffort(focus);
    if (effort) last = effort;
  } else if (changed) {
    last = changed;
  }
  return { seeded: true, seen, last };
}

export function noteEffort(memory: EffortMemory | null | undefined, effort: string | null | undefined): EffortMemory {
  if (!effort) return memory || { seeded: false, seen: {}, last: "" };
  return { seeded: true, seen: memory?.seen || {}, last: effort };
}

export function withMemory(picks: DraftPicks | null | undefined, effort: string, model: string): DraftPicks {
  const next: DraftPicks = { ...(picks || {}) };
  if (!next.model && model) next.model = model;
  if (!next.effort && effort) next.effort = effort;
  return next;
}

// The picks after one menu changed. A new model drops a picked effort it does not offer.
export function withPick(catalog: Partial<ComposerCatalog> | null | undefined, picks: DraftPicks | null | undefined, id: string, value: string): DraftPicks {
  const next: DraftPicks = { ...(picks || {}), [id]: value };
  if (id === "model") {
    const model = (catalog?.models || []).find((item) => item.value === value);
    const allowed = new Set((model?.efforts || []).map((item) => item.value));
    if (next.effort && !allowed.has(next.effort)) delete next.effort;
  }
  return next;
}

export function composerOptions(
  catalog: Partial<ComposerCatalog> | null | undefined,
  picks: DraftPicks | null | undefined = {},
): PresentedOption[] {
  const models: ComposerModel[] = catalog?.models || [];
  if (!models.length) return [];
  const requested = picks?.model;
  const model = models.find((item) => item.value === requested)
    || models.find((item) => item.value === catalog?.defaultModel)
    || models[0];
  if (model === undefined) return [];
  const efforts = model.efforts || [];
  const requestedEffort = picks?.effort;
  let effort: string;
  if (typeof requestedEffort === "string" && efforts.some((item) => item.value === requestedEffort)) effort = requestedEffort;
  else if (efforts.some((item) => item.value === model.defaultEffort)) effort = model.defaultEffort;
  else effort = efforts[0]?.value || "";
  const options: PresentedOption[] = [{
    id: "model",
    name: "Model",
    currentValue: model.value,
    options: models.map((item) => ({ value: item.value, name: item.name, group: item.group, ...(item.older ? { older: true } : {}) })),
  }];
  if (efforts.length && effort) {
    options.push({
      id: "effort",
      name: "Effort",
      currentValue: effort,
      options: efforts.map((item) => ({ value: item.value, name: item.name })),
    });
  }
  return options;
}

// What /api/session needs to open the draft: the provider of the picked model, the model id that
// provider knows, and the effort shown.
export function draftChoice(
  catalog: Partial<ComposerCatalog> | null | undefined,
  picks: DraftPicks | null | undefined,
): { provider: string; model: string; effort: string } | null {
  const options = composerOptions(catalog, picks);
  const value = options.find((option) => option.id === "model")?.currentValue;
  const model = (catalog?.models || []).find((item) => item.value === value);
  if (!model) return null;
  const effort = options.find((option) => option.id === "effort")?.currentValue;
  return { provider: model.provider, model: model.model, effort: typeof effort === "string" ? effort : "" };
}
