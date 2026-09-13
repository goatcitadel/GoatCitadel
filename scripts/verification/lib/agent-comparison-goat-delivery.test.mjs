import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdtemp, mkdir, readFile, writeFile, access } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { it } from "node:test";
import { observeGoatComparisonDelivery } from "./agent-comparison-goat-delivery.mjs";
import { COMPARISON_TASKS, sha256 } from "./agent-comparison.mjs";
import { PERMISSION_REVIEW_FILE, PERMISSION_REVIEW_VERSION } from "./agent-comparison-permissions.mjs";
import { verifyComparisonEvidence } from "./agent-comparison-verifiers.mjs";

async function fixture(t, fault) {
  const cellDirectory = await mkdtemp(path.join(os.tmpdir(), "Goat Delivery Observer "));
  const evidence = path.join(cellDirectory, "evidence"),
    workspace = path.join(cellDirectory, "workspace");
  await mkdir(evidence);
  await mkdir(workspace);
  const binding = {
    executionId: "controlled-execution",
    manifestSha256: sha256("controlled manifest"),
    cellId: "goatcitadel:scheduled_delivery:1",
    revision: "controlled-working-build",
    effectiveConfigSha256: sha256("controlled config"),
    fixtureSha256: sha256(COMPARISON_TASKS.find((task) => task.id === "scheduled_delivery")),
  };
  const save = (name, value) => writeFile(path.join(evidence, name), JSON.stringify(value), { flag: "wx" });
  await save("session-start.json", {
    ...binding,
    product: "goatcitadel",
    taskId: "scheduled_delivery",
    source: "controlled_fixture",
  });
  const launch = {
    fixtureOnly: true,
    note: "Controlled HTTP records exercise the observer, not a real native schedule or provider.",
  };
  await save("native-launch.json", launch);
  await save(PERMISSION_REVIEW_FILE, {
    schemaVersion: PERMISSION_REVIEW_VERSION,
    ...binding,
    policy: { files: "disabled", terminal: "disabled", skills: "disabled", schedule: "authorized_destination" },
    reviewedBy: "controlled unit fixture",
    reviewedAt: new Date().toISOString(),
    sourceReceipts: [{ path: "native-launch.json", sha256: sha256(JSON.stringify(launch)) }],
  });
  const due = Date.now() + 1500;
  const authorization = {
    channelKey: "telegram",
    connectionId: "11111111-1111-4111-8111-111111111111",
    target: "-123456",
    scheduledFor: new Date(due).toISOString(),
  };
  const job = {
    jobId: "reminder",
    revision: 1,
    action: "agent_turn",
    enabled: true,
    actionConfig: {
      agentTurn: {
        prompt: "HARBOR PILOT CHECK",
        deliveryChannel: { channelKey: "telegram", target: authorization.target },
      },
    },
    schedule: "0 12 * * * UTC",
    nextRunAt: authorization.scheduledFor,
    endAt: new Date(due + 60000).toISOString(),
  };
  const occurrence = {
    runId: "cron-1",
    jobId: job.jobId,
    trigger: "scheduled_due",
    scheduledFor: authorization.scheduledFor,
    jobRevision: 1,
    executionGeneration: 1,
    status: "completed",
    phase: "settlement",
    childSessionId: "cron-session",
    childTurnId: "cron-turn",
    childDurableRunId: "chat-1",
    deliveryRunId: "autonomous-delivery:chat-1",
  };
  const child = {
    runId: "chat-1",
    workflowKey: "chat.turn.execute",
    status: "completed",
    payload: { sessionId: "cron-session", turnId: "cron-turn" },
    metadata: { cronRunId: "cron-1", cronJobId: job.jobId, cronExecutionGeneration: 1 },
  };
  const transport = {
    runId: "autonomous-delivery:chat-1",
    workflowKey: "connector.delivery",
    status: "completed",
    metadata: { deliveryKind: "autonomous.assistant_message", sourceRunId: child.runId },
    payload: {
      runId: child.runId,
      sessionId: "cron-session",
      connectorId: `integration:${authorization.connectionId}`,
      action: "channel.send",
      payload: { target: authorization.target, message: "HARBOR PILOT CHECK" },
    },
  };
  const result = { status: "queued", deliveryId: "send-1", channelKey: "telegram", target: authorization.target };
  const checkpoints = {
    items: [
      {
        runId: transport.runId,
        checkpointId: "checkpoint-1",
        checkpointKind: "run_completed",
        state: { connectorId: transport.payload.connectorId, action: "channel.send", result },
      },
    ],
  };
  const delivered = {
    ...result,
    status: "sent",
    deliveryStatus: "sent",
    providerMessageId: "provider-1",
    connectionId: authorization.connectionId,
    channelKey: "telegram",
    target: authorization.target,
    attempts: 1,
    updatedAt: authorization.scheduledFor,
  };
  const state = { reconnected: false, fault, requests: [] };
  const server = createServer((request, response) => {
    state.requests.push({ method: request.method, path: request.url });
    if (request.method !== "GET") {
      response.writeHead(405).end();
      return;
    }
    const ready = Date.now() >= due;
    let body;
    if (request.url === "/api/v1/cron/jobs/reminder")
      body = { ...job, ...(ready ? { lastRunId: occurrence.runId } : {}) };
    else if (request.url === "/api/v1/comms/deliveries?limit=200") {
      const rows = ready ? [structuredClone(delivered)] : [];
      if (state.reconnected && state.fault === "duplicate")
        rows.push({ ...delivered, deliveryId: "duplicate", providerMessageId: "duplicate" });
      if (state.fault === "truncated")
        rows.push(...Array.from({ length: 200 }, (_, index) => ({ deliveryId: `extra-${index}` })));
      body = { count: rows.length, deliveries: rows };
    } else if (request.url === "/api/v1/cron/runs/cron-1")
      body = { runId: occurrence.runId, jobId: job.jobId, status: "ok", canonical: occurrence };
    else if (request.url === "/api/v1/durable/runs/chat-1") body = child;
    else if (request.url === "/api/v1/durable/runs/autonomous-delivery%3Achat-1") body = transport;
    else if (request.url === "/api/v1/durable/runs/autonomous-delivery%3Achat-1/checkpoints?limit=200")
      body = checkpoints;
    else {
      response.writeHead(404).end();
      return;
    }
    body = structuredClone(body);
    if (state.fault === "manual" && body.canonical) body.canonical.trigger = "manual";
    if (state.fault === "legacy" && body.canonical) delete body.canonical;
    if (state.fault === "child" && body.runId === child.runId) body.metadata.cronRunId = "another-cron";
    if (state.fault === "message" && body.workflowKey === "connector.delivery")
      body.payload.payload.message = "different message";
    if (state.fault === "unacknowledged" && body.deliveries?.[0]) delete body.deliveries[0].providerMessageId;
    if (state.fault === "queued" && body.deliveries?.[0]) body.deliveries[0].status = "queued";
    if (state.fault === "receipt-target" && body.items) body.items[0].state.result.target = "-654321";
    if (state.fault === "conflicting-ack" && body.items)
      body.items[0].state.result.providerMessageId = "another-provider-message";
    response.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify(body));
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(
    () =>
      new Promise((resolve) => {
        server.closeAllConnections();
        server.close(resolve);
      }),
  );
  const options = {
    cellDirectory,
    baseUrl: `http://127.0.0.1:${server.address().port}/`,
    token: "a".repeat(48),
    scheduleId: job.jobId,
    authorization,
    pollMs: 100,
    maxTaskMs: 60000,
    onReconnect: async () => {
      state.reconnected = true;
      return {
        kind: "owned_runtime_restart",
        detail: "Controlled HTTP state transition only; no real process restart.",
      };
    },
  };
  return { options, evidence, workspace, state };
}

it(
  "retains complete native-shaped provenance and observes thirty real seconds without mutations",
  { timeout: 60000 },
  async (t) => {
    const f = await fixture(t);
    const began = performance.now();
    const result = await observeGoatComparisonDelivery({ ...f.options, pollMs: 1000 });
    assert.ok(performance.now() - began >= 30000);
    assert.equal(result.taskOutcome, "unverified");
    assert.equal(result.providerMessageId, "provider-1");
    assert.ok(f.state.requests.every((request) => request.method === "GET"));
    assert.ok(f.state.requests.some((request) => request.path.includes("autonomous-delivery%3Achat-1")));
    const verified = await verifyComparisonEvidence({
      taskId: "scheduled_delivery",
      workspaceRoot: f.workspace,
      evidenceRoot: f.evidence,
    });
    assert.equal(verified.outcome, "passed");
    assert.equal(verified.evidenceKind, "controlled");
    assert.equal(Object.keys(verified.checks).length, 4);
    const execution = JSON.parse(await readFile(path.join(f.evidence, "execution.json"), "utf8"));
    assert.equal(execution.nativeReceipts.length, 4);
    assert.equal(execution.delivery.reconnectKind, "owned_runtime_restart");
    t.diagnostic(`Retained controlled observer evidence: ${f.evidence}`);
  },
);

for (const [fault, pattern] of [
  ["manual", /manual/u],
  ["legacy", /missing/u],
  ["child", /Chat child/u],
  ["message", /exact parent/u],
  ["unacknowledged", /acknowledged/u],
  ["queued", /acknowledged/u],
  ["receipt-target", /admission receipt/u],
  ["conflicting-ack", /acknowledged/u],
  ["truncated", /inventory/u],
  ["duplicate", /duplicated/u],
])
  it(`refuses ${fault} delivery evidence without certifying completion`, async (t) => {
    const f = await fixture(t, fault);
    await assert.rejects(observeGoatComparisonDelivery(f.options), pattern);
    await assert.rejects(access(path.join(f.evidence, "execution.json")));
    await assert.rejects(access(path.join(f.evidence, "native-goat-delivery-observer.lock")));
  });

it("cancels even while a reconnect callback is pending", async (t) => {
  const f = await fixture(t);
  const controller = new AbortController();
  const pending = observeGoatComparisonDelivery({
    ...f.options,
    signal: controller.signal,
    onReconnect: async () => {
      controller.abort(new Error("cancel during reconnect"));
      return new Promise(() => {});
    },
  });
  await assert.rejects(pending, /cancel during reconnect/u);
  await assert.rejects(access(path.join(f.evidence, "execution.json")));
  await assert.rejects(access(path.join(f.evidence, "native-goat-delivery-observer.lock")));
});
