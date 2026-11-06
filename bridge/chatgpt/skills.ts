const CODE = /(```[\s\S]*?(?:```|$)|`[^`\n]*`)/;

// Codex lists its skills as $name and runs one from a $name mention. The app offers them as /name, so a
// /name token outside code for a skill Codex listed only as $name goes to Codex as $name.
export function codexSkillText(text: string, names: readonly string[]): string {
  return text
    .split(CODE)
    .map((piece, index) =>
      index % 2
        ? piece
        : piece.replace(/(?<=^|\s)\/([^\s/$]+?)(?=[.,;:!?)]*(?:\s|$))/g, (token: string, name: string) =>
            names.includes(name) || !names.includes(`$${name}`) ? token : `$${name}`,
          ),
    )
    .join("");
}
