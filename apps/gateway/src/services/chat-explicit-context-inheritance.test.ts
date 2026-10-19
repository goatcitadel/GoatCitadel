import { describe, expect, it, vi } from "vitest";

const readAuthority = vi.hoisted(() => vi.fn());
vi.mock("@goatcitadel/contracts", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@goatcitadel/contracts")>()),
  readDurableChatTurnExecutionPayloadAuthority: readAuthority,
}));

import {
  contextRefsFromSnapshot,
  resolveInheritedChatContextRefs,
  type ExplicitContextInheritanceStorage,
} from "./chat-explicit-context-inheritance.js";
import type { ActiveTurnAdmission } from "./chat-turn-types.js";

const parentSnapshot = {
  snapshotId: "parent-snapshot",
  snapshotHash: "a".repeat(64),
  turnId: "turn-parent",
  workspaceId: "workspace-1",
  entries: [
    { index: 1, kind: "attachment", ref: "attachment-2", label: "Second" },
    { index: 0, kind: "memory_item", ref: "memory-1", label: "First" },
    { index: 2, kind: "memory_item", ref: "memory-1", label: "Duplicate" },
  ],
};

function admission(extra: Partial<ActiveTurnAdmission["admittedRequest"]> = {}, durable = false): ActiveTurnAdmission {
  return {
    identity: {
      admissionId: "admission-1",
      workspaceId: "workspace-1",
      sessionId: "child-session",
      turnId: "turn-child",
    },
    admittedRequest: { content: "Continue.", ...extra },
    requestActor: { actorKind: "operator", actorId: "operator-1" },
    ...(durable ? { durableClaim: { durableRunId: "run-1", leaseOwnerId: "worker", attemptCount: 1 } } : {}),
  } as unknown as ActiveTurnAdmission;
}

function host(enabled = true) {
  const findByTurn = vi.fn(async (turnId: string) =>
    turnId === "turn-parent" || turnId === "turn-source" ? parentSnapshot : undefined,
  );
  const storage = {
    routedContextSnapshots: { findByTurn },
    chatDelegationRuns: { get: vi.fn(async () => ({ parentRunId: "parent-run" })) },
    durableRuns: {
      getRun: vi.fn(async () => ({ runId: "parent-run", workflowKey: "chat.turn.execute", payload: {} })),
    },
  } as unknown as ExplicitContextInheritanceStorage;
  return {
    storage,
    findByTurn,
    isFeatureEnabled: vi.fn(async (flag: string) => enabled && flag === "chatExplicitContextBranchesV1Enabled"),
  };
}

describe("explicit context inheritance for edit, retry and child turns", () => {
  it("rebuilds ordered, de-duplicated source ids without labels", () => {
    expect(contextRefsFromSnapshot(parentSnapshot as never)).toEqual([
      { kind: "memory_item", ref: "memory-1" },
      { kind: "attachment", ref: "attachment-2" },
    ]);
  });

  it("re-admits the source turn's refs on edit or retry only with the branch flag", async () => {
    const h = host();
    const base = { request: {}, sourceTurnId: "turn-source", admission: admission(), profileBound: false };
    for (const branchKind of ["retry", "edit"]) {
      expect(await resolveInheritedChatContextRefs(h, { ...base, branchKind })).toEqual({
        source: "branch",
        refs: [
          { kind: "memory_item", ref: "memory-1" },
          { kind: "attachment", ref: "attachment-2" },
        ],
      });
    }
    expect(await resolveInheritedChatContextRefs(h, { ...base, branchKind: "append" })).toBeUndefined();
    expect(await resolveInheritedChatContextRefs(host(false), { ...base, branchKind: "retry" })).toBeUndefined();
  });

  it("never inherits for explicit refs, durable replay or historical profile turns", async () => {
    const h = host();
    const base = { branchKind: "retry", sourceTurnId: "turn-source", profileBound: false };
    expect(
      await resolveInheritedChatContextRefs(h, { ...base, request: { contextRefs: [] }, admission: admission() }),
    ).toBeUndefined();
    expect(
      await resolveInheritedChatContextRefs(h, { ...base, request: {}, admission: admission({}, true) }),
    ).toBeUndefined();
    expect(
      await resolveInheritedChatContextRefs(h, { ...base, request: {}, admission: admission(), profileBound: true }),
    ).toBeUndefined();
    expect(await resolveInheritedChatContextRefs(h, { ...base, request: {}, admission: undefined })).toBeUndefined();
    expect(h.findByTurn).not.toHaveBeenCalled();
  });

  it("gives a delegated child its parent's admitted ids after matching the parent's durable binding", async () => {
    const h = host();
    readAuthority.mockReturnValue({
      turnId: "turn-parent",
      routedContextSnapshotId: "parent-snapshot",
      routedContextSnapshotHash: "a".repeat(64),
    });
    const child = admission({ parentDelegationStepId: "step-1", policyRunId: "delegation-1" });
    const inherited = await resolveInheritedChatContextRefs(h, {
      request: { parentDelegationStepId: "step-1" },
      branchKind: "append",
      admission: child,
      profileBound: false,
    });
    expect(inherited?.source).toBe("parent");
    // The session-bound attachment stays with the parent session.
    expect(inherited?.refs).toEqual([{ kind: "memory_item", ref: "memory-1" }]);
    readAuthority.mockReturnValue({
      turnId: "turn-parent",
      routedContextSnapshotId: "parent-snapshot",
      routedContextSnapshotHash: "b".repeat(64),
    });
    await expect(
      resolveInheritedChatContextRefs(h, {
        request: { parentDelegationStepId: "step-1" },
        branchKind: "append",
        admission: child,
        profileBound: false,
      }),
    ).rejects.toThrow(/parent turn's admitted context changed/);
    readAuthority.mockReturnValue({ turnId: "turn-parent" });
    expect(
      await resolveInheritedChatContextRefs(h, {
        request: { parentDelegationStepId: "step-1" },
        branchKind: "append",
        admission: child,
        profileBound: false,
      }),
    ).toBeUndefined();
  });
});
