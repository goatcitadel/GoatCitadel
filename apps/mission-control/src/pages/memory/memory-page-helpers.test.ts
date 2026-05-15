import { describe, expect, it, vi } from "vitest";
import {
  buildMemoryMaintenancePolicyPatch,
  clampNumber,
  dedupeTextOptions,
  describeMaintenanceProviderLocality,
  describeMaintenanceUnavailablePolicy,
  describeQmdImpact,
  formatBytes,
  formatJson,
  formatMemoryMaintenanceProviderOption,
  formatMaybeDateTime,
  formatShortDateTime,
  formatTokenDelta,
  isMemoryLifecycleAdminDisabledError,
  isLikelyLocalProvider,
  pickLatestTimestamp,
  shortId,
  summarizeAreas,
  summarizeMemorySubspaces,
  toMemoryMaintenancePolicyDraft,
  topLevelArea,
  type MemoryMaintenancePolicyDraft,
} from "./memory-page-helpers";

describe("memory-page-helpers", () => {
  it("summarizes workspace and memory subspace areas", () => {
    const files = [
      { relativePath: "memory/runs/a.json", size: 200, modifiedAt: "2026-05-14T10:00:00.000Z" },
      { relativePath: "memory/runs/b.json", size: 300, modifiedAt: "2026-05-14T11:00:00.000Z" },
      { relativePath: "docs/readme.md", size: 800, modifiedAt: "2026-05-14T09:00:00.000Z" },
      { relativePath: "\\root.txt", size: 50, modifiedAt: "2026-05-14T08:00:00.000Z" },
    ];

    expect(topLevelArea("memory\\runs\\a.json")).toBe("memory");
    expect(topLevelArea("")).toBe("(root)");
    expect(pickLatestTimestamp("2026-05-14T10:00:00.000Z", "2026-05-14T11:00:00.000Z")).toBe(
      "2026-05-14T11:00:00.000Z",
    );
    expect(summarizeAreas(files).map((area) => [area.area, area.totalBytes])).toEqual([
      ["docs", 800],
      ["memory", 500],
      ["(root)", 50],
    ]);
    expect(summarizeMemorySubspaces(files)).toMatchObject([
      {
        area: "memory/runs",
        totalBytes: 500,
        latestModifiedAt: "2026-05-14T11:00:00.000Z",
      },
    ]);
  });

  it("formats memory status labels and defensive text values", () => {
    expect(isMemoryLifecycleAdminDisabledError("Feature flag memoryLifecycleAdminV1Enabled is disabled")).toBe(true);
    expect(formatBytes(512)).toBe("512 B");
    expect(formatBytes(2048)).toBe("2.00 KB");
    expect(formatBytes(3 * 1024 * 1024)).toBe("3.00 MB");
    expect(formatBytes(4 * 1024 * 1024 * 1024)).toBe("4.00 GB");
    expect(describeQmdImpact({ efficiencyLabel: "reduced", compressionPercent: 12.345, expansionPercent: 0 })).toBe(
      "Reduced 12.3%",
    );
    expect(describeQmdImpact({ efficiencyLabel: "expanded", compressionPercent: 0, expansionPercent: 6.789 })).toBe(
      "Grew 6.8%",
    );
    expect(describeQmdImpact({ efficiencyLabel: "neutral", compressionPercent: 0, expansionPercent: 0 })).toBe(
      "Stable",
    );
    expect(formatTokenDelta(12.4)).toBe("+12 tokens");
    expect(formatTokenDelta(-12.6)).toBe("-13 tokens");
    expect(formatTokenDelta(0)).toBe("no change");
    expect(dedupeTextOptions([" qwen ", "", "qwen", undefined, "gpt"])).toEqual(["qwen", "gpt"]);
    expect(formatJson({ ok: true })).toBe('{\n  "ok": true\n}');
    expect(shortId("abcdefghijklmnop", 8)).toBe("abcdefgh...");
  });

  it("classifies provider locality and builds maintenance policy patches", () => {
    const policy = toMemoryMaintenancePolicyDraft({
      enabled: true,
      runMode: "scheduled",
      timingStrategy: "recommendation_first",
      timeZone: "America/Los_Angeles",
      minHoursSinceLastSuccess: 12,
      minChangedSessions: 4,
      providerId: null,
      model: undefined,
      executionTarget: "auto",
      unavailableModelPolicy: "skip",
      schedule: { frequency: "weekly", hour: 2, minute: 30, weekday: 5 },
    });

    expect(policy).toMatchObject({
      providerId: "",
      model: "",
      scheduleEnabled: true,
      scheduleFrequency: "weekly",
      scheduleWeekday: 5,
    });
    expect(isLikelyLocalProvider("http://192.168.1.2:11434/v1")).toBe(true);
    expect(isLikelyLocalProvider("https://api.openai.com/v1")).toBe(false);
    expect(describeMaintenanceProviderLocality("http://localhost:11434/v1")).toBe("local endpoint");
    expect(describeMaintenanceUnavailablePolicy("error")).toBe("error if unavailable");
    expect(
      formatMemoryMaintenanceProviderOption(
        { providerId: "ollama", label: "Ollama", baseUrl: "http://127.0.0.1:11434/v1" },
        true,
      ),
    ).toBe("ollama (Ollama · local endpoint · active)");

    const patch = buildMemoryMaintenancePolicyPatch({
      ...policy,
      providerId: " ollama ",
      model: " qwen3 ",
    });
    expect(patch).toEqual({
      enabled: true,
      runMode: "scheduled",
      timingStrategy: "recommendation_first",
      timeZone: "America/Los_Angeles",
      minHoursSinceLastSuccess: 12,
      minChangedSessions: 4,
      providerId: "ollama",
      model: "qwen3",
      executionTarget: "auto",
      unavailableModelPolicy: "skip",
      schedule: {
        frequency: "weekly",
        hour: 2,
        minute: 30,
        weekday: 5,
      },
    });
  });

  it("clamps schedule values and omits manual schedules", () => {
    vi.spyOn(Intl, "DateTimeFormat").mockReturnValue({
      resolvedOptions: () => ({ timeZone: "UTC" }),
    } as Intl.DateTimeFormat);

    const draft: MemoryMaintenancePolicyDraft = {
      enabled: false,
      runMode: "manual",
      timingStrategy: "fixed",
      timeZone: " ",
      minHoursSinceLastSuccess: 1,
      minChangedSessions: 1,
      providerId: " ",
      model: " ",
      executionTarget: "cloud",
      unavailableModelPolicy: "error",
      scheduleEnabled: false,
      scheduleFrequency: "daily",
      scheduleHour: 99,
      scheduleMinute: -1,
      scheduleWeekday: 7,
    };

    expect(clampNumber("bad", 0, 10, 5)).toBe(5);
    expect(clampNumber("99", 0, 10, 5)).toBe(10);
    expect(buildMemoryMaintenancePolicyPatch(draft)).toMatchObject({
      runMode: "manual",
      timeZone: "UTC",
      providerId: null,
      model: null,
      schedule: null,
    });
  });

  it("formats timestamps through locale-aware wrappers", () => {
    expect(formatMaybeDateTime()).toBe("-");
    expect(formatMaybeDateTime("2026-05-14T12:00:00.000Z")).toContain("2026");
    expect(formatShortDateTime("2026-05-14T12:00:00.000Z")).toContain("May");
  });
});
