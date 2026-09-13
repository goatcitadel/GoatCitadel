import { open, readFile, realpath, lstat, unlink } from "node:fs/promises";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { performance } from "node:perf_hooks";
import { createGoatComparisonClient } from "./agent-comparison-goat-client.mjs";
import { advanceComparisonWorkflow } from "./agent-comparison-workflow.mjs";
import { readComparisonJson } from "./agent-comparison-session.mjs";
import {
  EXECUTION_BINDING_FIELDS,
  PERMISSION_REVIEW_FILE,
  PERMISSION_REVIEW_VERSION,
} from "./agent-comparison-permissions.mjs";
import { sha256 } from "./agent-comparison.mjs";

const phrase = "HARBOR PILOT CHECK";
const requireValue = (condition, message) => {
  if (!condition) throw new Error(message);
};
const identifier = (value) => typeof value === "string" && /^[A-Za-z0-9_.:-]{1,200}$/u.test(value);
const routeIdentifier = (value) => {
  requireValue(identifier(value) && value !== "." && value !== "..", "Use one native resource identifier.");
  return encodeURIComponent(value);
};
const timestamp = (value) => typeof value === "string" && Number.isFinite(Date.parse(value));
const sameTime = (left, right) => timestamp(left) && timestamp(right) && Date.parse(left) === Date.parse(right);
const spec = (job) =>
  Object.fromEntries(
    ["jobId", "revision", "action", "actionConfig", "schedule", "endAt", "workdir", "contextFrom"]
      .filter((key) => job[key] !== undefined)
      .map((key) => [key, job[key]]),
  );

/** Read native evidence around an operator-owned schedule/reconnect journey.
 * Scheduling, approval, credentials and reconnection remain in the product or
 * its attached supervisor. This observer issues GET requests only. */
