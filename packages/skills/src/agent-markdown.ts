import YAML from "yaml";
import type {
  RichAgentFrontmatter,
  RichAgentParseSupportStatus,
  RichAgentSectionKind,
  RichAgentSectionMap,
  RichAgentSectionRecord,
} from "@goatcitadel/contracts";

const CANONICAL_SECTION_KEYS = new Map<
  string,
  {
    canonicalKey: string;
    kind: RichAgentSectionKind;
  }
>([
  ["identity-memory", { canonicalKey: "identity-memory", kind: "persona" }],
  ["identity-and-memory", { canonicalKey: "identity-memory", kind: "persona" }],
  ["communication-style", { canonicalKey: "communication-style", kind: "persona" }],
  ["critical-rules-you-must-follow", { canonicalKey: "critical-rules", kind: "persona" }],
  ["critical-rules", { canonicalKey: "critical-rules", kind: "persona" }],
  ["core-mission", { canonicalKey: "core-mission", kind: "operations" }],
  ["technical-deliverables", { canonicalKey: "technical-deliverables", kind: "operations" }],
  ["workflow-process", { canonicalKey: "workflow-process", kind: "operations" }],
  ["learning-memory", { canonicalKey: "learning-memory", kind: "persona" }],
  ["learning-and-memory", { canonicalKey: "learning-memory", kind: "persona" }],
  ["success-metrics", { canonicalKey: "success-metrics", kind: "operations" }],
  ["advanced-capabilities", { canonicalKey: "advanced-capabilities", kind: "operations" }],
  ["quick-reference", { canonicalKey: "quick-reference", kind: "reference" }],
  ["next-steps", { canonicalKey: "next-steps", kind: "reference" }],
]);

export interface ParsedRichAgentMarkdown {
  frontmatter?: RichAgentFrontmatter;
  rawMarkdown: string;
  bodyMarkdown: string;
  sectionOrder: string[];
  sectionMap: RichAgentSectionMap;
  parseStatus: RichAgentParseSupportStatus;
  parseWarnings: string[];
}

export function parseRichAgentMarkdown(markdown: string): ParsedRichAgentMarkdown {
  const rawMarkdown = markdown;
  const parseWarnings: string[] = [];
  const lines = markdown.split(/\r?\n/);
  let bodyStartIndex = 0;
  let frontmatter: RichAgentFrontmatter | undefined;

  if (lines[0]?.trim() === "---") {
    const closingFence = lines.findIndex((line, index) => index > 0 && line.trim() === "---");
    if (closingFence < 0) {
      parseWarnings.push("Frontmatter fence closes incorrectly or is missing.");
    } else {
      bodyStartIndex = closingFence + 1;
      try {
        const parsed = YAML.parse(lines.slice(1, closingFence).join("\n")) as Record<string, unknown> | undefined;
        frontmatter = normalizeFrontmatter(parsed, parseWarnings);
      } catch (error) {
        parseWarnings.push(`Invalid YAML frontmatter: ${(error as Error).message}`);
      }
    }
  } else {
    parseWarnings.push("Missing YAML frontmatter.");
  }

  const bodyMarkdown = lines.slice(bodyStartIndex).join("\n").trim();
  const { sectionOrder, sectionMap, unknownHeadings } = extractSections(bodyMarkdown);

  if (!frontmatter?.name || !frontmatter?.description) {
    parseWarnings.push("Frontmatter must include name and description.");
  }
  if (sectionOrder.length === 0) {
    parseWarnings.push("No level-2 Markdown sections were found.");
  }
  if (!hasSectionKind(sectionOrder, sectionMap, "persona")) {
    parseWarnings.push("Missing persona section group.");
  }
  if (!hasSectionKind(sectionOrder, sectionMap, "operations")) {
    parseWarnings.push("Missing operations section group.");
  }
  if (unknownHeadings.length > 0) {
    parseWarnings.push(`Unrecognized sections: ${unknownHeadings.join(", ")}.`);
  }

  const parseStatus = resolveParseStatus({
    hasFrontmatter: Boolean(frontmatter?.name && frontmatter?.description),
    hasSections: sectionOrder.length > 0,
    parseWarnings,
  });

  return {
    frontmatter,
    rawMarkdown,
    bodyMarkdown,
    sectionOrder,
    sectionMap,
    parseStatus,
    parseWarnings,
  };
}

