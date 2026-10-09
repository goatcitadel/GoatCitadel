// @vitest-environment happy-dom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import type {
  AgentProfileRecord,
  ChatSessionRecord,
  ChatSessionStatusResponse,
  ToolCatalogEntry,
} from "@goatcitadel/contracts";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CapabilityPolicyInspector } from "./CapabilityPolicyInspector";
import {
  inspectSelectedToolPolicy,
  loadPolicyInspectionOptions,
  parsePolicyArguments,
  type PolicyInspectionInput,
} from "./capability-policy-inspection";

const api = vi.hoisted(() => ({
  evaluateToolAccess: vi.fn(),
  fetchEffectivePermissionProfile: vi.fn(),
  fetchToolCatalog: vi.fn(),
  fetchChatSessions: vi.fn(),
  fetchChatSessionStatus: vi.fn(),
  fetchAgent: vi.fn(),
  fetchAgents: vi.fn(),
}));
vi.mock("@goatcitadel/mission-control-shared/api/approvals", () => api);
vi.mock("@goatcitadel/mission-control-shared/api/chat", () => api);
vi.mock("@goatcitadel/mission-control-shared/api/operators-agents-files", () => api);

const now = "2026-09-30T00:00:00.000Z";
const agent: AgentProfileRecord = {
  agentId: "agent-real",
  roleId: "coder",
  name: "Coder",
  title: "Coder",
  summary: "Code",
  specialties: [],
  defaultTools: [],
  aliases: [],
  isBuiltin: true,
  editable: false,
  lifecycleStatus: "active",
  status: "idle",
  sessionCount: 0,
  activeSessions: 0,
  createdAt: now,
  updatedAt: now,
};
const session: ChatSessionRecord = {
  sessionId: "session-real",
  revision: 1,
  sessionKey: "mission:real",
  workspaceId: "workspace-a",
  scope: "mission",
  includeInHistory: true,
  title: "Real conversation",
  pinned: false,
  lifecycleStatus: "active",
  channel: "mission",
  account: "local",
  updatedAt: now,
  lastActivityAt: now,
  tokenTotal: 0,
  costUsdTotal: 0,
};
const unavailable = { availability: "unavailable", reason: "Not relevant to fixture" } as const;
const status: ChatSessionStatusResponse = {
  schemaVersion: "chat.session-status.v1",
  sessionId: session.sessionId,
  workspaceId: "workspace-a",
  generatedAt: now,
  model: unavailable,
  context: unavailable,
  work: unavailable,
  attention: unavailable,
  orchestration: unavailable,
  capabilities: unavailable,
  usage: unavailable,
  build: unavailable,
};
const tool: ToolCatalogEntry = {
  toolName: "fs.read",
  category: "fs",
  riskLevel: "safe",
  requiresApproval: false,
  description: "Read",
  argSchema: {},
  pack: "core",
  examples: [
    {
      title: "Exact path",
      args: {
        path: " ./a b.txt ",
        range: { start: 0, stop: null },
        enabled: false,
        values: ["1", 2],
      },
    },
  ],
};
const profile = {
  workspaceId: "workspace-a",
  sessionId: session.sessionId,
  surface: "tools",
  permissionProfileId: "safe",
  permissionProfile: { profileId: "safe", label: "Safe profile", approvalMode: "approve_all" },
};
const decision = {
  toolName: tool.toolName,
  allowed: true,
  requiresApproval: true,
  riskLevel: "safe",
  reasonCodes: ["approval_required"],
  permissionProfileId: "safe",
};
const input: PolicyInspectionInput = {
  toolName: tool.toolName,
  workspaceId: "workspace-a",
  sessionId: session.sessionId,
  agentId: agent.agentId,
  surface: "tools",
  trustLevel: "trusted_operator",
};
let root: Root;
let container: HTMLDivElement;
beforeEach(() => {
  for (const mock of Object.values(api)) mock.mockReset();
  api.fetchAgents.mockResolvedValue({ items: [agent] });
  api.fetchAgent.mockResolvedValue(agent);
  api.fetchChatSessions.mockResolvedValue({ items: [session] });
  api.fetchChatSessionStatus.mockResolvedValue(status);
  api.fetchToolCatalog.mockResolvedValue({ items: [tool] });
  api.fetchEffectivePermissionProfile.mockResolvedValue(profile);
  api.evaluateToolAccess.mockResolvedValue(decision);
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
});
afterEach(() => {
  act(() => root.unmount());
  container.remove();
});
async function render(workspaceId = "workspace-a", toolName: string | undefined = tool.toolName) {
  await act(async () => root.render(<CapabilityPolicyInspector workspaceId={workspaceId} toolName={toolName} />));
}
async function click(label: string) {
  const element = [...container.querySelectorAll("button")].find((button) => button.textContent === label);
  if (!element) throw new Error(`Missing button ${label}`);
  await act(async () => element.click());
}
async function select(label: string, value: string) {
  const element = [...container.querySelectorAll("label")]
    .find((item) => item.firstChild?.textContent === label)
    ?.querySelector("select");
  if (!element) throw new Error(`Missing select ${label}`);
  await act(async () => {
    element.value = value;
    element.dispatchEvent(new Event("change", { bubbles: true }));
  });
}
async function openForm() {
  await render();
  await click("Inspect access rules");
  await select("Agent", agent.agentId);
  await select("Conversation", session.sessionId);
}
function deferred<T>() {
  let resolve!: (value: T) => void;
  return {
    promise: new Promise<T>((done) => {
      resolve = done;
    }),
    resolve: (value: T) => resolve(value),
  };
}

