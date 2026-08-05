import { afterEach, describe, expect, it, vi } from "vitest";
import type {
  HeartbeatOccurrenceAdmissionRequest,
  HeartbeatOccurrenceRecord,
  SessionMutationAdmissionRecord,
} from "@goatcitadel/storage";
import {
  HeartbeatOccurrenceService,
  buildHeartbeatOccurrencePlan,
  type HeartbeatOccurrenceServiceDeps,
} from "./heartbeat-occurrence-service.js";

const CLAIM_INPUT = {
  workspaceId: "workspace-1",
  sessionId: "session-1",
  expectedPriorCadence: {
    lastProactiveAt: "2026-07-15T18:00:00.000Z",
    lastProactiveRunId: "prior-run-1",
  },
  idleFloorSeconds: 300,
} as const;

afterEach(() => {
  vi.useRealTimers();
});

describe("HeartbeatOccurrenceService", () => {
  it("freezes deterministic content-free request, objective, and evaluated-policy digests", () => {
    const first = buildHeartbeatOccurrencePlan(CLAIM_INPUT);
    const replay = buildHeartbeatOccurrencePlan(CLAIM_INPUT);
    const nextCadence = buildHeartbeatOccurrencePlan({
      ...CLAIM_INPUT,
      expectedPriorCadence: { ...CLAIM_INPUT.expectedPriorCadence, lastProactiveRunId: "prior-run-2" },
    });

    expect(replay).toEqual(first);
    expect(first.sourceRunId).toMatch(/^heartbeat_source_[a-f0-9]{40}$/u);
    expect(first.frozenRequestSha256).toMatch(/^[a-f0-9]{64}$/u);
    expect(first.frozenObjectiveSha256).toMatch(/^[a-f0-9]{64}$/u);
    expect(first.evaluatedPolicySha256).toMatch(/^[a-f0-9]{64}$/u);
    expect(nextCadence.sourceRunId).not.toBe(first.sourceRunId);
  });

  it("uses the callback-free atomic claim exactly once and hydrates its preclaimed enqueue authority", async () => {
    const plan = buildHeartbeatOccurrencePlan(CLAIM_INPUT);
    const occurrence = buildOccurrence(plan);
    const admissionRecord = buildAdmissionRecord(occurrence);
    const activeAdmission = buildActiveAdmission(occurrence, plan);
    const admitSystemHeartbeatOccurrence = vi.fn(() => ({ admission: activeAdmission, record: admissionRecord }));
    const claim = vi.fn(() => ({ disposition: "created", occurrence }) as const);
    const enqueuePreclaimedHeartbeat = vi.fn(async () => true);
    const service = new HeartbeatOccurrenceService(
      buildDeps({ claim, admitSystemHeartbeatOccurrence, enqueuePreclaimedHeartbeat }),
    );

    await expect(service.claimAndEnqueue(CLAIM_INPUT)).resolves.toEqual({ disposition: "enqueued" });

    expect(claim).toHaveBeenCalledWith({
      workspaceId: CLAIM_INPUT.workspaceId,
      sessionId: CLAIM_INPUT.sessionId,
      expectedPriorCadence: CLAIM_INPUT.expectedPriorCadence,
      evaluatedPolicySha256: plan.evaluatedPolicySha256,
      frozenRequestSha256: plan.frozenRequestSha256,
      frozenObjectiveSha256: plan.frozenObjectiveSha256,
      idleFloorSeconds: CLAIM_INPUT.idleFloorSeconds,
    });
    expect(claim.mock.calls[0]?.[0]).not.toHaveProperty("content");
    expect(claim.mock.calls[0]?.[0]).not.toHaveProperty("prompt");
    expect(admitSystemHeartbeatOccurrence).toHaveBeenCalledWith({
      occurrenceRequest: buildAdmissionRequest(occurrence),
      request: plan.request,
    });
    expect(enqueuePreclaimedHeartbeat).toHaveBeenCalledWith(
      expect.objectContaining({
        occurrence,
        turnAdmission: activeAdmission,
        request: plan.request,
        sourceRunId: plan.sourceRunId,
      }),
    );
  });

  it("treats an exact replay with a live pre-bind lease as busy and never admits or enqueues again", async () => {
    const plan = buildHeartbeatOccurrencePlan(CLAIM_INPUT);
    const occurrence = buildOccurrence(plan);
    const admitSystemHeartbeatOccurrence = vi.fn();
    const recoverSystemHeartbeatOccurrence = vi.fn(() => ({ disposition: "live" as const }));
    const enqueuePreclaimedHeartbeat = vi.fn(async () => true);
    const service = new HeartbeatOccurrenceService(
      buildDeps({
        claim: vi.fn(() => ({ disposition: "replayed", occurrence })),
        admitSystemHeartbeatOccurrence,
        recoverSystemHeartbeatOccurrence,
        enqueuePreclaimedHeartbeat,
      }),
    );

    await expect(service.claimAndEnqueue(CLAIM_INPUT)).resolves.toEqual({ disposition: "database_busy" });
    expect(admitSystemHeartbeatOccurrence).not.toHaveBeenCalled();
    expect(recoverSystemHeartbeatOccurrence).toHaveBeenCalledWith({ occurrence, request: plan.request });
    expect(enqueuePreclaimedHeartbeat).not.toHaveBeenCalled();
  });

  it("preserves an authoritative database not-due reason as an expected skip", async () => {
    const service = new HeartbeatOccurrenceService(
      buildDeps({
        claim: vi.fn(() => ({
          disposition: "not_due",
          reason: "cadence_changed",
          databaseNow: "2026-07-15T19:00:00.000Z",
        })),
      }),
    );

    await expect(service.claimAndEnqueue(CLAIM_INPUT)).resolves.toEqual({
      disposition: "database_not_due",
      reason: "cadence_changed",
    });
  });

  it("reports an exact terminal claim replay as recovered rather than a failed enqueue", async () => {
    const plan = buildHeartbeatOccurrencePlan(CLAIM_INPUT);
    const occurrence = buildOccurrence(plan, {
      state: "terminal",
      boundDurableRunId: "hbr_child_1",
      capabilityProfileId: "profile-1",
      capabilityProfileHash: "9".repeat(64),
      terminalStatus: "completed",
    });
    const service = new HeartbeatOccurrenceService(
      buildDeps({
        claim: vi.fn(() => ({ disposition: "replayed", occurrence })),
        markDurableBound: vi.fn(() => ({ disposition: "replayed", occurrence })),
        markTerminal: vi.fn(() => ({ disposition: "replayed", occurrence })),
        getDurableRun: vi.fn(() => ({ runId: occurrence.durableRunId, workflowKey: "chat.turn.execute" })),
      }),
    );

    await expect(service.claimAndEnqueue(CLAIM_INPUT)).resolves.toEqual({
      disposition: "database_recovered",
      outcome: "terminal",
    });
  });

  it("reclaims one expired exact pre-bind lease and resumes the deterministic child", async () => {
    const plan = buildHeartbeatOccurrencePlan(CLAIM_INPUT);
    const occurrence = buildOccurrence(plan);
    const activeAdmission = buildActiveAdmission(occurrence, plan);
    const enqueuePreclaimedHeartbeat = vi.fn(async () => true);
    const service = new HeartbeatOccurrenceService(
      buildDeps({
        listRecoverablePage: vi.fn(() => ({ items: [occurrence] })),
        recoverSystemHeartbeatOccurrence: vi.fn(() => ({
          disposition: "reclaimed" as const,
          admission: activeAdmission,
        })),
        enqueuePreclaimedHeartbeat,
      }),
    );

    await expect(service.recoverAll()).resolves.toEqual({
      scanned: 1,
      parked: 0,
      busy: 0,
      reclaimed: 1,
      resumed: 0,
      terminal: 0,
      closed: 0,
    });
    expect(enqueuePreclaimedHeartbeat).toHaveBeenCalledWith(
      expect.objectContaining({ occurrence, turnAdmission: activeAdmission, sourceRunId: plan.sourceRunId }),
    );
  });

  it("releases an admitted pre-bind heartbeat while disabled and retains cadence after re-enable", async () => {
    const plan = buildHeartbeatOccurrencePlan(CLAIM_INPUT);
    const occurrence = buildOccurrence(plan);
    const abandoned = buildOccurrence(plan, {
      state: "abandoned",
      abandonmentReason: "admission_closed",
    });
    const activeAdmission = buildActiveAdmission(occurrence, plan);
    let enabled = false;
    const recoverSystemHeartbeatOccurrence = vi.fn(() => ({
      disposition: "reclaimed" as const,
      admission: activeAdmission,
    }));
    const enqueuePreclaimedHeartbeat = vi.fn(async () => true);
    const abandonAdmittedHeartbeatForExecutionDisabled = vi.fn(() => ({
      disposition: "parked" as const,
      occurrenceId: occurrence.occurrenceId,
      admission: {} as never,
    }));
    const listRecoverablePage = vi
      .fn()
      .mockReturnValueOnce({ items: [occurrence] })
      .mockReturnValue({ items: [] });
    const service = new HeartbeatOccurrenceService(
      buildDeps({
        canEnqueueHeartbeat: () => enabled,
        listRecoverablePage,
        find: vi.fn(() => abandoned),
        abandonAdmittedHeartbeatForExecutionDisabled,
        recoverSystemHeartbeatOccurrence,
        enqueuePreclaimedHeartbeat,
      }),
    );

    await expect(service.recoverAll()).resolves.toEqual({
      scanned: 1,
      parked: 1,
      busy: 0,
      reclaimed: 0,
      resumed: 0,
      terminal: 0,
      closed: 0,
    });
    expect(abandonAdmittedHeartbeatForExecutionDisabled).toHaveBeenCalledWith({
      workspaceId: occurrence.workspaceId,
      sessionId: occurrence.sessionId,
      occurrenceId: occurrence.occurrenceId,
      admissionId: occurrence.admissionId,
      claimSha256: occurrence.claimSha256,
      idempotencyKey: `heartbeat-execution-disabled:${occurrence.occurrenceId}`,
      correlationId: occurrence.occurrenceId,
    });
    expect(recoverSystemHeartbeatOccurrence).not.toHaveBeenCalled();
    expect(enqueuePreclaimedHeartbeat).not.toHaveBeenCalled();

    enabled = true;
    await expect(service.recoverAll()).resolves.toMatchObject({ scanned: 0, parked: 0, reclaimed: 0 });
    await expect(service.claimAndEnqueue(CLAIM_INPUT)).resolves.toEqual({
      disposition: "database_not_due",
      reason: "interval",
    });
    expect(recoverSystemHeartbeatOccurrence).not.toHaveBeenCalled();
    expect(enqueuePreclaimedHeartbeat).not.toHaveBeenCalled();
  });

  it("converges a two-worker stale reclaim race to one enqueue and one database-busy result", async () => {
    const plan = buildHeartbeatOccurrencePlan(CLAIM_INPUT);
    const occurrence = buildOccurrence(plan);
    const activeAdmission = buildActiveAdmission(occurrence, plan);
    const recoverSystemHeartbeatOccurrence = vi
      .fn()
      .mockReturnValueOnce({ disposition: "reclaimed" as const, admission: activeAdmission })
      .mockReturnValueOnce({ disposition: "live" as const });
    const enqueuePreclaimedHeartbeat = vi.fn(async () => true);
    const service = new HeartbeatOccurrenceService(
      buildDeps({
        claim: vi.fn(() => ({ disposition: "replayed", occurrence })),
        recoverSystemHeartbeatOccurrence,
        enqueuePreclaimedHeartbeat,
      }),
    );

    const outcomes = await Promise.all([service.claimAndEnqueue(CLAIM_INPUT), service.claimAndEnqueue(CLAIM_INPUT)]);

    expect(outcomes).toEqual(expect.arrayContaining([{ disposition: "enqueued" }, { disposition: "database_busy" }]));
    expect(recoverSystemHeartbeatOccurrence).toHaveBeenCalledTimes(2);
    expect(enqueuePreclaimedHeartbeat).toHaveBeenCalledTimes(1);
  });

  it.each([
    ["closed", "admission_closed"],
    ["authority_drift", "authority_drift"],
    ["lifecycle_drift", "lifecycle_drift"],
  ] as const)("durably abandons only pre-bind recovery closed by %s", async (reason, abandonReason) => {
    const plan = buildHeartbeatOccurrencePlan(CLAIM_INPUT);
    const occurrence = buildOccurrence(plan);
    const abandoned = { ...occurrence, state: "abandoned" as const, abandonmentReason: abandonReason };
    const find = vi.fn(() => abandoned);
    const service = new HeartbeatOccurrenceService(
      buildDeps({
        listRecoverablePage: vi.fn(() => ({ items: [occurrence] })),
        recoverSystemHeartbeatOccurrence: vi.fn(() => ({
          disposition: "closed_or_authority_drift" as const,
          reason,
        })),
        find,
      }),
    );

    await expect(service.recoverAll()).resolves.toMatchObject({ scanned: 1, closed: 1 });
    expect(find).toHaveBeenCalledWith(occurrence.occurrenceId);
  });

  it("fails closed when storage reports closed recovery without exact abandonment convergence", async () => {
    const plan = buildHeartbeatOccurrencePlan(CLAIM_INPUT);
    const occurrence = buildOccurrence(plan);
    const service = new HeartbeatOccurrenceService(
      buildDeps({
        listRecoverablePage: vi.fn(() => ({ items: [occurrence] })),
        recoverSystemHeartbeatOccurrence: vi.fn(() => ({
          disposition: "closed_or_authority_drift" as const,
          reason: "authority_drift" as const,
        })),
        find: vi.fn(() => ({ ...occurrence, state: "abandoned", abandonmentReason: "lifecycle_drift" })),
      }),
    );

    await expect(service.recoverAll()).rejects.toThrow(/abandonment evidence/u);
  });

  it("treats operator preemption after pre-bind reclaim as closed without enqueueing a child", async () => {
    const plan = buildHeartbeatOccurrencePlan(CLAIM_INPUT);
    const occurrence = buildOccurrence(plan);
    const abandoned = buildOccurrence(plan, {
      state: "abandoned",
      abandonmentReason: "authority_drift",
    });
    const enqueuePreclaimedHeartbeat = vi.fn(async () => true);
    const service = new HeartbeatOccurrenceService(
      buildDeps({
        listRecoverablePage: vi.fn(() => ({ items: [occurrence] })),
        recoverSystemHeartbeatOccurrence: vi.fn(() => ({
          disposition: "reclaimed" as const,
          admission: buildActiveAdmission(occurrence, plan),
        })),
        find: vi.fn(() => abandoned),
        enqueuePreclaimedHeartbeat,
      }),
    );

    await expect(service.recoverAll()).resolves.toMatchObject({ scanned: 1, closed: 1, reclaimed: 0 });
    expect(enqueuePreclaimedHeartbeat).not.toHaveBeenCalled();
  });

  it("does not swallow an unrelated enqueue failure when heartbeat authority is still active", async () => {
    const plan = buildHeartbeatOccurrencePlan(CLAIM_INPUT);
    const occurrence = buildOccurrence(plan);
    const enqueueFailure = new Error("child creation failed");
    const service = new HeartbeatOccurrenceService(
      buildDeps({
        listRecoverablePage: vi.fn(() => ({ items: [occurrence] })),
        recoverSystemHeartbeatOccurrence: vi.fn(() => ({
          disposition: "reclaimed" as const,
          admission: buildActiveAdmission(occurrence, plan),
        })),
        find: vi.fn(() => occurrence),
        enqueuePreclaimedHeartbeat: vi.fn(async () => {
          throw enqueueFailure;
        }),
      }),
    );

    await expect(service.recoverAll()).rejects.toBe(enqueueFailure);
  });

  it("validates and resumes a bound canonical run before terminal settlement", async () => {
    const plan = buildHeartbeatOccurrencePlan(CLAIM_INPUT);
    const occurrence = buildOccurrence(plan, {
      state: "durable_bound",
      boundDurableRunId: "hbr_child_1",
      capabilityProfileId: "profile-1",
      capabilityProfileHash: "9".repeat(64),
    });
    const order: string[] = [];
    const markDurableBound = vi.fn(() => {
      order.push("validate-bound");
      return { disposition: "replayed", occurrence } as const;
    });
    const recoverDurableRun = vi.fn(async () => {
      order.push("recover-run-finalizers");
    });
    const markTerminal = vi.fn(() => {
      order.push("settle-occurrence");
      return { disposition: "terminal", occurrence: { ...occurrence, state: "terminal" } } as const;
    });
    const service = new HeartbeatOccurrenceService(
      buildDeps({
        listRecoverablePage: vi.fn(() => ({ items: [occurrence] })),
        markDurableBound,
        markTerminal,
        recoverDurableRun,
        getDurableRun: vi.fn(() => ({ runId: occurrence.durableRunId, workflowKey: "chat.turn.execute" })),
      }),
    );

    await expect(service.recoverAll()).resolves.toMatchObject({ scanned: 1, terminal: 1 });
    expect(order).toEqual(["validate-bound", "recover-run-finalizers", "settle-occurrence"]);
  });

  it("treats operator preemption between bound replay validation and run recovery as closed", async () => {
    const plan = buildHeartbeatOccurrencePlan(CLAIM_INPUT);
    const occurrence = buildOccurrence(plan, {
      state: "durable_bound",
      boundDurableRunId: "hbr_child_1",
      capabilityProfileId: "profile-1",
      capabilityProfileHash: "9".repeat(64),
    });
    const abandoned = { ...occurrence, state: "abandoned" as const, abandonmentReason: "authority_drift" as const };
    const find = vi.fn().mockReturnValueOnce(occurrence).mockReturnValue(abandoned);
    const getDurableRun = vi.fn();
    const recoverDurableRun = vi.fn();
    const markTerminal = vi.fn();
    const service = new HeartbeatOccurrenceService(
      buildDeps({
        listRecoverablePage: vi.fn(() => ({ items: [occurrence] })),
        find,
        markDurableBound: vi.fn(() => ({ disposition: "replayed", occurrence })),
        getDurableRun,
        recoverDurableRun,
        markTerminal,
      }),
    );

    await expect(service.recoverAll()).resolves.toMatchObject({ scanned: 1, closed: 1, resumed: 0 });
    expect(getDurableRun).not.toHaveBeenCalled();
    expect(recoverDurableRun).not.toHaveBeenCalled();
    expect(markTerminal).not.toHaveBeenCalled();
  });

  it("treats operator preemption while bound run recovery awaits as closed without terminal replay", async () => {
    const plan = buildHeartbeatOccurrencePlan(CLAIM_INPUT);
    const occurrence = buildOccurrence(plan, {
      state: "durable_bound",
      boundDurableRunId: "hbr_child_1",
      capabilityProfileId: "profile-1",
      capabilityProfileHash: "9".repeat(64),
    });
    const abandoned = { ...occurrence, state: "abandoned" as const, abandonmentReason: "authority_drift" as const };
    let preempted = false;
    const find = vi.fn(() => (preempted ? abandoned : occurrence));
    const recoverDurableRun = vi.fn(async () => {
      preempted = true;
    });
    const markTerminal = vi.fn();
    const service = new HeartbeatOccurrenceService(
      buildDeps({
        listRecoverablePage: vi.fn(() => ({ items: [occurrence] })),
        find,
        markDurableBound: vi.fn(() => ({ disposition: "replayed", occurrence })),
        getDurableRun: vi.fn(() => ({ runId: occurrence.durableRunId, workflowKey: "chat.turn.execute" })),
        recoverDurableRun,
        markTerminal,
      }),
    );

    await expect(service.recoverAll()).resolves.toMatchObject({ scanned: 1, closed: 1, terminal: 0 });
    expect(recoverDurableRun).toHaveBeenCalledTimes(1);
    expect(markTerminal).not.toHaveBeenCalled();
  });

  it("fails closed before lease recovery when request, objective, or policy bytes drift", async () => {
    const plan = buildHeartbeatOccurrencePlan(CLAIM_INPUT);
    const occurrence = buildOccurrence(plan, { evaluatedPolicySha256: "f".repeat(64) });
    const recoverSystemHeartbeatOccurrence = vi.fn();
    const service = new HeartbeatOccurrenceService(
      buildDeps({ listRecoverablePage: vi.fn(() => ({ items: [occurrence] })), recoverSystemHeartbeatOccurrence }),
    );

    await expect(service.recoverAll()).rejects.toThrow(/material drifted/u);
    expect(recoverSystemHeartbeatOccurrence).not.toHaveBeenCalled();
  });

  it("exhausts cursor pages so more than 500 busy rows cannot starve a later reclaim", async () => {
    const plan = buildHeartbeatOccurrencePlan(CLAIM_INPUT);
    const occurrences = Array.from({ length: 501 }, (_, index) => {
      const suffix = String(index).padStart(4, "0");
      return buildOccurrence(plan, {
        occurrenceId: `hbo_${suffix}`,
        admissionId: `admission_${suffix}`,
        userMessageId: `hbu_${suffix}`,
        assistantMessageId: `hba_${suffix}`,
        turnId: `hbt_${suffix}`,
        durableRunId: `hbr_${suffix}`,
        updatedAt: "2026-07-15T19:00:00.000Z",
      });
    });
    const firstCursor = {
      updatedAt: occurrences[499]!.updatedAt,
      occurrenceId: occurrences[499]!.occurrenceId,
    };
    const listRecoverablePage = vi
      .fn()
      .mockReturnValueOnce({ items: occurrences.slice(0, 500), nextCursor: firstCursor })
      .mockReturnValueOnce({ items: [occurrences[500]!] });
    const recoverSystemHeartbeatOccurrence = vi.fn(({ occurrence }) =>
      occurrence.occurrenceId === occurrences[500]!.occurrenceId
        ? { disposition: "reclaimed" as const, admission: buildActiveAdmission(occurrence, plan) }
        : { disposition: "live" as const },
    );
    const enqueuePreclaimedHeartbeat = vi.fn(async () => true);
    const service = new HeartbeatOccurrenceService(
      buildDeps({ listRecoverablePage, recoverSystemHeartbeatOccurrence, enqueuePreclaimedHeartbeat }),
    );

    await expect(service.recoverAll()).resolves.toMatchObject({ scanned: 501, busy: 500, reclaimed: 1 });
    expect(listRecoverablePage).toHaveBeenNthCalledWith(1, { limit: 500 });
    expect(listRecoverablePage).toHaveBeenNthCalledWith(2, { limit: 500, after: firstCursor });
    expect(enqueuePreclaimedHeartbeat).toHaveBeenCalledTimes(1);
  });

  it("fails closed on a non-advancing recovery cursor", async () => {
    const plan = buildHeartbeatOccurrencePlan(CLAIM_INPUT);
    const occurrence = buildOccurrence(plan);
    const cursor = { updatedAt: occurrence.updatedAt, occurrenceId: occurrence.occurrenceId };
    const service = new HeartbeatOccurrenceService(
      buildDeps({
        listRecoverablePage: vi.fn(() => ({ items: [occurrence], nextCursor: cursor })),
        recoverSystemHeartbeatOccurrence: vi.fn(() => ({ disposition: "live" as const })),
      }),
    );

    await expect(service.recoverAll()).rejects.toThrow(/cursor did not advance/u);
  });

  it.each([
    [0, 1],
    [-8, 1],
    [1.9, 1],
    [501, 500],
    [Number.NaN, 500],
    [Number.POSITIVE_INFINITY, 500],
  ])("clamps recovery page size %s to the finite repository bound %s", async (requested, expected) => {
    const listRecoverablePage = vi.fn(() => ({ items: [] }));
    const service = new HeartbeatOccurrenceService(buildDeps({ listRecoverablePage }));

    await expect(service.recoverAll(requested, Number.NaN)).resolves.toMatchObject({ scanned: 0 });

    expect(listRecoverablePage).toHaveBeenCalledWith({ limit: expected });
  });

  it("bounds a sweep when recovery moves a previously seen row beyond the active cursor", async () => {
    const plan = buildHeartbeatOccurrencePlan(CLAIM_INPUT);
    const first = buildOccurrence(plan, {
      occurrenceId: "hbo-first",
      updatedAt: "2026-07-15T19:00:00.000Z",
    });
    const second = buildOccurrence(plan, {
      occurrenceId: "hbo-second",
      updatedAt: "2026-07-15T19:01:00.000Z",
    });
    const movedFirst = {
      ...first,
      updatedAt: "2026-07-15T19:02:00.000Z",
      revision: first.revision + 1,
    };
    const later = buildOccurrence(plan, {
      occurrenceId: "hbo-later",
      updatedAt: "2026-07-15T19:03:00.000Z",
    });
    const firstCursor = { updatedAt: first.updatedAt, occurrenceId: first.occurrenceId };
    const secondCursor = { updatedAt: second.updatedAt, occurrenceId: second.occurrenceId };
    const movedCursor = { updatedAt: movedFirst.updatedAt, occurrenceId: movedFirst.occurrenceId };
    const listRecoverablePage = vi
      .fn()
      .mockReturnValueOnce({ items: [first], nextCursor: firstCursor })
      .mockReturnValueOnce({ items: [second], nextCursor: secondCursor })
      .mockReturnValueOnce({ items: [movedFirst], nextCursor: movedCursor })
      .mockReturnValueOnce({ items: [later] });
    const recoverSystemHeartbeatOccurrence = vi.fn(() => ({ disposition: "live" as const }));
    const service = new HeartbeatOccurrenceService(
      buildDeps({ listRecoverablePage, recoverSystemHeartbeatOccurrence }),
    );

    await expect(service.recoverAll(1, 3)).resolves.toEqual({
      scanned: 2,
      parked: 0,
      busy: 2,
      reclaimed: 0,
      resumed: 0,
      terminal: 0,
      closed: 0,
      continuation: movedCursor,
    });
    expect(recoverSystemHeartbeatOccurrence.mock.calls.map(([input]) => input.occurrence.occurrenceId)).toEqual([
      "hbo-first",
      "hbo-second",
    ]);

    await expect(service.recoverAll(1, 3)).resolves.toMatchObject({ scanned: 1, busy: 1 });
    expect(listRecoverablePage).toHaveBeenNthCalledWith(4, { limit: 1, after: movedCursor });
    expect(recoverSystemHeartbeatOccurrence).toHaveBeenCalledTimes(3);
  });

  it("defers a concurrent row inserted behind the cursor until the next bounded sweep", async () => {
    const plan = buildHeartbeatOccurrencePlan(CLAIM_INPUT);
    const first = buildOccurrence(plan, {
      occurrenceId: "hbo-first",
      updatedAt: "2026-07-15T19:00:00.000Z",
    });
    const second = buildOccurrence(plan, {
      occurrenceId: "hbo-second",
      updatedAt: "2026-07-15T19:01:00.000Z",
    });
    const insertedBehind = buildOccurrence(plan, {
      occurrenceId: "hbo-inserted-behind",
      updatedAt: "2026-07-15T18:59:00.000Z",
    });
    const firstCursor = { updatedAt: first.updatedAt, occurrenceId: first.occurrenceId };
    const listRecoverablePage = vi
      .fn()
      .mockReturnValueOnce({ items: [first], nextCursor: firstCursor })
      .mockReturnValueOnce({ items: [second] })
      .mockReturnValueOnce({ items: [insertedBehind] });
    const recoverSystemHeartbeatOccurrence = vi.fn(() => ({ disposition: "live" as const }));
    const service = new HeartbeatOccurrenceService(
      buildDeps({ listRecoverablePage, recoverSystemHeartbeatOccurrence }),
    );

    await expect(service.recoverAll(2, 4)).resolves.toMatchObject({ scanned: 2, busy: 2 });
    expect(listRecoverablePage).toHaveBeenNthCalledWith(2, { limit: 2, after: firstCursor });

    await expect(service.recoverAll(2, 4)).resolves.toMatchObject({ scanned: 1, busy: 1 });
    expect(listRecoverablePage).toHaveBeenNthCalledWith(3, { limit: 2 });
    expect(recoverSystemHeartbeatOccurrence.mock.calls.map(([input]) => input.occurrence.occurrenceId)).toEqual([
      "hbo-first",
      "hbo-second",
      "hbo-inserted-behind",
    ]);
  });

  it("re-enters canonical recovery and observes exact terminal closure before operator retry", async () => {
    const plan = buildHeartbeatOccurrencePlan(CLAIM_INPUT);
    const bound = buildOccurrence(plan, {
      state: "durable_bound",
      boundDurableRunId: "hbr_child_1",
      capabilityProfileId: "profile-1",
      capabilityProfileHash: "9".repeat(64),
    });
    const terminal = buildOccurrence(plan, {
      ...bound,
      state: "terminal",
      terminalStatus: "completed",
    });
    let currentOccurrence = bound;
    let currentAdmission = buildAdmissionRecord(bound);
    const recoverDurableRun = vi.fn(async () => {
      currentAdmission = {
        ...currentAdmission,
        status: "completed",
        terminalAuthorityKind: "durable_terminal",
        terminalDurableRunId: bound.durableRunId,
        terminalDurableRunStatus: "completed",
      };
    });
    const markTerminal = vi.fn(() => {
      currentOccurrence = terminal;
      return { disposition: "terminal" as const, occurrence: terminal };
    });
    const recordRecoveryDiagnostic = vi.fn();
    const service = new HeartbeatOccurrenceService(
      buildDeps({
        find: vi.fn(() => currentOccurrence),
        getAdmission: vi.fn(() => currentAdmission),
        markDurableBound: vi.fn(() => ({ disposition: "replayed" as const, occurrence: bound })),
        markTerminal,
        recoverDurableRun,
        getDurableRun: vi.fn(() => ({ runId: bound.durableRunId, workflowKey: "chat.turn.execute" })),
        recordRecoveryDiagnostic,
      }),
    );

    await expect(
      service.recoverDecisionCommittedForOperatorPreemption(decisionCommittedIdentity(bound)),
    ).resolves.toBeUndefined();

    expect(recoverDurableRun).toHaveBeenCalledOnce();
    expect(markTerminal).toHaveBeenCalledOnce();
    expect(recordRecoveryDiagnostic).toHaveBeenCalledWith(
      expect.objectContaining({
        level: "info",
        recoveryOutcome: "retrying",
        remainingBudgetMs: expect.any(Number),
        identity: expect.objectContaining({ durableRunId: bound.durableRunId }),
      }),
    );
    expect(recordRecoveryDiagnostic).toHaveBeenCalledWith(
      expect.objectContaining({
        level: "info",
        recoveryOutcome: "recovered",
        remainingBudgetMs: expect.any(Number),
      }),
    );
  });

  it("fails closed when canonical recovery rejects decision evidence after the storage outcome", async () => {
    const plan = buildHeartbeatOccurrencePlan(CLAIM_INPUT);
    const bound = buildOccurrence(plan, {
      state: "durable_bound",
      boundDurableRunId: "hbr_child_1",
      capabilityProfileId: "profile-1",
      capabilityProfileHash: "9".repeat(64),
    });
    const markTerminal = vi.fn();
    const service = new HeartbeatOccurrenceService(
      buildDeps({
        find: vi.fn(() => bound),
        getAdmission: vi.fn(() => buildAdmissionRecord(bound)),
        markDurableBound: vi.fn(() => ({ disposition: "replayed" as const, occurrence: bound })),
        markTerminal,
        recoverDurableRun: vi.fn(async () => {
          throw new Error("System heartbeat recovery has invalid decision evidence.");
        }),
        getDurableRun: vi.fn(() => ({ runId: bound.durableRunId, workflowKey: "chat.turn.execute" })),
      }),
    );

    await expect(
      service.recoverDecisionCommittedForOperatorPreemption(decisionCommittedIdentity(bound)),
    ).rejects.toThrow(/could not complete canonical recovery/u);
    expect(markTerminal).not.toHaveBeenCalled();
  });

  it("bounds a still-running canonical recovery and leaves durable processing requested", async () => {
    vi.useFakeTimers();
    const plan = buildHeartbeatOccurrencePlan(CLAIM_INPUT);
    const bound = buildOccurrence(plan, {
      state: "durable_bound",
      boundDurableRunId: "hbr_child_1",
      capabilityProfileId: "profile-1",
      capabilityProfileHash: "9".repeat(64),
    });
    const recoverDurableRun = vi.fn(async () => undefined);
    const service = new HeartbeatOccurrenceService(
      buildDeps({
        find: vi.fn(() => bound),
        getAdmission: vi.fn(() => buildAdmissionRecord(bound)),
        markDurableBound: vi.fn(() => ({ disposition: "replayed" as const, occurrence: bound })),
        markTerminal: vi.fn(() => ({ disposition: "still_bound" as const, occurrence: bound })),
        recoverDurableRun,
        getDurableRun: vi.fn(() => ({ runId: bound.durableRunId, workflowKey: "chat.turn.execute" })),
      }),
    );

    const result = expect(
      service.recoverDecisionCommittedForOperatorPreemption(decisionCommittedIdentity(bound)),
    ).rejects.toThrow(/still completing canonical recovery/u);
    await vi.advanceTimersByTimeAsync(2_100);
    await result;
    expect(recoverDurableRun).toHaveBeenCalled();
  });
});

