import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { canonicalJsonString } from "./canonical-json.js";
import {
  REMOTE_WORKER_INFERENCE_BUDGET_SCHEMA_VERSION,
  REMOTE_WORKER_INFERENCE_EFFECTIVE_ROUTE_SCHEMA_VERSION,
  REMOTE_WORKER_INFERENCE_FRAME_GENESIS_SHA256,
  REMOTE_WORKER_INFERENCE_FRAME_SCHEMA_VERSION,
  REMOTE_WORKER_INFERENCE_GOVERNANCE_SCHEMA_VERSION,
  REMOTE_WORKER_INFERENCE_MAX_MESSAGES,
  REMOTE_WORKER_INFERENCE_MAX_MESSAGE_CHARS,
  REMOTE_WORKER_INFERENCE_MAX_TEMPERATURE_MILLI,
  REMOTE_WORKER_INFERENCE_REQUEST_SCHEMA_VERSION,
  authorizeRemoteWorkerInferenceRequestSubmission,
  isRemoteWorkerInferenceTerminalState,
  normalizeRemoteWorkerInferenceBudgetReservation,
  normalizeRemoteWorkerInferenceEffectiveRouteReceipt,
  normalizeRemoteWorkerInferenceFramePayload,
  normalizeRemoteWorkerInferenceGovernanceReceipt,
  normalizeRemoteWorkerInferenceReleaseReason,
  normalizeRemoteWorkerInferenceAuthorizedSubmission,
  remoteWorkerInferenceCanonicalRequestBody,
  remoteWorkerInferenceCanonicalRequestBodySha256,
  remoteWorkerInferenceCanonicalSha256,
  remoteWorkerInferenceEffectiveRouteSha256,
  remoteWorkerInferenceFrameSha256,
  remoteWorkerInferenceLeaseTokenSha256,
  remoteWorkerInferenceRequestReplayMaterial,
  remoteWorkerInferenceRequestSha256,
  remoteWorkerInferenceBudgetOperationSha256,
  remoteWorkerInferenceStateCanTransition,
  type RemoteWorkerInferenceRequestSubmission,
} from "./remote-worker-inference.js";

const D = (value: string): string => createHash("sha256").update(value, "utf8").digest("hex");

function submission(
  overrides: Partial<RemoteWorkerInferenceRequestSubmission> = {},
): RemoteWorkerInferenceRequestSubmission {
  return {
    registryWorkspaceId: "default",
    assignmentId: "assignment-1",
    assignmentGeneration: 3,
    inferenceRequestId: "inference-1",
    attempt: 1,
    idempotencyKey: "idem-1",
    leaseToken: "raw-lease-secret-abc",
    messages: [
      { role: "system", text: "You are bounded." },
      { role: "user", text: "Hello." },
    ],
    inputSha256: D("input"),
    contextSha256: D("context"),
    modelIntentSha256: D("intent"),
    outputTokenCeiling: 4096,
    reasoningTokenCeiling: 1024,
    temperatureMilli: 700,
    ...overrides,
  };
}

function authorized(overrides: Partial<RemoteWorkerInferenceRequestSubmission> = {}) {
  return authorizeRemoteWorkerInferenceRequestSubmission(submission(overrides)).submission;
}

