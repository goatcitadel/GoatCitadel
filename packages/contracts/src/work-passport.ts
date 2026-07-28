/**
 * Work Passport is a task-boundary and review contract, not an assessment of
 * the operator. The workspace baseline is always operator-authored; task
 * signals are local, deterministic, correctable, and frozen into the Chat turn
 * capability profile.
 */

export const WORK_PASSPORT_SCHEMA_VERSION = "work.passport.v1" as const;

export const WORK_PASSPORT_DOMAINS = [
  "administration",
  "customer_experience",
  "data_analysis",
  "design",
  "engineering",
  "finance",
  "healthcare",
  "human_resources",
  "legal",
  "marketing",
  "operations",
  "procurement",
  "project_management",
  "research",
  "sales",
  "security",
] as const;

export type WorkPassportDomain = (typeof WORK_PASSPORT_DOMAINS)[number];
export type WorkPassportSignalStrength = "low" | "medium" | "high";
export type WorkPassportBoundary =
  | "baseline_not_configured"
  | "within_baseline"
  | "cross_domain"
  | "mixed"
  | "generic_or_unclear";
export type WorkPassportConsequence = "low" | "moderate" | "high";
export type WorkPassportReviewPosture = "self_check" | "independent_review" | "domain_expert_required";
export type WorkPassportActionPosture = "explore" | "draft" | "ready_for_review" | "approval_before_external_action";

export interface WorkPassportBaseline {
  configured: boolean;
  roleLabel?: string;
  primaryDomains: WorkPassportDomain[];
  revision?: number;
}

export interface WorkPassportTaskSignal {
  domain: WorkPassportDomain;
  strength: WorkPassportSignalStrength;
  /** Short, secret-free descriptions of the matched task cues. */
  reasons: string[];
}

export interface WorkPassportReviewRequirement {
  posture: WorkPassportReviewPosture;
  reason: string;
  requirements: string[];
}

export interface WorkPassportRecord {
  passportId: string;
  schemaVersion: typeof WORK_PASSPORT_SCHEMA_VERSION;
  classificationMode: "deterministic_local_v1";
  baseline: WorkPassportBaseline;
  taskSignals: WorkPassportTaskSignal[];
  boundary: WorkPassportBoundary;
  consequence: WorkPassportConsequence;
  review: WorkPassportReviewRequirement;
  evidenceRequirements: string[];
  actionPosture: WorkPassportActionPosture;
  limitations: string[];
  operatorCorrectionAllowed: true;
}

export interface WorkPassportBaselineUpdateInput {
  workspaceId: string;
  roleLabel?: string;
  primaryDomains: WorkPassportDomain[];
}

export interface WorkPassportBaselineResponse {
  workspaceId: string;
  baseline: WorkPassportBaseline;
}

const DOMAIN_SET: ReadonlySet<string> = new Set(WORK_PASSPORT_DOMAINS);
const BOUNDARIES: ReadonlySet<string> = new Set([
  "baseline_not_configured",
  "within_baseline",
  "cross_domain",
  "mixed",
  "generic_or_unclear",
]);
const CONSEQUENCES: ReadonlySet<string> = new Set(["low", "moderate", "high"]);
const REVIEW_POSTURES: ReadonlySet<string> = new Set(["self_check", "independent_review", "domain_expert_required"]);
const ACTION_POSTURES: ReadonlySet<string> = new Set([
  "explore",
  "draft",
  "ready_for_review",
  "approval_before_external_action",
]);

export function assertWorkPassportRecord(value: unknown): asserts value is WorkPassportRecord {
  if (!isRecord(value)) {
    throw new Error("Work Passport must be an object.");
  }
  if (
    !isBoundedString(value.passportId, 160) ||
    value.schemaVersion !== WORK_PASSPORT_SCHEMA_VERSION ||
    value.classificationMode !== "deterministic_local_v1" ||
    value.operatorCorrectionAllowed !== true
  ) {
    throw new Error("Work Passport identity is invalid.");
  }
  assertWorkPassportBaseline(value.baseline);
  if (!Array.isArray(value.taskSignals) || value.taskSignals.length > 3) {
    throw new Error("Work Passport task signals are invalid.");
  }
  const seen = new Set<string>();
  for (const signal of value.taskSignals) {
    if (
      !isRecord(signal) ||
      !isDomain(signal.domain) ||
      !["low", "medium", "high"].includes(String(signal.strength)) ||
      seen.has(signal.domain) ||
      !isBoundedStrings(signal.reasons, 4, 120)
    ) {
      throw new Error("Work Passport contains an invalid or duplicate task signal.");
    }
    seen.add(signal.domain);
  }
  if (!BOUNDARIES.has(String(value.boundary)) || !CONSEQUENCES.has(String(value.consequence))) {
    throw new Error("Work Passport boundary or consequence is invalid.");
  }
  if (
    !isRecord(value.review) ||
    !REVIEW_POSTURES.has(String(value.review.posture)) ||
    !isBoundedString(value.review.reason, 240) ||
    !isBoundedStrings(value.review.requirements, 8, 240)
  ) {
    throw new Error("Work Passport review requirement is invalid.");
  }
  if (
    !isBoundedStrings(value.evidenceRequirements, 12, 240) ||
    !ACTION_POSTURES.has(String(value.actionPosture)) ||
    !isBoundedStrings(value.limitations, 6, 240)
  ) {
    throw new Error("Work Passport evidence, action, or limitation fields are invalid.");
  }
}

export function assertWorkPassportBaseline(value: unknown): asserts value is WorkPassportBaseline {
  if (!isRecord(value) || typeof value.configured !== "boolean") {
    throw new Error("Work Passport baseline is invalid.");
  }
  if (value.roleLabel !== undefined && !isBoundedString(value.roleLabel, 120)) {
    throw new Error("Work Passport role label is invalid.");
  }
  if (!Array.isArray(value.primaryDomains) || value.primaryDomains.length > 8) {
    throw new Error("Work Passport primary domains are invalid.");
  }
  const domains = value.primaryDomains.filter(isDomain);
  if (domains.length !== value.primaryDomains.length || new Set(domains).size !== domains.length) {
    throw new Error("Work Passport primary domains contain invalid or duplicate values.");
  }
  if (value.revision !== undefined && (!Number.isInteger(value.revision) || Number(value.revision) < 1)) {
    throw new Error("Work Passport baseline revision is invalid.");
  }
  if (value.configured !== domains.length > 0) {
    throw new Error("Work Passport configured state does not match its baseline fields.");
  }
}

function isDomain(value: unknown): value is WorkPassportDomain {
  return typeof value === "string" && DOMAIN_SET.has(value);
}

function isBoundedString(value: unknown, maxLength: number): value is string {
  return typeof value === "string" && value.trim().length > 0 && value.length <= maxLength;
}

function isBoundedStrings(value: unknown, maxItems: number, maxLength: number): value is string[] {
  return Array.isArray(value) && value.length <= maxItems && value.every((item) => isBoundedString(item, maxLength));
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}
