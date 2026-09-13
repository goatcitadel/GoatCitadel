import { lstat, open, readFile, realpath, unlink } from "node:fs/promises";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { setTimeout as delay } from "node:timers/promises";
import { sha256 } from "./agent-comparison.mjs";
import { NATIVE_COMPARISON_PINS } from "./agent-comparison-native-profile.mjs";
import {
  EXECUTION_BINDING_FIELDS,
  PERMISSION_REVIEW_FILE,
  PERMISSION_REVIEW_VERSION,
} from "./agent-comparison-permissions.mjs";
import { readComparisonJson } from "./agent-comparison-session.mjs";
import { advanceComparisonWorkflow } from "./agent-comparison-workflow.mjs";

const requireValue = (condition, message) => {
  if (!condition) throw new Error(message);
};
const identifier = (value) => typeof value === "string" && /^[A-Za-z0-9][A-Za-z0-9:._/-]{0,250}$/u.test(value);
const timestamp = (value) => Number.isFinite(Date.parse(value));
const phrase = "HARBOR PILOT CHECK";

/** Read the pinned product's queue directly without opening its migration or
 * repair owners. Only a fresh comparison state directory belongs here. */
export async function readOpenclawComparisonDeliveryQueue(stateDirectory) {
  return readNativeDatabase(stateDirectory, readQueueRows);
}

/** Capture queue custody and the exact active scheduler owner before returning
 * a controlled wire acknowledgement. The public history omits this run ID. */
export async function readOpenclawComparisonDeliveryDispatch(stateDirectory, jobId) {
  requireValue(identifier(jobId), "Choose one exact native scheduler job.");
  return readNativeDatabase(stateDirectory, (database) => ({
    queue: readQueueRows(database),
    tasks: database
      .prepare(
        "SELECT task_id, run_id, source_id, runtime, child_session_key, started_at, status FROM task_runs WHERE runtime = ? AND source_id = ? ORDER BY task_id LIMIT 2",
      )
      .all("cron", jobId),
    receipts: database
      .prepare(
        "SELECT job_id, receipt_id, request_run_id, started_at_ms, finished_at_ms, status FROM cron_run_receipts WHERE job_id = ? ORDER BY started_at_ms LIMIT 2",
      )
      .all(jobId),
  }));
}

async function readNativeDatabase(stateDirectory, read) {
  const root = await realpath(stateDirectory);
  requireValue(root === path.resolve(stateDirectory), "Use the canonical comparison state directory.");
  const filename = path.join(root, "state", "openclaw.sqlite");
  for (const name of [root, path.dirname(filename), filename]) {
    const info = await lstat(name);
    requireValue(!info.isSymbolicLink() && (await realpath(name)) === name, "Native queue paths cannot be linked.");
  }
  requireValue((await lstat(filename)).isFile(), "Native state must be an existing regular database.");
  const database = new DatabaseSync(filename, { readOnly: true });
  try {
    database.exec("BEGIN");
    const result = read(database);
    requireValue(Buffer.byteLength(JSON.stringify(result)) <= 1024 * 1024, "Native queue snapshot exceeds its bound.");
    return result;
  } finally {
    database.close();
  }
}

function readQueueRows(database) {
  const rows = database
    .prepare(
      "SELECT queue_name, id, status, retry_count, updated_at, entry_json FROM delivery_queue_entries ORDER BY queue_name, id LIMIT 201",
    )
    .all();
  requireValue(
    rows.length <= 200 && Buffer.byteLength(JSON.stringify(rows)) <= 1024 * 1024,
    "Native queue inventory is incomplete or exceeds its bound.",
  );
  return rows;
}

const specification = (job) =>
  Object.fromEntries(
    [
      "id",
      "name",
      "agentId",
      "sessionKey",
      "createdAtMs",
      "schedule",
      "sessionTarget",
      "wakeMode",
      "payload",
      "delivery",
      "deleteAfterRun",
    ]
      .filter((key) => Object.hasOwn(job, key))
      .map((key) => [key, job[key]]),
  );

