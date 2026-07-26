import assert from "node:assert/strict";
import path from "node:path";
import { test } from "node:test";

import { runSessionControlLane } from "./session-control-lane.mjs";

const EXPECTED_SCENARIO_IDS = [
  "session-control.proof-matrix",
  "session-control.storage",
  "session-control.contract-vocabulary",
  "session-control.purpose-auth-contracts",
  "session-control.purpose-auth-gateway",
  "session-control.route-access",
  "session-control.protocol",
  "session-control.external-send",
  "session-control.recovery",
  "session-control.mutation-classification",
  "session-control.late-callback-fence",
  "session-control.event-stream",
  "session-control.cli",
  "session-control.shared-client",
  "session-control.surface-banner",
  "session-control.operator-ui",
  "session-control.logger-redaction",
  "session-control.runtime-ux-redaction",
  "session-control.shared-host-drain",
  "session-control.typecheck",
  "session-control.browser-proof",
  "session-control.postgres",
];

function makeDeps({ commands, definitions, results, writes }) {
  return {
    clampString: (value) => value,
    emptyArtifacts: (overrides = {}) => ({
      diagnostics: [],
      screenshots: [],
      traces: [],
      logs: [],
      perf: [],
      playwright: [],
      ...overrides,
    }),
    path,
    pnpmCommand: () => "pnpm",
    readSessionControlMigrationHeads: async () => ({ sqlite: 174, postgres: 116 }),
    relativeToRun: (_context, value) => path.relative("artifacts/session-control", value).replaceAll("\\", "/"),
    repoRoot: "repo",
    runCommand: async (command, args, options) => {
      commands.push({ command, args, options });
      return {
        code: 0,
        durationMs: 1,
        stdoutPath: path.join("artifacts/session-control", "diagnostics", `${options.logName}.stdout.log`),
        stderrPath: path.join("artifacts/session-control", "diagnostics", `${options.logName}.stderr.log`),
      };
    },
    runScenario: async (_context, definition, fn) => {
      definitions.push(definition);
      const result = await fn();
      if (results) results.push({ id: definition.id, result });
      return result;
    },
    writeJson: async (targetPath, payload) => {
      if (writes) writes.push({ targetPath, payload });
    },
  };
}

