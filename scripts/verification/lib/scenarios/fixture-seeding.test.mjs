import assert from "node:assert/strict";
import test from "node:test";
import { seedMissionControlNextFixture } from "./fixture-seeding.mjs";

test("fails when the seeded thread has no artifact turn", async () => {
  const requests = [];
  const requestJson = async (_gatewayUrl, path) => {
    requests.push(path);
    if (path === "/api/v1/dev/verification/seed") {
      return {
        ok: true,
        body: {
          workspaceId: "workspace-1",
          sessionId: "session-1",
          candidateId: "usability-browser-candidate",
          candidateVersionId: "usability-browser-candidate-v1",
        },
      };
    }
    return { ok: true, body: { turns: [] } };
  };

  await assert.rejects(
    seedMissionControlNextFixture(
      "http://gateway.test",
      {},
      {
        assertOk(response) {
          assert.equal(response.ok, true);
        },
        delay: async () => {},
        randomUUID: () => "00000000-0000-0000-0000-000000000000",
        requestJson,
        stabilizeMissionControlNextFileFixtureMtime: async () => {},
      },
    ),
    /did not return an artifact turn/,
  );
  assert.deepEqual(requests, ["/api/v1/dev/verification/seed", "/api/v1/chat/sessions/session-1/thread"]);
});

