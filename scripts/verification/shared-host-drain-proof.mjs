#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";

const repoRoot = path.resolve(import.meta.dirname, "..", "..");
const pnpm = process.platform === "win32" ? process.execPath : "pnpm";
const pnpmPrefix =
  process.platform === "win32"
    ? [path.join(path.dirname(process.execPath), "node_modules", "corepack", "dist", "pnpm.js")]
    : [];
const startedAt = new Date();
const artifactRoot = path.join(
  repoRoot,
  "artifacts",
  "verification",
  `${startedAt.toISOString().replaceAll(":", "-").replace(".", "-")}-shared-host-drain-${randomBytes(4).toString("hex")}`,
);
const checkResults = [];

const checks = [
  {
    label: "Gateway admission, entrypoint, drain, health, cadence, shutdown, and durable recovery proof",
    args: [
      ...pnpmPrefix,
      "--filter",
      "@goatcitadel/gateway",
      "exec",
      "vitest",
      "run",
      "--reporter=dot",
      "src/services/shared-host-lifecycle-service.test.ts",
      "src/plugins/shared-host-lifecycle.test.ts",
      "src/routes/health.test.ts",
      "src/main.shutdown.test.ts",
      "src/services/a2a-grpc-service.test.ts",
      "src/services/discord-runtime-service.test.ts",
      "src/services/approval-resolution-effects-service.test.ts",
      "src/services/inbound-channel-event-service.test.ts",
      "src/services/channel-delivery-runtime-service.test.ts",
      "src/services/media-voice-service.test.ts",
      "src/services/prompt-pack-service.execution.test.ts",
      "src/services/assembly-service.test.ts",
      "src/services/shared-host-production-admission.test.ts",
      "src/services/gateway/cron-automation-service.test.ts",
      "src/services/durable-run-service.test.ts",
    ],
  },
  {
    label: "Executable shared-host no-migration proof",
    command: process.execPath,
    args: [path.join(repoRoot, "scripts", "verification", "shared-host-no-migration-proof.mjs")],
  },
  {
    label: "SQLite canonical cron reservation proof",
    args: [...pnpmPrefix, "--filter", "@goatcitadel/storage", "exec", "tsx", "--test", "src/cron-run-repo.test.ts"],
  },
  {
    label: "Postgres canonical cron reservation proof (conditional)",
    args: [
      ...pnpmPrefix,
      "--filter",
      "@goatcitadel/storage",
      "exec",
      "tsx",
      "--test",
      "src/postgres-channel-cron-durability.test.ts",
    ],
  },
  {
    label: "Storage typecheck",
    args: [...pnpmPrefix, "--filter", "@goatcitadel/storage", "typecheck"],
  },
  {
    label: "Gateway typecheck",
    args: [...pnpmPrefix, "--filter", "@goatcitadel/gateway", "typecheck"],
  },
];

for (const [index, check] of checks.entries()) {
  process.stdout.write(`\n[${index + 1}/${checks.length}] ${check.label}\n`);
  const checkStartedAt = Date.now();
  const result = spawnSync(check.command ?? pnpm, check.args, {
    cwd: repoRoot,
    env: process.env,
    encoding: "utf8",
    stdio: "inherit",
    windowsHide: true,
  });
  checkResults.push({
    label: check.label,
    status: result.status === 0 ? "passed" : "failed",
    exitCode: result.status,
    durationMs: Date.now() - checkStartedAt,
  });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    process.exitCode = result.status ?? 1;
    process.stderr.write(`Shared-host drain proof failed during: ${check.label}\n`);
    break;
  }
}

await fs.mkdir(artifactRoot, { recursive: true });
const noMigrationCheck = checkResults.find((check) => check.label === "Executable shared-host no-migration proof");
await fs.writeFile(
  path.join(artifactRoot, "manifest.json"),
  `${JSON.stringify(
    {
      version: "shared_host.drain_proof.v1",
      lane: "verify:shared-host:drain",
      status: process.exitCode ? "failed" : "passed",
      startedAt: startedAt.toISOString(),
      finishedAt: new Date().toISOString(),
      livePostgres: process.env.GOATCITADEL_TEST_POSTGRES_URL?.trim() ? "executed" : "skipped_env_unset",
      noMigrationsAdded: noMigrationCheck?.status === "passed",
      checks: checkResults,
    },
    null,
    2,
  )}\n`,
  "utf8",
);
process.stdout.write(`\nShared-host drain proof artifact: ${artifactRoot}\n`);

if (!process.exitCode) {
  process.stdout.write(
    process.env.GOATCITADEL_TEST_POSTGRES_URL?.trim()
      ? "\nShared-host drain proof passed, including live Postgres.\n"
      : "\nShared-host drain proof passed. Live Postgres was conditionally skipped because GOATCITADEL_TEST_POSTGRES_URL is unset.\n",
  );
}
