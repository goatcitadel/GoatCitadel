import { assertArtifactRedactionGate } from "../../../verify-artifact-redaction.mjs";
import { runSelfConfigurationLane } from "./self-configuration-lane.mjs";

export const CHAT_EVOLUTION_LANE = "chat-evolution";

export const CHAT_EVOLUTION_COMMANDS = Object.freeze([
  {
    id: "chat-evolution.contract-and-model-tool",
    title: "Bounded Change Plan contract and first-party model tool",
    subsystem: "contracts-policy",
    cwd: "packages/contracts",
    args: [
      "exec", "node", "../../node_modules/vitest/vitest.mjs", "run", "src/change-plan.test.ts",
    ],
  },
  {
    id: "chat-evolution.policy-model-tool",
    title: "Model tool schema, origin, and secret-free result enforcement",
    subsystem: "policy-engine",
    cwd: "packages/policy-engine",
    args: [
      "exec", "node", "../../node_modules/vitest/vitest.mjs", "run",
      "src/tool-registry.test.ts", "src/tool-executor-change-request.test.ts",
    ],
  },
  {
    id: "chat-evolution.gateway-control-plane",
    title: "Gateway lifecycle, adapters, secure custody, recovery, and route enforcement",
    subsystem: "gateway",
    cwd: "apps/gateway",
    args: [
      "exec", "node", "../../node_modules/vitest/vitest.mjs", "run",
      "src/services/evolution-control-plane-service.test.ts",
      "src/services/evolution-control-plane-governance.test.ts",
      "src/services/model-change-plan-adapter.test.ts",
      "src/services/runtime-configuration-change-plan-adapter.test.ts",
      "src/services/provider-connection-change-plan-adapter.test.ts",
      "src/services/channel-connection-change-plan-adapter.test.ts",
      "src/services/channel-secret-custody-service.test.ts",
      "src/services/capability-candidate-change-plan-adapter.test.ts",
      "src/services/improvement-candidate-change-plan-adapter.test.ts",
      "src/services/runtime-remediation-change-plan-adapter.test.ts",
      "src/services/managed-source-install-service.test.ts",
      "src/services/product-source-update-service.test.ts",
      "src/services/product-source-update-change-plan-adapter.test.ts",
      "src/services/product-source-apply-supervisor.test.ts",
      "src/routes/change-plans.test.ts",
      "src/routes/chat.change-plans.test.ts",
      "src/routes/dashboard.settings.test.ts",
      "src/routes/secrets.test.ts",
      "src/routes/capabilities.test.ts",
      "src/routes/improvement.test.ts",
      "src/routes/integrations-channel-setup.loop22.test.ts",
    ],
  },
  {
    id: "chat-evolution.storage-parity",
    title: "Change Plan, source-update, and migration parity persistence",
    subsystem: "storage",
    cwd: "packages/storage",
    args: [
      "exec", "node", "../../node_modules/tsx/dist/cli.mjs", "--test",
      "src/change-plan-repo.test.ts",
      "src/managed-source-install-repo.test.ts",
      "src/product-source-update-repo.test.ts",
      "src/postgres-migrator.test.ts",
      "src/sqlite-migration-versioning.test.ts",
    ],
  },
  {
    id: "chat-evolution.chat-controls",
    title: "Persistent Chat plan card, exact modal, structured actions, and receipts",
    subsystem: "mission-control",
    cwd: "packages/mission-control-shared",
    args: [
      "exec", "node", "../../node_modules/vitest/vitest.mjs", "run",
      "src/components/chat/ChatChangePlanCard.test.tsx",
      "src/components/chat/ChatChangePlanActionDialog.test.tsx",
      "src/api/chat.test.ts",
    ],
  },
  {
    id: "chat-evolution.settings-channel-controls",
    title: "Guided setup, provider custody, and Settings-to-Chat channel handoff",
    subsystem: "mission-control-next",
    cwd: "apps/mission-control-next",
    args: [
      "exec", "node", "../../node_modules/vitest/vitest.mjs", "run",
      "src/features/native-routes/SettingsNativePage.test.tsx",
      "src/features/native-routes/settings/channel-setup/ChannelSetupWizard.test.tsx",
    ],
  },
  {
    id: "chat-evolution.desktop-and-installer-boundary",
    title: "Windows helper packaging and packaged-update refusal boundary",
    subsystem: "desktop-installer",
    args: [
      "exec", "node", "--test",
      "scripts/packaging/build-windows-host.test.mjs",
      "scripts/packaging/packaged-update-guard.test.mjs",
    ],
  },
]);

