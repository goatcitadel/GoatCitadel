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
  `${startedAt.toISOString().replaceAll(":", "-").replace(".", "-")}-workspace-path-bridge-${randomBytes(4).toString("hex")}`,
);
const checks = [
  {
    label: "Gateway mapping, config, Git binding, TOCTOU, plugin, cancellation, replay, and route proof",
    args: [
      ...pnpmPrefix,
      "--filter",
      "@goatcitadel/gateway",
      "exec",
      "vitest",
      "run",
      "--reporter=dot",
      "src/services/workspace-path-bridge-config.test.ts",
      "src/services/workspace-path-bridge-runtime.test.ts",
      "src/services/workspace-path-bridge-service.test.ts",
      "src/services/workspace-path-bridge-integration.test.ts",
      "src/services/tool-path-resolution.test.ts",
      "src/services/tool-invocation-coordinator-path-bridge.test.ts",
      "src/routes/workspace-path-bridge.test.ts",
    ],
  },
  {
    label: "Deepest builtin process-spawn and async policy precondition proof",
    args: [
      ...pnpmPrefix,
      "--filter",
      "@goatcitadel/policy-engine",
      "exec",
      "vitest",
      "run",
      "--reporter=dot",
      "src/tool-execution-fence.test.ts",
    ],
  },
  {
    label: "Immutable snapshots and SQLite 162/PostgreSQL 104 parity",
    args: [
      ...pnpmPrefix,
      "--filter",
      "@goatcitadel/storage",
      "exec",
      "tsx",
      "--test",
      "src/workspace-path-bridge-snapshot-repo.test.ts",
      "src/workspace-path-bridge-schema-parity.test.ts",
    ],
  },
  {
    label: "Policy engine typecheck",
    args: [...pnpmPrefix, "--filter", "@goatcitadel/policy-engine", "typecheck"],
  },
  {
    label: "Gateway typecheck",
    args: [...pnpmPrefix, "--filter", "@goatcitadel/gateway", "typecheck"],
  },
];
const checkResults = [];
let sqliteHead;
let postgresHead;
let workspacePathBridgeMigrationPairFrozen = false;

try {
  const sqliteSource = await fs.readFile(path.join(repoRoot, "packages", "storage", "src", "sqlite.ts"), "utf8");
  const postgresSource = await fs.readFile(
    path.join(repoRoot, "packages", "storage", "src", "postgres", "migrations.ts"),
    "utf8",
  );
  sqliteHead = Math.max(...[...sqliteSource.matchAll(/version:\s*(\d+)/gu)].map((match) => Number(match[1])));
  postgresHead = Math.max(...[...postgresSource.matchAll(/version:\s*(\d+)/gu)].map((match) => Number(match[1])));
  workspacePathBridgeMigrationPairFrozen =
    /version:\s*162[\s\S]*?workspace_path_bridge_snapshots/gu.test(sqliteSource) &&
    /version:\s*104[\s\S]*?workspace_path_bridge_snapshots/gu.test(postgresSource);
  if (!workspacePathBridgeMigrationPairFrozen) {
    throw new Error("Workspace path bridge migration parity must remain frozen at SQLite 162/PostgreSQL 104.");
  }

  for (const [index, check] of checks.entries()) {
    process.stdout.write(`\n[${index + 1}/${checks.length}] ${check.label}\n`);
    const checkStartedAt = Date.now();
    const result = spawnSync(pnpm, check.args, {
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
      break;
    }
  }
} catch (error) {
  process.exitCode = process.exitCode || 1;
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
} finally {
  await fs.mkdir(artifactRoot, { recursive: true });
  await fs.writeFile(
    path.join(artifactRoot, "manifest.json"),
    `${JSON.stringify(
      {
        version: "workspace_path_bridge.proof.v1",
        lane: "verify:workspace:path-bridge",
        status: process.exitCode ? "failed" : "passed",
        startedAt: startedAt.toISOString(),
        finishedAt: new Date().toISOString(),
        migrationHeads: { sqlite: sqliteHead, postgres: postgresHead },
        workspacePathBridgeMigrationVersions: { sqlite: 162, postgres: 104 },
        workspacePathBridgeMigrationPairFrozen,
        noAdditionalMigrationRequiredByThisLane: true,
        checks: checkResults,
      },
      null,
      2,
    )}\n`,
    "utf8",
  );
  process.stdout.write(`\nWorkspace path bridge proof artifact: ${artifactRoot}\n`);
}
