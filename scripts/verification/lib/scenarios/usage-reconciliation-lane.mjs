export async function runUsageReconciliationLane(context, _options, deps) {
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

  const proofMatrixPath = path.join(context.artifactRoot, "diagnostics", "usage-reconciliation-proof-matrix.json");
  await runScenario(
    context,
    {
      id: "usage-reconciliation.proof-matrix",
      lane: "usage-reconciliation",
      title: "Canonical usage reconciliation proof matrix",
      subsystem: "usage-accounting",
    },
    async () => {
      await writeJson(proofMatrixPath, {
        generatedAt: new Date().toISOString(),
        invariants: [
          "one canonical row per real provider transport attempt",
          "unknown usage remains nullable and distinct from exact zero",
          "workspace-scoped operator reconciliation records actor and evidence",
          "startup and periodic recovery preserve live PostgreSQL ownership",
          "worker, assembly, utility, embedding, image, repair, fallback, and tool-loop attribution remains inspectable",
        ],
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
      id: "usage-reconciliation.storage",
      title: "Canonical storage, parity, reconciliation, and recovery",
      subsystem: "storage",
      args: [
        "--filter",
        "@goatcitadel/storage",
        "exec",
        "tsx",
        "--test",
        "src/model-usage-event-repo.test.ts",
        "src/model-usage-schema-parity.test.ts",
        "src/cost-ledger-repo.test.ts",
      ],
    },
    {
      id: "usage-reconciliation.gateway-core-accounting",
      title: "Canonical accounting ownership",
      subsystem: "gateway-core",
      args: ["--filter", "@goatcitadel/gateway-core", "exec", "tsx", "--test", "src/model-usage-accounting.test.ts"],
    },
    {
      id: "usage-reconciliation.gateway-core-ingest",
      title: "Canonical ingest ownership",
      subsystem: "gateway-core",
      args: ["--filter", "@goatcitadel/gateway-core", "exec", "vitest", "run", "src/event-ingest.test.ts"],
    },
    {
      id: "usage-reconciliation.gateway",
      title: "Gateway transport, worker, assembly, utility, and operator attribution",
      subsystem: "gateway",
      args: [
        "--filter",
        "@goatcitadel/gateway",
        "exec",
        "vitest",
        "run",
        "src/routes/costs.test.ts",
        "src/routes/llm.test.ts",
        "src/routes/turns.test.ts",
        "src/services/costs-route-service.test.ts",
        "src/services/gateway-route-composition-loop15.test.ts",
        "src/services/llm-service.usage-accounting.test.ts",
        "src/services/llm-completion-service.test.ts",
        "src/services/chat-turn-agent-runner.usage-accounting.test.ts",
        "src/services/chat-turn-stream-service.test.ts",
        "src/services/chat-turn-dispatch-service.loop31.test.ts",
        "src/services/chat-delegation-service.budget.test.ts",
        "src/services/assembly-service.test.ts",
        "src/orchestration/engine.test.ts",
        "src/services/stream-idle-watchdog.test.ts",
        "src/services/utility-model-call.test.ts",
        "src/services/utility-model-usage-attribution.test.ts",
      ],
    },
    {
      id: "usage-reconciliation.gateway-runner-consumer-return",
      title: "Gateway consumer-return settlement and cancellation ownership",
      subsystem: "gateway",
      args: [
        "--filter",
        "@goatcitadel/gateway",
        "exec",
        "vitest",
        "run",
        "src/services/chat-turn-agent-runner.test.ts",
        "-t",
        "closes the heartbeat wrapper promptly|surfaces dispatch uncertainty|surfaces authoritative usage settlement",
      ],
    },
    {
      id: "usage-reconciliation.embedding",
      title: "Embedding attempt attribution and settlement",
      subsystem: "policy-engine",
      args: [
        "--filter",
        "@goatcitadel/policy-engine",
        "exec",
        "vitest",
        "run",
        "src/embedding-runtime-hooks.test.ts",
        "src/local-embeddings.test.ts",
      ],
    },
    {
      id: "usage-reconciliation.mission-control",
      title: "Mission Control exact-zero, unknown-usage, and provider aggregation truth",
      subsystem: "mission-control-next",
      args: [
        "--filter",
        "@goatcitadel/mission-control-next",
        "exec",
        "vitest",
        "run",
        "src/features/native-routes/ops/RuntimeRoutePage.test.tsx",
      ],
    },
    {
      id: "usage-reconciliation.typecheck",
      title: "Usage reconciliation package type boundaries",
      subsystem: "contracts",
      args: [
        "--filter",
        "@goatcitadel/contracts",
        "--filter",
        "@goatcitadel/storage",
        "--filter",
        "@goatcitadel/gateway-core",
        "--filter",
        "@goatcitadel/policy-engine",
        "--filter",
        "@goatcitadel/orchestration",
        "--filter",
        "@goatcitadel/gateway",
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
        lane: "usage-reconciliation",
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
      id: "usage-reconciliation.postgres-concurrency",
      lane: "usage-reconciliation",
      title: "Real PostgreSQL recovery ownership concurrency",
      subsystem: "storage-postgres",
    },
    async () => {
      if (!process.env.GOATCITADEL_TEST_POSTGRES_URL?.trim()) {
        return {
          status: "skipped",
          notes: ["Set GOATCITADEL_TEST_POSTGRES_URL to execute the real PostgreSQL lock/CAS proof."],
          artifacts: emptyArtifacts(),
        };
      }
      const result = await runCommand(pnpmCommand(), ["--filter", "@goatcitadel/storage", "test:postgres"], {
        cwd: repoRoot,
        artifactRoot: path.join(context.artifactRoot, "diagnostics"),
        logName: "usage-reconciliation.postgres-concurrency",
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
