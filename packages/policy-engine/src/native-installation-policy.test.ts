import { describe, expect, it, vi } from "vitest";
import { HEARTBEAT_RESTRICTED_PROFILE, type ToolPolicyConfig, type ToolAccessEvaluateRequest } from "@goatcitadel/contracts";
import { ToolPolicyEngine } from "./engine.js";

const installation = { schemaVersion: "goatcitadel.worker-runtime-install.v1", nonce: "1".repeat(64), journalIdentityHex: "2".repeat(48),
  preparedSha256: "3".repeat(64), checkpointSha256: "4".repeat(64), packageSha256: "5".repeat(64),
  runtimeBundle: { schemaVersion: "goatcitadel.worker-runtime-bundle.v1", files: [
    { relativePath: "node.exe", bytes: 5, sha256: "6".repeat(64) }, { relativePath: "worker-host-receipt.json", bytes: 7, sha256: "7".repeat(64) }] } };
function fixture() {
  const config: ToolPolicyConfig = { tools: { allow: ["*"], deny: [], approvalMode: "bypass" }, agents: {},
    sandbox: { writeJailRoots: [], readOnlyRoots: [], networkAllowlist: [], riskyShellPatterns: [], requireApprovalForRiskyShell: true } };
  const storage = { approvals: { create: vi.fn(), get: vi.fn() }, audit: { append: vi.fn() },
    toolGrants: { listActive: vi.fn(async () => [] as unknown[]), consumeOne: vi.fn() },
    toolAccessDecisions: { record: vi.fn(), countToolCallsInLastHourInScope: vi.fn(async () => 0), countWritesInLastHourInScope: vi.fn(async () => 0) },
    citadels: { listWards: vi.fn(async () => [] as unknown[]) } };
  const request: ToolAccessEvaluateRequest = { toolName: "remote_worker.native_runtime_install", agentId: "assistant", surface: "chat",
    workspaceId: "workspace", sessionId: "session", runId: "run", args: { installation: structuredClone(installation) } };
  return { config, storage, request, engine: new ToolPolicyEngine(config, storage as never) };
}
describe("native installation policy inspection", () => {
  it("requires approval even with bypass policy and performs no mutations", async () => {
    const f = fixture(); expect(await f.engine.inspectNativeInstallation(f.request)).toMatchObject({ allowed: true, requiresApproval: true });
    expect(f.storage.toolGrants.consumeOne).not.toHaveBeenCalled(); expect(f.storage.toolAccessDecisions.record).not.toHaveBeenCalled();
    expect(f.storage.approvals.create).not.toHaveBeenCalled(); expect(f.storage.audit.append).not.toHaveBeenCalled();
  });
  it("does not make installation available through ordinary tool inspection", async () => {
    const f = fixture(); expect(await f.engine.inspectAccess(f.request)).toMatchObject({ allowed: false, reasonCodes: ["unknown_tool"] });
  });
  it("honors wildcard deny before broad allow", async () => {
    const f = fixture(); f.config.tools.deny = ["remote_worker.*"];
    expect(await f.engine.inspectNativeInstallation(f.request)).toMatchObject({ allowed: false, reasonCodes: ["policy_deny"] });
  });
  it("honors the restricted permission ceiling", async () => {
    const f = fixture(); f.request.policyContext = { permissionProfile: HEARTBEAT_RESTRICTED_PROFILE };
    expect((await f.engine.inspectNativeInstallation(f.request)).allowed).toBe(false);
  });
  it("does not use an ordinary allow grant for installation", async () => {
    const f = fixture(); f.storage.toolGrants.listActive.mockResolvedValue([{ grantId: "grant", toolPattern: f.request.toolName,
      decision: "allow", scope: "session", scopeRef: "session", grantType: "persistent", createdBy: "operator", createdAt: new Date().toISOString() }]);
    expect(await f.engine.inspectNativeInstallation(f.request)).toMatchObject({ allowed: true, matchedGrantId: undefined, requiresApproval: true });
    f.config.tools.allow = []; f.config.tools.profile = "minimal"; f.config.profiles = { minimal: [] };
    expect(await f.engine.inspectNativeInstallation(f.request)).toMatchObject({ allowed: false, reasonCodes: ["policy_disallow"] });
    expect(f.storage.toolGrants.consumeOne).not.toHaveBeenCalled();
  });
  it("preserves scoped deny grants", async () => {
    const f = fixture(); f.storage.toolGrants.listActive.mockResolvedValue([{ grantId: "deny", toolPattern: "remote_worker.*",
      decision: "deny", scope: "session", scopeRef: "session", grantType: "persistent", createdBy: "operator" }]);
    expect(await f.engine.inspectNativeInstallation(f.request)).toMatchObject({ allowed: false, reasonCodes: ["grant_deny"] });
  });
  it.each(["deny", "require_approval", "require_dry_run", "route_local", "redact"])("preserves Citadel Ward %s", async effect => {
    const f = fixture(); f.request.citadelId = "citadel";
    f.storage.citadels.listWards.mockResolvedValue([{ wardId: "ward", citadelId: "citadel", name: "installation",
      actionPattern: "remote_worker.*", effect, createdAt: "2026-09-17T00:00:00Z" }]);
    expect(await f.engine.inspectNativeInstallation(f.request)).toMatchObject({ allowed: effect !== "deny", requiresApproval: true, wardEffect: effect });
  });
  it.each(["shell.exec", "fs.write"])("refuses template substitution with %s", async toolName => {
    const f = fixture(); await expect(f.engine.inspectNativeInstallation({ ...f.request, toolName })).rejects.toThrow();
  });
  it("rejects extra arguments and malformed package bindings", async () => {
    const f = fixture(); await expect(f.engine.inspectNativeInstallation({ ...f.request, args: { installation, command: "ignored" } })).rejects.toThrow();
    await expect(f.engine.inspectNativeInstallation({ ...f.request, args: { installation: { ...installation, packageSha256: "0".repeat(64) } } })).rejects.toThrow();
  });
});
