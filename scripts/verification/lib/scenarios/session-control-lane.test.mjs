import assert from "node:assert/strict";
import path from "node:path";
import { test } from "node:test";

import { runSessionControlLane } from "./session-control-lane.mjs";

test("session-control lane emits its named-proof matrix and every owned proof boundary", async () => {
  const definitions = [];
  const commands = [];
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
        readSessionControlMigrationHeads: async () => ({ sqlite: 174, postgres: 116 }),
        relativeToRun: (_context, value) => path.relative(context.artifactRoot, value).replaceAll("\\", "/"),
        repoRoot: "repo",
        runCommand: async (command, args, options) => {
          commands.push({ command, args, options });
          return {
            code: 0,
            durationMs: 1,
            stdoutPath: path.join(context.artifactRoot, "diagnostics", `${options.logName}.stdout.log`),
            stderrPath: path.join(context.artifactRoot, "diagnostics", `${options.logName}.stderr.log`),
          };
        },
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

  assert.deepEqual(
    definitions.map((definition) => definition.id),
    [
      "session-control.proof-matrix",
      "session-control.storage",
      "session-control.purpose-auth-contracts",
      "session-control.purpose-auth-gateway",
      "session-control.recovery",
      "session-control.mutation-classification",
      "session-control.late-callback-fence",
      "session-control.shared-host-drain",
      "session-control.typecheck",
      "session-control.postgres",
    ],
  );
  assert.ok(
    definitions.every((definition) => definition.lane === "session-control"),
    "every scenario declares the session-control lane",
  );

  assert.equal(writes.length, 1, "only the proof-matrix scenario writes a diagnostics artifact");
  const matrix = writes[0].payload;
  assert.deepEqual(matrix.featureMigrationPairs, {
    authRevokeLifecycleAdmission: { sqlite: 173, postgres: 115 },
    heartbeatOccurrenceAuthority: { sqlite: 174, postgres: 116 },
  });
  assert.deepEqual(matrix.currentDependencyMigrationHeads, { sqlite: 174, postgres: 116 });
  assert.equal(matrix.postgresProofConfigured, false);
  assert.deepEqual(matrix.namedProofAreas, [
    "storage parity",
    "purpose-auth matrix",
    "restart/worker-move recovery",
    "shared-host drain",
    "mutation classification",
    "late-callback proof",
  ]);
  assert.ok(matrix.invariants.some((item) => item.includes("late classification evidence")));
  assert.ok(matrix.invariants.some((item) => item.includes("eight vocabulary")));
  assert.ok(matrix.invariants.some((item) => item.includes("companion principal purpose")));
  assert.ok(matrix.invariants.some((item) => item.includes("storage-keyed")));
  assert.ok(matrix.nonGoals.includes("external control route registration"));
  assert.ok(matrix.nonGoals.includes("CLI"));
  assert.ok(matrix.nonGoals.includes("UI"));
  assert.ok(matrix.nonGoals.includes("release claim"));

  // 8 commands run through the shared runCommand loop; the postgres scenario is
  // gated separately and does not invoke runCommand when the env var is unset.
  assert.equal(commands.length, 8, "PostgreSQL scenario is skipped when no test URL is configured");

  const storageCommand = commands[0];
  assert.deepEqual(storageCommand.args.slice(0, 4), ["--filter", "@goatcitadel/storage", "exec", "tsx"]);
  assert.ok(storageCommand.args.includes("src/session-control-schema-parity.test.ts"));
  assert.ok(storageCommand.args.includes("src/chat-session-lifecycle-repo.test.ts"));
  assert.ok(storageCommand.args.includes("src/chat-session-lifecycle-repo.postgres.test.ts"));
  assert.ok(storageCommand.args.includes("src/session-control-repo.test.ts"));
  assert.ok(storageCommand.args.includes("src/session-control-repo.postgres.test.ts"));
  assert.ok(storageCommand.args.includes("src/session-mutation-admission-repo.test.ts"));
  assert.ok(storageCommand.args.includes("src/session-mutation-admission-repo.postgres.test.ts"));

  const purposeAuthContractsCommand = commands[1];
  assert.deepEqual(purposeAuthContractsCommand.args, [
    "--filter",
    "@goatcitadel/contracts",
    "exec",
    "vitest",
    "run",
    "src/auth.test.ts",
    "src/companion-auth.test.ts",
  ]);

  const purposeAuthGatewayCommand = commands[2];
  assert.ok(purposeAuthGatewayCommand.args.includes("src/services/settings-auth-service.test.ts"));
  assert.ok(purposeAuthGatewayCommand.args.includes("src/services/session-control-service.test.ts"));

  const recoveryCommand = commands[3];
  assert.ok(recoveryCommand.args.includes("src/services/session-control-runtime-owner.test.ts"));
  assert.ok(recoveryCommand.args.includes("src/services/chat-turn-interruption-recovery-service.test.ts"));
  assert.ok(
    recoveryCommand.args.includes("src/services/chat-turn-interruption-recovery-service.postgres-dialect.test.ts"),
  );

  const mutationClassificationCommand = commands[4];
  assert.ok(mutationClassificationCommand.args.includes("src/services/session-mutation-classification.test.ts"));
  assert.ok(mutationClassificationCommand.args.includes("src/services/session-mutation-source-inventory.test.ts"));

  const lateCallbackFenceCommand = commands[5];
  assert.ok(lateCallbackFenceCommand.args.includes("src/services/chat-turn-dispatch-service.test.ts"));
  assert.ok(lateCallbackFenceCommand.args.includes("src/services/chat-turn-entry-service.test.ts"));
  assert.ok(lateCallbackFenceCommand.args.includes("src/services/durable-execution-service.test.ts"));

  const sharedHostDrainCommand = commands[6];
  assert.deepEqual(sharedHostDrainCommand.args, ["verify:shared-host:drain"]);

  const typecheckCommand = commands[7];
  assert.equal(typecheckCommand.args.at(-1), "typecheck");
  assert.ok(typecheckCommand.args.includes("@goatcitadel/contracts"));
  assert.ok(typecheckCommand.args.includes("@goatcitadel/storage"));
  assert.ok(typecheckCommand.args.includes("@goatcitadel/gateway"));
});

