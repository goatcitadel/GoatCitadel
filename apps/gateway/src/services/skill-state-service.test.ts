import { describe, expect, it, vi } from "vitest";
import { SkillStateService, type SkillStateServiceCtx, type SkillStateServiceHost } from "./skill-state-service.js";

interface FakeSqlCall {
  sql: string;
  params: Record<string, unknown>;
}

function createHarness(options?: {
  rows?: Array<Record<string, unknown>>;
  settings?: Record<string, unknown>;
  listSkills?: Array<{ skillId: string }>;
}) {
  const runs: FakeSqlCall[] = [];
  const settings = new Map<string, unknown>(Object.entries(options?.settings ?? {}));
  let selectRows = options?.rows ?? [];
  const gatewaySql = {
    prepare: (sql: string) => ({
      all: () => selectRows,
      run: (params: Record<string, unknown>) => {
        runs.push({ sql, params });
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
  const service = new SkillStateService({ gatewaySql, systemSettings } as unknown as SkillStateServiceCtx, host);
  return {
    service,
    runs,
    settings,
    systemSettings,
    host,
    setRows: (rows: Array<Record<string, unknown>>) => {
      selectRows = rows;
    },
  };
}

describe("SkillStateService", () => {
  it("returns clamped defaults for the activation policy and persists updates", () => {
    const harness = createHarness();

    expect(harness.service.getActivationPolicy()).toEqual({
      guardedAutoThreshold: 0.72,
      requireFirstUseConfirmation: true,
    });

    const updated = harness.service.updateActivationPolicy({ guardedAutoThreshold: 4 });
    expect(updated.guardedAutoThreshold).toBe(1);
    expect(harness.systemSettings.set).toHaveBeenCalledWith("skill_activation_policy_v1", updated);
    expect(harness.service.getActivationPolicy()).toEqual(updated);
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

    expect(() => harness.service.setSkillState("skill-missing", "sleep")).toThrow(/Unknown skill/);

    harness.settings.set("skill_state_metadata_v1", { "skill-a": { pinned: true } });
    expect(() => harness.service.setSkillState("skill-a", "disabled")).toThrow(/Pinned skill/);

    harness.settings.set("skill_state_metadata_v1", {});
    const updated = harness.service.setSkillState("skill-a", "sleep", "  resting  ");
    expect(updated.skillId).toBe("skill-a");
    expect(harness.runs.some((call) => call.sql.includes("INSERT INTO skill_state"))).toBe(true);
    const eventInsert = harness.runs.find((call) => call.sql.includes("skill_activation_events"));
    expect(eventInsert?.params).toMatchObject({ skillId: "skill-a", eventType: "state_updated" });
    expect(JSON.parse(String(eventInsert?.params.payloadJson))).toEqual({ state: "sleep", note: "resting" });
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
