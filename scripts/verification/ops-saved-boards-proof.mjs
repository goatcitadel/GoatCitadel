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
  `${startedAt.toISOString().replaceAll(":", "-").replace(".", "-")}-ops-saved-boards-${randomBytes(4).toString("hex")}`,
);
const proofPaths = [
  "package.json",
  "README.md",
  "packages/contracts/src/index.ts",
  "packages/contracts/src/ops-board.ts",
  "packages/contracts/src/ops-board.test.ts",
  "packages/storage/src/index.ts",
  "packages/storage/src/sqlite.ts",
  "packages/storage/src/postgres/migrations.ts",
  "packages/storage/src/postgres-migration-integrity.test.ts",
  "packages/storage/src/ops-saved-board-repo.ts",
  "packages/storage/src/ops-saved-board-repo.test.ts",
  "packages/storage/src/ops-saved-board-schema-parity.test.ts",
  "packages/storage/src/ops-saved-board-postgres.test.ts",
  "apps/gateway/src/services/ops-saved-board-service.ts",
  "apps/gateway/src/services/ops-saved-board-service.test.ts",
  "apps/gateway/src/services/gateway-route-services.ts",
  "apps/gateway/src/services/gateway-service.ts",
  "apps/gateway/src/routes/ops-boards.ts",
  "apps/gateway/src/routes/ops-boards.test.ts",
  "apps/gateway/src/app.ts",
  "apps/gateway/src/ops-saved-boards.integration.test.ts",
  "packages/mission-control-shared/src/api/ops-saved-boards.ts",
  "packages/mission-control-shared/src/api/ops-saved-boards.test.ts",
  "packages/mission-control-shared/src/api/index.ts",
  "apps/mission-control-next/src/app/ops-saved-board-realtime.ts",
  "apps/mission-control-next/src/app/ops-saved-board-realtime.test.ts",
  "apps/mission-control-next/src/app/use-event-stream.ts",
  "apps/mission-control-next/src/app/use-event-stream.notification-stability.test.tsx",
  "apps/mission-control-next/src/app/MissionControlNextApp.test.tsx",
  "apps/mission-control-next/src/styles/mission-control-next.css",
  "apps/mission-control-next/src/features/native-routes/NativeRoutePages.tsx",
  "apps/mission-control-next/src/features/native-routes/NativeRoutePages.coverage.test.tsx",
  "apps/mission-control-next/src/features/native-routes/native-routes.css",
  "apps/mission-control-next/src/features/native-routes/ops/OpsSavedBoardsEditor.tsx",
  "apps/mission-control-next/src/features/native-routes/ops/OpsSavedBoardsModel.ts",
  "apps/mission-control-next/src/features/native-routes/ops/OpsSavedBoardsModel.test.ts",
  "apps/mission-control-next/src/features/native-routes/ops/OpsSavedBoardsRoutePage.tsx",
  "apps/mission-control-next/src/features/native-routes/ops/OpsSavedBoardsRoutePage.test.tsx",
  "apps/mission-control-next/src/features/native-routes/ops/OpsSavedBoardsWidgets.tsx",
  "apps/mission-control-next/src/features/native-routes/styles/14-ops-saved-boards.css",
  "scripts/verification/lib/release-surface-manifest.mjs",
  "scripts/verification/lib/release-surface-manifest.test.mjs",
  "scripts/verification/lib/scenarios/surface-regression-lane.mjs",
  "scripts/verification/lib/scenarios/surface-regression-lane.test.mjs",
  "scripts/verification/lib/scenarios/visual-regression-lane.mjs",
  "scripts/verification/lib/scenarios/visual-regression-lane.test.mjs",
  "scripts/verification/lib/scenarios/fixture-seeding.mjs",
  "scripts/verification/lib/scenarios/fixture-seeding.test.mjs",
  "scripts/verification/ops-saved-boards-proof.mjs",
  "docs/1_0_RELEASE_SURFACE_SCOPE.md",
  "docs/1_0_RELEASE_EVIDENCE.md",
  "docs/review/HX_410_TRUSTED_OPS_BOARDS_PACKET_2026-07-14.md",
  "docs/OPENCLAW_HERMES_PARITY_PROGRAM.md",
];

