/* eslint-disable no-console -- CLI entrypoint intentionally writes structured output to stdout. */
import path from "node:path";
import process from "node:process";
import { pathToFileURL } from "node:url";
import type { BundledPostgresRuntimeHandle } from "./bundled-postgres-runtime.js";
import { ensureBundledPostgresRuntime } from "./bundled-postgres-runtime.js";
import { repoHasConfigMarker } from "./config-files.js";
import { loadLocalEnvFile } from "./env-file.js";
import { loadGatewayConfig } from "./config.js";
import { createGatewayAdminRuntime } from "./services/gateway-runtime-factory.js";

export interface CronCliPort {
  runCronJobNow(jobId: string): Promise<{ jobId: string; runId: string; status: "ok" }>;
  findCronRunById(
    runId: string,
  ): { runId: string; jobId: string; status: "ok"; finishedAt?: string; output?: string } | undefined;
}

export interface CronCliIo {
  port: CronCliPort;
  write: (line: string) => void;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
}

const defaultSleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

function readFlag(args: string[], flag: string): string | undefined {
  const index = args.indexOf(flag);
  if (index < 0) {
    return undefined;
  }
  return args[index + 1];
}

export async function runCronCli(args: string[], io: CronCliIo): Promise<void> {
  const [command, ...rest] = args;
  if (command === "run") {
    await runRunCommand(rest, io);
    return;
  }
  if (command === "runs") {
    await runRunsCommand(rest, io);
    return;
  }
  throw new Error(`Unknown cron command: ${command ?? "(empty)"}`);
}

async function runRunCommand(args: string[], io: CronCliIo): Promise<void> {
  const jobId = args.find((token, index) => index === 0 && !token.startsWith("--"));
  if (!jobId) {
    throw new Error("cron run requires <jobId>");
  }
  const wait = args.includes("--wait");
  const timeoutMsRaw = readFlag(args, "--timeout");
  const pollMsRaw = readFlag(args, "--poll-interval");
  const timeoutMs = timeoutMsRaw ? Number.parseInt(timeoutMsRaw, 10) : 60_000;
  const pollMs = pollMsRaw ? Number.parseInt(pollMsRaw, 10) : 250;
  const sleep = io.sleep ?? defaultSleep;
  const now = io.now ?? Date.now;

  const queued = await io.port.runCronJobNow(jobId);
  if (!wait) {
    io.write(JSON.stringify(queued, null, 2));
    return;
  }

  const startedAt = now();
  while (true) {
    const found = io.port.findCronRunById(queued.runId);
    if (found) {
      io.write(JSON.stringify(found, null, 2));
      return;
    }
    if (now() - startedAt >= timeoutMs) {
      throw new Error(`cron run --wait timed out after ${timeoutMs}ms (runId=${queued.runId})`);
    }
    await sleep(pollMs);
  }
}

async function runRunsCommand(args: string[], io: CronCliIo): Promise<void> {
  const runId = readFlag(args, "--run-id");
  if (!runId) {
    throw new Error("cron runs requires --run-id <id>");
  }
  const result = io.port.findCronRunById(runId);
  if (!result) {
    throw new Error(`No cron run found for runId=${runId}`);
  }
  io.write(JSON.stringify(result, null, 2));
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

export async function main(): Promise<void> {
  loadLocalEnvFile();
  const args = process.argv.slice(2);
  if (args[0] !== "cron") {
    console.log("Usage: goatcitadel cron run <jobId> [--wait] [--timeout <ms>] [--poll-interval <ms>]");
    console.log("       goatcitadel cron runs --run-id <id>");
    process.exitCode = 1;
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
    const port: CronCliPort = {
      runCronJobNow: (jobId) => gateway.runCronJobNow(jobId),
      findCronRunById: (runId) => gateway.findCronRunById(runId),
    };
    await runCronCli(args.slice(1), {
      port,
      write: (line) => console.log(line),
    });
  } finally {
    await gateway.close();
    await bundledPostgres?.stop();
  }
}

const invokedAsScript = typeof process.argv[1] === "string" && import.meta.url === pathToFileURL(process.argv[1]).href;

if (invokedAsScript) {
  main().catch((error) => {
    console.error((error as Error).message);
    process.exitCode = 1;
  });
}