export const CHAT_EVOLUTION_HELD_ROWS = Object.freeze([
  {
    id: "real-provider-onboarding",
    reason: "No disposable real-provider credential and retained provider-issued verification evidence was supplied.",
  },
  {
    id: "browser-secure-input",
    reason: "No retained browser trace proves blank-install secure entry and first-Chat continuation without transcript leakage.",
  },
  {
    id: "windows-source-restart-rollback",
    reason: "Hermetic helper fault tests do not replace retained desktop process-exit, restart, smoke, and automatic restore evidence.",
  },
  {
    id: "signed-packaged-update",
    reason: "Packaged-patch refusal is tested, but no publisher-verified signed installer promotion evidence was supplied.",
  },
]);

export function buildChatEvolutionProofMatrix(commandOutcomes = []) {
  return {
    schemaVersion: "goatcitadel.chat-evolution-proof.v1",
    lane: "verify:chat-evolution",
    extends: "verify:self-configuration",
    result: "foundation_only",
    hermeticRows: [
      "durable-change-plan-lifecycle",
      "bounded-model-tool",
      "settings-chat-owner-parity",
      "secure-owner-custody",
      "capability-and-improvement-governance",
      "managed-source-staging-and-fault-recovery",
      "packaged-generated-patch-refusal",
    ].map((id) => ({ id, status: "exercised" })),
    heldRows: CHAT_EVOLUTION_HELD_ROWS.map((row) => ({ ...row, status: "held" })),
    commandOutcomes: commandOutcomes.map((outcome) => ({
      scenarioId: outcome.scenarioId,
      exitCode: outcome.exitCode,
    })),
    claimBoundary:
      "Passing hermetic rows prove the governed source owners only. Product claims remain held until the real-provider, browser, desktop restart/rollback, and signed-installer rows have retained evidence.",
  };
}

export async function runChatEvolutionLane(context, options = {}, deps) {
  await runSelfConfigurationLane(context, options, deps);
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

  for (const command of CHAT_EVOLUTION_COMMANDS) {
    await runScenario(context, {
      id: command.id,
      lane: CHAT_EVOLUTION_LANE,
      title: command.title,
      subsystem: command.subsystem,
    }, async () => {
      const result = await runCommand(pnpmCommand(), command.args, {
        cwd: command.cwd ? path.join(repoRoot, command.cwd) : repoRoot,
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
    });
  }

  await runScenario(context, {
    id: "chat-evolution.acceptance-boundary",
    lane: CHAT_EVOLUTION_LANE,
    title: "Chat-driven evolution acceptance boundary",
    subsystem: "release-proof",
  }, async () => {
    const proof = buildChatEvolutionProofMatrix(commandOutcomes);
    const outPath = path.join(context.artifactRoot, "diagnostics", "chat-evolution-proof-matrix.json");
    await writeJson(outPath, proof);
    return {
      status: "degraded",
      notes: ["Four real-runtime evidence rows remain held, so public claims stay intentionally narrower than the source implementation."],
      metrics: { hermeticRows: proof.hermeticRows.length, heldRows: proof.heldRows.length },
      artifacts: emptyArtifacts({ diagnostics: [relativeToRun(context, outPath)] }),
    };
  });

  await runScenario(context, {
    id: "chat-evolution.artifact-redaction",
    lane: CHAT_EVOLUTION_LANE,
    title: "Exact-root Chat evolution artifact redaction gate",
    subsystem: "security",
  }, async () => {
    await assertArtifactRedactionGate(context.artifactRoot);
    return { status: "passed", metrics: { exactRootScanned: true }, artifacts: emptyArtifacts() };
  });
}
