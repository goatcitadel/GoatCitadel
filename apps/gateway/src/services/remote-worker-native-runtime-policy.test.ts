import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ToolAccessEvaluateResponse } from "@goatcitadel/contracts";
import { windowsRuntimeDispatchFixture } from "../../../remote-worker/src/worker-windows-runtime-dispatch-test-fixture.js";
import { resolveRemoteWorkerChatProfile } from "./remote-worker-chat-authority.js";
import { createRemoteWorkerNativeRuntimePolicy } from "./remote-worker-native-runtime-policy.js";
vi.mock("./remote-worker-chat-authority.js", () => ({ resolveRemoteWorkerChatProfile: vi.fn() }));
function fixture() {
  const request = windowsRuntimeDispatchFixture(), stop = new AbortController();
  const input = { registryWorkspaceId: "registry", assignmentId: "assignment", assignmentGeneration: 1, leaseRevision: 1,
    leaseTokenSha256: "11".repeat(32), protectedAuthority: { credentialAuthority: {}, meshAdmission: {} } as never,
    launch: request.launch, inventoryLimits: request.inventoryLimits, signal: stop.signal };
  const manifest = { requiredCapabilityClasses: ["durable_compute", "governed_tool"], taskId: "task", durableRunId: "run" };
  const binding = { profile: { identity: { sessionId: "session", workspaceId: "execution", citadelId: "citadel" },
    selection: { tools: [{ canonicalName: "shell.exec", runtimeOwner: { kind: "builtin" }, effectPotential: { potential: "effectful" } }] } }, policy: { permissionProfileId: "safe", authActorId: "operator" } };
  vi.mocked(resolveRemoteWorkerChatProfile).mockResolvedValue(binding as never);
  const resolveActiveChatExecution = vi.fn(async () => ({ authority: { assignment: { manifest } } }));
  const evaluate = vi.fn(async (_request: unknown): Promise<ToolAccessEvaluateResponse> => ({ toolName: "shell.exec", allowed: true, requiresApproval: true, reasonCodes: [], riskLevel: "danger" }));
  const inspectAdmitted = vi.fn(async (_request: unknown, _authority: unknown): Promise<ToolAccessEvaluateResponse> => ({ toolName: "shell.exec", allowed: true, requiresApproval: true, reasonCodes: [], riskLevel: "danger" }));
  const owner = createRemoteWorkerNativeRuntimePolicy({ storage: { remoteWorkerAssignments: { resolveActiveChatExecution } } } as never, evaluate, undefined, inspectAdmitted);
  return { input, stop, manifest, binding, evaluate, inspectAdmitted, resolveActiveChatExecution, owner };
}
beforeEach(() => vi.resetAllMocks());
describe("native execution uses current Chat tool policy", () => {
  it("routes admitted authorization through the reservation reader without fresh-call evaluation", async () => {
    const f = fixture(), input = { ...f.input, nonce: "33".repeat(32), requestSha256: "44".repeat(32) };
    await f.owner.authorizeAdmitted(input);
    expect(f.evaluate).not.toHaveBeenCalled();
    expect(f.inspectAdmitted).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ toolName: "shell.exec", policyContext: f.binding.policy }),
      expect.objectContaining({ nonce: input.nonce, requestSha256: input.requestSha256, assignmentId: input.assignmentId }));
    expect(f.resolveActiveChatExecution).toHaveBeenCalledTimes(2);
  });
  it("propagates a revoked reservation without falling back to fresh policy evaluation", async () => {
    const f = fixture(); f.inspectAdmitted.mockRejectedValue(new Error("reservation revoked"));
    await expect(f.owner.authorizeAdmitted({ ...f.input, nonce: "33".repeat(32), requestSha256: "44".repeat(32) })).rejects.toThrow("revoked");
    expect(f.evaluate).not.toHaveBeenCalled();
  });
  it.each(["require_dry_run", "route_local", "redact", "deny"] as const)("refuses an allowed decision carrying an unenforced %s Ward", async wardEffect => {
    const f = fixture();
    f.evaluate.mockResolvedValue({ toolName: "shell.exec", allowed: true, requiresApproval: true, reasonCodes: [], riskLevel: "danger", wardEffect });
    await expect(f.owner.authorize(f.input)).rejects.toThrow("Ward");
    expect(f.evaluate).toHaveBeenCalledOnce();
  });
  it.each([undefined, "allow", "require_approval"] as const)("preserves native review for the %s Ward decision", async wardEffect => {
    const f = fixture();
    f.evaluate.mockResolvedValue({ toolName: "shell.exec", allowed: true, requiresApproval: true, reasonCodes: [], riskLevel: "danger", wardEffect });
    await expect(f.owner.authorize(f.input)).resolves.toBeUndefined();
    expect(f.resolveActiveChatExecution).toHaveBeenCalledTimes(2);
  });
  it.each(["echo harmless", "\"C:\\other.exe\" serve", "unquoted.exe"])("refuses a policy command that does not name the execution image: %s", async commandLine => {
    const f = fixture(); f.input.launch.commandLine = commandLine;
    await expect(f.owner.authorize(f.input)).rejects.toThrow("exact quoted executable");
    expect(f.evaluate).not.toHaveBeenCalled();
    expect(f.resolveActiveChatExecution).not.toHaveBeenCalled();
  });
  it("evaluates the exact remote command and scoped frozen profile without executing anything", async () => {
    const f = fixture(); await f.owner.authorize(f.input);
    expect(f.evaluate).toHaveBeenCalledWith(expect.objectContaining({ toolName: "shell.exec", agentId: "assistant", sessionId: "session", workspaceId: "execution",
      citadelId: "citadel", taskId: "task", runId: "run", policyContext: f.binding.policy, args: { command: f.input.launch.commandLine, cwd: f.input.launch.directory } }));
    expect(f.resolveActiveChatExecution).toHaveBeenCalledTimes(2); expect(resolveRemoteWorkerChatProfile).toHaveBeenCalledTimes(2);
  });
  it.each(["assignment", "compute", "governed", "missing-tool", "plugin", "classification", "cancel"])("refuses %s before evaluating command policy", async mode => {
    const f = fixture();
    if (mode === "assignment") f.resolveActiveChatExecution.mockRejectedValue(new Error("revoked"));
    if (mode === "compute") f.manifest.requiredCapabilityClasses = ["governed_tool"];
    if (mode === "governed") f.manifest.requiredCapabilityClasses = ["durable_compute"];
    if (mode === "missing-tool") f.binding.profile.selection.tools = [];
    if (mode === "plugin") f.binding.profile.selection.tools[0]!.runtimeOwner.kind = "plugin";
    if (mode === "classification") delete (f.binding.profile.selection.tools[0]! as Partial<typeof f.binding.profile.selection.tools[0]>).effectPotential;
    if (mode === "cancel") f.stop.abort();
    await expect(f.owner.authorize(f.input)).rejects.toThrow(); expect(f.evaluate).not.toHaveBeenCalled();
  });
  it.each(["denied", "tool", "profile-drift", "policy-drift", "manifest-drift", "revoked", "cancel"])("refuses %s during the policy boundary", async mode => {
    const f = fixture();
    f.evaluate.mockImplementation(async () => {
      if (mode === "profile-drift") f.binding.profile.identity.sessionId = "foreign";
      if (mode === "policy-drift") f.binding.policy.authActorId = "foreign";
      if (mode === "manifest-drift") f.manifest.taskId = "foreign";
      if (mode === "revoked") f.resolveActiveChatExecution.mockRejectedValue(new Error("revoked"));
      if (mode === "cancel") f.stop.abort();
      return { toolName: mode === "tool" ? "fs.read" : "shell.exec", allowed: mode !== "denied", requiresApproval: true, reasonCodes: [], riskLevel: "danger" };
    });
    await expect(f.owner.authorize(f.input)).rejects.toThrow(); expect(f.evaluate).toHaveBeenCalledOnce();
  });
});
