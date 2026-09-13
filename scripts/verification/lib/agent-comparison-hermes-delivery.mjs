import { lstat, readFile, realpath } from "node:fs/promises";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { setTimeout as delay } from "node:timers/promises";
import { sha256 } from "./agent-comparison.mjs";

const requireValue = (condition, message) => {
  if (!condition) throw new Error(message);
};
const identifier = (value) => typeof value === "string" && /^[A-Za-z0-9][A-Za-z0-9:._/-]{0,250}$/u.test(value);
const time = (value) => (typeof value === "string" ? Date.parse(value) : NaN);
const phrase = "HARBOR PILOT CHECK";
const specification = (job) =>
  Object.fromEntries(
    [
      "id",
      "name",
      "prompt",
      "skills",
      "skill",
      "model",
      "provider",
      "provider_snapshot",
      "model_snapshot",
      "base_url",
      "script",
      "no_agent",
      "monitor_script",
      "monitor_url",
      "context_from",
      "schedule",
      "created_at",
      "deliver",
      "origin",
      "enabled_toolsets",
      "workdir",
      "attach_to_session",
      "failure_deliver",
      "reasoning_effort",
    ]
      .filter((key) => Object.hasOwn(job, key))
      .map((key) => [key, job[key]]),
  );
const oneJob = (state) => {
  requireValue(state?.jobs?.jobs?.length === 1, "Retain exactly one native Hermes schedule.");
  return state.jobs.jobs[0];
};
const noQueue = (state) =>
  requireValue(
    state.queue?.status === "missing",
    "This native in-process profile must not substitute a queued or uncertain delivery.",
  );

export function projectHermesComparisonSchedule({ state, authorization, model }) {
  requireValue(
    authorization &&
      Object.keys(authorization).sort().join(",") === "accountId,scheduledFor,target" &&
      authorization.accountId === "default" &&
      /^-?[0-9]{1,30}$/u.test(authorization.target ?? "") &&
      Number.isFinite(time(authorization.scheduledFor)),
    "Review one exact Hermes account, target and due time.",
  );
  const job = oneJob(state);
  requireValue(
    identifier(job.id) &&
      job.prompt === phrase &&
      job.deliver === `telegram:${authorization.target}` &&
      job.schedule?.kind === "once" &&
      time(job.schedule.run_at) === time(authorization.scheduledFor) &&
      job.repeat?.times === 1 &&
      job.repeat.completed === 0 &&
      job.enabled === true &&
      job.state === "scheduled" &&
      time(job.next_run_at) === time(authorization.scheduledFor) &&
      time(job.created_at) < time(authorization.scheduledFor) &&
      job.last_run_at === null &&
      job.last_status === null &&
      job.last_error === null &&
      job.last_delivery_error === null &&
      job.last_delivery_unverified === null &&
      !job.run_claim &&
      !job.fire_claim &&
      job.provider_snapshot === "custom" &&
      job.model_snapshot === model &&
      job.provider === null &&
      job.model === null &&
      job.base_url === null &&
      job.no_agent === false &&
      job.script === null &&
      job.monitor_script === null &&
      job.monitor_url === null &&
      job.context_from === null &&
      job.skills?.length === 0 &&
      job.skill === null &&
      job.origin === null &&
      job.workdir === null &&
      job.attach_to_session === false &&
      !job.failure_deliver &&
      sha256(job.enabled_toolsets) === sha256(["cronjob", "no_mcp"]),
    "The native Hermes schedule is not a fresh, bounded, authorized reminder.",
  );
  requireValue(
    state.executions?.status === "retained" && state.executions.executions?.length === 0,
    "A fresh native schedule cannot have an earlier execution.",
  );
  noQueue(state);
  return { job, scheduleId: job.id, specificationSha256: sha256(specification(job)) };
}

