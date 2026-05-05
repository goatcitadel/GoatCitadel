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
    return resolveBackupFilesystemPath(fromInput);
  }
  const fromEnv = process.env.GOATCITADEL_BACKUP_DIR?.trim();
  if (fromEnv) {
    return resolveBackupFilesystemPath(fromEnv);
  }
  return path.join(os.homedir(), ".GoatCitadel", "backups");
}

export function resolveBackupPathWithinDirectory(
  filePath: string,
  backupDir?: string,
): { ok: true; resolvedPath: string; backupDirectory: string } | { ok: false; error: string } {
  const backupDirectory = resolveBackupFilesystemPath(resolveBackupDirectory(backupDir));
  const pathApi = pathApiForBackupPath(backupDirectory);
  if (isWindowsAbsolutePath(filePath) && !isWindowsAbsolutePath(backupDirectory)) {
    return {
      ok: false,
      error: "Backup file path must stay within the GoatCitadel backup directory.",
    };
  }
  const resolvedPath = pathApi.resolve(backupDirectory, filePath);
  const relative = pathApi.relative(backupDirectory, resolvedPath);
  if (!relative || relative.startsWith("..") || pathApi.isAbsolute(relative)) {
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

function isWindowsAbsolutePath(value: string): boolean {
  return /^[A-Za-z]:[\\/]/.test(value.trim());
}

function pathApiForBackupPath(value: string): typeof path.win32 | typeof path {
  return isWindowsAbsolutePath(value) ? path.win32 : path;
}

function resolveBackupFilesystemPath(value: string): string {
  const trimmed = value.trim();
  return pathApiForBackupPath(trimmed).resolve(trimmed);
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
