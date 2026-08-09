import { createHash } from "node:crypto";
import { describe, expect, expectTypeOf, it } from "vitest";
import { canonicalJsonString } from "./canonical-json.js";
import type {
  ChatSecureConfigurationSubmitRequest,
  ChatUserInputPromptAnswerResponse,
  ChatUserInputPromptRecord,
} from "./chat.js";
import {
  GOVERNED_REMEDIATION_FAILURE_SCHEMA_VERSION,
  GOVERNED_REMEDIATION_PHASE_CLAIM_SCHEMA_VERSION,
  GOVERNED_REMEDIATION_RECEIPT_SCHEMA_VERSION,
  GOVERNED_REMEDIATION_RECIPE_SCHEMA_VERSION,
  GOVERNED_REMEDIATION_RECONCILIATION_SCHEMA_VERSION,
  GOVERNED_REMEDIATION_SCOPE_SCHEMA_VERSION,
  GOVERNED_REMEDIATION_STATE_SCHEMA_VERSION,
  governedRemediationRecipeSha256,
  governedRemediationReconciliationCanTransition,
  governedRemediationStateCanTransition,
  normalizeGovernedRemediationFailure,
  normalizeGovernedRemediationPhaseClaim,
  normalizeGovernedRemediationReceipt,
  normalizeGovernedRemediationRecipe,
  normalizeGovernedRemediationReconciliation,
  normalizeGovernedRemediationScope,
  normalizeGovernedRemediationStateRecord,
  type GovernedRemediationFailure,
  type GovernedRemediationRecipe,
  type GovernedRemediationReconciliation,
  type GovernedRemediationScope,
  type GovernedRemediationStateRecord,
} from "./governed-remediation.js";

const NOW = "2026-08-08T12:00:00.000Z";
const LATER = "2026-08-08T12:05:00.000Z";
const EXPIRES = "2026-08-08T12:15:00.000Z";

function installationScope(overrides: Partial<GovernedRemediationScope> = {}): GovernedRemediationScope {
  return {
    schemaVersion: GOVERNED_REMEDIATION_SCOPE_SCHEMA_VERSION,
    deploymentId: "root-installation-a",
    scopeKind: "installation",
    scopeId: "root-installation-a",
    targetId: "brave_search",
    ...overrides,
  };
}

function credentialRecipe(overrides: Partial<GovernedRemediationRecipe> = {}): GovernedRemediationRecipe {
  return {
    schemaVersion: GOVERNED_REMEDIATION_RECIPE_SCHEMA_VERSION,
    recipeId: "search.brave.credential.configure",
    recipeVersion: 1,
    repairClass: "credential",
    ownerId: "search-credential-owner",
    targetId: "brave_search",
    requestedCapabilityId: "browser.search",
    executionMode: "governed",
    allowedScopeKinds: ["installation"],
    allowedDeploymentProfiles: ["local_dev", "trusted_local"],
    inputKind: "secure_credential",
    preEffectApproval: "not_required",
    activationMode: "not_applicable",
    activationApproval: "not_applicable",
    verificationProbeId: "search.brave.live-probe.v1",
    rollbackStrategy: "restore_previous",
    maxApplyAttempts: 1,
    ...overrides,
  };
}

function awaitingSecureInputState(
  overrides: Partial<GovernedRemediationStateRecord> = {},
): GovernedRemediationStateRecord {
  return {
    schemaVersion: GOVERNED_REMEDIATION_STATE_SCHEMA_VERSION,
    remediationId: "remediation-a",
    workspaceId: "workspace-a",
    sessionId: "session-a",
    sourceTurnId: "turn-a",
    durableRunId: "run-a",
    blockedCheckpointId: "checkpoint-a",
    requesterActorId: "actor-a",
    recipeId: "search.brave.credential.configure",
    recipeVersion: 1,
    recipeSha256: governedRemediationRecipeSha256(credentialRecipe()),
    scope: installationScope(),
    state: "awaiting_secure_input",
    revision: 3,
    expectedWaitingRunVersion: 7,
    expectedOwnerRevision: "a".repeat(64),
    parentReservationId: "reservation-a",
    promptId: "prompt-a",
    promptExpiresAt: EXPIRES,
    preEffectApprovalId: null,
    activationApprovalId: null,
    effectId: null,
    latestReceiptId: null,
    failureId: null,
    reconciliationId: null,
    createdAt: NOW,
    updatedAt: LATER,
    ...overrides,
  };
}

