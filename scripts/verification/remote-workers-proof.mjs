#!/usr/bin/env node
// verify:remote-workers — the integrated Phase-5 proof lane named across the
// HX-500/501B/503/505/506/507 packets (docs/OPENCLAW_HERMES_PARITY_PROGRAM.md
// rows HX-501..HX-507). It RUNS the already-committed, already-security-reviewed
// remote-worker owner proofs as 12 numbered scenarios and declares the
// genuinely two-machine / live-connected-worker scenarios (11-12) as documented
// conditional skips — the same posture HX-408's two-node mTLS row and the
// HX-411 session-control live-PG row use. This lane is a COMPOSITION gate: it
// adds no runtime behavior and re-implements no assertion already owned by a
// composed suite; it builds NO product code.
//
// The check table, 12-scenario proof matrix, static scans, count parsers with
// the zero-test honesty guard, and status derivations live in
// `lib/scenarios/remote-workers-lane.mjs` (unit-proven by its sibling test);
// this entrypoint owns process spawning, the hermetic PostgreSQL lifecycle, the
// scoped eslint/diff invocation, filesystem reads, the artifact, and the honest
// exit code.
//
// Live PostgreSQL is EXECUTED, never skipped (scenario 8): the lane honors a
// provided GOATCITADEL_TEST_POSTGRES_URL, otherwise it provisions a hermetic
// cluster (initdb/pg_ctl/psql; PGDATA in the OS temp directory, random
// identity-checked port in a band distinct from the other lanes, detached
// start, readiness-polled, fast-stopped and removed on teardown) and runs ALL
// seven remote-worker `.postgres.test.ts` owner suites against it with
// requireAllExecuted. If neither a URL nor local PostgreSQL binaries exist, the
// live-PG check FAILS. The lane's only declared skips are scenarios 11-12.
import { spawn, spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  REMOTE_WORKERS_LANE_ARTIFACTS,
  REMOTE_WORKER_LIVE_POSTGRES_SUITES,
  buildRemoteWorkersLaneChecks,
  buildRemoteWorkersProofMatrix,
  deriveCheckStatus,
  deriveRemoteWorkersLaneStatus,
  deriveRemoteWorkersRowStatuses,
  parseNodeTestCounts,
  parseVitestCounts,
  runRemoteWorkerStaticScans,
  stripAnsi,
} from "./lib/scenarios/remote-workers-lane.mjs";

