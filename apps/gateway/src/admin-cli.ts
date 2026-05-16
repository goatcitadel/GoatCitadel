/* eslint-disable no-console -- CLI entrypoint intentionally writes structured output to stdout and stderr. */
import path from "node:path";
import process from "node:process";
import { pathToFileURL } from "node:url";
import type { LlmRuntimeConfig } from "@goatcitadel/contracts";
import type { BundledPostgresRuntimeHandle } from "./bundled-postgres-runtime.js";
import { ensureBundledPostgresRuntime } from "./bundled-postgres-runtime.js";
import { repoHasConfigMarker } from "./config-files.js";
import { runOfflineBackupCommand } from "./admin-backup-cli.js";
import { loadLocalEnvFile } from "./env-file.js";
import { loadGatewayConfig } from "./config.js";
import { createGatewayAdminRuntime, type GatewayAdminPort } from "./services/gateway-runtime-factory.js";

loadLocalEnvFile();

export async function main(): Promise<void> {
  const args = process.argv.slice(2);
  if (args.length === 0) {
    printUsage();
    return;
  }

  const [group, action, ...rest] = args;
  if (group !== "backup" && group !== "retention" && group !== "auth" && group !== "database" && group !== "llm") {
    printUsage();
    process.exitCode = 1;
    return;
  }

  if (group === "backup" && (action === "restore" || action === "verify")) {
    await runOfflineBackupCommand(action, rest);
    return;
  }
  const config = await loadGatewayConfig(resolveRootDir());
  let bundledPostgres: BundledPostgresRuntimeHandle | undefined;
  if (config.assistant.database.driver === "postgres") {
    bundledPostgres = await ensureBundledPostgresRuntime(config);
  }
  const gateway = createGatewayAdminRuntime(config);
  await gateway.init();

  try {
    if (group === "backup") {
      await runBackupCommand(gateway, action, rest);
      return;
    }
    if (group === "retention") {
      await runRetentionCommand(gateway, action, rest);
      return;
    }
    if (group === "auth") {
      await runAuthCommand(gateway, action, rest);
      return;
    }
    if (group === "llm") {
      await runLlmCommand(gateway, action, rest);
      return;
    }
    await runDatabaseCommand(gateway, action, rest);
  } finally {
    await gateway.close();
    await bundledPostgres?.stop();
  }
}

async function runBackupCommand(gateway: GatewayAdminPort, action: string | undefined, args: string[]): Promise<void> {
  if (action === "create") {
    const name = readFlag(args, "--name");
    const outputPath = readFlag(args, "--output");
    const created = await gateway.createBackup({
      name: name ?? undefined,
      outputPath: outputPath ?? undefined,
    });
    console.log(JSON.stringify(created, null, 2));
    return;
  }

  if (action === "list") {
    const limitRaw = readFlag(args, "--limit");
    const limit = limitRaw ? Number.parseInt(limitRaw, 10) : 50;
    const items = await gateway.listBackups(Number.isFinite(limit) ? limit : 50);
    console.log(JSON.stringify({ items }, null, 2));
    return;
  }

  throw new Error("Unknown backup command");
}

async function runRetentionCommand(
  gateway: GatewayAdminPort,
  action: string | undefined,
  args: string[],
): Promise<void> {
  if (action === "show") {
    console.log(JSON.stringify(gateway.getRetentionPolicy(), null, 2));
    return;
  }

  if (action === "set") {
    const realtimeDays = readFlag(args, "--realtime-days");
    const backupKeep = readFlag(args, "--backup-keep");
    const transcriptDays = readFlag(args, "--transcript-days");
    const auditDays = readFlag(args, "--audit-days");
    const updated = gateway.updateRetentionPolicy({
      realtimeEventsDays: realtimeDays ? Number.parseInt(realtimeDays, 10) : undefined,
      backupsKeep: backupKeep ? Number.parseInt(backupKeep, 10) : undefined,
      transcriptsDays: parseOptionalDays(transcriptDays),
      auditDays: parseOptionalDays(auditDays),
    });
    console.log(JSON.stringify(updated, null, 2));
    return;
  }

  if (action === "prune") {
    const apply = args.includes("--apply");
    const dryRun = !apply;
    const result = await gateway.pruneRetention({ dryRun });
    console.log(JSON.stringify(result, null, 2));
    return;
  }

  throw new Error("Unknown retention command");
}

