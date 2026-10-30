import path from "node:path";
import type { SkillHubOperatorApprovalSummary, SkillHubOperatorItem } from "./skill-hub-operator-service.js";

/** Where a shipped pack's check records its source: the pack's folder on the server. Never sent to the cockpit. */
export const HIMALAYA_PACK_PATH = path.join(path.resolve("goatcitadel-root"), "skills", "import-packs", "himalaya");

const CREATED_AT = "2026-10-29T00:00:00.000Z";

/** The item's parts that an override changes field by field rather than replacing. */
type NestedPart = "snapshot" | "runtime" | "actions";
type ItemOverrides = Partial<Omit<SkillHubOperatorItem, NestedPart>> & {
  [Part in NestedPart]?: Partial<SkillHubOperatorItem[Part]>;
};

/**
 * One Skill Hub operator item as `SkillHubOperatorService.list` projects it: by default a check of the shipped
 * `himalaya` pack that passed, with nothing installed or asked for yet.
 */
export function hubItem(overrides: ItemOverrides = {}): SkillHubOperatorItem {
  const { snapshot, runtime, actions, ...rest } = overrides;
  const allowed = { allowed: true, blockers: [] };
  return {
    snapshotId: "skill-hub-review-1",
    skillId: "extra:himalaya",
    title: "himalaya",
    lineage: { versionCount: 0, inventoryTruncated: false, ambiguous: false },
    approvals: {},
    ...rest,
    snapshot: {
      operation: "review",
      sourceProvider: "local",
      sourceType: "local_path",
      sourceRef: HIMALAYA_PACK_PATH,
      canonicalSourceKey: "local:himalaya",
      resolvedVersion: `sha256:${"a".repeat(64)}`,
      contentTreeSha256: "a".repeat(64),
      digestChangedFromPrior: false,
      sameVersionDifferentBytes: false,
      riskLevel: "medium",
      trustDisposition: "candidate",
      blockerCodes: [],
      audit: {},
      auditSha256: "b".repeat(64),
      auditFloor: {} as SkillHubOperatorItem["snapshot"]["auditFloor"],
      auditFloorSha256: "c".repeat(64),
      permissionEnvelope: {
        version: "goatcitadel.skill-permission-envelope.v1",
        toolIds: ["tool:fs.read", "tool:shell.exec"],
        environmentVariableNames: [],
        networkOrigins: [],
        filesystem: { readScopes: [], writeScopes: [] },
        scripts: [],
        dependencies: { packages: [], nativeRequirements: ["require:himalaya"] },
      },
      permissionEnvelopeSha256: "d".repeat(64),
      permissionDiff: {},
      compatibility: {},
      createdAt: CREATED_AT,
      ...snapshot,
    },
    runtime: { callable: false, activeVersion: false, inactiveCandidate: false, ...runtime },
    actions: {
      install_inactive: allowed,
      stage_update_candidate: { allowed: false, blockers: ["CANDIDATE_LINEAGE_MISSING"] },
      stage_rollback_candidate: { allowed: false, blockers: ["CANDIDATE_LINEAGE_MISSING"] },
      activate: { allowed: false, blockers: ["INACTIVE_CANDIDATE_MISSING"] },
      revoke: { allowed: false, blockers: ["VERSION_NOT_ACTIVE"] },
      ...actions,
    },
  };
}

/** One Hub approval summary; a settled one carries the settlement's disposition. */
export function hubApproval(
  operationKind: SkillHubOperatorApprovalSummary["operationKind"],
  status: SkillHubOperatorApprovalSummary["status"],
  settled?: NonNullable<SkillHubOperatorApprovalSummary["settlement"]>["disposition"],
): SkillHubOperatorApprovalSummary {
  return {
    approvalId: `approval-${operationKind}`,
    operationId: `skill-hub-op-${operationKind}`,
    operationKind,
    status,
    createdAt: CREATED_AT,
    ...(status === "pending" ? {} : { resolvedAt: CREATED_AT }),
    ...(settled
      ? {
          settlement: {
            settlementId: `settlement-${operationKind}`,
            disposition: settled,
            resultSha256: "e".repeat(64),
            evidenceEnvelopeId: `evidence-${operationKind}`,
            journeyEventId: `journey-${operationKind}`,
            settledAt: CREATED_AT,
          },
        }
      : {}),
  };
}
