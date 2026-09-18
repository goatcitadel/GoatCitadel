import { describe, expect, it, vi } from "vitest";
import { windowsRuntimeDispatchFixture } from "../../../remote-worker/src/worker-windows-runtime-dispatch-test-fixture.js";
import { RemoteWorkerNativeReviewOperator } from "./remote-worker-native-review-operator.js";
import { composeRemoteWorkerRouteDependencies } from "./remote-worker-route-composition.js";

function fixture() {
  let now = 1000;
  const request = windowsRuntimeDispatchFixture();
  const authority = { registryWorkspaceId: "registry", assignmentId: "assignment", assignmentGeneration: 1,
    leaseRevision: 1, leaseTokenSha256: "11".repeat(32), protectedAuthority: { credentialAuthority: {}, meshAdmission: {} } as never };
  const input = { registryWorkspaceId: authority.registryWorkspaceId, assignmentId: authority.assignmentId,
    assignmentGeneration: 1, launch: request.launch, inventoryLimits: request.inventoryLimits };
  const result = { approval: { approvalId: "approval", status: "pending", expiresAt: "2099-01-01T00:00:00.000Z", private: "secret" },
    candidate: { candidateExpectation: { requestSha256: "22".repeat(32) }, private: "secret" } };
  const requestReview = vi.fn(async (_input: unknown) => result as never);
  const installationReview = vi.fn(async (_input: unknown) => ({ approval: result.approval,
    candidate: { requestSha256: "33".repeat(32) } }) as never);
  const installationRetention = vi.fn(async (_input: unknown) => ({ decision: "review_retained", approvalId: "approval",
    requestSha256: "33".repeat(32), request: { private: "secret" } }) as never);
  const owner = new RemoteWorkerNativeReviewOperator({ requestReview }, () => now,
    { requestReview: installationReview, retainApprovedReview: installationRetention });
  const stop = new AbortController();
  return { authority, input, result, requestReview, installationReview, installationRetention, owner, stop, advance: (value: number) => { now += value; } };
}

