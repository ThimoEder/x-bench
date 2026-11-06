import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import type { ProviderUsage } from "../../server/snapshot.ts";
import type { UsageWindow } from "../../bridge/provider.ts";
import { ProviderMark } from "../chat/messages/providerMark.tsx";

const METER_MS = 260;
const METER_EASE = "cubic-bezier(0.22, 1, 0.36, 1)";

// A meter that arrives grows into the row and one that leaves shrinks out of it, so the others slide
// over. The meters the row opens with are drawn at once.
export function UsageRow({ usage }: { usage: ProviderUsage[] }) {
  const [shown, setShown] = useState(() => usage.map((item) => ({ item, leaving: false })));
  const [seen, setSeen] = useState(usage);
  const opened = useRef(false);
  if (usage !== seen) {
    setSeen(usage);
    const next = usage.map((item) => ({ item, leaving: false }));
    const ids = new Set(usage.map((item) => item.provider));
    shown.forEach((entry, index) => {
      if (!ids.has(entry.item.provider)) next.splice(Math.min(index, next.length), 0, { item: entry.item, leaving: true });
    });
    setShown(next);
  }
  useEffect(() => {
    opened.current = true;
  }, []);
  const onLeft = useCallback((provider: string) => {
    setShown((list) => list.filter((entry) => !(entry.leaving && entry.item.provider === provider)));
  }, []);
  return (
    <span className="sidebar-usage">
      {shown.map(({ item, leaving }) => (
        <UsageMeter key={item.provider} usage={item} rowOpened={opened} leaving={leaving} onLeft={onLeft} />
      ))}
    </span>
  );
}

// The element to animate, or null where there is no animation (reduced motion, or a test DOM).
function animated(element: HTMLElement | null) {
  if (!element || typeof element.animate !== "function" || window.matchMedia?.("(prefers-reduced-motion: reduce)").matches) return null;
  return element;
}

interface UsageMeterProps {
  usage: ProviderUsage;
  // True once the row has drawn its first meters. A meter that mounts after that arrives.
  rowOpened: { readonly current: boolean };
  leaving: boolean;
  onLeft: (provider: string) => void;
}

function UsageMeter({ usage, rowOpened, leaving, onLeft }: UsageMeterProps) {
  const wrapRef = useRef<HTMLSpanElement | null>(null);
  const cardRef = useRef<HTMLDivElement | null>(null);
  const pctRef = useRef<HTMLSpanElement | null>(null);
  const drawnPercent = useRef(usage.percent);

  useLayoutEffect(() => {
    const wrap = animated(wrapRef.current);
    if (!wrap || !rowOpened.current) return;
    const width = `${wrap.getBoundingClientRect().width}px`;
    wrap.animate([{ width: "0px", opacity: 0, overflow: "hidden" }, { width, opacity: 1, overflow: "hidden" }], { duration: METER_MS, easing: METER_EASE });
  }, [rowOpened]);

  useLayoutEffect(() => {
    if (!leaving) return;
    const wrap = animated(wrapRef.current);
    if (!wrap) {
      onLeft(usage.provider);
      return;
    }
    const width = `${wrap.getBoundingClientRect().width}px`;
    const shrink = wrap.animate([{ width, opacity: 1, overflow: "hidden" }, { width: "0px", opacity: 0, overflow: "hidden" }], { duration: METER_MS, easing: METER_EASE, fill: "forwards" });
    shrink.onfinish = () => onLeft(usage.provider);
    return () => shrink.cancel();
  }, [leaving, onLeft, usage.provider]);

  useLayoutEffect(() => {
    if (drawnPercent.current === usage.percent) return;
    drawnPercent.current = usage.percent;
    animated(pctRef.current)?.animate([{ opacity: 0, transform: "translateY(3px)" }, { opacity: 1, transform: "none" }], { duration: METER_MS, easing: METER_EASE });
  }, [usage.percent]);

  const reset = resetLabel(usage.resetsAt);
  const name = usageName(usage);
  const line = usageLine(usage);
  const windows = usage.windows ?? [];
  const summary = (windows.length ? [name, ...windows.map(windowSummary)] : [name, line, reset ? `Next reset ${reset}` : ""]).filter(Boolean).join(". ");

  // The card sits centered over its meter, moved over as far as it must to stay inside the footer.
  const placeCard = () => {
    const wrap = wrapRef.current;
    const card = cardRef.current;
    const foot = wrap?.closest(".sidebar-foot")?.getBoundingClientRect();
    if (!wrap || !card || !foot) return;
    const own = wrap.getBoundingClientRect();
    const width = card.offsetWidth;
    const left = Math.max(foot.left, Math.min(own.left + own.width / 2 - width / 2, foot.right - width));
    card.style.left = `${left - own.left}px`;
    card.style.transformOrigin = `${own.left + own.width / 2 - left}px bottom`;
  };

  // A card in view follows its meter while other meters arrive or leave around it.
  useLayoutEffect(() => {
    if (!wrapRef.current?.matches(":hover, :focus-within")) return;
    placeCard();
    const settled = window.setTimeout(placeCard, METER_MS);
    return () => window.clearTimeout(settled);
  });

  return (
    <span className="brand-usage-wrap" ref={wrapRef} onPointerEnter={placeCard} onFocus={placeCard} data-leaving={leaving ? "" : undefined}>
      <button
        type="button"
        className="brand-usage"
        data-level={usage.percent >= 90 ? "high" : undefined}
        data-testid="account-usage"
        aria-label={summary}
      >
        <ProviderMark provider={usage.provider} />
        <span className="brand-pct" ref={pctRef}>{usage.percent}%</span>
      </button>
      <div className="usage-card" ref={cardRef} aria-hidden="true">
        <UsageDetails usage={usage} />
      </div>
    </span>
  );
}

