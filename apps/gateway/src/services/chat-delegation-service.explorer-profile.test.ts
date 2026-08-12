import type { ToolPolicyConfig } from "@goatcitadel/contracts";
import { isToolAllowed, resolveEffectivePolicy, ToolPolicyEngine } from "@goatcitadel/policy-engine";
import { describe, expect, it } from "vitest";
import {
  buildReadOnlyExplorerPolicyContext,
  buildWorkspaceExplorerReport,
  isReadOnlyWorkspaceExplorerRun,
  READ_ONLY_EXPLORER_ALLOWED_TOOLS,
  READ_ONLY_EXPLORER_PERMISSION_PROFILE,
  READ_ONLY_EXPLORER_WORKFLOW_TEMPLATE,
} from "./chat-delegation-service.js";

const PERMISSIVE_POLICY: ToolPolicyConfig = {
  profiles: {},
  tools: { profile: "danger", approvalMode: "bypass", allow: ["*"], deny: [] },
  agents: {},
  sandbox: {
    writeJailRoots: ["./workspace"],
    readOnlyRoots: [],
    readAccessMode: "full_disk",
    networkAllowlist: ["*"],
    riskyShellPatterns: [],
    requireApprovalForRiskyShell: false,
  },
};

describe("read-only workspace explorer policy", () => {
  it("keeps only bounded filesystem reads and the delegated result envelope callable", () => {
    const effective = resolveEffectivePolicy(
      PERMISSIVE_POLICY,
      "workspace explorer",
      READ_ONLY_EXPLORER_PERMISSION_PROFILE,
    );

    for (const toolName of READ_ONLY_EXPLORER_ALLOWED_TOOLS) {
      expect(isToolAllowed(effective, toolName), `${toolName} should remain callable`).toBe(true);
    }
    for (const toolName of [
      "fs.write",
      "fs.copy",
      "shell.exec",
      "git.status",
      "browser.search",
      "http.get",
      "mcp.invoke",
      "memory.read",
      "context.fetch",
      "embeddings.query",
      "session.status",
      "channel.send",
      "tests.run",
      "code_mode.run",
    ]) {
      expect(isToolAllowed(effective, toolName), `${toolName} must be denied`).toBe(false);
    }
    expect(effective.readAccessMode).toBe("roots_only");
  });

  it("enforces the explorer profile as an upper bound over a base-allowed runtime tool", async () => {
    const engine = new ToolPolicyEngine(
      {
        ...PERMISSIVE_POLICY,
        sandbox: { ...PERMISSIVE_POLICY.sandbox, writeJailRoots: [process.cwd()] },
      },
      { toolGrants: { listActive: async () => [] } } as never,
    );

    await expect(
      engine.inspectAccess({
        toolName: "runtime.configure",
        args: {},
        agentId: "workspace-explorer",
        sessionId: "child-1",
        policyContext: {
          permissionProfileId: READ_ONLY_EXPLORER_PERMISSION_PROFILE.profileId,
          permissionProfile: READ_ONLY_EXPLORER_PERMISSION_PROFILE,
        },
      }),
    ).resolves.toMatchObject({
      allowed: false,
      requiresApproval: false,
      reasonCodes: ["permission_profile_upper_bound"],
      permissionProfileId: READ_ONLY_EXPLORER_PERMISSION_PROFILE.profileId,
    });
  });

  it("allows bounded explorer reads without an ordinary approval while retaining the profile ceiling", async () => {
    const engine = new ToolPolicyEngine(
      {
        ...PERMISSIVE_POLICY,
        sandbox: { ...PERMISSIVE_POLICY.sandbox, writeJailRoots: [process.cwd()] },
      },
      { toolGrants: { listActive: async () => [] } } as never,
    );

    await expect(
      engine.inspectAccess({
        toolName: "fs.read",
        args: { path: "package.json" },
        agentId: "workspace-explorer",
        sessionId: "child-1",
        policyContext: {
          permissionProfileId: READ_ONLY_EXPLORER_PERMISSION_PROFILE.profileId,
          permissionProfile: READ_ONLY_EXPLORER_PERMISSION_PROFILE,
        },
      }),
    ).resolves.toMatchObject({
      allowed: true,
      requiresApproval: false,
      permissionProfileId: READ_ONLY_EXPLORER_PERMISSION_PROFILE.profileId,
    });
  });

  it("drops inherited override and web authority while rebinding the child scope", () => {
    const context = buildReadOnlyExplorerPolicyContext(
      {
        operatorId: "operator-1",
        authActorId: "operator-1",
        localOperatorOverrideId: "override-danger",
        localOperatorOverride: {
          overrideId: "override-danger",
          operatorId: "operator-1",
          scope: "run",
          reason: "test",
          status: "active",
          createdBy: "operator-1",
          createdAt: "2026-08-12T00:00:00.000Z",
          expiresAt: "2026-08-12T01:00:00.000Z",
        },
        fullWebAccess: true,
      },
      { workspaceId: "workspace-1", sessionId: "child-1", taskId: "task-1", runId: "run-1" },
    );

    expect(context).toMatchObject({
      operatorId: "operator-1",
      authActorId: "operator-1",
      workspaceId: "workspace-1",
      sessionId: "child-1",
      taskId: "task-1",
      runId: "run-1",
      surface: "chat",
      fullWebAccess: false,
      permissionProfile: READ_ONLY_EXPLORER_PERMISSION_PROFILE,
    });
    expect(context.localOperatorOverrideId).toBeUndefined();
    expect(context.localOperatorOverride).toBeUndefined();
  });

  it("rebuilds the structured report only from canonical persisted explorer records", () => {
    const report = buildWorkspaceExplorerReport(
      {
        runId: "explorer-1",
        sessionId: "session-1",
        taskId: "task-1",
        objective: "Find the owner",
        roles: ["workspace-explorer"],
        mode: "sequential",
        status: "partial",
        workflowTemplate: READ_ONLY_EXPLORER_WORKFLOW_TEMPLATE,
        stitchedOutput: "Gateway owns runtime truth.",
        citations: [],
        startedAt: "2026-08-12T00:00:00.000Z",
      },
      [
        {
          stepId: "step-1",
          runId: "explorer-1",
          role: "workspace-explorer",
          status: "running",
          index: 0,
          startedAt: "2026-08-12T00:00:00.000Z",
          output: "Search was interrupted before tests were checked.",
          scopeControl: {
            rootPath: "F:\\code\\personal-ai",
            requestedPaths: ["apps/gateway"],
            resolvedPaths: ["F:\\code\\personal-ai\\apps\\gateway"],
            approvedPaths: ["apps/gateway"],
            scopeHash: "scope-1",
            dispatchGeneration: 1,
          },
          workResult: {
            disposition: "blocked",
            summary: "Need the tests folder.",
            evidenceRefs: ["apps/gateway/src/services/gateway-service.ts"],
            scopeHash: "scope-1",
            dispatchGeneration: 1,
            submittedAt: "2026-08-12T00:01:00.000Z",
          },
        },
      ],
    );

    expect(report).toEqual({
      profile: "read_only_explorer",
      answer: "Gateway owns runtime truth.",
      evidenceReferences: ["apps/gateway/src/services/gateway-service.ts"],
      searchedScope: {
        kind: "server_owned_delegated_scope",
        approvedPaths: ["apps/gateway"],
        scopeHashes: ["scope-1"],
      },
      partialResult: true,
      gaps: ["Need the tests folder.", "Search was interrupted before tests were checked."],
    });
  });

  it("contains legacy absolute paths when rebuilding a persisted explorer report", () => {
    const report = buildWorkspaceExplorerReport(
      {
        runId: "explorer-paths",
        sessionId: "session-1",
        taskId: "task-1",
        objective: "Find the owner",
        roles: ["workspace-explorer"],
        mode: "sequential",
        status: "partial",
        workflowTemplate: READ_ONLY_EXPLORER_WORKFLOW_TEMPLATE,
        stitchedOutput:
          "Owner: F:\\private\\workspace\\apps\\gateway\\src\\owner.ts; private: C:\\Users\\operator\\secret.txt",
        citations: [],
        startedAt: "2026-08-12T00:00:00.000Z",
      },
      [
        {
          stepId: "step-paths",
          runId: "explorer-paths",
          role: "workspace-explorer",
          status: "failed",
          index: 0,
          startedAt: "2026-08-12T00:00:00.000Z",
          error: "Failed at F:\\private\\workspace\\apps\\gateway; host /home/operator/private",
          scopeControl: {
            rootPath: "F:\\private\\workspace",
            approvedPaths: ["apps/gateway"],
            scopeHash: "scope-paths",
            dispatchGeneration: "dispatch-paths",
          },
          workResult: {
            disposition: "blocked",
            summary: "Could not read F:\\private\\workspace\\apps\\gateway\\src\\owner.ts",
            changedFiles: [],
            evidenceRefs: ["F:\\private\\workspace\\apps\\gateway\\src\\owner.ts"],
          },
        },
      ],
    );

    expect(report).toMatchObject({
      answer: "Owner: apps\\gateway\\src\\owner.ts; private: [outside-workspace-path]",
      evidenceReferences: ["apps/gateway/src/owner.ts"],
      gaps: expect.arrayContaining([
        "Could not read apps\\gateway\\src\\owner.ts",
        "Failed at apps\\gateway; host [outside-workspace-path]",
      ]),
    });
    expect(JSON.stringify(report)).not.toContain("F:\\private");
    expect(JSON.stringify(report)).not.toContain("/home/operator");
  });

  it("does not infer explorer authority from an unfenced role-only delegation", () => {
    const roleOnlyRun = {
      runId: "standard-role-only-1",
      sessionId: "session-1",
      taskId: "task-1",
      objective: "Inspect the workspace",
      roles: ["workspace-explorer"],
      mode: "sequential" as const,
      status: "completed" as const,
      stitchedOutput: "This came from a standard delegation.",
      citations: [],
      startedAt: "2026-08-12T00:00:00.000Z",
    };

    expect(isReadOnlyWorkspaceExplorerRun(roleOnlyRun)).toBe(false);
    expect(buildWorkspaceExplorerReport(roleOnlyRun, [])).toBeUndefined();
    expect(
      isReadOnlyWorkspaceExplorerRun({
        ...roleOnlyRun,
        workflowTemplate: READ_ONLY_EXPLORER_WORKFLOW_TEMPLATE,
      }),
    ).toBe(true);
  });
});