test("session-control lane composes the full 28-scenario required-proof matrix with visible CI-gated skips", async () => {
  const definitions = [];
  const commands = [];
  const results = [];
  const writes = [];
  const context = { artifactRoot: "artifacts/session-control" };
  const previousPostgresUrl = process.env.GOATCITADEL_TEST_POSTGRES_URL;
  delete process.env.GOATCITADEL_TEST_POSTGRES_URL;
  try {
    await runSessionControlLane(context, {}, makeDeps({ commands, definitions, results, writes }));
  } finally {
    if (previousPostgresUrl === undefined) delete process.env.GOATCITADEL_TEST_POSTGRES_URL;
    else process.env.GOATCITADEL_TEST_POSTGRES_URL = previousPostgresUrl;
  }

  assert.deepEqual(
    definitions.map((definition) => definition.id),
    EXPECTED_SCENARIO_IDS,
  );
  assert.ok(
    definitions.every((definition) => definition.lane === "session-control"),
    "every scenario declares the session-control lane",
  );

  // Only the proof-matrix scenario writes a diagnostics artifact.
  assert.equal(writes.length, 1, "only the proof-matrix scenario writes a diagnostics artifact");
  const matrix = writes[0].payload;
  assert.deepEqual(matrix.featureMigrationPairs, {
    authRevokeLifecycleAdmission: { sqlite: 173, postgres: 115 },
    heartbeatOccurrenceAuthority: { sqlite: 174, postgres: 116 },
  });
  assert.deepEqual(matrix.currentDependencyMigrationHeads, { sqlite: 174, postgres: 116 });
  assert.equal(matrix.postgresProofConfigured, false);

  // The 28-scenario spec map is present, complete, and honest: every row is either
  // executed or skipped-with-reason, nothing is faked, and the two CI-gated scenarios
  // (27 browser, 28 live-Postgres when unset) are the only skips.
  assert.equal(matrix.specScenarioCount, 28);
  assert.equal(matrix.specProofMatrix.length, 28);
  assert.deepEqual(
    matrix.specProofMatrix.map((row) => row.scenario),
    Array.from({ length: 28 }, (_value, index) => index + 1),
    "the proof matrix covers scenarios 1..28 contiguously",
  );
  assert.equal(matrix.specScenariosFaked, 0);
  for (const row of matrix.specProofMatrix) {
    assert.ok(["executed", "skipped"].includes(row.status), `scenario ${row.scenario} has a valid status`);
    assert.ok(Array.isArray(row.proof) && row.proof.length > 0, `scenario ${row.scenario} names proof scenarios`);
    if (row.status === "skipped") {
      assert.ok(
        typeof row.skipReason === "string" && row.skipReason.trim().length > 0,
        `skipped scenario ${row.scenario} carries a reason`,
      );
    }
  }
  const executed = matrix.specProofMatrix.filter((row) => row.status === "executed").map((row) => row.scenario);
  const skipped = matrix.specProofMatrix.filter((row) => row.status === "skipped").map((row) => row.scenario);
  assert.deepEqual(skipped, [27, 28], "only scenario 27 (browser) and 28 (live-Postgres, unset) skip");
  assert.equal(executed.length, 26);
  assert.equal(matrix.specScenariosExecuted, 26);
  assert.equal(matrix.specScenariosSkippedWithReason, 2);
  // Every executed spec scenario must reference at least one lane scenario that actually ran.
  const ranScenarioIds = new Set(definitions.map((definition) => definition.id));
  for (const row of matrix.specProofMatrix) {
    if (row.status !== "executed") continue;
    assert.ok(
      row.proof.some((laneId) => ranScenarioIds.has(laneId)),
      `executed scenario ${row.scenario} maps to a lane scenario that ran`,
    );
  }

  // The CI-gated scenarios are visibly skipped in the scenario stream, not silently omitted.
  const browser = results.find((entry) => entry.id === "session-control.browser-proof");
  assert.equal(browser.result.status, "skipped", "browser proof is skipped, never passed");
  assert.ok(
    browser.result.notes.some((note) => note.includes("runs on CI")),
    "browser skip states its reason",
  );
  const postgres = results.find((entry) => entry.id === "session-control.postgres");
  assert.equal(postgres.result.status, "skipped", "live PostgreSQL proof is skipped when the URL is unset");
  assert.ok(
    postgres.result.notes.some((note) => note.includes("GOATCITADEL_TEST_POSTGRES_URL")),
    "PostgreSQL skip states its reason",
  );

  // 19 command scenarios run through the shared runCommand loop; browser-proof and the
  // gated postgres scenario do not invoke runCommand when skipped.
  assert.equal(commands.length, 19, "browser and PostgreSQL scenarios do not invoke runCommand when skipped");

  const byLogName = new Map(commands.map((command) => [command.options.logName, command]));

  const storageCommand = byLogName.get("session-control.storage");
  assert.deepEqual(storageCommand.args.slice(0, 4), ["--filter", "@goatcitadel/storage", "exec", "tsx"]);
  assert.ok(
    storageCommand.args.includes("--test-concurrency=1"),
    "migration-rewinding live PostgreSQL files execute serially against the shared proof database",
  );
  assert.ok(storageCommand.args.includes("src/session-control-schema-parity.test.ts"));
  assert.ok(storageCommand.args.includes("src/chat-session-lifecycle-repo.test.ts"));
  assert.ok(storageCommand.args.includes("src/session-control-repo.test.ts"));
  assert.ok(storageCommand.args.includes("src/session-mutation-admission-repo.test.ts"));

  const contractVocabularyCommand = byLogName.get("session-control.contract-vocabulary");
  assert.deepEqual(contractVocabularyCommand.args, [
    "--filter",
    "@goatcitadel/contracts",
    "exec",
    "vitest",
    "run",
    "src/session-control.test.ts",
  ]);

  const purposeAuthContractsCommand = byLogName.get("session-control.purpose-auth-contracts");
  assert.deepEqual(purposeAuthContractsCommand.args, [
    "--filter",
    "@goatcitadel/contracts",
    "exec",
    "vitest",
    "run",
    "src/auth.test.ts",
    "src/companion-auth.test.ts",
  ]);

  const purposeAuthGatewayCommand = byLogName.get("session-control.purpose-auth-gateway");
  assert.ok(purposeAuthGatewayCommand.args.includes("src/services/settings-auth-service.test.ts"));
  assert.ok(purposeAuthGatewayCommand.args.includes("src/services/session-control-service.test.ts"));

  const routeAccessCommand = byLogName.get("session-control.route-access");
  assert.ok(routeAccessCommand.args.includes("src/routes/route-access.test.ts"));
  assert.ok(routeAccessCommand.args.includes("src/routes/session-control.test.ts"));

  const protocolCommand = byLogName.get("session-control.protocol");
  assert.ok(protocolCommand.args.includes("src/services/session-control-service.protocol.test.ts"));

  const externalSendCommand = byLogName.get("session-control.external-send");
  assert.ok(externalSendCommand.args.includes("src/services/chat-turn-entry-service.external-companion.test.ts"));

  const recoveryCommand = byLogName.get("session-control.recovery");
  assert.ok(recoveryCommand.args.includes("src/services/session-control-runtime-owner.test.ts"));
  assert.ok(recoveryCommand.args.includes("src/services/chat-turn-interruption-recovery-service.test.ts"));
  assert.ok(
    recoveryCommand.args.includes("src/services/chat-turn-interruption-recovery-service.postgres-dialect.test.ts"),
  );

  const mutationClassificationCommand = byLogName.get("session-control.mutation-classification");
  assert.ok(mutationClassificationCommand.args.includes("src/services/session-mutation-classification.test.ts"));
  assert.ok(mutationClassificationCommand.args.includes("src/services/session-mutation-source-inventory.test.ts"));

  const lateCallbackFenceCommand = byLogName.get("session-control.late-callback-fence");
  assert.ok(lateCallbackFenceCommand.args.includes("src/services/chat-turn-dispatch-service.test.ts"));
  assert.ok(lateCallbackFenceCommand.args.includes("src/services/chat-turn-entry-service.test.ts"));
  assert.ok(lateCallbackFenceCommand.args.includes("src/services/durable-execution-service.test.ts"));

  const eventStreamCommand = byLogName.get("session-control.event-stream");
  assert.ok(eventStreamCommand.args.includes("src/routes/session-control-event-stream.test.ts"));

  const cliCommand = byLogName.get("session-control.cli");
  assert.deepEqual(cliCommand.args, [
    "--filter",
    "@goatcitadel/gateway",
    "exec",
    "vitest",
    "run",
    "src/session-control-cli.test.ts",
  ]);

  const sharedClientCommand = byLogName.get("session-control.shared-client");
  assert.deepEqual(sharedClientCommand.args.slice(0, 2), ["--filter", "@goatcitadel/mission-control-shared"]);
  assert.ok(sharedClientCommand.args.includes("src/api/session-control.test.ts"));
  assert.ok(sharedClientCommand.args.includes("src/api/session-control-operator.test.ts"));

  const surfaceBannerCommand = byLogName.get("session-control.surface-banner");
  assert.deepEqual(surfaceBannerCommand.args.slice(0, 2), ["--filter", "@goatcitadel/threaded-surface-core"]);
  assert.ok(surfaceBannerCommand.args.includes("src/chat/session-control-banner.test.ts"));

  const operatorUiCommand = byLogName.get("session-control.operator-ui");
  assert.deepEqual(operatorUiCommand.args.slice(0, 2), ["--filter", "@goatcitadel/mission-control-next"]);
  assert.ok(operatorUiCommand.args.includes("src/features/native-routes/ops/SessionControlPanel.test.tsx"));
  assert.ok(operatorUiCommand.args.includes("src/features/threaded-surface/SessionControlBanner.test.tsx"));

  const loggerRedactionCommand = byLogName.get("session-control.logger-redaction");
  assert.deepEqual(loggerRedactionCommand.args, [
    "--filter",
    "@goatcitadel/gateway-core",
    "exec",
    "vitest",
    "run",
    "src/logger.test.ts",
  ]);

  const runtimeUxRedactionCommand = byLogName.get("session-control.runtime-ux-redaction");
  assert.deepEqual(runtimeUxRedactionCommand.args, [
    "--filter",
    "@goatcitadel/gateway",
    "exec",
    "vitest",
    "run",
    "src/runtime-ux.coverage.test.ts",
  ]);

  const sharedHostDrainCommand = byLogName.get("session-control.shared-host-drain");
  assert.deepEqual(sharedHostDrainCommand.args, ["verify:shared-host:drain"]);

  const typecheckCommand = byLogName.get("session-control.typecheck");
  assert.equal(typecheckCommand.args.at(-1), "typecheck");
  for (const pkg of [
    "@goatcitadel/contracts",
    "@goatcitadel/storage",
    "@goatcitadel/gateway",
    "@goatcitadel/gateway-core",
    "@goatcitadel/mission-control-shared",
    "@goatcitadel/threaded-surface-core",
    "@goatcitadel/mission-control-next",
  ]) {
    assert.ok(typecheckCommand.args.includes(pkg), `typecheck covers ${pkg}`);
  }
});

