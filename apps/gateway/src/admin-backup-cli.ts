import path from "node:path";
import { repoHasConfigMarker } from "./config-files.js";
import { restoreBackupOffline, verifyBackupOffline } from "./services/backup-retention-service.js";

export async function runOfflineBackupCommand(action: string | undefined, args: string[]): Promise<void> {
  const rootDir = resolveRootDir();
  if (action === "restore") {
    const filePath = readFlag(args, "--file");
    const confirm = args.includes("--confirm");
    if (!filePath) {
      throw new Error("Missing required --file <path>");
    }
    if (!confirm) {
      throw new Error("Restore requires --confirm");
    }
    const restored = await restoreBackupOffline({
      rootDir,
      filePath,
      confirm: true,
    });
    process.stdout.write(`${JSON.stringify(restored, null, 2)}\n`);
    return;
  }

  if (action === "verify") {
    const filePath = readFlag(args, "--file");
    if (!filePath) {
      throw new Error("Missing required --file <path>");
    }
    const verified = await verifyBackupOffline({
      filePath,
    });
    process.stdout.write(`${JSON.stringify(verified, null, 2)}\n`);
    return;
  }

  throw new Error("Unknown backup command");
}

function readFlag(args: string[], flag: string): string | null {
  const index = args.indexOf(flag);
  if (index < 0) {
    return null;
  }
  return args[index + 1] ?? null;
}

function resolveRootDir(): string {
  const envRoot = process.env.GOATCITADEL_ROOT_DIR?.trim();
  if (envRoot) {
    return path.resolve(envRoot);
  }

  const candidates = [process.cwd(), path.resolve(process.cwd(), ".."), path.resolve(process.cwd(), "../..")];

  for (const candidate of candidates) {
    if (repoHasConfigMarker(candidate)) {
      return candidate;
    }
  }

  return path.resolve(process.cwd(), "../..");
}