describe("HX-503 remote worker inference submission", () => {
  it("normalizes and freezes the exact bounded submission", () => {
    const result = authorizeRemoteWorkerInferenceRequestSubmission(submission());
    const normalized = result.submission;
    expect(Object.isFrozen(normalized)).toBe(true);
    expect(Object.isFrozen(normalized.messages)).toBe(true);
    expect(normalized.messages).toHaveLength(2);
    expect(result.leaseTokenSha256).toBe(D("raw-lease-secret-abc"));
    expect(canonicalJsonString(result)).not.toContain("raw-lease-secret-abc");
    expect(canonicalJsonString(normalized)).not.toContain("leaseToken");
  });

  it("uses browser-safe canonical SHA-256 parity", () => {
    const value = { b: 2, a: [1, { z: "9" }] };
    expect(remoteWorkerInferenceCanonicalSha256(value)).toBe(D(canonicalJsonString(value)));
  });

  it("keeps the raw lease out of the canonical request material and body", () => {
    const material = remoteWorkerInferenceRequestReplayMaterial(authorized());
    const body = remoteWorkerInferenceCanonicalRequestBody(authorized());
    expect(canonicalJsonString(material)).not.toContain("raw-lease-secret");
    expect(canonicalJsonString(body)).not.toContain("raw-lease-secret");
    expect(canonicalJsonString(material)).not.toContain("leaseToken");
  });

  it("hashes the raw lease token deterministically and independently of the request hash", () => {
    expect(remoteWorkerInferenceLeaseTokenSha256("raw-lease-secret-abc")).toBe(D("raw-lease-secret-abc"));
    expect(remoteWorkerInferenceLeaseTokenSha256("raw-lease-secret-abc")).not.toBe(
      remoteWorkerInferenceRequestSha256(authorized()),
    );
  });

  it("holds the request hash stable across lease rotation but changes on body drift", () => {
    const base = remoteWorkerInferenceRequestSha256(authorized());
    expect(remoteWorkerInferenceRequestSha256(authorized({ leaseToken: "rotated-lease-token" }))).toBe(base);
    expect(remoteWorkerInferenceRequestSha256(authorized({ temperatureMilli: 701 }))).not.toBe(base);
    expect(remoteWorkerInferenceRequestSha256(authorized({ messages: [{ role: "user", text: "Hi." }] }))).not.toBe(
      base,
    );
    expect(remoteWorkerInferenceCanonicalRequestBodySha256(authorized())).toBe(
      remoteWorkerInferenceCanonicalRequestBodySha256(authorized({ leaseToken: "rotated", idempotencyKey: "other" })),
    );
  });

  it("pins the canonical request body schema version", () => {
    const body = remoteWorkerInferenceCanonicalRequestBody(authorized()) as { schemaVersion: string };
    expect(body.schemaVersion).toBe(REMOTE_WORKER_INFERENCE_REQUEST_SCHEMA_VERSION);
  });

  it("rejects every forbidden provider/credential/tool/metadata field", () => {
    for (const forbidden of [
      "provider",
      "providerId",
      "model",
      "modelId",
      "apiStyle",
      "providerUrl",
      "credentialRef",
      "apiKey",
      "headers",
      "tools",
      "memory",
      "metadata",
      "serviceTier",
      "fallback",
      "fallbackList",
      "multimodal",
      "images",
      "attachments",
    ]) {
      expect(() =>
        authorizeRemoteWorkerInferenceRequestSubmission({
          ...submission(),
          [forbidden]: "x",
        } as unknown as RemoteWorkerInferenceRequestSubmission),
      ).toThrow(/unknown fields/u);
    }
  });

  it("enforces message count, per-message size, and total request size bounds", () => {
    expect(() => authorizeRemoteWorkerInferenceRequestSubmission(submission({ messages: [] }))).toThrow(/bounded/u);
    const tooMany = Array.from({ length: REMOTE_WORKER_INFERENCE_MAX_MESSAGES + 1 }, () => ({
      role: "user" as const,
      text: "x",
    }));
    expect(() => authorizeRemoteWorkerInferenceRequestSubmission(submission({ messages: tooMany }))).toThrow(
      /bounded/u,
    );
    expect(() =>
      authorizeRemoteWorkerInferenceRequestSubmission(
        submission({ messages: [{ role: "user", text: "x".repeat(REMOTE_WORKER_INFERENCE_MAX_MESSAGE_CHARS + 1) }] }),
      ),
    ).toThrow(/invalid/u);
  });

  it("rejects unsupported roles, non-hex hashes, and out-of-range ceilings", () => {
    expect(() =>
      authorizeRemoteWorkerInferenceRequestSubmission(submission({ messages: [{ role: "tool" as never, text: "x" }] })),
    ).toThrow(/unsupported/u);
    expect(() => authorizeRemoteWorkerInferenceRequestSubmission(submission({ inputSha256: "NOTHEX" }))).toThrow(
      /digest/u,
    );
    expect(() => authorizeRemoteWorkerInferenceRequestSubmission(submission({ outputTokenCeiling: 0 }))).toThrow(
      /positive integer/u,
    );
    expect(() =>
      authorizeRemoteWorkerInferenceRequestSubmission(
        submission({ temperatureMilli: REMOTE_WORKER_INFERENCE_MAX_TEMPERATURE_MILLI + 1 }),
      ),
    ).toThrow(/non-negative/u);
    expect(() => authorizeRemoteWorkerInferenceRequestSubmission(submission({ reasoningTokenCeiling: -1 }))).toThrow(
      /non-negative/u,
    );
  });

  it("rejects prototype-pollution and cyclic message payloads", () => {
    const cyclic: Record<string, unknown> = { role: "user", text: "x" };
    cyclic.text = cyclic;
    expect(() =>
      authorizeRemoteWorkerInferenceRequestSubmission(submission({ messages: [cyclic as never] })),
    ).toThrow();
    expect(() =>
      authorizeRemoteWorkerInferenceRequestSubmission(
        JSON.parse('{"__proto__":{"polluted":true}}') as RemoteWorkerInferenceRequestSubmission,
      ),
    ).toThrow();
  });

  it("rejects raw lease material at every authorized downstream contract", () => {
    expect(() => normalizeRemoteWorkerInferenceAuthorizedSubmission(submission() as never)).toThrow(/unknown fields/u);
    expect(() => remoteWorkerInferenceRequestSha256(submission() as never)).toThrow(/unknown fields/u);
  });
});

