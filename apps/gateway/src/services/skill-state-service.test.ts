import { describe, expect, it, vi } from "vitest";
import { ConflictError } from "@goatcitadel/contracts";
import { SkillStateService, type SkillStateServiceCtx, type SkillStateServiceHost } from "./skill-state-service.js";

interface FakeSqlCall {
  sql: string;
  params: Record<string, unknown>;
}

function throwWriteConflict(
  resourceKind: string,
  resourceId: string,
  expectedRevision: number,
  currentRevision: number,
): never {
  throw new ConflictError({
    code: "WRITE_CONFLICT",
    message: `${resourceKind} ${resourceId} changed since revision ${expectedRevision}`,
    details: { resourceKind, resourceId, expectedRevision, currentRevision },
  });
}

function createHarness(options?: {
  rows?: Array<Record<string, unknown>>;
  settings?: Record<string, unknown>;
  listSkills?: Array<{ skillId: string }>;
}) {
  const runs: FakeSqlCall[] = [];
  const settings = new Map<string, unknown>(Object.entries(options?.settings ?? {}));
  const revisions = new Map<string, number>();
  let selectRows = options?.rows ?? [];
  const gatewaySql = {
    prepare: (sql: string) => ({
      all: () => selectRows,
      run: (params: Record<string, unknown>) => {
        runs.push({ sql, params });
        if (sql.includes("INSERT INTO skill_state")) {
          const skillId = String(params.skillId);
          const existing = selectRows.find((row) => row.skillId === skillId);
          if (!existing) {
            selectRows.push({
              skillId,
              state: params.state,
              note: params.note,
              updatedAt: params.updatedAt,
              firstAutoApprovedAt: null,
            });
          } else if (sql.includes("DO UPDATE")) {
            existing.state = params.state;
            existing.note = params.note;
            existing.updatedAt = params.updatedAt;
          }
        }
        return { changes: 1 };
      },
    }),
  };
  const systemSettings = {
    get: vi.fn(<T>(key: string) => (settings.has(key) ? { value: settings.get(key) as T } : undefined)),
    set: vi.fn((key: string, value: unknown) => {
      settings.set(key, value);
    }),
  };
  const host: SkillStateServiceHost = {
    listSkills: () => options?.listSkills ?? [{ skillId: "skill-a" }],
    recordAutonomousMutation: vi.fn(),
    recordDevDiagnostic: vi.fn(),
  };
  const skillAggregateRevisions = {
    ensure: (aggregateKind: string, aggregateId: string, now = "2026-07-01T00:00:00.000Z") => {
      const key = `${aggregateKind}\u0000${aggregateId}`;
      const revision = revisions.get(key) ?? 1;
      revisions.set(key, revision);
      return { aggregateKind, aggregateId, revision, createdAt: now, updatedAt: now };
    },
    runWithRevision: <T>(
      aggregateKind: string,
      aggregateId: string,
      expectedRevision: number,
      mutation: () => { value: T; changed: boolean },
    ) => {
      const current = skillAggregateRevisions.ensure(aggregateKind, aggregateId);
      if (current.revision !== expectedRevision) {
        throwWriteConflict(aggregateKind, aggregateId, expectedRevision, current.revision);
      }
      const result = mutation();
      const revision = result.changed ? expectedRevision + 1 : expectedRevision;
      revisions.set(`${aggregateKind}\u0000${aggregateId}`, revision);
      return { ...result, revision };
    },
    runWithRevisions: <T>(
      expectations: Array<{ aggregateKind: string; aggregateId: string; expectedRevision: number }>,
      mutation: () => { value: T; changed: boolean },
    ) => {
      for (const expectation of expectations) {
        const current = skillAggregateRevisions.ensure(expectation.aggregateKind, expectation.aggregateId);
        if (current.revision !== expectation.expectedRevision) {
          throwWriteConflict(
            expectation.aggregateKind,
            expectation.aggregateId,
            expectation.expectedRevision,
            current.revision,
          );
        }
      }
      const result = mutation();
      const revisionRecords = expectations.map((expectation) => {
        const revision = result.changed ? expectation.expectedRevision + 1 : expectation.expectedRevision;
        revisions.set(`${expectation.aggregateKind}\u0000${expectation.aggregateId}`, revision);
        return { ...expectation, revision, createdAt: "test", updatedAt: "test" };
      });
      return { ...result, revisions: revisionRecords };
    },
  };
  const service = new SkillStateService(
    { gatewaySql, systemSettings, skillAggregateRevisions } as unknown as SkillStateServiceCtx,
    host,
  );
  return {
    service,
    runs,
    settings,
    systemSettings,
    host,
    setRows: (rows: Array<Record<string, unknown>>) => {
      selectRows = rows;
    },
    revisions,
  };
}

