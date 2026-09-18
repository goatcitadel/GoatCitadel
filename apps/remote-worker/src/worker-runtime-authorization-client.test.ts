import { beforeEach, describe, expect, it, vi } from "vitest";
import { runtimeResultPagesFixture } from "../../../packages/contracts/src/remote-worker-runtime-result-pages-test-fixture.js";
import { REMOTE_WORKER_RUNTIME_AUTHORIZATION_SCHEMA_VERSION } from "@goatcitadel/contracts";
import { authorizeWorkerRuntime } from "./worker-runtime-authorization-client.js";
import { callProtectedRoute } from "./worker-protected-route-client.js";
import type { RouteContext } from "./connected-worker-routes.js";
vi.mock("./worker-protected-route-client.js", () => ({ callProtectedRoute: vi.fn() }));
function fixture() {
  const f = runtimeResultPagesFixture(), lease = { registryWorkspaceId: f.history.registryWorkspaceId, assignmentId: f.history.assignmentId,
    assignmentGeneration: f.history.assignmentGeneration, leaseRevision: f.history.leaseRevision, leaseToken: "private-lease-token" };
  const context = { credential: {} } as RouteContext;
  const reply = (submission: unknown) => ({ status: 200, body: {
    schemaVersion: "goatcitadel.remote-worker-assignment-execution-response.v1", operation: "assignment.settlement.submit",
    disposition: "runtime_authorization", registryWorkspaceId: lease.registryWorkspaceId, runtimeAuthorization: {
      schemaVersion: REMOTE_WORKER_RUNTIME_AUTHORIZATION_SCHEMA_VERSION, registryWorkspaceId: lease.registryWorkspaceId,
      assignmentId: lease.assignmentId, assignmentGeneration: lease.assignmentGeneration, leaseRevision: lease.leaseRevision,
      submission, expectation: { ...f.expectation } } } });
  return { ...f, lease, context, reply };
}
describe("protected native runtime authorization client", () => {
  beforeEach(() => vi.clearAllMocks());
  it("checks a fresh challenge every time without publishing private lease material", async () => {
    const f = fixture();
    vi.mocked(callProtectedRoute).mockImplementation(async input => f.reply(input.payload.submission));
    await authorizeWorkerRuntime(f.context, f.lease, f.expectation, "execution");
    await authorizeWorkerRuntime(f.context, f.lease, f.expectation, "delivery");
    const calls = vi.mocked(callProtectedRoute).mock.calls.map(([input]) => input);
    expect(calls).toHaveLength(2);
    expect(calls[0]!.idempotencyKey).not.toBe(calls[1]!.idempotencyKey);
    expect(calls[0]!.idempotencyKey).not.toContain(f.lease.leaseToken);
    expect(calls[0]!.payload.submission).toMatchObject({ phase: "execution" });
    expect(calls[1]!.payload.submission).toMatchObject({ phase: "delivery" });
  });
  it.each(["challenge", "phase", "expectation", "scope", "generation", "lease", "operation", "extra", "cancel", "lost"])(
    "refuses %s without retry", async mode => {
      const f = fixture(), controller = new AbortController();
      vi.mocked(callProtectedRoute).mockImplementation(async input => {
        const response = f.reply(input.payload.submission), receipt = response.body.runtimeAuthorization;
        if (mode === "challenge") receipt.submission = { ...input.payload.submission as object, challenge: "ff".repeat(32) };
        if (mode === "phase") receipt.submission = { ...input.payload.submission as object, phase: "delivery" };
        if (mode === "expectation") receipt.expectation.maxInputBytes += 1;
        if (mode === "scope") receipt.assignmentId = "foreign";
        if (mode === "generation") receipt.assignmentGeneration += 1;
        if (mode === "lease") receipt.leaseRevision += 1;
        if (mode === "operation") response.body.operation = "assignment.inference";
        if (mode === "extra") Object.assign(receipt, { approved: true });
        if (mode === "cancel") controller.abort();
        if (mode === "lost") throw new Error("lost observation");
        return response;
      });
      await expect(authorizeWorkerRuntime(f.context, f.lease, f.expectation, "execution", controller.signal)).rejects.toThrow();
      expect(callProtectedRoute).toHaveBeenCalledTimes(1);
    });
  it("refuses pre-cancelled calls and invalid phases before transport", async () => {
    const f = fixture(), controller = new AbortController(); controller.abort();
    await expect(authorizeWorkerRuntime(f.context, f.lease, f.expectation, "execution", controller.signal)).rejects.toThrow();
    await expect(authorizeWorkerRuntime(f.context, f.lease, f.expectation, "approve" as "execution")).rejects.toThrow();
    expect(callProtectedRoute).not.toHaveBeenCalled();
  });
  it("rejects an earlier successful receipt for a new challenge in the same phase", async () => {
    const f = fixture(); let prior: ReturnType<typeof f.reply> | undefined;
    vi.mocked(callProtectedRoute).mockImplementation(async input => prior ??= f.reply(input.payload.submission));
    await authorizeWorkerRuntime(f.context, f.lease, f.expectation, "execution");
    await expect(authorizeWorkerRuntime(f.context, f.lease, f.expectation, "execution")).rejects.toThrow();
    expect(callProtectedRoute).toHaveBeenCalledTimes(2);
  });
  it("withholds an otherwise valid reply received after its deadline", async () => {
    const f = fixture();
    vi.mocked(callProtectedRoute).mockImplementation(async input => {
      await new Promise<void>(resolve => input.signal!.addEventListener("abort", () => resolve(), { once: true }));
      return f.reply(input.payload.submission);
    });
    await expect(authorizeWorkerRuntime(f.context, f.lease, f.expectation, "execution")).rejects.toThrow();
    expect(callProtectedRoute).toHaveBeenCalledTimes(1);
  }, 10000);
});