describe("HX-503 remote worker inference output frames", () => {
  it("normalizes an allowlisted output_text frame and rejects unknown fields", () => {
    const payload = normalizeRemoteWorkerInferenceFramePayload({
      schemaVersion: REMOTE_WORKER_INFERENCE_FRAME_SCHEMA_VERSION,
      kind: "output_text",
      text: "hello",
    });
    expect(Object.isFrozen(payload)).toBe(true);
    expect(() =>
      normalizeRemoteWorkerInferenceFramePayload({
        schemaVersion: REMOTE_WORKER_INFERENCE_FRAME_SCHEMA_VERSION,
        kind: "output_text",
        text: "hi",
        reasoning: "secret chain of thought",
      } as never),
    ).toThrow(/unknown fields/u);
  });

  it("normalizes a terminal frame and binds the optional HX-306 usage event", () => {
    const payload = normalizeRemoteWorkerInferenceFramePayload({
      schemaVersion: REMOTE_WORKER_INFERENCE_FRAME_SCHEMA_VERSION,
      kind: "terminal",
      terminalState: "completed",
      usageEventId: "usage-1",
    });
    expect(payload).toMatchObject({ kind: "terminal", terminalState: "completed", usageEventId: "usage-1" });
  });

  it("chains frame hashes over sequence, payload, previous hash, and effective route", () => {
    const first = remoteWorkerInferenceFrameSha256({
      registryWorkspaceId: "default",
      assignmentId: "assignment-1",
      assignmentGeneration: 3,
      inferenceRequestId: "inference-1",
      attempt: 1,
      frameSequence: 1,
      frameKind: "output_text",
      payloadSha256: D("payload-1"),
      previousFrameSha256: REMOTE_WORKER_INFERENCE_FRAME_GENESIS_SHA256,
      effectiveRouteSha256: D("route"),
    });
    const second = remoteWorkerInferenceFrameSha256({
      registryWorkspaceId: "default",
      assignmentId: "assignment-1",
      assignmentGeneration: 3,
      inferenceRequestId: "inference-1",
      attempt: 1,
      frameSequence: 2,
      frameKind: "output_text",
      payloadSha256: D("payload-2"),
      previousFrameSha256: first,
      effectiveRouteSha256: D("route"),
    });
    expect(first).toMatch(/^[0-9a-f]{64}$/u);
    expect(second).not.toBe(first);
  });

  it("identifies terminal states", () => {
    expect(isRemoteWorkerInferenceTerminalState("completed")).toBe(true);
    expect(isRemoteWorkerInferenceTerminalState("streaming")).toBe(false);
  });
});