describe("Library context policy inspection", () => {
  it("loads real choices on request and only records evaluation on explicit submit, with exact example arguments", async () => {
    await render();
    expect(api.fetchAgents).not.toHaveBeenCalled();
    expect(api.evaluateToolAccess).not.toHaveBeenCalled();
    await click("Inspect access rules");
    expect(api.fetchChatSessions).toHaveBeenCalledWith({
      workspaceId: "workspace-a",
      scope: "mission",
      view: "active",
      limit: 50,
    });
    expect(container.querySelector("textarea")).toBeNull();
    expect(container.textContent).toContain("records an advisory decision");
    await select("Agent", agent.agentId);
    await select("Conversation", session.sessionId);
    await select("Arguments to evaluate", "0");
    expect(api.evaluateToolAccess).not.toHaveBeenCalled();
    await click("Evaluate selected context");
    expect(api.evaluateToolAccess).toHaveBeenCalledExactlyOnceWith({ ...input, args: tool.examples[0]!.args });
    expect(container.textContent).toContain("Approval would be required");
    expect(container.textContent).toContain("Safe profile");
    expect(api.fetchChatSessionStatus).toHaveBeenCalledTimes(2);
    expect(api.fetchAgent).toHaveBeenCalledWith(agent.agentId);
  });
  it("preserves omitted arguments versus an explicitly empty object", async () => {
    await inspectSelectedToolPolicy(input, () => true);
    expect(api.evaluateToolAccess.mock.calls[0]![0]).not.toHaveProperty("args");
    await inspectSelectedToolPolicy({ ...input, args: {} }, () => true);
    expect(api.evaluateToolAccess.mock.calls[1]![0]).toHaveProperty("args", {});
  });
  it("filters foreign and missing scope conversations and reports bounded samples", async () => {
    api.fetchChatSessions.mockResolvedValue({
      items: [
        session,
        { ...session, sessionId: "foreign", workspaceId: "workspace-b" },
        { ...session, sessionId: "missing", workspaceId: undefined },
      ],
      nextCursor: "more",
    });
    const options = await loadPolicyInspectionOptions("workspace-a", tool.toolName);
    expect(options.sessions).toEqual([session]);
    expect(options.sessionsPartial).toBe(true);
  });
  it.each(["foreign session", "inactive agent", "foreign profile", "missing tool"])(
    "does not evaluate after owner recheck finds %s",
    async (failure) => {
      if (failure === "foreign session")
        api.fetchChatSessionStatus.mockResolvedValue({ ...status, workspaceId: "workspace-b" });
      if (failure === "inactive agent") api.fetchAgent.mockResolvedValue({ ...agent, lifecycleStatus: "archived" });
      if (failure === "foreign profile")
        api.fetchEffectivePermissionProfile.mockResolvedValue({ ...profile, workspaceId: "workspace-b" });
      if (failure === "missing tool") api.fetchToolCatalog.mockResolvedValue({ items: [] });
      await expect(inspectSelectedToolPolicy(input, () => true)).rejects.toThrow();
      expect(api.evaluateToolAccess).not.toHaveBeenCalled();
    },
  );
  it.each(["different tool", "missing boolean", "changed profile", "changed override"])(
    "withholds %s result evidence",
    async (failure) => {
      if (failure === "different tool") api.evaluateToolAccess.mockResolvedValue({ ...decision, toolName: "fs.write" });
      if (failure === "missing boolean") api.evaluateToolAccess.mockResolvedValue({ ...decision, allowed: undefined });
      if (failure === "changed profile")
        api.fetchEffectivePermissionProfile
          .mockResolvedValueOnce(profile)
          .mockResolvedValue({
            ...profile,
            permissionProfileId: "new",
            permissionProfile: { ...profile.permissionProfile, profileId: "new" },
          });
      if (failure === "changed override")
        api.evaluateToolAccess.mockResolvedValue({ ...decision, localOperatorOverrideId: "unexpected" });
      await expect(inspectSelectedToolPolicy(input, () => true)).rejects.toThrow();
    },
  );
  it.each([{ label: "Renamed profile" }, { deny: ["fs.read"] }, { revision: "new-revision" }])(
    "withholds same-ID permission profile edits: %j",
    async (edit) => {
      api.fetchEffectivePermissionProfile
        .mockResolvedValueOnce(profile)
        .mockResolvedValue({ ...profile, permissionProfile: { ...profile.permissionProfile, ...edit } });
      await openForm();
      await click("Evaluate selected context");
      expect(api.evaluateToolAccess).toHaveBeenCalledOnce();
      expect(container.querySelector('[aria-label="Advisory policy result"]')).toBeNull();
      expect(container.querySelector('[role="alert"]')?.textContent).toContain("policy context changed");
      expect(container.textContent).not.toContain("Renamed profile");
    },
  );
  it.each([{ expiresAt: "2026-09-30T00:20:00.000Z" }, { status: "revoked" }, { revision: "new-revision" }])(
    "withholds same-ID operator override edits: %j",
    async (edit) => {
      const override = {
        overrideId: "override-a",
        operatorId: "operator-a",
        scope: "session",
        scopeRef: session.sessionId,
        reason: "Fixture",
        status: "active",
        createdBy: "operator-a",
        createdAt: now,
        expiresAt: "2026-09-30T00:10:00.000Z",
      };
      const before = { ...profile, localOperatorOverrideId: override.overrideId, localOperatorOverride: override };
      api.fetchEffectivePermissionProfile
        .mockResolvedValueOnce(before)
        .mockResolvedValue({ ...before, localOperatorOverride: { ...override, ...edit } });
      api.evaluateToolAccess.mockResolvedValue({ ...decision, localOperatorOverrideId: override.overrideId });
      await expect(inspectSelectedToolPolicy(input, () => true)).rejects.toThrow("policy context changed");
    },
  );
  it("compares canonical snapshots without treating object key order as an edit", async () => {
    api.fetchEffectivePermissionProfile
      .mockResolvedValueOnce(profile)
      .mockResolvedValue({
        ...profile,
        permissionProfile: { approvalMode: "approve_all", label: "Safe profile", profileId: "safe" },
      });
    await expect(inspectSelectedToolPolicy(input, () => true)).resolves.toMatchObject({ profileLabel: "Safe profile" });
  });
  it("does not evaluate an override ID with no matching owner snapshot", async () => {
    api.fetchEffectivePermissionProfile.mockResolvedValue({ ...profile, localOperatorOverrideId: "override-a" });
    await expect(inspectSelectedToolPolicy(input, () => true)).rejects.toThrow("override has incomplete");
    expect(api.evaluateToolAccess).not.toHaveBeenCalled();
  });
  it("clears a completed result immediately when context changes", async () => {
    await openForm();
    await click("Evaluate selected context");
    expect(container.querySelector('[aria-label="Advisory policy result"]')).not.toBeNull();
    await select("Input trust", "untrusted_external");
    expect(container.querySelector('[aria-label="Advisory policy result"]')).toBeNull();
    expect(api.evaluateToolAccess).toHaveBeenCalledOnce();
  });
  it("ignores an evaluation that completes after argument selection changes", async () => {
    const reply = deferred<typeof decision>();
    api.evaluateToolAccess.mockReturnValue(reply.promise);
    await openForm();
    await click("Evaluate selected context");
    await select("Arguments to evaluate", "0");
    await act(async () => reply.resolve(decision));
    expect(container.querySelector('[aria-label="Advisory policy result"]')).toBeNull();
    expect(container.querySelector('[role="alert"]')).toBeNull();
  });
  it("ignores pending evaluations on workspace change and only preselects unique owner identities", async () => {
    const reply = deferred<typeof decision>();
    api.evaluateToolAccess.mockReturnValue(reply.promise);
    await openForm();
    await click("Evaluate selected context");
    await render("workspace-b");
    await act(async () => reply.resolve(decision));
    expect(container.querySelector('[aria-label="Advisory policy result"]')).toBeNull();
    expect([...container.querySelectorAll("select")].slice(0, 2).map((item) => item.value)).toEqual(["agent-real", ""]);
  });
  it("does not materialize a decision when selection expires during owner reads", async () => {
    const reply = deferred<typeof agent>();
    api.fetchAgent.mockReturnValue(reply.promise);
    let current = true;
    const reading = inspectSelectedToolPolicy(input, () => current);
    current = false;
    reply.resolve(agent);
    await expect(reading).rejects.toThrow("no longer active");
    expect(api.evaluateToolAccess).not.toHaveBeenCalled();
  });
  it("rejects non-object and oversized arguments without changing scalar, nested, or whitespace semantics", () => {
    for (const text of ["null", "[]", "1", "false", "{", '"text"']) expect(() => parsePolicyArguments(text)).toThrow();
    expect(() => parsePolicyArguments(JSON.stringify({ path: "x".repeat(17_000) }))).toThrow("16 KiB");
    expect(parsePolicyArguments(JSON.stringify(tool.examples[0]!.args))).toEqual(tool.examples[0]!.args);
  });
  it("shows an unavailable state after evaluation failure without retaining the previous result", async () => {
    await openForm();
    await click("Evaluate selected context");
    api.evaluateToolAccess.mockRejectedValue(new Error("Gateway disconnected"));
    await click("Evaluate selected context");
    expect(container.querySelector('[aria-label="Advisory policy result"]')).toBeNull();
    expect(container.querySelector('[role="alert"]')?.textContent).toContain("Gateway disconnected");
  });
});