function buildDeps(
  overrides: Partial<{
    claim: ReturnType<typeof vi.fn>;
    listRecoverablePage: ReturnType<typeof vi.fn>;
    findUnresolved: ReturnType<typeof vi.fn>;
    markDurableBound: ReturnType<typeof vi.fn>;
    markTerminal: ReturnType<typeof vi.fn>;
    find: ReturnType<typeof vi.fn>;
    admitSystemHeartbeatOccurrence: ReturnType<typeof vi.fn>;
    recoverSystemHeartbeatOccurrence: ReturnType<typeof vi.fn>;
    abandonAdmittedHeartbeatForExecutionDisabled: ReturnType<typeof vi.fn>;
    enqueuePreclaimedHeartbeat: ReturnType<typeof vi.fn>;
    getDurableRun: ReturnType<typeof vi.fn>;
    recoverDurableRun: ReturnType<typeof vi.fn>;
    getAdmission: ReturnType<typeof vi.fn>;
    canEnqueueHeartbeat: () => boolean;
    recordRecoveryDiagnostic: ReturnType<typeof vi.fn>;
  }> = {},
): HeartbeatOccurrenceServiceDeps {
  return {
    storage: {
      heartbeatOccurrences: {
        claimWithAdmission: overrides.claim ?? vi.fn(() => ({ disposition: "not_due", reason: "interval" })),
        find: overrides.find ?? vi.fn(),
        listRecoverablePage: overrides.listRecoverablePage ?? vi.fn(() => ({ items: [] })),
        findUnresolved: overrides.findUnresolved ?? vi.fn(),
        markDurableBound: overrides.markDurableBound ?? vi.fn(),
        markTerminal: overrides.markTerminal ?? vi.fn(),
      },
      sessionMutationAdmissions: {
        get: overrides.getAdmission ?? vi.fn(),
        abandonAdmittedHeartbeatForExecutionDisabled: overrides.abandonAdmittedHeartbeatForExecutionDisabled ?? vi.fn(),
      },
    } as unknown as HeartbeatOccurrenceServiceDeps["storage"],
    sessionControlRuntimeOwner: {
      admitSystemHeartbeatOccurrence: overrides.admitSystemHeartbeatOccurrence ?? vi.fn(),
      recoverSystemHeartbeatOccurrence: overrides.recoverSystemHeartbeatOccurrence ?? vi.fn(),
    },
    canEnqueueHeartbeat: overrides.canEnqueueHeartbeat ?? (() => true),
    enqueuePreclaimedHeartbeat: overrides.enqueuePreclaimedHeartbeat ?? vi.fn(async () => false),
    getDurableRun: overrides.getDurableRun ?? vi.fn(() => ({ runId: "hbr_child_1", workflowKey: "chat.turn.execute" })),
    recoverDurableRun: overrides.recoverDurableRun ?? vi.fn(async () => undefined),
    recordRecoveryDiagnostic: overrides.recordRecoveryDiagnostic,
  } as unknown as HeartbeatOccurrenceServiceDeps;
}

