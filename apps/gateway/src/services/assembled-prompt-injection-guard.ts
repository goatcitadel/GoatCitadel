import { createHash } from "node:crypto";

export const PROMPTWARE_SCANNER_ID = "goatcitadel.promptware-scan";
export const PROMPTWARE_SCANNER_VERSION = "1.0.0";
export const PROMPTWARE_SCANNER_REVISION = 1;
export const PROMPTWARE_MAX_FINDINGS = 32;

export type PromptwareRuleId =
  | "instruction_hierarchy_override"
  | "privileged_prompt_exfiltration"
  | "approval_policy_bypass"
  | "tool_execution_without_approval"
  | "role_identity_override"
  | "hidden_text_obfuscation";

export type PromptwareSeverity = "critical" | "high";

interface PromptwareRule {
  readonly id: PromptwareRuleId;
  readonly severity: PromptwareSeverity;
  readonly pattern: RegExp;
}

const PROMPTWARE_RULES: readonly PromptwareRule[] = [
  {
    id: "instruction_hierarchy_override",
    severity: "critical",
    pattern:
      /\b(?:(?:ignore|disregard|override)\s+(?:all\s+)?(?:the\s+)?(?:(?:previous|prior|above)\s+(?:instructions?|messages?|rules?)|(?:system|developer)\s+(?:prompt|message|instructions?|rules?))|do\s+not\s+follow\s+(?:the\s+)?(?:system|developer|previous|prior|above)\s+(?:prompt|message|instructions?|rules?))\b/giu,
  },
  {
    id: "privileged_prompt_exfiltration",
    severity: "critical",
    pattern:
      /\b(?:reveal|show|print|expose|repeat)\s+(?:the\s+)?(?:hidden\s+)?(?:system|developer)\s+(?:prompt|message|instructions?)\b/giu,
  },
  {
    id: "approval_policy_bypass",
    severity: "critical",
    pattern:
      /\b(?:bypass|skip|disable|override)\s+(?:the\s+)?(?:approval(?:\s+gate)?|policy(?:\s+engine)?|path\s+jail|tool\s+grants?)\b/giu,
  },
  {
    id: "tool_execution_without_approval",
    severity: "high",
    pattern:
      /\b(?:run|execute|invoke|call|use)\s+[\s\S]{0,96}?\bwithout\s+(?:asking\s+(?:for\s+)?)?(?:approval|permission|confirmation)\b/giu,
  },
  {
    id: "role_identity_override",
    severity: "critical",
    pattern: /\byou\s+are\s+now\s+(?:(?:in|under)\s+)?(?:developer|system|admin(?:istrator)?|unrestricted)\s+mode\b/giu,
  },
] as const;

export interface AssembledPromptInjectionFinding {
  marker: string;
}

export type PromptwareScanSource =
  | "assembled_prompt"
  | "scheduled_prompt"
  | "imported_skill"
  | "memory_context"
  | "tool_output"
  | "delegated_output"
  | "plugin_prompt_pack";

/** Skill and prompt pack files get the stricter pass: normalized text, hidden characters and decoded base64. */
export const SKILL_CONTENT_SOURCES: ReadonlySet<PromptwareScanSource> = new Set([
  "imported_skill",
  "plugin_prompt_pack",
]);

export interface PromptwareScanFinding {
  source: PromptwareScanSource;
  sourcePath?: string;
  scannerVersion: string;
  ruleId: PromptwareRuleId;
  severity: PromptwareSeverity;
  startLine: number;
  endLine: number;
  marker: string;
  evidenceHash: string;
  excerpt: string;
}

interface LocatedPromptwareFinding extends PromptwareScanFinding {
  readonly matchIndex: number;
}

export function scanAssembledPromptForInjection(prompt: string): AssembledPromptInjectionFinding | undefined {
  const [finding] = scanPromptwareContent({ source: "assembled_prompt", content: prompt });
  return finding ? { marker: finding.ruleId } : undefined;
}

