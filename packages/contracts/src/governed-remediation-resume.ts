/** References to server-owned repair evidence, never operator-authored answers
 * or arbitrary provider/credential data. Storage must verify their lineage. */
export interface GovernedRemediationResumeReference {
  schemaVersion: "goatcitadel.remediation-resume-reference.v1";
  resolutionId: string;
  remediationId: string;
  verificationReceiptId: string;
}

export const GOVERNED_REMEDIATION_RESUME_TEXT = "The runtime completed and verified the requested repair.";

export function readGovernedRemediationResumeReference(value: unknown): GovernedRemediationResumeReference | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const record = value as Record<string, unknown>;
  const fields = ["schemaVersion", "resolutionId", "remediationId", "verificationReceiptId"];
  if (Object.keys(record).length !== fields.length || fields.some((field) => !Object.hasOwn(record, field))) return undefined;
  if (record.schemaVersion !== "goatcitadel.remediation-resume-reference.v1") return undefined;
  for (const field of fields.slice(1)) {
    if (typeof record[field] !== "string" || !/^[a-zA-Z0-9._:-]{1,256}$/u.test(record[field])) return undefined;
  }
  return {
    schemaVersion: record.schemaVersion,
    resolutionId: record.resolutionId as string,
    remediationId: record.remediationId as string,
    verificationReceiptId: record.verificationReceiptId as string,
  };
}
