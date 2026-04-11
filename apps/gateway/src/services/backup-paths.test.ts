import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  buildOfflineRestoreRequiredResponse,
  resolveBackupDirectory,
  resolveBackupPathWithinDirectory,
} from "./backup-paths.js";

const ORIGINAL_BACKUP_DIR = process.env.GOATCITADEL_BACKUP_DIR;

afterEach(() => {
  if (ORIGINAL_BACKUP_DIR === undefined) {
    delete process.env.GOATCITADEL_BACKUP_DIR;
    return;
  }
  process.env.GOATCITADEL_BACKUP_DIR = ORIGINAL_BACKUP_DIR;
});

describe("backup path helpers", () => {
  it("prefers GOATCITADEL_BACKUP_DIR when no explicit directory is provided", () => {
    process.env.GOATCITADEL_BACKUP_DIR = path.join("C:", "gc-backups");
    expect(resolveBackupDirectory()).toBe(path.resolve(path.join("C:", "gc-backups")));
  });

  it("keeps backup file paths jailed within the configured directory", () => {
    process.env.GOATCITADEL_BACKUP_DIR = path.join("C:", "gc-backups");
    expect(resolveBackupPathWithinDirectory("daily/backup-1.backup")).toMatchObject({
      ok: true,
      resolvedPath: path.resolve(path.join("C:", "gc-backups", "daily", "backup-1.backup")),
    });
    expect(resolveBackupPathWithinDirectory("../outside.backup")).toMatchObject({
      ok: false,
      error: "Backup file path must stay within the GoatCitadel backup directory.",
    });
  });

  it("builds the blocked live-restore response from the shared jailed path helper", () => {
    process.env.GOATCITADEL_BACKUP_DIR = path.join(os.tmpdir(), "goatcitadel-shared-backups");
    const blocked = buildOfflineRestoreRequiredResponse("nightly.backup");
    expect(blocked).toMatchObject({
      ok: true,
    });
    if (!blocked.ok) {
      throw new Error("expected blocked restore response");
    }
    expect(blocked.response).toMatchObject({
      error: "offline_restore_required",
      code: "offline_restore_required",
      maintenanceRequired: true,
      supportedMode: "offline",
      filePath: path.resolve(process.env.GOATCITADEL_BACKUP_DIR, "nightly.backup"),
    });
    expect(blocked.response.cliHint).toContain('pnpm admin backup restore --file "nightly.backup" --confirm');
  });
});
