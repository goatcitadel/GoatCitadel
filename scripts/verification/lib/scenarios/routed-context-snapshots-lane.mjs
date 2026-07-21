export async function runRoutedContextSnapshotsLane(context, _options, deps) {
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

  const proofMatrixPath = path.join(context.artifactRoot, "diagnostics", "routed-context-snapshots-proof-matrix.json");
  await runScenario(
    context,
    {
      id: "routed-context-snapshots.proof-matrix",
      lane: "routed-context-snapshots",
      title: "Immutable routed-context snapshot proof matrix",
      subsystem: "chat-context",
    },
    async () => {
      await writeJson(proofMatrixPath, {
        generatedAt: new Date().toISOString(),
        invariants: [
          "strict Chat-only attachment and memory-item reference admission before persistence",
          "one bounded source resolution pass under effective workspace and frozen capability policy",
          "exact UTF-8 source attestation with deterministic rendered-token budgeting",
          "routed turns remain on one direct frozen provider route with subagents disabled",
          "atomic profile, snapshot, durable run, and narrow trace binding admission",
          "durable replay loads the frozen snapshot without resolving mutable sources again",
          "provider usage attempts retain snapshot, intent, and immutable resolution attribution",
          "operator inspection is scoped and source content never enters thread traces",
        ],
        sqliteMigration: 159,
        postgresMigration: 101,
        postgresProofConfigured: Boolean(process.env.GOATCITADEL_TEST_POSTGRES_URL?.trim()),
      });
      return {
        status: "passed",
        artifacts: emptyArtifacts({ diagnostics: [relativeToRun(context, proofMatrixPath)] }),
      };
    },
  );

  const commands = [
    {
      id: "routed-context-snapshots.storage",
      title: "Immutable snapshot repository and SQLite/PostgreSQL schema parity",
      subsystem: "storage",
      args: [
        "--filter",
        "@goatcitadel/storage",
        "exec",
        "tsx",
        "--test",
        "src/routed-context-snapshot-repo.test.ts",
        "src/routed-context-snapshot-schema-parity.test.ts",
      ],
    },
    {
      id: "routed-context-snapshots.gateway",
      title: "Admission, resolution, budget, durable replay, trace, inspection, and usage attribution",
      subsystem: "gateway",
      args: [
        "--filter",
        "@goatcitadel/gateway",
        "exec",
        "vitest",
        "run",
        "src/routes/chat.messages.test.ts",
        "src/services/chat-attachment-service.test.ts",
        "src/services/memory-lifecycle-service.test.ts",
        "src/services/chat-routed-context-service.test.ts",
        "src/services/chat-turn-prep-service.routed-context.test.ts",
        "src/services/chat-turn-entry-service.test.ts",
        "src/services/chat-turn-stream-service.test.ts",
        "src/services/chat-subagent-fanout-service.test.ts",
        "src/services/llm-service.contextwindow.test.ts",
        "src/services/durable-chat-routed-context.test.ts",
        "src/services/chat-durable-run-service.test.ts",
        "src/services/durable-execution-service.test.ts",
        "src/services/gateway-route-composition-chat.test.ts",
        "src/services/chat-turn-agent-runner.usage-accounting.test.ts",
      ],
    },
    {
      id: "routed-context-snapshots.threaded-surface",
      title: "Trace binding verification and scoped inspection refresh",
      subsystem: "threaded-surface-core",
      args: [
        "--filter",
        "@goatcitadel/threaded-surface-core",
        "exec",
        "vitest",
        "run",
        "src/chat/useChatCapabilityProfileInspection.test.tsx",
      ],
    },
    {
      id: "routed-context-snapshots.gateway-composition",
      title: "Gateway durable snapshot store and transaction composition",
      subsystem: "gateway",
      args: [
        "--filter",
        "@goatcitadel/gateway",
        "exec",
        "vitest",
        "run",
        "src/services/gateway-service.loop13-facade.test.ts",
        "-t",
        "forwards chat turn preparation",
      ],
    },
    {
      id: "routed-context-snapshots.mission-control",
      title: "Content-free routed-context operator receipt",
      subsystem: "mission-control-next",
      args: [
        "--filter",
        "@goatcitadel/mission-control-next",
        "exec",
        "vitest",
        "run",
        "src/features/threaded-surface/ChatCapabilityProfilePanel.test.tsx",
      ],
    },
    {
      id: "routed-context-snapshots.typecheck",
      title: "Routed-context contract and runtime package boundaries",
      subsystem: "contracts",
      args: [
        "--filter",
        "@goatcitadel/contracts",
        "--filter",
        "@goatcitadel/storage",
        "--filter",
        "@goatcitadel/gateway",
        "--filter",
        "@goatcitadel/threaded-surface-core",
        "--filter",
        "@goatcitadel/mission-control-next",
        "typecheck",
      ],
    },
  ];

  for (const command of commands) {
    await runScenario(
      context,
      {
        id: command.id,
        lane: "routed-context-snapshots",
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
      id: "routed-context-snapshots.postgres",
      lane: "routed-context-snapshots",
      title: "Real PostgreSQL migration and immutable snapshot proof",
      subsystem: "storage-postgres",
    },
    async () => {
      if (!process.env.GOATCITADEL_TEST_POSTGRES_URL?.trim()) {
        return {
          status: "skipped",
          notes: ["Set GOATCITADEL_TEST_POSTGRES_URL to execute the real PostgreSQL proof."],
          artifacts: emptyArtifacts(),
        };
      }
      const result = await runCommand(pnpmCommand(), ["--filter", "@goatcitadel/storage", "test:postgres"], {
        cwd: repoRoot,
        artifactRoot: path.join(context.artifactRoot, "diagnostics"),
        logName: "routed-context-snapshots.postgres",
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