async function runAuthCommand(gateway: GatewayAdminPort, action: string | undefined, args: string[]): Promise<void> {
  if (action === "plan") {
    console.log(JSON.stringify(gateway.getAuthCredentialPlan(), null, 2));
    return;
  }

  if (action === "install-token") {
    const token = readFlag(args, "--token");
    const resolved = await gateway.resolveGatewayInstallToken({
      token: token ?? undefined,
      generateWhenMissing: args.includes("--generate"),
      persistToEnv: args.includes("--persist"),
    });
    console.log(JSON.stringify(resolved, null, 2));
    return;
  }

  throw new Error("Unknown auth command");
}

async function runDatabaseCommand(
  gateway: GatewayAdminPort,
  action: string | undefined,
  args: string[],
): Promise<void> {
  if (action === "cutover") {
    const profileRaw = readFlag(args, "--profile");
    if (profileRaw !== "local" && profileRaw !== "hosted") {
      throw new Error("Database cutover requires --profile local|hosted");
    }
    const dryRun = args.includes("--dry-run");
    const execute = args.includes("--execute");
    if (dryRun === execute) {
      throw new Error("Database cutover requires exactly one of --dry-run or --execute");
    }
    const result = await gateway.runDatabaseCutover({
      profile: profileRaw,
      execute,
      confirm: args.includes("--confirm"),
    });
    console.log(JSON.stringify(result, null, 2));
    return;
  }

  if (action === "verify") {
    const source = readFlag(args, "--source");
    const target = readFlag(args, "--target");
    if (!source) {
      throw new Error("Database verify requires --source <sqlite-backup>");
    }
    const result = await gateway.verifyDatabaseCutover({
      source,
      target: target ?? undefined,
    });
    console.log(JSON.stringify(result, null, 2));
    return;
  }

  throw new Error("Unknown database command");
}

async function runLlmCommand(gateway: GatewayAdminPort, action: string | undefined, args: string[]): Promise<void> {
  if (action === "status") {
    const runtime = gateway.getLlmConfig();
    if (args.includes("--json")) {
      console.log(JSON.stringify(runtime, null, 2));
      return;
    }
    const lines = buildLlmStatusLines(runtime);
    for (const line of lines) {
      console.log(line);
    }
    return;
  }

  throw new Error("Unknown llm command");
}

export function buildLlmStatusLines(runtime: LlmRuntimeConfig): string[] {
  const activeProviderId = runtime.activeProviderId?.trim() || "unset";
  const activeModel = runtime.activeModel?.trim() || "unset";
  const lines: string[] = [
    "LLM runtime status",
    `  Active provider: ${activeProviderId}`,
    `  Active model:    ${activeModel}`,
  ];
  if (typeof runtime.activeModelContextWindow === "number") {
    lines.push(`  Context window:  ${runtime.activeModelContextWindow.toLocaleString()}`);
  }
  if (typeof runtime.activeModelOutputTokenLimit === "number") {
    lines.push(`  Output limit:    ${runtime.activeModelOutputTokenLimit.toLocaleString()}`);
  }
  return lines;
}

function parseOptionalDays(value: string | null): number | undefined {
  if (!value) {
    return undefined;
  }
  if (value.toLowerCase() === "off") {
    return undefined;
  }
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) ? parsed : undefined;
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

function printUsage(): void {
  console.log(`Usage:
  goat admin backup create [--name <name>] [--output <path>]
  goat admin backup list [--limit <n>]
  goat admin backup verify --file <path>
  goat admin backup restore --file <path> --confirm
  goat admin auth plan
  goat admin auth install-token [--token <value>] [--generate] [--persist]
  goat admin database cutover --profile local|hosted --dry-run
  goat admin database cutover --profile local|hosted --execute --confirm
  goat admin database verify --source <sqlite-backup> [--target <postgres-connection-string>]
  goat admin llm status [--json]
  goat admin retention show
  goat admin retention set --realtime-days <n> --backup-keep <n> [--transcript-days <n>|off] [--audit-days <n>|off]
  goat admin retention prune [--dry-run|--apply]`);
}

const invokedAsScript = typeof process.argv[1] === "string" && import.meta.url === pathToFileURL(process.argv[1]).href;

if (invokedAsScript) {
  main().catch((error) => {
    console.error((error as Error).message);
    process.exitCode = 1;
  });
}