test("session-control lane runs the live PostgreSQL scenario and marks spec scenario 28 executed when the URL is configured", async () => {
  const definitions = [];
  const commands = [];
  const writes = [];
  const context = { artifactRoot: "artifacts/session-control" };
  const previousPostgresUrl = process.env.GOATCITADEL_TEST_POSTGRES_URL;
  process.env.GOATCITADEL_TEST_POSTGRES_URL = "postgres://example-test-only/db";
  try {
    await runSessionControlLane(context, {}, makeDeps({ commands, definitions, writes }));
  } finally {
    if (previousPostgresUrl === undefined) delete process.env.GOATCITADEL_TEST_POSTGRES_URL;
    else process.env.GOATCITADEL_TEST_POSTGRES_URL = previousPostgresUrl;
  }

  assert.equal(commands.length, 20, "the live PostgreSQL scenario issues one additional runCommand call");
  const postgresCommand = commands.at(-1);
  assert.deepEqual(postgresCommand.args, ["--filter", "@goatcitadel/storage", "test:postgres"]);
  assert.equal(definitions.at(-1).id, "session-control.postgres");

  const matrix = writes[0].payload;
  assert.equal(matrix.postgresProofConfigured, true);
  const scenario28 = matrix.specProofMatrix.find((row) => row.scenario === 28);
  assert.equal(scenario28.status, "executed", "scenario 28 is executed when the URL is configured");
  assert.equal(scenario28.skipReason, undefined);
  assert.ok(scenario28.proof.includes("session-control.postgres"));
  // The browser proof remains a skip regardless of PostgreSQL availability.
  const scenario27 = matrix.specProofMatrix.find((row) => row.scenario === 27);
  assert.equal(scenario27.status, "skipped");
  assert.equal(matrix.specScenariosSkippedWithReason, 1);
  assert.equal(matrix.specScenariosExecuted, 27);
});

