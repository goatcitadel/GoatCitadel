import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  repoHasConfigMarker: vi.fn(),
  restoreBackupOffline: vi.fn(),
  verifyBackupOffline: vi.fn(),
}));

vi.mock("./config-files.js", () => ({
  repoHasConfigMarker: mocks.repoHasConfigMarker,
}));

vi.mock("./services/backup-retention-service.js", () => ({
  restoreBackupOffline: mocks.restoreBackupOffline,
  verifyBackupOffline: mocks.verifyBackupOffline,
}));

const { runOfflineBackupCommand } = await import("./admin-backup-cli.js");

const originalRootDir = process.env.GOATCITADEL_ROOT_DIR;

describe("admin backup CLI", () => {
  let output: string[];
  let stdoutSpy: ReturnType<typeof vi.spyOn>;
  let cwdSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    output = [];
    mocks.repoHasConfigMarker.mockReset();
    mocks.restoreBackupOffline.mockReset();
    mocks.verifyBackupOffline.mockReset();
    stdoutSpy = vi.spyOn(process.stdout, "write").mockImplementation((chunk: string | Uint8Array) => {
      output.push(String(chunk));
      return true;
    });
    cwdSpy = vi.spyOn(process, "cwd").mockReturnValue(path.join("C:", "repo", "apps", "gateway"));
    delete process.env.GOATCITADEL_ROOT_DIR;
  });

  afterEach(() => {
    stdoutSpy.mockRestore();
    cwdSpy.mockRestore();
    if (originalRootDir === undefined) {
      delete process.env.GOATCITADEL_ROOT_DIR;
    } else {
      process.env.GOATCITADEL_ROOT_DIR = originalRootDir;
    }
  });

  it("restores a backup only when a file and confirmation are provided", async () => {
    process.env.GOATCITADEL_ROOT_DIR = "  C:/goat/root  ";
    mocks.restoreBackupOffline.mockResolvedValue({ restored: true, filePath: "backup.zip" });

    await runOfflineBackupCommand("restore", ["--file", "backup.zip", "--confirm"]);

    expect(mocks.restoreBackupOffline).toHaveBeenCalledWith({
      rootDir: path.resolve("C:/goat/root"),
      filePath: "backup.zip",
      confirm: true,
    });
    expect(JSON.parse(output.join(""))).toEqual({ restored: true, filePath: "backup.zip" });

    await expect(runOfflineBackupCommand("restore", ["--confirm"])).rejects.toThrow("Missing required --file <path>");
    await expect(runOfflineBackupCommand("restore", ["--file", "backup.zip"])).rejects.toThrow(
      "Restore requires --confirm",
    );
  });

  it("verifies backups without resolving a writable root", async () => {
    mocks.verifyBackupOffline.mockResolvedValue({ ok: true, entries: 2 });

    await runOfflineBackupCommand("verify", ["--file", "backup.zip"]);

    expect(mocks.verifyBackupOffline).toHaveBeenCalledWith({ filePath: "backup.zip" });
    expect(JSON.parse(output.join(""))).toEqual({ ok: true, entries: 2 });
    await expect(runOfflineBackupCommand("verify", [])).rejects.toThrow("Missing required --file <path>");
  });

  it("resolves the nearest repo marker before falling back for unknown commands", async () => {
    const cwd = path.join("C:", "repo", "apps", "gateway");
    const repoRoot = path.resolve(cwd, "..");
    cwdSpy.mockReturnValue(cwd);
    mocks.repoHasConfigMarker.mockImplementation((candidate: string) => candidate === repoRoot);
    mocks.restoreBackupOffline.mockResolvedValue({ restored: true });

    await runOfflineBackupCommand("restore", ["--file", "backup.zip", "--confirm"]);

    expect(mocks.restoreBackupOffline).toHaveBeenCalledWith(expect.objectContaining({ rootDir: repoRoot }));

    mocks.repoHasConfigMarker.mockReturnValue(false);
    await expect(runOfflineBackupCommand(undefined, [])).rejects.toThrow("Unknown backup command");
  });
});
