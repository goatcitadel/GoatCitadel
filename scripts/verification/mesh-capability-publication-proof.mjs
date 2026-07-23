#!/usr/bin/env node
// HX-408 mesh-capability-publication proof lane (packet section "## Proof
// matrix", docs/review/HX_408_MESH_CAPABILITY_PUBLICATION_PACKET_2026-07-14.md).
//
// `pnpm verify:mesh:capability-publication` — the program row's
// acceptance-evidence gate for HX-408. It is a COMPOSITION gate: it adds no
// runtime behavior and re-implements no assertion already owned by a composed
// suite. The check table, packet proof-matrix row table, static scans, count
// parsers with the zero-test honesty guard, and status derivations live in
// `lib/scenarios/mesh-capability-publication-lane.mjs` (unit-proven by its
// sibling test); this entrypoint owns process spawning, the hermetic
// PostgreSQL lifecycle, the artifact, and the honest exit code.
//
// Live PostgreSQL is EXECUTED, never skipped: the lane honors a provided
// GOATCITADEL_TEST_POSTGRES_URL, otherwise it provisions a hermetic cluster
// (initdb/pg_ctl/psql; PGDATA in the OS temp directory, random
// identity-checked port, detached start, readiness-polled, fast-stopped and
// removed on teardown). If neither a URL nor local PostgreSQL binaries exist,
// the live-PG check FAILS. The lane's single declared skip is the packet's
// own conditional two-node mTLS proof (row 10), reported with its reason.
import { spawn, spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  buildMeshCapabilityLaneChecks,
  buildMeshCapabilityProofMatrix,
  deriveCheckStatus,
  deriveMeshLaneStatus,
  deriveMeshProofRowStatuses,
  parseNodeTestCounts,
  parseVitestCounts,
  runMeshCapabilityStaticScans,
  stripAnsi,
} from "./lib/scenarios/mesh-capability-publication-lane.mjs";

const repoRoot = path.resolve(import.meta.dirname, "..", "..");
const isWindows = process.platform === "win32";
const windowsCmdPath = path.join(process.env.SystemRoot ?? "C:/Windows", "System32", "cmd.exe");
const startedAt = new Date();
const artifactRoot = path.join(
  repoRoot,
  "artifacts",
  "verification",
  `${startedAt.toISOString().replaceAll(":", "-").replace(".", "-")}-mesh-capability-publication-${randomBytes(4).toString("hex")}`,
);
const logsRoot = path.join(artifactRoot, "logs");
fs.mkdirSync(logsRoot, { recursive: true });

function pnpmCommandName() {
  return isWindows ? "pnpm.cmd" : "pnpm";
}

function spawnChecked(command, args, envOverride = {}) {
  const spawnCommand = isWindows && /\.(cmd|bat)$/i.test(command) ? windowsCmdPath : command;
  const spawnArgs = isWindows && /\.(cmd|bat)$/i.test(command) ? ["/d", "/s", "/c", command, ...args] : args;
  return spawnSync(spawnCommand, spawnArgs, {
    cwd: repoRoot,
    env: { ...process.env, ...envOverride },
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
    windowsHide: true,
  });
}

function writeCheckLogs(id, stdout, stderr) {
  fs.writeFileSync(path.join(logsRoot, `${id}.stdout.log`), stdout ?? "", "utf8");
  fs.writeFileSync(path.join(logsRoot, `${id}.stderr.log`), stderr ?? "", "utf8");
}

// ---------------------------------------------------------------------------
// Static scans: real file contents feed the pure lib scan; migration heads
// are recorded as no-migration evidence.
// ---------------------------------------------------------------------------

function readFileRecords(paths) {
  return paths.map((relativePath) => ({
    path: relativePath,
    content: fs.readFileSync(path.join(repoRoot, relativePath), "utf8"),
  }));
}

function maxDeclaredMigrationVersion(source, label) {
  const versions = [...source.matchAll(/\bversion:\s*([0-9]+)\b/gu)].map((match) => Number(match[1]));
  if (versions.length === 0 || versions.some((version) => !Number.isSafeInteger(version) || version < 1)) {
    throw new Error(`${label} migration head could not be resolved.`);
  }
  return Math.max(...versions);
}

