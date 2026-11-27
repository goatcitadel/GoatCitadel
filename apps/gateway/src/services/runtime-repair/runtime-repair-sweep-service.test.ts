import { describe, expect, it, vi } from "vitest";
import type { ApprovalRequest, DurableDeadLetterRecord, DurableRunRecord } from "@goatcitadel/contracts";
import {
  RuntimeRepairSweepService,
  type RuntimeRepairAuditPort,
  type RuntimeRepairReadPort,
} from "./runtime-repair-sweep-service.js";

const START = Date.parse("2026-11-27T12:00:00.000Z");

function waitRun(runId: string, approvalId: string): DurableRunRecord {
  return {
    runId,
    workflowKey: "approval.wait",
    status: "waiting",
    attemptCount: 1,
    maxAttempts: 3,
    version: 1,
    payload: { version: "approval.wait.v1", approvalId },
    createdAt: new Date(START - 60 * 60_000).toISOString(),
    updatedAt: new Date(START - 60 * 60_000).toISOString(),
  };
}

function deadLetter(overrides: Partial<DurableDeadLetterRecord> = {}): DurableDeadLetterRecord {
  return {
    deadLetterId: "dead-1",
    runId: "run-9",
    reason: "HTTP 503 Service Unavailable",
    payload: {},
    createdAt: new Date(START - 10 * 60_000).toISOString(),
    ...overrides,
  };
}

interface World {
  waitingRuns: DurableRunRecord[];
  otherRuns: DurableRunRecord[];
  approvals: Map<string, ApprovalRequest>;
  deadLetters: DurableDeadLetterRecord[];
}

function createHarness(world: Partial<World> = {}) {
  const state: World = {
    waitingRuns: world.waitingRuns ?? [],
    otherRuns: world.otherRuns ?? [],
    approvals: world.approvals ?? new Map(),
    deadLetters: world.deadLetters ?? [],
  };
  const events: Record<string, unknown>[] = [];
  let nowMs = START;
  let idCounter = 0;
  const reads: RuntimeRepairReadPort = {
    listWaitingRunIds: vi.fn(async (limit: number) => state.waitingRuns.slice(0, limit).map((run) => run.runId)),
    getRunsByIds: vi.fn(
      async (runIds: string[]) =>
        new Map(
          [...state.waitingRuns, ...state.otherRuns]
            .filter((run) => runIds.includes(run.runId))
            .map((run) => [run.runId, run] as const),
        ),
    ),
    getApproval: vi.fn(async (approvalId: string) => state.approvals.get(approvalId) ?? null),
    listPendingApprovals: vi.fn(async () => [...state.approvals.values()].filter((item) => item.status === "pending")),
    listExpiredPendingApprovals: vi.fn(async () => []),
    listDeadLetters: vi.fn(async (limit: number) => state.deadLetters.slice(0, limit)),
    listRecentRuns: vi.fn(async (limit: number) => state.otherRuns.slice(0, limit)),
  };
  const audit: RuntimeRepairAuditPort = {
    append: vi.fn(async (payload: Record<string, unknown>) => {
      events.push(payload);
    }),
    listRecent: vi.fn(async (limit: number) => events.slice(-limit)),
  };
  const build = () =>
    new RuntimeRepairSweepService({
      reads,
      audit,
      now: () => nowMs,
      newId: () => `finding-${++idCounter}`,
    });
  return {
    state,
    events,
    reads,
    audit,
    build,
    advance(ms: number) {
      nowMs += ms;
    },
  };
}

