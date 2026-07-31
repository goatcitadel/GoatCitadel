import fsSync from "node:fs";
import path from "node:path";

export interface NativePostgresCommands {
  initdb: string;
  pgCtl: string;
}

/**
 * Resolve the server tools inside a candidate bin directory.
 *
 * Client-only PostgreSQL packages ship psql/pg_dump without the server tools,
 * so require BOTH initdb and pg_ctl before claiming we can manage a cluster.
 */
export function nativePostgresCommandsInBinDir(
  binDir: string,
  platform: NodeJS.Platform,
): NativePostgresCommands | undefined {
  const exe = platform === "win32" ? ".exe" : "";
  const initdb = path.join(binDir, `initdb${exe}`);
  const pgCtl = path.join(binDir, `pg_ctl${exe}`);
  if (!fsSync.existsSync(initdb) || !fsSync.existsSync(pgCtl)) {
    return undefined;
  }
  return { initdb, pgCtl };
}

/**
 * Directories whose immediate children are PostgreSQL installations, i.e.
 * `<root>/<entry>/bin` is a candidate bin directory. One uniform rule covers
 * every mainstream layout:
 *   Windows      C:\Program Files\PostgreSQL\16\bin
 *   Debian       /usr/lib/postgresql/16/bin
 *   RHEL         /usr/pgsql-16/bin              (root /usr, entry pgsql-16)
 *   Homebrew     /opt/homebrew/opt/postgresql@16/bin
 *   Postgres.app /Applications/Postgres.app/Contents/Versions/16/bin
 */
export function nativePostgresInstallRoots(platform: NodeJS.Platform, env: NodeJS.ProcessEnv): string[] {
  if (platform === "win32") {
    const roots = new Set<string>();
    for (const key of ["ProgramFiles", "ProgramW6432", "ProgramFiles(x86)"]) {
      const base = env[key]?.trim();
      if (base) {
        roots.add(path.join(base, "PostgreSQL"));
      }
    }
    if (roots.size === 0) {
      roots.add(path.join("C:\\Program Files", "PostgreSQL"));
    }
    return [...roots];
  }
  if (platform === "darwin") {
    return ["/opt/homebrew/opt", "/usr/local/opt", "/Applications/Postgres.app/Contents/Versions"];
  }
  return ["/usr/lib/postgresql", "/usr", "/usr/local", "/opt/homebrew/opt"];
}

export function parseNativePostgresMajor(entryName: string): number {
  const match = /(\d+)(?:\.\d+)*$/.exec(entryName.trim());
  return match ? Number.parseInt(match[1] ?? "", 10) || 0 : 0;
}

export function highestVersionedNativePostgresCommands(
  roots: string[],
  platform: NodeJS.Platform,
): NativePostgresCommands | undefined {
  const candidates: Array<{ major: number; commands: NativePostgresCommands }> = [];
  for (const root of roots) {
    let entries: string[];
    try {
      entries = fsSync.readdirSync(root);
    } catch {
      // Root absent or unreadable — normal on most machines.
      continue;
    }
    for (const entry of entries) {
      const commands = nativePostgresCommandsInBinDir(path.join(root, entry, "bin"), platform);
      if (commands) {
        candidates.push({ major: parseNativePostgresMajor(entry), commands });
      }
    }
  }
  candidates.sort((left, right) => right.major - left.major);
  return candidates[0]?.commands;
}

export function nativePostgresCommandsFromPathEnv(
  platform: NodeJS.Platform,
  env: NodeJS.ProcessEnv,
): NativePostgresCommands | undefined {
  const rawPath = env.PATH ?? env.Path;
  if (!rawPath?.trim()) {
    return undefined;
  }
  for (const entry of rawPath.split(platform === "win32" ? ";" : ":")) {
    const dir = entry.trim().replace(/^"+|"+$/g, "");
    if (!dir) {
      continue;
    }
    const commands = nativePostgresCommandsInBinDir(dir, platform);
    if (commands) {
      return commands;
    }
  }
  return undefined;
}

/**
 * Locate a PostgreSQL server installation already present on the host. PATH
 * wins because it is the most deliberate signal the operator can give; only
 * then do we fall back to scanning the standard per-platform install roots,
 * preferring the highest major version found.
 */
export function discoverNativePostgresCommands(
  platform: NodeJS.Platform = process.platform,
  env: NodeJS.ProcessEnv = process.env,
): NativePostgresCommands | undefined {
  return (
    nativePostgresCommandsFromPathEnv(platform, env) ??
    highestVersionedNativePostgresCommands(nativePostgresInstallRoots(platform, env), platform)
  );
}