const repoRoot = path.resolve(import.meta.dirname, "..", "..");
const isWindows = process.platform === "win32";
const windowsCmdPath = path.join(process.env.SystemRoot ?? "C:/Windows", "System32", "cmd.exe");
const startedAt = new Date();
const artifactRoot = path.join(
  repoRoot,
  "artifacts",
  "verification",
  `${startedAt.toISOString().replaceAll(":", "-").replace(".", "-")}-remote-workers-${randomBytes(4).toString("hex")}`,
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
// Remote-worker file collection: a self-contained recursive walk of the six
// package src roots, filtered to the remote-worker filename family. Feeds the
// byte-hygiene scan (all .ts/.tsx) and the eslint row (artifacts + source span).
// ---------------------------------------------------------------------------

const REMOTE_WORKER_SRC_ROOTS = [
  "packages/contracts/src",
  "packages/storage/src",
  "apps/gateway/src",
  "packages/policy-engine/src",
  "packages/mission-control-shared/src",
  "apps/mission-control-next/src",
];

const REMOTE_WORKER_FILENAME = /(^remote-worker|^remote-workers|^RemoteWorker|^useRemoteWorker|worker-cell-egress)/u;

const REMOTE_WORKER_MIGRATION_FILES = ["packages/storage/src/sqlite.ts", "packages/storage/src/postgres/migrations.ts"];

function walkFiles(absDir, relDir, out) {
  let entries;
  try {
    entries = fs.readdirSync(absDir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    const abs = path.join(absDir, entry.name);
    const rel = `${relDir}/${entry.name}`;
    if (entry.isDirectory()) {
      if (entry.name === "node_modules" || entry.name === "dist" || entry.name === "dist-node") continue;
      walkFiles(abs, rel, out);
    } else if (entry.isFile()) {
      out.push(rel);
    }
  }
}

function collectRemoteWorkerTsFiles() {
  const files = [];
  for (const root of REMOTE_WORKER_SRC_ROOTS) {
    const collected = [];
    walkFiles(path.join(repoRoot, root), root, collected);
    for (const rel of collected) {
      if (!/\.(ts|tsx)$/u.test(rel)) continue;
      if (REMOTE_WORKER_FILENAME.test(path.basename(rel))) files.push(rel);
    }
  }
  return files.sort();
}

function readFileRecords(paths) {
  return paths.map((relativePath) => ({
    path: relativePath,
    content: fs.readFileSync(path.join(repoRoot, relativePath), "utf8"),
  }));
}

function readByteRecords(paths) {
  return paths.map((relativePath) => ({
    path: relativePath,
    bytes: fs.readFileSync(path.join(repoRoot, relativePath)),
  }));
}

function runStaticScans(remoteWorkerTsFiles) {
  const ownerSource = remoteWorkerTsFiles.filter((rel) => !/\.test\.(ts|tsx)$/u.test(rel));
  const scan = runRemoteWorkerStaticScans({
    migrationFiles: readFileRecords(REMOTE_WORKER_MIGRATION_FILES),
    ownerFiles: readFileRecords(ownerSource),
    byteFiles: readByteRecords(remoteWorkerTsFiles),
    sqliteSource: fs.readFileSync(path.join(repoRoot, "packages/storage/src/sqlite.ts"), "utf8"),
    postgresSource: fs.readFileSync(path.join(repoRoot, "packages/storage/src/postgres/migrations.ts"), "utf8"),
    requiredSqlite: [176, 177, 178, 179],
    requiredPostgres: [118, 119, 120, 121],
  });
  return scan;
}

// ---------------------------------------------------------------------------
// Hermetic PostgreSQL lifecycle (the external-sources / mesh lanes' proven
// recipe for this host): initdb -U gcproof -A trust -E UTF8, detached pg_ctl
// start (a foreground pg_ctl start hangs Git-Bash shells here), psql readiness
// polling with a data-directory identity check, and pg_ctl stop -m fast on
// teardown. Docker is NOT the path (it hangs on this host).
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
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "gc-remote-workers-lane-pg-"));
  // Random port in a band based at 54334 (distinct from the other lanes'
  // bands): sequential lane runs must never share a port with a lingering
  // postmaster from a previous run.
  const port = 54_334 + (randomBytes(2).readUInt16BE(0) % 4_000);
  const tool = (name) => path.join(binDir, isWindows ? `${name}.exe` : name);
  const initdb = spawnSync(tool("initdb"), ["-D", dataDir, "-U", "gcproof", "-A", "trust", "-E", "UTF8"], {
    encoding: "utf8",
    windowsHide: true,
  });
  if (initdb.status !== 0) {
    return { error: `initdb failed (${initdb.status}): ${stripAnsi(initdb.stderr ?? "").slice(-400)}` };
  }
  // Durability settings are relaxed for this THROWAWAY cluster only. Scenario 8
  // runs seven owner suites whose every live test builds an isolated schema by
  // replaying the FULL migration ledger; with default fsync each replay costs
  // ~2 minutes of commit latency on this host, which alone exceeds the lane's
  // run budget. fsync/synchronous_commit/full_page_writes govern crash
  // durability, NOT transactional semantics — isolation, locking, advisory
  // locks, triggers, composite-FK enforcement and one-winner CAS (exactly what
  // these suites assert) are unchanged, and the cluster is destroyed on
  // teardown. max_connections is raised because the seven suites run
  // concurrently and each opens an admin pool plus per-connection clients.
  const serverOptions =
    `-p ${port} -c listen_addresses=127.0.0.1 ` +
    "-c fsync=off -c synchronous_commit=off -c full_page_writes=off -c max_connections=200";
  const started = spawn(
    tool("pg_ctl"),
    ["-D", dataDir, "-o", serverOptions, "-l", path.join(dataDir, "log.txt"), "start"],
    { detached: true, stdio: "ignore", windowsHide: true },
  );
  started.unref();
  const psqlArgs = (sql) => [
    "-h",
    "127.0.0.1",
    "-p",
    String(port),
    "-U",
    "gcproof",
    "-d",
    "postgres",
    "-tA",
    "-c",
    sql,
  ];
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

const remoteWorkerTsFiles = collectRemoteWorkerTsFiles();
const checks = buildRemoteWorkersLaneChecks();
const checkResults = new Map();

function recordResult(check, result) {
  checkResults.set(check.id, { id: check.id, title: check.title, ...result });
}