function runStaticScans() {
  const scan = runMeshCapabilityStaticScans({
    opsPanelFiles: readFileRecords(["apps/mission-control-next/src/features/native-routes/ops/MeshCapabilityPanel.tsx"]),
    opsClientFiles: readFileRecords([
      "packages/mission-control-shared/src/api/mesh-capabilities.ts",
      "packages/mission-control-shared/src/hooks/useMeshCapabilityOps.ts",
    ]),
    meshOwnerFiles: readFileRecords([
      "apps/gateway/src/services/mesh-capability-publication-service.ts",
      "apps/gateway/src/services/mesh-capability-activation-approval-service.ts",
      "apps/gateway/src/services/mesh-capability-activation-service.ts",
      "apps/gateway/src/services/mesh-capability-invocation-service.ts",
    ]),
  });
  const migrationHeads = {
    sqlite: maxDeclaredMigrationVersion(
      fs.readFileSync(path.join(repoRoot, "packages", "storage", "src", "sqlite.ts"), "utf8"),
      "SQLite",
    ),
    postgres: maxDeclaredMigrationVersion(
      fs.readFileSync(path.join(repoRoot, "packages", "storage", "src", "postgres", "migrations.ts"), "utf8"),
      "PostgreSQL",
    ),
  };
  return {
    passed: scan.passed,
    detail: {
      ...scan.detail,
      migrationChange: "none",
      currentDependencyMigrationHeads: migrationHeads,
    },
  };
}

// ---------------------------------------------------------------------------
// Hermetic PostgreSQL lifecycle (the external-sources lane's proven recipe
// for this host): initdb -U gcproof -A trust -E UTF8, detached pg_ctl start
// (a foreground pg_ctl start hangs Git-Bash shells here), psql readiness
// polling with a data-directory identity check, and pg_ctl stop -m fast on
// teardown.
// ---------------------------------------------------------------------------

function resolvePostgresBinDir() {
  const candidates = [
    process.env.GOATCITADEL_PG_BIN_DIR,
    "C:/Program Files/PostgreSQL/16/bin",
    "C:/Program Files/PostgreSQL/17/bin",
  ].filter(Boolean);
  for (const candidate of candidates) {
    if (fs.existsSync(path.join(candidate, isWindows ? "pg_ctl.exe" : "pg_ctl"))) return candidate;
  }
  const onPath = spawnSync(isWindows ? "where" : "which", ["pg_ctl"], { encoding: "utf8", windowsHide: true });
  if (onPath.status === 0) {
    const first = String(onPath.stdout ?? "")
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter(Boolean)[0];
    if (first) return path.dirname(first);
  }
  return undefined;
}

function provisionHermeticPostgres() {
  const binDir = resolvePostgresBinDir();
  if (!binDir) return { error: "No PostgreSQL binaries found (set GOATCITADEL_PG_BIN_DIR or install PostgreSQL 16)." };
  // PGDATA lives in the OS temp directory, NOT under the repository: clusters
  // under the repo tree intermittently lose backends mid-migration on this
  // host (antivirus-scanning signature), while temp-dir clusters are stable.
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "gc-hx408-lane-pg-"));
  // Random port: sequential lane runs must never share a port with a
  // lingering postmaster from a previous run.
  const port = 54_000 + (randomBytes(2).readUInt16BE(0) % 8_000);
  const tool = (name) => path.join(binDir, isWindows ? `${name}.exe` : name);
  const initdb = spawnSync(tool("initdb"), ["-D", dataDir, "-U", "gcproof", "-A", "trust", "-E", "UTF8"], {
    encoding: "utf8",
    windowsHide: true,
  });
  if (initdb.status !== 0) {
    return { error: `initdb failed (${initdb.status}): ${stripAnsi(initdb.stderr ?? "").slice(-400)}` };
  }
  const started = spawn(
    tool("pg_ctl"),
    ["-D", dataDir, "-o", `-p ${port} -c listen_addresses=127.0.0.1`, "-l", path.join(dataDir, "log.txt"), "start"],
    { detached: true, stdio: "ignore", windowsHide: true },
  );
  started.unref();
  const psqlArgs = (sql) => ["-h", "127.0.0.1", "-p", String(port), "-U", "gcproof", "-d", "postgres", "-tA", "-c", sql];
  const deadline = Date.now() + 60_000;
  let ready = false;
  while (Date.now() < deadline) {
    // Identity-checked readiness: the responding server must be OUR cluster,
    // not a stale postmaster that happens to hold the same port.
    const probe = spawnSync(tool("psql"), psqlArgs("SHOW data_directory"), { encoding: "utf8", windowsHide: true });
    if (probe.status === 0) {
      const reported = String(probe.stdout ?? "")
        .trim()
        .replaceAll("\\", "/")
        .toLowerCase();
      if (reported === dataDir.replaceAll("\\", "/").toLowerCase()) {
        ready = true;
        break;
      }
      return {
        error: `port 127.0.0.1:${port} is answered by a foreign PostgreSQL (data_directory ${reported}); refusing to run the proof against it.`,
      };
    }
    spawnSync(process.execPath, ["-e", "setTimeout(() => process.exit(0), 1000)"], { windowsHide: true });
  }
  if (!ready) {
    return { error: `hermetic PostgreSQL did not accept connections on 127.0.0.1:${port} within 60s.` };
  }
  return {
    url: `postgresql://gcproof@127.0.0.1:${port}/postgres`,
    stop: () => {
      spawnSync(tool("pg_ctl"), ["-D", dataDir, "-m", "fast", "stop"], { encoding: "utf8", windowsHide: true });
      fs.rmSync(dataDir, { recursive: true, force: true, maxRetries: 5 });
    },
  };
}

