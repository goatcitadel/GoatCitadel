import { beforeEach, describe, expect, it, vi } from "vitest";
import { REAL_TARGET, findCheck, makeTestContext } from "../test-support/context";
import { backupChecks } from "./backups";

const mocks = vi.hoisted(() => ({ createBackup: vi.fn(), listBackups: vi.fn() }));
vi.mock("@goatcitadel/mission-control-shared/api/system", () => mocks);

beforeEach(() => {
  mocks.createBackup.mockReset();
  mocks.listBackups.mockReset();
  mocks.createBackup.mockResolvedValue({ backupId: "b-1", bytes: 2048, outputPath: "backups/b-1.backup" });
});

describe("backups", () => {
  it("creates a backup and finds it in the list", async () => {
    mocks.listBackups.mockResolvedValueOnce({ items: [{ backupId: "b-1" }] });
    await expect(findCheck(backupChecks, "admin.backup").run(makeTestContext())).resolves.toMatchObject({
      status: "pass",
      summary: "Backup b-1 (2048 bytes) is listed.",
    });
    expect(mocks.createBackup).toHaveBeenCalledWith({ name: "testbench" });
  });

  it("fails when the new backup is not listed", async () => {
    mocks.listBackups.mockResolvedValueOnce({ items: [] });
    await expect(findCheck(backupChecks, "admin.backup").run(makeTestContext())).rejects.toThrow("is not listed");
  });

  it("fails when the new backup is empty", async () => {
    mocks.createBackup.mockResolvedValueOnce({ backupId: "b-1", bytes: 0, outputPath: "backups/b-1.backup" });
    await expect(findCheck(backupChecks, "admin.backup").run(makeTestContext())).rejects.toThrow(
      "The backup is empty.",
    );
    expect(mocks.listBackups).not.toHaveBeenCalled();
  });

  it("refuses to run outside the verified sandbox", async () => {
    await expect(findCheck(backupChecks, "admin.backup").run(makeTestContext({ target: REAL_TARGET }))).rejects.toThrow(
      "verified sandbox",
    );
    expect(mocks.createBackup).not.toHaveBeenCalled();
  });
});
