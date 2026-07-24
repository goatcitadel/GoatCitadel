import { beforeEach, describe, expect, it, vi } from "vitest";

import * as improvement from "./improvement";

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

const PENDING_APPROVAL: improvement.ImprovementLifecyclePendingApproval = {
  approvalId: "11111111-2222-3333-4444-555555555555",
  status: "pending",
  kind: "improvement.lifecycle",
  operationKind: "pause",
  targetKind: "improvement_activation",
  targetId: "activation-1",
  workspaceId: "default",
  requestSha256: "a".repeat(64),
  expectedStateSha256: "b".repeat(64),
  createdAt: "2026-07-23T00:00:00.000Z",
  replayed: false,
};

// HX-402 P3: the improvement activation lifecycle surface is approval-first.
// These tests pin the wire shape of each request AND both response envelopes
// (pending improvement.lifecycle approval vs pure no-op) so UI consumers
// discriminate honestly — the request itself never mutates anything.
describe("shared improvement lifecycle API", () => {
  beforeEach(() => {
    apiMocks.request.mockReset();
  });

  it("requests an activation approval and surfaces the pending improvement.lifecycle envelope", async () => {
    apiMocks.request.mockResolvedValue({
      pendingApproval: { ...PENDING_APPROVAL, operationKind: "activate", targetKind: "improvement_candidate" },
    });
    const outcome = await improvement.requestImprovementActivation("candidate/1", { actorId: "operator-1" });
    const [path, init] = apiMocks.request.mock.calls.at(-1) ?? [];
    expect(path).toBe("/api/v1/improvement/candidates/candidate%2F1/activation-request");
    expect(init).toMatchObject({ method: "POST" });
    expect(JSON.parse((init as { body: string }).body)).toEqual({ actorId: "operator-1" });
    expect(outcome.pendingApproval).toMatchObject({
      kind: "improvement.lifecycle",
      operationKind: "activate",
      approvalId: PENDING_APPROVAL.approvalId,
    });
  });

  it("requests a pause approval with the requester and pins the pending envelope", async () => {
    apiMocks.request.mockResolvedValue({ pendingApproval: PENDING_APPROVAL });
    const outcome = await improvement.pauseImprovementActivation("activation/1", { actorId: "operator-1" });
    const [path, init] = apiMocks.request.mock.calls.at(-1) ?? [];
    expect(path).toBe("/api/v1/improvement/activations/activation%2F1/pause");
    expect(init).toMatchObject({ method: "POST" });
    expect(JSON.parse((init as { body: string }).body)).toEqual({ actorId: "operator-1" });
    expect(outcome.pendingApproval).toMatchObject({
      kind: "improvement.lifecycle",
      operationKind: "pause",
      requestSha256: PENDING_APPROVAL.requestSha256,
      expectedStateSha256: PENDING_APPROVAL.expectedStateSha256,
    });
  });

  it("requests a rollback approval and defaults to an empty body when no actor is given", async () => {
    apiMocks.request.mockResolvedValue({
      pendingApproval: { ...PENDING_APPROVAL, operationKind: "rollback" },
    });
    const outcome = await improvement.rollbackImprovementActivation("activation-1");
    const [path, init] = apiMocks.request.mock.calls.at(-1) ?? [];
    expect(path).toBe("/api/v1/improvement/activations/activation-1/rollback");
    expect(JSON.parse((init as { body: string }).body)).toEqual({});
    expect(outcome.pendingApproval).toMatchObject({ operationKind: "rollback" });
  });

  it("surfaces the honest no-op envelope when the activation already holds the requested state", async () => {
    apiMocks.request.mockResolvedValue({
      pendingApproval: null,
      noMutationRequired: true,
      activation: { activationId: "activation-1", status: "paused" },
    });
    const outcome = await improvement.pauseImprovementActivation("activation-1");
    expect(outcome.pendingApproval).toBeNull();
    if (outcome.pendingApproval === null) {
      expect(outcome.noMutationRequired).toBe(true);
      expect(outcome.activation).toMatchObject({ activationId: "activation-1", status: "paused" });
    }
  });
});
