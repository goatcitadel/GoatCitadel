/**
 * Seeds the complete Mission Control Next verification dataset through the gateway API.
 *
 * @param {string} gatewayUrl gateway base URL
 * @param {object} [options={}] scenario-specific fixture controls
 * @param {object} deps request, assertion, UUID, and file-mtime dependencies
 * @returns {Promise<object>} identifiers and metadata for the seeded verification scenario
 * @throws {Error} when required seed or thread identifiers are missing
 */
export async function seedMissionControlNextFixture(gatewayUrl, options = {}, deps) {
  const { assertOk, randomUUID, requestJson, stabilizeMissionControlNextFileFixtureMtime } = deps;
  const seedResponse = await requestJson(gatewayUrl, "/api/v1/dev/verification/seed", {
    method: "POST",
    body: {
      workspaceName: "Mission Control Next Verification Workspace",
      sessionTitle: "Mission Control Next Verification Session",
      sessionCount: 8,
      longThreadTurns: 20,
    },
  });
  assertOk(seedResponse, "seed mission-control-next verification data");

  const workspaceId = seedResponse.body?.workspaceId;
  const sessionId = seedResponse.body?.sessionId;
  if (!workspaceId || !sessionId) {
    throw new Error("mission-control-next verification seed did not return workspaceId/sessionId");
  }

  const threadResponse = await requestJson(gatewayUrl, `/api/v1/chat/sessions/${encodeURIComponent(sessionId)}/thread`);
  assertOk(threadResponse, "read mission-control-next verification thread");
  const artifactTurnId =
    threadResponse.body?.selectedTurnId ??
    threadResponse.body?.activeLeafTurnId ??
    threadResponse.body?.turns?.at?.(-1)?.turnId;

  if (!artifactTurnId) {
    throw new Error(`mission-control-next verification thread ${sessionId} did not return an artifact turn`);
  }
  const artifactResponse = await requestJson(
    gatewayUrl,
    `/api/v1/chat/sessions/${encodeURIComponent(sessionId)}/turns/${encodeURIComponent(artifactTurnId)}/generated-artifact`,
    {
      method: "POST",
      body: {
        supersedeLatest: true,
      },
    },
  );
  assertOk(artifactResponse, "create mission-control-next generated artifact");

  // Seed a pending-user-input prompt on a SEPARATE session BEFORE the approval
  // scenario, so the chat-approval session remains the most-recently-active
  // session and existing "/chat" baselines that auto-pick the freshest session
  // still resolve to the approval state. The chat-pending-user-input baseline
  // targets the user-input session explicitly via fixtureSessionKey.
  const seededSessionIds = Array.isArray(seedResponse.body?.sessionIds) ? seedResponse.body.sessionIds : [];
  const userInputSessionId = seededSessionIds.find((candidate) => candidate && candidate !== sessionId);
  if (userInputSessionId) {
    const userInputResponse = await requestJson(gatewayUrl, "/api/v1/dev/verification/chat-user-input-scenario", {
      method: "POST",
      body: {
        sessionId: userInputSessionId,
        workspaceId,
      },
    });
    assertOk(userInputResponse, "create mission-control-next chat user-input prompt");
  }

  const approvalResponse = await requestJson(gatewayUrl, "/api/v1/dev/verification/chat-approval-scenario", {
    method: "POST",
    body: {
      sessionId,
      workspaceId,
    },
  });
  assertOk(approvalResponse, "create mission-control-next chat approval");

  const agentSpecs = [
    {
      roleId: `mc-next-operator-${randomUUID().slice(0, 8)}`,
      name: "Operator Scout",
      title: "Evidence Scout",
      summary: "Keeps route proof legible and traces noteworthy activity.",
      specialties: ["verification", "summaries"],
      defaultTools: ["fs.read", "fs.list"],
      aliases: ["scout"],
    },
    {
      roleId: `mc-next-builder-${randomUUID().slice(0, 8)}`,
      name: "Builder Pair",
      title: "Workbench Pair",
      summary: "Owns code posture and implementation reviews in shared workspaces.",
      specialties: ["code", "review"],
      defaultTools: ["fs.read", "fs.write", "git.status"],
      aliases: ["pair"],
    },
  ];

  const createdAgents = [];
  for (const agentSpec of agentSpecs) {
    const response = await requestJson(gatewayUrl, "/api/v1/agents", {
      method: "POST",
      body: agentSpec,
    });
    assertOk(response, `create mission-control-next agent ${agentSpec.name}`);
    createdAgents.push(response.body);
  }

  // The dev seed assigns the verification workspace to the default personal
  // Citadel. Seed that existing Citadel with governance content so Citadel
  // routes avoid 404 console errors while Projects/Sessions/Artifacts keep a
  // matching workspace + citadel scope.
  const citadelId = "personal";
  assertOk(
    await requestJson(gatewayUrl, `/api/v1/citadels/${encodeURIComponent(citadelId)}/charter`, {
      method: "PUT",
      body: {
        purpose: "Coordinate Mission Control verification work under explicit, reviewable governance.",
        kind: "personal",
        goals: ["Keep operator work legible", "Prove governance surfaces render real content"],
        boundaries: ["No external writes without approval", "Sensitive work stays sealed"],
        successDefinition: ["Release-bearing Citadel surfaces are visually verified"],
        riskPosture: "balanced",
        modelPolicyDefault: "hybrid_guarded",
      },
    }),
    "stage mission-control-next citadel charter",
  );
  for (const chamber of [
    { name: "Operations", sensitivity: "internal" },
    { name: "Finance", sensitivity: "secret", sealed: true },
  ]) {
    assertOk(
      await requestJson(gatewayUrl, `/api/v1/citadels/${encodeURIComponent(citadelId)}/chambers`, {
        method: "POST",
        body: chamber,
      }),
      `create mission-control-next citadel chamber ${chamber.name}`,
    );
  }
  for (const ward of [
    { name: "Block destructive shell", actionPattern: "shell.*", effect: "deny" },
    { name: "Approve external integration writes", actionPattern: "integration.write.*", effect: "require_approval" },
  ]) {
    assertOk(
      await requestJson(gatewayUrl, `/api/v1/citadels/${encodeURIComponent(citadelId)}/wards`, {
        method: "POST",
        body: ward,
      }),
      `add mission-control-next citadel ward ${ward.name}`,
    );
  }
  for (const councilAgent of createdAgents) {
    if (!councilAgent?.agentId) {
      continue;
    }
    assertOk(
      await requestJson(gatewayUrl, `/api/v1/citadels/${encodeURIComponent(citadelId)}/council`, {
        method: "POST",
        body: { agentId: councilAgent.agentId },
      }),
      `seat mission-control-next citadel council agent ${councilAgent.agentId}`,
    );
  }

  const tasks = [];
  const taskSpecs = [
    {
      title: "Validate the new Chat/Cowork/Code shell",
      description: "Check the default operator path, context panel, and visual hierarchy.",
      status: "planning",
      priority: "high",
      assignedAgentId: createdAgents[0]?.agentId,
    },
    {
      title: "Review task board and agent board cohesion",
      description: "Make sure orchestration state stays visible without clutter.",
      status: "in_progress",
      priority: "urgent",
      assignedAgentId: createdAgents[1]?.agentId,
    },
    {
      title: "Capture prompt-pack quality posture",
      description: "Benchmark the quality route without leaving the new shell.",
      status: "review",
      priority: "normal",
      assignedAgentId: createdAgents[0]?.agentId,
    },
    {
      title: "Watch runtime approvals and costs",
      description: "Keep Ops readable while approvals and spend update.",
      status: "blocked",
      priority: "normal",
      assignedAgentId: createdAgents[1]?.agentId,
    },
  ];

  for (const taskSpec of taskSpecs) {
    const response = await requestJson(gatewayUrl, "/api/v1/tasks", {
      method: "POST",
      body: {
        workspaceId,
        ...taskSpec,
      },
    });
    assertOk(response, `create mission-control-next task ${taskSpec.title}`);
    tasks.push(response.body);
  }

  if (tasks[0]?.taskId) {
    const taskId = tasks[0].taskId;
    assertOk(
      await requestJson(gatewayUrl, `/api/v1/tasks/${encodeURIComponent(taskId)}/activities`, {
        method: "POST",
        body: {
          workspaceId,
          activityType: "comment",
          message: "Surface proof fixture loaded with deterministic activity.",
          agentId: createdAgents[0]?.agentId ?? "operator",
        },
      }),
      "append mission-control-next task activity",
    );
    assertOk(
      await requestJson(gatewayUrl, `/api/v1/tasks/${encodeURIComponent(taskId)}/deliverables`, {
        method: "POST",
        body: {
          workspaceId,
          deliverableType: "artifact",
          title: "Mission Control Next proof artifact",
          path: "workspace/verification/mission-control-next-proof.md",
          description: "Seeded deliverable for task detail proof.",
        },
      }),
      "append mission-control-next task deliverable",
    );
    assertOk(
      await requestJson(gatewayUrl, `/api/v1/tasks/${encodeURIComponent(taskId)}/subagents`, {
        method: "POST",
        body: {
          workspaceId,
          agentSessionId: `agent-session-${randomUUID().slice(0, 8)}`,
          agentName: createdAgents[1]?.name ?? "Builder Pair",
        },
      }),
      "append mission-control-next task subagent",
    );
  }

  const opsBoardResponse = await requestJson(gatewayUrl, "/api/v1/ops/boards", {
    method: "POST",
    body: {
      workspaceId,
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
  if (opsBoardResponse?.status === 403) {
    // A bare "403" here sends the reader hunting through the Ops board route.
    // The cause is always the lane's stack: `startVerificationStack` defaults to
    // GOATCITADEL_AUTH_MODE=none, and the auth plugin short-circuits that to
    // actor source `none` before the loopback branch runs, so a route that needs
    // a specific operator identity to record has none to record.
    throw new Error(
      "create mission-control-next verification Ops board was denied (403): the Ops saved-board routes require an "
        + "authenticated operator, but this lane's gateway is running with GOATCITADEL_AUTH_MODE=none. Spread "
        + "VERIFICATION_OPERATOR_AUTH_ENV into the lane's startVerificationStack gatewayEnv.",
    );
  }
  assertOk(opsBoardResponse, "create mission-control-next verification Ops board");
  const opsBoardId = opsBoardResponse.body?.boardId;
  if (!opsBoardId) {
    throw new Error("mission-control-next verification Ops board did not return boardId");
  }

  const settingsResponse = await requestJson(gatewayUrl, "/api/v1/settings");
  assertOk(settingsResponse, "read mission-control-next verification settings");
  const settingsRevision = settingsResponse.body?.revision;
  if (!Number.isSafeInteger(settingsRevision) || settingsRevision < 1) {
    throw new Error("mission-control-next verification settings did not return a valid revision");
  }
  const updatedSettingsResponse = await requestJson(gatewayUrl, "/api/v1/settings", {
    method: "PATCH",
    body: {
      expectedRevision: settingsRevision,
      features: { memoryLifecycleAdminV1Enabled: true },
    },
  });
  assertOk(updatedSettingsResponse, "enable mission-control-next verification memory admin");
  if (updatedSettingsResponse.body?.features?.memoryLifecycleAdminV1Enabled !== true) {
    throw new Error("mission-control-next verification memory admin did not become enabled");
  }

  const memorySeedResponse = await requestJson(gatewayUrl, "/api/v1/dev/verification/memory-item-seed", {
    method: "POST",
    body: {
      workspaceId,
      namespace: "mission-control-next",
      title: "Mission Control Next shell posture",
      content: "Chat owns conversation, structured agentic work, and governed code-capability context.",
      metadata: {
        tags: ["verification", "ui"],
        source: "verification",
        sessionId,
      },
    },
  });
  assertOk(memorySeedResponse, "seed mission-control-next memory item");
  const memoryItemId = memorySeedResponse.body?.itemId;
  if (!memoryItemId) {
    throw new Error("mission-control-next verification memory seed did not return itemId");
  }
  const visibleMemoryResponse = await requestJson(
    gatewayUrl,
    `/api/v1/memory/items?workspaceId=${encodeURIComponent(workspaceId)}&status=all&limit=200`,
  );
  assertOk(visibleMemoryResponse, "read mission-control-next verification memory items");
  const seededMemoryVisible = visibleMemoryResponse.body?.items?.some(
    (item) => item?.itemId === memoryItemId && item?.title === "Mission Control Next shell posture",
  );
  if (!seededMemoryVisible) {
    throw new Error("mission-control-next verification memory item was not visible through the operator API");
  }

  const uploadResponse = await requestJson(gatewayUrl, "/api/v1/files/upload", {
    method: "POST",
    body: {
      relativePath: "workspace/verification/mission-control-next-proof.md",
      content: "# Mission Control Next\n\n- Seeded for visual proof.\n- Safe to overwrite.\n",
    },
  });
  assertOk(uploadResponse, "upload mission-control-next file fixture");
  await stabilizeMissionControlNextFileFixtureMtime(options.runtimeRoot, uploadResponse.body?.fullPath);

  assertOk(
    await requestJson(gatewayUrl, "/api/v1/prompt-packs/import", {
      method: "POST",
      body: {
        name: "Mission Control Next Verification Pack",
        sourceLabel: "verification",
        content: [
          "[TEST-01] Mission Control Next shell posture",
          "Confirm the new shell is calmer than the legacy frame.",
          "",
          "[TEST-02] Context panel posture",
          "Explain what the context panel should reveal without overwhelming the operator.",
        ].join("\n"),
      },
    }),
    "import mission-control-next prompt pack",
  );

  return {
    workspaceId,
    sessionId,
    sessionIds: seededSessionIds,
    citadelId,
    sessions: {
      approval: sessionId,
      ...(userInputSessionId ? { userInput: userInputSessionId } : {}),
    },
    agentIds: createdAgents.map((agent) => agent?.agentId).filter(Boolean),
    taskIds: tasks.map((task) => task?.taskId).filter(Boolean),
    opsBoardId,
    memoryItemId,
  };
}
