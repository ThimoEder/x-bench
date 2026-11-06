// iOS keeps the page at full height under the on-screen keyboard and scrolls it up to show the focused field,
// which pushes the header off screen. On a touch screen the page instead takes the height above the keyboard
// (--viewport-height) and stays scrolled to the top. data-keyboard marks the visible height shrunk by the
// keyboard, which then covers the home indicator's safe area.

const KEYBOARD = 40;

// Whether the keyboard is up: the visible height is well under the tallest seen at this width.
export function keyboardUp(height: number, fullHeight: number): boolean {
  return height < fullHeight - KEYBOARD;
}

export function fitKeyboardViewport(): void {
  const viewport = window.visualViewport;
  if (!viewport || !window.matchMedia?.("(hover: none) and (pointer: coarse)").matches) return;
  const root = document.documentElement;
  let width = 0;
  let fullHeight = 0;
  function fit() {
    if (!viewport) return;
    if (window.innerWidth !== width) {
      width = window.innerWidth;
      fullHeight = 0;
    }
    fullHeight = Math.max(fullHeight, viewport.height);
    root.style.setProperty("--viewport-height", `${viewport.height}px`);
    root.toggleAttribute("data-keyboard", keyboardUp(viewport.height, fullHeight));
    if (window.scrollY) window.scrollTo(0, 0);
  }
  viewport.addEventListener("resize", fit);
  viewport.addEventListener("scroll", fit);
  window.addEventListener("scroll", () => window.scrollY && window.scrollTo(0, 0), { passive: true });
  fit();
}
