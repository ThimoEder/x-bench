import { useEffect, useLayoutEffect, useRef, useState } from "react";
import type { AnimationEvent } from "react";
import { nextTitleReveal } from "./titleReveal.ts";

const revealFallbackMs = 1200;

function prefersReducedMotion(): boolean {
  return window.matchMedia("(prefers-reduced-motion: reduce)").matches;
}

export interface RevealTitleProps {
  as?: "span" | "p";
  className?: string;
  text: string;
  tooltip?: string;
}

export function RevealTitle({ as: Tag = "span", className, text, tooltip }: RevealTitleProps) {
  const previous = useRef(text);
  const [reveal, setReveal] = useState<{ from: string; to: string } | null>(null);

  useLayoutEffect(() => {
    const before = previous.current;
    if (before === text) return;
    previous.current = text;
    const next = nextTitleReveal(before, text);
    if (next && !prefersReducedMotion()) {
      setReveal(next);
      return;
    }
    setReveal((current) => (current ? { from: current.from, to: text } : current));
  }, [text]);

  useEffect(() => {
    if (!reveal) return undefined;
    const timer = window.setTimeout(() => setReveal(null), revealFallbackMs);
    return () => window.clearTimeout(timer);
  }, [reveal]);

  function finish(event: AnimationEvent<HTMLSpanElement>) {
    if (event.target !== event.currentTarget) return;
    if (event.animationName !== "title-reveal") return;
    setReveal(null);
  }

  if (!reveal) {
    return (
      <Tag className={className} title={tooltip}>
        {text}
      </Tag>
    );
  }

  return (
    <Tag className={className ? `${className} is-revealing` : "is-revealing"} title={tooltip}>
      <span className="title-from" aria-hidden="true">{reveal.from}</span>
      <span className="title-to" onAnimationEnd={finish}>{reveal.to}</span>
    </Tag>
  );
}
