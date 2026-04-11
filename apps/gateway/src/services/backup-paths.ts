import os from "node:os";
import path from "node:path";

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
