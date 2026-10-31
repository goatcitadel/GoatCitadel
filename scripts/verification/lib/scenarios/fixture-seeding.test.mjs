import assert from "node:assert/strict";
import test from "node:test";
import {
  seedCodeModeRequestSessions,
  seedMissionControlNextFixture,
  settleApprovedSettingsChangePlan,
} from "./fixture-seeding.mjs";

function codeModeSeedDeps(requests) {
  return {
    assertOk(response, label) {
      assert.equal(response.ok, true, label);
    },
    requestJson: async (_gatewayUrl, path, options) => {
      requests.push({ path, body: options?.body });
      return { ok: true, body: {} };
    },
  };
}

test("seeds the Code Mode card's pending and ran sessions on spare sessions", async () => {
  const requests = [];
  const sessions = await seedCodeModeRequestSessions(
    "http://gateway.test",
    "workspace-1",
    ["session-3", "session-4", "session-5"],
    codeModeSeedDeps(requests),
  );

  assert.deepEqual(sessions, { codeModePending: "session-3", codeModeRan: "session-4" });
  assert.deepEqual(requests, [
    {
      path: "/api/v1/dev/verification/chat-approval-scenario",
      body: { sessionId: "session-3", workspaceId: "workspace-1", tool: "code_mode.request" },
    },
    {
      path: "/api/v1/dev/verification/chat-code-mode-ran-scenario",
      body: { sessionId: "session-4", workspaceId: "workspace-1" },
    },
  ]);
});

test("fails the Code Mode card seed without two spare sessions", async () => {
  const requests = [];
  await assert.rejects(
    seedCodeModeRequestSessions("http://gateway.test", "workspace-1", ["session-3"], codeModeSeedDeps(requests)),
    /need two spare seeded sessions/,
  );
  assert.deepEqual(requests, []);
});

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
  let projectRequest;
  const projectSessionRequests = [];
  const settingsPatchRequests = [];
  let settingsApprovalRequest;
  let settingsPlanResponseRequest;
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
    if (path === "/api/v1/dev/verification/chat-approval-scenario") {
      return { ok: true, body: { approvalId: "approval-1" } };
    }
    if (path === "/api/v1/chat/projects") {
      projectRequest = options;
      return { ok: true, body: { projectId: "project-1" } };
    }
    if (path === "/api/v1/chat/sessions") {
      projectSessionRequests.push(options);
      return { ok: true, body: { sessionId: `project-session-${projectSessionRequests.length}` } };
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
        return {
          ok: true,
          body: {
            revision: 8,
            features: { memoryLifecycleAdminV1Enabled: false },
            changePlanReceipt: {
              planId: "settings-plan-1",
              status: "awaiting_approval",
              revision: 3,
              requiredAction: {
                kind: "approval",
                approvalId: "00000000-0000-0000-0000-000000000001",
                actionId: "settings-action-1",
                actionNonce: "settings-action-nonce-1234567890",
              },
            },
          },
        };
      }
      return {
        ok: true,
        body: {
          revision: settingsPlanResponseRequest ? 9 : settingsPatchRequests.length === 0 ? 7 : 8,
          features: { memoryLifecycleAdminV1Enabled: Boolean(settingsPlanResponseRequest) },
        },
      };
    }
    if (path === "/api/v1/approvals/00000000-0000-0000-0000-000000000001/resolve") {
      settingsApprovalRequest = options;
      return { ok: true, body: { status: "approved" } };
    }
    if (path === "/api/v1/change-plans/settings-plan-1?workspaceId=default") {
      // After approval the plan has moved on; a continuation is answered with its current revision.
      return {
        ok: true,
        body: settingsPlanResponseRequest
          ? { status: "completed", revision: 7 }
          : {
              status: "awaiting_confirmation",
              revision: 6,
              requiredAction: {
                kind: "confirmation",
                actionId: "settings-action-2",
                actionNonce: "settings-action-nonce-2234567890",
              },
            },
      };
    }
    if (path === "/api/v1/change-plans/settings-plan-1/responses") {
      settingsPlanResponseRequest = options;
      return { ok: true, body: { status: "completed" } };
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
    projects: { primary: "project-1" },
    approvals: { primary: "approval-1" },
    agentIds: ["agent-1", "agent-2"],
    taskIds: ["task-1", "task-2", "task-3", "task-4"],
    opsBoardId: "board-1",
    memoryItemId: "memory-1",
    candidateId: "usability-browser-candidate",
    candidateVersionId: "usability-browser-candidate-v1",
  });
  assert.deepEqual(stabilizedPaths, ["workspace/verification/mission-control-next-proof.md"]);
  assert.deepEqual(projectRequest, {
    method: "POST",
    body: {
      workspaceId: "workspace-1",
      name: "Mission Control Verification",
      description: "Populated project used to prove project summary and detail surfaces.",
      workspacePath: "verification/mission-control-next",
      color: "#20b8a6",
    },
  });
  assert.deepEqual(
    projectSessionRequests.map((request) => request.body),
    [
      {
        workspaceId: "workspace-1",
        projectId: "project-1",
        title: "Release readiness review",
        mode: "chat",
      },
      {
        workspaceId: "workspace-1",
        projectId: "project-1",
        title: "Operator surface polish",
        mode: "chat",
      },
      {
        workspaceId: "workspace-1",
        projectId: "project-1",
        title: "Runtime evidence follow-up",
        mode: "chat",
      },
    ],
  );
  assert.ok(requests.includes("/api/v1/prompt-packs/import"));
  // The Code Mode card sessions are opt-in, so the default fixture seeds only the shell approval.
  assert.equal(requests.filter((path) => path === "/api/v1/dev/verification/chat-approval-scenario").length, 1);
  assert.ok(!requests.includes("/api/v1/dev/verification/chat-code-mode-ran-scenario"));
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
  assert.deepEqual(settingsApprovalRequest, {
    method: "POST",
    body: {
      decision: "approve",
      resolutionNote: "Approved by the isolated Mission Control verification fixture.",
    },
  });
  assert.deepEqual(settingsPlanResponseRequest, {
    method: "POST",
    body: {
      workspaceId: "default",
      expectedRevision: 6,
      actionId: "settings-action-2",
      actionNonce: "settings-action-nonce-2234567890",
      values: {},
    },
  });
  assert.deepEqual(retryDelays, [250, 250]);
  assert.ok(requests.includes("/api/v1/memory/items?workspaceId=workspace-1&status=all&limit=200"));
});