export function projectOpenclawComparisonDelivery({ job, runs, queue, receipts, authorization, model }) {
  requireValue(
    Array.isArray(runs?.entries) && runs.entries.length === 1 && runs.total === 1 && runs.hasMore === false,
    "Retain exactly one complete native cron run history.",
  );
  const run = runs.entries[0];
  requireValue(
    run.jobId === job.id &&
      identifier(run.sessionId) &&
      identifier(run.sessionKey) &&
      run.action === "finished" &&
      run.status === "ok" &&
      run.completionStatus === "succeeded" &&
      run.delivered === true &&
      run.deliveryStatus === "delivered" &&
      !run.error &&
      !run.deliveryError &&
      run.provider === "comparison" &&
      run.model === model &&
      Number.isSafeInteger(run.runAtMs) &&
      run.runAtMs >= Date.parse(authorization.scheduledFor),
    "The native cron outcome lacks successful execution, route, or delivery evidence.",
  );
  for (const target of [run.delivery?.intended, run.delivery?.resolved])
    requireValue(
      target?.channel === "telegram" &&
        target.to === authorization.target &&
        target.accountId === authorization.accountId,
      "The native cron delivery target changed.",
    );
  requireValue(
    run.delivery.resolved.ok === true &&
      run.delivery.delivered === true &&
      // The pinned runtime names its normal direct-announcement path fallback;
      // it means the agent did not already send through a message tool.
      run.delivery.fallbackUsed === true &&
      !run.delivery.messageToolSentTo?.length,
    "Native delivery used an unreviewed or competing send path.",
  );
  requireValue(
    job.enabled === false &&
      !job.state?.runningAtMs &&
      !job.state?.nextRunAtMs &&
      job.state?.lastRunAtMs === run.runAtMs &&
      job.state.lastRunStatus === "ok" &&
      job.state.lastDelivered === true &&
      job.state.lastDeliveryStatus === "delivered",
    "The one-shot schedule has not settled its canonical delivery.",
  );
  requireValue(
    Array.isArray(receipts) && receipts.length === 1,
    "Retain exactly one independently observed provider receipt.",
  );
  const receipt = receipts[0],
    dispatch = receipt.nativeDispatch;
  requireValue(
    dispatch?.tasks?.length === 1 && dispatch.receipts?.length === 1 && dispatch.queue?.length === 1,
    "Retain the exact native dispatch owners before provider acknowledgement.",
  );
  const task = dispatch.tasks[0],
    claim = dispatch.receipts[0],
    pending = dispatch.queue[0];
  requireValue(
    task.runtime === "cron" &&
      task.source_id === job.id &&
      identifier(task.task_id) &&
      task.status === "running" &&
      task.child_session_key === run.sessionKey &&
      task.started_at === run.runAtMs &&
      claim.job_id === job.id &&
      identifier(claim.receipt_id) &&
      claim.status === "running" &&
      claim.finished_at_ms === null &&
      claim.request_run_id === null &&
      claim.started_at_ms === run.runAtMs &&
      task.run_id === `cron:${job.id}:${run.runAtMs}:${claim.receipt_id}` &&
      (run.runId === undefined || run.runId === task.run_id),
    "The provider acknowledgement lacks the exact active scheduled occurrence.",
  );
  const deliveryId = pending.id;
  const prefix = `cron-direct-delivery:v1:cron:${job.id}:`,
    suffix = `:telegram:${encodeURIComponent(authorization.accountId)}:${encodeURIComponent(`telegram:${authorization.target}`)}:`;
  requireValue(
    typeof deliveryId === "string" && deliveryId.startsWith(prefix) && deliveryId.endsWith(suffix),
    "The native delivery queue belongs to another schedule or route.",
  );
  const innerStartedAt = Number(deliveryId.slice(prefix.length, -suffix.length));
  requireValue(
    Number.isSafeInteger(innerStartedAt) &&
      innerStartedAt >= run.runAtMs &&
      pending.queue_name === "outbound-prepared-v1" &&
      pending.status === "pending" &&
      pending.retry_count === 0,
    "The native delivery queue lacks its original pre-acknowledgement custody.",
  );
  const prepared = JSON.parse(pending.entry_json);
  requireValue(
    prepared.id === deliveryId &&
      prepared.retryCount === 0 &&
      prepared.attemptCount === 0 &&
      prepared.channel === "telegram" &&
      prepared.to === authorization.target &&
      prepared.accountId === authorization.accountId &&
      prepared.queuePolicy === "required" &&
      prepared.requiresProducerClaim === true &&
      prepared.recoveryState === "send_attempt_started" &&
      identifier(prepared.platformSendAttemptId) &&
      Number.isSafeInteger(prepared.platformSendStartedAt) &&
      prepared.platformSendStartedAt >= innerStartedAt &&
      prepared.platformSendStartedAt <= Date.parse(receipt.acknowledgedAt) &&
      prepared.availableAt > Date.parse(receipt.acknowledgedAt) &&
      prepared.preparedBatch?.entries?.length === 1 &&
      prepared.preparedBatch.entries[0].status === "accepted" &&
      prepared.preparedBatch.entries[0].payload?.text === phrase,
    "The native queued payload changed before provider acknowledgement.",
  );
  requireValue(
    Array.isArray(queue) &&
      queue.length === 1 &&
      queue[0].queue_name === "outbound-prepared-v1" &&
      queue[0].id === deliveryId &&
      queue[0].status === "completed" &&
      queue[0].retry_count === 0,
    "The native delivery queue is duplicated, pending, failed, retried, or unrelated.",
  );
  const entry = JSON.parse(queue[0].entry_json);
  requireValue(
    entry.id === deliveryId &&
      entry.retryCount === 0 &&
      Number.isSafeInteger(entry.acknowledgedAt) &&
      entry.acknowledgedAt >= run.runAtMs &&
      entry.recoveryState === "completed_bounded",
    "The native queue lacks its retained completion receipt.",
  );
  requireValue(
    receipt.fixtureOnly === true &&
      identifier(receipt.providerMessageId) &&
      receipt.destination === `telegram:${authorization.target}` &&
      receipt.accountId === authorization.accountId &&
      receipt.message === phrase &&
      timestamp(receipt.acknowledgedAt) &&
      Date.parse(receipt.acknowledgedAt) >= run.runAtMs &&
      Date.parse(receipt.acknowledgedAt) <= entry.acknowledgedAt,
    "The controlled provider acknowledgement does not match the native delivery.",
  );
  return { run, runId: task.run_id, deliveryId, receipt };
}

