import assert from "node:assert/strict";

const settingsEvidence = (state) => {
  const { plan: _derivedPlan, ...auth } = state.settings.auth;
  return { ...state.settings, auth };
};

export function assertAdvancedDefaultsReceipt({ before, request, receipt, after }) {
  assert.equal(before.settings.auth.allowLoopbackBypass, false, "The real auth fixture must be established first.");
  assert.deepEqual(request, {
    expectedRevision: before.settings.revision,
    toolApprovalMode: before.settings.toolApprovalMode,
    budgetMode: before.settings.budgetMode,
    networkAllowlist: before.settings.networkAllowlist,
    auth: { allowLoopbackBypass: false },
  });
  assert.ok(Number.isFinite(Date.parse(receipt.appliedAt)));
  const expected = { ...settingsEvidence(before), revision: before.settings.revision + 1 };
  assert.deepEqual(settingsEvidence(receipt.state), expected);
  assert.deepEqual(settingsEvidence(after), expected);
  for (const field of ["completed", "completedAt", "completedBy", "firstTask"]) {
    if (field === "firstTask") {
      assert.equal(after.firstTask?.status, before.firstTask?.status);
    } else {
      assert.equal(receipt.state[field], before[field]);
      assert.equal(after[field], before[field]);
    }
  }
}

export function assertAdvancedDemoRecords({ receipt, state, workspace, project, session, tasks }) {
  assert.ok(["ready", "partial"].includes(receipt.status));
  assert.equal(state.status, "ready", "GET record readiness is separate from POST partial notes.");
  assert.ok(receipt.notes.every((note) => typeof note === "string"));
  assert.deepEqual(Object.keys(receipt.created).sort(), [
    "chatSession",
    "codeSession",
    "codeTask",
    "coworkSession",
    "coworkTask",
    "memorySeed",
    "project",
    "workspace",
  ]);
  assert.ok(Object.values(receipt.created).every((value) => typeof value === "boolean"));
  for (const key of ["workspace", "project", "sessions", "starterPrompts", "memorySeeds", "nextRoute"])
    assert.deepEqual(state[key], receipt[key]);
  const orderedTasks = (items) => {
    assert.equal(items.length, 2);
    assert.equal(new Set(items.map((item) => item.taskId)).size, items.length, "Duplicate demo task identity.");
    return [...items].sort((a, b) => (a.taskId < b.taskId ? -1 : a.taskId > b.taskId ? 1 : 0));
  };
  // Bootstrap returns creation order; subsequent reads use the task owner's order.
  // Match exact unique identities and every field, without assuming one list order.
  assert.deepEqual(orderedTasks(state.tasks), orderedTasks(receipt.tasks));
  assert.equal(workspace.workspaceId, state.workspace.workspaceId);
  assert.equal(workspace.name, state.workspace.name);
  assert.equal(workspace.slug, "goatcitadel-demo");
  assert.equal(workspace.lifecycleStatus, "active");
  assert.ok(workspace.citadelId);
  assert.equal(project.projectId, state.project.projectId);
  assert.equal(project.workspaceId, workspace.workspaceId);
  assert.equal(project.name, state.project.name);
  assert.equal(project.workspacePath, state.project.workspacePath);
  assert.equal(project.lifecycleStatus, "active");
  assert.equal(state.sessions.length, 1);
  assert.equal(session.sessionId, state.sessions[0].sessionId);
  assert.equal(session.title, state.sessions[0].title);
  assert.equal(session.workspaceId, workspace.workspaceId);
  assert.equal(session.projectId, project.projectId);
  assert.equal(session.mode, "chat");
  assert.equal(session.lifecycleStatus, "active");
  assert.equal(tasks.length, 2);
  assert.equal(new Set(tasks.map((task) => task.taskId)).size, 2);
  for (const task of tasks) {
    assert.equal(task.workspaceId, workspace.workspaceId);
    assert.equal(task.deletedAt, undefined);
    assert.deepEqual(
      state.tasks.find((item) => item.taskId === task.taskId),
      {
        taskId: task.taskId,
        title: task.title,
        status: task.status,
        priority: task.priority,
      },
    );
  }
}

export function assertAdvancedFirstRunWrites(writes) {
  assert.deepEqual(
    writes.map(({ method, pathname }) => `${method} ${pathname}`),
    [
      "POST /api/v1/onboarding/bootstrap",
      "POST /api/v1/onboarding/bootstrap",
      "POST /api/v1/demo/bootstrap",
      "POST /api/v1/demo/bootstrap",
    ],
  );
  assert.ok(Number.isSafeInteger(writes[0].body.expectedRevision));
  assert.deepEqual(writes[1].body, { ...writes[0].body, expectedRevision: writes[0].body.expectedRevision + 1 });
  assert.deepEqual(writes[2].body ?? {}, {});
  assert.deepEqual(writes[3].body ?? {}, {});
}
