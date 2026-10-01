import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  assertAdvancedDefaultsReceipt,
  assertAdvancedDemoRecords,
  assertAdvancedFirstRunWrites,
} from "./cockpit-first-run-advanced-assertions.mjs";

const defaultsFixture = () => {
  const before = {
    completed: false,
    firstTask: { status: "not_observed" },
    settings: {
      revision: 12,
      toolApprovalMode: "approve_all",
      budgetMode: "balanced",
      networkAllowlist: ["localhost"],
      auth: {
        mode: "token",
        allowLoopbackBypass: false,
        tokenConfigured: true,
        basicConfigured: false,
        plan: { detail: "derived" },
      },
      llm: { activeProviderId: "fixture", activeModel: "fixture" },
      mesh: { enabled: false },
    },
  };
  const after = structuredClone(before);
  after.settings.revision++;
  return {
    before,
    after,
    receipt: { state: structuredClone(after), appliedAt: "2026-09-30T00:00:00.000Z" },
    request: {
      expectedRevision: 12,
      toolApprovalMode: "approve_all",
      budgetMode: "balanced",
      networkAllowlist: ["localhost"],
      auth: { allowLoopbackBypass: false },
    },
  };
};
const demoFixture = () => {
  const workspace = {
    workspaceId: "demo",
    citadelId: "default",
    slug: "goatcitadel-demo",
    name: "GoatCitadel Demo",
    lifecycleStatus: "active",
  };
  const project = {
    projectId: "project",
    workspaceId: "demo",
    name: "Adoption Tour",
    workspacePath: "demo/tour",
    lifecycleStatus: "active",
  };
  const session = {
    sessionId: "session",
    workspaceId: "demo",
    projectId: "project",
    title: "Demo Chat",
    mode: "chat",
    lifecycleStatus: "active",
  };
  const tasks = [1, 2].map((value) => ({
    taskId: `task-${value}`,
    workspaceId: "demo",
    title: "Task",
    status: "inbox",
    priority: "normal",
  }));
  const state = {
    status: "ready",
    workspace: { workspaceId: "demo", name: workspace.name, slug: workspace.slug },
    project: { projectId: "project", name: project.name, workspacePath: project.workspacePath },
    sessions: [{ sessionId: "session", title: session.title, mode: "chat", projectId: "project" }],
    tasks: tasks.map(({ workspaceId: _scope, ...task }) => task),
    starterPrompts: [],
    memorySeeds: [],
    nextRoute: "/chat?sessionId=session",
  };
  const receipt = {
    ...structuredClone(state),
    status: "partial",
    notes: ["Memory seed was withheld"],
    created: {
      workspace: true,
      project: true,
      chatSession: true,
      coworkSession: false,
      codeSession: false,
      coworkTask: true,
      codeTask: true,
      memorySeed: false,
    },
  };
  return { workspace, project, session, tasks, state, receipt };
};

describe("advanced first-run proof evidence", () => {
  it("accepts owner-reordered exact task identities and rejects changed or duplicate records", () => {
    const value = demoFixture();
    value.state.tasks.reverse();
    assertAdvancedDemoRecords(value);
    for (const mutate of [
      (data) => {
        data.state.tasks[0].title = "Changed";
      },
      (data) => {
        data.receipt.tasks[0].taskId = "foreign";
      },
      (data) => {
        data.state.tasks[0] = structuredClone(data.state.tasks[1]);
      },
      (data) => {
        data.receipt.tasks[0] = structuredClone(data.receipt.tasks[1]);
      },
    ]) {
      const data = structuredClone(value);
      mutate(data);
      assert.throws(() => assertAdvancedDemoRecords(data));
    }
  });
  it("requires actual auth bypass off and exact no-op policy intent with a new numeric revision", () => {
    assertAdvancedDefaultsReceipt(defaultsFixture());
    for (const mutate of [
      (value) => {
        value.before.settings.auth.allowLoopbackBypass = true;
      },
      (value) => {
        value.request.markComplete = true;
      },
      (value) => {
        value.after.completed = true;
      },
      (value) => {
        value.after.settings.auth.allowLoopbackBypass = true;
      },
      (value) => {
        value.after.settings.llm.activeModel = "other";
      },
      (value) => {
        value.after.settings.revision++;
      },
      (value) => {
        value.after.firstTask.status = "verified";
      },
    ]) {
      const fixture = defaultsFixture();
      mutate(fixture);
      assert.throws(() => assertAdvancedDefaultsReceipt(fixture));
    }
  });
  it("keeps a partial preparation receipt distinct from ready record counts", () => {
    const value = demoFixture();
    assertAdvancedDemoRecords(value);
    assert.equal(value.receipt.status, "partial");
    assert.equal(value.receipt.notes[0], "Memory seed was withheld");
  });
  it("rejects a foreign, archived or unbound canonical child", () => {
    for (const mutate of [
      (value) => {
        value.workspace.citadelId = "";
      },
      (value) => {
        value.project.workspaceId = "foreign";
      },
      (value) => {
        value.session.lifecycleStatus = "archived";
      },
      (value) => {
        value.session.mode = "code";
      },
      (value) => {
        value.tasks[0].workspaceId = "foreign";
      },
      (value) => {
        value.tasks[0].deletedAt = "2026-09-30";
      },
      (value) => {
        value.state.tasks[0].title = "changed";
      },
    ]) {
      const fixture = demoFixture();
      mutate(fixture);
      assert.throws(() => assertAdvancedDemoRecords(fixture));
    }
  });
  it("allows only the four reviewed bootstrap requests and rejects any execution or approval request", () => {
    const writes = ["onboarding", "onboarding", "demo", "demo"].map((kind, index) => ({
      method: "POST",
      pathname: `/api/v1/${kind}/bootstrap`,
      body: index < 2 ? { ...defaultsFixture().request, expectedRevision: 12 + index } : {},
    }));
    assertAdvancedFirstRunWrites(writes);
    for (const pathname of ["/api/v1/tools/invoke", "/api/v1/chat/demo/agent-send", "/api/v1/approvals/demo/resolve"])
      assert.throws(() => assertAdvancedFirstRunWrites([...writes, { method: "POST", pathname, body: {} }]));
    assert.throws(() =>
      assertAdvancedFirstRunWrites([...writes.slice(0, 3), { ...writes[3], body: { markComplete: true } }]),
    );
  });
});