function failure(overrides: Partial<GovernedRemediationFailure> = {}): GovernedRemediationFailure {
  return {
    schemaVersion: GOVERNED_REMEDIATION_FAILURE_SCHEMA_VERSION,
    failureId: "failure-a",
    remediationId: "remediation-a",
    recipeId: "search.brave.credential.configure",
    recipeVersion: 1,
    scope: installationScope(),
    phase: "verify",
    reason: "credential_rejected",
    effectBoundary: "crossed",
    disposition: "rollback_required",
    ownerRevisionObserved: "b".repeat(64),
    occurredAt: LATER,
    ...overrides,
  };
}

function reconciliation(overrides: Partial<GovernedRemediationReconciliation> = {}): GovernedRemediationReconciliation {
  return {
    schemaVersion: GOVERNED_REMEDIATION_RECONCILIATION_SCHEMA_VERSION,
    reconciliationId: "reconciliation-a",
    remediationId: "remediation-a",
    failureId: "failure-a",
    recipeId: "search.brave.credential.configure",
    recipeVersion: 1,
    scope: installationScope(),
    domain: "effect",
    reason: "rollback_failed",
    observation: "unknown",
    state: "quarantined",
    ownerRevisionObserved: null,
    resolutionReceiptId: null,
    revision: 1,
    createdAt: NOW,
    updatedAt: LATER,
    ...overrides,
  };
}

function jsonRoundTrip<T>(value: T): unknown {
  return JSON.parse(JSON.stringify(value)) as unknown;
}

