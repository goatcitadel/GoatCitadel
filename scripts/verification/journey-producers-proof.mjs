#!/usr/bin/env node
// HX-402 P5 journey-producers proof lane (remaining-producer audit
// docs/review/HX_402_REMAINING_PRODUCER_AUDIT_2026-07-14.md, section
// "### P5: shared wiring and release proof").
//
// `pnpm verify:journey:producers` — the program row's acceptance-evidence gate
// for the HX-402 P5 close. It is a COMPOSITION gate: it adds no runtime
// behavior and re-implements no assertion already owned by a composed suite.
// The check table, audit-P5 proof-matrix rows, count parsers with the zero-test
// honesty guard, format targets, and status derivations live in
// `lib/scenarios/journey-producers-lane.mjs` (unit-proven by its sibling test);
// this entrypoint owns process spawning, the hermetic PostgreSQL lifecycle, the
// scoped docs/format/diff tool invocation, the artifact, and the honest exit
// code.
//
// Live PostgreSQL is EXECUTED, never skipped: the lane honors a provided
// GOATCITADEL_TEST_POSTGRES_URL, otherwise it provisions a hermetic cluster
// (initdb/pg_ctl/psql; PGDATA in the OS temp directory, random identity-checked
// port, detached start, readiness-polled, fast-stopped and removed on
// teardown). If neither a URL nor local PostgreSQL binaries exist, the live-PG
// check FAILS — the audit calls an unexecuted live-PostgreSQL proof "not an
// optional release skip". The live-PG check runs BOTH the SQLite<->PostgreSQL
// 175/117 journey-producer schema-parity suite (requireAllExecuted, both
// governed owners) and the live memory-lifecycle governed-owner behavioural
// proof against the same cluster.
import { spawn, spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  JOURNEY_PRODUCERS_FORMAT_TARGETS,
  buildJourneyProducersLaneChecks,
  buildJourneyProducersProofMatrix,
  deriveCheckStatus,
  deriveJourneyProducerRowStatuses,
  deriveJourneyProducersLaneStatus,
  parseNodeTestCounts,
  parseVitestCounts,
  stripAnsi,
} from "./lib/scenarios/journey-producers-lane.mjs";

const repoRoot = path.resolve(import.meta.dirname, "..", "..");
const isWindows = process.platform === "win32";
const windowsCmdPath = path.join(process.env.SystemRoot ?? "C:/Windows", "System32", "cmd.exe");
const startedAt = new Date();
const artifactRoot = path.join(
  repoRoot,
  "artifacts",
  "verification",
  `${startedAt.toISOString().replaceAll(":", "-").replace(".", "-")}-journey-producers-${randomBytes(4).toString("hex")}`,
);
const logsRoot = path.join(artifactRoot, "logs");
fs.mkdirSync(logsRoot, { recursive: true });

function pnpmCommandName() {
  return isWindows ? "pnpm.cmd" : "pnpm";
}

