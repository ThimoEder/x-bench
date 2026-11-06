const leaving = new Set<HTMLElement>();

// A ref for a menu or sheet that unmounts when it closes. A copy, out of reach, takes its place while the
// .is-leaving animation in styles.css plays, then goes, at once without that animation. A menu that opens
// removes every copy still leaving, so a reopened menu or sheet never shows twice.
export function leaveRef(node: HTMLElement | null): (() => void) | undefined {
  if (!node || typeof node.getAnimations !== "function" || window.matchMedia("(prefers-reduced-motion: reduce)").matches) return undefined;
  for (const copy of leaving) copy.remove();
  leaving.clear();
  return () => {
    const parent = node.parentNode;
    const next = node.nextSibling;
    const copy = node.cloneNode(true) as HTMLElement;
    // React calls this before it removes the node, and also when only the ref changes.
    queueMicrotask(() => {
      if (node.isConnected || !parent?.isConnected) return;
      for (const element of [copy, ...copy.querySelectorAll("[id]")]) element.removeAttribute("id");
      copy.classList.add("is-leaving");
      copy.inert = true;
      parent.insertBefore(copy, next?.parentNode === parent ? next : null);
      leaving.add(copy);
      void Promise.allSettled(copy.getAnimations().map((animation) => animation.finished)).then(() => {
        leaving.delete(copy);
        copy.remove();
      });
    });
  };
}
