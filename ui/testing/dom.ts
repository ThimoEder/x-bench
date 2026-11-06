import { register } from "node:module";
import { Window } from "happy-dom";

// Component tests run under node --test with a happy-dom window as the page's globals.
// Call this before importing a component; it also lets later imports load .tsx files.
export function installDom(): Window {
  register("./tsx-hooks.ts", import.meta.url);
  const window = new Window({ url: "http://127.0.0.1:8787/" });
  const globals: Record<string, unknown> = {
    window,
    document: window.document,
    navigator: window.navigator,
    localStorage: window.localStorage,
    requestAnimationFrame: window.requestAnimationFrame.bind(window),
    cancelAnimationFrame: window.cancelAnimationFrame.bind(window),
    getComputedStyle: window.getComputedStyle.bind(window),
    Node: window.Node,
    Element: window.Element,
    HTMLElement: window.HTMLElement,
    HTMLAnchorElement: window.HTMLAnchorElement,
    HTMLInputElement: window.HTMLInputElement,
    HTMLTextAreaElement: window.HTMLTextAreaElement,
    Event: window.Event,
    InputEvent: window.InputEvent,
    KeyboardEvent: window.KeyboardEvent,
    MouseEvent: window.MouseEvent,
    FocusEvent: window.FocusEvent,
    Image: window.Image,
    MutationObserver: window.MutationObserver,
    DOMParser: window.DOMParser,
    XMLSerializer: window.XMLSerializer,
    // React checks this to run updates inside act().
    IS_REACT_ACT_ENVIRONMENT: true,
  };
  for (const [name, value] of Object.entries(globals)) {
    Object.defineProperty(globalThis, name, { value, configurable: true, writable: true });
  }
  return window;
}

// Types into a controlled field the way a keystroke does: set the value past React's tracker, then fire input.
export function typeInto(field: HTMLTextAreaElement | HTMLInputElement, text: string): void {
  const setter = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(field), "value")?.set;
  if (!setter) throw new Error("The field has no value setter");
  setter.call(field, text);
  field.setSelectionRange(text.length, text.length);
  field.dispatchEvent(new InputEvent("input", { bubbles: true }));
}

export function press(target: Element, key: string, init: KeyboardEventInit = {}): void {
  target.dispatchEvent(new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true, ...init }));
}

export function click(target: Element): void {
  target.dispatchEvent(new MouseEvent("mousedown", { bubbles: true, cancelable: true }));
  target.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
}

export function wait(ms = 0): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}
