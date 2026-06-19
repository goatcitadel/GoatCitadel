/**
 * P0-4 governance/safety regression — chat-turn write-after-archive / write-after-switch.
 *
 * Guard under test: `withChatTurnWriteLease` (backed by `ChatTurnExecutionRegistry`)
 * serialises mutating chat-turn work per session so a turn/undo write cannot interleave
 * with — or land after — a concurrent session archive/switch on the same session.
 *
 * These tests drive `undoChatTurns` because it is the smallest mutating turn-write whose
 * lease + session-existence seams are fully injectable. We use the REAL
 * `ChatTurnExecutionRegistry` for the lease (not a pass-through stub) so the mutual
 * exclusion is exercised for real, and we stub the storage mutators so we can assert that
 * NO delete lands when the guard rejects the write.
 *
 * SEAM NOTE / harder race this suite does NOT (and cannot, with these seams) prove:
 *   `undoChatTurns` validates session existence by calling `deps.getSession(sessionId)`
 *   *once, before* acquiring the lease, and then never re-reads `lifecycleStatus` after the
 *   lease is held (unlike the send/prep path, which calls `assertChatSessionActive(...)` in
 *   `chat-turn-prep-service.ts`). Archiving a session keeps it retrievable
 *   (`archiveChatSession` only patches `lifecycleStatus: "archived"`; `getSession` still
 *   returns it — see chat-session-service.ts), so the ONLY archive-race protections undo
 *   has are (a) the write lease serialising it against the concurrent archive/turn write
 *   and (b) `getSession` throwing for a fully *deleted* session. A truly faithful
 *   "archived mid-lease" race would need an in-lease `lifecycleStatus` re-check seam that
 *   the undo service does not currently expose; closing that gap is an implementation
 *   change, not a test change. The tests below pin the behaviour the seams DO guarantee.
 */
import { describe, expect, it, vi } from "vitest";
import type { ChatTurnTraceRecord } from "@goatcitadel/contracts";
import { NotFoundError } from "@goatcitadel/contracts";
import { undoChatTurns, type ChatTurnUndoDependencies } from "./chat-turn-undo-service.js";
import {
  ChatTurnExecutionRegistry,
  ChatTurnWriteConflictError,
} from "./chat-turn-execution-registry.js";

const SESSION_ID = "session-race";

function singleCompletedTrace(): ChatTurnTraceRecord {
  return {
    turnId: "turn-1",
    sessionId: SESSION_ID,
    userMessageId: "user-1",
    assistantMessageId: "assistant-1",
    status: "completed",
  } as ChatTurnTraceRecord;
}

function createDeps(input: {
  registry: ChatTurnExecutionRegistry;
  getSession?: ChatTurnUndoDependencies["getSession"];
  deleteMessages?: ReturnType<typeof vi.fn>;
  deleteTraces?: ReturnType<typeof vi.fn>;
  traces?: ChatTurnTraceRecord[];
  activeLeafTurnId?: string;
}): {
  deps: ChatTurnUndoDependencies;
  deleteMessages: ReturnType<typeof vi.fn>;
  deleteTraces: ReturnType<typeof vi.fn>;
  leaseSpy: ReturnType<typeof vi.fn>;
} {
  const traces = input.traces ?? [singleCompletedTrace()];
  const deleteMessages = input.deleteMessages ?? vi.fn(() => traces.length);
  const deleteTraces = input.deleteTraces ?? vi.fn(() => traces.length);
  // Use the REAL registry to enforce the per-session lease; spy on it so we can assert
  // ordering (lease acquired before any mutation).
  const leaseSpy = vi.fn(
    <T>(sessionId: string, operation: string, work: () => Promise<T>): Promise<T> =>
      input.registry.withWriteLease(sessionId, operation, work),
  );

  const deps: ChatTurnUndoDependencies = {
    getSession: input.getSession ?? vi.fn(() => ({ sessionId: SESSION_ID })),
    loadChatTurnSessionState: vi.fn(async () => ({
      traces,
      tracesById: new Map(traces.map((trace) => [trace.turnId, trace])),
      turnLineageById: new Map(traces.map((trace) => [trace.turnId, { turnId: trace.turnId, parentTurnId: trace.parentTurnId }])),
      messages: [],
      messagesById: new Map(),
      childrenByTurnId: new Map(),
      activeLeafTurnId: input.activeLeafTurnId ?? traces.at(-1)?.turnId,
    })),
    publishRealtime: vi.fn(),
    recordDevDiagnostic: vi.fn(),
    storage: {
      runImmediateTransaction: (callback) => callback(),
      chatMessages: { deleteByMessageIds: deleteMessages },
      chatTurnTraces: { deleteByTurnIds: deleteTraces },
      chatSessionBranchState: { setActiveLeaf: vi.fn(), clear: vi.fn() },
    },
    withChatTurnWriteLease: leaseSpy as ChatTurnUndoDependencies["withChatTurnWriteLease"],
  } as ChatTurnUndoDependencies;

  return { deps, deleteMessages, deleteTraces, leaseSpy };
}

