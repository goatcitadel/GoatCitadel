import type { PromptPackDiagnosticMetadata } from "@goatcitadel/contracts";

export interface PromptPackParsedTest {
  code: string;
  title: string;
  prompt: string;
  orderIndex: number;
  mode?: string;
  toolTier?: string;
  diagnosticMetadata?: PromptPackDiagnosticMetadata;
}

const PROMPT_PACK_KNOWN_TOOL_FAMILIES = new Set([
  "none",
  "unspecified",
  "web",
  "memory",
  "file/code",
  "time",
  "command/validation",
  "other",
]);

export function normalizePromptTestCode(value: string): string {
  const normalized = value.trim().toUpperCase();
  if (normalized === "ALL") {
    return "all";
  }
  const dottedMatch = normalized.match(/^(\d+(?:\.\d+)+)$/);
  if (dottedMatch) {
    return dottedMatch[1]!
      .split(".")
      .map((segment) => String(Number.parseInt(segment, 10)))
      .join(".");
  }
  const match = normalized.match(/TEST-([A-Z]?\d{1,3})/);
  if (!match) {
    return normalized;
  }
  const suffix = match[1] ?? "0";
  const letterPrefix = suffix.match(/^([A-Z])/)?.[1] ?? "";
  const numericPart = suffix.replace(/^[A-Z]/, "");
  const padded = String(Number.parseInt(numericPart, 10)).padStart(2, "0");
  return `TEST-${letterPrefix}${padded}`;
}

