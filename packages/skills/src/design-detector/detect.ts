import type { DesignAdvisory } from "@goatcitadel/contracts";
import { DESIGN_DETECTOR_RULES } from "./rules.js";

export const DESIGN_ADVISORY_MAX_FINDINGS = 8;
// The plan's contract: at most 1 KiB of serialized advisories reaches a tool result or artifact.
export const DESIGN_ADVISORY_MAX_BYTES = 1024;

export interface DetectDesignAdvisoriesOptions {
  maxFindings?: number;
  maxBytes?: number;
}

/**
 * Scan text line by line with the deterministic rules. Each rule reports at most its first hit;
 * results are sorted by line, capped by count and by the byte size of their JSON, and never
 * contain the scanned text itself. Pure and synchronous.
 */
export function detectDesignAdvisories(text: string, options: DetectDesignAdvisoriesOptions = {}): DesignAdvisory[] {
  const maxFindings = Math.max(0, options.maxFindings ?? DESIGN_ADVISORY_MAX_FINDINGS);
  const maxBytes = Math.max(0, options.maxBytes ?? DESIGN_ADVISORY_MAX_BYTES);
  if (!text || maxFindings === 0) return [];
  const lines = text.split(/\r?\n/u);
  const found: DesignAdvisory[] = [];
  for (const rule of DESIGN_DETECTOR_RULES) {
    const index = lines.findIndex((line) => rule.re.test(line));
    if (index === -1) continue;
    found.push({
      ruleId: rule.id,
      line: index + 1,
      summary: rule.summary,
      ...(rule.craftFloorRule ? { craftFloorRule: rule.craftFloorRule } : {}),
    });
  }
  const sorted = found
    .sort((left, right) => left.line - right.line || left.ruleId.localeCompare(right.ruleId))
    .slice(0, maxFindings);
  while (sorted.length > 0 && Buffer.byteLength(JSON.stringify(sorted), "utf8") > maxBytes) sorted.pop();
  return sorted;
}
