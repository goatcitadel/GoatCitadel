import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { createRemoteWorkerExecutionOwners, type RemoteWorkerExecutionOwnersDependencies } from "./remote-worker-execution-owners.js";
import { REMOTE_WORKER_NATIVE_CELL_POLICY } from "./remote-worker-native-cell-policy.js";

describe("native cell owner production composition", () => {
  it.each((["cell.native_pool.page", "cell.native_pool.cleanup.page"] as const).flatMap(kind =>
    ["current", "before", "after"].map(stage => [kind, stage] as const)))("reads %s with %s cancellation", async (kind, stage) => {
    const stop = new AbortController(), page = { snapshotSha256: "a".repeat(64), offset: 0, byteLength: 1, bytesHex: "7b" };
    const read = async (input: { submission: unknown; protectedAuthority: { credentialAuthority: unknown } }) => {
      expect(Object.isFrozen(input.submission)).toBe(true);
      expect(Object.isFrozen(input.protectedAuthority.credentialAuthority)).toBe(true);
      if (stage === "after") stop.abort();
      return page;
    };
    const readPageForAssignment = vi.fn(read), readCleanupPageForAssignment = vi.fn(read);
    const llm = {}, deps = { storage: { remoteWorkerNativePools: { readPageForAssignment, readCleanupPageForAssignment } }, llm,
      completionHost: { llmService: llm }, artifactRoot: path.join(process.cwd(), "unused-pool-read") } as unknown as RemoteWorkerExecutionOwnersDependencies;
    const owner = createRemoteWorkerExecutionOwners(deps).settlement.nativePool!;
    const input = { registryWorkspaceId: "default", assignmentId: "assignment", assignmentGeneration: 1, leaseRevision: 1,
      leaseTokenSha256: "1".repeat(64), protectedAuthority: { credentialAuthority: {}, meshAdmission: {} }, signal: stop.signal,
      submission: { kind, snapshotSha256: null, offset: 0 } };
    if (stage === "before") stop.abort();
    const pending = owner.read(input as Parameters<typeof owner.read>[0]);
    if (stage === "current") await expect(pending).resolves.toBe(page); else await expect(pending).rejects.toThrow();
    const cleanup = kind === "cell.native_pool.cleanup.page";
    expect(cleanup ? readCleanupPageForAssignment : readPageForAssignment).toHaveBeenCalledTimes(stage === "before" ? 0 : 1);
    expect(cleanup ? readPageForAssignment : readCleanupPageForAssignment).not.toHaveBeenCalled();
  });
  it.each(["current", "before", "after"])("uses durable native capacity staging with %s cancellation", async stage => {
    const stop = new AbortController(), recorded = { capture: "retained" };
    const exchangeWithAssignment = vi.fn(async (input: { submission: unknown; protectedAuthority: { credentialAuthority: unknown } }) => {
      await Promise.resolve();
      expect(Object.isFrozen(input.submission)).toBe(true);
      expect(Object.isFrozen(input.protectedAuthority.credentialAuthority)).toBe(true);
      if (stage === "after") stop.abort();
      return recorded;
    });
    const llm = {}, dependencies = { storage: { remoteWorkerNativeCapacityPages: { exchangeWithAssignment } }, llm,
      completionHost: { llmService: llm }, artifactRoot: path.join(process.cwd(), "unused-native-capacity-staging") } as unknown as RemoteWorkerExecutionOwnersDependencies;
    const owner = createRemoteWorkerExecutionOwners(dependencies).settlement.nativeCapacityPages!;
    const input = { registryWorkspaceId: "default", assignmentId: "assignment", assignmentGeneration: 1, leaseRevision: 1,
      leaseTokenSha256: "1".repeat(64), protectedAuthority: { credentialAuthority: {}, meshAdmission: {} }, signal: stop.signal,
      submission: { kind: "cell.native_capacity.lookup", nonce: "2".repeat(64), bundleSha256: "3".repeat(64) } };
    if (stage === "before") stop.abort();
    const pending = owner.exchange(input as Parameters<typeof owner.exchange>[0]);
    if (stage === "current") await expect(pending).resolves.toBe(recorded); else await expect(pending).rejects.toThrow();
    expect(exchangeWithAssignment).toHaveBeenCalledTimes(stage === "before" ? 0 : 1);
  });
  it("uses the same private request producer for review and worker selection", () => {
    const llm = {}, dependencies = { storage: {}, llm, completionHost: { llmService: llm }, artifactRoot: path.join(process.cwd(), "unused-selection") } as unknown as RemoteWorkerExecutionOwnersDependencies;
    const owners = createRemoteWorkerExecutionOwners(dependencies);
    expect(owners.settlement.runtimeRequests).toBe(owners.nativeRuntimeRequests);
  });
  it.each(["current", "before", "after"])("checks native authorization storage with %s cancellation", async stage => {
    const stop = new AbortController(), result = { nonce: "retained" };
    const authorizeForAssignment = vi.fn(async () => { if (stage === "after") stop.abort(); return result; });
    const llm = {}, deps = { storage: { remoteWorkerRuntimeResults: { authorizeForAssignment } }, llm,
      completionHost: { llmService: llm }, artifactRoot: path.join(process.cwd(), "unused-native-auth") } as unknown as RemoteWorkerExecutionOwnersDependencies;
    const owners = createRemoteWorkerExecutionOwners(deps), owner = owners.settlement.runtimeAuthorization!;
    const authorizePolicy = vi.spyOn(owners.nativeRuntimeRequests, "authorizePolicyForRequest").mockResolvedValue(undefined);
    const input = { registryWorkspaceId: "default", assignmentId: "assignment", assignmentGeneration: 1,
      leaseRevision: 1, leaseTokenSha256: "1".repeat(64), protectedAuthority: { credentialAuthority: {}, meshAdmission: {} },
      nonce: "2".repeat(64), requestSha256: "3".repeat(64), phase: "execution", signal: stop.signal };
    if (stage === "before") stop.abort();
    const pending = owner.authorize(input as Parameters<typeof owner.authorize>[0]);
    if (stage === "current") await expect(pending).resolves.toBe(result); else await expect(pending).rejects.toThrow();
    expect(authorizeForAssignment).toHaveBeenCalledTimes(stage === "before" ? 0 : stage === "current" ? 2 : 1);
    expect(authorizePolicy).toHaveBeenCalledTimes(stage === "current" ? 1 : 0);
    if (stage !== "before") { const { signal: _signal, ...binding } = input; expect(authorizeForAssignment).toHaveBeenCalledWith(binding); }
  });
  it.each(["mounted", "backing", "inventory", "pages", "runtime", "install", "install-select"].flatMap((kind) => ["current", "before", "after"].map((stage) => ({ kind, stage }))))(
    "awaits the $kind observation repository and respects $stage cancellation", async ({ kind, stage }) => {
      const controller = new AbortController(), recorded = { observation: kind };
      const exchangeWithAssignment = vi.fn(async () => {
        await Promise.resolve();
        if (stage === "after") controller.abort();
        return recorded;
      });
      const llm = {}, ownerKey = kind.startsWith("install") ? "remoteWorkerRuntimeInstalls" : kind === "runtime" ? "remoteWorkerRuntimeResults" : kind === "backing" ? "remoteWorkerCellBackingCapacity" : "remoteWorkerCellCapacity";
      const dependencies = { storage: { [ownerKey]: { exchangeWithAssignment, exchangeInventoryWithAssignment: exchangeWithAssignment,
        exchangeInventoryPageWithAssignment: exchangeWithAssignment, exchangePageForAssignment: exchangeWithAssignment, exchangeForAssignment: exchangeWithAssignment, selectForAssignment: exchangeWithAssignment } }, llm,
        completionHost: { llmService: llm }, artifactRoot: path.join(process.cwd(), "unused-capacity-fixture")
      } as unknown as RemoteWorkerExecutionOwnersDependencies;
      const settlement = createRemoteWorkerExecutionOwners(dependencies).settlement;
      const input = { registryWorkspaceId: "default", assignmentId: "assignment", assignmentGeneration: 1,
        leaseRevision: 1, leaseTokenSha256: "1".repeat(64), protectedAuthority: { credentialAuthority: {}, meshAdmission: {} },
        submission: { kind: kind === "pages" ? "cell.object_inventory.page_snapshot" : kind === "inventory" ? "cell.object_inventory.snapshot" : kind === "backing" ? "cell.backing_capacity.snapshot" : "cell.capacity.snapshot" }, signal: controller.signal };
      if (stage === "before") controller.abort();
      const pending = kind === "install-select"
        ? settlement.runtimeInstalls!.select!(input as unknown as Parameters<NonNullable<NonNullable<typeof settlement.runtimeInstalls>["select"]>>[0])
        : kind === "install"
        ? settlement.runtimeInstalls!.exchange(input as unknown as Parameters<NonNullable<typeof settlement.runtimeInstalls>["exchange"]>[0])
        : kind === "runtime"
        ? settlement.runtimeResults!.exchange(input as unknown as Parameters<NonNullable<typeof settlement.runtimeResults>["exchange"]>[0])
        : kind === "pages"
        ? settlement.cellObjectInventoryPages!.exchange(input as unknown as Parameters<NonNullable<typeof settlement.cellObjectInventoryPages>["exchange"]>[0])
        : kind === "inventory"
        ? settlement.cellObjectInventory!.exchange(input as unknown as Parameters<NonNullable<typeof settlement.cellObjectInventory>["exchange"]>[0])
        : kind === "backing"
        ? settlement.cellBackingCapacity!.exchange(input as unknown as Parameters<NonNullable<typeof settlement.cellBackingCapacity>["exchange"]>[0])
        : settlement.cellCapacity!.exchange(input as unknown as Parameters<NonNullable<typeof settlement.cellCapacity>["exchange"]>[0]);
      if (stage === "current") await expect(pending).resolves.toBe(recorded);
      else await expect(pending).rejects.toThrow();
      expect(exchangeWithAssignment).toHaveBeenCalledTimes(stage === "before" ? 0 : 1);
      if (stage !== "before") {
        const { signal: _signal, ...expected } = input;
        expect(exchangeWithAssignment).toHaveBeenCalledWith(expected);
      }
    });
  it.each(["current", "before", "after"])("uses only Gateway limits and respects %s cancellation", async (stage) => {
    const controller = new AbortController();
    const recorded = { decision: "create_once" };
    const prepareForAssignment = vi.fn(async () => { if (stage === "after") controller.abort(); return recorded; });
    const llm = {};
    // Other execution owners are constructed but never invoked in this check.
    const dependencies = { storage: { remoteWorkerCellProvisioning: { prepareForAssignment } }, llm,
      completionHost: { llmService: llm }, artifactRoot: path.join(process.cwd(), "unused-native-preparation-fixture")
    } as unknown as RemoteWorkerExecutionOwnersDependencies;
    const owner = createRemoteWorkerExecutionOwners(dependencies).settlement.cellProvisioning!;
    const input = { registryWorkspaceId: "default", assignmentId: "assignment", assignmentGeneration: 1,
      leaseRevision: 1, leaseTokenSha256: "1".repeat(64), protectedAuthority: { credentialAuthority: {}, meshAdmission: {} },
      submission: { kind: "cell.provisioning.prepare", parentIdentityHex: "0100000000000000" + "1".repeat(32) },
      policy: { capacity: "caller must not choose this" }, signal: controller.signal };
    if (stage === "before") controller.abort();
    const pending = owner.prepare!(input as unknown as Parameters<NonNullable<typeof owner.prepare>>[0]);
    if (stage === "current") await expect(pending).resolves.toBe(recorded);
    else await expect(pending).rejects.toThrow();
    expect(prepareForAssignment).toHaveBeenCalledTimes(stage === "before" ? 0 : 1);
    if (stage !== "before") expect(prepareForAssignment).toHaveBeenCalledWith({
      registryWorkspaceId: input.registryWorkspaceId, assignmentId: input.assignmentId,
      assignmentGeneration: 1, leaseRevision: 1, leaseTokenSha256: input.leaseTokenSha256,
      protectedAuthority: input.protectedAuthority, submission: input.submission, policy: REMOTE_WORKER_NATIVE_CELL_POLICY });
    expect(Object.isFrozen(REMOTE_WORKER_NATIVE_CELL_POLICY.capacity)).toBe(true);
  });
});