export function parsePromptPackTests(content: string): PromptPackParsedTest[] {
  const TEST_CODE_PATTERN = "(?:TEST-[A-Z]?\\d{1,3}|\\d+(?:\\.\\d+)+)";
  const lines = content.replace(/\r\n/g, "\n").split("\n");
  const entries: PromptPackParsedTest[] = [];
  let active: { code: string; title: string; lines: string[] } | undefined;
  let currentMode: string | undefined;
  let currentToolTier: string | undefined;

  const flush = () => {
    if (!active) {
      return;
    }
    const extracted = extractPromptPackDiagnosticMetadata(active.lines.join("\n").trim());
    const prompt = extracted.prompt;
    if (prompt.length > 0) {
      entries.push({
        code: normalizePromptTestCode(active.code),
        title: active.title || active.code,
        prompt,
        orderIndex: entries.length,
        mode: currentMode && VALID_MODES.has(currentMode) ? currentMode : undefined,
        toolTier: currentToolTier && VALID_TOOL_TIERS.has(currentToolTier) ? currentToolTier : undefined,
        diagnosticMetadata: extracted.diagnosticMetadata,
      });
    }
    active = undefined;
  };

  const normalizeHeadingLine = (line: string): string => {
    let normalized = line.trim();
    normalized = normalized.replace(/^[-*]\s+/, "");
    normalized = normalized.replace(/^\d+[.)]\s+/, "");
    let previous = "";
    while (normalized !== previous) {
      previous = normalized;
      normalized = normalized
        .replace(/^\*\*(.+)\*\*$/, "$1")
        .replace(/^__(.+)__$/, "$1")
        .replace(/^\*(.+)\*$/, "$1")
        .replace(/^_(.+)_$/, "$1")
        .trim();
    }
    return normalized;
  };

  const MODE_SECTION_RE = /^#{1,3}\s+(chat|cowork|code)(?:\s+tests?)?\b/i;
  const TOOL_TIER_RE = /^#{1,4}\s+(no[- ]tools|implicit[- ]tools|explicit[- ]tools)\b/i;
  const VALID_MODES = new Set(["chat", "cowork", "code"]);
  const VALID_TOOL_TIERS = new Set(["no-tools", "implicit-tools", "explicit-tools"]);

  let openFenceLength = 0;

  for (const rawLine of lines) {
    // Fenced code can contain lines that would otherwise read as mode/tier
    // headings, test codes, or horizontal rules; keep them in the active body.
    // A fence closes only on a backtick run at least as long as its opener, so
    // a four-backtick fence can quote a literal ``` block without closing.
    const fenceRunLength = rawLine.trim().match(/^(`{3,})/)?.[1]?.length ?? 0;
    if (fenceRunLength > 0 || openFenceLength > 0) {
      if (openFenceLength === 0) {
        openFenceLength = fenceRunLength;
      } else if (fenceRunLength >= openFenceLength) {
        openFenceLength = 0;
      }
      if (active) {
        active.lines.push(rawLine);
      }
      continue;
    }
    const line = normalizeHeadingLine(rawLine);

    const modeMatch = line.match(MODE_SECTION_RE);
    if (modeMatch) {
      flush();
      currentMode = modeMatch[1]!.toLowerCase();
      currentToolTier = undefined;
      continue;
    }

    const tierMatch = line.match(TOOL_TIER_RE);
    if (tierMatch) {
      flush();
      currentToolTier = tierMatch[1]!.toLowerCase().replace(/\s+/g, "-");
      continue;
    }

    const testBracket = line.match(new RegExp(`^\\[(${TEST_CODE_PATTERN})\\]\\s*(.*)$`, "i"));
    const testHeadingPlain = line.match(new RegExp(`^#{1,6}\\s*(${TEST_CODE_PATTERN})\\s+(.+)$`, "i"));
    const testHeading = line.match(new RegExp(`^#{1,6}\\s*(${TEST_CODE_PATTERN})\\s*[:\\-]\\s*(.*)$`, "i"));
    const testPlain = line.match(new RegExp(`^(${TEST_CODE_PATTERN})\\s*[:\\-]\\s*(.*)$`, "i"));
    const matched = testBracket ?? testHeadingPlain ?? testHeading ?? testPlain;
    if (matched) {
      flush();
      const code = normalizePromptTestCode(matched[1] ?? "");
      const title = (matched[2] ?? "").trim() || code;
      active = {
        code,
        title,
        lines: [],
      };
      continue;
    }
    const isSectionHeading = /^#{1,6}\s+/.test(line);
    const isHorizontalRule = rawLine.trim() === "---";
    if (active && (isHorizontalRule || isSectionHeading)) {
      flush();
      continue;
    }
    if (!active) {
      continue;
    }
    active.lines.push(rawLine);
  }
  flush();
  return entries;
}

export function extractPromptPackVersionLabel(content: string): string | undefined {
  // Only the pack preamble may declare a version; scanning stops at the first
  // mode heading so prompt bodies can mention "Pack-Version:" freely.
  for (const rawLine of extractPromptPackPreambleLines(content)) {
    const match = rawLine.trim().match(/^Pack-Version:\s*(\S.*)$/i);
    const label = match?.[1]?.trim();
    if (label) {
      return label.slice(0, 120);
    }
  }
  return undefined;
}

export function validatePromptPackStructure(
  content: string,
  tests: Array<{
    code: string;
    mode?: string;
    toolTier?: string;
    diagnosticMetadata?: PromptPackDiagnosticMetadata;
  }>,
): string[] {
  const issues: string[] = [];

  const seenCodes = new Set<string>();
  const duplicateCodes = new Set<string>();
  for (const test of tests) {
    if (seenCodes.has(test.code)) {
      duplicateCodes.add(test.code);
    }
    seenCodes.add(test.code);
  }
  if (duplicateCodes.size > 0) {
    issues.push(`duplicate test codes: ${[...duplicateCodes].sort().join(", ")}`);
  }

  for (const declared of parseDeclaredPromptPackCounts(content)) {
    const parsedCount = tests.filter(
      (test) =>
        (test.mode ?? "") === declared.mode && (declared.toolTier === undefined || test.toolTier === declared.toolTier),
    ).length;
    if (parsedCount !== declared.count) {
      const scope = declared.toolTier ? `${declared.mode}/${declared.toolTier}` : declared.mode;
      issues.push(`declared ${declared.count} ${scope} tests but parsed ${parsedCount}`);
    }
  }

  const unknownFamilies = new Set<string>();
  for (const test of tests) {
    for (const family of test.diagnosticMetadata?.expectedToolFamilies ?? []) {
      if (!PROMPT_PACK_KNOWN_TOOL_FAMILIES.has(family)) {
        unknownFamilies.add(`${test.code}:${family}`);
      }
    }
  }
  if (unknownFamilies.size > 0) {
    issues.push(`unknown Expected Tool Families values: ${[...unknownFamilies].sort().join(", ")}`);
  }

  return issues;
}

function extractPromptPackPreambleLines(content: string): string[] {
  const lines = content.replace(/\r\n/g, "\n").split("\n");
  const preamble: string[] = [];
  for (const line of lines) {
    if (/^#{1,3}\s+(chat|cowork|code)\b/i.test(line.trim())) {
      break;
    }
    preamble.push(line);
  }
  return preamble;
}

function parseDeclaredPromptPackCounts(content: string): Array<{ count: number; mode: string; toolTier?: string }> {
  const declared: Array<{ count: number; mode: string; toolTier?: string }> = [];
  for (const line of extractPromptPackPreambleLines(content)) {
    if (!/tests?|prompts?/i.test(line)) {
      continue;
    }
    for (const match of line.matchAll(
      /(\d{1,3})\s+(chat|cowork|code)(?:\s+(no-tools|implicit-tools|explicit-tools))?\b/gi,
    )) {
      declared.push({
        count: Number(match[1]),
        mode: match[2]!.toLowerCase(),
        toolTier: match[3]?.toLowerCase(),
      });
    }
  }
  return declared;
}

export function extractPromptPackDiagnosticMetadata(prompt: string): {
  prompt: string;
  diagnosticMetadata?: PromptPackDiagnosticMetadata;
} {
  const match = prompt.match(/^\s*<!--\s*Prompt Pack Diagnostics:\s*([\s\S]*?)-->\s*/i);
  if (!match?.[1]) {
    return { prompt };
  }
  const metadata = parsePromptPackDiagnosticMetadataBlock(match[1]);
  return {
    prompt: prompt.slice(match[0].length).trim(),
    diagnosticMetadata: hasPromptPackDiagnosticMetadata(metadata) ? metadata : undefined,
  };
}

function parsePromptPackDiagnosticMetadataBlock(block: string): PromptPackDiagnosticMetadata {
  const metadata: PromptPackDiagnosticMetadata = {
    capabilityTargets: [],
    expectedRuntimeSignals: [],
    likelyFailureClasses: [],
  };
  for (const rawLine of block.split(/\r?\n/g)) {
    const line = rawLine.trim().replace(/^[-*]\s*/, "");
    const match = line.match(
      /^(Capability Targets|Expected Runtime Signals|Likely Failure Classes|Expected Tool Families):\s*(.+)$/i,
    );
    if (!match?.[1] || !match[2]) {
      continue;
    }
    const values = splitPromptPackMetadataList(match[2]);
    if (/^Capability Targets$/i.test(match[1])) {
      metadata.capabilityTargets = values;
    } else if (/^Expected Runtime Signals$/i.test(match[1])) {
      metadata.expectedRuntimeSignals = values;
    } else if (/^Expected Tool Families$/i.test(match[1])) {
      // Only set when authored so packs without the key keep their exact
      // pre-existing metadata shape (and stored JSON) byte-for-byte.
      const families = values.map((value) => value.toLowerCase());
      if (families.length > 0) {
        metadata.expectedToolFamilies = families;
      }
    } else {
      metadata.likelyFailureClasses = values;
    }
  }
  return metadata;
}

function splitPromptPackMetadataList(value: string): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const raw of value.split(/[,;]\s*/g)) {
    const item = raw.trim().replace(/^`|`$/g, "");
    if (!item || seen.has(item)) {
      continue;
    }
    seen.add(item);
    out.push(item);
  }
  return out;
}

