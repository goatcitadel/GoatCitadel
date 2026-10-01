import assert from "node:assert/strict";
import { it } from "node:test";
import { assertNotificationFixtureChannel, assertNotificationFixtureGrant, assertNotificationRoutingSaved, assertNotificationDeliveryObserved, notificationFailureProjection } from "./cockpit-notification-routing-proof.mjs";
it("binds notification receipt to workspace, exact configuration, CAS and archived owner readback", () => {
  const previous = { targetId: "target", workspaceId: "default", label: "Fixture", revision: 2, lifecycleState: "disabled" };
  const saved = { ...previous, revision: 3, lifecycleState: "archived" };
  const input = { kind: "target", previous, receipt: saved, canonical: saved, submitted: { workspaceId: "default", expectedRevision: 2, target: { label: "Fixture", lifecycleState: "archived" } } };
  assert.doesNotThrow(() => assertNotificationRoutingSaved(input));
  for (const canonical of [previous, { ...saved, workspaceId: "foreign" }, { ...saved, targetId: "other" }]) assert.throws(() => assertNotificationRoutingSaved({ ...input, canonical }));
  assert.throws(() => assertNotificationRoutingSaved({ ...input, submitted: { ...input.submitted, expectedRevision: 1 } }));
  assert.throws(() => assertNotificationRoutingSaved({ ...input, submitted: { ...input.submitted, target: { label: "Other", lifecycleState: "archived" } } }));
});
it("admits only one explicit fixture-workspace send to loopback", () => {
  const grant = { grantId: "grant", createdBy: "operator", toolPattern: "channel.send", decision: "allow", scope: "workspace", scopeRef: "fixture",
    grantType: "one_time", usesRemaining: 1, constraints: { allowedHosts: ["127.0.0.1"], mutationAllowed: true } };
  assert.doesNotThrow(() => assertNotificationFixtureGrant(grant, "fixture"));
  for (const patch of [{ scope: "global" }, { scopeRef: "default" }, { toolPattern: "*" }, { grantType: "persistent" }, { usesRemaining: 0 },
    { constraints: { allowedHosts: ["*"], mutationAllowed: true } }, { revokedAt: "2026-09-30T00:00:00Z" }])
    assert.throws(() => assertNotificationFixtureGrant({ ...grant, ...patch }, "fixture"));
});
it("requires the exact saved loopback channel while keeping unprobed runtime readiness truthful", () => {
  const created = { connectionId: "connection", catalogId: "channel.ntfy", kind: "channel", key: "ntfy", enabled: true,
    status: "connected", workspaceId: "fixture", config: { baseUrl: "http://127.0.0.1:1234", topic: "opaque-topic" } };
  const data = { created, canonical: structuredClone(created), workspaceId: "fixture", ...created.config,
    runtime: { connectionId: "connection", channelKey: "ntfy", enabled: true, ready: false,
      metadata: { setupReady: true, connectionStatus: "connected" } } };
  assertNotificationFixtureChannel(data);
  for (const mutate of [
    value => { value.canonical.workspaceId = "foreign"; },
    value => { value.canonical.config.dryRun = true; },
    value => { value.canonical.status = value.created.status = "paused"; },
    value => { value.canonical.enabled = value.created.enabled = false; },
    value => { value.runtime.connectionId = "foreign"; },
    value => { value.runtime.metadata.setupReady = false; },
  ]) { const value = structuredClone(data); mutate(value); assert.throws(() => assertNotificationFixtureChannel(value)); }
});

function deliveryFixture() {
  const initial = { deliveryId: "delivery", eventId: "event", targetId: "target", workspaceId: "fixture",
    ruleId: "operator_test", idempotencyKey: "notification:event:operator_test:target", status: "pending", attemptCount: 1,
    createdAt: "2026-09-30T00:00:00.000Z", updatedAt: "2026-09-30T00:00:00.000Z" };
  const result = { event: { eventId: "event", workspaceId: "fixture", source: "operator_test", eventType: "durable.attention_required" },
    status: "pending", deliveries: [initial] };
  return { result, workspaceId: "fixture", targetId: "target", canonical: { ...initial, status: "delivered", updatedAt: "2026-09-30T00:00:01.000Z" } };
}
it("accepts pending only as an observation and requires canonical delivered for final proof", () => {
  const data = deliveryFixture();
  assert.equal(assertNotificationDeliveryObserved({ ...data, canonical: data.result.deliveries[0] }), false);
  assert.throws(() => assertNotificationDeliveryObserved({ ...data, canonical: data.result.deliveries[0], requireDelivered: true }));
  assert.equal(assertNotificationDeliveryObserved({ ...data, requireDelivered: true }), true);
  assert.throws(() => assertNotificationDeliveryObserved({ ...data, previous: data.canonical, canonical: data.result.deliveries[0] }));
});
it("rejects foreign delivery/event/key, regressing evidence and unexpected terminal states", () => {
  for (const change of [
    data => { data.canonical.deliveryId = "foreign"; },
    data => { data.canonical.eventId = "foreign"; },
    data => { data.canonical.targetId = "foreign"; },
    data => { data.canonical.workspaceId = "foreign"; },
    data => { data.canonical.idempotencyKey = "foreign"; },
    data => { data.result.deliveries[0].idempotencyKey = data.canonical.idempotencyKey = "wrong-but-matching"; },
    data => { data.canonical.attemptCount = 0; },
    data => { data.canonical.updatedAt = "2026-09-29T00:00:00.000Z"; },
    data => { data.canonical.status = "unknown_after_send"; },
    data => { data.canonical.status = "failed"; },
    data => { data.canonical.status = "suppressed_present"; },
  ]) { const data = deliveryFixture(); change(data); assert.throws(() => assertNotificationDeliveryObserved(data)); }
});
it("failure diagnostics retain statuses and identifiers without messages, errors, payloads or secret references", () => {
  const marker = "SECRET_OR_MESSAGE_MUST_NOT_APPEAR";
  const output = notificationFailureProjection({
    delivery: { ...deliveryFixture().canonical, lastError: marker },
    queue: { deliveries: [{ deliveryId: "queued", connectionId: "connection", status: "queued", deliveryStatus: "waiting_approval",
      attempts: 1, maxAttempts: 3, target: marker, payload: marker, error: marker, staleReason: marker, fallbackReason: marker }] },
    runtime: { connectionId: "connection", ready: false, lastError: marker, metadata: { credential: marker }, runtimePolicy: { pairing: true, secret: marker } },
    approvals: { items: [{ approvalId: "approval", status: "pending", payload: marker, rationale: marker }] },
    grant: { grantId: "grant", usesRemaining: 1, constraints: { token: marker } },
  });
  assert.equal(output.queue[0].deliveryStatus, "waiting_approval");
  assert.equal(output.approvals[0].approvalId, "approval"); assert.equal(output.grant.usesRemaining, 1);
  assert.equal(output.delivery.hasError, true); assert.ok(!JSON.stringify(output).includes(marker));
  const rejected = notificationFailureProjection({ queue: { deliveries: [{ error: `blocked: grant host constraints blocked this action ${marker}` }] } });
  assert.equal(rejected.queue[0].policyReasonCode, "grant_host_constraints_block");
  assert.ok(!JSON.stringify(rejected).includes(marker));
});
