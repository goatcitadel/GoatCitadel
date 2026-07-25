export async function runModelCouncilLane(context, _options, deps) {
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

  const proofMatrixPath = path.join(context.artifactRoot, "diagnostics", "model-council-proof-matrix.json");
  await runScenario(
    context,
    {
      id: "model-council.proof-matrix",
      lane: "model-council",
      title: "Chat model-council invariant proof matrix",
      subsystem: "assembly",
    },
    async () => {
      await writeJson(proofMatrixPath, {
        generatedAt: new Date().toISOString(),
        invariants: [
          "Council execution is captured once per enqueued Chat item and the composer arming clears immediately",
          "Every enqueued send, edit, and retry freezes bounded provider, model, reasoning, web, memory, and access prefs for preflight and dispatch",
          "participants resolve immutably against the governed execution profile and fail closed",
          "every participant and synthesis route reuses the exact admitted routed-context snapshot and history",
          "every route admits the actual provider messages plus worst-case participant and synthesis output before the first dispatch",
          "participants are advisory and read-only with no tools or mutation authority",
          "Assembly C0 through C3 renews generation leases around provider calls and asserts ownership before immutable writes",
          "Council rounds and artifacts allow only byte-equivalent canonical replay and reject conflicts or recovery tampering",
          "Recovery reconstructs all attempts, HX-306 event ids, tokens, and cost from validated durable evidence",
          "one canonical Chat answer is emitted while dissent and minority evidence remains inspectable",
          "every participant and synthesis provider call records HX-306 effective-provider attribution",
        ],
        sqliteMigration: 160,
        postgresMigration: 102,
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
      id: "model-council.storage",
      title: "Assembly council recovery repository and SQLite/PostgreSQL parity",
      subsystem: "storage",
      args: [
        "--filter",
        "@goatcitadel/storage",
        "exec",
        "tsx",
        "--test",
        "src/assembly-repo.test.ts",
        "src/model-council-schema-parity.test.ts",
      ],
    },
    {
      id: "model-council.gateway",
      title: "Fail-closed resolution, exact snapshot reuse, recovery, attribution, and one-answer projection",
      subsystem: "gateway",
      args: [
        "--filter",
        "@goatcitadel/gateway",
        "exec",
        "vitest",
        "run",
        "src/routes/chat.messages.test.ts",
        "src/services/assembly-service.test.ts",
        "src/services/chat-turn-stream-service.model-council.test.ts",
        "src/services/chat-turn-runtime-host-composition.test.ts",
        "src/services/gateway-service.chat-turn-runtime-host.test.ts",
      ],
    },
    {
      id: "model-council.threaded-surface",
      title: "Chat-only opt-in propagation through outbound execution",
      subsystem: "threaded-surface-core",
      args: [
        "--filter",
        "@goatcitadel/threaded-surface-core",
        "exec",
        "vitest",
        "run",
        "src/chat/useChatSurfaceOrchestration.test.tsx",
        "src/chat/useChatRoutePreflight.test.tsx",
        "src/chat/useChatOutboundExecution.test.tsx",
        "src/MissionThreadedControllerHost.test.tsx",
      ],
    },
    {
      id: "model-council.mission-control",
      title: "Explicit Council control inside the canonical Chat composer",
      subsystem: "mission-control-next",
      args: [
        "--filter",
        "@goatcitadel/mission-control-next",
        "exec",
        "vitest",
        "run",
        "src/features/threaded-surface/ThreadedComposer.test.tsx",
      ],
    },
    {
      id: "model-council.typecheck",
      title: "Council contract, persistence, runtime, and Chat surface boundaries",
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
        lane: "model-council",
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
}