function hasPromptPackDiagnosticMetadata(metadata: PromptPackDiagnosticMetadata): boolean {
  return (
    metadata.capabilityTargets.length > 0 ||
    metadata.expectedRuntimeSignals.length > 0 ||
    metadata.likelyFailureClasses.length > 0 ||
    (metadata.expectedToolFamilies?.length ?? 0) > 0
  );
}

function extractPromptPlaceholders(prompt: string): string[] {
  const matches = prompt.match(/<[^<>\n]{3,160}>/g) ?? [];
  const unique = new Set<string>();
  for (const match of matches) {
    const trimmed = match.trim();
    const inner = trimmed.slice(1, -1).trim();
    if (!inner) {
      continue;
    }
    const looksLikePlaceholder =
      /[A-Z]{2,}/.test(inner) || /[_ ]/.test(inner) || /\b(PASTE|LOCAL|URL|TOPIC|PATH|EXAMPLE|YOUR)\b/i.test(inner);
    if (!looksLikePlaceholder) {
      continue;
    }
    unique.add(`<${inner}>`);
  }
  return Array.from(unique);
}

function normalizePromptPlaceholderKey(value: string): string {
  const trimmed = value.trim();
  if (!trimmed) {
    return "";
  }
  const inner = trimmed.startsWith("<") && trimmed.endsWith(">") ? trimmed.slice(1, -1).trim() : trimmed;
  return inner.toLowerCase().replace(/\s+/g, " ").trim();
}

export function applyPromptPlaceholderValues(
  prompt: string,
  placeholderValues?: Record<string, string>,
): {
  prompt: string;
  missingPlaceholders: string[];
} {
  const placeholders = extractPromptPlaceholders(prompt);
  if (placeholders.length === 0) {
    return {
      prompt,
      missingPlaceholders: [],
    };
  }

  const replacements = new Map<string, string>();
  for (const [rawKey, rawValue] of Object.entries(placeholderValues ?? {})) {
    const key = normalizePromptPlaceholderKey(rawKey);
    const value = rawValue.trim();
    if (!key || !value) {
      continue;
    }
    replacements.set(key, value);
  }

  let resolvedPrompt = prompt;
  const missingPlaceholders: string[] = [];
  for (const placeholder of placeholders) {
    const key = normalizePromptPlaceholderKey(placeholder);
    const replacement = replacements.get(key);
    if (!replacement) {
      missingPlaceholders.push(placeholder);
      continue;
    }
    resolvedPrompt = resolvedPrompt.split(placeholder).join(replacement);
  }

  return {
    prompt: resolvedPrompt,
    missingPlaceholders,
  };
}
