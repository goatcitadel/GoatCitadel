import { createHash } from "node:crypto";

const PROMPT_INJECTION_MARKERS = [
  /\bignore (?:all )?(?:previous|prior|above) (?:instructions|messages|rules)\b/i,
  /\bdisregard (?:all )?(?:previous|prior|above) (?:instructions|messages|rules)\b/i,
  /\b(?:ignore|disregard|override) (?:the )?(?:system|developer) (?:prompt|message|instructions|rules)\b/i,
  /\bdo not follow (?:the )?(?:system|developer|previous|prior|above) (?:prompt|message|instructions|rules)\b/i,
  /\boverride (?:the )?(?:system|developer) (?:prompt|message|instructions)\b/i,
  /\breveal (?:the )?(?:system|developer) (?:prompt|message|instructions)\b/i,
  /\byou are now (?:in|under) developer mode\b/i,
];

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
  marker: string;
  evidenceHash: string;
  excerpt: string;
}

export function scanAssembledPromptForInjection(prompt: string): AssembledPromptInjectionFinding | undefined {
  const [finding] = scanPromptwareContent({ source: "assembled_prompt", content: prompt });
  return finding ? { marker: finding.marker } : undefined;
}

export function scanPromptwareContent(input: {
  source: PromptwareScanSource;
  content: string;
}): PromptwareScanFinding[] {
  const findings: PromptwareScanFinding[] = [];
  for (const marker of PROMPT_INJECTION_MARKERS) {
    marker.lastIndex = 0;
    const match = marker.exec(input.content);
    if (match?.[0]) {
      findings.push({
        source: input.source,
        marker: marker.source,
        evidenceHash: createHash("sha256").update(input.content).digest("hex"),
        excerpt: buildRedactedExcerpt(input.content, match.index, match[0].length),
      });
    }
  }
  return findings;
}

export function assertNoAssembledPromptInjection(prompt: string): void {
  const [finding] = scanPromptwareContent({ source: "assembled_prompt", content: prompt });
  if (finding) {
    throw new Error(
      `Assembled prompt failed prompt-injection scan: ${finding.marker}; evidence=${finding.evidenceHash.slice(0, 12)}`,
    );
  }
}

export function assertNoMemoryContextInjection(contextText: string): void {
  const [finding] = scanPromptwareContent({ source: "memory_context", content: contextText });
  if (finding) {
    throw new Error(
      `Memory context failed prompt-injection scan: ${finding.marker}; evidence=${finding.evidenceHash.slice(0, 12)}`,
    );
  }
}

export function assertNoToolOutputInjection(result: unknown): void {
  const content = typeof result === "string" ? result : JSON.stringify(result);
  const [finding] = scanPromptwareContent({ source: "tool_output", content });
  if (finding) {
    throw new Error(
      `Tool output failed prompt-injection scan: ${finding.marker}; evidence=${finding.evidenceHash.slice(0, 12)}`,
    );
  }
}

function buildRedactedExcerpt(content: string, matchIndex: number, matchLength: number): string {
  // matchIndex/matchLength are offsets into the ORIGINAL content, so slice the window from the
  // original (then collapse whitespace) — slicing a pre-collapsed string with original offsets
  // shifted the window off the match whenever the content had leading whitespace/newlines.
  const start = Math.max(0, matchIndex - 48);
  const end = Math.min(content.length, matchIndex + matchLength + 96);
  const window = content.slice(start, end).replace(/\s+/g, " ").trim();
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