test("an approved Settings plan that already applied is not answered again", async () => {
  const requests = [];
  const deps = {
    assertOk(response) {
      assert.equal(response.ok, true);
    },
    delay: async () => undefined,
    requestJson: async (_url, path, options) => {
      requests.push([path, options?.method ?? "GET"]);
      return { ok: true, body: { status: "completed", revision: 6 } };
    },
  };
  await settleApprovedSettingsChangePlan("http://gateway.test", "plan-1", deps);
  assert.deepEqual(requests, [["/api/v1/change-plans/plan-1?workspaceId=default", "GET"]]);
});

test("an approved Settings plan that failed stops the fixture with its status", async () => {
  const deps = {
    assertOk() {},
    delay: async () => undefined,
    requestJson: async () => ({ ok: true, body: { status: "rollback_failed", revision: 6 } }),
  };
  await assert.rejects(
    settleApprovedSettingsChangePlan("http://gateway.test", "plan-1", deps),
    /ended as rollback_failed/,
  );
});

test("an approved Settings plan that is still applying is polled until it completes", async () => {
  const statuses = ["applying", "applying", "completed"];
  const delays = [];
  const deps = {
    assertOk(response) {
      assert.equal(response.ok, true);
    },
    delay: async (ms) => {
      delays.push(ms);
    },
    requestJson: async (_url, _path, options) => {
      assert.equal(options?.method ?? "GET", "GET", "an applying plan is never answered");
      return { ok: true, body: { status: statuses.shift(), revision: 6 } };
    },
  };
  await settleApprovedSettingsChangePlan("http://gateway.test", "plan-1", deps);
  assert.equal(statuses.length, 0);
  assert.equal(delays.length, 2);
});

test("an approved Settings plan that never settles stops the fixture after the retry budget", async () => {
  let reads = 0;
  const deps = {
    assertOk() {},
    delay: async () => undefined,
    requestJson: async () => {
      reads += 1;
      return { ok: true, body: { status: "applying", revision: 6 } };
    },
  };
  await assert.rejects(
    settleApprovedSettingsChangePlan("http://gateway.test", "plan-1", deps),
    /did not settle after approval/,
  );
  // The settle loop shares the Settings reconciliation budget (120 attempts).
  assert.equal(reads, 120);
});
