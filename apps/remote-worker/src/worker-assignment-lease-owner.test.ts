import { describe, expect, it, vi } from "vitest";
import { WorkerAssignmentLeaseOwner } from "./worker-assignment-lease-owner.js";
import { createInMemoryWorkerDurableState, type WorkerDurableStatePort } from "./worker-durable-state.js";
import { WorkerCredentialVault } from "./worker-credential-vault.js";
import type { LeaseBinding, RouteContext, pollOffers } from "./connected-worker-routes.js";

const context = {} as RouteContext;
const binding: LeaseBinding = {
  registryWorkspaceId: "registry",
  assignmentId: "assignment",
  assignmentGeneration: 1,
  leaseRevision: 1,
  leaseToken: "a".repeat(43),
};
const response = (disposition: string, lease = binding, workerSentThrough = 0) => ({
  status: 200,
  body: {
    disposition,
    generation: { assignmentGeneration: lease.assignmentGeneration },
    lease: {
      registryWorkspaceId: lease.registryWorkspaceId,
      assignmentId: lease.assignmentId,
      assignmentGeneration: lease.assignmentGeneration,
      leaseRevision: lease.leaseRevision,
      workerSentThrough,
      heartbeatAt: "2030-01-01T00:00:00.000Z",
      expiresAt: "2030-01-01T00:01:00.000Z",
    },
  },
});
const offers = () => ({ status: 200, body: { items: [{ assignment: { assignmentId: binding.assignmentId } }] } });
async function retain(state: WorkerDurableStatePort) {
  const vault = await WorkerCredentialVault.open(state);
  await vault.retainLease({
    assignmentId: binding.assignmentId,
    assignmentGeneration: 1,
    leaseRevision: 1,
    rawLeaseToken: binding.leaseToken,
  });
  await state.write("connected-run", JSON.stringify({ assignmentId: binding.assignmentId }));
  return vault;
}