test("session-control lane falls back to reading migration heads from storage sources", async () => {
  const definitions = [];
  const writes = [];
  const context = { artifactRoot: "artifacts/session-control" };
  const previousPostgresUrl = process.env.GOATCITADEL_TEST_POSTGRES_URL;
  delete process.env.GOATCITADEL_TEST_POSTGRES_URL;
  try {
    await runSessionControlLane(
      context,
      {},
      {
        clampString: (value) => value,
        emptyArtifacts: (overrides = {}) => ({
          diagnostics: [],
          screenshots: [],
          traces: [],
          logs: [],
          perf: [],
          playwright: [],
          ...overrides,
        }),
        path,
        pnpmCommand: () => "pnpm",
        // No readSessionControlMigrationHeads override: exercises the real repo-root fallback reader.
        repoRoot: path.resolve(import.meta.dirname, "..", "..", "..", ".."),
        relativeToRun: (_context, value) => path.relative(context.artifactRoot, value).replaceAll("\\", "/"),
        runCommand: async (_command, _args, options) => ({
          code: 0,
          durationMs: 1,
          stdoutPath: path.join(context.artifactRoot, "diagnostics", `${options.logName}.stdout.log`),
          stderrPath: path.join(context.artifactRoot, "diagnostics", `${options.logName}.stderr.log`),
        }),
        runScenario: async (_context, definition, fn) => {
          definitions.push(definition);
          return await fn();
        },
        writeJson: async (targetPath, payload) => {
          writes.push({ targetPath, payload });
        },
      },
    );
  } finally {
    if (previousPostgresUrl === undefined) delete process.env.GOATCITADEL_TEST_POSTGRES_URL;
    else process.env.GOATCITADEL_TEST_POSTGRES_URL = previousPostgresUrl;
  }

  assert.equal(writes.length, 1);
  const heads = writes[0].payload.currentDependencyMigrationHeads;
  assert.ok(Number.isSafeInteger(heads.sqlite) && heads.sqlite >= 174);
  assert.ok(Number.isSafeInteger(heads.postgres) && heads.postgres >= 116);
});