/** Controlled native conformance only. The observer issues read RPCs and reads
 * the retained queue; the caller owns scheduling, wire receipts and restart.
 * A live provider-receipt adapter requires a separate reviewed evidence owner. */
export async function observeOpenclawComparisonDelivery({
  cellDirectory,
  scheduleId,
  authorization,
  request,
  readQueue,
  readProviderReceipts,
  onReconnect,
  signal,
  pollMs = 1000,
  maxTaskMs = 300000,
}) {
  requireValue(
    identifier(scheduleId) &&
      authorization &&
      Object.keys(authorization).sort().join(",") === "accountId,scheduledFor,target" &&
      identifier(authorization.accountId) &&
      /^-?[0-9]{1,30}$/u.test(authorization.target ?? "") &&
      timestamp(authorization.scheduledFor),
    "Review one exact native schedule, Telegram account, target and due time.",
  );
  requireValue(
    [request, readQueue, readProviderReceipts, onReconnect].every((item) => typeof item === "function"),
    "Attach native read, provider-observation and reconnect owners.",
  );
  requireValue(
    Number.isInteger(pollMs) &&
      pollMs >= 10 &&
      pollMs <= 10000 &&
      Number.isInteger(maxTaskMs) &&
      maxTaskMs >= 30000 &&
      maxTaskMs <= 600000,
    "Use bounded delivery observation timing.",
  );
  const root = await realpath(cellDirectory),
    evidence = path.join(root, "evidence");
  requireValue(path.resolve(cellDirectory) === root, "Use the canonical comparison cell.");
  for (const directory of [root, evidence, path.join(root, "workspace")])
    requireValue(
      (await realpath(directory)) === directory && !(await lstat(directory)).isSymbolicLink(),
      "Comparison directories cannot be linked.",
    );
  const start = await readComparisonJson(path.join(evidence, "session-start.json"));
  requireValue(
    start.product === "openclaw" &&
      start.taskId === "scheduled_delivery" &&
      start.source === "controlled_fixture" &&
      start.revision === NATIVE_COMPARISON_PINS.openclaw &&
      EXECUTION_BINDING_FIELDS.every((key) => typeof start[key] === "string" && start[key]),
    "Use the pinned controlled OpenClaw delivery cell.",
  );
  const binding = Object.fromEntries(EXECUTION_BINDING_FIELDS.map((key) => [key, start[key]]));
  const permission = await readComparisonJson(path.join(evidence, PERMISSION_REVIEW_FILE));
  requireValue(
    permission.schemaVersion === PERMISSION_REVIEW_VERSION &&
      EXECUTION_BINDING_FIELDS.every((key) => permission[key] === binding[key]) &&
      permission.policy?.schedule === "authorized_destination" &&
      Array.isArray(permission.sourceReceipts) &&
      permission.sourceReceipts.length > 0 &&
      permission.sourceReceipts.length <= 20,
    "Retain the actual native authorization policy and its source evidence.",
  );
  for (const source of permission.sourceReceipts) {
    requireValue(
      /^native-[A-Za-z0-9][A-Za-z0-9._-]{0,112}$/u.test(source.path ?? "") && source.path !== PERMISSION_REVIEW_FILE,
      "Use bounded native permission source names.",
    );
    await readComparisonJson(path.join(evidence, source.path));
    requireValue(
      sha256(await readFile(path.join(evidence, source.path))) === source.sha256,
      "Native permission evidence changed.",
    );
  }
  const active = AbortSignal.any([AbortSignal.timeout(maxTaskMs), ...(signal ? [signal] : [])]);
  const records = [];
  let phase = "schedule",
    sequence = 0;
  const retain = async (name, value) => {
    requireValue(++sequence <= 450, "Native delivery observation exceeded its snapshot bound.");
    const record = { phase, sequence, name, observedAt: new Date().toISOString(), ...value };
    await writeNew(path.join(evidence, `native-openclaw-delivery-${String(sequence).padStart(4, "0")}.json`), record);
    records.push(record);
  };
  const read = async (name, callback) => {
    const result = await abortable(callback, active);
    await retain(name, { result });
    return result;
  };
  const getJob = () => read("cron-get", () => request("cron.get", { id: scheduleId }, active));
  const getRuns = () =>
    read("cron-runs", () => request("cron.runs", { id: scheduleId, limit: 200, offset: 0, sortDir: "asc" }, active));
  const advance = async (action, delivery) => {
    const filename = `native-openclaw-delivery-${action}.json`;
    const bytes = await writeNew(path.join(evidence, filename), {
      ...binding,
      source: start.source,
      records: records.filter((item) => item.phase === action),
    });
    await advanceComparisonWorkflow({
      cellDirectory: root,
      action,
      executionFile: "workflow-execution.json",
      receipt: {
        ...binding,
        source: start.source,
        nativeReceipt: { path: filename, sha256: sha256(bytes) },
        permissionReview: {
          path: PERMISSION_REVIEW_FILE,
          sha256: sha256(await readFile(path.join(evidence, PERMISSION_REVIEW_FILE))),
        },
        delivery,
      },
    });
  };
  const lockPath = path.join(evidence, "native-openclaw-delivery-observer.lock"),
    lock = await open(lockPath, "wx", 0o600);
  try {
    await lock.writeFile(JSON.stringify({ pid: process.pid, ...binding }));
    await lock.sync();
    const original = await getJob(),
      initialRuns = await getRuns();
    requireValue(
      original.id === scheduleId &&
        original.enabled === true &&
        original.schedule?.kind === "at" &&
        original.schedule.at === authorization.scheduledFor &&
        original.deleteAfterRun === false &&
        original.sessionTarget === "isolated" &&
        original.payload?.kind === "agentTurn" &&
        original.payload.message === phrase &&
        original.payload.model === `comparison/${start.profile.model}` &&
        Array.isArray(original.payload.toolsAllow) &&
        original.payload.toolsAllow.length === 0 &&
        original.delivery?.mode === "announce" &&
        original.delivery.channel === "telegram" &&
        original.delivery.to === authorization.target &&
        original.delivery.accountId === authorization.accountId &&
        original.delivery.bestEffort !== true &&
        !original.delivery.completionDestination &&
        !original.delivery.failureDestination &&
        !original.delivery.threadId &&
        original.state?.nextRunAtMs === Date.parse(authorization.scheduledFor) &&
        !original.state?.lastRunAtMs &&
        !original.state?.runningAtMs &&
        initialRuns.total === 0 &&
        initialRuns.entries?.length === 0 &&
        initialRuns.hasMore === false,
      "The native schedule is not a fresh, bounded, authorized one-shot reminder.",
    );
    requireValue(
      (await read("queue-before", readQueue)).length === 0 &&
        (await read("provider-before", readProviderReceipts)).length === 0,
      "The controlled delivery state is not fresh.",
    );
    const frozen = sha256(specification(original));
    const delivery = {
      scheduleId,
      scheduledFor: authorization.scheduledFor,
      authorizedDestination: `telegram:${authorization.target}`,
      schedulePersisted: true,
    };
    await advance("schedule", delivery);
    phase = "reconnect";
    let completed, stable;
    const snapshot = async () => ({
      job: await getJob(),
      runs: await getRuns(),
      queue: await read("queue", readQueue),
      receipts: await read("provider", readProviderReceipts),
    });
    for (;;) {
      active.throwIfAborted();
      const current = await snapshot();
      requireValue(
        sha256(specification(current.job)) === frozen,
        "Native schedule definition changed during delivery.",
      );
      requireValue(
        current.runs.total <= 1 &&
          current.runs.hasMore === false &&
          current.runs.entries?.length === current.runs.total &&
          current.receipts.length <= 1,
        "Native delivery inventory is incomplete or duplicated.",
      );
      if (current.runs.entries.length) {
        completed = projectOpenclawComparisonDelivery({ ...current, authorization, model: start.profile.model });
        stable = current;
        break;
      }
      await delay(pollMs, undefined, { signal: active });
    }
    const reconnection = await abortable(() => onReconnect(completed, active), active);
    requireValue(
      reconnection?.kind === "owned_process_restart" &&
        identifier(reconnection.beforeInstanceId) &&
        identifier(reconnection.afterInstanceId) &&
        reconnection.beforeInstanceId !== reconnection.afterInstanceId,
      "Retain distinct native Gateway process identities across restart.",
    );
    await retain("reconnected", { reconnection });
    const reconnectedAt = new Date().toISOString(),
      monotonicStart = performance.now();
    for (;;) {
      active.throwIfAborted();
      const current = await snapshot();
      projectOpenclawComparisonDelivery({ ...current, authorization, model: start.profile.model });
      requireValue(
        sha256(current) === sha256(stable),
        "Native schedule, run, receipt or queue changed after reconnect.",
      );
      if (performance.now() - monotonicStart >= 30000) break;
      await delay(Math.min(pollMs, 30000 - (performance.now() - monotonicStart)), undefined, { signal: active });
    }
    await advance("reconnect", {
      ...delivery,
      receipts: [completed.receipt],
      reconnectedAt,
      observedUntil: new Date().toISOString(),
      pendingDeliveries: 0,
      reconnectKind: reconnection.kind,
    });
    const workflow = await readComparisonJson(path.join(evidence, "workflow-execution.json"));
    const nativeReceipts = [...permission.sourceReceipts, ...workflow.nativeReceipts];
    requireValue(
      new Set(nativeReceipts.map((item) => item.path)).size === nativeReceipts.length,
      "Native evidence sources overlap.",
    );
    await writeNew(path.join(evidence, "execution.json"), { ...workflow, nativeReceipts });
    return {
      scheduleId,
      runId: completed.runId,
      deliveryId: completed.deliveryId,
      providerMessageId: completed.receipt.providerMessageId,
      taskOutcome: "unverified",
    };
  } finally {
    await lock.close();
    await unlink(lockPath);
  }
}

async function writeNew(filename, value) {
  const bytes = Buffer.from(JSON.stringify(value, null, 2) + "\n");
  requireValue(bytes.length <= 4 * 1024 * 1024, "Native delivery evidence exceeds its byte bound.");
  const file = await open(filename, "wx", 0o600);
  try {
    await file.writeFile(bytes);
    await file.sync();
  } finally {
    await file.close();
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
