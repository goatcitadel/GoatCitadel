import type { MemoryWriteAuthority, MemoryWriteGateDecision } from "@goatcitadel/contracts";

export interface MemoryWriteGateEvaluateInput {
  authority: MemoryWriteAuthority;
  content: string;
  existingClaims?: string[];
  policyAllowsExternalWrites?: boolean;
  createdAt?: string;
}

const SECRET_PATTERN =
  /(?:api[_-]?key|secret|password|token|credential|sk-[a-z0-9_-]{16,}|ghp_[a-z0-9_]{16,}|xox[baprs]-[a-z0-9-]{16,})/i;

export class MemoryWriteGateService {
  public evaluate(input: MemoryWriteGateEvaluateInput): MemoryWriteGateDecision {
    const reasons: string[] = [];
    const contradictionHints = findContradictionHints(input.content, input.existingClaims ?? []);
    const containsSecret = SECRET_PATTERN.test(input.content);
    let decision: MemoryWriteGateDecision["decision"];
    let redactionStatus: MemoryWriteGateDecision["redactionStatus"] = "none";

    if (containsSecret) {
      decision = "blocked";
      redactionStatus = "blocked_secret";
      reasons.push("secret_like_content");
    } else if (input.authority === "trusted_lifecycle" || input.authority === "operator") {
      decision = "allowed";
      reasons.push("trusted_authority");
    } else if (
      (input.authority === "external_channel" || input.authority === "imported_skill") &&
      !input.policyAllowsExternalWrites
    ) {
      decision = "proposed";
      reasons.push("external_write_requires_review");
    } else {
      decision = "proposed";
      reasons.push("agent_write_requires_review");
    }

    if (contradictionHints.length > 0 && decision !== "blocked") {
      decision = "proposed";
      reasons.push("possible_contradiction");
    }

    return {
      decision,
      authority: input.authority,
      reasons,
      contradictionHints,
      redactionStatus,
      createdAt: input.createdAt ?? new Date().toISOString(),
    };
  }
}

function findContradictionHints(content: string, existingClaims: string[]): string[] {
  const normalizedContent = normalizeClaim(content);
  return existingClaims
    .map((claim) => claim.trim())
    .filter(Boolean)
    .filter((claim) => {
      const normalizedClaim = normalizeClaim(claim);
      return normalizedClaim.length > 0 && normalizedContent.length > 0 && normalizedClaim !== normalizedContent;
    })
    .filter((claim) => haveMeaningfulOverlap(normalizedContent, normalizeClaim(claim)))
    .slice(0, 5);
}

function normalizeClaim(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function haveMeaningfulOverlap(left: string, right: string): boolean {
  const leftWords = new Set(left.split(" ").filter((word) => word.length >= 5));
  const rightWords = new Set(right.split(" ").filter((word) => word.length >= 5));
  let overlap = 0;
  for (const word of leftWords) {
    if (rightWords.has(word)) {
      overlap += 1;
    }
  }
  return overlap >= 2;
}
