import { Fragment, useState } from "react";
import type { KeyboardEvent } from "react";
import type { FormField } from "../../../bridge/elicitation.ts";
import { MarkdownView } from "../markdown/MarkdownView.tsx";
import type { PresentedQuestion } from "../../../server/present.ts";
import { CheckIcon } from "../../icons.tsx";
import { ProviderMark } from "./providerMark.tsx";
import { choose, initialValues, isCompanion, isEmpty, missingAnswer, soleChoice, steps, toggle, type FormValues } from "./question.ts";
import type { ReceiptText } from "./receipts.ts";
import type { SessionCall } from "../Transcript.tsx";

export interface QuestionCardProps {
  question: PresentedQuestion;
  call: SessionCall;
  // The provider's id, for its mark on the card.
  provider?: string;
  onAnswered?: (receipt: ReceiptText) => void;
}

export function QuestionCard({ question, call, provider = "", onAnswered }: QuestionCardProps) {
  const [values, setValues] = useState<FormValues>(() => initialValues(question.fields));
  const [sending, setSending] = useState(false);
  const [step, setStep] = useState(0);
  const fields = question.fields;
  const pages = steps(fields);
  const paged = pages.length > 1;
  const shown = paged ? (pages[step] ?? []) : fields;
  const last = step === pages.length - 1;
  const sole = soleChoice(fields);
  const blocked = sending || missingAnswer(fields, values);
  const main = shown.filter((field) => !isCompanion(fields, fields.indexOf(field)));
  const first = main[0];
  const heading = paged ? questionOf(first) : question.message || questionOf(first);
  const tag = first && (first.kind === "choice" || first.kind === "multi") && first.title !== heading ? first.title : "";

  function answer(action: string, content?: FormValues) {
    if (sending) return;
    setSending(true);
    call("/api/question", { id: question.id, action, ...(content ? { content } : {}) })
      .then(() => onAnswered?.(questionReceipt(question, action, content ?? {})), () => {})
      .finally(() => setSending(false));
  }

  function submit() {
    if (!blocked) answer("accept", values);
  }

  function next() {
    if (!paged || last) submit();
    else if (!missingAnswer(shown, values)) setStep(step + 1);
  }

  function pick(field: FormField, value: string) {
    if (field.kind === "multi") {
      setValues(toggle(values, field.key, value));
      return;
    }
    // A lone pick answers on the click, so it sets the option and never clears it.
    const next = sole === field ? { ...values, [field.key]: value } : choose(values, field.key, value);
    setValues(next);
    if (sole === field && !missingAnswer(fields, next)) answer("accept", next);
  }

  return (
    <section className="card ask question" data-testid="question" aria-live="polite">
      <span className="card-from">
        <QuestionIcon />
        {tag ? <span>{tag}</span> : null}
        {main.some((field) => field.kind === "multi") ? <span>Pick any</span> : null}
        {paged ? (
          <span className="question-step" data-testid="question-step">
            <span className="question-dots" aria-hidden="true">
              {pages.map((_, index) => (
                <span key={index} className={index < step ? "done" : index === step ? "now" : undefined} />
              ))}
            </span>
            {step + 1} / {pages.length}
          </span>
        ) : null}
        <span className="card-asker">
          <ProviderMark provider={provider} />
          asks
        </span>
      </span>
      <div className="card-head">
        <h2>{heading}</h2>
      </div>
      {main.map((field) => {
        const index = fields.indexOf(field);
        const own = isCompanion(fields, index + 1) ? fields[index + 1] : undefined;
        return (
          <div key={field.key} className="question-field" data-testid={`question-${field.key}`}>
            <FieldHeading field={field} heading={heading} />
            <FieldInput field={field} own={own} values={values} sending={sending} onPick={pick} onChange={setValues} onSubmit={next} />
          </div>
        );
      })}
      <div className="card-actions">
        <button type="button" className="btn ghost" data-testid="question-skip" disabled={sending} onClick={() => answer("decline")}>
          {fields.length ? "Skip" : "Decline"}
        </button>
        {question.actions.map((choice) => (
          <button key={choice.id} type="button" className="btn ghost" data-testid={`question-${choice.id}`} disabled={sending} onClick={() => answer(choice.id, values)}>
            {choice.label}
          </button>
        ))}
        <span className="grow" />
        {paged && step > 0 ? (
          <button type="button" className="btn ghost" data-testid="question-back" disabled={sending} onClick={() => setStep(step - 1)}>
            Back
          </button>
        ) : null}
        {paged && !last ? (
          <button type="button" className="btn primary" data-testid="question-next" disabled={sending || missingAnswer(shown, values)} onClick={next}>
            Next
          </button>
        ) : (
          <button type="button" className="btn primary" data-testid="question-submit" disabled={blocked} onClick={submit}>
            {fields.length ? "Answer" : "Accept"}
          </button>
        )}
      </div>
    </section>
  );
}

function questionOf(field: FormField | undefined) {
  return field ? field.description || field.title : "";
}