function normalizeFrontmatter(
  value: Record<string, unknown> | undefined,
  parseWarnings: string[],
): RichAgentFrontmatter | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    parseWarnings.push("Frontmatter must be a YAML object.");
    return undefined;
  }

  const { name, description, color, services, presentation, metadata, ...extra } = value;

  if (typeof name !== "string" || !name.trim()) {
    parseWarnings.push("Frontmatter name is required.");
  }
  if (typeof description !== "string" || !description.trim()) {
    parseWarnings.push("Frontmatter description is required.");
  }

  return {
    name: typeof name === "string" ? name.trim() : "",
    description: typeof description === "string" ? description.trim() : "",
    color: typeof color === "string" && color.trim() ? color.trim() : undefined,
    services: normalizeServices(services),
    presentation: isPlainObject(presentation) ? presentation : undefined,
    metadata: isPlainObject(metadata) ? metadata : undefined,
    extra: Object.keys(extra).length > 0 ? extra : undefined,
  };
}

function normalizeServices(value: unknown): string[] | undefined {
  const candidates = Array.isArray(value) ? value : typeof value === "string" ? value.split(",") : [];
  const normalized = dedupeStrings(
    candidates.map((candidate) => (typeof candidate === "string" ? candidate.trim() : "")).filter(Boolean),
  );
  return normalized.length > 0 ? normalized : undefined;
}

function extractSections(bodyMarkdown: string): {
  sectionOrder: string[];
  sectionMap: RichAgentSectionMap;
  unknownHeadings: string[];
} {
  const lines = bodyMarkdown.split(/\r?\n/);
  const sections: Array<{ heading: string; lines: string[] }> = [];
  let current: { heading: string; lines: string[] } | null = null;

  for (const line of lines) {
    const heading = parseSectionHeading(line);
    if (heading) {
      if (current) {
        sections.push(current);
      }
      current = {
        heading,
        lines: [],
      };
      continue;
    }
    if (current) {
      current.lines.push(line);
    }
  }
  if (current) {
    sections.push(current);
  }

  const sectionOrder: string[] = [];
  const sectionMap: RichAgentSectionMap = {};
  const unknownHeadings: string[] = [];
  const slugCounts = new Map<string, number>();

  for (const section of sections) {
    const slugBase = normalizeHeadingSlug(section.heading);
    const canonical = CANONICAL_SECTION_KEYS.get(slugBase);
    const keyBase = canonical?.canonicalKey ?? slugBase;
    const nextCount = (slugCounts.get(keyBase) ?? 0) + 1;
    slugCounts.set(keyBase, nextCount);
    const key = nextCount === 1 ? keyBase : `${keyBase}-${nextCount}`;
    if (!canonical) {
      unknownHeadings.push(section.heading);
    }
    sectionOrder.push(key);
    sectionMap[key] = {
      key,
      slug: slugBase,
      heading: section.heading,
      level: 2,
      kind: canonical?.kind ?? "other",
      content: section.lines.join("\n").trim(),
      canonicalKey: canonical?.canonicalKey,
    } satisfies RichAgentSectionRecord;
  }

  return {
    sectionOrder,
    sectionMap,
    unknownHeadings,
  };
}

function parseSectionHeading(line: string): string | undefined {
  if (!line.startsWith("##")) {
    return undefined;
  }
  const nextChar = line.charCodeAt(2);
  if (!Number.isFinite(nextChar) || !isMarkdownWhitespace(nextChar)) {
    return undefined;
  }
  const heading = line.slice(2).trim();
  return heading || undefined;
}

function isMarkdownWhitespace(code: number): boolean {
  return code === 9 || code === 10 || code === 11 || code === 12 || code === 13 || code === 32;
}

function normalizeHeadingSlug(value: string): string {
  return value
    .toLowerCase()
    .replace(/&/g, " and ")
    .replace(/\byour\b/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .replace(/-{2,}/g, "-");
}

function hasSectionKind(sectionOrder: string[], sectionMap: RichAgentSectionMap, kind: RichAgentSectionKind): boolean {
  return sectionOrder.some((key) => sectionMap[key]?.kind === kind);
}

function resolveParseStatus(input: {
  hasFrontmatter: boolean;
  hasSections: boolean;
  parseWarnings: string[];
}): RichAgentParseSupportStatus {
  if (!input.hasFrontmatter || !input.hasSections) {
    return "unsupported";
  }
  return input.parseWarnings.length > 0 ? "supported_with_warnings" : "supported";
}

function dedupeStrings(values: string[]): string[] {
  const seen = new Set<string>();
  const deduped: string[] = [];
  for (const value of values) {
    const normalized = value.trim();
    if (!normalized || seen.has(normalized)) {
      continue;
    }
    seen.add(normalized);
    deduped.push(normalized);
  }
  return deduped;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