test("session-control lane runs the live PostgreSQL scenario when the test URL is configured", async () => {
  const definitions = [];
  const commands = [];
  const context = { artifactRoot: "artifacts/session-control" };
  const previousPostgresUrl = process.env.GOATCITADEL_TEST_POSTGRES_URL;
  process.env.GOATCITADEL_TEST_POSTGRES_URL = "postgres://example-test-only/db";
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
        readSessionControlMigrationHeads: async () => ({ sqlite: 174, postgres: 116 }),
        relativeToRun: (_context, value) => path.relative(context.artifactRoot, value).replaceAll("\\", "/"),
        repoRoot: "repo",
        runCommand: async (command, args, options) => {
          commands.push({ command, args, options });
          return {
            code: 0,
            durationMs: 1,
            stdoutPath: path.join(context.artifactRoot, "diagnostics", `${options.logName}.stdout.log`),
            stderrPath: path.join(context.artifactRoot, "diagnostics", `${options.logName}.stderr.log`),
          };
        },
        runScenario: async (_context, definition, fn) => {
          definitions.push(definition);
          return await fn();
        },
        writeJson: async () => {},
      },
    );
  } finally {
    if (previousPostgresUrl === undefined) delete process.env.GOATCITADEL_TEST_POSTGRES_URL;
    else process.env.GOATCITADEL_TEST_POSTGRES_URL = previousPostgresUrl;
  }

  assert.equal(commands.length, 9, "the live PostgreSQL scenario issues one additional runCommand call");
  const postgresCommand = commands.at(-1);
  assert.deepEqual(postgresCommand.args, ["--filter", "@goatcitadel/storage", "test:postgres"]);
  assert.equal(definitions.at(-1).id, "session-control.postgres");
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