// The card's head asks the question, so a field shows only what the head leaves out.
function FieldHeading({ field, heading }: { field: FormField; heading: string }) {
  if (field.kind === "boolean") return null;
  const text = field.description && field.description !== heading ? <p className="question-text">{field.description}</p> : null;
  if (field.kind === "choice" || field.kind === "multi") return text;
  return (
    <>
      {field.title && field.title !== heading ? <p className="question-label">{field.title}</p> : null}
      {text}
    </>
  );
}

interface FieldInputProps {
  field: FormField;
  // The text box for the person's own answer, drawn as the last option.
  own?: FormField;
  values: FormValues;
  sending: boolean;
  onPick: (field: FormField, value: string) => void;
  onChange: (values: FormValues) => void;
  onSubmit: () => void;
}

function FieldInput({ field, own, values, sending, onPick, onChange, onSubmit }: FieldInputProps) {
  const value = values[field.key];
  const enter = (event: KeyboardEvent) => {
    if (event.key === "Enter" && !event.nativeEvent.isComposing) onSubmit();
  };
  if (field.kind === "choice" || field.kind === "multi") {
    const multi = field.kind === "multi";
    const isChosen = (option: string) => (Array.isArray(value) ? value.includes(option) : value === option);
    const previewed = field.options.find((option) => isChosen(option.value)) ?? field.options.find((option) => option.preview);
    // With a pick, a single question's own text is a note on it, so only the pick shows as chosen.
    const ownChosen = own ? !isEmpty(values[own.key]) && (multi || isEmpty(value)) : false;
    return (
      <div className="ask-options question-options" role="group" aria-label={field.title}>
        {field.options.map((option) => (
          <Fragment key={option.value}>
            <button
              type="button"
              className={isChosen(option.value) ? "ask-opt question-option sel" : "ask-opt question-option"}
              aria-pressed={isChosen(option.value)}
              disabled={sending}
              onClick={() => onPick(field, option.value)}
            >
              <ChoiceMark multi={multi} />
              <span className="ask-text">
                <span className="question-option-label">{option.label}</span>
                {option.description ? <span className="question-option-detail">{option.description}</span> : null}
              </span>
            </button>
            {option === previewed && option.preview ? <MarkdownView className="question-preview plan-doc" text={option.preview} /> : null}
          </Fragment>
        ))}
        {own ? (
          <label className={ownChosen ? "ask-opt ask-own sel" : "ask-opt ask-own"}>
            <ChoiceMark multi={multi} />
            <input
              className="question-other"
              type={own.secret ? "password" : "text"}
              placeholder={own.title}
              title={own.description || undefined}
              aria-label={own.title}
              value={String(values[own.key] ?? "")}
              disabled={sending}
              onChange={(event) => onChange({ ...values, [own.key]: event.target.value })}
              onKeyDown={enter}
            />
          </label>
        ) : null}
      </div>
    );
  }
  if (field.kind === "boolean") {
    return (
      <label className="question-check">
        <input
          type="checkbox"
          checked={value === true}
          disabled={sending}
          onChange={(event) => onChange({ ...values, [field.key]: event.target.checked })}
        />
        <span>
          {field.title}
          {field.description ? <span className="question-option-detail">{field.description}</span> : null}
        </span>
      </label>
    );
  }
  return (
    <input
      className="question-input"
      type={field.secret ? "password" : field.kind === "text" ? "text" : "number"}
      step={field.kind === "integer" ? 1 : undefined}
      aria-label={field.title}
      value={String(value ?? "")}
      disabled={sending}
      onChange={(event) => onChange({ ...values, [field.key]: event.target.value })}
      onKeyDown={enter}
    />
  );
}

// The answer reads as the options' labels, and a secret answer stays hidden.
function questionReceipt(question: PresentedQuestion, action: string, values: FormValues): ReceiptText {
  const label = question.message || questionOf(question.fields[0]) || "Question";
  const named = question.actions.find((choice) => choice.id === action)?.label;
  const detail = action === "decline" ? "Skipped" : named || answerText(question.fields, values) || "Answered";
  return { icon: "check", label, detail, code: false };
}

function answerText(fields: FormField[], values: FormValues) {
  return fields
    .flatMap((field) => {
      const value = values[field.key];
      if (isEmpty(value)) return [];
      if (field.secret) return ["••••"];
      if (field.kind === "boolean") return [`${field.title}: ${value === true ? "Yes" : "No"}`];
      if (field.kind === "choice" || field.kind === "multi") {
        const picked = Array.isArray(value) ? value : [String(value)];
        return [picked.map((item) => field.options.find((option) => option.value === item)?.label ?? item).join(", ")];
      }
      return [`“${String(value)}”`];
    })
    .join(", ");
}

function ChoiceMark({ multi }: { multi: boolean }) {
  return multi ? (
    <span className="check" aria-hidden="true">
      <CheckIcon />
    </span>
  ) : (
    <span className="radio" aria-hidden="true" />
  );
}

export function QuestionIcon() {
  return (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" aria-hidden="true">
      <circle cx="12" cy="12" r="8.5" />
      <path d="M9.7 9.5a2.4 2.4 0 1 1 3.4 2.2c-.7.3-1.1.9-1.1 1.6v.4" />
      <path d="M12 16.8h.01" strokeWidth="2.4" />
    </svg>
  );
}
