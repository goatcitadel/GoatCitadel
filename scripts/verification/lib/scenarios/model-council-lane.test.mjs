import assert from "node:assert/strict";
import path from "node:path";
import { test } from "node:test";

import { runModelCouncilLane } from "./model-council-lane.mjs";

test("model-council lane emits its invariant artifact and runs every owned proof boundary", async () => {
  const definitions = [];
  const commands = [];
  const writes = [];
  const context = { artifactRoot: "artifacts/model-council" };

  await runModelCouncilLane(
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

  assert.deepEqual(
    definitions.map((definition) => definition.id),
    [
      "model-council.proof-matrix",
      "model-council.storage",
      "model-council.gateway",
      "model-council.threaded-surface",
      "model-council.mission-control",
      "model-council.typecheck",
    ],
  );
  assert.equal(writes.length, 1);
  assert.equal(writes[0].payload.sqliteMigration, 160);
  assert.equal(writes[0].payload.postgresMigration, 102);
  assert.ok(writes[0].payload.invariants.some((item) => item.includes("exact admitted routed-context snapshot")));
  assert.ok(writes[0].payload.invariants.some((item) => item.includes("composer arming clears immediately")));
  assert.ok(writes[0].payload.invariants.some((item) => item.includes("freezes bounded provider")));
  assert.ok(writes[0].payload.invariants.some((item) => item.includes("generation leases around provider calls")));
  assert.ok(writes[0].payload.invariants.some((item) => item.includes("byte-equivalent canonical replay")));
  assert.ok(writes[0].payload.invariants.some((item) => item.includes("HX-306 event ids")));
  assert.equal(commands.length, 5);
  assert.ok(commands[0].args.includes("src/model-council-schema-parity.test.ts"));
  assert.ok(commands[1].args.includes("src/services/chat-turn-stream-service.model-council.test.ts"));
  assert.ok(commands[2].args.includes("src/chat/useChatSurfaceOrchestration.test.tsx"));
  assert.ok(commands[2].args.includes("src/chat/useChatRoutePreflight.test.tsx"));
  assert.ok(commands[2].args.includes("src/chat/useChatOutboundExecution.test.tsx"));
  assert.ok(commands[3].args.includes("src/features/threaded-surface/ThreadedComposer.test.tsx"));
  assert.equal(commands[4].args.at(-1), "typecheck");
});
