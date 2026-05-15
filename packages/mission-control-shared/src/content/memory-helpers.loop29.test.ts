import { describe, expect, it, vi } from "vitest";
import {
  buildMemoryMaintenancePolicyPatch,
  describeQmdImpact,
  formatBytes,
  formatMaybeDateTime,
  formatTokenDelta,
  pickLatestTimestamp,
  shortId,
  summarizeMemorySubspaces,
  toMemoryMaintenancePolicyDraft,
  topLevelArea,
  type MemoryMaintenancePolicyDraft,
} from "./memory-helpers";

const baseDraft: MemoryMaintenancePolicyDraft = {
  enabled: true,
  runMode: "manual",
  timingStrategy: "fixed",
  timeZone: "America/Los_Angeles",
  minHoursSinceLastSuccess: 24,
  minChangedSessions: 1,
  providerId: "",
  model: "",
  executionTarget: "auto",
  unavailableModelPolicy: "skip",
  scheduleEnabled: false,
  scheduleFrequency: "daily",
  scheduleHour: 3,
  scheduleMinute: 0,
  scheduleWeekday: 1,
};

describe("memory helper loop 29 branch tails", () => {
  it("summarizes paths, sizes, timestamps, and identifiers across omitted/default inputs", () => {
    expect(topLevelArea("")).toBe("(root)");
    expect(topLevelArea("memory\\workspace\\note.md")).toBe("memory");
    expect(pickLatestTimestamp(undefined, "2026-05-01T00:00:00.000Z")).toBe("2026-05-01T00:00:00.000Z");
    expect(pickLatestTimestamp("2026-05-02T00:00:00.000Z", undefined)).toBe("2026-05-02T00:00:00.000Z");
    expect(pickLatestTimestamp("2026-05-02T00:00:00.000Z", "2026-05-03T00:00:00.000Z")).toBe(
      "2026-05-03T00:00:00.000Z",
    );
    expect(
      summarizeMemorySubspaces([
        { relativePath: "logs/ignore.txt", size: 100, modifiedAt: "2026-05-01T00:00:00.000Z" },
      ]),
    ).toEqual([]);
    expect(
      summarizeMemorySubspaces([
        { relativePath: "memory/root.md", size: 100, modifiedAt: "2026-05-01T00:00:00.000Z" },
        { relativePath: "memory/workspace/a.md", size: 2048, modifiedAt: "2026-05-02T00:00:00.000Z" },
      ]),
    ).toEqual([
      expect.objectContaining({ area: "memory/workspace", totalBytes: 2048 }),
      expect.objectContaining({ area: "memory/root.md", totalBytes: 100 }),
    ]);
    expect(formatBytes(1_073_741_824)).toBe("1.00 GB");
    expect(formatBytes(1_048_576)).toBe("1.00 MB");
    expect(formatBytes(1024)).toBe("1.00 KB");
    expect(formatBytes(512)).toBe("512 B");
    expect(formatTokenDelta(2.4)).toBe("+2 tokens");
    expect(formatTokenDelta(-2.4)).toBe("-2 tokens");
    expect(formatTokenDelta(0)).toBe("no change");
    expect(describeQmdImpact({ efficiencyLabel: "reduced", compressionPercent: 10, expansionPercent: 0 })).toBe(
      "Reduced 10.0%",
    );
    expect(describeQmdImpact({ efficiencyLabel: "expanded", compressionPercent: 0, expansionPercent: 5 })).toBe(
      "Grew 5.0%",
    );
    expect(describeQmdImpact({ efficiencyLabel: "neutral", compressionPercent: 0, expansionPercent: 0 })).toBe(
      "Stable",
    );
    expect(formatMaybeDateTime(undefined)).toBe("-");
    expect(shortId("short")).toBe("short");
    expect(shortId("abcdefghijklmnopqrstuvwxyz", 6)).toBe("abcdef...");
  });

  it("builds maintenance policy patches for manual, scheduled, and weekly variants", () => {
    const resolvedTimeZone = vi.spyOn(Intl, "DateTimeFormat").mockReturnValue({
      resolvedOptions: () => ({ timeZone: "America/New_York" }),
    } as Intl.DateTimeFormat);

    try {
      expect(buildMemoryMaintenancePolicyPatch({ ...baseDraft, timeZone: "   " })).toMatchObject({
        timeZone: "America/New_York",
        providerId: null,
        model: null,
        schedule: null,
      });
      expect(
        buildMemoryMaintenancePolicyPatch({
          ...baseDraft,
          runMode: "scheduled",
          providerId: " openai ",
          model: " gpt-5 ",
        }),
      ).toMatchObject({
        providerId: "openai",
        model: "gpt-5",
        schedule: { frequency: "daily", hour: 3, minute: 0, weekday: undefined },
      });
      expect(
        buildMemoryMaintenancePolicyPatch({
          ...baseDraft,
          runMode: "hybrid",
          scheduleFrequency: "weekly",
          scheduleWeekday: 5,
        }),
      ).toMatchObject({ schedule: { frequency: "weekly", hour: 3, minute: 0, weekday: 5 } });
    } finally {
      resolvedTimeZone.mockRestore();
    }
  });

  it("normalizes persisted maintenance policies with optional schedule and provider fields", () => {
    expect(
      toMemoryMaintenancePolicyDraft({
        workspaceId: "default",
        enabled: true,
        runMode: "manual",
        timingStrategy: "fixed",
        timeZone: "UTC",
        minHoursSinceLastSuccess: 24,
        minChangedSessions: 1,
        providerId: null,
        model: null,
        executionTarget: "auto",
        unavailableModelPolicy: "skip",
        createdAt: "2026-05-01T00:00:00.000Z",
        updatedAt: "2026-05-01T00:00:00.000Z",
      }),
    ).toMatchObject({
      providerId: "",
      model: "",
      scheduleEnabled: false,
      scheduleFrequency: "daily",
      scheduleWeekday: 1,
    });
    expect(
      toMemoryMaintenancePolicyDraft({
        workspaceId: "default",
        enabled: true,
        runMode: "scheduled",
        timingStrategy: "fixed",
        timeZone: "UTC",
        minHoursSinceLastSuccess: 24,
        minChangedSessions: 1,
        providerId: "openai",
        model: "gpt-5",
        executionTarget: "auto",
        unavailableModelPolicy: "skip",
        schedule: { frequency: "weekly", hour: 4, minute: 30 },
        createdAt: "2026-05-01T00:00:00.000Z",
        updatedAt: "2026-05-01T00:00:00.000Z",
      }),
    ).toMatchObject({
      providerId: "openai",
      model: "gpt-5",
      scheduleEnabled: true,
      scheduleFrequency: "weekly",
      scheduleHour: 4,
      scheduleMinute: 30,
      scheduleWeekday: 1,
    });
  });
});
