import { assertArtifactRedactionGate } from "../../../verify-artifact-redaction.mjs";

export const SELF_CONFIGURATION_LANE = "self-configuration";

export const SELF_CONFIGURATION_COMMANDS = Object.freeze([
  {
    id: "self-configuration.policy-owner-tests",
    title: "Official-search configuration policy and executor owner tests",
    subsystem: "policy-engine",
    args: [
      "--filter",
      "@goatcitadel/policy-engine",
      "exec",
      "vitest",
      "run",
      "src/tool-executor-runtime-configuration.test.ts",
      "src/research-search-official-providers.test.ts",
      "src/browser-tools.official-search.test.ts",
    ],
  },
  {
    id: "self-configuration.gateway-owner-fault-tests",
    title: "Gateway secure-submit, authorization, settlement, and fault tests",
    subsystem: "gateway",
    args: [
      "--filter",
      "@goatcitadel/gateway",
      "exec",
      "vitest",
      "run",
      "src/services/runtime-configuration-service.test.ts",
      "src/services/runtime-configuration-approval-binding.test.ts",
      "src/services/chat-secure-configuration-recovery-service.test.ts",
      "src/services/chat-message-route-runtime.test.ts",
      "src/services/chat-turn-agent-runner.loop24.test.ts",
      "src/routes/chat.routes.test.ts",
      "src/routes/chat.messages.commit-truth.test.ts",
      "src/app.rate-limit.test.ts",
      "src/plugins/idempotency.test.ts",
    ],
  },
  {
    id: "self-configuration.storage-durable-tests",
    title: "Durable secure-configuration reservation and schema-parity tests",
    subsystem: "storage",
    args: [
      "--filter",
      "@goatcitadel/storage",
      "exec",
      "tsx",
      "--test",
      "src/session-mutation-admission-repo.test.ts",
      "src/secure-configuration-reservation-schema-parity.test.ts",
      "src/postgres-migration-integrity.test.ts",
      "src/sqlite-migration-versioning.test.ts",
    ],
  },
  {
    id: "self-configuration.ui-secure-control-tests",
    title: "Secure Chat control, dedicated client route, and prompt-state tests",
    subsystem: "mission-control",
    args: [
      "--filter",
      "@goatcitadel/mission-control-shared",
      "exec",
      "vitest",
      "run",
      "src/components/chat/ChatPendingBlockingPanels.test.tsx",
      "src/api/chat.test.ts",
    ],
  },
  {
    id: "self-configuration.threaded-prompt-tests",
    title: "Threaded Chat pending-input projection tests",
    subsystem: "mission-control",
    args: [
      "--filter",
      "@goatcitadel/threaded-surface-core",
      "exec",
      "vitest",
      "run",
      "src/chat/chat-pending-user-input.test.ts",
    ],
  },
  {
    id: "self-configuration.contract-redaction-tests",
    title: "Secret-redaction and secure prompt contract tests",
    subsystem: "contracts",
    args: ["--filter", "@goatcitadel/contracts", "exec", "vitest", "run", "src/secret-redaction.test.ts"],
  },
  {
    id: "self-configuration.owner-typechecks",
    title: "Self-configuration owner package typechecks",
    subsystem: "workspace",
    args: [
      "--filter",
      "@goatcitadel/contracts",
      "--filter",
      "@goatcitadel/storage",
      "--filter",
      "@goatcitadel/policy-engine",
      "--filter",
      "@goatcitadel/gateway",
      "--filter",
      "@goatcitadel/mission-control-shared",
      "--filter",
      "@goatcitadel/threaded-surface-core",
      "run",
      "typecheck",
    ],
  },
]);

export const SELF_CONFIGURATION_HELD_ROWS = Object.freeze([
  {
    id: "live-provider-probe",
    status: "held",
    reason:
      "No retained provider-issued disposable credential and bounded real-provider probe evidence was supplied to this run.",
  },
  {
    id: "packaged-process-restart",
    status: "held",
    reason:
      "No retained packaged-process fault-injection evidence was supplied for apply, probe, settlement, rollback, and resume boundaries.",
  },
  {
    id: "browser-secure-input-journey",
    status: "held",
    reason:
      "No retained browser evidence proved blank-profile secure entry, field clearing, live verification, and same-turn continuation.",
  },
]);

