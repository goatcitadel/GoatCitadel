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
  | "role_identity_override";

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
  | "tool_output";

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
  const findings: LocatedPromptwareFinding[] = [];

  for (const rule of PROMPTWARE_RULES) {
    rule.pattern.lastIndex = 0;
    let match: RegExpExecArray | null;
    while (findings.length < maxFindings && (match = rule.pattern.exec(input.content)) !== null) {
      if (!isProtectiveNegation(input.content, match.index)) {
        findings.push({
          source: input.source,
          sourcePath: input.sourcePath,
          scannerVersion: PROMPTWARE_SCANNER_VERSION,
          ruleId: rule.id,
          severity: rule.severity,
          startLine: lineNumberAt(input.content, match.index),
          endLine: lineNumberAt(input.content, match.index + match[0].length),
          marker: rule.id,
          evidenceHash,
          excerpt: buildRedactedExcerpt(input.content, match.index, match[0].length),
          matchIndex: match.index,
        });
      }
      if (match[0].length === 0) {
        rule.pattern.lastIndex += 1;
      }
    }
    if (findings.length >= maxFindings) {
      break;
    }
  }

  return findings
    .sort((left, right) => left.matchIndex - right.matchIndex || left.ruleId.localeCompare(right.ruleId))
    .slice(0, maxFindings)
    .map(({ matchIndex: _matchIndex, ...finding }) => finding);
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