test("seeds the complete fixture and returns its identifiers", async () => {
  const requests = [];
  let agentIndex = 0;
  let taskIndex = 0;
  let opsBoardRequest;
  let agenticTaskSeedRequest;
  let kanbanDeliverableRequest;
  const settingsPatchRequests = [];
  const retryDelays = [];
  const requestJson = async (_gatewayUrl, path, options) => {
    requests.push(path);
    if (path === "/api/v1/dev/verification/seed") {
      return {
        ok: true,
        body: {
          workspaceId: "workspace-1",
          sessionId: "session-1",
          sessionIds: ["session-1", "session-2"],
          candidateId: "usability-browser-candidate",
          candidateVersionId: "usability-browser-candidate-v1",
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
    if (path === "/api/v1/dev/verification/agentic-task-seed") {
      agenticTaskSeedRequest = options;
      return { ok: true, body: { items: [] } };
    }
    if (path === "/api/v1/tasks/task-3/deliverables") {
      kanbanDeliverableRequest = options;
      return { ok: true, body: { deliverableId: "deliverable-1" } };
    }
    if (path === "/api/v1/files/upload") {
      return { ok: true, body: { fullPath: "workspace/verification/mission-control-next-proof.md" } };
    }
    if (path === "/api/v1/ops/boards") {
      opsBoardRequest = options;
      return { ok: true, body: { boardId: "board-1" } };
    }
    if (path === "/api/v1/settings") {
      if (options?.method === "PATCH") {
        settingsPatchRequests.push(options);
        if (settingsPatchRequests.length === 1) {
          return {
            ok: false,
            status: 409,
            body: {
              code: "STATE_CONFLICT",
              error: "Settings are temporarily unavailable while runtime owners reconcile a config generation.",
            },
          };
        }
        return { ok: true, body: { revision: 8, features: { memoryLifecycleAdminV1Enabled: true } } };
      }
      return { ok: true, body: { revision: settingsPatchRequests.length === 0 ? 7 : 8 } };
    }
    if (path === "/api/v1/dev/verification/memory-item-seed") {
      return { ok: true, body: { itemId: "memory-1" } };
    }
    if (path === "/api/v1/memory/items?workspaceId=workspace-1&status=all&limit=200") {
      return {
        ok: true,
        body: { items: [{ itemId: "memory-1", title: "Mission Control Next shell posture" }] },
      };
    }
    return { ok: true, body: {} };
  };

  const stabilizedPaths = [];
  const result = await seedMissionControlNextFixture(
    "http://gateway.test",
    {},
    {
      assertOk(response) {
        assert.equal(response.ok, true);
      },
      delay: async (ms) => {
        retryDelays.push(ms);
      },
      randomUUID: () => "00000000-0000-0000-0000-000000000000",
      requestJson,
      stabilizeMissionControlNextFileFixtureMtime: async (_runtimeRoot, fullPath) => {
        stabilizedPaths.push(fullPath);
      },
    },
  );

  assert.deepEqual(result, {
    workspaceId: "workspace-1",
    sessionId: "session-1",
    sessionIds: ["session-1", "session-2"],
    citadelId: "personal",
    sessions: { approval: "session-1", userInput: "session-2" },
    agentIds: ["agent-1", "agent-2"],
    taskIds: ["task-1", "task-2", "task-3", "task-4"],
    opsBoardId: "board-1",
    memoryItemId: "memory-1",
    candidateId: "usability-browser-candidate",
    candidateVersionId: "usability-browser-candidate-v1",
  });
  assert.deepEqual(stabilizedPaths, ["workspace/verification/mission-control-next-proof.md"]);
  assert.ok(requests.includes("/api/v1/prompt-packs/import"));
  assert.deepEqual(agenticTaskSeedRequest, {
    method: "POST",
    body: {
      workspaceId: "workspace-1",
      tasks: [
        {
          taskId: "task-1",
          runId: "verification-agentic-task-1",
          status: "queued",
          surface: "chat",
          parentSessionId: "session-1",
        },
        {
          taskId: "task-2",
          runId: "verification-agentic-task-2",
          status: "failed",
          surface: "chat",
          parentSessionId: "session-1",
        },
        {
          taskId: "task-3",
          runId: "verification-agentic-task-3",
          status: "running",
          surface: "chat",
          parentSessionId: "session-1",
        },
        {
          taskId: "task-4",
          runId: "verification-agentic-task-4",
          status: "approval_required",
          surface: "chat",
          parentSessionId: "session-1",
        },
      ],
    },
  });
  assert.deepEqual(kanbanDeliverableRequest, {
    method: "POST",
    body: {
      workspaceId: "workspace-1",
      deliverableType: "artifact",
      title: "Verification prompt-pack quality evidence",
      description: "Deterministic evidence that permits the Kanban close journey.",
    },
  });
  assert.ok(requests.indexOf("/api/v1/ops/boards") > requests.lastIndexOf("/api/v1/tasks"));
  assert.deepEqual(opsBoardRequest, {
    method: "POST",
    body: {
      workspaceId: "workspace-1",
      name: "Verification command board",
      description: "Five compiled operational summaries over canonical verification sources.",
      placements: [
        {
          widgetId: "verification-runtime-truth",
          kind: "runtime_truth_summary",
          x: 0,
          y: 0,
          width: 4,
          height: 4,
        },
        {
          widgetId: "verification-approval-queue",
          kind: "approval_queue_summary",
          x: 4,
          y: 0,
          width: 4,
          height: 4,
        },
        {
          widgetId: "verification-usage-cost",
          kind: "usage_cost_summary",
          x: 8,
          y: 0,
          width: 4,
          height: 4,
        },
        {
          widgetId: "verification-agentic-runs",
          kind: "agentic_run_kanban",
          x: 0,
          y: 4,
          width: 6,
          height: 4,
        },
        {
          widgetId: "verification-task-status",
          kind: "task_status_summary",
          x: 6,
          y: 4,
          width: 6,
          height: 4,
        },
      ],
      idempotencyKey: "mission-control-next-visual-ops-board-v1",
    },
  });
  assert.deepEqual(settingsPatchRequests, [
    {
      method: "PATCH",
      body: {
        expectedRevision: 7,
        features: { memoryLifecycleAdminV1Enabled: true },
      },
    },
    {
      method: "PATCH",
      body: {
        expectedRevision: 8,
        features: { memoryLifecycleAdminV1Enabled: true },
      },
    },
  ]);
  assert.deepEqual(retryDelays, [250]);
  assert.ok(requests.includes("/api/v1/memory/items?workspaceId=workspace-1&status=all&limit=200"));
});
