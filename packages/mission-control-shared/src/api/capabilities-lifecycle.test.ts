import { beforeEach, describe, expect, it, vi } from "vitest";

import * as capabilities from "./capabilities";

const apiMocks = vi.hoisted(() => ({
  request: vi.fn(),
  buildGatewayUrl: vi.fn((path: string) => `http://localhost:8787${path}`),
  clearGatewayAuthState: vi.fn(),
  readStoredGatewayAuthState: vi.fn(),
}));

vi.mock("./client-core.js", () => ({
  request: apiMocks.request,
  buildGatewayUrl: apiMocks.buildGatewayUrl,
  clearGatewayAuthState: apiMocks.clearGatewayAuthState,
  readStoredGatewayAuthState: apiMocks.readStoredGatewayAuthState,
}));

function pendingApproval(
  action: capabilities.CapabilityLifecyclePendingApproval["action"],
): capabilities.CapabilityLifecyclePendingApproval {
  return {
    approvalId: "22222222-3333-4444-5555-666677778888",
    status: "pending",
    kind: "capability.lifecycle",
    action,
    candidateId: "candidate-1",
    requestSha256: "a".repeat(64),
    expectedStateSha256: "b".repeat(64),
    createdAt: "2026-07-23T00:00:00.000Z",
    replayed: false,
  };
}

// HX-402 P2: direct candidate lifecycle verbs are approval-first. These tests
// pin the wire shape of each request AND both response envelopes (pending
// capability.lifecycle approval vs no-op detail).
describe("shared capabilities lifecycle API", () => {
  beforeEach(() => {
    apiMocks.request.mockReset();
  });

  it("requests promotion and surfaces the pending capability.lifecycle approval", async () => {
    apiMocks.request.mockResolvedValue({ pendingApproval: pendingApproval("candidate_promoted") });
    const outcome = await capabilities.promoteCapabilityCandidate("candidate-1", 3, "version-2");
    const [path, init] = apiMocks.request.mock.calls.at(-1) ?? [];
    expect(path).toBe("/api/v1/capabilities/candidates/candidate-1/promote");
    expect(JSON.parse((init as { body: string }).body)).toEqual({ expectedRevision: 3, versionId: "version-2" });
    expect(outcome.pendingApproval).toMatchObject({
      kind: "capability.lifecycle",
      action: "candidate_promoted",
      candidateId: "candidate-1",
    });
  });

  it("requests revocation without a version and binds the exact candidate", async () => {
    apiMocks.request.mockResolvedValue({ pendingApproval: pendingApproval("candidate_revoked") });
    const outcome = await capabilities.revokeCapabilityCandidate("candidate-1", 4);
    const [path, init] = apiMocks.request.mock.calls.at(-1) ?? [];
    expect(path).toBe("/api/v1/capabilities/candidates/candidate-1/revoke");
    expect(JSON.parse((init as { body: string }).body)).toEqual({ expectedRevision: 4 });
    expect(outcome.pendingApproval?.action).toBe("candidate_revoked");
  });

  it("requests rollback with the target version", async () => {
    apiMocks.request.mockResolvedValue({ pendingApproval: pendingApproval("candidate_rolled_back") });
    const outcome = await capabilities.rollbackCapabilityCandidate("candidate-1", "version-0", 5);
    const [path, init] = apiMocks.request.mock.calls.at(-1) ?? [];
    expect(path).toBe("/api/v1/capabilities/candidates/candidate-1/rollback");
    expect(JSON.parse((init as { body: string }).body)).toEqual({ expectedRevision: 5, targetVersionId: "version-0" });
    expect(outcome.pendingApproval?.action).toBe("candidate_rolled_back");
  });

  it("surfaces the no-op envelope when the reviewed candidate state already matches", async () => {
    apiMocks.request.mockResolvedValue({
      pendingApproval: null,
      noMutationRequired: true,
      detail: { candidateId: "candidate-1", revision: 4 },
    });
    const outcome = await capabilities.promoteCapabilityCandidate("candidate-1", 4, "version-2");
    expect(outcome.pendingApproval).toBeNull();
    if (outcome.pendingApproval === null) {
      expect(outcome.noMutationRequired).toBe(true);
      expect(outcome.detail).toMatchObject({ candidateId: "candidate-1" });
    }
  });
});
