export type DiffLineKind = "hunk" | "add" | "del" | "same" | "note";

export interface DiffLine {
  kind: DiffLineKind;
  text: string;
  // The new file's line number, or the old file's for a deleted line.
  number?: number;
}

const HUNK = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/;
// Header lines the file's title row already says.
const TITLE_LINE = /^(diff --git |index |--- |\+\+\+ )/;

// A unified diff's hunks, and the header lines its title row leaves out, such as a mode change or a rename.
export function diffLines(patch: string): DiffLine[] | null {
  const rows: DiffLine[] = [];
  let header = true;
  let oldLine = 0;
  let newLine = 0;
  const lines = patch.split("\n");
  if (lines.at(-1) === "") lines.pop();
  for (const line of lines) {
    const hunk = HUNK.exec(line);
    if (hunk) {
      header = false;
      oldLine = Number(hunk[1]);
      newLine = Number(hunk[2]);
      rows.push({ kind: "hunk", text: line });
    } else if (line.startsWith("diff --git ")) header = true;
    else if (header) {
      if (!TITLE_LINE.test(line)) rows.push({ kind: "note", text: line });
    } else if (line.startsWith("+")) rows.push({ kind: "add", text: line.slice(1), number: newLine++ });
    else if (line.startsWith("-")) rows.push({ kind: "del", text: line.slice(1), number: oldLine++ });
    else if (line.startsWith("\\")) rows.push({ kind: "note", text: line });
    else {
      rows.push({ kind: "same", text: line.slice(1), number: newLine++ });
      oldLine++;
    }
  }
  return rows.length ? rows : null;
}