export function projectHermesComparisonDelivery({ created, state, receipts, authorization, model, gatewayIdentity }) {
  const original = projectHermesComparisonSchedule({ state: created, authorization, model });
  const job = oneJob(state);
  requireValue(
    sha256(specification(job)) === original.specificationSha256,
    "The native Hermes schedule definition changed.",
  );
  requireValue(
    job.enabled === false &&
      job.state === "completed" &&
      job.repeat?.times === 1 &&
      job.repeat.completed === 1 &&
      job.next_run_at === null &&
      job.last_status === "ok" &&
      job.last_error === null &&
      job.last_delivery_error === null &&
      job.last_delivery_unverified === null &&
      !job.last_delivery_queued &&
      !job.last_fire_error &&
      !job.run_claim &&
      !job.fire_claim,
    "The native Hermes schedule has not settled a verified one-shot delivery.",
  );
  noQueue(state);
  requireValue(
    state.executions?.status === "retained" && state.executions.executions?.length === 1,
    "Retain exactly one complete native scheduled execution.",
  );
  const execution = state.executions.executions[0];
  requireValue(
    identifier(execution.id) &&
      identifier(execution.process_id) &&
      execution.job_id === job.id &&
      execution.source === "builtin" &&
      execution.status === "completed" &&
      execution.delivery_outcome === "delivered" &&
      execution.error === null &&
      execution.handoff_pending === 0 &&
      execution.handoff_started_at === null &&
      execution.pid === gatewayIdentity?.pid &&
      execution.process_started_at === gatewayIdentity?.start_time &&
      Number.isSafeInteger(execution.pid) &&
      execution.pid > 0 &&
      Number.isSafeInteger(execution.process_started_at) &&
      time(execution.scheduled_instant) === time(authorization.scheduledFor) &&
      time(execution.claimed_at) >= time(authorization.scheduledFor) &&
      time(execution.started_at) >= time(execution.claimed_at) &&
      time(execution.finished_at) >= time(execution.started_at),
    "The native execution lacks the exact scheduled occurrence and owned process.",
  );
  requireValue(
    Array.isArray(receipts) && receipts.length === 1,
    "Retain exactly one independently observed Telegram acknowledgement.",
  );
  const receipt = receipts[0],
    dispatch = receipt.nativeDispatch,
    activeJob = oneJob(dispatch);
  requireValue(
    sha256(specification(activeJob)) === original.specificationSha256 &&
      activeJob.enabled === true &&
      activeJob.state === "scheduled" &&
      activeJob.repeat?.times === 1 &&
      activeJob.repeat.completed === 1 &&
      typeof activeJob.run_claim?.by === "string" &&
      activeJob.run_claim.by.endsWith(`:${execution.pid}`) &&
      typeof activeJob.fire_claim?.by === "string" &&
      activeJob.fire_claim.by.startsWith(`${activeJob.run_claim.by}:`) &&
      /^[a-f0-9]{32}$/u.test(activeJob.fire_claim.by.slice(activeJob.run_claim.by.length + 1)) &&
      time(activeJob.run_claim.at) >= time(authorization.scheduledFor) &&
      time(activeJob.fire_claim.at) >= time(execution.started_at) &&
      time(activeJob.fire_claim.at) <= time(receipt.acknowledgedAt),
    "The provider receipt lacks the active native fire claim.",
  );
  noQueue(dispatch);
  requireValue(
    dispatch.executions?.status === "retained" && dispatch.executions.executions?.length === 1,
    "Retain the one active execution before Telegram acknowledgement.",
  );
  const active = dispatch.executions.executions[0];
  const identity = [
    "id",
    "job_id",
    "source",
    "process_id",
    "pid",
    "process_started_at",
    "claimed_at",
    "started_at",
    "scheduled_instant",
    "handoff_pending",
    "handoff_started_at",
  ];
  requireValue(
    identity.every((key) => active[key] === execution[key]) &&
      active.status === "running" &&
      active.finished_at === null &&
      active.error === null &&
      active.delivery_outcome === null,
    "The Telegram acknowledgement belongs to a different native execution.",
  );
  requireValue(
    receipt.fixtureOnly === true &&
      identifier(receipt.providerMessageId) &&
      receipt.accountId === authorization.accountId &&
      receipt.destination === `telegram:${authorization.target}` &&
      receipt.message === phrase &&
      time(receipt.acknowledgedAt) >= time(execution.started_at) &&
      time(receipt.acknowledgedAt) <= time(job.last_run_at) &&
      time(job.last_run_at) <= time(execution.finished_at),
    "The controlled provider acknowledgement does not match the native delivery.",
  );
  return { scheduleId: job.id, executionId: execution.id, providerMessageId: receipt.providerMessageId };
}

