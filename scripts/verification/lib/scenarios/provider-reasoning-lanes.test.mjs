import assert from "node:assert/strict";
import path from "node:path";
import { test } from "node:test";

import { runReasoningProfilesLane, runVertexFireworksProvidersLane } from "./provider-reasoning-lanes.mjs";

test("provider and reasoning lanes emit invariant artifacts and run every owned proof boundary", async () => {
  const provider = await exerciseLane(runVertexFireworksProvidersLane, "providers-vertex-fireworks");
  assert.deepEqual(provider.ids, [
    "providers-vertex-fireworks.proof-matrix",
    "providers-vertex-fireworks.contracts",
    "providers-vertex-fireworks.gateway",
    "providers-vertex-fireworks.surface",
    "providers-vertex-fireworks.typecheck",
  ]);
  assert.equal(provider.writes.length, 1);
  assert.equal(provider.writes[0].payload.migrationChange, "none");
  assert.deepEqual(provider.writes[0].payload.vertexFireworksFeatureDependencyMigrations, {
    sqlite: 160,
    postgres: 102,
  });
  assert.ok(provider.writes[0].payload.invariants.some((item) => item.includes("Chat off omits reasoning_effort")));
  assert.ok(provider.commands[1].args.includes("src/services/llm-service.vertex-fireworks.test.ts"));

  const reasoning = await exerciseLane(runReasoningProfilesLane, "reasoning-profiles");
  assert.deepEqual(reasoning.ids, [
    "reasoning-profiles.proof-matrix",
    "reasoning-profiles.gateway",
    "reasoning-profiles.typecheck",
  ]);
  assert.equal(reasoning.writes.length, 1);
  assert.ok(reasoning.writes[0].payload.invariants.some((item) => item.includes("model-usage records")));
  assert.ok(reasoning.commands[0].args.includes("src/services/llm-service.reasoning-usage.test.ts"));
  assert.equal(reasoning.commands[1].args.at(-1), "typecheck");
});

async function exerciseLane(runLane, lane) {
  const definitions = [];
  const commands = [];
  const writes = [];
  const context = { artifactRoot: `artifacts/${lane}` };
  await runLane(
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
  return { ids: definitions.map((definition) => definition.id), commands, writes };
}
