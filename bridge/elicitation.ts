// A form the agent asks the person to fill in (ACP elicitation/create, form mode), as fields the page can draw.
// Claude's AskUserQuestion, Codex's request_user_input and an MCP server's questions all arrive this way.

import { z } from "zod";
import { fields, isRecord, listOf, maybe } from "./lenient.ts";

export type FormValue = string | number | boolean | string[];

export const FormAnswers = z.record(z.string(), z.union([z.string(), z.number(), z.boolean(), z.array(z.string())]));

export interface FormChoice {
  value: string;
  label: string;
  description: string;
  // Markdown, such as a mockup or code snippet.
  preview?: string;
}

export interface FormField {
  key: string;
  kind: "choice" | "multi" | "text" | "number" | "integer" | "boolean";
  // With both, title is the short name and description the full question. Alone, title is the question.
  title: string;
  description: string;
  required: boolean;
  options: FormChoice[];
  secret: boolean;
  default: FormValue | null;
  // The choice whose answer this text box is when nothing is picked there.
  answerFor: string | null;
}

// An answer the harness offers beside accept and decline, such as Grok's "chat about this".
export interface QuestionAction {
  id: string;
  label: string;
}

const PREVIEW_KEY = "_claude/askUserQuestionOption";

const Choice = z.object({
  const: z.union([z.string(), z.number()]),
  title: maybe(z.string()),
  description: maybe(z.string()),
  _meta: maybe(z.looseObject({ [PREVIEW_KEY]: maybe(z.looseObject({ preview: maybe(z.string()) })) })),
});

const Property = fields({
  type: maybe(z.string()),
  title: maybe(z.string()),
  description: maybe(z.string()),
  oneOf: maybe(listOf(Choice)),
  enum: maybe(listOf(z.union([z.string(), z.number()]))),
  enumNames: maybe(listOf(z.string())),
  items: maybe(
    fields({
      anyOf: maybe(listOf(Choice)),
      enum: maybe(listOf(z.union([z.string(), z.number()]))),
    }),
  ),
  default: maybe(z.union([z.string(), z.number(), z.boolean(), z.array(z.string())])),
  _meta: maybe(
    z.looseObject({
      codex: maybe(z.looseObject({ isSecret: maybe(z.boolean()), questionId: maybe(z.string()) })),
      jetbrains: maybe(z.looseObject({ air: maybe(z.looseObject({ customAnswer: maybe(z.unknown()) })) })),
    }),
  ),
});

const Schema = fields({
  properties: maybe(z.record(z.string(), z.unknown())),
  required: maybe(listOf(z.string())),
});

export function formFields(schema: unknown): FormField[] {
  const parsed = Schema.parse(schema);
  const required = new Set(parsed.required ?? []);
  return Object.entries(parsed.properties ?? {}).flatMap(([key, raw]) => {
    const field = formField(key, Property.parse(raw), required.has(key));
    return field ? [field] : [];
  });
}

function formField(key: string, property: z.output<typeof Property>, required: boolean): FormField | null {
  const kind = kindOf(property);
  if (!kind) return null;
  let title = property.title ?? "";
  let description = property.description ?? "";
  // Codex puts the question in title and its short header in description.
  if (property._meta?.codex && title && description) [title, description] = [description, title];
  if (!title) [title, description] = [description || key, ""];
  const options =
    kind === "choice" ? choices(property.oneOf, property.enum, property.enumNames)
    : kind === "multi" ? choices(property.items?.anyOf, property.items?.enum)
    : [];
  return {
    key,
    kind,
    title,
    description,
    required,
    options,
    secret: property._meta?.codex?.isSecret === true,
    default: property.default ?? null,
    // Codex's note box. With nothing picked, Codex reads the typed answer from the choice itself.
    answerFor: property._meta?.jetbrains?.air?.customAnswer === true ? (property._meta.codex?.questionId ?? null) : null,
  };
}

function kindOf(property: z.output<typeof Property>): FormField["kind"] | null {
  switch (property.type) {
    case "string":
      return property.oneOf?.length || property.enum?.length ? "choice" : "text";
    case "array":
      return property.items?.anyOf?.length || property.items?.enum?.length ? "multi" : null;
    case "number":
    case "integer":
    case "boolean":
      return property.type;
    default:
      return null;
  }
}

function choices(
  titled: z.output<typeof Choice>[] | undefined,
  plain: (string | number)[] | undefined,
  names: string[] = [],
): FormChoice[] {
  if (titled?.length) {
    return titled.map((choice) => {
      const preview = choice._meta?.[PREVIEW_KEY]?.preview;
      return {
        value: String(choice.const),
        label: choice.title || String(choice.const),
        description: choice.description ?? "",
        ...(preview ? { preview } : {}),
      };
    });
  }
  return (plain ?? []).map((value, index) => ({ value: String(value), label: names[index] || String(value), description: "" }));
}

// The page's answer, kept to the form's own fields and types. A typed answer fills its empty choice.
export function formContent(form: FormField[], content: unknown): Record<string, FormValue> {
  const answer: Record<string, FormValue> = {};
  if (!isRecord(content)) return answer;
  for (const field of form) {
    const value = valueFor(field, content[field.key]);
    if (value !== null) answer[field.key] = value;
  }
  for (const field of form) {
    const text = answer[field.key];
    if (field.answerFor && typeof text === "string" && !(field.answerFor in answer)) {
      answer[field.answerFor] = text.trim();
      delete answer[field.key];
    }
  }
  return answer;
}

function valueFor(field: FormField, value: unknown): FormValue | null {
  const allowed = new Set(field.options.map((option) => option.value));
  switch (field.kind) {
    case "choice":
      return typeof value === "string" && allowed.has(value) ? value : null;
    case "multi": {
      if (!Array.isArray(value)) return null;
      const picks = value.filter((item): item is string => typeof item === "string" && allowed.has(item));
      return picks.length ? [...new Set(picks)] : null;
    }
    case "text":
      return typeof value === "string" && value.trim() ? value : null;
    case "number":
    case "integer": {
      const number = typeof value === "number" ? value : typeof value === "string" && value.trim() ? Number(value) : NaN;
      if (!Number.isFinite(number)) return null;
      return field.kind === "integer" ? Math.trunc(number) : number;
    }
    case "boolean":
      return typeof value === "boolean" ? value : null;
  }
}
