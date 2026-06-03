import { createHash } from "node:crypto";

const PROMPT_INJECTION_MARKERS = [
  /\bignore (?:all )?(?:previous|prior|above) (?:instructions|messages|rules)\b/i,
  /\bdisregard (?:all )?(?:previous|prior|above) (?:instructions|messages|rules)\b/i,
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

function buildRedactedExcerpt(content: string, matchIndex: number, matchLength: number): string {
  const compact = content.replace(/\s+/g, " ").trim();
  const start = Math.max(0, matchIndex - 48);
  const end = Math.min(compact.length, matchIndex + matchLength + 96);
  return redactPromptwareExcerpt(
    `${start > 0 ? "..." : ""}${compact.slice(start, end)}${end < compact.length ? "..." : ""}`,
  );
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