describe("SkillStateService", () => {
  it("returns clamped defaults for the activation policy and persists updates", () => {
    const harness = createHarness();

    expect(harness.service.getActivationPolicy()).toEqual({
      revision: 1,
      guardedAutoThreshold: 0.72,
      requireFirstUseConfirmation: true,
    });

    const updated = harness.service.updateActivationPolicy({ guardedAutoThreshold: 4 }, 1);
    expect(updated.revision).toBe(2);
    expect(updated.guardedAutoThreshold).toBe(1);
    expect(harness.systemSettings.set).toHaveBeenCalledWith("skill_activation_policy_v1", {
      guardedAutoThreshold: 1,
      requireFirstUseConfirmation: true,
    });
    expect(harness.service.getActivationPolicy()).toEqual(updated);

    const noOp = harness.service.updateActivationPolicy({ guardedAutoThreshold: 1 }, updated.revision);
    expect(noOp.revision).toBe(updated.revision);
    expect(() => harness.service.updateActivationPolicy({ guardedAutoThreshold: 0.5 }, 1)).toThrow(
      /changed since revision 1/,
    );
  });

  it("merges sanitized usage metadata into skill-state rows and drops malformed rows", () => {
    const harness = createHarness({
      rows: [
        {
          skillId: "skill-a",
          state: "enabled",
          note: null,
          updatedAt: "2026-07-01T00:00:00.000Z",
          firstAutoApprovedAt: null,
        },
        { skillId: 42, state: "enabled" }, // malformed — filtered out
      ],
      settings: {
        skill_state_metadata_v1: {
          "skill-a": { pinned: true, usageCount: 3, lastUsedAt: "2026-07-02T00:00:00.000Z" },
          "skill-b": "not-an-object",
        },
      },
    });

    const states = harness.service.readSkillStates();
    expect([...states.keys()]).toEqual(["skill-a"]);
    expect(states.get("skill-a")).toMatchObject({ pinned: true, usageCount: 3 });
  });

  it("rejects unknown skills and pinned-state changes, and records the activation event on success", () => {
    const harness = createHarness({ listSkills: [{ skillId: "skill-a" }] });
    harness.setRows([
      {
        skillId: "skill-a",
        state: "enabled",
        note: null,
        updatedAt: "2026-07-01T00:00:00.000Z",
        firstAutoApprovedAt: null,
      },
    ]);

    expect(() => harness.service.setSkillState("skill-missing", "sleep", undefined, 1)).toThrow(/not found/);

    harness.settings.set("skill_state_metadata_v1", { "skill-a": { pinned: true } });
    expect(() => harness.service.setSkillState("skill-a", "disabled", undefined, 1)).toThrow(/Pinned skill/);

    harness.settings.set("skill_state_metadata_v1", {});
    const updated = harness.service.setSkillState("skill-a", "sleep", "  resting  ", 1);
    expect(updated.skillId).toBe("skill-a");
    expect(updated).toMatchObject({ state: "sleep", note: "resting", revision: 2 });
    expect(harness.runs.some((call) => call.sql.includes("INSERT INTO skill_state"))).toBe(true);
    const eventInsert = harness.runs.find((call) => call.sql.includes("skill_activation_events"));
    expect(eventInsert?.params).toMatchObject({ skillId: "skill-a", eventType: "state_updated" });
    expect(JSON.parse(String(eventInsert?.params.payloadJson))).toEqual({ state: "sleep", note: "resting" });

    const eventCount = harness.runs.filter((call) => call.sql.includes("skill_activation_events")).length;
    const noOp = harness.service.setSkillState("skill-a", "sleep", "resting", updated.revision);
    expect(noOp.revision).toBe(updated.revision);
    expect(harness.runs.filter((call) => call.sql.includes("skill_activation_events"))).toHaveLength(eventCount);
  });

  it("applies bulk state writes deterministically and fences every aggregate before mutation", () => {
    const harness = createHarness({
      listSkills: [{ skillId: "skill-b" }, { skillId: "skill-a" }],
      rows: [
        {
          skillId: "skill-a",
          state: "enabled",
          note: null,
          updatedAt: "2026-07-01T00:00:00.000Z",
          firstAutoApprovedAt: null,
        },
        {
          skillId: "skill-b",
          state: "enabled",
          note: null,
          updatedAt: "2026-07-01T00:00:00.000Z",
          firstAutoApprovedAt: null,
        },
      ],
    });

    const updated = harness.service.bulkSetSkillState(["skill-b", "skill-a", "skill-b"], "disabled", "bulk", {
      "skill-a": 1,
      "skill-b": 1,
    });
    expect(updated.map((item) => [item.skillId, item.revision])).toEqual([
      ["skill-a", 2],
      ["skill-b", 2],
    ]);

    expect(() =>
      harness.service.bulkSetSkillState(["skill-a", "skill-b"], "enabled", undefined, {
        "skill-a": 2,
        "skill-b": 1,
      }),
    ).toThrow(/skill-b changed since revision 1/);
    expect(harness.service.readSkillStates().get("skill-a")).toMatchObject({ state: "disabled", revision: 2 });

    const noOp = harness.service.bulkSetSkillState(["skill-a", "skill-b"], "disabled", "bulk", {
      "skill-a": 2,
      "skill-b": 2,
    });
    expect(noOp.map((item) => item.revision)).toEqual([2, 2]);
  });

  it("captures curator idle snapshots best-effort and restores through setSkillState", () => {
    const harness = createHarness({
      rows: [
        {
          skillId: "skill-a",
          state: "enabled",
          note: "keep",
          updatedAt: "2026-07-01T00:00:00.000Z",
          firstAutoApprovedAt: null,
        },
      ],
    });

    harness.service.captureCuratorIdleSnapshot("skill-a");
    expect(harness.host.recordAutonomousMutation).toHaveBeenCalledWith(
      expect.objectContaining({ kind: "curator_archive", targetKey: "skill-a" }),
    );
    expect(harness.settings.get("curator_idle_skill_snapshot_v1:skill-a")).toMatchObject({
      skillId: "skill-a",
      priorState: "enabled",
    });

    expect(harness.service.restoreCuratorIdleSnapshot("skill-missing")).toBe(false);
    expect(harness.service.restoreCuratorIdleSnapshot("skill-a")).toBe(true);

    // A snapshot failure is swallowed and reported as a diagnostic, never thrown.
    const failing = createHarness();
    failing.systemSettings.set.mockImplementationOnce(() => {
      throw new Error("settings offline");
    });
    expect(() => failing.service.captureCuratorIdleSnapshot("skill-a")).not.toThrow();
    expect(failing.host.recordDevDiagnostic).toHaveBeenCalledWith(
      expect.objectContaining({ event: "curator_idle_snapshot_failed" }),
    );
  });

  it("increments usage metadata only for non-blank skill ids", () => {
    const harness = createHarness({
      settings: { skill_state_metadata_v1: { "skill-a": { usageCount: 1 } } },
    });

    harness.service.recordSkillUsage(["skill-a", "skill-a", " ", "skill-b"]);

    const written = harness.settings.get("skill_state_metadata_v1") as Record<
      string,
      { usageCount?: number; lastUsedAt?: string }
    >;
    expect(written["skill-a"]?.usageCount).toBe(2);
    expect(written["skill-b"]?.usageCount).toBe(1);
    expect(Object.keys(written)).not.toContain(" ");

    harness.systemSettings.set.mockClear();
    harness.service.recordSkillUsage([" ", ""]);
    expect(harness.systemSettings.set).not.toHaveBeenCalled();
  });
});
