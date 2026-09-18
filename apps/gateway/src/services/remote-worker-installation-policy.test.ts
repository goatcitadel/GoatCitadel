import { beforeEach, describe, expect, it, vi } from "vitest";
import { remoteWorkerRuntimeInstallRequestSha256, type ToolAccessEvaluateResponse, type ToolAccessEvaluateRequest, type ToolPolicyConfig } from "@goatcitadel/contracts";
import { ToolPolicyEngine } from "@goatcitadel/policy-engine";
import { resolveRemoteWorkerChatProfile } from "./remote-worker-chat-authority.js";
import { createRemoteWorkerInstallationPolicy } from "./remote-worker-installation-policy.js";
vi.mock("./remote-worker-chat-authority.js", () => ({ resolveRemoteWorkerChatProfile: vi.fn() }));
function fixture() {
  const installation = { schemaVersion: "goatcitadel.worker-runtime-install.v1" as const, nonce: "1".repeat(64), journalIdentityHex: "2".repeat(48),
    preparedSha256: "3".repeat(64), checkpointSha256: "4".repeat(64), packageSha256: "5".repeat(64),
    runtimeBundle: { schemaVersion: "goatcitadel.worker-runtime-bundle.v1" as const, files: [
      { relativePath: "node.exe", bytes: 5, sha256: "6".repeat(64) }, { relativePath: "worker-host-receipt.json", bytes: 7, sha256: "7".repeat(64) }] } };
  const input = { registryWorkspaceId: "registry", assignmentId: "assignment", assignmentGeneration: 1, leaseRevision: 1,
    leaseTokenSha256: "8".repeat(64), protectedAuthority: { credentialAuthority: {}, meshAdmission: {} } as never,
    nonce: installation.nonce, requestSha256: remoteWorkerRuntimeInstallRequestSha256(installation) };
  const manifest = { requiredCapabilityClasses: ["durable_compute"], durableRunId: "run", taskId: "task" };
  const binding = { profile: { identity: { workspaceId: "workspace", sessionId: "session", citadelId: "citadel" } },
    policy: { permissionProfileId: "danger", authActorId: "operator" } };
  vi.mocked(resolveRemoteWorkerChatProfile).mockResolvedValue(binding as never);
  const validateReviewForAssignment = vi.fn(async () => installation);
  const resolveActiveChatExecution = vi.fn(async () => ({ authority: { assignment: { manifest } } }));
  const inspect = vi.fn(async (_request: ToolAccessEvaluateRequest): Promise<ToolAccessEvaluateResponse> => ({ toolName: "remote_worker.native_runtime_install", allowed: true,
    requiresApproval: true, reasonCodes: [], riskLevel: "danger" }));
  const owner = createRemoteWorkerInstallationPolicy({ storage: { remoteWorkerRuntimeInstalls: { validateReviewForAssignment },
    remoteWorkerAssignments: { resolveActiveChatExecution } } } as never, inspect);
  return { input, installation, manifest, binding, validateReviewForAssignment, resolveActiveChatExecution, inspect, owner, stop: new AbortController() };
}
beforeEach(() => vi.resetAllMocks());
describe("canonical native installation policy", () => {
  it("connects canonical review to real deny-wins policy and observes revocation", async () => {
    const f = fixture();
    const config: ToolPolicyConfig = { tools: { allow: ["*"], deny: [] }, agents: {},
      sandbox: { writeJailRoots: [], readOnlyRoots: [], networkAllowlist: [], riskyShellPatterns: [], requireApprovalForRiskyShell: true } };
    const engine = new ToolPolicyEngine(config, { toolGrants: { listActive: async () => [] }, citadels: { listWards: async () => [] } } as never);
    f.inspect.mockImplementation(request => engine.inspectNativeInstallation(request));
    await f.owner.verify(f.input, f.stop.signal);
    config.tools.deny = ["remote_worker.*"];
    await expect(f.owner.verify(f.input, f.stop.signal)).rejects.toThrow(/denied/u);
  });
  it("uses the exact approved package and canonical Chat policy", async () => {
    const f = fixture(); await f.owner.verify(f.input, f.stop.signal);
    expect(f.inspect).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ toolName: "remote_worker.native_runtime_install",
      workspaceId: "workspace", runId: "run", policyContext: f.binding.policy, args: { installation: f.installation } }));
    expect(f.validateReviewForAssignment).toHaveBeenCalledTimes(2);
  });
  it.each(["deny", "grant", "wrong-tool", "require_dry_run", "route_local", "redact"])("refuses %s", async failure => {
    const f = fixture(); f.inspect.mockResolvedValue({ toolName: failure === "wrong-tool" ? "shell.exec" : "remote_worker.native_runtime_install",
      allowed: failure !== "deny", requiresApproval: true, riskLevel: "danger", reasonCodes: [],
      ...(failure === "grant" ? { matchedGrantId: "grant" } : {}),
      ...(["require_dry_run", "route_local", "redact"].includes(failure) ? { wardEffect: failure as "require_dry_run" } : {}) });
    await expect(f.owner.verify(f.input, f.stop.signal)).rejects.toThrow(/denied/u);
  });
  it.each(["review", "profile", "manifest", "cancel"])("refuses authority changed during inspection: %s", async failure => {
    const f = fixture(); f.inspect.mockImplementation(async () => {
      if (failure === "review") f.validateReviewForAssignment.mockRejectedValue(new Error("review revoked"));
      if (failure === "profile") f.binding.policy.authActorId = "another";
      if (failure === "manifest") f.manifest.taskId = "another";
      if (failure === "cancel") f.stop.abort();
      return { toolName: "remote_worker.native_runtime_install", allowed: true, requiresApproval: true, reasonCodes: [], riskLevel: "danger" };
    });
    await expect(f.owner.verify(f.input, f.stop.signal)).rejects.toThrow();
  });
  it("refuses a foreign review before policy inspection", async () => {
    const f = fixture(); f.input.requestSha256 = "9".repeat(64);
    await expect(f.owner.verify(f.input, f.stop.signal)).rejects.toThrow(/differs/u); expect(f.inspect).not.toHaveBeenCalled();
  });
  it("checks cancellation before reading canonical storage", async () => {
    const f = fixture(); f.stop.abort(); await expect(f.owner.verify(f.input, f.stop.signal)).rejects.toThrow();
    expect(f.validateReviewForAssignment).not.toHaveBeenCalled();
  });
});