function spawnCommand(command, args, envOverride = {}) {
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

function currentMigrationHeads() {
  const maxVersion = (relPath, label) => {
    const source = fs.readFileSync(path.join(repoRoot, relPath), "utf8");
    const versions = [...source.matchAll(/\bversion:\s*([0-9]+)\b/gu)].map((match) => Number(match[1]));
    if (versions.length === 0 || versions.some((version) => !Number.isSafeInteger(version) || version < 1)) {
      throw new Error(`${label} migration head could not be resolved.`);
    }
    return Math.max(...versions);
  };
  return {
    sqlite: maxVersion("packages/storage/src/sqlite.ts", "SQLite"),
    postgres: maxVersion("packages/storage/src/postgres/migrations.ts", "PostgreSQL"),
  };
}

// ---------------------------------------------------------------------------
// Hermetic PostgreSQL lifecycle (the external-sources / mesh lanes' proven
// recipe for this host): initdb -U gcproof -A trust -E UTF8, detached pg_ctl
// start (a foreground pg_ctl start hangs Git-Bash shells here), psql readiness
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
  // PGDATA lives in the OS temp directory, NOT under the repository: on this
  // Windows host, clusters under the repo tree intermittently lose backends
  // mid-migration (connection resets — the antivirus-scanning signature), while
  // temp-dir clusters run the identical suite reliably.
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "gc-hx402-lane-pg-"));
  // Random port: sequential lane runs must never share a port with a lingering
  // postmaster from a previous run.
  const port = 54_000 + (randomBytes(2).readUInt16BE(0) % 8_000);
  const tool = (name) => path.join(binDir, isWindows ? `${name}.exe` : name);
  const removeDataDir = () => {
    try {
      fs.rmSync(dataDir, { recursive: true, force: true, maxRetries: 5 });
    } catch {
      // best-effort: a wedged backend can briefly hold a handle on Windows.
    }
  };
  // Stop a (possibly half-started) postmaster and remove its PGDATA. Called on
  // every provisioning FAILURE path so a readiness-timeout / foreign-port /
  // initdb failure can never leak a lingering postmaster + temp cluster that
  // would collide with the next lane's hermetic cluster under the composed run.
  const teardownFailedCluster = (postmasterStarted) => {
    if (postmasterStarted) {
      spawnSync(tool("pg_ctl"), ["-D", dataDir, "-m", "immediate", "stop"], {
        encoding: "utf8",
        windowsHide: true,
        timeout: 30_000,
      });
    }
    removeDataDir();
  };
  const initdb = spawnSync(tool("initdb"), ["-D", dataDir, "-U", "gcproof", "-A", "trust", "-E", "UTF8"], {
    encoding: "utf8",
    windowsHide: true,
  });
  if (initdb.status !== 0) {
    removeDataDir();
    return { error: `initdb failed (${initdb.status}): ${stripAnsi(initdb.stderr ?? "").slice(-400)}` };
  }
  const started = spawn(
    tool("pg_ctl"),
    ["-D", dataDir, "-o", `-p ${port} -c listen_addresses=127.0.0.1`, "-l", path.join(dataDir, "log.txt"), "start"],
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
      teardownFailedCluster(true);
      return {
        error: `port 127.0.0.1:${port} is answered by a foreign PostgreSQL (data_directory ${reported}); refusing to run the proof against it.`,
      };
    }
    spawnSync(process.execPath, ["-e", "setTimeout(() => process.exit(0), 1000)"], { windowsHide: true });
  }
  if (!ready) {
    teardownFailedCluster(true);
    return { error: `hermetic PostgreSQL did not accept connections on 127.0.0.1:${port} within 60s.` };
  }
  return {
    url: `postgresql://gcproof@127.0.0.1:${port}/postgres`,
    stop: () => {
      spawnSync(tool("pg_ctl"), ["-D", dataDir, "-m", "fast", "stop"], {
        encoding: "utf8",
        windowsHide: true,
        timeout: 60_000,
      });
      removeDataDir();
    },
  };
}

// ---------------------------------------------------------------------------
// Execution.
// ---------------------------------------------------------------------------

const checks = buildJourneyProducersLaneChecks();
const checkResults = new Map();

function recordResult(check, result) {
  checkResults.set(check.id, { id: check.id, title: check.title, ...result });
}

// Run one spawned command, parse its declared counter kind, and derive an
// honest status. `command`/`args`/`env` let the live-PG branch drive both a
// pnpm+tsx run and a pnpm+vitest run against the same cluster.
function runProcessCheck(check, { command = pnpmCommandName(), args, env = {}, countKind = check.count, logId } = {}) {
  const checkStartedAt = Date.now();
  const result = spawnCommand(command, args ?? check.args, env);
  writeCheckLogs(logId ?? check.id, result.stdout, result.stderr);
  if (result.error) {
    return { status: "failed", error: String(result.error), combined: "", durationMs: Date.now() - checkStartedAt };
  }
  const combined = `${result.stdout ?? ""}\n${result.stderr ?? ""}`;
  const counts =
    countKind === "vitest"
      ? parseVitestCounts(combined)
      : countKind === "node-test"
        ? parseNodeTestCounts(combined)
        : undefined;
  const derived = deriveCheckStatus({
    exitCode: result.status ?? 1,
    countKind,
    counts,
    requireAllExecuted: check.requireAllExecuted === true,
  });
  return {
    ...derived,
    exitCode: result.status,
    ...(counts ? { testsPassed: counts.passed, testsFailed: counts.failed, testsSkipped: counts.skipped ?? 0 } : {}),
    combined,
    durationMs: Date.now() - checkStartedAt,
  };
}