describe("worker lease intent custody", () => {
  it("keeps an approval-waiting assignment and secret across restarts without granting execution", async () => {
    const state = createInMemoryWorkerDurableState();
    const vault = await retain(state);
    const waiting = { ...response("waiting_approval"), body: { ...response("waiting_approval").body,
      waiting: { approvalId: "approval-one", runtimeAuthoritySha256: "a".repeat(64) } } };
    const sync = vi.fn(async (_context: RouteContext, _lease: LeaseBinding, _key: string) => waiting);
    const poll = vi.fn();
    const renew = vi.fn();
    for (let restart = 0; restart < 2; restart++) {
      const observed = {};
      const owner = new WorkerAssignmentLeaseOwner(context, state, await WorkerCredentialVault.open(state),
        "registry", { sync, poll, renew });
      expect(await owner.resumeOrClaim(observed)).toBeUndefined();
      expect(observed).toMatchObject({ reconnectSync: "waiting_approval", awaiting: "approval_resolution" });
      expect(owner.remainingLeaseMs()).toBe(0);
      expect(await state.read("connected-run")).toBeDefined();
      expect(vault.getLease(binding.assignmentId).rawLeaseToken).toBe(binding.leaseToken);
    }
    expect(sync).toHaveBeenCalledTimes(2);
    expect(sync.mock.calls[0]![2]).not.toBe(sync.mock.calls[1]![2]);
    expect(poll).not.toHaveBeenCalled();
    expect(renew).not.toHaveBeenCalled();
  });

  it.each(["missing", "wrong-assignment", "invalid-proof"])("rejects %s approval wait evidence", async (failure) => {
    const state = createInMemoryWorkerDurableState();
    const vault = await retain(state);
    const receipt = response("waiting_approval", failure === "wrong-assignment" ?
      { ...binding, assignmentId: "another" } : binding);
    const owner = new WorkerAssignmentLeaseOwner(context, state, vault, "registry", {
      sync: async () => ({ ...receipt, body: { ...receipt.body,
        ...(failure === "missing" ? {} : { waiting: {
          approvalId: "approval-one", runtimeAuthoritySha256: failure === "invalid-proof" ? "bad" : "a".repeat(64),
        } }),
      } }),
    });
    await expect(owner.resumeOrClaim({})).rejects.toThrow();
    expect(await state.read("connected-run")).toBeDefined();
    expect(vault.getLease(binding.assignmentId).rawLeaseToken).toBe(binding.leaseToken);
  });

  it("waits across restart for the resumed Chat owner without polling or renewing the retained lease", async () => {
    const state = createInMemoryWorkerDurableState();
    await retain(state);
    const poll = vi.fn();
    const renew = vi.fn();
    const sync = vi.fn(async () => ({ ...response("approval_resume_pending"), body: {
      ...response("approval_resume_pending").body,
      resume: { approvalId: "approval-one", runtimeAuthoritySha256: "a".repeat(64), resumeSha256: "b".repeat(64) },
    } }));
    for (let restart = 0; restart < 2; restart++) {
      const owner = new WorkerAssignmentLeaseOwner(context, state, await WorkerCredentialVault.open(state),
        "registry", { sync, poll, renew });
      expect(await owner.resumeOrClaim({})).toBeUndefined();
      expect(owner.remainingLeaseMs()).toBe(0);
    }
    expect(poll).not.toHaveBeenCalled();
    expect(renew).not.toHaveBeenCalled();
    expect((await WorkerCredentialVault.open(state)).getLease(binding.assignmentId).rawLeaseToken).toBe(binding.leaseToken);
  });

  it.each(["approval", "parent"] as const)("rotates %s resumed authority and recovers a lost renewal response with the same secret", async (kind) => {
    const state = createInMemoryWorkerDurableState();
    const vault = await retain(state);
    const sync = vi.fn(async (_context, lease) => {
      const disposition = lease.leaseRevision === 1 ? (kind === "approval" ? "approval_resume_ready" : "parent_recovery_ready") : "synchronized";
      return { ...response(disposition, lease, 7), body: { ...response(disposition, lease, 7).body,
        resume: { approvalId: "approval-one", runtimeAuthoritySha256: "a".repeat(64), resumeSha256: "b".repeat(64) },
        recovery: { bindingSha256: "c".repeat(64) },
      } };
    });
    const renew = vi.fn(async (_context, lease, input) => {
      const intent = JSON.parse((await state.read("assignment-renewal-pending"))!);
      expect(intent.lease).toEqual(lease);
      expect(intent.nextLeaseToken).toBe(input.nextLeaseToken);
      if (renew.mock.calls.length === 1) throw new Error("resume renewal response lost");
      return response("replayed_without_lease_secret", { ...binding, leaseRevision: 2 }, 7);
    });
    const first = new WorkerAssignmentLeaseOwner(context, state, vault, "registry", { sync, renew });
    await expect(first.resumeOrClaim({})).rejects.toThrow("response lost");
    expect(first.remainingLeaseMs()).toBe(0);
    expect(vault.getLease(binding.assignmentId).leaseRevision).toBe(1);
    const restarted = new WorkerAssignmentLeaseOwner(context, state, await WorkerCredentialVault.open(state),
      "registry", { sync, renew });
    const lease = await restarted.resumeOrClaim({});
    expect(lease?.leaseRevision).toBe(2);
    expect(lease?.leaseToken).toBe(renew.mock.calls[0]![2].nextLeaseToken);
    expect(lease?.leaseToken).not.toBe(binding.leaseToken);
    expect(renew.mock.calls[1]).toEqual(renew.mock.calls[0]);
    expect(sync.mock.calls[1]![1]).toEqual(lease);
    expect(await state.read("assignment-renewal-pending")).toBeUndefined();
    expect(restarted.workerSentThrough()).toBe(7);
  });

  it("waits for parent recovery across restart without polling for another assignment or renewing", async () => {
    const state = createInMemoryWorkerDurableState();
    await retain(state);
    const poll = vi.fn();
    const renew = vi.fn();
    for (let restart = 0; restart < 2; restart++) {
      const observed = {};
      const owner = new WorkerAssignmentLeaseOwner(context, state, await WorkerCredentialVault.open(state), "registry", {
        poll, renew, sync: async () => ({ ...response("parent_recovery_pending"), body: {
          ...response("parent_recovery_pending").body, recovery: { bindingSha256: "a".repeat(64) },
        } }),
      });
      expect(await owner.resumeOrClaim(observed)).toBeUndefined();
      expect(observed).toMatchObject({ reconnectSync: "parent_recovery_pending", awaiting: "parent_recovery" });
      expect(owner.remainingLeaseMs()).toBe(0);
    }
    expect(poll).not.toHaveBeenCalled();
    expect(renew).not.toHaveBeenCalled();
    expect((await WorkerCredentialVault.open(state)).getLease(binding.assignmentId).rawLeaseToken).toBe(binding.leaseToken);
  });

  it.each(["missing", "wrong-assignment", "invalid-proof", "invalid-resume"])("does not renew %s continuation evidence", async (failure) => {
    const state = createInMemoryWorkerDurableState();
    const vault = await retain(state);
    const receipt = response("approval_resume_ready", failure === "wrong-assignment" ?
      { ...binding, assignmentId: "another" } : binding);
    const renew = vi.fn();
    const owner = new WorkerAssignmentLeaseOwner(context, state, vault, "registry", {
      renew,
      sync: async () => ({ ...receipt, body: { ...receipt.body,
        ...(failure === "missing" ? {} : { resume: { approvalId: "approval-one",
          runtimeAuthoritySha256: failure === "invalid-proof" ? "bad" : "a".repeat(64),
          resumeSha256: failure === "invalid-resume" ? "bad" : "b".repeat(64) } }),
      } }),
    });
    await expect(owner.resumeOrClaim({})).rejects.toThrow();
    expect(renew).not.toHaveBeenCalled();
    expect(await state.read("connected-run")).toBeDefined();
    expect(vault.getLease(binding.assignmentId).leaseRevision).toBe(1);
  });

  it.each(["missing", "wrong-assignment", "invalid-binding"])("does not renew %s parent recovery evidence", async (failure) => {
    const state = createInMemoryWorkerDurableState();
    const vault = await retain(state);
    const receipt = response("parent_recovery_ready", failure === "wrong-assignment" ?
      { ...binding, assignmentId: "another" } : binding);
    const renew = vi.fn();
    const owner = new WorkerAssignmentLeaseOwner(context, state, vault, "registry", {
      renew, sync: async () => ({ ...receipt, body: { ...receipt.body,
        ...(failure === "missing" ? {} : { recovery: { bindingSha256: failure === "invalid-binding" ? "bad" : "a".repeat(64) } }),
      } }),
    });
    await expect(owner.resumeOrClaim({})).rejects.toThrow();
    expect(renew).not.toHaveBeenCalled();
    expect(await state.read("connected-run")).toBeDefined();
    expect(vault.getLease(binding.assignmentId).leaseRevision).toBe(1);
  });

  it("persists a claim secret before sending and replays identical authority after a lost response", async () => {
    const state = createInMemoryWorkerDurableState();
    const poll = vi.fn(async () => offers());
    const claim = vi.fn(async (_context, input) => {
      expect(JSON.parse((await state.read("assignment-claim-pending"))!).leaseToken).toBe(input.leaseToken);
      if (claim.mock.calls.length === 1) throw new Error("response lost after Gateway commit");
      return response("replayed_without_lease_secret");
    });
    const first = new WorkerAssignmentLeaseOwner(context, state, await WorkerCredentialVault.open(state), "registry", {
      poll,
      claim,
    });
    await expect(first.resumeOrClaim({})).rejects.toThrow("response lost");
    const restartedVault = await WorkerCredentialVault.open(state);
    const restarted = new WorkerAssignmentLeaseOwner(context, state, restartedVault, "registry", { poll, claim });
    const lease = await restarted.resumeOrClaim({});
    expect(lease?.assignmentId).toBe(binding.assignmentId);
    expect(claim.mock.calls[0]![1]).toEqual(claim.mock.calls[1]![1]);
    expect(poll).toHaveBeenCalledTimes(1);
    expect(restartedVault.getLease(binding.assignmentId).rawLeaseToken).toBe(lease?.leaseToken);
    expect(await state.read("assignment-claim-pending")).toBeUndefined();
  });

  it("does not send a claim when the proposed authority cannot be persisted", async () => {
    const backing = createInMemoryWorkerDurableState();
    const state = {
      ...backing,
      write: async () => {
        throw new Error("disk full");
      },
    };
    const claim = vi.fn();
    const owner = new WorkerAssignmentLeaseOwner(context, state, await WorkerCredentialVault.open(state), "registry", {
      poll: async () => offers(),
      claim,
    });
    await expect(owner.resumeOrClaim({})).rejects.toThrow("disk full");
    expect(claim).not.toHaveBeenCalled();
  });

  it("recovers an ambiguous renewal before synchronizing with the rotated secret", async () => {
    const state = createInMemoryWorkerDurableState();
    const vault = await retain(state);
    const renew = vi.fn(async (_context, lease, input) => {
      const intent = JSON.parse((await state.read("assignment-renewal-pending"))!);
      expect(intent.nextLeaseToken).toBe(input.nextLeaseToken);
      expect(intent.lease.leaseToken).toBe(lease.leaseToken);
      if (renew.mock.calls.length === 1) throw new Error("lost renewal response");
      return response("replayed_without_lease_secret", { ...binding, leaseRevision: 2 }, 7);
    });
    const first = new WorkerAssignmentLeaseOwner(context, state, vault, "registry", { renew });
    await expect(first.renew(binding, 7, {})).rejects.toThrow("lost renewal");
    expect(vault.getLease(binding.assignmentId).leaseRevision).toBe(1);
    const sync = vi.fn(async (_context, lease) => response("synchronized", lease, 7));
    const restarted = new WorkerAssignmentLeaseOwner(
      context,
      state,
      await WorkerCredentialVault.open(state),
      "registry",
      { renew, sync },
    );
    const lease = await restarted.resumeOrClaim({});
    expect(lease?.leaseRevision).toBe(2);
    expect(renew.mock.calls[0]).toEqual(renew.mock.calls[1]);
    expect(sync.mock.calls[0]![1].leaseToken).toBe(renew.mock.calls[0]![2].nextLeaseToken);
    expect(await state.read("assignment-renewal-pending")).toBeUndefined();
    expect(restarted.workerSentThrough()).toBe(7);
    await expect(restarted.renew(lease!, 0, {})).rejects.toThrow("watermark");
  });

  it("preserves a renewal intent if retaining the committed lease fails", async () => {
    const backing = createInMemoryWorkerDurableState();
    await retain(backing);
    let failVault = true;
    const state = {
      ...backing,
      write: async (key: string, value: string) => {
        if (failVault && key === "assignment-leases") throw new Error("vault disk full");
        await backing.write(key, value);
      },
    };
    const vault = await WorkerCredentialVault.open(state);
    const renew = vi.fn(async () => response("renewed", { ...binding, leaseRevision: 2 }));
    const owner = new WorkerAssignmentLeaseOwner(context, state, vault, "registry", { renew });
    await expect(owner.renew(binding, 0, {})).rejects.toThrow("vault disk full");
    expect(vault.getLease(binding.assignmentId).leaseRevision).toBe(1);
    expect(await state.read("assignment-renewal-pending")).toBeDefined();
    expect(owner.remainingLeaseMs()).toBe(0);
    failVault = false;
    const sync = vi.fn(async (_context, lease) => response("synchronized", lease));
    const restarted = new WorkerAssignmentLeaseOwner(
      context,
      state,
      await WorkerCredentialVault.open(state),
      "registry",
      { renew, sync },
    );
    expect((await restarted.resumeOrClaim({}))?.leaseRevision).toBe(2);
    expect(restarted.remainingLeaseMs()).toBeGreaterThan(59_000);
    expect(restarted.remainingLeaseMs()).toBeLessThanOrEqual(60_000);
  });

  it("retains rejected/mismatched authority for operator reconciliation", async () => {
    const state = createInMemoryWorkerDurableState();
    const vault = await WorkerCredentialVault.open(state);
    const owner = new WorkerAssignmentLeaseOwner(context, state, vault, "registry", {
      poll: async () => offers(),
      claim: async () => response("started", { ...binding, assignmentId: "other" }),
    });
    await expect(owner.resumeOrClaim({})).rejects.toThrow("does not match");
    expect(vault.hasLease(binding.assignmentId)).toBe(false);
    expect(await state.read("assignment-claim-pending")).toBeDefined();
    const otherWorkspace = new WorkerAssignmentLeaseOwner(context, state, vault, "foreign", { claim: vi.fn() });
    await expect(otherWorkspace.resumeOrClaim({})).rejects.toThrow("workspace changed");
  });

  it("polls with fresh identities so an empty response cannot be cached forever", async () => {
    const state = createInMemoryWorkerDurableState();
    const poll = vi.fn<typeof pollOffers>(async () => ({ status: 200, body: { items: [] } }));
    const owner = new WorkerAssignmentLeaseOwner(context, state, await WorkerCredentialVault.open(state), "registry", {
      poll,
    });
    expect(await owner.resumeOrClaim({})).toBeUndefined();
    expect(await owner.resumeOrClaim({})).toBeUndefined();
    expect(poll.mock.calls[0]![1].idempotencyKey).not.toBe(poll.mock.calls[1]![1].idempotencyKey);
  });
});
