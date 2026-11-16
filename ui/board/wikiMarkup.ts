// A ticket's wiki markup (h2. Title, {{mono}}, *bold*, [text|url]) turned into the Markdown the ticket detail draws.
// Markdown bold, code spans and fences in the text stay as they are.

// {{code}} is the word code in monospace, so a macro's brace follows no other brace.
const BLOCK = /(?<!\{)\{(code|noformat)(?::(\w+)(?=[|}]))?[^}\n]*\}\n?([\s\S]*?)\n?(?<!\{)\{\1\}|```[\s\S]*?```/g;

const INLINE = /(`[^`\n]+`)|\{\{(.+?)\}\}|(?<![\w*])\*(?![\s*])([^*\n]+?)(?<!\s)\*(?![\w*])|\[([^\]|\n]+)\|(https?:\/\/[^\]|\s]+)(?:\|[^\]\n]*)?\]|\[(https?:\/\/[^\]|\s]+)\](?!\()/g;

export function wikiToMarkdown(text: string): string {
  let out = "";
  let cursor = 0;
  for (const match of text.matchAll(BLOCK)) {
    out += prose(text.slice(cursor, match.index));
    out += match[1] ? `\n\`\`\`${match[2] ?? ""}\n${match[3] ?? ""}\n\`\`\`\n` : match[0];
    cursor = match.index + match[0].length;
  }
  return out + prose(text.slice(cursor));
}

function prose(text: string): string {
  return inline(text)
    .replace(/^bq\.[ \t]+/gm, "> ")
    // A marker's length is its depth, and its last character its kind: ## is a numbered item one level in.
    .replace(/^([*#]+)[ \t]+/gm, (_, marks: string) => `${"  ".repeat(marks.length - 1)}${marks.endsWith("#") ? "1." : "-"} `)
    .replace(/^h([1-6])\.[ \t]+/gm, (_, level: string) => `${"#".repeat(Number(level))} `)
    .replace(/^\|\|(.+?)\|\|[ \t]*$/gm, (_, cells: string) => {
      const header = cells.split("||");
      return `| ${header.join(" | ")} |\n|${" --- |".repeat(header.length)}`;
    })
    .replace(/\{quote\}\n?([\s\S]*?)\n?\{quote\}/g, (_, body: string) => body.replace(/^/gm, "> "));
}

function inline(text: string): string {
  return text.replace(INLINE, (whole: string, ...groups: (string | undefined)[]) => {
    const [tick, mono, bold, label, url, bare] = groups;
    if (tick) return whole;
    if (mono !== undefined) return `\`${mono}\``;
    if (bold !== undefined) return `**${inline(bold)}**`;
    // The Markdown link target ends at the first closing parenthesis.
    return label !== undefined ? `[${label}](${(url ?? "").replace(/\(/g, "%28").replace(/\)/g, "%29")})` : (bare ?? whole);
  });
}