function printTailOnFailure(combined) {
  const tail = stripAnsi(combined).trim().split(/\r?\n/).slice(-12).join("\n");
  if (tail) process.stdout.write(`${tail.replace(/^/gm, "     | ")}\n`);
}

// Standard spawn check (contracts/typecheck/storage-owners/producer vitest).
function runSpawnCheck(check) {
  const outcome = runProcessCheck(check);
  const { combined: _combined, ...record } = outcome;
  recordResult(check, record);
  if (outcome.status !== "passed") printTailOnFailure(outcome.combined ?? "");
  return outcome;
}

let livePostgresMode = "unavailable";
for (const [index, check] of checks.entries()) {
  process.stdout.write(`\n[check ${index + 1}/${checks.length}] ${check.id}\n  ${check.title}\n`);

  if (check.kind === "named-lane") {
    // Invoke the REAL named lane (verify:skill-learning / verify:skill-hub:lifecycle);
    // each carries its own internal honesty guards, so exit code is the signal.
    const outcome = runProcessCheck(check, { args: [check.script], countKind: undefined });
    const { combined: _combined, ...record } = outcome;
    recordResult(check, record);
    const seconds = ((outcome.durationMs ?? 0) / 1000).toFixed(1);
    if (outcome.status !== "passed") printTailOnFailure(outcome.combined ?? "");
    process.stdout.write(
      outcome.status === "passed"
        ? `  -> PASS (pnpm ${check.script}) in ${seconds}s\n`
        : `  -> FAIL (pnpm ${check.script} exit ${outcome.exitCode}) in ${seconds}s\n`,
    );
    continue;
  }

  if (check.kind === "docs") {
    // The governance-doc validator inside docs:check — a real named script.
    const outcome = runProcessCheck(check, {
      command: process.execPath,
      args: [check.nodeScript],
      countKind: undefined,
    });
    const { combined: _combined, ...record } = outcome;
    recordResult(check, record);
    if (outcome.status !== "passed") printTailOnFailure(outcome.combined ?? "");
    process.stdout.write(outcome.status === "passed" ? "  -> PASS (governance docs valid)\n" : "  -> FAIL\n");
    continue;
  }

  if (check.kind === "format") {
    // Real prettier binary, scoped to the lane's own new artifacts.
    const outcome = runProcessCheck(check, {
      args: ["exec", "prettier", "--check", ...JOURNEY_PRODUCERS_FORMAT_TARGETS],
      countKind: undefined,
    });
    const { combined: _combined, ...record } = outcome;
    recordResult(check, { ...record, formatTargets: JOURNEY_PRODUCERS_FORMAT_TARGETS });
    if (outcome.status !== "passed") printTailOnFailure(outcome.combined ?? "");
    process.stdout.write(
      outcome.status === "passed"
        ? `  -> PASS (${JOURNEY_PRODUCERS_FORMAT_TARGETS.length} lane artifacts formatted)\n`
        : "  -> FAIL (run prettier --write on the lane artifacts)\n",
    );
    continue;
  }

  if (check.kind === "diff") {
    const outcome = runProcessCheck(check, { command: "git", args: ["diff", "--check"], countKind: undefined });
    const { combined: _combined, ...record } = outcome;
    recordResult(check, record);
    if (outcome.status !== "passed") printTailOnFailure(outcome.combined ?? "");
    process.stdout.write(
      outcome.status === "passed" ? "  -> PASS (no whitespace/conflict-marker errors)\n" : "  -> FAIL\n",
    );
    continue;
  }

  if (check.kind === "live-postgres") {
    const providedUrl = process.env.GOATCITADEL_TEST_POSTGRES_URL?.trim();
    const schemaParityArgs = [
      "--filter",
      "@goatcitadel/storage",
      "exec",
      "tsx",
      "--test",
      "src/journey-producer-schema-parity.test.ts",
    ];
    const memoryBehaviourArgs = [
      "--filter",
      "@goatcitadel/gateway",
      "exec",
      "vitest",
      "run",
      "src/services/memory-lifecycle-service.real-postgres.test.ts",
    ];
    // Connection-reset signatures get ONE fresh-cluster re-attempt: on this host
    // a hermetic postmaster can sporadically lose backends to external
    // interference (AV-style file scanning), which is environmental, not a proof
    // failure. Genuine assertion failures never match and never retry.
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
              `${provisioned.error} The audit treats an unexecuted live-PostgreSQL proof as "not an optional release ` +
              'skip": provide GOATCITADEL_TEST_POSTGRES_URL or local PostgreSQL binaries.',
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
      const env = { GOATCITADEL_TEST_POSTGRES_URL: url };
      try {
        // (i) both governed owners' SQLite<->PostgreSQL DDL parity, live; the
        // requireAllExecuted guard forbids a self-skipped PostgreSQL side.
        process.stdout.write("  schema parity (both owners, live PostgreSQL)...\n");
        const schemaParity = runProcessCheck(check, {
          args: schemaParityArgs,
          env,
          countKind: "node-test",
          logId: "journey-producers.live-postgres.schema-parity",
        });
        // (ii) the governed P0 owner's live behavioural proof.
        process.stdout.write("  memory-lifecycle governed-owner behaviour (live PostgreSQL)...\n");
        const memoryBehaviour = runProcessCheck(
          { ...check, requireAllExecuted: false },
          {
            args: memoryBehaviourArgs,
            env,
            countKind: "vitest",
            logId: "journey-producers.live-postgres.memory-behaviour",
          },
        );
        const combined = `${schemaParity.combined ?? ""}\n${memoryBehaviour.combined ?? ""}`;
        const status = schemaParity.status === "passed" && memoryBehaviour.status === "passed" ? "passed" : "failed";
        outcome = { status, combined };
        recordResult(check, {
          status,
          schemaParity: {
            status: schemaParity.status,
            exitCode: schemaParity.exitCode,
            testsPassed: schemaParity.testsPassed,
            testsSkipped: schemaParity.testsSkipped,
            ...(schemaParity.failureNote ? { failureNote: schemaParity.failureNote } : {}),
          },
          memoryBehaviour: {
            status: memoryBehaviour.status,
            exitCode: memoryBehaviour.exitCode,
            testsPassed: memoryBehaviour.testsPassed,
            ...(memoryBehaviour.failureNote ? { failureNote: memoryBehaviour.failureNote } : {}),
          },
        });
        if (status !== "passed") printTailOnFailure(combined);
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
        ? `  -> PASS (live PostgreSQL executed: schema parity + memory behaviour; attempts ${attempt})\n`
        : "  -> FAIL\n",
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

const rowStatuses = deriveJourneyProducerRowStatuses(buildJourneyProducersProofMatrix(), checkResults);
const laneStatus = deriveJourneyProducersLaneStatus(checkResults, rowStatuses);

process.stdout.write("\nAudit P5 proof-matrix rows:\n");
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
  if (row.failedChecks) process.stdout.write(`      failed checks: ${row.failedChecks.join(", ")}\n`);
}

let migrationHeads;
try {
  migrationHeads = currentMigrationHeads();
} catch (error) {
  migrationHeads = { error: String(error) };
}

const manifest = {
  version: "journey_producers_proof.v1",
  lane: "verify:journey:producers",
  packet: "docs/review/HX_402_REMAINING_PRODUCER_AUDIT_2026-07-14.md",
  status: laneStatus,
  startedAt: startedAt.toISOString(),
  finishedAt: new Date().toISOString(),
  livePostgres: livePostgresMode,
  migrationChange: "none",
  currentDependencyMigrationHeads: migrationHeads,
  proofMatrixRows: rowStatuses.length,
  proofMatrixExecuted: rowStatuses.filter((row) => row.status === "executed").length,
  proofMatrixFailed: rowStatuses.filter((row) => row.status === "failed").length,
  proofMatrixSkippedWithReason: rowStatuses.filter((row) => row.status === "skipped_with_reason").length,
  proofMatrixFaked: 0,
  checks: [...checkResults.values()],
};
fs.writeFileSync(path.join(artifactRoot, "manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
fs.writeFileSync(
  path.join(artifactRoot, "journey-producers-proof-matrix.json"),
  `${JSON.stringify({ ...manifest, proofMatrix: rowStatuses }, null, 2)}\n`,
  "utf8",
);

process.stdout.write(`\nJourney producers proof artifact: ${artifactRoot}\n`);
process.stdout.write(`Live PostgreSQL: ${livePostgresMode}\n`);
process.stdout.write(`Status: ${laneStatus}\n`);
if (laneStatus !== "passed") process.exitCode = 1;