export async function observeGoatComparisonDelivery({
  cellDirectory,
  baseUrl,
  token,
  scheduleId,
  authorization,
  onReconnect,
  signal,
  fetchImpl = fetch,
  pollMs = 1000,
  maxTaskMs = 600000,
}) {
  requireValue(identifier(scheduleId), "Choose one exact native schedule.");
  requireValue(
    authorization &&
      Object.keys(authorization).sort().join(",") === "channelKey,connectionId,scheduledFor,target" &&
      authorization.channelKey === "telegram" &&
      /^[a-f0-9-]{36}$/iu.test(authorization.connectionId ?? "") &&
      /^-?[0-9]{1,30}$/u.test(authorization.target ?? "") &&
      timestamp(authorization.scheduledFor),
    "Supply the reviewed Telegram connection, numeric target and exact scheduled time.",
  );
  requireValue(typeof onReconnect === "function", "An explicit native reconnect supervisor is required.");
  requireValue(
    Number.isInteger(pollMs) &&
      pollMs >= 10 &&
      pollMs <= 10000 &&
      Number.isInteger(maxTaskMs) &&
      maxTaskMs >= 30000 &&
      maxTaskMs <= 600000,
    "Use bounded observation timing.",
  );
  const root = await realpath(cellDirectory);
  requireValue(path.resolve(cellDirectory) === root, "Use the canonical comparison cell directory.");
  for (const directory of [root, path.join(root, "workspace"), path.join(root, "evidence")])
    requireValue(
      (await realpath(directory)) === directory &&
        (await lstat(directory)).isDirectory() &&
        !(await lstat(directory)).isSymbolicLink(),
      "Comparison directories cannot be linked.",
    );
  const evidence = path.join(root, "evidence");
  const start = await readComparisonJson(path.join(evidence, "session-start.json"));
  requireValue(
    start.product === "goatcitadel" &&
      start.taskId === "scheduled_delivery" &&
      ["controlled_fixture", "native_receipts"].includes(start.source) &&
      EXECUTION_BINDING_FIELDS.every((key) => typeof start[key] === "string" && start[key]),
    "The observer requires a declared GoatCitadel delivery cell and evidence source.",
  );
  const binding = Object.fromEntries(EXECUTION_BINDING_FIELDS.map((key) => [key, start[key]]));
  const permission = await readComparisonJson(path.join(evidence, PERMISSION_REVIEW_FILE));
  requireValue(
    permission.schemaVersion === PERMISSION_REVIEW_VERSION &&
      EXECUTION_BINDING_FIELDS.every((key) => permission[key] === binding[key]) &&
      ["authorized_destination", "per_send_approval"].includes(permission.policy?.schedule) &&
      Array.isArray(permission.sourceReceipts) &&
      permission.sourceReceipts.length > 0 &&
      permission.sourceReceipts.length <= 20,
    "Retain the reviewed native schedule/delivery policy and its source receipts.",
  );
  for (const receipt of permission.sourceReceipts) {
    requireValue(
      /^native-[A-Za-z0-9][A-Za-z0-9._-]{0,112}$/u.test(receipt.path ?? "") &&
        ![PERMISSION_REVIEW_FILE, "native-goat-delivery-schedule.json", "native-goat-delivery-reconnect.json"].includes(
          receipt.path,
        ) &&
        /^[a-f0-9]{64}$/u.test(receipt.sha256 ?? ""),
      "Native permission sources must be distinct bounded receipt files.",
    );
    await readComparisonJson(path.join(evidence, receipt.path));
    requireValue(
      sha256(await readFile(path.join(evidence, receipt.path))) === receipt.sha256,
      "Native permission source changed.",
    );
  }
  const activeSignal = AbortSignal.any([AbortSignal.timeout(maxTaskMs), ...(signal ? [signal] : [])]);
  const lockPath = path.join(evidence, "native-goat-delivery-observer.lock");
  const records = [];
  let phase = "schedule",
    sequence = 0;
  const retain = async (name, value) => {
    const entry = { phase, sequence: ++sequence, name, observedAt: new Date().toISOString(), ...value };
    requireValue(
      sequence <= 450 && Buffer.byteLength(JSON.stringify(entry)) <= 1024 * 1024,
      "Native delivery evidence exceeds its bound.",
    );
    await writeNew(path.join(evidence, `native-goat-delivery-${String(sequence).padStart(4, "0")}.json`), entry);
    records.push(entry);
  };
  const apiOptions = { baseUrl, token, signal: activeSignal, retain, fetchImpl };
  let api = createGoatComparisonClient(apiOptions);
  const getJob = () => api("schedule", `/cron/jobs/${encodeURIComponent(scheduleId)}`);
  const getDeliveries = async () => {
    const page = await api("deliveries", "/comms/deliveries?limit=200");
    requireValue(
      Array.isArray(page.deliveries) &&
        page.deliveries.length < 200 &&
        page.count === page.deliveries.length &&
        new Set(page.deliveries.map((item) => item.deliveryId)).size === page.deliveries.length &&
        page.deliveries.every((item) => identifier(item.deliveryId)),
      "The native delivery inventory is incomplete or ambiguous.",
    );
    return page.deliveries;
  };
  const advance = async (action, delivery) => {
    const nativePath = `native-goat-delivery-${action}.json`;
    const bytes = await writeNew(path.join(evidence, nativePath), {
      ...binding,
      source: start.source,
      records: records.filter((entry) => entry.phase === action),
    });
    await advanceComparisonWorkflow({
      cellDirectory: root,
      action,
      executionFile: "workflow-execution.json",
      receipt: {
        ...binding,
        source: start.source,
        nativeReceipt: { path: nativePath, sha256: sha256(bytes) },
        permissionReview: {
          path: PERMISSION_REVIEW_FILE,
          sha256: sha256(await readFile(path.join(evidence, PERMISSION_REVIEW_FILE))),
        },
        delivery,
      },
    });
  };
  const lock = await open(lockPath, "wx", 0o600);
  try {
    await lock.writeFile(JSON.stringify({ pid: process.pid, ...binding }));
    await lock.sync();
    const job = await getJob();
    const deliveryChannel = job.actionConfig?.agentTurn?.deliveryChannel;
    requireValue(
      job.jobId === scheduleId &&
        Number.isSafeInteger(job.revision) &&
        job.revision > 0 &&
        job.action === "agent_turn" &&
        job.enabled === true &&
        !job.activeRunId &&
        !job.lastRunId &&
        deliveryChannel?.channelKey === authorization.channelKey &&
        deliveryChannel.target === authorization.target &&
        sameTime(job.nextRunAt, authorization.scheduledFor) &&
        Date.parse(job.nextRunAt) > Date.now() &&
        Date.parse(job.nextRunAt) < Date.now() + maxTaskMs - 30000 &&
        timestamp(job.endAt) &&
        Date.parse(job.endAt) > Date.parse(job.nextRunAt) &&
        Date.parse(job.endAt) <= Date.parse(job.nextRunAt) + 60000,
      "The native job must be a fresh, bounded reminder at the reviewed time and destination.",
    );
    requireValue(
      (await getDeliveries()).length === 0,
      "Use a dedicated comparison runtime with no earlier channel deliveries.",
    );
    const frozenSpec = sha256(spec(job));
    const delivery = {
      scheduleId,
      scheduledFor: authorization.scheduledFor,
      schedulePersisted: true,
      authorizedDestination: `${authorization.channelKey}:${authorization.target}`,
    };
    await retain("authorization", { authorization, scheduleSha256: frozenSpec });
    await advance("schedule", delivery);
    phase = "reconnect";
    let completed;
    while (!completed) {
      activeSignal.throwIfAborted();
      const current = await getJob();
      requireValue(sha256(spec(current)) === frozenSpec, "The reviewed native schedule changed during observation.");
      if (current.lastRunId) {
        const run = await api("cron-run", `/cron/runs/${encodeURIComponent(current.lastRunId)}`);
        const occurrence = run.canonical;
        requireValue(
          occurrence &&
            occurrence.runId === run.runId &&
            run.runId === current.lastRunId &&
            occurrence.jobId === scheduleId &&
            run.jobId === scheduleId &&
            occurrence.trigger === "scheduled_due" &&
            sameTime(occurrence.scheduledFor, authorization.scheduledFor) &&
            occurrence.jobRevision === job.revision &&
            Number.isSafeInteger(occurrence.executionGeneration) &&
            occurrence.executionGeneration > 0,
          "The native occurrence is missing, manual, or bound to another schedule/time/revision.",
        );
        requireValue(
          ["admitting", "admitted", "running", "waiting", "completed"].includes(occurrence.status),
          "The native scheduled occurrence did not complete successfully.",
        );
        if (occurrence.status === "completed") {
          requireValue(
            run.status === "ok" && occurrence.phase === "settlement",
            "Cron summary and canonical settlement disagree.",
          );
          completed = await readDeliveryCompletion(api, occurrence, authorization, getDeliveries);
        }
      }
      if (!completed) await delay(pollMs, undefined, { signal: activeSignal });
    }
    const acknowledged = await getDeliveries();
    assertSingleDelivery(acknowledged, completed, authorization);
    await retain("reconnect-requested", {
      scheduleId,
      runId: completed.occurrence.runId,
      deliveryId: completed.result.deliveryId,
    });
    const reconnection = await abortable(
      () =>
        onReconnect({
          scheduleId,
          runId: completed.occurrence.runId,
          deliveryId: completed.result.deliveryId,
          signal: activeSignal,
        }),
      activeSignal,
    );
    activeSignal.throwIfAborted();
    requireValue(
      reconnection &&
        ["operator_confirmed_reconnect", "owned_runtime_restart"].includes(reconnection.kind) &&
        typeof reconnection.detail === "string" &&
        reconnection.detail.trim() &&
        reconnection.detail.length <= 1000,
      "Retain how the native runtime/channel was reconnected.",
    );
    await retain("reconnected", { kind: reconnection.kind, detail: reconnection.detail });
    api = createGoatComparisonClient({
      ...apiOptions,
      baseUrl: reconnection.baseUrl ?? baseUrl,
      token: reconnection.token ?? token,
    });
    const reconnectedAt = new Date().toISOString(),
      monotonicStart = performance.now();
    let finalRows;
    for (;;) {
      activeSignal.throwIfAborted();
      const current = await getJob();
      requireValue(
        sha256(spec(current)) === frozenSpec &&
          current.lastRunId === completed.occurrence.runId &&
          !current.activeRunId,
        "The schedule changed or another occurrence appeared after reconnect.",
      );
      finalRows = await getDeliveries();
      assertSingleDelivery(finalRows, completed, authorization);
      requireValue(sha256(finalRows) === sha256(acknowledged), "Native delivery state changed after reconnect.");
      if (performance.now() - monotonicStart >= 30000) break;
      await delay(Math.min(pollMs, 30000 - (performance.now() - monotonicStart)), undefined, { signal: activeSignal });
    }
    const confirmed = await api(
      "cron-run-after-reconnect",
      `/cron/runs/${encodeURIComponent(completed.occurrence.runId)}`,
    );
    requireValue(
      sha256(confirmed.canonical) === sha256(completed.occurrence),
      "Canonical occurrence changed after reconnect.",
    );
    const reread = await readDeliveryCompletion(api, confirmed.canonical, authorization, getDeliveries);
    requireValue(sha256(reread) === sha256(completed), "Canonical delivery linkage changed after reconnect.");
    await advance("reconnect", {
      ...delivery,
      receipts: [
        {
          providerMessageId: finalRows[0].providerMessageId,
          message: phrase,
          destination: delivery.authorizedDestination,
          acknowledgedAt: finalRows[0].updatedAt,
        },
      ],
      reconnectedAt,
      observedUntil: new Date().toISOString(),
      pendingDeliveries: 0,
      reconnectKind: reconnection.kind,
    });
    const workflow = await readComparisonJson(path.join(evidence, "workflow-execution.json"));
    const receipts = [...permission.sourceReceipts, ...workflow.nativeReceipts];
    requireValue(
      new Set(receipts.map((item) => item.path)).size === receipts.length,
      "Native evidence sources overlap.",
    );
    await writeNew(path.join(evidence, "execution.json"), { ...workflow, nativeReceipts: receipts });
    return {
      scheduleId,
      runId: completed.occurrence.runId,
      deliveryId: completed.result.deliveryId,
      providerMessageId: completed.result.providerMessageId,
      reconnectKind: reconnection.kind,
      taskOutcome: "unverified",
    };
  } finally {
    await lock.close();
    await unlink(lockPath);
  }
}

