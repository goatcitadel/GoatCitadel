import type { SkillOutputDirective, SkillOutputParseResult } from "@goatcitadel/contracts";

const DIRECTIVE_PATTERN = /\[\[as_document(?<attrs>[^\]]*?)\]\](?<content>[\s\S]*?)\[\[\/as_document\]\]/g;

export function parseSkillOutputDirectives(input: string): SkillOutputParseResult {
  const directives: SkillOutputDirective[] = [];
  const text = input.replace(DIRECTIVE_PATTERN, (match) => {
    // Re-execute the regex on the matched substring to extract named groups
    // reliably (the `replace` callback's groups argument typing is awkward in TS).
    const inner = match.match(/\[\[as_document(?<attrs>[^\]]*?)\]\](?<content>[\s\S]*?)\[\[\/as_document\]\]/);
    const attrs = inner?.groups?.attrs ?? "";
    const content = (inner?.groups?.content ?? "").trim();
    const parsed = parseAttributes(attrs);
    if (!parsed.fileName) {
      // Malformed — leave the original substring in place.
      return match;
    }
    directives.push({
      kind: "document",
      fileName: parsed.fileName,
      mimeType: parsed.mimeType ?? "text/plain",
      content,
    });
    return ""; // strip from delivered text
  });
  return {
    text: text.replace(/\n{3,}/g, "\n\n").trim(),
    directives,
  };
}

interface ParsedAttributes {
  fileName?: string;
  mimeType?: string;
}

function parseAttributes(raw: string): ParsedAttributes {
  const result: ParsedAttributes = {};
  const pattern = /(\w+)\s*=\s*("([^"]*)"|'([^']*)'|(\S+))/g;
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(raw)) !== null) {
    const key = match[1];
    const value = match[3] ?? match[4] ?? match[5];
    if (!key || value === undefined) continue;
    if (key === "fileName") result.fileName = value;
    else if (key === "mimeType") result.mimeType = value;
  }
  return result;
}