/** Read only a fresh controlled runtime. Do not import Hermes's repair or
 * migration owners into an evidence reader. Missing ledgers are explicit. */
export async function readHermesComparisonDeliveryState(stateDirectory) {
  const root = await realpath(stateDirectory);
  requireValue(root === path.resolve(stateDirectory), "Use the canonical Hermes comparison home.");
  const filename = path.join(root, "cron", "jobs.json");
  let conflict;
  for (let attempt = 0; attempt < 5; attempt++) {
    try {
      const jobs = await readBoundedJson(filename);
      const executions = await readRows(path.join(root, "cron", "executions.db"), {
        executions: "SELECT * FROM executions ORDER BY claimed_at,id LIMIT 201",
      });
      const queue = await readRows(path.join(root, "cron", "deliveries.db"), {
        deliveries: "SELECT * FROM deliveries ORDER BY created_at,execution_id LIMIT 201",
        tombstones: "SELECT * FROM delivery_tombstones ORDER BY execution_id LIMIT 201",
      });
      if (JSON.stringify(jobs) === JSON.stringify(await readBoundedJson(filename))) return { jobs, executions, queue };
      conflict = new Error("Native schedule changed during its delivery snapshot.");
    } catch (error) {
      // These are native SQLite contention codes, not corruption or missing
      // schema. Retry the whole observation so owners cannot be mixed.
      if (![5, 6].includes(error.errcode)) throw error;
      conflict = error;
    }
    if (attempt < 4) await delay(20);
  }
  throw new Error("Native Hermes delivery state stayed busy or changed across bounded observations.", {
    cause: conflict,
  });
}

async function ordinaryFile(filename, maxBytes) {
  let info;
  try {
    info = await lstat(filename);
  } catch (error) {
    if (error.code === "ENOENT") return false;
    throw error;
  }
  requireValue(
    info.isFile() && !info.isSymbolicLink() && info.size <= maxBytes,
    "Native delivery evidence must be an ordinary bounded file.",
  );
  requireValue((await realpath(filename)) === path.resolve(filename), "Native evidence paths cannot be linked.");
  return true;
}

async function readBoundedJson(filename) {
  if (!(await ordinaryFile(filename, 1024 * 1024))) return null;
  const bytes = await readFile(filename);
  requireValue(bytes.length <= 1024 * 1024, "Native schedule evidence exceeds its bound.");
  return JSON.parse(bytes.toString("utf8"));
}

async function readRows(filename, queries) {
  if (!(await ordinaryFile(filename, 64 * 1024 * 1024))) return { status: "missing" };
  const database = new DatabaseSync(filename, { readOnly: true });
  try {
    database.exec("PRAGMA query_only=ON; PRAGMA busy_timeout=250; BEGIN");
    const result = { status: "retained" };
    for (const [name, query] of Object.entries(queries)) {
      const rows = database.prepare(query).all();
      requireValue(
        rows.length <= 200 && Buffer.byteLength(JSON.stringify(rows)) <= 1024 * 1024,
        "Native delivery ledger inventory is incomplete or exceeds its bound.",
      );
      result[name] = rows;
    }
    return result;
  } finally {
    database.close();
  }
}
