export async function runDurableRecoveryLane(context, options = {}, deps) {
  const {
    clampString,
    emptyArtifacts,
    path,
    pnpmCommand,
    relativeToRun,
    repoRoot,
    requestJson,
    runCommand,
    runScenario,
    assertOk,
    startVerificationStack,
    stopProcess,
    stopVerificationStack,
    waitForDurableRunStatus,
    writeJson,
  } = deps;
  let stack = await startVerificationStack(context, {
    includeUi: false,
    gatewayEnv: {
      GOATCITADEL_DURABLE_FOUNDATION_ENABLED: "true",
      GOATCITADEL_FEATURE_DURABLE_KERNEL_V1_ENABLED: "true",
    },
  });
  try {
    await runScenario(
      context,
      {
        id: "durable-recovery.stack.approval-wait-restart-and-dlq",
        lane: "durable-recovery",
        title: "Stack-backed orphan restart and dead-letter recovery for approval wait flows",
        subsystem: "gateway",
      },
      async () => {
        const seeded = await requestJson(stack.gatewayUrl, "/api/v1/dev/verification/durable-recovery-seed", {
          method: "POST",
          body: {},
        });
        assertOk(seeded, "seed durable recovery verification state");
        const orphanRunId = seeded.body?.orphanRecovery?.runId;
        const deadLetterRunId = seeded.body?.deadLetterRecovery?.runId;
        const deadLetterId = seeded.body?.deadLetterRecovery?.deadLetterId;
        if (seeded.body?.orphanRecovery?.status !== "running") {
          throw new Error(
            `expected orphan durable run ${orphanRunId} to seed as running; got ${seeded.body?.orphanRecovery?.status ?? "unknown"}`,
          );
        }
        if (seeded.body?.deadLetterRecovery?.status !== "dead_lettered") {
          throw new Error(
            `expected dead-letter durable run ${deadLetterRunId} to seed as dead_lettered; got ${seeded.body?.deadLetterRecovery?.status ?? "unknown"}`,
          );
        }

        await stopProcess(stack.gateway);
        stack = await startVerificationStack(context, {
          runtimeRoot: stack.runtimeRoot,
          includeUi: false,
          gatewayEnv: {
            GOATCITADEL_DURABLE_FOUNDATION_ENABLED: "true",
            GOATCITADEL_FEATURE_DURABLE_KERNEL_V1_ENABLED: "true",
          },
        });

        const orphanAfterRestart = await waitForDurableRunStatus(stack.gatewayUrl, orphanRunId, ["completed"]);
        const orphanTimeline = await requestJson(
          stack.gatewayUrl,
          `/api/v1/durable/runs/${encodeURIComponent(orphanRunId)}/timeline?limit=50`,
        );
        assertOk(orphanTimeline, "read orphan durable run timeline");
        if (
          !Array.isArray(orphanTimeline.body?.items) ||
          !orphanTimeline.body.items.some((item) => item?.eventType === "run_started")
        ) {
          throw new Error(`expected orphan durable run ${orphanRunId} timeline to include run_started after restart`);
        }

        const deadLettersBeforeRecovery = await requestJson(stack.gatewayUrl, "/api/v1/durable/dead-letters?limit=20");
        assertOk(deadLettersBeforeRecovery, "list dead letters before recovery");

        const recoveredDeadLetter = await requestJson(
          stack.gatewayUrl,
          `/api/v1/durable/dead-letters/${encodeURIComponent(deadLetterId)}/recover`,
          {
            method: "POST",
            body: {},
          },
        );
        assertOk(recoveredDeadLetter, "recover durable dead letter");

        const deadLetterAfterRecovery = await waitForDurableRunStatus(stack.gatewayUrl, deadLetterRunId, ["completed"]);
        const deadLetterTimeline = await requestJson(
          stack.gatewayUrl,
          `/api/v1/durable/runs/${encodeURIComponent(deadLetterRunId)}/timeline?limit=50`,
        );
        assertOk(deadLetterTimeline, "read recovered dead-letter run timeline");
        if (
          !Array.isArray(deadLetterTimeline.body?.items) ||
          !deadLetterTimeline.body.items.some((item) => item?.eventType === "dead_letter_recovered")
        ) {
          throw new Error(`expected dead-letter run ${deadLetterRunId} timeline to include dead_letter_recovered`);
        }

        const outPath = path.join(context.artifactRoot, "diagnostics", "durable-recovery-stack-proof.json");
        await writeJson(outPath, {
          seeded: seeded.body,
          orphanSeededBeforeRestart: seeded.body?.orphanRecovery,
          deadLettersBeforeRecovery: deadLettersBeforeRecovery.body,
          orphanAfterRestart: orphanAfterRestart.body,
          orphanTimeline: orphanTimeline.body,
          recoveredDeadLetter: recoveredDeadLetter.body,
          deadLetterAfterRecovery: deadLetterAfterRecovery.body,
          deadLetterTimeline: deadLetterTimeline.body,
        });

        return {
          status: "passed",
          metrics: {
            orphanRunStatus: orphanAfterRestart.body?.status,
            deadLetterRunStatus: deadLetterAfterRecovery.body?.status,
            deadLetterId,
          },
          artifacts: emptyArtifacts({ diagnostics: [relativeToRun(context, outPath)] }),
        };
      },
    );
  } finally {
    await stopVerificationStack(stack);
  }

  const commands = [
    {
      id: "durable-recovery.gateway.worker-tests",
      title: "Durable worker restart, retry, and DLQ recovery tests",
      args: [
        "--filter",
        "@goatcitadel/gateway",
        "exec",
        "vitest",
        "run",
        "src/services/chat-durable-run-service.test.ts",
        "src/services/durable-run-service.test.ts",
      ],
    },
    {
      id: "durable-recovery.gateway.approval-wake-tests",
      title: "Approval wake and linked durable resume tests",
      args: [
        "--filter",
        "@goatcitadel/gateway",
        "exec",
        "vitest",
        "run",
        "src/services/approval-resolution-effects-service.test.ts",
      ],
    },
  ];

  for (const command of commands) {
    await runScenario(
      context,
      {
        id: command.id,
        lane: "durable-recovery",
        title: command.title,
        subsystem: "gateway",
      },
      async () => {
        const result = await runCommand(pnpmCommand(), command.args, {
          cwd: repoRoot,
          artifactRoot: path.join(context.artifactRoot, "diagnostics"),
          logName: command.id,
        });
        return {
          status: result.code === 0 ? "passed" : "failed",
          error: result.code === 0 ? undefined : clampString(result.stderr || result.stdout, 1200),
          metrics: {
            exitCode: result.code,
            durationMs: result.durationMs,
          },
          artifacts: {
            diagnostics: [],
            screenshots: [],
            traces: [],
            logs: [relativeToRun(context, result.stdoutPath), relativeToRun(context, result.stderrPath)],
            perf: [],
            playwright: [],
          },
        };
      },
    );
  }

}
