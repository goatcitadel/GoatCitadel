export async function seedMissionControlNextFixture(gatewayUrl, options = {}, deps) {
  const {
    assertOk,
    randomUUID,
    requestJson,
    stabilizeMissionControlNextFileFixtureMtime,
  } = deps;
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

  if (artifactTurnId) {
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
  }

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

  assertOk(
    await requestJson(gatewayUrl, "/api/v1/dev/verification/memory-item-seed", {
      method: "POST",
      body: {
        namespace: "mission-control-next",
        title: "Mission Control Next shell posture",
        content: "Chat is the default lane, Cowork owns structured work, and Code stays workbench-first.",
        metadata: {
          tags: ["verification", "ui"],
          source: "verification",
          sessionId,
        },
      },
    }),
    "seed mission-control-next memory item",
  );

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
  };

}