function decisionCommittedIdentity(occurrence: HeartbeatOccurrenceRecord) {
  return {
    workspaceId: occurrence.workspaceId,
    sessionId: occurrence.sessionId,
    sessionIncarnationId: occurrence.sessionIncarnationId,
    turnId: occurrence.turnId,
    occurrenceId: occurrence.occurrenceId,
    heartbeatAdmissionId: occurrence.admissionId,
    durableRunId: occurrence.durableRunId,
  };
}

function buildOccurrence(
  plan: ReturnType<typeof buildHeartbeatOccurrencePlan>,
  patch: Partial<HeartbeatOccurrenceRecord> = {},
): HeartbeatOccurrenceRecord {
  return {
    occurrenceId: "hbo_occurrence_1",
    workspaceId: CLAIM_INPUT.workspaceId,
    sessionId: CLAIM_INPUT.sessionId,
    sessionIncarnationId: "incarnation-1",
    admissionId: "admission-1",
    admissionRequestSha256: "8".repeat(64),
    admissionIdempotencyKey: "heartbeat-admission:hbo_occurrence_1",
    admissionCorrelationId: "hbo_occurrence_1",
    runtimeOwnerId: "hbro_runtime_1",
    systemActorId: "system-heartbeat",
    admissionMaterialSha256: plan.frozenRequestSha256,
    evaluatedPolicySha256: plan.evaluatedPolicySha256,
    frozenRequestSha256: plan.frozenRequestSha256,
    frozenObjectiveSha256: plan.frozenObjectiveSha256,
    claimSha256: "7".repeat(64),
    aggregateRevision: 4,
    controllerGeneration: 2,
    priorCadence: { ...CLAIM_INPUT.expectedPriorCadence },
    heartbeatIntervalSeconds: 3600,
    cooldownSeconds: 300,
    idleFloorSeconds: CLAIM_INPUT.idleFloorSeconds,
    observedSessionActivityAt: "2026-07-15T17:00:00.000Z",
    userMessageId: "hbu_child_1",
    assistantMessageId: "hba_child_1",
    turnId: "hbt_child_1",
    durableRunId: "hbr_child_1",
    state: "admitted",
    revision: 1,
    claimedAt: "2026-07-15T19:00:00.000Z",
    updatedAt: "2026-07-15T19:00:00.000Z",
    ...patch,
  };
}