// ---------------------------------------------------------------------------
// Execution.
// ---------------------------------------------------------------------------

const checks = buildMeshCapabilityLaneChecks();
const checkResults = new Map();

function recordResult(check, result) {
  checkResults.set(check.id, { id: check.id, title: check.title, ...result });
}

function runSpawnCheck(check, envOverride = {}) {
  const checkStartedAt = Date.now();
  const result = spawnChecked(pnpmCommandName(), check.args, envOverride);
  writeCheckLogs(check.id, result.stdout, result.stderr);
  if (result.error) {
    recordResult(check, { status: "failed", error: String(result.error), durationMs: Date.now() - checkStartedAt });
    return { status: "failed", combined: "" };
  }
  const combined = `${result.stdout ?? ""}\n${result.stderr ?? ""}`;
  const counts =
    check.count === "vitest"
      ? parseVitestCounts(combined)
      : check.count === "node-test"
        ? parseNodeTestCounts(combined)
        : undefined;
  const derived = deriveCheckStatus({
    exitCode: result.status ?? 1,
    countKind: check.count,
    counts,
    requireAllExecuted: check.requireAllExecuted === true,
  });
  recordResult(check, {
    ...derived,
    exitCode: result.status,
    ...(counts ? { testsPassed: counts.passed, testsFailed: counts.failed, testsSkipped: counts.skipped ?? 0 } : {}),
    durationMs: Date.now() - checkStartedAt,
  });
  if (derived.status !== "passed") {
    const tail = stripAnsi(`${result.stderr ?? ""}\n${result.stdout ?? ""}`)
      .trim()
      .split(/\r?\n/)
      .slice(-12)
      .join("\n");
    process.stdout.write(`${tail.replace(/^/gm, "     | ")}\n`);
  }
  return { status: derived.status, combined };
}

let livePostgresMode = "unavailable";
for (const [index, check] of checks.entries()) {
  process.stdout.write(`\n[check ${index + 1}/${checks.length}] ${check.id}\n  ${check.title}\n`);

  if (check.kind === "static-scans") {
    const checkStartedAt = Date.now();
    const { passed, detail } = runStaticScans();
    fs.writeFileSync(path.join(logsRoot, `${check.id}.json`), `${JSON.stringify(detail, null, 2)}\n`, "utf8");
    recordResult(check, { status: passed ? "passed" : "failed", durationMs: Date.now() - checkStartedAt, detail });
    process.stdout.write(
      passed
        ? `  -> PASS (ops surface + mesh owners clean; heads sqlite ${detail.currentDependencyMigrationHeads.sqlite} / postgres ${detail.currentDependencyMigrationHeads.postgres})\n`
        : "  -> FAIL (static scan matches found; see logs)\n",
    );
    continue;
  }

  if (check.kind === "live-postgres") {
    const providedUrl = process.env.GOATCITADEL_TEST_POSTGRES_URL?.trim();
    const storageTestArgs = [
      "--filter",
      "@goatcitadel/storage",
      "exec",
      "tsx",
      "--test",
      "src/mesh-capability-publication-repo.postgres.test.ts",
    ];
    // Connection-reset signatures get ONE fresh-cluster re-attempt: on this
    // host a hermetic postmaster can sporadically lose backends to external
    // interference (AV-style file scanning), which is environmental, not a
    // proof failure. Genuine assertion failures never match and never retry.
    const connectionResetPattern =
      /ECONNRESET|Connection terminated|server closed the connection|terminated unexpectedly/iu;
    const maxAttempts = providedUrl ? 1 : 2;
    let attempt = 0;
    let hermeticStop;
    let outcome;
    while (attempt < maxAttempts) {
      attempt += 1;
      let url = providedUrl;
      if (url) {
        livePostgresMode = "provided_env_url";
        process.stdout.write("  using provided GOATCITADEL_TEST_POSTGRES_URL\n");
      } else {
        process.stdout.write(`  provisioning hermetic PostgreSQL cluster (attempt ${attempt}/${maxAttempts})...\n`);
        const provisioned = provisionHermeticPostgres();
        if (provisioned.error) {
          recordResult(check, {
            status: "failed",
            failureNote:
              `${provisioned.error} The packet's SQLite/PostgreSQL parity row requires live execution: provide ` +
              "GOATCITADEL_TEST_POSTGRES_URL or local PostgreSQL binaries.",
          });
          process.stdout.write(`  -> FAIL (${provisioned.error})\n`);
          outcome = { status: "failed", combined: "" };
          break;
        }
        url = provisioned.url;
        hermeticStop = provisioned.stop;
        livePostgresMode = "hermetic_cluster";
        process.stdout.write(`  hermetic cluster ready at ${url}\n`);
      }
      try {
        outcome = runSpawnCheck({ ...check, args: storageTestArgs }, { GOATCITADEL_TEST_POSTGRES_URL: url });
      } finally {
        if (hermeticStop) {
          try {
            hermeticStop();
          } catch (error) {
            process.stdout.write(`  (hermetic PostgreSQL teardown warning: ${String(error)})\n`);
          }
          hermeticStop = undefined;
        }
      }
      if (outcome.status === "passed" || attempt >= maxAttempts) break;
      if (!connectionResetPattern.test(outcome.combined)) break;
      process.stdout.write(
        "  connection-reset signature detected (environmental interference); retrying once on a fresh cluster...\n",
      );
    }
    const settled = checkResults.get(check.id);
    if (settled) {
      checkResults.set(check.id, { ...settled, livePostgresAttempts: attempt });
    }
    process.stdout.write(
      settled?.status === "passed" ? `  -> PASS (live PostgreSQL executed; attempts ${attempt})\n` : "  -> FAIL\n",
    );
    continue;
  }

  runSpawnCheck(check);
  const settled = checkResults.get(check.id);
  const seconds = ((settled.durationMs ?? 0) / 1000).toFixed(1);
  process.stdout.write(
    settled.status === "passed"
      ? `  -> PASS${settled.testsPassed !== undefined ? ` (${settled.testsPassed} tests)` : ""} in ${seconds}s\n`
      : `  -> FAIL (exit ${settled.exitCode}${settled.failureNote ? `; ${settled.failureNote}` : ""}) in ${seconds}s\n`,
  );
}

