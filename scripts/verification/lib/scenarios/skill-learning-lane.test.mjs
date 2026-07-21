import assert from "node:assert/strict";
import path from "node:path";
import { test } from "node:test";

import { runSkillLearningLane } from "./skill-learning-lane.mjs";

test("skill-learning lane emits its invariant matrix and every owned proof boundary", async () => {
  const definitions = [];
  const commands = [];
  const writes = [];
  const context = { artifactRoot: "artifacts/skill-learning" };
  const previousPostgresUrl = process.env.GOATCITADEL_TEST_POSTGRES_URL;
  delete process.env.GOATCITADEL_TEST_POSTGRES_URL;
  try {
    await runSkillLearningLane(
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
        readSkillLearningMigrationHeads: async () => ({ sqlite: 163, postgres: 105 }),
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
      "skill-learning.proof-matrix",
      "skill-learning.contracts",
      "skill-learning.storage",
      "skill-learning.schema",
      "skill-learning.gateway",
      "skill-learning.code-mode-lineage",
      "skill-learning.typecheck",
      "skill-learning.postgres",
    ],
  );
  assert.equal(writes.length, 1);
  assert.equal(writes[0].payload.migrationChange, "none");
  assert.deepEqual(writes[0].payload.featureMigrationPair, { sqlite: 161, postgres: 103 });
  assert.deepEqual(writes[0].payload.currentDependencyMigrationHeads, { sqlite: 163, postgres: 105 });
  assert.equal(writes[0].payload.postgresProofConfigured, false);
  assert.ok(writes[0].payload.invariants.some((item) => item.includes("three distinct clean sessions")));
  assert.ok(commands[2].args.includes("src/skill-governance-schema-parity.test.ts"));
  assert.ok(commands[3].args.includes("src/services/skill-learning-service.test.ts"));
  assert.ok(commands[4].args.includes("src/services/capability-system-service.test.ts"));
  assert.equal(commands[5].args.at(-1), "typecheck");
  assert.equal(commands.length, 6, "PostgreSQL command is skipped when no test URL is configured");
});