export function scanPromptwareContent(input: {
  source: PromptwareScanSource;
  content: string;
  sourcePath?: string;
  maxFindings?: number;
}): PromptwareScanFinding[] {
  const maxFindings = Math.max(1, Math.min(input.maxFindings ?? PROMPTWARE_MAX_FINDINGS, PROMPTWARE_MAX_FINDINGS));
  const evidenceHash = createHash("sha256").update(input.content).digest("hex");
  const findings = scanPromptwareRules(input.source, input.content, input.sourcePath, evidenceHash, maxFindings);
  if (SKILL_CONTENT_SOURCES.has(input.source)) {
    findings.push(...scanSkillContentVariants(input, evidenceHash, maxFindings));
  }
  const seen = new Set<string>();
  return findings
    .sort((left, right) => left.matchIndex - right.matchIndex || left.ruleId.localeCompare(right.ruleId))
    .filter((finding) => {
      const key = `${finding.ruleId}:${finding.startLine}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    })
    .slice(0, maxFindings)
    .map(({ matchIndex: _matchIndex, ...finding }) => finding);
}

const HIDDEN_TEXT_PATTERN = /[\u200B-\u200D\u2060\u202A-\u202E\u2066-\u2069\uFEFF]/u;
const ZERO_WIDTH_GLOBAL = /[\u200B-\u200D\u2060\uFEFF]/gu;
const BASE64_RUN = /[A-Za-z0-9+/]{200,}={0,2}/gu;
const BASE64_DECODE_LIMIT = 64 * 1024;

/** The stricter pass for skill content. Findings point at the original text's lines. */
function scanSkillContentVariants(
  input: { source: PromptwareScanSource; content: string; sourcePath?: string },
  evidenceHash: string,
  maxFindings: number,
): LocatedPromptwareFinding[] {
  const { content } = input;
  const findings: LocatedPromptwareFinding[] = [];
  // A byte order mark at the very start is ordinary; anywhere else it hides text.
  const body = content.startsWith("\uFEFF") ? ` ${content.slice(1)}` : content;
  const hidden = HIDDEN_TEXT_PATTERN.exec(body);
  if (hidden) {
    findings.push(locatedFinding(input, evidenceHash, "hidden_text_obfuscation", "high", hidden.index, 1));
  }
  // Normalizing keeps the text's length close to the original, so line numbers stay usable.
  const normalized = content.normalize("NFKC").replace(ZERO_WIDTH_GLOBAL, "");
  if (normalized !== content) {
    for (const finding of scanPromptwareRules(input.source, normalized, input.sourcePath, evidenceHash, maxFindings)) {
      findings.push({ ...finding, excerpt: buildRedactedExcerpt(normalized, finding.matchIndex, 0) });
    }
  }
  BASE64_RUN.lastIndex = 0;
  let run: RegExpExecArray | null;
  while (findings.length < maxFindings && (run = BASE64_RUN.exec(content)) !== null) {
    const decoded = decodeBase64Text(run[0].slice(0, BASE64_DECODE_LIMIT));
    if (!decoded) continue;
    for (const finding of scanPromptwareRules(input.source, decoded, input.sourcePath, evidenceHash, maxFindings)) {
      findings.push({
        ...finding,
        startLine: lineNumberAt(content, run.index),
        endLine: lineNumberAt(content, run.index + run[0].length),
        excerpt: buildRedactedExcerpt(decoded, finding.matchIndex, 0),
        matchIndex: run.index,
      });
    }
  }
  return findings;
}

function decodeBase64Text(run: string): string | undefined {
  const usable = run.slice(0, run.length - (run.length % 4));
  try {
    const text = new TextDecoder("utf-8", { fatal: true }).decode(Buffer.from(usable, "base64"));
    // Decoded text worth scanning reads as text: mostly printable characters.
    const printable = text.replace(/[^\t\n\r\x20-\x7E\u00A0-\uFFFF]/gu, "");
    return printable.length >= text.length * 0.95 ? text : undefined;
  } catch {
    return undefined;
  }
}

function locatedFinding(
  input: { source: PromptwareScanSource; content: string; sourcePath?: string },
  evidenceHash: string,
  ruleId: PromptwareRuleId,
  severity: PromptwareSeverity,
  index: number,
  length: number,
): LocatedPromptwareFinding {
  return {
    source: input.source,
    sourcePath: input.sourcePath,
    scannerVersion: PROMPTWARE_SCANNER_VERSION,
    ruleId,
    severity,
    startLine: lineNumberAt(input.content, index),
    endLine: lineNumberAt(input.content, index + length),
    marker: ruleId,
    evidenceHash,
    excerpt: buildRedactedExcerpt(input.content, index, length),
    matchIndex: index,
  };
}

function scanPromptwareRules(
  source: PromptwareScanSource,
  content: string,
  sourcePath: string | undefined,
  evidenceHash: string,
  maxFindings: number,
): LocatedPromptwareFinding[] {
  const findings: LocatedPromptwareFinding[] = [];

  for (const rule of PROMPTWARE_RULES) {
    rule.pattern.lastIndex = 0;
    let match: RegExpExecArray | null;
    while (findings.length < maxFindings && (match = rule.pattern.exec(content)) !== null) {
      if (!isProtectiveNegation(content, match.index)) {
        findings.push(
          locatedFinding(
            { source, content, sourcePath },
            evidenceHash,
            rule.id,
            rule.severity,
            match.index,
            match[0].length,
          ),
        );
      }
      if (match[0].length === 0) {
        rule.pattern.lastIndex += 1;
      }
    }
    if (findings.length >= maxFindings) {
      break;
    }
  }

  return findings;
}

export function assertNoAssembledPromptInjection(prompt: string): void {
  const [finding] = scanPromptwareContent({ source: "assembled_prompt", content: prompt });
  if (finding) {
    throw new Error(
      `Assembled prompt failed prompt-injection scan: ${finding.ruleId}; evidence=${finding.evidenceHash.slice(0, 12)}`,
    );
  }
}

export function assertNoMemoryContextInjection(contextText: string): void {
  const [finding] = scanPromptwareContent({ source: "memory_context", content: contextText });
  if (finding) {
    throw new Error(
      `Memory context failed prompt-injection scan: ${finding.ruleId}; evidence=${finding.evidenceHash.slice(0, 12)}`,
    );
  }
}

export function assertNoToolOutputInjection(result: unknown): void {
  const content = typeof result === "string" ? result : JSON.stringify(result);
  const [finding] = scanPromptwareContent({ source: "tool_output", content });
  if (finding) {
    throw new Error(
      `Tool output failed prompt-injection scan: ${finding.ruleId}; evidence=${finding.evidenceHash.slice(0, 12)}`,
    );
  }
}

function isProtectiveNegation(content: string, matchIndex: number): boolean {
  const prefix = content.slice(Math.max(0, matchIndex - 64), matchIndex).replace(/\s+/gu, " ");
  return /(?:^|[\s:;,.!?(){}-]|\[|\])(?:never|must not|do not|don't|cannot|can't|avoid)\s*$/iu.test(prefix);
}

function lineNumberAt(content: string, offset: number): number {
  const boundedOffset = Math.max(0, Math.min(offset, content.length));
  const matches = content.slice(0, boundedOffset).match(/\r\n|\r|\n|\u2028|\u2029/gu);
  return (matches?.length ?? 0) + 1;
}

function buildRedactedExcerpt(content: string, matchIndex: number, matchLength: number): string {
  // matchIndex/matchLength are offsets into the ORIGINAL content, so slice the window from the
  // original (then collapse whitespace) — slicing a pre-collapsed string with original offsets
  // shifted the window off the match whenever the content had leading whitespace/newlines.
  const start = Math.max(0, matchIndex - 48);
  const end = Math.min(content.length, matchIndex + matchLength + 96);
  const window = content.slice(start, end).replace(/\s+/gu, " ").trim();
  return redactPromptwareExcerpt(`${start > 0 ? "..." : ""}${window}${end < content.length ? "..." : ""}`);
}

function redactPromptwareExcerpt(value: string): string {
  return value
    .replace(/\b(Bearer|token|api[-_]?key|authorization)\s*[:=]\s*[A-Za-z0-9._~+/=-]{8,}/gi, "$1=[REDACTED]")
    .replace(/\bauthorization\s*:\s*Bearer\s+\S+/gi, "authorization=[REDACTED]")
    .replace(/\bBearer\s+[A-Za-z0-9._~+/=-]{8,}/gi, "Bearer [REDACTED]")
    .replace(/https?:\/\/([^/\s:@]+):([^/\s@]+)@/gi, "https://[REDACTED]@")
    .replace(/\bsk-[A-Za-z0-9_-]{8,}\b/g, "sk-[REDACTED]")
    .slice(0, 240);
}
