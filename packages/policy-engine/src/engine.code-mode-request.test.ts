import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { PermissionProfileRecord, ToolInvokeRequest, ToolPolicyConfig } from "@goatcitadel/contracts";
import { createSqliteAsyncStorage, Storage, type AsyncStorage } from "@goatcitadel/storage";
import { ToolPolicyEngine } from "./engine.js";
import { CODE_MODE_REQUEST_TOOL_NAME } from "./tool-registry.js";

const CREATED_AT = "2026-10-30T00:00:00.000Z";

function profile(
  profileId: string,
  approvalMode: PermissionProfileRecord["approvalMode"],
  allow: string[],
): PermissionProfileRecord {
  return {
    profileId,
    label: profileId,
    description: `${profileId} test profile`,
    builtin: true,
    status: "active",
    scope: "global",
    approvalMode,
    toolPatterns: ["*"],
    allow,
    deny: [],
    readAccessMode: "approval_required",
    defaultForSurfaces: [],
    createdBy: "system",
    createdAt: CREATED_AT,
    updatedAt: CREATED_AT,
  };
}

const SAFE_PROFILE = profile("safe", "approve_all", []);
const TRUSTED_LOCAL_POWER_PROFILE = profile("trusted_local_power", "bypass", ["*"]);

const policyConfig: ToolPolicyConfig = {
  tools: { approvalMode: "bypass", allow: ["*"], deny: [] },
  agents: {},
  sandbox: {
    writeJailRoots: [],
    readOnlyRoots: [],
    networkAllowlist: [],
    riskyShellPatterns: [],
    requireApprovalForRiskyShell: true,
  },
};

let directory: string;
let storage: AsyncStorage;

beforeEach(async () => {
  directory = await mkdtemp(path.join(os.tmpdir(), "goat-code-mode-request-"));
  storage = createSqliteAsyncStorage(
    new Storage({
      dbPath: ":memory:",
      transcriptsDir: path.join(directory, "transcripts"),
      auditDir: path.join(directory, "audit"),
    }),
  );
});

afterEach(async () => {
  await storage?.close();
  await rm(directory, { recursive: true, force: true });
});

function codeModeRequest(overrides: Partial<ToolInvokeRequest> = {}): ToolInvokeRequest {
  return {
    toolName: CODE_MODE_REQUEST_TOOL_NAME,
    args: { goal: "count the pages of plan.pdf", source: "return 3;" },
    agentId: "assistant",
    sessionId: "session-code-mode",
    turnId: "turn-code-mode",
    toolRunId: "tool-run-code-mode",
    surface: "chat",
    ...overrides,
  };
}

describe("code_mode.request approval", () => {
  it("code_mode.request always needs approval", async () => {
    const runCodeModeRequest = vi.fn(async () => ({ status: "completed" }));
    const engine = new ToolPolicyEngine(policyConfig, storage, undefined, { runCodeModeRequest });

    const underSafe = await engine.invoke(
      codeModeRequest({
        permissionProfileId: SAFE_PROFILE.profileId,
        policyContext: { permissionProfileId: SAFE_PROFILE.profileId, permissionProfile: SAFE_PROFILE },
      }),
    );
    const underBypass = await engine.invoke(
      codeModeRequest({
        permissionProfileId: TRUSTED_LOCAL_POWER_PROFILE.profileId,
        policyContext: {
          permissionProfileId: TRUSTED_LOCAL_POWER_PROFILE.profileId,
          permissionProfile: TRUSTED_LOCAL_POWER_PROFILE,
        },
      }),
    );
    await storage.toolGrants.create({
      toolPattern: "code_mode.*",
      decision: "allow",
      scope: "session",
      scopeRef: "session-code-mode",
      grantType: "persistent",
      createdBy: "operator",
    });
    const underGrant = await engine.invoke(codeModeRequest());

    for (const result of [underSafe, underBypass, underGrant]) {
      expect(result.outcome).toBe("approval_required");
      expect(result.approvalId).toEqual(expect.any(String));
    }
    expect(runCodeModeRequest).not.toHaveBeenCalled();
  });

  it("does not run from a re-sent approval reference", async () => {
    const runCodeModeRequest = vi.fn(async () => ({ status: "completed" }));
    const engine = new ToolPolicyEngine(policyConfig, storage, undefined, { runCodeModeRequest });
    const first = await engine.invoke(codeModeRequest());
    await storage.approvals.resolve(first.approvalId!, { decision: "approve", resolvedBy: "operator" });

    const resent = await engine.invoke(codeModeRequest({ consentContext: { reason: `approval:${first.approvalId}` } }));

    expect(resent.outcome).toBe("approval_required");
    expect(resent.approvalId).not.toBe(first.approvalId);
    expect(runCodeModeRequest).not.toHaveBeenCalled();
  });

  it("stamps approvedByApprovalId only on approved execution", async () => {
    const seen: ToolInvokeRequest[] = [];
    const runCodeModeRequest = vi.fn(async (request: ToolInvokeRequest) => {
      seen.push(request);
      return { status: "completed", result: { pages: 3 } };
    });
    const engine = new ToolPolicyEngine(policyConfig, storage, undefined, { runCodeModeRequest });

    const requested = await engine.invoke(codeModeRequest({ approvedByApprovalId: "forged-approval" }));
    expect(requested.outcome).toBe("approval_required");
    const approvalId = requested.approvalId!;
    const pending = await storage.pendingApprovalActions.find(approvalId);
    expect(pending?.request).not.toHaveProperty("approvedByApprovalId");
    expect(runCodeModeRequest).not.toHaveBeenCalled();

    await storage.approvals.resolve(approvalId, { decision: "approve", resolvedBy: "operator" });
    const executed = await engine.executeApprovedAction(approvalId);

    expect(executed?.outcome).toBe("executed");
    expect(executed?.result).toMatchObject({ status: "completed", result: { pages: 3 } });
    expect(runCodeModeRequest).toHaveBeenCalledTimes(1);
    expect(seen[0]?.approvedByApprovalId).toBe(approvalId);
  });

  it("strips a caller-supplied approval id from tools that run without approval", async () => {
    const engine = new ToolPolicyEngine(
      { ...policyConfig, tools: { ...policyConfig.tools, approvalMode: "approve_risky" } },
      storage,
      undefined,
      { readToolArtifact: async (request) => ({ approvedByApprovalId: request.approvedByApprovalId ?? null }) },
    );
    const result = await engine.invoke({
      toolName: "tool_artifact.read",
      args: { artifactId: "0c5081e8-73f9-4803-8778-61ecf9cbd5a8" },
      agentId: "assistant",
      sessionId: "session-code-mode",
      approvedByApprovalId: "forged-approval",
    });
    expect(result.outcome).toBe("executed");
    expect(result.result).toMatchObject({ approvedByApprovalId: null });
  });
});