describe("governed remediation recipe and scope contracts", () => {
  it("represents the current installation-scoped secure-search vertical without changing its Chat contract", () => {
    const scope = normalizeGovernedRemediationScope(jsonRoundTrip(installationScope()));
    const recipe = normalizeGovernedRemediationRecipe(jsonRoundTrip(credentialRecipe()));

    expect(scope).toStrictEqual(installationScope());
    expect(recipe).toStrictEqual(credentialRecipe());
    expect(Object.isFrozen(scope)).toBe(true);
    expect(Object.isFrozen(recipe)).toBe(true);
    expect(Object.isFrozen(recipe.allowedDeploymentProfiles)).toBe(true);
    expect(recipe.allowedDeploymentProfiles).not.toContain("remote_hardened");

    expectTypeOf<ChatSecureConfigurationSubmitRequest>().toEqualTypeOf<{ secret: string }>();
    expectTypeOf<
      NonNullable<ChatUserInputPromptRecord["secureConfiguration"]>["scope"]
    >().toEqualTypeOf<"installation">();
    expectTypeOf<NonNullable<ChatUserInputPromptAnswerResponse["runtimeConfigurationReceipt"]>>().toMatchTypeOf<{
      targetId: string;
      provider: string;
      revision: string;
      scopeRef: string;
    }>();
  });

  it("canonicalizes bounded owner-authored scope/profile arrays and survives a second JSON parse", () => {
    const first = normalizeGovernedRemediationRecipe({
      ...credentialRecipe(),
      allowedScopeKinds: ["workspace", "installation"],
      allowedDeploymentProfiles: ["trusted_local", "local_dev"],
    });
    const second = normalizeGovernedRemediationRecipe(jsonRoundTrip(first));

    expect(first.allowedScopeKinds).toEqual(["installation", "workspace"]);
    expect(first.allowedDeploymentProfiles).toEqual(["local_dev", "trusted_local"]);
    expect(second).toStrictEqual(first);
    expect(governedRemediationRecipeSha256(first)).toBe(
      createHash("sha256").update(canonicalJsonString(first), "utf8").digest("hex"),
    );
    expect(governedRemediationRecipeSha256(second)).toBe(governedRemediationRecipeSha256(first));
    expect(
      governedRemediationRecipeSha256({
        ...first,
        activationMode: "owner_step",
        activationApproval: "required",
      }),
    ).not.toBe(governedRemediationRecipeSha256(first));
  });

  it("models explicit manual boundaries without granting generic repair authority", () => {
    const manual = normalizeGovernedRemediationRecipe({
      ...credentialRecipe(),
      recipeId: "product.binary.repair",
      repairClass: "product_source_or_binary",
      ownerId: "installer-updater-owner",
      targetId: "goatcitadel-desktop",
      requestedCapabilityId: "product.update",
      executionMode: "manual_required",
      inputKind: "none",
      preEffectApproval: "not_applicable",
      activationMode: "not_applicable",
      activationApproval: "not_applicable",
      verificationProbeId: null,
      rollbackStrategy: "manual_required",
      maxApplyAttempts: 0,
    });

    expect(manual.executionMode).toBe("manual_required");
    expect(() =>
      normalizeGovernedRemediationRecipe({ ...manual, executionMode: "governed", maxApplyAttempts: 1 }),
    ).toThrow(/outside generic remediation authority/u);
  });

  it("represents manual OAuth recovery without claiming redirect or token custody", () => {
    const manual = normalizeGovernedRemediationRecipe({
      ...credentialRecipe(),
      recipeId: "provider.openai-codex.oauth.manual-reconnect",
      repairClass: "oauth_connection",
      ownerId: "gateway.openai-codex-oauth",
      targetId: "gateway.llm.provider.openai-codex.oauth-owner",
      requestedCapabilityId: "llm.provider.openai-codex.oauth-credential-present",
      executionMode: "manual_required",
      inputKind: "none",
      preEffectApproval: "not_applicable",
      activationMode: "not_applicable",
      activationApproval: "not_applicable",
      verificationProbeId: null,
      rollbackStrategy: "manual_required",
      maxApplyAttempts: 0,
    });

    expect(manual).toMatchObject({
      repairClass: "oauth_connection",
      executionMode: "manual_required",
      inputKind: "none",
    });
    expect(() => normalizeGovernedRemediationRecipe({ ...manual, inputKind: "oauth_redirect" })).toThrow(
      /Manual recipes cannot declare input/u,
    );
  });

  it("rejects secret/command extensions and unsafe recipe combinations", () => {
    expect(() => normalizeGovernedRemediationRecipe({ ...credentialRecipe(), secret: "do-not-store" })).toThrow(
      /unsupported fields/u,
    );
    expect(() =>
      normalizeGovernedRemediationRecipe({ ...credentialRecipe(), command: "npm install anything" }),
    ).toThrow(/unsupported fields/u);
    expect(() =>
      normalizeGovernedRemediationRecipe({ ...credentialRecipe(), inputKind: "operator_confirmation" }),
    ).toThrow(/dedicated secure-credential/u);
    expect(() =>
      normalizeGovernedRemediationRecipe({
        ...credentialRecipe(),
        repairClass: "oauth_connection",
        inputKind: "none",
      }),
    ).toThrow(/dedicated redirect\/token/u);
    expect(() =>
      normalizeGovernedRemediationRecipe({ ...credentialRecipe(), preEffectApproval: "required_before_apply" }),
    ).toThrow(/cannot wait for approval after collection/u);
    expect(() => normalizeGovernedRemediationRecipe({ ...credentialRecipe(), verificationProbeId: null })).toThrow(
      /require a live probe/u,
    );
    expect(() =>
      normalizeGovernedRemediationRecipe({
        ...credentialRecipe(),
        allowedDeploymentProfiles: ["local_dev", "local_dev"],
      }),
    ).toThrow(/cannot contain duplicates/u);
    expect(() =>
      normalizeGovernedRemediationRecipe({
        ...credentialRecipe(),
        activationMode: "owner_step",
        activationApproval: "not_applicable",
      }),
    ).toThrow(/activation mode and approval posture/u);
  });
});