function printTailOnFailure(combined) {
  const tail = stripAnsi(combined).trim().split(/\r?\n/).slice(-14).join("\n");
  if (tail) process.stdout.write(`${tail.replace(/^/gm, "     | ")}\n`);
}

// Run one spawned command, parse its declared counter kind, and record an
// honest status. Returns the combined output so the live-PG branch can inspect
// it for the connection-reset retry signature. `command` lets the diff row
// drive `git` instead of pnpm; `count` is undefined for non-test rows so the
// zero-test guard applies only where a runner reports counts.
function runProcessCheck(check, { command = pnpmCommandName(), args, env = {}, logId } = {}) {
  const checkStartedAt = Date.now();
  const result = spawnChecked(command, args ?? check.args, env);
  writeCheckLogs(logId ?? check.id, result.stdout, result.stderr);
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
  if (derived.status !== "passed") printTailOnFailure(combined);
  return { status: derived.status, combined };
}

let livePostgresMode = "unavailable";
for (const [index, check] of checks.entries()) {
  process.stdout.write(`\n[check ${index + 1}/${checks.length}] ${check.id}\n  ${check.title}\n`);

  if (check.kind === "static-scans") {
    const checkStartedAt = Date.now();
    const { passed, detail } = runStaticScans(remoteWorkerTsFiles);
    fs.writeFileSync(path.join(logsRoot, `${check.id}.json`), `${JSON.stringify(detail, null, 2)}\n`, "utf8");
    recordResult(check, { status: passed ? "passed" : "failed", durationMs: Date.now() - checkStartedAt, detail });
    if (!passed) {
      const flagged = [
        ...detail.migrationSecrets.matches.map((m) => `raw-secret column ${m.file}:${m.line} ${m.text}`),
        ...detail.accountingMutation.matches.map((m) => `HX-306 mutation ${m.file}:${m.line} ${m.text}`),
        ...detail.controlBytes.matches.map((m) => `control byte 0x${m.byte.toString(16)} in ${m.file}@${m.offset}`),
        ...(detail.migrationContiguity.sqlite.passed
          ? []
          : [`sqlite migration non-linear: ${JSON.stringify(detail.migrationContiguity.sqlite)}`]),
        ...(detail.migrationContiguity.postgres.passed
          ? []
          : [`postgres migration non-linear: ${JSON.stringify(detail.migrationContiguity.postgres)}`]),
      ];
      for (const line of flagged) process.stdout.write(`     | ${line}\n`);
    }
    process.stdout.write(
      passed
        ? `  -> PASS (${detail.migrationSecrets.blocksScanned} remote_worker table blocks + ${detail.controlBytes.checkedFiles} source files clean; heads sqlite ${detail.currentDependencyMigrationHeads.sqlite} / postgres ${detail.currentDependencyMigrationHeads.postgres})\n`
        : "  -> FAIL (static scan matches found; see logs)\n",
    );
    continue;
  }

  if (check.kind === "eslint") {
    const targets = [...REMOTE_WORKERS_LANE_ARTIFACTS, ...remoteWorkerTsFiles];
    const outcome = runProcessCheck(check, { args: ["exec", "eslint", "--max-warnings", "0", ...targets] });
    const settled = checkResults.get(check.id);
    if (settled) checkResults.set(check.id, { ...settled, eslintTargets: targets.length });
    process.stdout.write(
      outcome.status === "passed"
        ? `  -> PASS (eslint clean over ${targets.length} files, --max-warnings 0)\n`
        : "  -> FAIL (eslint reported problems; see logs)\n",
    );
    continue;
  }

  if (check.kind === "diff") {
    const outcome = runProcessCheck(check, { command: "git", args: ["diff", "--check"] });
    process.stdout.write(
      outcome.status === "passed" ? "  -> PASS (no whitespace/conflict-marker errors)\n" : "  -> FAIL\n",
    );
    continue;
  }

  if (check.kind === "live-postgres") {
    const providedUrl = process.env.GOATCITADEL_TEST_POSTGRES_URL?.trim();
    const livePostgresArgs = [
      "--filter",
      "@goatcitadel/storage",
      "exec",
      "tsx",
      "--test",
      ...REMOTE_WORKER_LIVE_POSTGRES_SUITES.map((suite) => `src/${suite}`),
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
              `${provisioned.error} Scenario 8 requires live execution of all seven remote-worker owner ` +
              ".postgres.test.ts suites: provide GOATCITADEL_TEST_POSTGRES_URL or local PostgreSQL binaries.",
          });
          process.stdout.write(`  -> FAIL (${provisioned.error})\n`);
          outcome = { status: "failed", combined: "" };
          break;
        }
        url = provisioned.url;
        hermeticStop = provisioned.stop;
        livePostgresMode = "hermetic_cluster";
        process.stdout.write(`  hermetic cluster ready at ${url}\n`);
        process.stdout.write(
          `  running ${REMOTE_WORKER_LIVE_POSTGRES_SUITES.length} owner .postgres.test.ts suites...\n`,
        );
      }
      try {
        outcome = runProcessCheck(check, {
          args: livePostgresArgs,
          env: { GOATCITADEL_TEST_POSTGRES_URL: url },
          logId: "remote-workers.live-postgres",
        });
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
    if (settled) checkResults.set(check.id, { ...settled, livePostgresAttempts: attempt });
    process.stdout.write(
      settled?.status === "passed"
        ? `  -> PASS (live PostgreSQL executed: ${REMOTE_WORKER_LIVE_POSTGRES_SUITES.length} owner suites, ${settled.testsPassed ?? "?"} tests; attempts ${attempt})\n`
        : "  -> FAIL\n",
    );
    continue;
  }

  const outcome = runProcessCheck(check);
  const settled = checkResults.get(check.id);
  const seconds = ((settled.durationMs ?? 0) / 1000).toFixed(1);
  process.stdout.write(
    outcome.status === "passed"
      ? `  -> PASS${settled.testsPassed !== undefined ? ` (${settled.testsPassed} tests)` : ""} in ${seconds}s\n`
      : `  -> FAIL (exit ${settled.exitCode}${settled.failureNote ? `; ${settled.failureNote}` : ""}) in ${seconds}s\n`,
  );
}