const rowStatuses = deriveMeshProofRowStatuses(buildMeshCapabilityProofMatrix(), checkResults);
const laneStatus = deriveMeshLaneStatus(checkResults, rowStatuses);

process.stdout.write("\nHX-408 packet proof-matrix rows:\n");
for (const row of rowStatuses) {
  const label =
    row.status === "executed"
      ? "PASS"
      : row.status === "executed_with_declared_skip"
        ? "PASS*"
        : row.status === "skipped_with_reason"
          ? "SKIP"
          : "FAIL";
  process.stdout.write(`  Row ${String(row.row).padStart(2)}: ${label} — ${row.title}\n`);
  if (row.skipReason) process.stdout.write(`      declared skip: ${row.skipReason}\n`);
  if (row.note) process.stdout.write(`      note: ${row.note}\n`);
  if (row.failedChecks) process.stdout.write(`      failed checks: ${row.failedChecks.join(", ")}\n`);
}

const staticDetail = checkResults.get("mesh-publication.static-scans")?.detail;
const manifest = {
  version: "mesh_capability_publication_proof.v1",
  lane: "verify:mesh:capability-publication",
  packet: "docs/review/HX_408_MESH_CAPABILITY_PUBLICATION_PACKET_2026-07-14.md",
  status: laneStatus,
  startedAt: startedAt.toISOString(),
  finishedAt: new Date().toISOString(),
  livePostgres: livePostgresMode,
  migrationChange: "none",
  currentDependencyMigrationHeads: staticDetail?.currentDependencyMigrationHeads,
  proofMatrixRows: rowStatuses.length,
  proofMatrixExecuted: rowStatuses.filter((row) => row.status === "executed").length,
  proofMatrixFailed: rowStatuses.filter((row) => row.status === "failed").length,
  proofMatrixSkippedWithReason: rowStatuses.filter((row) => row.status === "skipped_with_reason").length,
  proofMatrixFaked: 0,
  checks: [...checkResults.values()].map(({ detail: _detail, ...row }) => row),
};
fs.writeFileSync(path.join(artifactRoot, "manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
fs.writeFileSync(
  path.join(artifactRoot, "mesh-capability-publication-proof-matrix.json"),
  `${JSON.stringify({ ...manifest, proofMatrix: rowStatuses }, null, 2)}\n`,
  "utf8",
);

process.stdout.write(`\nMesh capability publication proof artifact: ${artifactRoot}\n`);
process.stdout.write(`Live PostgreSQL: ${livePostgresMode}\n`);
process.stdout.write(`Status: ${laneStatus}\n`);
if (laneStatus !== "passed") process.exitCode = 1;