describe("operator native review bridge", () => {
  const runtimeBundle = { schemaVersion: "goatcitadel.worker-runtime-bundle.v1", files: [
    { relativePath: "node.exe", bytes: 10, sha256: "55".repeat(32) },
    { relativePath: "worker-host-receipt.json", bytes: 20, sha256: "66".repeat(32) },
  ] };
  it("prepares installation review with protected contact and projects only review metadata", async () => {
    const f = fixture(); f.owner.observe(f.authority);
    const input = { ...f.input, packageSha256: "44".repeat(32), runtimeBundle, leaseTokenSha256: "forged" };
    const result = await f.owner.requestInstallationReview(input, f.stop.signal);
    expect(f.installationReview).toHaveBeenCalledWith({ ...f.authority, packageSha256: input.packageSha256, runtimeBundle, signal: f.stop.signal });
    expect(result).toEqual({ approvalId: "approval", status: "pending", expiresAt: f.result.approval.expiresAt, requestSha256: "33".repeat(32) });
    expect(f.installationRetention).not.toHaveBeenCalled(); expect(f.requestReview).not.toHaveBeenCalled();
  });
  it("retains an exact approved installation review without accepting caller request bytes", async () => {
    const f = fixture(); f.owner.observe(f.authority);
    const result = await f.owner.retainInstallationReview({ ...f.input, approvalId: "approval", request: "forged" } as typeof f.input & { approvalId: string }, f.stop.signal);
    expect(f.installationRetention).toHaveBeenCalledWith({ ...f.authority, approvalId: "approval", signal: f.stop.signal });
    expect(result).toEqual({ decision: "review_retained", approvalId: "approval", requestSha256: "33".repeat(32) });
    expect(f.installationReview).not.toHaveBeenCalled();
  });
  it.each(["missing", "expired", "generation", "cancel"])("refuses both installation entries with %s contact", async mode => {
    const f = fixture(); if (mode !== "missing") f.owner.observe(f.authority);
    if (mode === "expired") f.advance(30001);
    if (mode === "generation") f.input.assignmentGeneration = 2;
    if (mode === "cancel") f.stop.abort();
    await expect(f.owner.requestInstallationReview({ ...f.input, packageSha256: "44".repeat(32), runtimeBundle }, f.stop.signal)).rejects.toThrow();
    await expect(f.owner.retainInstallationReview({ ...f.input, approvalId: "approval" }, f.stop.signal)).rejects.toThrow();
    expect(f.installationReview).not.toHaveBeenCalled(); expect(f.installationRetention).not.toHaveBeenCalled();
  });
  it("does not retry a denied or uncertain installation retention", async () => {
    const f = fixture(); f.owner.observe(f.authority);
    f.installationRetention.mockRejectedValueOnce(new Error("review revoked"));
    await expect(f.owner.retainInstallationReview({ ...f.input, approvalId: "approval" }, f.stop.signal)).rejects.toThrow("review revoked");
    expect(f.installationRetention).toHaveBeenCalledOnce();
  });
  it("connects both installation entries through lazy production route composition", async () => {
    const f = fixture(); f.owner.observe(f.authority);
    const createOwners = vi.fn(() => ({ operatorNativeRuntime: f.owner }));
    const deps = composeRemoteWorkerRouteDependencies({ storage: {}, createRemoteWorkerExecutionOwners: createOwners } as never);
    expect(createOwners).not.toHaveBeenCalled();
    await deps.nativeRuntime!.requestInstallationReview!({ ...f.input, packageSha256: "44".repeat(32), runtimeBundle }, f.stop.signal);
    await deps.nativeRuntime!.retainInstallationReview!({ ...f.input, approvalId: "approval" }, f.stop.signal);
    expect(createOwners).toHaveBeenCalledTimes(2);
    expect(f.installationReview).toHaveBeenCalledOnce(); expect(f.installationRetention).toHaveBeenCalledOnce();
  });
  it("uses observed protected authority and exposes only canonical review metadata", async () => {
    const f = fixture(); f.owner.observe(f.authority);
    f.authority.leaseTokenSha256 = "33".repeat(32);
    const result = await f.owner.requestReview({ ...f.input, leaseTokenSha256: "44".repeat(32) } as typeof f.input, f.stop.signal);
    expect(f.requestReview).toHaveBeenCalledOnce();
    expect(f.requestReview).toHaveBeenCalledWith(expect.objectContaining({ ...f.input, leaseTokenSha256: "11".repeat(32), signal: f.stop.signal }));
    expect(result).toEqual({ approvalId: "approval", status: "pending", expiresAt: f.result.approval.expiresAt, requestSha256: "22".repeat(32) });
    expect(Object.isFrozen(result)).toBe(true);
  });
  it.each(["missing", "workspace", "assignment", "generation", "expired", "clock-regression", "cancel"])("refuses %s contact before preparation", async mode => {
    const f = fixture(); if (mode !== "missing") f.owner.observe(f.authority);
    if (mode === "workspace") f.input.registryWorkspaceId = "foreign";
    if (mode === "assignment") f.input.assignmentId = "foreign";
    if (mode === "generation") f.input.assignmentGeneration = 2;
    if (mode === "expired") f.advance(30001);
    if (mode === "clock-regression") f.advance(-1);
    if (mode === "cancel") f.stop.abort();
    await expect(f.owner.requestReview(f.input, f.stop.signal)).rejects.toThrow();
    expect(f.requestReview).not.toHaveBeenCalled();
  });
  it("does not let an older lease refresh current contact", async () => {
    const f = fixture(); f.owner.observe({ ...f.authority, leaseRevision: 2 });
    f.advance(29999); f.owner.observe(f.authority);
    await f.owner.requestReview(f.input, f.stop.signal);
    expect(f.requestReview).toHaveBeenCalledWith(expect.objectContaining({ leaseRevision: 2 }));
    f.advance(2); await expect(f.owner.requestReview(f.input, f.stop.signal)).rejects.toThrow();
    expect(f.requestReview).toHaveBeenCalledOnce();
  });
  it("evicts the oldest contact at its bounded capacity", async () => {
    const f = fixture(); f.owner.observe(f.authority);
    for (let index = 0; index < 32; index++) f.owner.observe({ ...f.authority, assignmentId: `other-${index}` });
    await expect(f.owner.requestReview(f.input, f.stop.signal)).rejects.toThrow();
    await f.owner.requestReview({ ...f.input, assignmentId: "other-31" }, f.stop.signal);
    expect(f.requestReview).toHaveBeenCalledOnce();
  });
  it("does not hide a committed review when contact expires during creation", async () => {
    const f = fixture(); f.owner.observe(f.authority);
    f.requestReview.mockImplementationOnce(async () => { f.advance(30001); return f.result as never; });
    expect((await f.owner.requestReview(f.input, f.stop.signal)).approvalId).toBe("approval");
    expect(f.requestReview).toHaveBeenCalledOnce();
  });
  it("propagates policy or uncertain creation failure without retry", async () => {
    const f = fixture(); f.owner.observe(f.authority);
    f.requestReview.mockRejectedValueOnce(new Error("review denied"));
    await expect(f.owner.requestReview(f.input, f.stop.signal)).rejects.toThrow("review denied");
    expect(f.requestReview).toHaveBeenCalledOnce();
  });
});