describe("chat-turn write lease — race against session archive/switch", () => {
  it("rejects a concurrent undo while another write holds the session lease, and lands no mutation", async () => {
    const registry = new ChatTurnExecutionRegistry();

    // Simulate an in-flight write (e.g. the archive/switch handler, or another turn write)
    // that holds the lease for SESSION_ID until we release it.
    let releaseHolder: () => void = () => undefined;
    const holderDone = new Promise<void>((resolve) => {
      releaseHolder = resolve;
    });
    const holder = registry.withWriteLease(SESSION_ID, "archive-session", async () => {
      await holderDone;
    });
    // Yield so the holder actually acquires the lease before the undo attempt.
    await Promise.resolve();

    const { deps, deleteMessages, deleteTraces } = createDeps({ registry });

    // The undo write must be rejected — it cannot interleave with the in-flight write.
    await expect(undoChatTurns(deps, SESSION_ID, 1)).rejects.toBeInstanceOf(ChatTurnWriteConflictError);

    // Critically, no turn data was mutated by the rejected undo.
    expect(deleteMessages).not.toHaveBeenCalled();
    expect(deleteTraces).not.toHaveBeenCalled();

    releaseHolder();
    await holder;
  });

  it("lets the undo proceed only once the contending lease holder releases (writes serialise, not interleave)", async () => {
    const registry = new ChatTurnExecutionRegistry();

    let releaseHolder: () => void = () => undefined;
    const holderDone = new Promise<void>((resolve) => {
      releaseHolder = resolve;
    });
    const holder = registry.withWriteLease(SESSION_ID, "switch-session", async () => {
      await holderDone;
    });
    await Promise.resolve();

    const { deps, deleteMessages, deleteTraces } = createDeps({ registry });

    // While the holder is active, undo is rejected (no mutation).
    await expect(undoChatTurns(deps, SESSION_ID, 1)).rejects.toBeInstanceOf(ChatTurnWriteConflictError);
    expect(deleteTraces).not.toHaveBeenCalled();

    // After the holder releases the lease, a fresh undo succeeds — proving the writes are
    // serialised (one-at-a-time) rather than allowed to interleave.
    releaseHolder();
    await holder;

    await expect(undoChatTurns(deps, SESSION_ID, 1)).resolves.toMatchObject({ undoneCount: 1 });
    expect(deleteMessages).toHaveBeenCalledTimes(1);
    expect(deleteTraces).toHaveBeenCalledTimes(1);
  });

  it("acquires the write lease before performing any turn mutation", async () => {
    const registry = new ChatTurnExecutionRegistry();
    const order: string[] = [];
    const deleteMessages = vi.fn(() => {
      order.push("delete-messages");
      return 1;
    });
    const deleteTraces = vi.fn(() => {
      order.push("delete-traces");
      return 1;
    });
    const { deps, leaseSpy } = createDeps({ registry, deleteMessages, deleteTraces });
    // Wrap the lease spy to record when the lease body actually starts running.
    const wrappedLease = vi.fn(
      <T>(sessionId: string, operation: string, work: () => Promise<T>): Promise<T> =>
        leaseSpy(sessionId, operation, async () => {
          order.push("lease-body-start");
          return work();
        }),
    );
    (deps as { withChatTurnWriteLease: unknown }).withChatTurnWriteLease = wrappedLease;

    await undoChatTurns(deps, SESSION_ID, 1);

    expect(order[0]).toBe("lease-body-start");
    expect(order).toEqual(["lease-body-start", "delete-messages", "delete-traces"]);
    // The lease is taken for the undo operation against the right session.
    expect(leaseSpy).toHaveBeenCalledWith(SESSION_ID, "chat.undo", expect.any(Function));
  });

  it("rejects a write against a missing/deleted session before taking the lease or mutating", async () => {
    const registry = new ChatTurnExecutionRegistry();
    // A deleted session: getSession throws NotFoundError (the pre-lease existence gate).
    const getSession = vi.fn(() => {
      throw new NotFoundError({ message: `chat session ${SESSION_ID} not found` });
    });
    const { deps, deleteMessages, deleteTraces, leaseSpy } = createDeps({ registry, getSession });

    await expect(undoChatTurns(deps, SESSION_ID, 1)).rejects.toBeInstanceOf(NotFoundError);

    // The existence gate fires before the lease is taken and before any mutation.
    expect(leaseSpy).not.toHaveBeenCalled();
    expect(deleteMessages).not.toHaveBeenCalled();
    expect(deleteTraces).not.toHaveBeenCalled();
    // And after the rejected write, the session lease is free for the next legitimate write.
    expect(() => registry.acquireWriteLease(SESSION_ID, "next-write")).not.toThrow();
  });

  it("releases the lease after a successful write so a later archive/switch can take it", async () => {
    const registry = new ChatTurnExecutionRegistry();
    const { deps } = createDeps({ registry });

    await expect(undoChatTurns(deps, SESSION_ID, 1)).resolves.toMatchObject({ undoneCount: 1 });

    // Lease was released in the `finally` of withWriteLease — a subsequent archive/switch
    // write can acquire it without hitting a stale-lease conflict.
    expect(() => registry.acquireWriteLease(SESSION_ID, "archive-session")).not.toThrow();
  });
});
