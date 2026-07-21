import fs from "node:fs/promises";

// HX-411 Next-Tranche Packet, section "## Named proof": this lane combines storage
// parity, purpose-auth matrix, restart/worker-move recovery, shared-host drain,
// mutation classification, and late-callback proof for the production-dark session
// control foundation. It composes EXISTING proof (storage repo tests, gateway
// service tests, and the existing shared-host drain script) and adds no runtime
// behavior of its own. Per the packet's "## Non-goals", external control route
// registration, CLI, UI, and any release claim remain out of scope for this lane.
export async function runSessionControlLane(context, _options, deps) {
  const {
    clampString,
    emptyArtifacts,
    path,
    pnpmCommand,
    relativeToRun,
    repoRoot,
    runCommand,
    runScenario,
    writeJson,
  } = deps;
  const currentDependencyMigrationHeads = deps.readSessionControlMigrationHeads
    ? await deps.readSessionControlMigrationHeads()
    : await readMigrationHeads(repoRoot, path);

  const proofMatrixPath = path.join(context.artifactRoot, "diagnostics", "session-control-proof-matrix.json");
  await runScenario(
    context,
    {
      id: "session-control.proof-matrix",
      lane: "session-control",
      title: "HX-411 session-control named-proof matrix",
      subsystem: "session-control",
    },
    async () => {
      await writeJson(proofMatrixPath, {
        generatedAt: new Date().toISOString(),
        migrationChange: "none",
        featureMigrationPairs: {
          authRevokeLifecycleAdmission: { sqlite: 173, postgres: 115 },
          heartbeatOccurrenceAuthority: { sqlite: 174, postgres: 116 },
        },
        currentDependencyMigrationHeads,
        postgresProofConfigured: Boolean(process.env.GOATCITADEL_TEST_POSTGRES_URL?.trim()),
        namedProofAreas: [
          "storage parity",
          "purpose-auth matrix",
          "restart/worker-move recovery",
          "shared-host drain",
          "mutation classification",
          "late-callback proof",
        ],
        invariants: [
          "one canonical active-turn authority governs every session while an authenticated operator can atomically preempt a pre-bind or durable-bound system heartbeat",
          "metadata, generation one, and initialization evidence commit together under an explicit workspace, and every new admission requires an exact initialization or reactivation intent",
          "tree deletion locks the complete parent/side-chat tree, verifies operator ownership, cancels pending requests, and rolls back entirely on one external, corrupt, or missing descendant",
          "long-lived mutation admissions bind workspace, session, aggregate revision, controller generation, actor, and operation to a canonical material digest without storing the material",
          "the stored companion principal purpose is frozen to exactly two values and immutable across request, grant, session, exchange, and refresh, and no input can broaden it",
          "the production-dark SessionControlService is one stateless, storage-keyed domain service with no database transaction left open across provider, tool, command, filesystem, or stream work",
          "every mutation source is classified into exactly one of the eight vocabulary values and any new or unclassified source fails the inventory gate",
          "if the controller generation changes after an actual dispatch attempt, HX-305 effect truth and HX-306 usage/cost are preserved, no redispatch occurs, and only content-free late classification evidence is appended",
          "expired pre-bind recovery reclaims only the same active, unbound, occurrence-linked admission under the identical deterministic runtime owner and immutable request identity",
          "generic expired-admission cleanup excludes unresolved occurrence-linked admissions both before and after the session lock, and recovery runs before maintenance schedulers and every heartbeat sweep",
          "the shared-host lifecycle drains admission, entrypoint, health, cadence, and durable-run recovery with no schema migration introduced",
          "PostgreSQL 116 forward-repairs the capability-profile binding foreign key to one stable deferred constraint while SQLite 174 needs no equivalent repair",
        ],
        nonGoals: [
          "external control route registration",
          "CLI",
          "UI",
          "new Chat surface",
          "steer capability",
          "generic auth token",
          "payload/content storage",
          "second mutation owner",
          "transaction held across external work",
          "inferred operator ownership",
          "erased HX-305/HX-306 evidence",
          "automatic redispatch",
          "migration sharing",
          "release claim",
        ],
      });
      return {
        status: "passed",
        artifacts: emptyArtifacts({ diagnostics: [relativeToRun(context, proofMatrixPath)] }),
      };
    },
  );

  const commands = [
    {
      id: "session-control.storage",
      title: "Storage parity: session-control schema, lifecycle, control, and mutation-admission repositories",
      subsystem: "storage",
      args: [
        "--filter",
        "@goatcitadel/storage",
        "exec",
        "tsx",
        "--test",
        "src/session-control-schema-parity.test.ts",
        "src/chat-session-lifecycle-repo.test.ts",
        "src/chat-session-lifecycle-repo.postgres.test.ts",
        "src/session-control-repo.test.ts",
        "src/session-control-repo.postgres.test.ts",
        "src/session-mutation-admission-repo.test.ts",
        "src/session-mutation-admission-repo.postgres.test.ts",
      ],
    },
    {
      id: "session-control.purpose-auth-contracts",
      title: "Purpose-auth matrix: frozen companion principal purpose contract and non-broadening projections",
      subsystem: "contracts",
      args: [
        "--filter",
        "@goatcitadel/contracts",
        "exec",
        "vitest",
        "run",
        "src/auth.test.ts",
        "src/companion-auth.test.ts",
      ],
    },
    {
      id: "session-control.purpose-auth-gateway",
      title: "Purpose-auth matrix: purpose-scoped companion exchange and runtime identity classification",
      subsystem: "gateway",
      args: [
        "--filter",
        "@goatcitadel/gateway",
        "exec",
        "vitest",
        "run",
        "src/services/settings-auth-service.test.ts",
        "src/services/session-control-service.test.ts",
      ],
    },
    {
      id: "session-control.recovery",
      title: "Restart/worker-move recovery: expired-admission drain and interrupted-turn reconciliation",
      subsystem: "gateway",
      args: [
        "--filter",
        "@goatcitadel/gateway",
        "exec",
        "vitest",
        "run",
        "src/services/session-control-runtime-owner.test.ts",
        "src/services/chat-turn-interruption-recovery-service.test.ts",
        "src/services/chat-turn-interruption-recovery-service.postgres-dialect.test.ts",
      ],
    },
    {
      id: "session-control.mutation-classification",
      title: "Mutation classification: exhaustive source classifier and production callsite inventory",
      subsystem: "gateway",
      args: [
        "--filter",
        "@goatcitadel/gateway",
        "exec",
        "vitest",
        "run",
        "src/services/session-mutation-classification.test.ts",
        "src/services/session-mutation-source-inventory.test.ts",
      ],
    },
    {
      id: "session-control.late-callback-fence",
      title: "Late-callback proof: authority-bearing callback fencing before dispatch and durable-run mutation",
      subsystem: "gateway",
      args: [
        "--filter",
        "@goatcitadel/gateway",
        "exec",
        "vitest",
        "run",
        "src/services/chat-turn-dispatch-service.test.ts",
        "src/services/chat-turn-entry-service.test.ts",
        "src/services/durable-execution-service.test.ts",
      ],
    },
    {
      id: "session-control.shared-host-drain",
      title: "Shared-host drain: production-dark admission, entrypoint, health, cadence, and recovery proof",
      subsystem: "shared-host",
      // Reuses the existing `verify:shared-host:drain` script rather than duplicating
      // its checks; that script already composes the shared-host lifecycle, health,
      // shutdown, cron-reservation, and durable-run proof this lane needs to cite.
      args: ["verify:shared-host:drain"],
    },
    {
      id: "session-control.typecheck",
      title: "Session-control contract, persistence, and Gateway boundary typechecks",
      subsystem: "contracts",
      args: [
        "--filter",
        "@goatcitadel/contracts",
        "--filter",
        "@goatcitadel/storage",
        "--filter",
        "@goatcitadel/gateway",
        "typecheck",
      ],
    },
  ];

  for (const command of commands) {
    await runScenario(
      context,
      {
        id: command.id,
        lane: "session-control",
        title: command.title,
        subsystem: command.subsystem,
      },
      async () => {
        const result = await runCommand(pnpmCommand(), command.args, {
          cwd: repoRoot,
          artifactRoot: path.join(context.artifactRoot, "diagnostics"),
          logName: command.id,
        });
        return {
          status: result.code === 0 ? "passed" : "failed",
          error: result.code === 0 ? undefined : clampString(result.stderr || result.stdout, 1_500),
          metrics: { exitCode: result.code, durationMs: result.durationMs },
          artifacts: emptyArtifacts({
            logs: [relativeToRun(context, result.stdoutPath), relativeToRun(context, result.stderrPath)],
          }),
        };
      },
    );
  }

  await runScenario(
    context,
    {
      id: "session-control.postgres",
      lane: "session-control",
      title: "Storage parity: live PostgreSQL session-control repository and admission proof",
      subsystem: "storage-postgres",
    },
    async () => {
      if (!process.env.GOATCITADEL_TEST_POSTGRES_URL?.trim()) {
        return {
          status: "skipped",
          notes: [
            "Set GOATCITADEL_TEST_POSTGRES_URL to execute the real PostgreSQL proof. The session-control " +
              "*.postgres.test.ts repository cases self-skip individually; this scenario additionally proves " +
              "the broader real-Postgres concurrency suite.",
          ],
          artifacts: emptyArtifacts(),
        };
      }
      const result = await runCommand(pnpmCommand(), ["--filter", "@goatcitadel/storage", "test:postgres"], {
        cwd: repoRoot,
        artifactRoot: path.join(context.artifactRoot, "diagnostics"),
        logName: "session-control.postgres",
      });
      return {
        status: result.code === 0 ? "passed" : "failed",
        error: result.code === 0 ? undefined : clampString(result.stderr || result.stdout, 1_500),
        metrics: { exitCode: result.code, durationMs: result.durationMs },
        artifacts: emptyArtifacts({
          logs: [relativeToRun(context, result.stdoutPath), relativeToRun(context, result.stderrPath)],
        }),
      };
    },
  );
}

async function readMigrationHeads(repoRoot, path) {
  const [sqliteSource, postgresSource] = await Promise.all([
    fs.readFile(path.join(repoRoot, "packages", "storage", "src", "sqlite.ts"), "utf8"),
    fs.readFile(path.join(repoRoot, "packages", "storage", "src", "postgres", "migrations.ts"), "utf8"),
  ]);
  return {
    sqlite: maxDeclaredMigrationVersion(sqliteSource, "SQLite"),
    postgres: maxDeclaredMigrationVersion(postgresSource, "PostgreSQL"),
  };
}

function maxDeclaredMigrationVersion(source, label) {
  const versions = [...source.matchAll(/\bversion:\s*(\d+)\b/gu)].map((match) => Number(match[1]));
  if (versions.length === 0 || versions.some((version) => !Number.isSafeInteger(version) || version < 1)) {
    throw new Error(`${label} migration head could not be resolved.`);
  }
  return Math.max(...versions);
}