describe("HX-503 remote worker inference governance and budget receipts", () => {
  it("accepts only the closed release reason code set", () => {
    expect(normalizeRemoteWorkerInferenceReleaseReason("governance_denied")).toBe("governance_denied");
    expect(() => normalizeRemoteWorkerInferenceReleaseReason("Bearer secret release reason")).toThrow(/unsupported/u);
  });

  it("normalizes an allowed governance receipt and rejects credential leakage", () => {
    const receipt = normalizeRemoteWorkerInferenceGovernanceReceipt({
      schemaVersion: REMOTE_WORKER_INFERENCE_GOVERNANCE_SCHEMA_VERSION,
      decision: "allowed",
      effectiveRouteSha256: D("route"),
      policyRevision: 4,
      policySha256: D("policy"),
      outputTokenCeiling: 4096,
      reasoningTokenCeiling: 1024,
      expiresAt: "2026-07-14T00:00:00.000Z",
    });
    expect(receipt.decision).toBe("allowed");
    expect(() =>
      normalizeRemoteWorkerInferenceGovernanceReceipt({
        schemaVersion: REMOTE_WORKER_INFERENCE_GOVERNANCE_SCHEMA_VERSION,
        decision: "allowed",
        effectiveRouteSha256: D("route"),
        policyRevision: 4,
        policySha256: D("policy"),
        outputTokenCeiling: 4096,
        reasoningTokenCeiling: 1024,
        expiresAt: "2026-07-14T00:00:00.000Z",
        apiKey: "sk-leak",
      } as never),
    ).toThrow(/unknown fields/u);
  });

  it("requires an approval receipt exactly for approval_required", () => {
    expect(() =>
      normalizeRemoteWorkerInferenceGovernanceReceipt({
        schemaVersion: REMOTE_WORKER_INFERENCE_GOVERNANCE_SCHEMA_VERSION,
        decision: "approval_required",
        effectiveRouteSha256: D("route"),
        policyRevision: 4,
        policySha256: D("policy"),
        outputTokenCeiling: 4096,
        reasoningTokenCeiling: 1024,
        expiresAt: "2026-07-14T00:00:00.000Z",
      }),
    ).toThrow(/approval receipt/u);
    const receipt = normalizeRemoteWorkerInferenceGovernanceReceipt({
      schemaVersion: REMOTE_WORKER_INFERENCE_GOVERNANCE_SCHEMA_VERSION,
      decision: "approval_required",
      effectiveRouteSha256: D("route"),
      policyRevision: 4,
      policySha256: D("policy"),
      approvalReceiptSha256: D("approval"),
      outputTokenCeiling: 4096,
      reasoningTokenCeiling: 1024,
      expiresAt: "2026-07-14T00:00:00.000Z",
    });
    expect(receipt.approvalReceiptSha256).toBe(D("approval"));
  });

  it("normalizes a budget reservation", () => {
    const reservation = normalizeRemoteWorkerInferenceBudgetReservation({
      schemaVersion: REMOTE_WORKER_INFERENCE_BUDGET_SCHEMA_VERSION,
      budgetOwnerId: "workspace-budget-owner",
      reservationId: "reservation-1",
      operationId: "operation-1",
      operationSha256: D("operation"),
      requestSha256: D("request"),
      effectiveRouteSha256: D("route"),
      reservedOutputTokens: 4096,
      reservedReasoningTokens: 1024,
      reservedCostMicrousd: 1250,
      expiresAt: "2026-07-14T00:00:00.000Z",
    });
    expect(reservation.reservedOutputTokens).toBe(4096);
  });

  it("hashes the runtime-exact secret-free route and rejects credential-lineage injection", () => {
    const route = {
      schemaVersion: REMOTE_WORKER_INFERENCE_EFFECTIVE_ROUTE_SCHEMA_VERSION,
      providerId: "anthropic",
      modelId: "claude-opus-4",
      apiStyle: "anthropic_messages",
      credentialType: "api_key" as const,
      usagePool: "standard" as const,
      credentialSource: "env" as const,
      credentialConfigFingerprint: D("secret-free-provider-config"),
      pricingCatalogVersion: "2026-08-01",
      pricingCatalogHash: D("catalog"),
      inputRateUsdPerMillion: 15,
      outputRateUsdPerMillion: 75,
    };
    const normalized = normalizeRemoteWorkerInferenceEffectiveRouteReceipt(route);
    expect(remoteWorkerInferenceEffectiveRouteSha256(normalized)).not.toBe(
      remoteWorkerInferenceEffectiveRouteSha256({ ...route, usagePool: "subscription" }),
    );
    expect(() =>
      normalizeRemoteWorkerInferenceEffectiveRouteReceipt({
        ...route,
        credentialConfigFingerprint: "sk-proj-super-secret",
      }),
    ).toThrow(/SHA-256|secret-like/u);
    expect(() =>
      normalizeRemoteWorkerInferenceEffectiveRouteReceipt({
        ...route,
        credentialSource: "sk-proj-super-secret" as never,
      }),
    ).toThrow(/credentialSource/u);
    expect(() =>
      normalizeRemoteWorkerInferenceEffectiveRouteReceipt({
        ...route,
        usagePool: "Bearer super-secret" as never,
      }),
    ).toThrow(/usagePool/u);
  });

  it("rejects secret-like operation and dispatch identities", () => {
    const operation = {
      operationId: "sk-proj-super-secret",
      dispatchGeneration: "dispatch-1",
      requestSha256: D("request"),
      effectiveRouteSha256: D("route"),
      registryWorkspaceId: "default",
      executionWorkspaceId: "default",
      assignmentId: "assignment-1",
      assignmentGeneration: 1,
      workerId: "worker-1",
      workerGeneration: 1,
      admittedLeaseRevision: 1,
      sessionId: "session-1",
      turnId: "turn-1",
      durableRunId: "run-1",
      taskId: "task-1",
      capabilityProfileSha256: D("profile"),
      routedContextSha256: D("context"),
      outputTokenCeiling: 64,
      reasoningTokenCeiling: 0,
    };
    expect(() => remoteWorkerInferenceBudgetOperationSha256(operation)).toThrow(/secret-like/u);
    expect(() =>
      remoteWorkerInferenceBudgetOperationSha256({
        ...operation,
        operationId: "operation-1",
        dispatchGeneration: "Bearer dispatch-secret-canary",
      }),
    ).toThrow(/secret-like/u);
  });
});