describe("governed remediation durable state", () => {
  it("freezes the documented primary-turn transition graph", () => {
    expect(governedRemediationStateCanTransition("blocked", "offered")).toBe(true);
    expect(governedRemediationStateCanTransition("offered", "awaiting_secure_input")).toBe(true);
    expect(governedRemediationStateCanTransition("verifying", "credential_verified")).toBe(true);
    expect(governedRemediationStateCanTransition("verifying", "verified")).toBe(true);
    expect(governedRemediationStateCanTransition("verified", "resuming")).toBe(true);
    expect(governedRemediationStateCanTransition("resuming", "reconciling_resume")).toBe(true);
    expect(governedRemediationStateCanTransition("reconciling_resume", "completed")).toBe(true);
    expect(governedRemediationStateCanTransition("rolling_back", "rollback_failed")).toBe(true);
    expect(governedRemediationStateCanTransition("verifying", "failed")).toBe(true);
    expect(governedRemediationStateCanTransition("credential_verified", "declined")).toBe(true);
    expect(governedRemediationStateCanTransition("verified", "failed")).toBe(true);
    expect(governedRemediationStateCanTransition("verified", "rolling_back")).toBe(false);
    expect(governedRemediationStateCanTransition("completed", "applying")).toBe(false);
    expect(governedRemediationStateCanTransition("rollback_failed", "completed")).toBe(false);
  });

  it("round-trips a secret-free waiting record with exact run and owner revision fences", () => {
    const first = normalizeGovernedRemediationStateRecord(jsonRoundTrip(awaitingSecureInputState()));
    const second = normalizeGovernedRemediationStateRecord(jsonRoundTrip(first));

    expect(first).toStrictEqual(awaitingSecureInputState());
    expect(second).toStrictEqual(first);
    expect(Object.isFrozen(first)).toBe(true);
    expect(Object.isFrozen(first.scope)).toBe(true);
  });

  it("requires exact prompt, failure, reconciliation, and terminal receipt linkage", () => {
    expect(() => normalizeGovernedRemediationStateRecord(awaitingSecureInputState({ promptExpiresAt: null }))).toThrow(
      /recorded together/u,
    );
    expect(() =>
      normalizeGovernedRemediationStateRecord(awaitingSecureInputState({ promptId: null, promptExpiresAt: null })),
    ).toThrow(/requires an active prompt/u);
    expect(() =>
      normalizeGovernedRemediationStateRecord(
        awaitingSecureInputState({ state: "failed", promptId: null, promptExpiresAt: null }),
      ),
    ).toThrow(/requires a typed failure reference/u);
    expect(() =>
      normalizeGovernedRemediationStateRecord(
        awaitingSecureInputState({
          state: "rollback_failed",
          promptId: null,
          promptExpiresAt: null,
          failureId: "failure-a",
        }),
      ),
    ).toThrow(/requires a durable reconciliation reference/u);
    expect(() =>
      normalizeGovernedRemediationStateRecord(
        awaitingSecureInputState({ state: "completed", promptId: null, promptExpiresAt: null }),
      ),
    ).toThrow(/requires a canonical receipt reference/u);
  });

  it("rejects secret-bearing or version-drifted durable shapes", () => {
    expect(() =>
      normalizeGovernedRemediationStateRecord({ ...awaitingSecureInputState(), secret: "do-not-store" }),
    ).toThrow(/unsupported fields/u);
    expect(() =>
      normalizeGovernedRemediationStateRecord({
        ...awaitingSecureInputState(),
        schemaVersion: "goatcitadel.governed-remediation-state.v2",
      }),
    ).toThrow(/schema version is unsupported/u);
    expect(() =>
      normalizeGovernedRemediationStateRecord({
        ...awaitingSecureInputState(),
        recipeSha256: "A".repeat(64),
      }),
    ).toThrow(/lower-case SHA-256 digest/u);
  });
});

describe("governed remediation durable phase claims", () => {
  const activeClaim = {
    schemaVersion: GOVERNED_REMEDIATION_PHASE_CLAIM_SCHEMA_VERSION,
    claimId: "claim-a",
    aggregateKind: "state",
    aggregateId: "remediation-a",
    remediationId: "remediation-a",
    phase: "apply",
    claimRevision: 1,
    claimantId: "gateway-a",
    expectedAggregateRevision: 4,
    operationId: "apply-a",
    effectId: "effect-a",
    expectedOwnerRevision: "a".repeat(64),
    leaseTokenSha256: "b".repeat(64),
    leaseExpiresAt: EXPIRES,
    status: "active",
    requestSha256: "c".repeat(64),
    outcomeSha256: null,
    createdAt: NOW,
    updatedAt: LATER,
  } as const;

  it("round-trips secret-free active and completed phase claims", () => {
    const active = normalizeGovernedRemediationPhaseClaim(jsonRoundTrip(activeClaim));
    const completed = normalizeGovernedRemediationPhaseClaim({
      ...active,
      status: "completed",
      outcomeSha256: "d".repeat(64),
    });
    expect(active).toStrictEqual(activeClaim);
    expect(completed.status).toBe("completed");
    expect(Object.isFrozen(completed)).toBe(true);
  });

  it("rejects bearer material, digest drift, mismatched effects, and incomplete completion", () => {
    expect(() => normalizeGovernedRemediationPhaseClaim({ ...activeClaim, leaseToken: "raw-bearer" })).toThrow(
      /unsupported fields/u,
    );
    expect(() =>
      normalizeGovernedRemediationPhaseClaim({ ...activeClaim, leaseTokenSha256: "B".repeat(64) }),
    ).toThrow(/lower-case SHA-256/u);
    expect(() => normalizeGovernedRemediationPhaseClaim({ ...activeClaim, effectId: null })).toThrow(
      /effect binding/u,
    );
    expect(() =>
      normalizeGovernedRemediationPhaseClaim({ ...activeClaim, phase: "effect_reconcile" }),
    ).toThrow(/aggregate kind/u);
    expect(() =>
      normalizeGovernedRemediationPhaseClaim({ ...activeClaim, status: "completed", outcomeSha256: null }),
    ).toThrow(/status and outcome digest/u);
  });
});