async function readDeliveryCompletion(api, occurrence, authorization, getDeliveries) {
  requireValue(
    [occurrence.childSessionId, occurrence.childTurnId, occurrence.childDurableRunId, occurrence.deliveryRunId].every(
      identifier,
    ),
    "Canonical cron child and delivery linkage is incomplete.",
  );
  const child = await api("chat-child", `/durable/runs/${routeIdentifier(occurrence.childDurableRunId)}`);
  requireValue(
    child.runId === occurrence.childDurableRunId &&
      child.workflowKey === "chat.turn.execute" &&
      child.status === "completed" &&
      child.payload?.sessionId === occurrence.childSessionId &&
      child.payload.turnId === occurrence.childTurnId &&
      child.metadata?.cronRunId === occurrence.runId &&
      child.metadata.cronJobId === occurrence.jobId &&
      child.metadata.cronExecutionGeneration === occurrence.executionGeneration,
    "The native Chat child does not belong to this occurrence.",
  );
  const transport = await api("delivery-child", `/durable/runs/${routeIdentifier(occurrence.deliveryRunId)}`);
  const connectorId = `integration:${authorization.connectionId}`;
  requireValue(
    transport.runId === occurrence.deliveryRunId &&
      transport.workflowKey === "connector.delivery" &&
      transport.status === "completed" &&
      transport.metadata?.deliveryKind === "autonomous.assistant_message" &&
      transport.metadata.sourceRunId === child.runId &&
      transport.payload?.runId === child.runId &&
      transport.payload.sessionId === occurrence.childSessionId &&
      transport.payload.connectorId === connectorId &&
      transport.payload.action === "channel.send" &&
      transport.payload.payload?.target === authorization.target &&
      transport.payload.payload.message === phrase,
    "The completed native delivery does not match the exact parent, connector, destination and reminder.",
  );
  const checkpoints = await api(
    "delivery-checkpoints",
    `/durable/runs/${routeIdentifier(transport.runId)}/checkpoints?limit=200`,
  );
  requireValue(
    Array.isArray(checkpoints.items) && checkpoints.items.length < 200,
    "Native delivery checkpoints are incomplete.",
  );
  const terminal = checkpoints.items.filter((item) => item.checkpointKind === "run_completed");
  requireValue(
    terminal.length === 1 &&
      terminal[0].runId === transport.runId &&
      terminal[0].state?.connectorId === connectorId &&
      terminal[0].state.action === "channel.send",
    "Retain one exact native delivery completion checkpoint.",
  );
  const result = terminal[0].state.result;
  requireValue(
    ["queued", "sent"].includes(result?.status) &&
      identifier(result.deliveryId) &&
      result.channelKey === authorization.channelKey &&
      result.target === authorization.target,
    "Native delivery completion lacks an exact channel admission receipt.",
  );
  // Queue-admission checkpoints are immutable. A later provider acknowledgement
  // belongs to the exact canonical channel row, not to a rewritten checkpoint.
  const rows = await getDeliveries();
  const row = rows.find((entry) => entry.deliveryId === result.deliveryId);
  requireValue(
    row?.status === "sent" &&
      row.deliveryStatus === "sent" &&
      identifier(row.providerMessageId) &&
      (result.providerMessageId === undefined || result.providerMessageId === row.providerMessageId),
    "Native delivery completion lacks an acknowledged provider message.",
  );
  const completed = { occurrence, result: { deliveryId: result.deliveryId, providerMessageId: row.providerMessageId } };
  assertSingleDelivery(rows, completed, authorization);
  return completed;
}