export function UsageDetails({ usage }: { usage: ProviderUsage }) {
  const name = usageName(usage);
  const reset = resetLabel(usage.resetsAt);
  const windows = usage.windows ?? [];
  return (
    <div className="usage-card-body">
      {name ? <p className="usage-tier">{name}</p> : null}
      {windows.length ? (
        <div className="usage-windows">
          {windows.map((window) => (
            <p key={window.period} className="usage-window" data-level={window.percent >= 90 ? "high" : undefined}>
              <span>{periodTitle(window.period)}</span>
              <span>{window.percent}%</span>
              <span>{resetLabel(window.resetsAt)}</span>
            </p>
          ))}
        </div>
      ) : (
        <>
          <p className="usage-line">{usageLine(usage)}</p>
          {reset ? (
            <p className="usage-reset">
              <span>Next reset</span>
              <span>{reset}</span>
            </p>
          ) : null}
        </>
      )}
    </div>
  );
}

// Some providers' tiers already start with the provider's name.
function usageName(usage: ProviderUsage) {
  return usage.tier.startsWith(usage.label) ? usage.tier : [usage.label, usage.tier].filter(Boolean).join(" · ");
}

function usageLine(window: UsageWindow) {
  const period = window.period === "five-hour" ? "5-hour" : window.period;
  return `${window.percent}% of ${period || "plan"} usage`;
}

function windowSummary(window: UsageWindow) {
  const reset = resetLabel(window.resetsAt);
  return reset ? `${usageLine(window)}, next reset ${reset}` : usageLine(window);
}

function periodTitle(period: UsageWindow["period"]) {
  return period === "five-hour" ? "5-hour" : period === "weekly" ? "Weekly" : period === "monthly" ? "Monthly" : "Plan";
}

// A reset that has passed is left out until the provider reports the new window.
function resetLabel(iso: string | null) {
  const when = iso ? new Date(iso) : null;
  if (!when || Number.isNaN(when.getTime()) || when.getTime() <= Date.now()) return "";
  const sameYear = when.getFullYear() === new Date().getFullYear();
  return when.toLocaleString(undefined, {
    weekday: "short",
    month: "short",
    day: "numeric",
    year: sameYear ? undefined : "numeric",
    hour: "numeric",
    minute: "2-digit",
  });
}
