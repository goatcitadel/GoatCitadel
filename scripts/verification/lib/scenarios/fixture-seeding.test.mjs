import assert from "node:assert/strict";
import test from "node:test";
import { seedMissionControlNextFixture } from "./fixture-seeding.mjs";

test("fails when the seeded thread has no artifact turn", async () => {
  const requests = [];
  const requestJson = async (_gatewayUrl, path) => {
    requests.push(path);
    if (path === "/api/v1/dev/verification/seed") {
      return { ok: true, body: { workspaceId: "workspace-1", sessionId: "session-1" } };
    }
    return { ok: true, body: { turns: [] } };
  };

  await assert.rejects(
    seedMissionControlNextFixture("http://gateway.test", {}, {
      assertOk(response) {
        assert.equal(response.ok, true);
      },
      randomUUID: () => "00000000-0000-0000-0000-000000000000",
      requestJson,
      stabilizeMissionControlNextFileFixtureMtime: async () => {},
    }),
    /did not return an artifact turn/,
  );
  assert.deepEqual(requests, [
    "/api/v1/dev/verification/seed",
    "/api/v1/chat/sessions/session-1/thread",
  ]);
});

test("seeds the complete fixture and returns its identifiers", async () => {
  const requests = [];
  let agentIndex = 0;
  let taskIndex = 0;
  const requestJson = async (_gatewayUrl, path) => {
    requests.push(path);
    if (path === "/api/v1/dev/verification/seed") {
      return {
        ok: true,
        body: {
          workspaceId: "workspace-1",
          sessionId: "session-1",
          sessionIds: ["session-1", "session-2"],
        },
      };
    }
    if (path === "/api/v1/chat/sessions/session-1/thread") {
      return { ok: true, body: { turns: [{ turnId: "turn-1" }] } };
    }
    if (path === "/api/v1/agents") {
      agentIndex += 1;
      return { ok: true, body: { agentId: `agent-${agentIndex}`, name: `Agent ${agentIndex}` } };
    }
    if (path === "/api/v1/tasks") {
      taskIndex += 1;
      return { ok: true, body: { taskId: `task-${taskIndex}` } };
    }
    if (path === "/api/v1/files/upload") {
      return { ok: true, body: { fullPath: "workspace/verification/mission-control-next-proof.md" } };
    }
    return { ok: true, body: {} };
  };

  const stabilizedPaths = [];
  const result = await seedMissionControlNextFixture("http://gateway.test", {}, {
    assertOk(response) {
      assert.equal(response.ok, true);
    },
    randomUUID: () => "00000000-0000-0000-0000-000000000000",
    requestJson,
    stabilizeMissionControlNextFileFixtureMtime: async (_runtimeRoot, fullPath) => {
      stabilizedPaths.push(fullPath);
    },
  });

  assert.deepEqual(result, {
    workspaceId: "workspace-1",
    sessionId: "session-1",
    sessionIds: ["session-1", "session-2"],
    citadelId: "personal",
    sessions: { approval: "session-1", userInput: "session-2" },
    agentIds: ["agent-1", "agent-2"],
    taskIds: ["task-1", "task-2", "task-3", "task-4"],
  });
  assert.deepEqual(stabilizedPaths, ["workspace/verification/mission-control-next-proof.md"]);
  assert.ok(requests.includes("/api/v1/prompt-packs/import"));
});
