import { beforeEach, describe, expect, it, vi } from "vitest";
import { readRemoteWorkerRuntimeResult, type RemoteWorkerRuntimeOutcomeSubmission } from "@goatcitadel/contracts";
import { runtimeResultPagesFixture } from "../../../../packages/contracts/src/remote-worker-runtime-result-pages-test-fixture.js";
import { createRemoteWorkerRuntimeOutcomeReader, readRemoteWorkerRuntimeOutcome } from "./remote-worker-runtime-outcome.js";
import { readWorkerRuntimeOutcome } from "../../../remote-worker/src/worker-runtime-outcome-client.js";
import { callProtectedRoute } from "../../../remote-worker/src/worker-protected-route-client.js";
import type { RouteContext } from "../../../remote-worker/src/connected-worker-routes.js";
vi.mock("../../../remote-worker/src/worker-protected-route-client.js", () => ({ callProtectedRoute: vi.fn() }));
function fixture() {
  const f = runtimeResultPagesFixture(2), result = readRemoteWorkerRuntimeResult(f.resultHex, f.expectation, f.history);
  const lookup = f.response(null, true), saved = { expectation: f.expectation, result, leaseRevision: lookup.record!.leaseRevision, recordedAt: lookup.record!.recordedAt };
  const exchangePageForAssignment = vi.fn(async () => lookup), findForAssignment = vi.fn(async () => saved);
  const owner = createRemoteWorkerRuntimeOutcomeReader({ remoteWorkerRuntimeResults: { exchangePageForAssignment, findForAssignment } } as never);
  const lease = { registryWorkspaceId: lookup.registryWorkspaceId, assignmentId: lookup.assignmentId,
    assignmentGeneration: lookup.assignmentGeneration, leaseRevision: lookup.leaseRevision, leaseToken: "private-token" };
  const context = { credential: {} } as RouteContext;
  const reply = async (submission: RemoteWorkerRuntimeOutcomeSubmission, signal?: AbortSignal) => ({ status: 200, body: {
    schemaVersion: "goatcitadel.remote-worker-assignment-execution-response.v1", operation: "assignment.settlement.submit",
    disposition: "runtime_outcome", registryWorkspaceId: lease.registryWorkspaceId,
    runtimeOutcome: await readRemoteWorkerRuntimeOutcome(owner, { registryWorkspaceId: lease.registryWorkspaceId, assignmentId: lease.assignmentId,
      assignmentGeneration: lease.assignmentGeneration, leaseRevision: lease.leaseRevision, leaseTokenSha256: "bb".repeat(32),
      protectedAuthority: { credentialAuthority: {}, meshAdmission: {} } as never, submission, signal }) } });
  return { ...f, lookup, saved, owner, exchangePageForAssignment, findForAssignment, lease, context, reply };
}
describe("canonical native outcome transport", () => {
  beforeEach(() => vi.clearAllMocks());
  it("preserves nonzero exit facts without disclosing inventory or claiming Chat success", async () => {
    const f = fixture(); vi.mocked(callProtectedRoute).mockImplementation(input => f.reply(input.payload.submission as RemoteWorkerRuntimeOutcomeSubmission));
    const response = await readWorkerRuntimeOutcome(f.context, f.lease, f.expectation);
    expect(response.outcome).toMatchObject({ end: "exited", exitCode: 23, inventoryEntries: 6 });
    expect(response.outcome).not.toHaveProperty("completed"); expect(response.outcome).not.toHaveProperty("inventory");
    expect(JSON.stringify(response).length).toBeLessThan(2048);
    expect(f.findForAssignment).toHaveBeenCalledTimes(1);
    await readWorkerRuntimeOutcome(f.context, f.lease, f.expectation);
    const calls = vi.mocked(callProtectedRoute).mock.calls;
    expect(calls[0]![0].idempotencyKey).not.toBe(calls[1]![0].idempotencyKey);
    expect(calls[0]![0].idempotencyKey).not.toContain(f.lease.leaseToken);
  });
  it("keeps an absent record absent without reading or recreating a result", async () => {
    const f = fixture(); f.exchangePageForAssignment.mockResolvedValue(f.response(null, false));
    vi.mocked(callProtectedRoute).mockImplementation(input => f.reply(input.payload.submission as RemoteWorkerRuntimeOutcomeSubmission));
    expect((await readWorkerRuntimeOutcome(f.context, f.lease, f.expectation)).outcome).toBeNull();
    expect(f.findForAssignment).not.toHaveBeenCalled();
  });
  it.each(["changed", "expectation", "revoked", "challenge", "scope", "lease", "generation", "bounds", "extra", "cancel", "lost"])("refuses %s without retry", async mode => {
    const f = fixture(), stop = new AbortController();
    if (mode === "changed") f.saved.recordedAt = "2026-09-14T00:01:00.000Z";
    if (mode === "expectation") f.saved.expectation = { ...f.expectation, requestSha256: "ff".repeat(32) };
    if (mode === "revoked") f.findForAssignment.mockRejectedValue(new Error("revoked"));
    vi.mocked(callProtectedRoute).mockImplementation(async input => {
      if (mode === "lost") throw new Error("lost");
      const response = await f.reply(input.payload.submission as RemoteWorkerRuntimeOutcomeSubmission), value = response.body.runtimeOutcome;
      if (mode === "challenge") response.body.runtimeOutcome = { ...value, challenge: "ff".repeat(32) };
      if (mode === "scope") response.body.runtimeOutcome = { ...value, lookup: { ...value.lookup, assignmentId: "foreign" } };
      if (mode === "lease") response.body.runtimeOutcome = { ...value, lookup: { ...value.lookup, leaseRevision: value.lookup.leaseRevision + 1 } };
      if (mode === "generation") response.body.runtimeOutcome = { ...value, lookup: { ...value.lookup, assignmentGeneration: 2 } };
      if (mode === "bounds") response.body.runtimeOutcome = { ...value, outcome: { ...value.outcome!, stdinBytes: f.expectation.maxInputBytes + 1 } };
      if (mode === "extra") response.body.runtimeOutcome = { ...value, outcome: { ...value.outcome!, completed: true } } as never;
      if (mode === "cancel") stop.abort();
      return response;
    });
    await expect(readWorkerRuntimeOutcome(f.context, f.lease, f.expectation, stop.signal)).rejects.toThrow();
    expect(callProtectedRoute).toHaveBeenCalledTimes(1);
  });
  it("refuses cancellation while reading retained storage", async () => {
    const f = fixture(), stop = new AbortController();
    f.findForAssignment.mockImplementation(async () => { stop.abort(); return f.saved; });
    await expect(f.reply({ kind: "runtime.outcome.read", nonce: f.expectation.nonce, requestSha256: f.expectation.requestSha256, challenge: "cc".repeat(32) }, stop.signal)).rejects.toThrow();
  });
});