function buildAdmissionRecord(occurrence: HeartbeatOccurrenceRecord): SessionMutationAdmissionRecord {
  return {
    admissionId: occurrence.admissionId,
    sessionIncarnationId: occurrence.sessionIncarnationId,
    workspaceId: occurrence.workspaceId,
    sessionId: occurrence.sessionId,
    turnId: occurrence.turnId,
    runtimeOwnerId: occurrence.runtimeOwnerId,
    runtimeLeaseRevision: 1,
    admissionKind: "turn_write",
    aggregateRevision: occurrence.aggregateRevision,
    controllerGeneration: occurrence.controllerGeneration,
    actorKind: "system",
    actorId: "system-heartbeat",
    operation: "chat_system_heartbeat",
    materialSha256: occurrence.frozenRequestSha256,
    status: "active",
    idempotencyKey: occurrence.admissionIdempotencyKey,
    requestSha256: occurrence.admissionRequestSha256,
    correlationId: occurrence.admissionCorrelationId,
    createdAt: occurrence.claimedAt,
  };
}

function buildActiveAdmission(
  occurrence: HeartbeatOccurrenceRecord,
  plan: ReturnType<typeof buildHeartbeatOccurrencePlan>,
) {
  return {
    identity: {
      admissionId: occurrence.admissionId,
      sessionIncarnationId: occurrence.sessionIncarnationId,
      workspaceId: occurrence.workspaceId,
      sessionId: occurrence.sessionId,
      turnId: occurrence.turnId,
      aggregateRevision: occurrence.aggregateRevision,
      controllerGeneration: occurrence.controllerGeneration,
      materialSha256: occurrence.frozenRequestSha256,
    },
    admittedRequest: plan.request,
    requestActor: { actorKind: "system" as const, actorId: "system-heartbeat" },
    requestClaim: { runtimeOwnerId: occurrence.runtimeOwnerId, leaseRevision: 1 },
  };
}

function buildAdmissionRequest(occurrence: HeartbeatOccurrenceRecord): HeartbeatOccurrenceAdmissionRequest {
  return {
    occurrenceId: occurrence.occurrenceId,
    claimSha256: occurrence.claimSha256,
    claimedAt: occurrence.claimedAt,
    child: {
      userMessageId: occurrence.userMessageId,
      assistantMessageId: occurrence.assistantMessageId,
      turnId: occurrence.turnId,
      durableRunId: occurrence.durableRunId,
    },
    admissionInput: {
      workspaceId: occurrence.workspaceId,
      sessionId: occurrence.sessionId,
      expectedSessionIncarnationId: occurrence.sessionIncarnationId,
      turnId: occurrence.turnId,
      runtimeOwnerId: occurrence.runtimeOwnerId,
      admissionKind: "turn_write",
      aggregateRevision: occurrence.aggregateRevision,
      controllerGeneration: occurrence.controllerGeneration,
      actorKind: "system",
      actorId: "system-heartbeat",
      operation: "chat_system_heartbeat",
      materialSha256: occurrence.frozenRequestSha256,
      idempotencyKey: occurrence.admissionIdempotencyKey,
      correlationId: occurrence.admissionCorrelationId,
    },
  };
}
