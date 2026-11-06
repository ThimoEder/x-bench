// While a phone's menu is open as a sheet, the page under it takes no taps (styles.css), so a press there lands
// on the root element and closes the menu. iOS aims the click that follows at whatever is under the finger once
// the menu is gone, so that click is dropped.
export function dropTapsOnRoot(doc: Document = document): () => void {
  let onRoot = false;
  const down = (event: Event) => {
    onRoot = event.target === doc.documentElement;
  };
  const cancel = () => {
    onRoot = false;
  };
  const click = (event: Event) => {
    if (!onRoot) return;
    onRoot = false;
    event.preventDefault();
    event.stopPropagation();
  };
  doc.addEventListener("pointerdown", down, true);
  doc.addEventListener("pointercancel", cancel, true);
  doc.addEventListener("click", click, true);
  return () => {
    doc.removeEventListener("pointerdown", down, true);
    doc.removeEventListener("pointercancel", cancel, true);
    doc.removeEventListener("click", click, true);
  };
}