const checks = [
  {
    label: "Trusted five-kind board contract and canonical layout validation",
    args: [
      ...pnpmPrefix,
      "--filter",
      "@goatcitadel/contracts",
      "exec",
      "vitest",
      "run",
      "--reporter=dot",
      "src/ops-board.test.ts",
    ],
  },
  {
    label: "SQLite repository, migration parity, and conditional PostgreSQL concurrency proof",
    args: [
      ...pnpmPrefix,
      "--filter",
      "@goatcitadel/storage",
      "exec",
      "tsx",
      "--test",
      "src/ops-saved-board-repo.test.ts",
      "src/ops-saved-board-schema-parity.test.ts",
      "src/ops-saved-board-postgres.test.ts",
      "src/postgres-migration-integrity.test.ts",
    ],
  },
  {
    label: "Gateway operator API, exact CAS, composition, and post-commit invalidation proof",
    args: [
      ...pnpmPrefix,
      "--filter",
      "@goatcitadel/gateway",
      "exec",
      "vitest",
      "run",
      "--reporter=dot",
      "src/services/ops-saved-board-service.test.ts",
      "src/routes/ops-boards.test.ts",
      "src/ops-saved-boards.integration.test.ts",
    ],
  },
  {
    label: "Typed no-store Mission Control client proof",
    args: [
      ...pnpmPrefix,
      "--filter",
      "@goatcitadel/mission-control-shared",
      "exec",
      "vitest",
      "run",
      "--reporter=dot",
      "src/api/ops-saved-boards.test.ts",
    ],
  },
  {
    label: "Saved-board model, workspace fencing, and compiled-widget route proof",
    args: [
      ...pnpmPrefix,
      "--filter",
      "@goatcitadel/mission-control-next",
      "exec",
      "vitest",
      "run",
      "--reporter=dot",
      "src/app/ops-saved-board-realtime.test.ts",
      "src/app/use-event-stream.notification-stability.test.tsx",
      "src/app/MissionControlNextApp.test.tsx",
      "src/features/native-routes/ops/OpsSavedBoardsModel.test.ts",
      "src/features/native-routes/ops/OpsSavedBoardsRoutePage.test.tsx",
    ],
  },
  {
    label: "Canonical release-surface manifest proof",
    args: [...pnpmPrefix, "exec", "node", "--test", "scripts/verification/lib/release-surface-manifest.test.mjs"],
  },
  {
    label: "Authenticated surface and visual harness proof",
    args: [
      ...pnpmPrefix,
      "exec",
      "node",
      "--test",
      "scripts/verification/lib/scenarios/fixture-seeding.test.mjs",
      "scripts/verification/lib/scenarios/surface-regression-lane.test.mjs",
      "scripts/verification/lib/scenarios/visual-regression-lane.test.mjs",
    ],
  },
  {
    label: "Contracts typecheck",
    args: [...pnpmPrefix, "--filter", "@goatcitadel/contracts", "typecheck"],
  },
  {
    label: "Storage typecheck",
    args: [...pnpmPrefix, "--filter", "@goatcitadel/storage", "typecheck"],
  },
  {
    label: "Gateway typecheck",
    args: [...pnpmPrefix, "--filter", "@goatcitadel/gateway", "typecheck"],
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
    label: "Governance and canonical surface documentation truth",
    args: [...pnpmPrefix, "docs:check"],
  },
  {
    label: "Scoped formatting",
    args: [...pnpmPrefix, "exec", "prettier", "--check", ...proofPaths],
  },
  {
    label: "Scoped whitespace and conflict-marker integrity",
    command: "git",
    args: ["diff", "--check", "--", ...proofPaths],
  },
  {
    label: "Responsive browser and runtime surface regression",
    args: [...pnpmPrefix, "verify:surface:regression"],
  },
  {
    label: "Desktop, laptop, narrow desktop, and mobile light/dark visual regression",
    args: [...pnpmPrefix, "verify:visual:regression"],
  },
];

