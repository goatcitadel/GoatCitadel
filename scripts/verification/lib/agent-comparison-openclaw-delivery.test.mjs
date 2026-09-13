import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, writeFile, access } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { it } from "node:test";
import {
  observeOpenclawComparisonDelivery,
  projectOpenclawComparisonDelivery,
  readOpenclawComparisonDeliveryQueue,
} from "./agent-comparison-openclaw-delivery.mjs";
import { NATIVE_COMPARISON_PINS } from "./agent-comparison-native-profile.mjs";
import { COMPARISON_TASKS, sha256 } from "./agent-comparison.mjs";
import { PERMISSION_REVIEW_FILE, PERMISSION_REVIEW_VERSION } from "./agent-comparison-permissions.mjs";
import { verifyComparisonEvidence } from "./agent-comparison-verifiers.mjs";

function completion() {
  const due = Date.now() - 2000,
    runAt = due + 50,
    ack = runAt + 100;
  const authorization = { accountId: "default", target: "-123456", scheduledFor: new Date(due).toISOString() };
  const run = {
    jobId: "reminder",
    sessionId: "native-session",
    sessionKey: "agent:main:cron:reminder",
    action: "finished",
    status: "ok",
    completionStatus: "succeeded",
    delivered: true,
    deliveryStatus: "delivered",
    provider: "comparison",
    model: "fixture-model",
    runAtMs: runAt,
    delivery: {
      intended: { channel: "telegram", to: authorization.target, accountId: "default" },
      resolved: { channel: "telegram", to: authorization.target, accountId: "default", ok: true },
      delivered: true,
      fallbackUsed: true,
    },
  };
  const job = {
    id: "reminder",
    name: "comparison reminder",
    createdAtMs: due - 1000,
    enabled: false,
    schedule: { kind: "at", at: authorization.scheduledFor },
    deleteAfterRun: false,
    sessionTarget: "isolated",
    wakeMode: "now",
    payload: {
      kind: "agentTurn",
      message: "HARBOR PILOT CHECK",
      model: "comparison/fixture-model",
      thinking: "off",
      toolsAllow: [],
    },
    delivery: {
      mode: "announce",
      channel: "telegram",
      accountId: "default",
      to: authorization.target,
      bestEffort: false,
    },
    state: { lastRunAtMs: runAt, lastRunStatus: "ok", lastDelivered: true, lastDeliveryStatus: "delivered" },
  };
  const deliveryId = `cron-direct-delivery:v1:cron:reminder:${runAt + 20}:telegram:default:telegram%3A-123456:`;
  const entry = { id: deliveryId, retryCount: 0, acknowledgedAt: ack + 10, recoveryState: "completed_bounded" };
  return {
    authorization,
    model: "fixture-model",
    job,
    runs: { entries: [run], total: 1, hasMore: false },
    queue: [
      {
        queue_name: "outbound-prepared-v1",
        id: deliveryId,
        status: "completed",
        retry_count: 0,
        updated_at: ack + 10,
        entry_json: JSON.stringify(entry),
      },
    ],
    receipts: [
      {
        fixtureOnly: true,
        providerMessageId: "8300",
        accountId: "default",
        destination: "telegram:-123456",
        message: "HARBOR PILOT CHECK",
        nativeDispatch: {
          tasks: [
            {
              task_id: "task-1",
              run_id: `cron:reminder:${runAt}:receipt-1`,
              source_id: "reminder",
              runtime: "cron",
              child_session_key: run.sessionKey,
              started_at: runAt,
              status: "running",
            },
          ],
          receipts: [
            {
              job_id: "reminder",
              receipt_id: "receipt-1",
              request_run_id: null,
              started_at_ms: runAt,
              finished_at_ms: null,
              status: "running",
            },
          ],
          queue: [
            {
              queue_name: "outbound-prepared-v1",
              id: deliveryId,
              status: "pending",
              retry_count: 0,
              entry_json: JSON.stringify({
                id: deliveryId,
                retryCount: 0,
                attemptCount: 0,
                channel: "telegram",
                to: authorization.target,
                accountId: authorization.accountId,
                queuePolicy: "required",
                requiresProducerClaim: true,
                recoveryState: "send_attempt_started",
                platformSendAttemptId: "platform-attempt-1",
                platformSendStartedAt: runAt + 30,
                availableAt: ack + 60000,
                preparedBatch: { entries: [{ status: "accepted", payload: { text: "HARBOR PILOT CHECK" } }] },
              }),
            },
          ],
        },
        acknowledgedAt: new Date(ack).toISOString(),
      },
    ],
  };
}

