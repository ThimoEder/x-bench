import { useRef, useState } from "react";
import { useCloseOutside } from "./useCloseOutside.ts";
import type { PresentedOption } from "../server/present.ts";
import { ProviderMark } from "./chat/messages/providerMark.tsx";
import { CaretIcon, CheckIcon } from "./icons.tsx";
import { leaveRef } from "./leaveRef.ts";

// A menu's open state, which its owner keeps so only one menu is open at a time.
export interface MenuProps<T> {
  open: boolean;
  onToggle: () => void;
  onClose: () => void;
  onChange: (value: T) => void;
}

export interface OptionEntry {
  option: PresentedOption;
  onChange: (value: string) => void;
  // The provider whose mark leads the button.
  mark?: string;
  // A quiet note beside a group's name, and a group whose choices cannot be picked now.
  hint?: (group: string) => string | null;
  locked?: (group: string) => boolean;
  // On/off options shown as switches under this menu's choices.
  switches?: OptionEntry[];
}

// A chip that opens a list of choices: the model, effort and approval menus of the composer, the routine editor
// and the board's new-chat sheet.
export function OptionMenu({ entry, open, onToggle, onClose }: Omit<MenuProps<string>, "onChange"> & { entry: OptionEntry }) {
  const { option, onChange, mark, hint, locked, switches } = entry;
  const root = useRef<HTMLDivElement | null>(null);
  const current = option.options.find((choice) => choice.value === option.currentValue) || option.options[0];

  useCloseOutside(open, root, onClose);

  return (
    <div className={open ? "option-menu open" : "option-menu"} ref={root}>
      <button
        type="button"
        className="option-trigger"
        data-testid={`config-${option.id}`}
        aria-label={option.name}
        aria-haspopup="listbox"
        aria-expanded={open}
        onClick={onToggle}
      >
        {mark ? <ProviderMark provider={mark} /> : null}
        <span>{current?.name || option.name}</span>
        <CaretIcon />
      </button>
      {open ? (
        <ul ref={leaveRef} className="option-list" role="listbox" aria-label={option.name}>
          <li className="option-title" role="presentation">{option.name}</li>
          <ChoiceItems
            option={option}
            hint={hint}
            locked={locked}
            onPick={(value) => {
              onClose();
              if (value !== option.currentValue) onChange(value);
            }}
          />
          {switches?.length ? <SwitchItems switches={switches} /> : null}
        </ul>
      ) : null}
    </div>
  );
}

export function isSwitch(option: PresentedOption) {
  return option.options.length === 2 && option.options.every((choice) => choice.value === "on" || choice.value === "off");
}

// Switches stay in their menu when flipped, so several can change at once.
export function SwitchItems({ switches }: { switches: OptionEntry[] }) {
  return switches.map(({ option, onChange }, index) => {
    const on = option.currentValue === "on";
    return (
      <li key={option.id} className={index ? "option-switch" : "option-switch option-group-start"}>
        <button type="button" role="switch" aria-checked={on} data-testid={`config-${option.id}`} onClick={() => onChange(on ? "off" : "on")}>
          {option.name}
          <span className={on ? "option-switch-track is-on" : "option-switch-track"} aria-hidden="true">
            <span />
          </span>
        </button>
      </li>
    );
  });
}

// An option's choices, each provider's models under its name where there are several, older ones folded until
// asked for. Unmounting folds them again.
export function ChoiceItems({ option, onPick, hint, locked }: { option: PresentedOption; onPick: (value: string) => void } & Pick<OptionEntry, "hint" | "locked">) {
  const [unfolded, setUnfolded] = useState<Set<string>>(() => new Set());
  const groups = groupChoices(option.options);
  const named = groups.length > 1;
  return groups.map(({ group, choices }) => {
    const shown = choices.filter((choice) => !choice.older || choice.value === option.currentValue || unfolded.has(group));
    const folded = choices.length - shown.length;
    return (
      <li key={group || "choices"} className={named ? "option-group-start" : undefined}>
        {named ? (
          <span className="option-group" role="presentation">
            {group}
            {hint?.(group) ? <span className="option-group-hint">{hint(group)}</span> : null}
          </span>
        ) : null}
        <ul className="option-sublist">
          {shown.map((choice) => (
            <li key={choice.value}>
              <button
                type="button"
                role="option"
                aria-selected={choice.value === option.currentValue}
                className={choice.value === option.currentValue ? "active" : ""}
                disabled={locked?.(group) ?? false}
                onClick={() => onPick(choice.value)}
              >
                {choice.name}
                {choice.value === option.currentValue ? <OptionCheck /> : null}
              </button>
            </li>
          ))}
          {folded > 0 ? (
            <li>
              <button
                type="button"
                className="option-more"
                data-testid="more-models"
                onClick={() => setUnfolded((groupsOpen) => new Set(groupsOpen).add(group))}
              >
                More models ({folded})
              </button>
            </li>
          ) : null}
        </ul>
      </li>
    );
  });
}

// Choices in their order, split where the provider group changes.
function groupChoices(choices: PresentedOption["options"]) {
  const groups: { group: string; choices: PresentedOption["options"] }[] = [];
  for (const choice of choices) {
    const group = choice.group || "";
    const last = groups.at(-1);
    if (last && last.group === group) last.choices.push(choice);
    else groups.push({ group, choices: [choice] });
  }
  return groups;
}

// The check on the picked choice.
export function OptionCheck() {
  return (
    <span className="option-check">
      <CheckIcon />
    </span>
  );
}