const boardProductionFiles = [
  "apps/mission-control-next/src/app/ops-saved-board-realtime.ts",
  "apps/mission-control-next/src/app/use-event-stream.ts",
  "apps/mission-control-next/src/features/native-routes/ops/OpsSavedBoardsEditor.tsx",
  "apps/mission-control-next/src/features/native-routes/ops/OpsSavedBoardsModel.ts",
  "apps/mission-control-next/src/features/native-routes/ops/OpsSavedBoardsRoutePage.tsx",
  "apps/mission-control-next/src/features/native-routes/ops/OpsSavedBoardsWidgets.tsx",
];
const forbiddenProductionPatterns = [
  { label: "raw HTML renderer", pattern: /dangerouslySetInnerHTML/u },
  { label: "dynamic module renderer", pattern: /\bimport\s*\(/u },
  { label: "embedded remote URL", pattern: /https?:\/\//iu },
  { label: "iframe renderer", pattern: /<iframe\b/iu },
];

const checkResults = [];
let sqliteHead;
let postgresHead;
let migrationPairFrozen = false;
let compiledRegistrySentinelPassed = false;

try {
  const sqliteSource = await fs.readFile(path.join(repoRoot, "packages", "storage", "src", "sqlite.ts"), "utf8");
  const postgresSource = await fs.readFile(
    path.join(repoRoot, "packages", "storage", "src", "postgres", "migrations.ts"),
    "utf8",
  );
  sqliteHead = Math.max(...[...sqliteSource.matchAll(/version:\s*(\d+)/gu)].map((match) => Number(match[1])));
  postgresHead = Math.max(...[...postgresSource.matchAll(/version:\s*(\d+)/gu)].map((match) => Number(match[1])));
  migrationPairFrozen =
    /version:\s*167,\s*name:\s*"trusted_ops_saved_boards"/u.test(sqliteSource) &&
    /version:\s*109,\s*name:\s*"trusted_ops_saved_boards"/u.test(postgresSource);
  if (!migrationPairFrozen) {
    throw new Error("Saved Ops boards must remain frozen at SQLite 167/PostgreSQL 109.");
  }

  for (const relativePath of boardProductionFiles) {
    const source = await fs.readFile(path.join(repoRoot, relativePath), "utf8");
    for (const forbidden of forbiddenProductionPatterns) {
      if (forbidden.pattern.test(source)) {
        throw new Error(`${relativePath} contains forbidden ${forbidden.label}.`);
      }
    }
  }
  compiledRegistrySentinelPassed = true;

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
        version: "ops_saved_boards.proof.v1",
        lane: "verify:ops:saved-boards",
        status: process.exitCode ? "failed" : "passed",
        startedAt: startedAt.toISOString(),
        finishedAt: new Date().toISOString(),
        migrationHeads: { sqlite: sqliteHead, postgres: postgresHead },
        foundationMigrationVersions: { sqlite: 167, postgres: 109 },
        migrationPairFrozen,
        compiledRegistrySentinelPassed,
        livePostgres: livePostgresConfigured ? "executed" : "skipped_env_unset",
        checks: checkResults,
      },
      null,
      2,
    )}\n`,
    "utf8",
  );
  process.stdout.write(`\nSaved Ops boards proof artifact: ${artifactRoot}\n`);
}

if (!process.exitCode) {
  process.stdout.write(
    livePostgresConfigured
      ? "\nSaved Ops boards proof passed, including live PostgreSQL execution.\n"
      : "\nSaved Ops boards proof passed. Live PostgreSQL was conditionally skipped.\n",
  );
}
