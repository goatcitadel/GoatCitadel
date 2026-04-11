import os from "node:os";
import path from "node:path";

export interface OfflineRestoreRequiredResponse {
  error: "offline_restore_required";
  code: "offline_restore_required";
  message: string;
  maintenanceRequired: true;
  supportedMode: "offline";
  filePath: string;
  cliHint: string;
}

export function resolveBackupDirectory(explicitDir?: string): string {
  const fromInput = explicitDir?.trim();
  if (fromInput) {
    return path.resolve(fromInput);
  }
  const fromEnv = process.env.GOATCITADEL_BACKUP_DIR?.trim();
  if (fromEnv) {
    return path.resolve(fromEnv);
  }
  return path.join(os.homedir(), ".GoatCitadel", "backups");
}

export function resolveBackupPathWithinDirectory(
  filePath: string,
  backupDir?: string,
): { ok: true; resolvedPath: string; backupDirectory: string } | { ok: false; error: string } {
  const backupDirectory = path.resolve(resolveBackupDirectory(backupDir));
  const resolvedPath = path.resolve(backupDirectory, filePath);
  const relative = path.relative(backupDirectory, resolvedPath);
  if (!relative || relative.startsWith("..") || path.isAbsolute(relative)) {
    return {
      ok: false,
      error: "Backup file path must stay within the GoatCitadel backup directory.",
    };
  }
  return {
    ok: true,
    resolvedPath,
    backupDirectory,
  };
}

export function buildOfflineRestoreRequiredResponse(
  filePath: string,
  backupDir?: string,
): { ok: true; response: OfflineRestoreRequiredResponse } | { ok: false; error: string } {
  const jailed = resolveBackupPathWithinDirectory(filePath, backupDir);
  if (!jailed.ok) {
    return jailed;
  }
  return {
    ok: true,
    response: {
      error: "offline_restore_required",
      code: "offline_restore_required",
      message: "Filesystem-backed backup restore is only supported while the GoatCitadel gateway is offline.",
      maintenanceRequired: true,
      supportedMode: "offline",
      filePath: jailed.resolvedPath,
      cliHint: `pnpm admin backup restore --file "${filePath}" --confirm`,
    },
  };
}
