// The model menu of a chat lists every enabled provider. The chat's own models come first under its provider's
// name; picking another provider's model switches the chat to that provider after a confirmation.

import type { PresentedOption } from "../../../server/present.ts";
import type { ComposerCatalog } from "../../../server/snapshot.ts";

const SWITCH = "switch:";

export interface SwitchChoice {
  provider: string;
  model: string;
  // The model's name and its provider's, for the confirmation.
  name: string;
  label: string;
}

// The session's model option with every other enabled provider's models after its own.
export function withOtherProviders(option: PresentedOption, provider: string, label: string, catalog: Partial<ComposerCatalog> | null | undefined): PresentedOption {
  const others = (catalog?.models || []).filter((item) => item.provider !== provider);
  if (!others.length) return option;
  return {
    ...option,
    options: [
      ...option.options.map((choice) => ({ ...choice, group: label })),
      ...others.map((item) => ({ value: `${SWITCH}${item.provider}:${item.model}`, name: item.name, group: item.group, ...(item.older ? { older: true } : {}) })),
    ],
  };
}

// The other provider's model a menu value names, or null for one of the chat's own.
export function switchChoice(value: string, catalog: Partial<ComposerCatalog> | null | undefined): SwitchChoice | null {
  if (!value.startsWith(SWITCH)) return null;
  const rest = value.slice(SWITCH.length);
  const split = rest.indexOf(":");
  if (split < 0) return null;
  const provider = rest.slice(0, split);
  const model = rest.slice(split + 1);
  const item = (catalog?.models || []).find((entry) => entry.provider === provider && entry.model === model);
  return { provider, model, name: item?.name || model, label: item?.group || provider };
}