export function buildSelfConfigurationProofMatrix(commandOutcomes = []) {
  return {
    schemaVersion: "goatcitadel.self-configuration-proof.v1",
    lane: "verify:self-configuration",
    result: "foundation_only",
    secretMaterialAccepted: false,
    hermeticRows: [
      {
        id: "typed-owner-policy",
        status: "exercised",
        scenarioRefs: ["self-configuration.policy-owner-tests"],
      },
      {
        id: "secure-submit-and-fault-boundaries",
        status: "exercised",
        scenarioRefs: ["self-configuration.gateway-owner-fault-tests"],
      },
      {
        id: "durable-reservation-and-schema",
        status: "exercised",
        scenarioRefs: ["self-configuration.storage-durable-tests"],
      },
      {
        id: "secure-chat-control",
        status: "exercised",
        scenarioRefs: ["self-configuration.ui-secure-control-tests", "self-configuration.threaded-prompt-tests"],
      },
      {
        id: "secret-redaction-contract",
        status: "exercised",
        scenarioRefs: ["self-configuration.contract-redaction-tests", "self-configuration.artifact-redaction"],
      },
    ],
    heldRows: SELF_CONFIGURATION_HELD_ROWS.map((row) => ({ ...row })),
    knownImplementationGaps: ["delegated-child-to-parent-resume", "remote-hardened-secret-custody"],
    commandOutcomes: commandOutcomes.map((outcome) => ({
      scenarioId: outcome.scenarioId,
      exitCode: outcome.exitCode,
    })),
    claimBoundary:
      "A successful hermetic command set proves the bounded source owners only. Held rows keep this run degraded and cannot be satisfied by mocks, saved-file checks, or model assertions.",
  };
}

export async function runSelfConfigurationLane(context, _options = {}, deps) {
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
  const commandOutcomes = [];

  for (const command of SELF_CONFIGURATION_COMMANDS) {
    await runScenario(
      context,
      {
        id: command.id,
        lane: SELF_CONFIGURATION_LANE,
        title: command.title,
        subsystem: command.subsystem,
      },
      async () => {
        const result = await runCommand(pnpmCommand(), command.args, {
          cwd: repoRoot,
          artifactRoot: path.join(context.artifactRoot, "diagnostics"),
          logName: command.id,
        });
        commandOutcomes.push({ scenarioId: command.id, exitCode: result.code });
        return {
          status: result.code === 0 ? "passed" : "failed",
          error: result.code === 0 ? undefined : clampString(result.stderr || result.stdout, 1_200),
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
      id: "self-configuration.acceptance-boundary",
      lane: SELF_CONFIGURATION_LANE,
      title: "Self-configuration parity acceptance boundary",
      subsystem: "release-proof",
    },
    async () => {
      const proof = buildSelfConfigurationProofMatrix(commandOutcomes);
      const outPath = path.join(context.artifactRoot, "diagnostics", "self-configuration-proof-matrix.json");
      await writeJson(outPath, proof);
      return {
        status: "degraded",
        notes: [
          "Live provider, packaged restart, and browser secure-input evidence are held, so this run proves foundations rather than shipped parity.",
        ],
        metrics: {
          hermeticRows: proof.hermeticRows.length,
          heldRows: proof.heldRows.length,
          secretMaterialAccepted: false,
        },
        artifacts: emptyArtifacts({ diagnostics: [relativeToRun(context, outPath)] }),
      };
    },
  );

  await runScenario(
    context,
    {
      id: "self-configuration.artifact-redaction",
      lane: SELF_CONFIGURATION_LANE,
      title: "Exact-root self-configuration artifact redaction gate",
      subsystem: "security",
    },
    async () => {
      await assertArtifactRedactionGate(context.artifactRoot);
      return {
        status: "passed",
        metrics: { exactRootScanned: true },
        artifacts: emptyArtifacts(),
      };
    },
  );
}
