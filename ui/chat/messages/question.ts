import type { FormField, FormValue } from "../../../bridge/elicitation.ts";

export type FormValues = Record<string, FormValue>;

export function initialValues(fields: FormField[]): FormValues {
  const values: FormValues = {};
  for (const field of fields) {
    if (field.default !== null) values[field.key] = field.default;
    else if (field.kind === "boolean") values[field.key] = false;
  }
  return values;
}

export function isEmpty(value: FormValue | undefined): boolean {
  if (value === undefined) return true;
  if (typeof value === "string") return !value.trim();
  if (Array.isArray(value)) return value.length === 0;
  return false;
}

export function missingAnswer(fields: FormField[], values: FormValues): boolean {
  const typed = (key: string) => fields.some((field) => field.answerFor === key && !isEmpty(values[field.key]));
  return fields.some((field) => field.required && isEmpty(values[field.key]) && !typed(field.key));
}

// A text box right after a list of options is that question's own "Other" answer or note.
export function isCompanion(fields: FormField[], index: number): boolean {
  const field = fields[index];
  const before = fields[index - 1];
  return field?.kind === "text" && !field.required && (before?.kind === "choice" || before?.kind === "multi");
}

// The form one question at a time: each field with its Other box.
export function steps(fields: FormField[]): FormField[][] {
  const grouped: FormField[][] = [];
  fields.forEach((field, index) => {
    if (isCompanion(fields, index)) grouped.at(-1)?.push(field);
    else grouped.push([field]);
  });
  return grouped;
}

// The one field, when the form is a single pick with no Other box, so choosing an option answers right away.
export function soleChoice(fields: FormField[]): FormField | null {
  const only = fields[0];
  // A pick with a preview waits for Submit, so picking can show each preview first.
  return fields.length === 1 && only?.kind === "choice" && !only.options.some((option) => option.preview) ? only : null;
}

// A single pick: picking the chosen option again clears it.
export function choose(values: FormValues, key: string, value: string): FormValues {
  const { [key]: current, ...rest } = values;
  return current === value ? rest : { ...rest, [key]: value };
}

export function toggle(values: FormValues, key: string, value: string): FormValues {
  const current = values[key];
  const picks = Array.isArray(current) ? current : [];
  return { ...values, [key]: picks.includes(value) ? picks.filter((item) => item !== value) : [...picks, value] };
}
