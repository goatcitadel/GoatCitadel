import type { MemoryMaintenancePolicyRecord } from "@goatcitadel/contracts";
import { describe, expect, it } from "vitest";

import {
  buildMemoryMaintenancePolicyPatch,
  describeQmdImpact,
  formatBytes,
  formatMaybeDateTime,
  formatShortDateTime,
  formatTokenDelta,
  pickLatestTimestamp,
  shortId,
  summarizeMemorySubspaces,
  toMemoryMaintenancePolicyDraft,
  topLevelArea,
  type MemoryMaintenancePolicyDraft,
} from "./memory-helpers";

function policy(overrides: Partial<MemoryMaintenancePolicyRecord> = {}): MemoryMaintenancePolicyRecord {
  return {
    workspaceId: "default",
    enabled: true,
    runMode: "scheduled",
    timingStrategy: "fixed",
    schedule: { frequency: "weekly", hour: 4, minute: 30, weekday: 2 },
    timeZone: "America/Los_Angeles",
    minHoursSinceLastSuccess: 12,
    minChangedSessions: 3,
    providerId: "openai",
    model: "gpt-5.4",
    executionTarget: "local",
    unavailableModelPolicy: "skip",
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-02T00:00:00.000Z",
    ...overrides,
  };
}

describe("memory helpers", () => {
  it("normalizes memory paths and summarizes memory subspaces by size", () => {
    expect(topLevelArea("memory\\workspace\\one.md")).toBe("memory");
    expect(topLevelArea("")).toBe("(root)");

    expect(pickLatestTimestamp(undefined, "2026-01-02T00:00:00.000Z")).toBe("2026-01-02T00:00:00.000Z");
    expect(pickLatestTimestamp("2026-01-03T00:00:00.000Z", undefined)).toBe("2026-01-03T00:00:00.000Z");
    expect(pickLatestTimestamp("2026-01-01T00:00:00.000Z", "2026-01-04T00:00:00.000Z")).toBe(
      "2026-01-04T00:00:00.000Z",
    );

    const summaries = summarizeMemorySubspaces([
      { relativePath: "notes/outside.md", size: 9999, modifiedAt: "2026-01-01T00:00:00.000Z" },
      { relativePath: "memory/workspace/a.md", size: 100, modifiedAt: "2026-01-02T00:00:00.000Z" },
      { relativePath: "memory/workspace/b.md", size: 600, modifiedAt: "2026-01-04T00:00:00.000Z" },
      { relativePath: "memory/user/c.md", size: 300, modifiedAt: "2026-01-03T00:00:00.000Z" },
      { relativePath: "memory/", size: 50, modifiedAt: "2026-01-05T00:00:00.000Z" },
    ]);

    expect(summaries.map((summary) => [summary.area, summary.totalBytes, summary.latestModifiedAt])).toEqual([
      ["memory/workspace", 700, "2026-01-04T00:00:00.000Z"],
      ["memory/user", 300, "2026-01-03T00:00:00.000Z"],
      ["memory/(root)", 50, "2026-01-05T00:00:00.000Z"],
    ]);
  });

  it("formats storage, QMD, token, date, and identifier labels", () => {
    expect(formatBytes(512)).toBe("512 B");
    expect(formatBytes(2048)).toBe("2.00 KB");
    expect(formatBytes(3 * 1024 * 1024)).toBe("3.00 MB");
    expect(formatBytes(4 * 1024 * 1024 * 1024)).toBe("4.00 GB");

    expect(describeQmdImpact({ efficiencyLabel: "reduced", compressionPercent: 12.34, expansionPercent: 0 })).toBe(
      "Reduced 12.3%",
    );
    expect(describeQmdImpact({ efficiencyLabel: "expanded", compressionPercent: 0, expansionPercent: 6.78 })).toBe(
      "Grew 6.8%",
    );
    expect(describeQmdImpact({ efficiencyLabel: "neutral", compressionPercent: 0, expansionPercent: 0 })).toBe(
      "Stable",
    );

    expect(formatTokenDelta(10.4)).toBe("+10 tokens");
    expect(formatTokenDelta(-10.6)).toBe("-11 tokens");
    expect(formatTokenDelta(0)).toBe("no change");
    expect(formatMaybeDateTime()).toBe("-");
    expect(formatMaybeDateTime("2026-01-02T03:04:00.000Z")).not.toBe("-");
    expect(formatShortDateTime("2026-01-02T03:04:00.000Z")).toContain("Jan");
    expect(shortId("abc", 6)).toBe("abc");
    expect(shortId("abcdefghijklmnop", 6)).toBe("abcdef...");
  });

  it("converts policy records to editable drafts and back to API patches", () => {
    const draft = toMemoryMaintenancePolicyDraft(policy());
    expect(draft).toMatchObject({
      enabled: true,
      runMode: "scheduled",
      scheduleEnabled: true,
      scheduleFrequency: "weekly",
      scheduleWeekday: 2,
      providerId: "openai",
      model: "gpt-5.4",
    });

    const fallbackScheduleDraft = toMemoryMaintenancePolicyDraft(policy({ schedule: undefined, runMode: "manual" }));
    expect(fallbackScheduleDraft).toMatchObject({
      scheduleEnabled: false,
      scheduleFrequency: "daily",
      scheduleHour: 3,
      scheduleMinute: 0,
      scheduleWeekday: 1,
    });

    const weeklyPatch = buildMemoryMaintenancePolicyPatch({
      ...draft,
      providerId: " ",
      model: "",
      timeZone: " UTC ",
      scheduleFrequency: "weekly",
      scheduleWeekday: 5,
    });
    expect(weeklyPatch).toEqual({
      enabled: true,
      runMode: "scheduled",
      timingStrategy: "fixed",
      timeZone: "UTC",
      minHoursSinceLastSuccess: 12,
      minChangedSessions: 3,
      providerId: null,
      model: null,
      executionTarget: "local",
      unavailableModelPolicy: "skip",
      schedule: { frequency: "weekly", hour: 4, minute: 30, weekday: 5 },
    });

    const manualPatch = buildMemoryMaintenancePolicyPatch({
      ...fallbackScheduleDraft,
      timeZone: "America/New_York",
      runMode: "manual",
    } satisfies MemoryMaintenancePolicyDraft);
    expect(manualPatch.schedule).toBeNull();
  });
});