it("binds a native cron run to its exact queue identity and independent wire acknowledgement", () => {
  const value = completion();
  const projected = projectOpenclawComparisonDelivery(value);
  assert.equal(projected.deliveryId, value.queue[0].id);
  assert.equal(projected.receipt.providerMessageId, "8300");
});

for (const [name, mutate, pattern] of [
  [
    "truncated history",
    (f) => {
      f.runs.hasMore = true;
    },
    /complete native cron/u,
  ],
  [
    "unacknowledged run",
    (f) => {
      f.runs.entries[0].delivered = false;
    },
    /successful execution/u,
  ],
  [
    "fallback provider",
    (f) => {
      f.runs.entries[0].provider = "other";
    },
    /successful execution/u,
  ],
  [
    "wrong account",
    (f) => {
      f.runs.entries[0].delivery.resolved.accountId = "other";
    },
    /target changed/u,
  ],
  [
    "competing tool send",
    (f) => {
      f.runs.entries[0].delivery.messageToolSentTo = [{}];
    },
    /competing send/u,
  ],
  [
    "second occurrence",
    (f) => {
      f.job.state.nextRunAtMs = Date.now() + 1000;
    },
    /one-shot schedule/u,
  ],
  [
    "pending queue",
    (f) => {
      f.queue[0].status = "pending";
    },
    /delivery queue/u,
  ],
  [
    "other occurrence receipt",
    (f) => {
      f.queue[0].id += "other";
    },
    /delivery queue/u,
  ],
  [
    "retry",
    (f) => {
      f.queue[0].retry_count = 1;
    },
    /delivery queue/u,
  ],
  [
    "duplicate receipt",
    (f) => {
      f.receipts.push({ ...f.receipts[0], providerMessageId: "8301" });
    },
    /exactly one independently/u,
  ],
  [
    "wrong recipient",
    (f) => {
      f.receipts[0].destination = "telegram:-654321";
    },
    /acknowledgement/u,
  ],
  [
    "unproven live receipt",
    (f) => {
      f.receipts[0].fixtureOnly = false;
    },
    /acknowledgement/u,
  ],
  [
    "missing dispatch custody",
    (f) => {
      delete f.receipts[0].nativeDispatch;
    },
    /dispatch owners/u,
  ],
  [
    "foreign active occurrence",
    (f) => {
      f.receipts[0].nativeDispatch.tasks[0].child_session_key = "other-session";
    },
    /active scheduled occurrence/u,
  ],
  [
    "manual run",
    (f) => {
      f.receipts[0].nativeDispatch.receipts[0].request_run_id = "manual-1";
    },
    /active scheduled occurrence/u,
  ],
])
  it(`refuses ${name}`, () => {
    const value = completion();
    mutate(value);
    assert.throws(() => projectOpenclawComparisonDelivery(value), pattern);
  });

it("reads the existing SQLite queue without running product migrations or altering rows", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "OpenClaw Delivery Queue "));
  await mkdir(path.join(root, "state"));
  const filename = path.join(root, "state", "openclaw.sqlite"),
    database = new DatabaseSync(filename);
  database.exec(
    "CREATE TABLE delivery_queue_entries (queue_name TEXT, id TEXT, status TEXT, retry_count INTEGER, updated_at INTEGER, entry_json TEXT)",
  );
  const row = completion().queue[0];
  database
    .prepare("INSERT INTO delivery_queue_entries VALUES (?, ?, ?, ?, ?, ?)")
    .run(row.queue_name, row.id, row.status, row.retry_count, row.updated_at, row.entry_json);
  database.close();
  const before = sha256(await readFile(filename));
  assert.deepEqual(
    (await readOpenclawComparisonDeliveryQueue(root)).map((entry) => ({ ...entry })),
    [row],
  );
  assert.equal(sha256(await readFile(filename)), before);
  const writable = new DatabaseSync(filename);
  writable
    .prepare(
      "INSERT INTO delivery_queue_entries SELECT queue_name, id, status, retry_count, updated_at, entry_json FROM delivery_queue_entries",
    )
    .run();
  for (let count = 0; count < 7; count++)
    writable.prepare("INSERT INTO delivery_queue_entries SELECT * FROM delivery_queue_entries").run();
  writable.close();
  await assert.rejects(readOpenclawComparisonDeliveryQueue(root), /inventory/u);
  t.diagnostic(`Retained read-only SQLite evidence: ${root}`);
});

