// The HID usage of a physical key, from KeyboardEvent.code. The simulator applies its own keyboard layout.
const NAMED: Record<string, number> = {
  Enter: 40,
  Escape: 41,
  Backspace: 42,
  Tab: 43,
  Space: 44,
  Minus: 45,
  Equal: 46,
  BracketLeft: 47,
  BracketRight: 48,
  Backslash: 49,
  Semicolon: 51,
  Quote: 52,
  Backquote: 53,
  Comma: 54,
  Period: 55,
  Slash: 56,
  CapsLock: 57,
  Home: 74,
  PageUp: 75,
  Delete: 76,
  End: 77,
  PageDown: 78,
  ArrowRight: 79,
  ArrowLeft: 80,
  ArrowDown: 81,
  ArrowUp: 82,
  IntlBackslash: 100,
  ControlLeft: 224,
  ShiftLeft: 225,
  AltLeft: 226,
  ControlRight: 228,
  ShiftRight: 229,
  AltRight: 230,
};

export function hidUsage(code: string): number | undefined {
  const letter = /^Key([A-Z])$/.exec(code);
  if (letter) return letter[1]!.charCodeAt(0) - 65 + 4;
  const digit = /^Digit([0-9])$/.exec(code);
  if (digit) return digit[1] === "0" ? 39 : Number(digit[1]) + 29;
  const fn = /^F([1-9]|1[0-2])$/.exec(code);
  if (fn) return Number(fn[1]) + 57;
  return NAMED[code];
}
