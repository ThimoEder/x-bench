// Grok's ask_user_question (_x.ai/ask_user_question): its questions as the question card's fields, and the
// card's answer in the shape Grok reads back.

import { z } from "zod";
import { formContent, type FormField, type QuestionAction } from "../elicitation.ts";
import { fields, listOf, maybe } from "../lenient.ts";

const Option = z.object({ label: z.string(), description: maybe(z.string()) });

const Question = z.object({
  question: z.string(),
  header: maybe(z.string()),
  options: listOf(Option),
  multiSelect: maybe(z.boolean().nullable()),
});

export const AskParams = fields({
  sessionId: maybe(z.string()),
  questions: maybe(listOf(Question)),
  mode: maybe(z.string()),
});

export type GrokQuestion = z.output<typeof Question>;

export interface GrokQuestionForm {
  message: string;
  fields: FormField[];
  actions: QuestionAction[];
}

const CHAT: QuestionAction = { id: "chat_about_this", label: "Chat about this" };
// Grok tells the model to stop asking and finish its plan, so it only fits plan mode.
const SKIP_INTERVIEW: QuestionAction = { id: "skip_interview", label: "Skip interview" };

export function grokQuestionForm(questions: GrokQuestion[], mode: string | undefined): GrokQuestionForm {
  const single = questions.length === 1;
  const form = questions.flatMap((question, index): FormField[] => {
    const multi = question.multiSelect === true;
    return [
      {
        key: pickKey(index),
        kind: multi ? "multi" : "choice",
        title: question.header ?? "",
        description: single ? "" : question.question,
        required: false,
        options: question.options.map((option) => ({ value: option.label, label: option.label, description: option.description ?? "" })),
        secret: false,
        default: null,
        answerFor: null,
      },
      {
        key: otherKey(index),
        kind: "text",
        title: "Other",
        description: multi ? "Your own answer, added to your picks." : "Your own answer, or a note on your pick.",
        required: false,
        options: [],
        secret: false,
        default: null,
        answerFor: null,
      },
    ];
  });
  return {
    message: single ? (questions[0]?.question ?? "") : "",
    fields: form,
    actions: mode === "plan" ? [CHAT, SKIP_INTERVIEW] : [CHAT],
  };
}

// A single pick with text typed in Other keeps the pick and sends the text as its note. With no pick, the text is the answer.
export function grokQuestionReply(questions: GrokQuestion[], form: FormField[], action: string, content?: unknown): unknown {
  if (action !== "accept" && action !== CHAT.id && action !== SKIP_INTERVIEW.id) return { outcome: "cancelled" };
  const filled = formContent(form, content);
  const answers: Record<string, string | string[]> = {};
  const annotations: Record<string, { notes: string }> = {};
  questions.forEach((question, index) => {
    const pick = filled[pickKey(index)];
    const other = filled[otherKey(index)];
    const text = typeof other === "string" ? other.trim() : "";
    if (question.multiSelect === true) {
      const picks = [...(Array.isArray(pick) ? pick : []), ...(text ? [text] : [])];
      if (picks.length) answers[question.question] = picks;
      return;
    }
    if (typeof pick === "string") {
      answers[question.question] = pick;
      if (text) annotations[question.question] = { notes: text };
    } else if (text) {
      answers[question.question] = text;
    }
  });
  if (action !== "accept") return { outcome: action, partial_answers: answers };
  return { outcome: "accepted", answers, ...(Object.keys(annotations).length ? { annotations } : {}) };
}

function pickKey(index: number) {
  return `question_${index}`;
}

function otherKey(index: number) {
  return `question_${index}_custom`;
}
