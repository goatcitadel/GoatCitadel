import { createHash } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import {
  RemoteWorkerVerificationService,
  type RemoteWorkerTrustedVerifierPort,
} from "./remote-worker-verification-service.js";

const D = (value: string): string => createHash("sha256").update(value).digest("hex");

function fakeRepository() {
  const advance = vi.fn(async (input: { nextState: string; evidence: { summary: string } }) => ({
    verificationId: "verification-1",
    // Only a passed Gateway attempt satisfies the gate.
    gateState: input.nextState === "passed" ? "satisfied" : "pending",
  }));
  return {
    recordWorkerClaim: vi.fn(async (input: unknown) => ({ verificationId: "worker-claim-1", input })),
    openGatewayVerification: vi.fn(async () => ({ verificationId: "verification-1" })),
    advanceGatewayVerification: advance,
  };
}

function fakeStore() {
  return { readBlob: vi.fn(async () => new TextEncoder().encode("immutable-bytes")) };
}

const baseInput = {
  registryWorkspaceId: "default",
  assignmentId: "assignment-1",
  assignmentGeneration: 1,
  executionWorkspaceId: "default",
  attemptIndex: 1,
  verifierProfileSha256: D("profile"),
  manifestSha256: D("manifest"),
  blobs: [D("blob")],
  wallDeadlineAt: "2099-01-01T00:00:00.000Z",
  idempotencyKey: "attempt-1",
  signal: new AbortController().signal,
};

describe("HX-506 verification service", () => {
  it("records a worker claim as evidence only, never a gate-satisfying attempt", async () => {
    const repository = fakeRepository();
    const service = new RemoteWorkerVerificationService({
      repository: repository as never,
      store: fakeStore() as never,
      verifier: { verify: vi.fn() },
    });
    await service.recordWorkerClaim({
      registryWorkspaceId: "default",
      assignmentId: "assignment-1",
      assignmentGeneration: 1,
      attemptIndex: 1,
      summary: "worker trusted",
      manifestSha256: D("manifest"),
      idempotencyKey: "claim-1",
    });
    expect(repository.recordWorkerClaim).toHaveBeenCalledOnce();
    expect(repository.advanceGatewayVerification).not.toHaveBeenCalled();
  });

  it("redacts worker and verifier summaries before durable evidence", async () => {
    const repository = fakeRepository();
    const service = new RemoteWorkerVerificationService({
      repository: repository as never,
      store: fakeStore() as never,
      verifier: {
        verify: vi.fn(async () => ({
          outcome: "failed",
          summary: "Authorization: Bearer secret-token-value",
          capturedOutputBytes: 1,
        })),
      },
    });
    await service.recordWorkerClaim({
      registryWorkspaceId: "default",
      assignmentId: "assignment-1",
      assignmentGeneration: 1,
      attemptIndex: 1,
      summary: "token=ghp_aaaaaaaaaaaaaaaaaaaaaaaa",
      manifestSha256: D("manifest"),
      idempotencyKey: "claim-secret",
    });
    await service.runGatewayVerification(baseInput);

    const workerEvidence = (repository.recordWorkerClaim.mock.calls[0]?.[0] as { evidence: { summary: string } })
      .evidence;
    const terminalEvidence = repository.advanceGatewayVerification.mock.calls.at(-1)?.[0].evidence;
    expect(workerEvidence.summary).not.toContain("ghp_");
    expect(terminalEvidence?.summary).not.toContain("secret-token-value");
    expect(JSON.stringify({ workerEvidence, terminalEvidence })).toContain("[REDACTED]");
  });

  it("rehashes immutable CAS bytes and satisfies the gate only on a passed Gateway attempt", async () => {
    const repository = fakeRepository();
    const store = fakeStore();
    const verifier: RemoteWorkerTrustedVerifierPort = {
      verify: vi.fn(async () => ({ outcome: "passed", summary: "ok", capturedOutputBytes: 42 })),
    };
    const service = new RemoteWorkerVerificationService({
      repository: repository as never,
      store: store as never,
      verifier,
    });
    const result = await service.runGatewayVerification(baseInput);
    expect(result.attemptState).toBe("passed");
    expect(result.gateState).toBe("satisfied");
    // Bytes are rehashed before and after execution (>= 2 reads for one blob).
    expect(store.readBlob.mock.calls.length).toBeGreaterThanOrEqual(2);
  });

  it("marks a crashed running verifier indeterminate and never satisfies the gate", async () => {
    const repository = fakeRepository();
    const verifier: RemoteWorkerTrustedVerifierPort = {
      verify: vi.fn(async () => {
        throw new Error("verifier timed out with ghp_bbbbbbbbbbbbbbbbbbbbbbbb");
      }),
    };
    const service = new RemoteWorkerVerificationService({
      repository: repository as never,
      store: fakeStore() as never,
      verifier,
    });
    const result = await service.runGatewayVerification(baseInput);
    expect(result.attemptState).toBe("indeterminate");
    expect(result.gateState).toBe("pending");
    const terminalEvidence = repository.advanceGatewayVerification.mock.calls.at(-1)?.[0].evidence;
    expect(terminalEvidence?.summary).toBe("verifier_indeterminate");
  });

  it("rejects accessor or oversized verifier envelopes without reading secret-bearing fields", async () => {
    const repository = fakeRepository();
    const summaryGetter = vi.fn(() => "ghp_cccccccccccccccccccccccc");
    const malicious = Object.defineProperties(
      {},
      {
        outcome: { value: "passed", enumerable: true },
        summary: { get: summaryGetter, enumerable: true },
        capturedOutputBytes: { value: 1, enumerable: true },
      },
    );
    const service = new RemoteWorkerVerificationService({
      repository: repository as never,
      store: fakeStore() as never,
      verifier: { verify: vi.fn(async () => malicious as never) },
    });

    const result = await service.runGatewayVerification(baseInput);
    expect(result.attemptState).toBe("indeterminate");
    expect(summaryGetter).not.toHaveBeenCalled();
    const terminalEvidence = repository.advanceGatewayVerification.mock.calls.at(-1)?.[0].evidence;
    expect(terminalEvidence?.summary).toBe("verifier_indeterminate");
  });

  it("fails closed when the immutable CAS bytes cannot be rehashed", async () => {
    const repository = fakeRepository();
    const store = {
      readBlob: vi.fn(async () => {
        throw new Error("tampered");
      }),
    };
    const service = new RemoteWorkerVerificationService({
      repository: repository as never,
      store: store as never,
      verifier: { verify: vi.fn() },
    });
    await expect(service.runGatewayVerification(baseInput)).rejects.toThrow();
    expect(repository.openGatewayVerification).not.toHaveBeenCalled();
  });
});
