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
const livePostgresConfigured = Boolean(process.env.GOATCITADEL_TEST_POSTGRES_URL?.trim());
const artifactRoot = path.join(
  repoRoot,
  "artifacts",
  "verification",
  `${startedAt.toISOString().replaceAll(":", "-").replace(".", "-")}-skill-hub-lifecycle-${randomBytes(4).toString("hex")}`,
);
const checks = [
  {
    label: "Contract intent, hash, snapshot, permission, and audit truth",
    args: [
      ...pnpmPrefix,
      "--filter",
      "@goatcitadel/contracts",
      "exec",
      "vitest",
      "run",
      "--reporter=dot",
      "src/skill-hub-lifecycle.test.ts",
    ],
  },
  {
    label: "SQLite artifact, snapshot, immutable intent, settlement, and migration parity",
    args: [
      ...pnpmPrefix,
      "--filter",
      "@goatcitadel/storage",
      "exec",
      "tsx",
      "--test",
      "src/skill-hub-snapshot-repo.test.ts",
      "src/skill-hub-artifact-repo.test.ts",
      "src/skill-hub-operation-repo.test.ts",
      "src/skill-hub-lifecycle-schema-parity.test.ts",
      "src/postgres-migration-integrity.test.ts",
    ],
  },
  {
    label: "Contracts typecheck and build",
    args: [...pnpmPrefix, "--filter", "@goatcitadel/contracts", "typecheck"],
  },
  {
    label: "Storage typecheck and build",
    args: [...pnpmPrefix, "--filter", "@goatcitadel/storage", "typecheck"],
  },
  {
    label:
      "Gateway production admission, callable-catalog, operator API, revocation hydration, and approved lifecycle runtime proof",
    args: [
      ...pnpmPrefix,
      "--filter",
      "@goatcitadel/gateway",
      "exec",
      "vitest",
      "run",
      "--reporter=dot",
      "src/services/callable-skill-activation.test.ts",
      "src/services/capability-system-service.loop32.test.ts",
      "src/services/skill-import-service.test.ts",
      "src/services/skill-hub-review-service.test.ts",
      "src/services/skill-hub-lifecycle-service.test.ts",
      "src/services/skill-hub-operator-service.test.ts",
      "src/routes/skills.test.ts",
    ],
  },
  {
    label: "Mission Control shared Skill Hub operator API client proof",
    args: [
      ...pnpmPrefix,
      "--filter",
      "@goatcitadel/mission-control-shared",
      "exec",
      "vitest",
      "run",
      "--reporter=dot",
      "src/api/skill-hub.test.ts",
    ],
  },
  {
    label: "Mission Control Skill Hub operator UI and workspace isolation proof",
    args: [
      ...pnpmPrefix,
      "--filter",
      "@goatcitadel/mission-control-next",
      "exec",
      "vitest",
      "run",
      "--reporter=dot",
      "src/features/native-routes/library/SkillHubOperatorPanel.test.tsx",
    ],
  },
  {
    label: "Mission Control shared typecheck",
    args: [...pnpmPrefix, "--filter", "@goatcitadel/mission-control-shared", "typecheck"],
  },
  {
    label: "Mission Control Next typecheck",
    args: [...pnpmPrefix, "--filter", "@goatcitadel/mission-control-next", "typecheck"],
  },
  {
    label: "Live PostgreSQL migration application (conditional)",
    skip: !livePostgresConfigured,
    args: [
      ...pnpmPrefix,
      "--filter",
      "@goatcitadel/storage",
      "exec",
      "tsx",
      "--test",
      "--test-name-pattern=real Postgres migrator/client lane applies migrations and writes through the client",
      "src/postgres/real-postgres.test.ts",
    ],
  },
  {
    label: "Gateway typecheck",
    args: [...pnpmPrefix, "--filter", "@goatcitadel/gateway", "typecheck"],
  },
];
const checkResults = [];
let sqliteHead;
let postgresHead;
let lifecycleMigrationPairFrozen = false;

try {
  const sqliteSource = await fs.readFile(path.join(repoRoot, "packages", "storage", "src", "sqlite.ts"), "utf8");
  const postgresSource = await fs.readFile(
    path.join(repoRoot, "packages", "storage", "src", "postgres", "migrations.ts"),
    "utf8",
  );
  sqliteHead = Math.max(...[...sqliteSource.matchAll(/version:\s*(\d+)/gu)].map((match) => Number(match[1])));
  postgresHead = Math.max(...[...postgresSource.matchAll(/version:\s*(\d+)/gu)].map((match) => Number(match[1])));
  lifecycleMigrationPairFrozen =
    /version:\s*165,\s*name:\s*"skill_hub_lifecycle_foundation"/u.test(sqliteSource) &&
    /version:\s*107,\s*name:\s*"skill_hub_lifecycle_foundation"/u.test(postgresSource);
  if (!lifecycleMigrationPairFrozen) {
    throw new Error("Skill Hub lifecycle foundation must remain frozen at SQLite 165/PostgreSQL 107.");
  }

  for (const [index, check] of checks.entries()) {
    process.stdout.write(`\n[${index + 1}/${checks.length}] ${check.label}\n`);
    if (check.skip) {
      checkResults.push({
        label: check.label,
        status: "skipped",
        reason: "GOATCITADEL_TEST_POSTGRES_URL is unset",
        durationMs: 0,
      });
      process.stdout.write("Skipped because GOATCITADEL_TEST_POSTGRES_URL is unset.\n");
      continue;
    }
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
        version: "skill_hub.lifecycle_proof.v1",
        lane: "verify:skill-hub:lifecycle",
        status: process.exitCode ? "failed" : "passed",
        startedAt: startedAt.toISOString(),
        finishedAt: new Date().toISOString(),
        migrationHeads: { sqlite: sqliteHead, postgres: postgresHead },
        lifecycleFoundationMigrationVersions: { sqlite: 165, postgres: 107 },
        lifecycleMigrationPairFrozen,
        noAdditionalMigrationRequiredByThisLane: true,
        livePostgres: livePostgresConfigured ? "executed" : "skipped_env_unset",
        checks: checkResults,
      },
      null,
      2,
    )}\n`,
    "utf8",
  );
  process.stdout.write(`\nSkill Hub lifecycle proof artifact: ${artifactRoot}\n`);
}

if (!process.exitCode) {
  process.stdout.write(
    livePostgresConfigured
      ? "\nSkill Hub lifecycle proof passed, including live PostgreSQL migration application.\n"
      : "\nSkill Hub lifecycle proof passed. Live PostgreSQL was conditionally skipped.\n",
  );
}