describe("governed remediation canonical receipts", () => {
  const common = {
    schemaVersion: GOVERNED_REMEDIATION_RECEIPT_SCHEMA_VERSION,
    receiptId: "receipt-a",
    remediationId: "remediation-a",
    recipeId: "search.brave.credential.configure",
    recipeVersion: 1,
    scope: installationScope(),
    recordedAt: LATER,
  } as const;

  it("round-trips application, verification, rollback, resume, and reconciliation receipts", () => {
    const receipts = [
      {
        ...common,
        kind: "application",
        ownerId: "search-credential-owner",
        effectId: "effect-a",
        ownerRevisionBefore: null,
        ownerRevisionAfter: "a".repeat(64),
      },
      {
        ...common,
        receiptId: "receipt-b",
        kind: "verification",
        applicationReceiptId: "receipt-a",
        activationReceiptId: null,
        probeId: "search.brave.live-probe.v1",
        probeResult: "accepted",
        ownerRevisionObserved: "a".repeat(64),
      },
      {
        ...common,
        receiptId: "receipt-c",
        kind: "activation",
        applicationReceiptId: "receipt-a",
        initialVerificationReceiptId: "receipt-b",
        ownerRevisionBefore: "a".repeat(64),
        ownerRevisionAfter: "b".repeat(64),
      },
      {
        ...common,
        receiptId: "receipt-c2",
        kind: "rollback",
        applicationReceiptId: "receipt-a",
        rollbackStrategy: "restore_previous",
        outcome: "rolled_back",
        ownerRevisionBefore: "a".repeat(64),
        ownerRevisionAfter: "b".repeat(64),
      },
      {
        ...common,
        receiptId: "receipt-d",
        kind: "resume",
        verificationReceiptId: "receipt-b",
        durableRunId: "run-a",
        blockedCheckpointId: "checkpoint-a",
        resumedRunVersion: 8,
      },
      {
        ...common,
        receiptId: "receipt-e",
        kind: "reconciliation",
        reconciliationId: "reconciliation-a",
        failureId: "failure-a",
        resolution: "confirmed_rolled_back",
        applicationReceiptId: "receipt-a",
        resumeReceiptId: null,
        ownerRevisionObserved: "b".repeat(64),
      },
    ];

    for (const receipt of receipts) {
      const first = normalizeGovernedRemediationReceipt(jsonRoundTrip(receipt));
      const second = normalizeGovernedRemediationReceipt(jsonRoundTrip(first));
      expect(second).toStrictEqual(first);
      expect(Object.isFrozen(first)).toBe(true);
      expect(Object.isFrozen(first.scope)).toBe(true);
    }
  });

  it("does not let failed probes, manual rollback, raw payloads, or unknown versions mint receipts", () => {
    expect(() =>
      normalizeGovernedRemediationReceipt({
        ...common,
        kind: "verification",
        applicationReceiptId: "receipt-a",
        activationReceiptId: null,
        probeId: "search.brave.live-probe.v1",
        probeResult: "rejected",
        ownerRevisionObserved: "a".repeat(64),
      }),
    ).toThrow(/probe result is unsupported/u);
    expect(() =>
      normalizeGovernedRemediationReceipt({
        ...common,
        kind: "rollback",
        applicationReceiptId: "receipt-a",
        rollbackStrategy: "manual_required",
        outcome: "rolled_back",
        ownerRevisionBefore: "a".repeat(64),
        ownerRevisionAfter: "b".repeat(64),
      }),
    ).toThrow(/cannot claim a manual rollback/u);
    expect(() =>
      normalizeGovernedRemediationReceipt({
        ...common,
        kind: "application",
        ownerId: "search-credential-owner",
        effectId: "effect-a",
        ownerRevisionBefore: null,
        ownerRevisionAfter: "a".repeat(64),
        providerResponse: { secret: "do-not-store" },
      }),
    ).toThrow(/unsupported fields/u);
    expect(() =>
      normalizeGovernedRemediationReceipt({
        ...common,
        schemaVersion: "goatcitadel.governed-remediation-receipt.v2",
        kind: "application",
        ownerId: "search-credential-owner",
        effectId: "effect-a",
        ownerRevisionBefore: null,
        ownerRevisionAfter: "a".repeat(64),
      }),
    ).toThrow(/schema version is unsupported/u);
  });
});

