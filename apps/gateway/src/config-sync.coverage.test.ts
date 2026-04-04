import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const syncUnifiedConfigMock = vi.fn();

vi.mock("./config-sync-lib.js", () => ({
  syncUnifiedConfig: syncUnifiedConfigMock,
}));

describe("config-sync entrypoint coverage", () => {
  beforeEach(() => {
    vi.resetModules();
    process.exitCode = 0;
    syncUnifiedConfigMock.mockReset();
    syncUnifiedConfigMock.mockResolvedValue({
      unifiedPath: "C:/tmp/goatcitadel.json",
      createdUnified: false,
      materializedExamples: [],
      syncedSections: ["assistant", "tool-policy"],
    });
  });

  afterEach(() => {
    delete process.env.GOATCITADEL_ROOT_DIR;
    vi.restoreAllMocks();
  });

  it("runs sync and logs summary", async () => {
    process.env.GOATCITADEL_ROOT_DIR = process.cwd();
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    await import("./config-sync.js");
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(syncUnifiedConfigMock).toHaveBeenCalledTimes(1);
    expect(logSpy).toHaveBeenCalled();
    expect(errorSpy).not.toHaveBeenCalled();
  });

  it("logs a friendly error when sync fails", async () => {
    process.env.GOATCITADEL_ROOT_DIR = process.cwd();
    syncUnifiedConfigMock.mockRejectedValueOnce(new Error("sync failed"));
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    await import("./config-sync.js");
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(errorSpy).toHaveBeenCalled();
    expect(process.exitCode).toBe(1);
  });
});
