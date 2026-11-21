/** Server-captured observation eligibility, frozen on the run before dispatch. */
export const PROMPT_PACK_WATCH_CAPABILITIES = [
  "taskSuccess",
  "honesty",
  "executionQuality",
  "robustness",
  "usability",
  "truthfulness",
  "evidenceGrounding",
  "formatAdherence",
  "operatorUsefulness",
  "toolUseQuality",
  "orchestrationQuality",
  "efficiency",
  "recoveryQuality",
] as const;
export type PromptPackComparisonEvidence =
  | { kind: "legacy_v1" }
  | {
      kind: "auto_scored";
      currentScoreId: string;
      baselineScoreId: string;
      currentScoreHash: string;
      baselineScoreHash: string;
      scoringSchemaVersion: "v2" | "v3";
      scorerVersion: string;
      judgeRubricVersion: string;
      policyHash: string;
    };
export interface PromptPackImprovementWatchBinding {
  activationId: string;
  revisionId: string;
  changeHash: string;
  workspaceId: string;
  fingerprint: string;
  capability: string;
  capturedAt: string;
}
const fields = ["activationId", "revisionId", "changeHash", "workspaceId", "fingerprint", "capability", "capturedAt"];
export function readPromptPackImprovementWatchBindings(
  value: unknown,
  startedAt: string,
): PromptPackImprovementWatchBinding[] | undefined {
  if (
    !Array.isArray(value) ||
    value.length > PROMPT_PACK_WATCH_CAPABILITIES.length ||
    !Number.isFinite(Date.parse(startedAt))
  )
    return undefined;
  const capabilities = new Set<string>();
  for (const item of value) {
    if (
      !item ||
      typeof item !== "object" ||
      Object.keys(item).length !== fields.length ||
      fields.some((key) => typeof item[key] !== "string" || !item[key].trim()) ||
      Object.keys(item).some((key) => !fields.includes(key))
    )
      return undefined;
    if (
      ["activationId", "revisionId", "workspaceId"].some((key) => item[key].length > 256) ||
      item.capability.length > 64 ||
      item.fingerprint.length > 2048 ||
      !/^[a-f0-9]{64}$/u.test(item.changeHash) ||
      !Number.isFinite(Date.parse(item.capturedAt)) ||
      new Date(item.capturedAt).toISOString() !== item.capturedAt ||
      Date.parse(item.capturedAt) > Date.parse(startedAt) ||
      capabilities.has(item.capability)
    )
      return undefined;
    capabilities.add(item.capability);
  }
  return value.map((item) => ({ ...item }));
}