describe("governed remediation failures and reconciliation", () => {
  it("round-trips typed secret-free failure truth and fences retries after a crossed boundary", () => {
    const first = normalizeGovernedRemediationFailure(jsonRoundTrip(failure()));
    const second = normalizeGovernedRemediationFailure(jsonRoundTrip(first));
    expect(second).toStrictEqual(first);
    expect(Object.isFrozen(first.scope)).toBe(true);

    expect(() => normalizeGovernedRemediationFailure(failure({ disposition: "retry_with_fresh_authority" }))).toThrow(
      /requires rollback or manual reconciliation/u,
    );
    expect(() =>
      normalizeGovernedRemediationFailure(failure({ effectBoundary: "not_crossed", disposition: "rollback_required" })),
    ).toThrow(/cannot be required/u);
    expect(() =>
      normalizeGovernedRemediationFailure(failure({ reason: "rollback_failed", disposition: "rollback_required" })),
    ).toThrow(/must retain crossed\/unknown effect truth/u);
    expect(() =>
      normalizeGovernedRemediationFailure(
        failure({
          phase: "preflight",
          reason: "unsupported_profile",
          effectBoundary: "not_crossed",
          disposition: "terminal_no_effect",
        }),
      ),
    ).toThrow(/require manual handling/u);
    expect(() => normalizeGovernedRemediationFailure({ ...failure(), error: "raw provider body" })).toThrow(
      /unsupported fields/u,
    );
  });

  it("keeps reconciliation quarantined until exact owner evidence resolves it", () => {
    expect(governedRemediationReconciliationCanTransition("open", "quarantined")).toBe(true);
    expect(governedRemediationReconciliationCanTransition("quarantined", "resolved_rolled_back")).toBe(true);
    expect(governedRemediationReconciliationCanTransition("resolved_rolled_back", "open")).toBe(false);

    const open = normalizeGovernedRemediationReconciliation(jsonRoundTrip(reconciliation()));
    expect(open).toStrictEqual(reconciliation());
    const resolved = normalizeGovernedRemediationReconciliation({
      ...open,
      observation: "rolled_back",
      state: "resolved_rolled_back",
      ownerRevisionObserved: "c".repeat(64),
      resolutionReceiptId: "receipt-e",
      revision: 2,
    });
    expect(normalizeGovernedRemediationReconciliation(jsonRoundTrip(resolved))).toStrictEqual(resolved);
  });

  it("rejects premature, contradictory, or unversioned reconciliation closure", () => {
    expect(() =>
      normalizeGovernedRemediationReconciliation({ ...reconciliation(), resolutionReceiptId: "receipt-e" }),
    ).toThrow(/cannot claim a resolution receipt/u);
    expect(() =>
      normalizeGovernedRemediationReconciliation({
        ...reconciliation(),
        state: "resolved_verified",
        observation: "effect_present_unverified",
        resolutionReceiptId: "receipt-e",
      }),
    ).toThrow(/requires an effect_verified/u);
    expect(() =>
      normalizeGovernedRemediationReconciliation({
        ...reconciliation(),
        schemaVersion: "goatcitadel.governed-remediation-reconciliation.v2",
      }),
    ).toThrow(/schema version is unsupported/u);
    expect(() => normalizeGovernedRemediationReconciliation({ ...reconciliation(), rawError: "secret" })).toThrow(
      /unsupported fields/u,
    );
  });
});
