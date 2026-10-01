import assert from "node:assert/strict";
import { test } from "node:test";
import { assertMcpPolicyAgreement, assertMcpResponseAgreement, reviewedMcpFixturePolicy, enableMcpDiagnosticsFixture } from "./cockpit-mcp-policy-requests-proof.mjs";
const policy = () => {
  const before = { serverId: "server", revision: "a".repeat(64), label: "Fixture", command: "node", enabled: false, category: "development",
    transport: "stdio", authType: "none", trustTier: "restricted", costTier: "unknown", createdAt: "2026-09-30T00:00:00Z" };
  const request = { expectedRevision: before.revision, label: before.label, command: before.command, enabled: false, category: before.category,
    args: ["--mode", "read only"], policy: structuredClone(reviewedMcpFixturePolicy) };
  const { expectedRevision: _, ...fields } = request;
  const receipt = { ...before, ...fields, revision: "b".repeat(64), status: "disconnected" };
  return { before, request, receipt, owner: structuredClone(receipt) };
};
const response = (action = "accept") => {
  const before = { elicitationId: "request", method: "elicitation/create", prompt: { text: "Seeded fixture" }, requestedSchema: { value: { type: "object" } },
    protocol: { method: "elicitation/create" }, owner: { workspaceId: "default", surface: "mcp" }, source: { sourceType: "ui" }, policy: { sensitiveInformationAllowed: false }, createdAt: "2026-09-30T00:00:00Z" };
  const content = action === "accept" ? { name: "Visible", count: 2, enabled: false } : undefined;
  const status = action === "accept" ? "accepted" : action === "decline" ? "declined" : "cancelled";
  const receipt = { ...structuredClone(before), status, response: { action, owner: before.owner, respondedAt: "2026-09-30T00:00:01Z",
    evidence: { status, previousStatus: "pending", auditEventId: "audit" }, ...(content ? { content: { value: content, truncated: false, redactedSecretCount: 0 } } : {}) } };
  return { before, request: { action, ...(content ? { content } : {}), owner: before.owner }, receipt, owner: structuredClone(receipt), action, content };
};
test("requires exact args, every reviewed policy field, revision and disabled canonical readback", () => {
  assertMcpPolicyAgreement(policy());
  for (const patch of [{ args: ["--mode", "read", "only"] }, { policy: { ...reviewedMcpFixturePolicy, allowedEnvKeys: [] } }, { enabled: true }, { expectedRevision: "stale" }]) {
    const fixture = policy(); Object.assign(fixture.request, patch); assert.throws(() => assertMcpPolicyAgreement(fixture));
  }
  for (const patch of [{ status: "connected" }, { serverId: "foreign" }, { trustTier: "trusted" }, { revision: "a".repeat(64) }]) {
    const fixture = policy(); Object.assign(fixture.receipt, patch); fixture.owner = structuredClone(fixture.receipt); assert.throws(() => assertMcpPolicyAgreement(fixture));
  }
});
test("binds accepted, declined and cancelled responses to exact seeded owner and terminal readback", () => {
  for (const action of ["accept", "decline", "cancel"]) assertMcpResponseAgreement(response(action));
  for (const change of [value => { value.receipt.owner.workspaceId = "foreign"; }, value => { value.receipt.requestedSchema.value.type = "array"; },
    value => { value.receipt.response.content.value.count = "2"; }, value => { value.receipt.response.content.truncated = true; },
    value => { value.receipt.response.content.redactedSecretCount = 1; }, value => { value.receipt.response.evidence.previousStatus = "accepted"; },
    value => { value.receipt.response.evidence.auditEventId = ""; }, value => { value.owner.status = "pending"; }]) {
    const fixture = response(); change(fixture); assert.throws(() => assertMcpResponseAgreement(fixture));
  }
  const declined = response("decline"); declined.request.content = { unexpected: true }; assert.throws(() => assertMcpResponseAgreement(declined));
});
test("enables only diagnostics through exact approval and explicit continuation before owner readback", async () => {
  const writes = [];
  const plan = { planId: "plan", revision: 2, status: "awaiting_approval", origin: { workspaceId: "default" },
    request: { kind: "runtime_configuration", change: { operation: "feature_flag", flag: "connectorDiagnosticsV1Enabled", enabled: true } },
    requiredAction: { kind: "approval", approvalId: "approval", actionId: "action", actionNonce: "nonce" } };
  let enabled = false;
  const api = async (route, input) => {
    if (input) writes.push({ route, ...input });
    if (route === "/api/v1/settings") return input ? { changePlanReceipt: plan } : { revision: enabled ? 3 : 1, features: { connectorDiagnosticsV1Enabled: enabled } };
    if (route === "/api/v1/change-plans/plan?workspaceId=default") return structuredClone(plan);
    if (route === "/api/v1/change-plans/plan/responses") enabled = true;
    return {};
  };
  await enableMcpDiagnosticsFixture(api, async () => {});
  assert.deepEqual(writes.map(item => item.route), ["/api/v1/settings", "/api/v1/approvals/approval/resolve", "/api/v1/change-plans/plan/responses"]);
  assert.deepEqual(writes[0].body, { expectedRevision: 1, features: { connectorDiagnosticsV1Enabled: true } });
  assert.deepEqual(writes[2].body, { workspaceId: "default", expectedRevision: 2, actionId: "action", actionNonce: "nonce", values: {} });
  for (const mismatch of [{ origin: { workspaceId: "foreign" } }, { request: { kind: "runtime_configuration", change: { operation: "feature_flag", flag: "other", enabled: true } } }]) {
    enabled = false; writes.length = 0;
    await assert.rejects(enableMcpDiagnosticsFixture(async (route, input) => route.includes("?workspaceId") ? { ...plan, ...mismatch } : api(route, input), async () => {}));
    assert.equal(writes.length, 1, "Foreign intent must never be approved by fixture setup");
  }
});