async function observerFixture() {
  const root = await mkdtemp(path.join(os.tmpdir(), "OpenClaw Delivery Observer "));
  const evidence = path.join(root, "evidence"),
    workspace = path.join(root, "workspace");
  await mkdir(evidence);
  await mkdir(workspace);
  const save = (name, value) => writeFile(path.join(evidence, name), JSON.stringify(value), { flag: "wx" });
  const binding = {
    executionId: "controlled-execution",
    cellId: "openclaw:scheduled_delivery:1",
    revision: NATIVE_COMPARISON_PINS.openclaw,
    manifestSha256: sha256("controlled-manifest"),
    effectiveConfigSha256: sha256("controlled-config"),
    fixtureSha256: sha256(COMPARISON_TASKS.find((entry) => entry.id === "scheduled_delivery")),
  };
  await save("session-start.json", {
    ...binding,
    source: "controlled_fixture",
    taskId: "scheduled_delivery",
    product: "openclaw",
    profile: { model: "fixture-model" },
  });
  const launch = {
    fixtureOnly: true,
    note: "Native-shaped observer unit fixture; no native process or channel is exercised.",
  };
  await save("native-launch.json", launch);
  await save(PERMISSION_REVIEW_FILE, {
    ...binding,
    schemaVersion: PERMISSION_REVIEW_VERSION,
    policy: { files: "disabled", terminal: "disabled", skills: "disabled", schedule: "authorized_destination" },
    reviewedBy: "controlled fixture",
    reviewedAt: new Date().toISOString(),
    sourceReceipts: [{ path: "native-launch.json", sha256: sha256(JSON.stringify(launch)) }],
  });
  const completed = completion(),
    original = structuredClone(completed.job);
  original.enabled = true;
  original.state = { nextRunAtMs: Date.parse(completed.authorization.scheduledFor) };
  let initial = true,
    restarted = false;
  const methods = [];
  const options = {
    cellDirectory: root,
    scheduleId: original.id,
    authorization: completed.authorization,
    request: async (method) => {
      methods.push(method);
      if (method === "cron.get") return structuredClone(initial ? original : completed.job);
      assert.equal(method, "cron.runs");
      return structuredClone(initial ? { entries: [], total: 0, hasMore: false } : completed.runs);
    },
    readQueue: async () => structuredClone(initial ? [] : completed.queue),
    readProviderReceipts: async () => {
      if (initial) {
        initial = false;
        return [];
      }
      return structuredClone(completed.receipts);
    },
    onReconnect: async () => {
      restarted = true;
      return { kind: "owned_process_restart", beforeInstanceId: "fixture-pid-1", afterInstanceId: "fixture-pid-2" };
    },
  };
  return { options, evidence, workspace, methods, completed, wasRestarted: () => restarted };
}

it(
  "retains read-only provenance and verifies thirty seconds of stable reconnect evidence",
  { timeout: 60000 },
  async (t) => {
    const fixture = await observerFixture(),
      began = performance.now();
    const result = await observeOpenclawComparisonDelivery(fixture.options);
    assert.ok(performance.now() - began >= 30000);
    assert.equal(result.taskOutcome, "unverified");
    assert.equal(fixture.wasRestarted(), true);
    assert.ok(fixture.methods.every((name) => ["cron.get", "cron.runs"].includes(name)));
    const verification = await verifyComparisonEvidence({
      taskId: "scheduled_delivery",
      workspaceRoot: fixture.workspace,
      evidenceRoot: fixture.evidence,
    });
    assert.equal(verification.outcome, "passed");
    assert.equal(verification.evidenceKind, "controlled");
    assert.equal(Object.keys(verification.checks).length, 4);
    t.diagnostic(`Retained controlled observer evidence: ${fixture.evidence}`);
  },
);

it("refuses a reconnect that does not replace the owned process", async () => {
  const fixture = await observerFixture();
  await assert.rejects(
    observeOpenclawComparisonDelivery({
      ...fixture.options,
      onReconnect: async () => ({ kind: "owned_process_restart", beforeInstanceId: "pid-1", afterInstanceId: "pid-1" }),
    }),
    /distinct native Gateway/u,
  );
  await assert.rejects(access(path.join(fixture.evidence, "execution.json")));
});

it("cancels a pending reconnect owner without writing a completion receipt", async () => {
  const fixture = await observerFixture(),
    controller = new AbortController();
  await assert.rejects(
    observeOpenclawComparisonDelivery({
      ...fixture.options,
      signal: controller.signal,
      onReconnect: async () => {
        controller.abort(new Error("cancel reconnect"));
        return new Promise(() => {});
      },
    }),
    /cancel reconnect/u,
  );
  await assert.rejects(access(path.join(fixture.evidence, "execution.json")));
  await assert.rejects(access(path.join(fixture.evidence, "native-openclaw-delivery-observer.lock")));
});
