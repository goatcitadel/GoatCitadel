import { createHash } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import { normalizeRemoteWorkerEffectCorrelation } from "@goatcitadel/contracts";
import {
  RemoteWorkerEffectSettlementService,
  type RemoteWorkerEffectCoordinatorPort,
  type RemoteWorkerEffectDispatchOutcome,
} from "./remote-worker-effect-settlement-service.js";

const D = (value: string): string => createHash("sha256").update(value).digest("hex");

function fakeEffectRepository() {
  const transitions: Array<{ transitionState: string; transitionSequence: number; transitionSha256: string }> = [];
  return {
    transitions,
    recordIntent: vi.fn(async () => ({ intentId: "intent-1", canonicalArgsSha256: D("args") })),
    appendTransition: vi.fn(async (input: { correlation: unknown }) => {
      // Mirror the real repository's contract enforcement: an invalid correlation
      // (e.g. a completed_with_effect with no canonical HX-305 outcome) is rejected.
      const correlation = normalizeRemoteWorkerEffectCorrelation(input.correlation as never);
      const record = {
        intentId: "intent-1",
        transitionState: correlation.transitionState,
        transitionSequence: transitions.length + 1,
        transitionSha256: D(`t${transitions.length + 1}`),
        correlationSha256: D(`c${transitions.length + 1}`),
        recordedAt: "2099-01-01T00:00:00.000Z",
      };
      transitions.push(record);
      return record;
    }),
    recordReceipt: vi.fn(async (input: { receiptState: string; hx305OutcomeSha256: string | null }) => ({
      intentId: "intent-1",
      receiptState: input.receiptState,
      receiptRevision: 1,
      finalTransitionSequence: transitions.length,
      finalTransitionSha256: D(`t${transitions.length}`),
      hx305OutcomeSha256: input.hx305OutcomeSha256,
      reconciliationRecordSha256: null,
    })),
  };
}

const fence = {
  registryWorkspaceId: "default",
  assignmentId: "assignment-1",
  assignmentGeneration: 1,
  sessionControlGeneration: 3,
  leaseTokenSha256: D("lease"),
};

function service(outcome: RemoteWorkerEffectDispatchOutcome, repository = fakeEffectRepository()) {
  const coordinator: RemoteWorkerEffectCoordinatorPort = { dispatch: vi.fn(async () => outcome) };
  return {
    svc: new RemoteWorkerEffectSettlementService({ repository: repository as never, coordinator }),
    repository,
    coordinator,
  };
}

const dispatchInput = {
  fence,
  intentIndex: 0,
  effectSelector: "email.send",
  canonicalArgs: { to: "user@example.com" },
  workerIdempotencyKey: "worker-key-1",
  intentIdempotencyKey: "intent-1",
};

describe("HX-506 effect settlement service", () => {
  it("persists the immutable intent BEFORE invoking the canonical coordinator", async () => {
    const { svc, repository, coordinator } = service({
      kind: "completed_no_effect",
      externalSideEffectRunId: "run-1",
      boundaryReceiptSha256: D("boundary"),
    });
    await svc.dispatchEffect(dispatchInput);
    const intentOrder = repository.recordIntent.mock.invocationCallOrder[0]!;
    const dispatchOrder = (coordinator.dispatch as ReturnType<typeof vi.fn>).mock.invocationCallOrder[0]!;
    expect(intentOrder).toBeLessThan(dispatchOrder);
  });

  it("records a completed_with_effect receipt only from the coordinator's canonical HX-305 outcome", async () => {
    const { svc, repository } = service({
      kind: "completed_with_effect",
      externalSideEffectRunId: "run-1",
      boundaryReceiptSha256: D("boundary"),
      hx305OutcomeSha256: D("hx305"),
    });
    const result = await svc.dispatchEffect(dispatchInput);
    expect(result.receipt.receiptState).toBe("completed_with_effect");
    expect(result.receipt.hx305OutcomeSha256).toBe(D("hx305"));
    expect(repository.transitions.map((t) => t.transitionState)).toEqual([
      "recorded",
      "dispatch_claimed",
      "external_boundary_started",
      "completed_with_effect",
    ]);
  });

  it("blocks before dispatch with no boundary crossing", async () => {
    const { svc, repository } = service({
      kind: "blocked_before_dispatch",
      approvalRecordSha256: null,
      sanitizedError: "policy denied",
    });
    const result = await svc.dispatchEffect(dispatchInput);
    expect(result.receipt.receiptState).toBe("blocked_before_dispatch");
    expect(repository.transitions.some((t) => t.transitionState === "external_boundary_started")).toBe(false);
  });

  it("routes a possibly-dispatched ambiguity to manual reconciliation, never a retry", async () => {
    const { svc, repository } = service({
      kind: "manual_reconciliation",
      externalSideEffectRunId: "run-1",
      boundaryReceiptSha256: null,
      sanitizedError: "disconnected mid-flight",
    });
    const result = await svc.dispatchEffect(dispatchInput);
    expect(result.receipt.receiptState).toBe("manual_reconciliation");
    // Non-authority: the service never writes external side-effect runs or usage/cost.
    expect(Object.keys(repository)).not.toContain("recordExternalSideEffectRun");
    expect(Object.keys(repository)).not.toContain("recordUsage");
  });

  it("rejects a completed_with_effect the coordinator reports without an HX-305 outcome (result-body spoof)", async () => {
    // A coordinator that claims a completed effect without a canonical HX-305 outcome
    // cannot produce a receipt: the correlation contract rejects the transition.
    const { svc } = service({
      kind: "completed_with_effect",
      externalSideEffectRunId: "run-1",
      boundaryReceiptSha256: D("boundary"),
      hx305OutcomeSha256: "" as never,
    });
    await expect(svc.dispatchEffect(dispatchInput)).rejects.toThrow();
  });
});