const rowStatuses = deriveRemoteWorkersRowStatuses(buildRemoteWorkersProofMatrix(), checkResults);
const laneStatus = deriveRemoteWorkersLaneStatus(checkResults, rowStatuses);

process.stdout.write("\nIntegrated Phase-5 proof-matrix (12 scenarios):\n");
for (const row of rowStatuses) {
  const label =
    row.status === "executed"
      ? "PASS"
      : row.status === "executed_with_declared_skip"
        ? "PASS*"
        : row.status === "skipped_with_reason"
          ? "SKIP"
          : "FAIL";
  process.stdout.write(`  Scenario ${String(row.row).padStart(2)}: ${label} — ${row.title}\n`);
  if (row.skipReason) process.stdout.write(`      declared skip: ${row.skipReason}\n`);
  if (row.note) process.stdout.write(`      note: ${row.note}\n`);
  if (row.failedChecks) process.stdout.write(`      failed checks: ${row.failedChecks.join(", ")}\n`);
}

const staticDetail = checkResults.get("remote-workers.static-scans")?.detail;
const manifest = {
  version: "remote_workers_proof.v1",
  lane: "verify:remote-workers",
  packets: [
    "docs/review/HX_503_REMOTE_WORKER_INFERENCE_PACKET_2026-07-14.md",
    "docs/review/HX_505_REMOTE_WORKER_CELL_PACKET_2026-07-14.md",
    "docs/review/HX_506_REMOTE_WORKER_SETTLEMENT_PACKET_2026-07-14.md",
    "docs/review/HX_507_REMOTE_WORKER_VISIBILITY_PACKET_2026-07-14.md",
  ],
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
  remoteWorkerSourceFilesScanned: remoteWorkerTsFiles.length,
  checks: [...checkResults.values()].map(({ detail: _detail, ...row }) => row),
};
fs.writeFileSync(path.join(artifactRoot, "manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
fs.writeFileSync(
  path.join(artifactRoot, "remote-workers-proof-matrix.json"),
  `${JSON.stringify({ ...manifest, proofMatrix: rowStatuses }, null, 2)}\n`,
  "utf8",
);

process.stdout.write(`\nRemote workers proof artifact: ${artifactRoot}\n`);
process.stdout.write(`Live PostgreSQL: ${livePostgresMode}\n`);
process.stdout.write(
  `Scenarios: ${manifest.proofMatrixExecuted} executed / ${manifest.proofMatrixSkippedWithReason} skipped-with-reason / ${manifest.proofMatrixFailed} failed\n`,
);
process.stdout.write(`Status: ${laneStatus}\n`);
if (laneStatus !== "passed") process.exitCode = 1;