function assertSingleDelivery(rows, completed, authorization) {
  const row = rows[0];
  requireValue(
    rows.length === 1 &&
      row.deliveryId === completed.result.deliveryId &&
      row.connectionId === authorization.connectionId &&
      row.channelKey === authorization.channelKey &&
      row.target === authorization.target &&
      row.status === "sent" &&
      row.attempts === 1 &&
      row.providerMessageId === completed.result.providerMessageId &&
      timestamp(row.updatedAt) &&
      Date.parse(row.updatedAt) >= Date.parse(authorization.scheduledFor) &&
      Date.parse(row.updatedAt) <= Date.now(),
    "Native delivery evidence is duplicated, changed, retried, pending or unacknowledged.",
  );
}

async function writeNew(filename, value) {
  const bytes = Buffer.from(JSON.stringify(value, null, 2) + "\n");
  requireValue(bytes.length <= 4 * 1024 * 1024, "Native delivery receipt exceeds its bound.");
  const handle = await open(filename, "wx", 0o600);
  try {
    await handle.writeFile(bytes);
    await handle.sync();
  } finally {
    await handle.close();
  }
  return bytes;
}

async function abortable(callback, signal) {
  signal.throwIfAborted();
  let onAbort;
  try {
    return await Promise.race([
      Promise.resolve().then(callback),
      new Promise((_, reject) => {
        onAbort = () => reject(signal.reason);
        signal.addEventListener("abort", onAbort, { once: true });
      }),
    ]);
  } finally {
    signal.removeEventListener("abort", onAbort);
  }
}