describe("RuntimeRepairSweepService", () => {
  it("is not ready before its first tick", () => {
    const harness = createHarness();
    const snapshot = harness.build().snapshot();
    expect(snapshot).toMatchObject({ mode: "detect_only", ready: false, open: [], recentlyCleared: [] });
  });

  it("records a new finding once and counts later sightings without logging them again", async () => {
    const harness = createHarness({ waitingRuns: [waitRun("run-1", "approval-gone")] });
    const sweep = harness.build();

    await sweep.runTick();
    harness.advance(60_000);
    await sweep.runTick();

    expect(harness.events).toHaveLength(1);
    expect(harness.events[0]).toMatchObject({
      event: "finding_observed",
      schemaVersion: 1,
      findingId: "finding-1",
      detectorId: "approval.wait-orphaned",
      subject: { runId: "run-1", approvalId: "approval-gone" },
    });
    const snapshot = sweep.snapshot();
    expect(snapshot.ready).toBe(true);
    expect(snapshot.open).toHaveLength(1);
    expect(snapshot.open[0]).toMatchObject({ findingId: "finding-1", state: "observed", seenCount: 2 });
    expect(snapshot.open[0]?.lastSeenAt).toBe(new Date(START + 60_000).toISOString());
  });

  it("clears a finding when the condition is gone and logs the clear", async () => {
    const harness = createHarness({ deadLetters: [deadLetter()] });
    const sweep = harness.build();
    await sweep.runTick();

    harness.state.deadLetters = [deadLetter({ resolvedAt: new Date(START).toISOString() })];
    harness.advance(60_000);
    await sweep.runTick();

    expect(harness.events.map((event) => event.event)).toEqual(["finding_observed", "finding_cleared"]);
    const snapshot = sweep.snapshot();
    expect(snapshot.open).toEqual([]);
    expect(snapshot.recentlyCleared[0]).toMatchObject({
      findingId: "finding-1",
      state: "cleared",
      clearedAt: new Date(START + 60_000).toISOString(),
    });
  });

  it("keeps open findings when their source cannot be read, instead of calling them cleared", async () => {
    const harness = createHarness({ deadLetters: [deadLetter()] });
    const sweep = harness.build();
    await sweep.runTick();

    vi.mocked(harness.reads.listDeadLetters).mockRejectedValueOnce(new Error("database unavailable"));
    harness.advance(60_000);
    await sweep.runTick();

    expect(harness.events.map((event) => event.event)).toEqual(["finding_observed"]);
    const snapshot = sweep.snapshot();
    expect(snapshot.open).toHaveLength(1);
    expect(snapshot.detectors.find((detector) => detector.detectorId === "durable.dead-letter")).toMatchObject({
      lastError: "database unavailable",
    });
  });

  it("marks a detector truncated when its source hits the read limit", async () => {
    const harness = createHarness({
      deadLetters: Array.from({ length: 300 }, (_, index) => deadLetter({ deadLetterId: `dead-${index}` })),
    });
    const sweep = harness.build();
    await sweep.runTick();
    const status = sweep.snapshot().detectors.find((detector) => detector.detectorId === "durable.dead-letter");
    expect(status?.truncated).toBe(true);
  });

  it("keeps a finding open when a truncated read no longer reaches it, instead of calling it cleared", async () => {
    const harness = createHarness({ deadLetters: [deadLetter({ deadLetterId: "dead-old" })] });
    const sweep = harness.build();
    await sweep.runTick();
    expect(sweep.snapshot().open).toHaveLength(1);

    // 200 newer dead letters push the old one out of the newest-first read, but it is still unresolved.
    harness.state.deadLetters = Array.from({ length: 200 }, (_, index) =>
      deadLetter({ deadLetterId: `dead-new-${index}` }),
    );
    harness.advance(60_000);
    await sweep.runTick();

    expect(harness.events.filter((event) => event.event === "finding_cleared")).toEqual([]);
    expect(sweep.snapshot().open.map((finding) => finding.subject.deadLetterId)).toContain("dead-old");
  });

  it("clears an unseen finding once the read is complete again", async () => {
    const harness = createHarness({ deadLetters: [deadLetter({ deadLetterId: "dead-old" })] });
    const sweep = harness.build();
    await sweep.runTick();
    harness.state.deadLetters = Array.from({ length: 200 }, (_, index) =>
      deadLetter({ deadLetterId: `dead-new-${index}` }),
    );
    harness.advance(60_000);
    await sweep.runTick();

    harness.state.deadLetters = [];
    harness.advance(60_000);
    await sweep.runTick();

    expect(
      harness.events.filter((event) => event.event === "finding_cleared").map((event) => event.findingId),
    ).toContain("finding-1");
    expect(sweep.snapshot().open).toEqual([]);
  });

  it("only checks approval wait runs and treats a missing approval as orphaned", async () => {
    const chatRun: DurableRunRecord = { ...waitRun("run-chat", "unused"), workflowKey: "chat.turn.execute" };
    const harness = createHarness({ waitingRuns: [chatRun, waitRun("run-1", "approval-gone")] });
    await harness.build().runTick();
    expect(harness.reads.getApproval).toHaveBeenCalledTimes(1);
    expect(harness.reads.getApproval).toHaveBeenCalledWith("approval-gone");
    expect(harness.events).toHaveLength(1);
  });

  it("retries an unlogged finding on the next tick when the audit write fails", async () => {
    const harness = createHarness({ deadLetters: [deadLetter()] });
    const sweep = harness.build();
    vi.mocked(harness.audit.append).mockRejectedValueOnce(new Error("disk full"));

    await sweep.runTick();
    expect(sweep.snapshot().open).toEqual([]);

    harness.advance(60_000);
    await sweep.runTick();
    expect(sweep.snapshot().open).toHaveLength(1);
    expect(harness.events).toHaveLength(1);
  });

  it("rebuilds open findings from the audit stream after a restart without logging them again", async () => {
    const harness = createHarness({ deadLetters: [deadLetter()] });
    await harness.build().runTick();

    const restarted = harness.build();
    harness.advance(60_000);
    await restarted.runTick();

    expect(harness.events).toHaveLength(1);
    expect(restarted.snapshot().open[0]).toMatchObject({
      findingId: "finding-1",
      firstSeenAt: new Date(START).toISOString(),
      seenCount: 1,
    });
  });

  it("logs the clear after a restart when the problem was fixed while the Gateway was down", async () => {
    const harness = createHarness({ deadLetters: [deadLetter()] });
    await harness.build().runTick();

    harness.state.deadLetters = [];
    const restarted = harness.build();
    await restarted.runTick();

    expect(harness.events.map((event) => event.event)).toEqual(["finding_observed", "finding_cleared"]);
    expect(harness.events[1]).toMatchObject({ findingId: "finding-1" });
  });

  it("ignores malformed audit records when rebuilding", async () => {
    const harness = createHarness();
    harness.events.push(
      { event: "finding_observed", findingId: 7 },
      { event: "something_else" },
      { event: "finding_observed", schemaVersion: 1, findingId: "x", fingerprint: "f", detectorId: "not.a.detector" },
    );
    const sweep = harness.build();
    await sweep.runTick();
    expect(sweep.snapshot().open).toEqual([]);
    expect(harness.events.filter((event) => event.event === "finding_cleared")).toEqual([]);
  });

  it("does not run two ticks at once", async () => {
    const harness = createHarness();
    let release: () => void = () => undefined;
    vi.mocked(harness.reads.listDeadLetters).mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          release = () => resolve([]);
        }),
    );
    const sweep = harness.build();
    const first = sweep.runTick();
    await vi.waitFor(() => expect(harness.reads.listDeadLetters).toHaveBeenCalledTimes(1));
    await sweep.runTick();
    release();
    await first;
    expect(harness.reads.listDeadLetters).toHaveBeenCalledTimes(1);
  });
});