describe("HX-503 remote worker inference state machine", () => {
  it("permits the documented transitions and rejects illegal ones", () => {
    expect(remoteWorkerInferenceStateCanTransition("admitted", "dispatch_claimed")).toBe(true);
    expect(remoteWorkerInferenceStateCanTransition("admitted", "waiting_approval")).toBe(true);
    expect(remoteWorkerInferenceStateCanTransition("waiting_approval", "admitted")).toBe(true);
    expect(remoteWorkerInferenceStateCanTransition("dispatch_claimed", "streaming")).toBe(true);
    expect(remoteWorkerInferenceStateCanTransition("dispatch_claimed", "dispatch_unknown")).toBe(true);
    expect(remoteWorkerInferenceStateCanTransition("streaming", "completed")).toBe(true);
    // Illegal / terminal-out transitions.
    expect(remoteWorkerInferenceStateCanTransition("completed", "streaming")).toBe(false);
    expect(remoteWorkerInferenceStateCanTransition("blocked", "dispatch_claimed")).toBe(false);
    expect(remoteWorkerInferenceStateCanTransition("admitted", "streaming")).toBe(false);
    expect(remoteWorkerInferenceStateCanTransition("admitted", "admitted")).toBe(false);
    expect(remoteWorkerInferenceStateCanTransition("dispatch_unknown", "completed")).toBe(false);
  });
});
