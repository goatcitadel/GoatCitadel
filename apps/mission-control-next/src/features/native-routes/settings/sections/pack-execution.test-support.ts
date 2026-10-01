import type {
  ApprovalReplaySnapshot,
  CapabilityPackManifest,
  CapabilityPackPreview,
  ChangePlanRecord,
} from "@goatcitadel/contracts";
export const packManifest: CapabilityPackManifest = {
  packId: "pack",
  name: "Reviewed pack",
  description: "Test pack",
  version: "1.0.0",
  trustTier: "restricted",
  tags: [],
  assets: [
    {
      id: "asset",
      label: "Reviewed asset",
      kind: "mcp_template",
      runtimeSupport: "requires_configuration",
      installMode: "review_required",
      binding: { owner: "mcp", revision: "one", sha256: "b".repeat(64) },
    },
  ],
  policyDefaults: {
    requireFirstUseApproval: true,
    memoryWriteAuthority: "operator_controlled",
    redactionMode: "strict",
    autoRunEnabled: false,
  },
  provenance: { source: "bundled", publisher: "Fixture", contentHash: "a".repeat(64) },
  installWarnings: [],
};
export const packPreview: CapabilityPackPreview = {
  manifest: packManifest,
  unsupportedAssets: [],
  installPlan: [{ assetId: "asset", kind: "mcp_template", outcome: "review_required", reason: "Review" }],
  policyChanges: packManifest.policyDefaults,
  reviewRequired: true,
};
export function packPlan(overrides: Partial<ChangePlanRecord> = {}): ChangePlanRecord {
  return {
    schemaVersion: 1,
    planId: "plan",
    origin: { surface: "settings", workspaceId: "a", actorId: "operator" },
    adapter: { adapterId: "capability-pack-execution", version: 1 },
    kind: "capability_pack",
    scope: "capability",
    status: "awaiting_confirmation",
    phase: "confirmation",
    revision: 1,
    request: { kind: "capability_pack", packId: "pack", manifestHash: "a".repeat(64), assetIds: ["asset"] },
    intentHash: "c".repeat(64),
    target: { ownerId: "capability_pack", resourceId: "a:pack", expectedHash: "d".repeat(64) },
    title: "Set up Reviewed pack",
    summary: "Set up one asset",
    impact: "Can connect shared MCP.",
    risk: "danger",
    requiredAction: {
      kind: "confirmation",
      actionId: "confirm",
      actionNonce: "nonce-one",
      title: "Confirm",
      confirmationText: "Connect the reviewed shared server.",
    },
    approvalRefs: [],
    evidenceRefs: [],
    rollbackRefs: [],
    createdAt: "2026-09-30T12:00:00Z",
    updatedAt: "2026-09-30T12:00:00Z",
    ...overrides,
  };
}
export function approvedPack(plan: ChangePlanRecord): ApprovalReplaySnapshot {
  return {
    approval: {
      approvalId: "approval",
      kind: "change_plan_effect",
      riskLevel: "danger",
      status: "approved",
      resolutionOutcome: "approved",
      explanationStatus: "not_requested",
      preview: {},
      createdAt: plan.createdAt,
      linkage: { workspaceId: plan.origin.workspaceId, actionType: "change_plan_effect" },
      payload: {
        planId: plan.planId,
        kind: plan.kind,
        scope: plan.scope,
        intentHash: plan.intentHash,
        targetOwnerId: plan.target.ownerId,
        targetResourceId: plan.target.resourceId,
        targetHash: plan.target.expectedHash,
        targetRevision: plan.target.expectedRevision,
        adapterId: plan.adapter.adapterId,
        adapterVersion: plan.adapter.version,
      },
    },
    events: [],
    effects: [],
  };
}
