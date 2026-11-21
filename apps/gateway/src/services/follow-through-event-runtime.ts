import { createHash } from "node:crypto";
import {
  canonicalJsonString,
  NotFoundError,
  readDurableChatTurnExecutionPayloadAuthority,
  type CronJobRecord,
  type HookRunRecord,
} from "@goatcitadel/contracts";
import { DEFAULT_SESSION_AUTONOMY_PREFS, type AsyncStorage } from "@goatcitadel/storage";
import { FollowThroughEventWakeService } from "./follow-through-event-wake-service.js";
import { isWithinActiveHours } from "./gateway/commitment-sweep-service.js";
import type { CronAutomationService } from "./gateway/cron-automation-service.js";
const hash = (value: unknown) => createHash("sha256").update(canonicalJsonString(value)).digest("hex");
export const followThroughEventCursorKey = (job: CronJobRecord) =>
  `follow_through_event_cursor_v1:${job.jobId}:${hash(job.actionConfig?.agentTurn?.eventWake ?? null)}`;
type Cursor = {
  version: 1;
  after: { completedAt: string; runId: string };
  lastDisposition: string;
  lastReason?: string;
  runId?: string;
};
type Runtime = {
  storage: AsyncStorage;
  cron: Pick<CronAutomationService, "runCronJobNow">;
  isEnabled: () => Promise<boolean>;
  now?: () => Date;
};
export async function validateFollowThroughEventSource(
  storage: Pick<
    AsyncStorage,
    | "workspaceHooks"
    | "chatSessionMeta"
    | "sessions"
    | "chatDelegationRuns"
    | "chatDelegationSteps"
    | "durableRuns"
    | "chatTurnTraces"
    | "chatMessages"
  >,
  job: CronJobRecord,
  event: HookRunRecord,
): Promise<boolean> {
  const config = job.actionConfig?.agentTurn?.eventWake,
    payload = event.requestPayload;
  if (
    !config ||
    !payload ||
    payload.parentSessionId !== config.sourceSessionId ||
    typeof payload.delegationRunId !== "string" ||
    typeof payload.stepId !== "string" ||
    typeof payload.childSessionId !== "string" ||
    payload.status !== "completed"
  )
    return false;
  try {
    const [hook, meta, session, delegation, step] = await Promise.all([
      storage.workspaceHooks.get(config.workspaceId, config.hookId),
      storage.chatSessionMeta.get(config.sourceSessionId),
      storage.sessions.getBySessionId(config.sourceSessionId),
      storage.chatDelegationRuns.get(payload.delegationRunId),
      storage.chatDelegationSteps.get(payload.stepId),
    ]);
    if (
      !hook.enabled ||
      hook.trigger !== "subagent.end" ||
      hook.mode !== "observe" ||
      meta?.workspaceId !== config.workspaceId ||
      meta.lifecycleStatus !== "active" ||
      meta.origin !== "operator" ||
      session.kind !== "dm" ||
      delegation.sessionId !== config.sourceSessionId ||
      !delegation.parentRunId ||
      step.runId !== delegation.runId ||
      step.status !== "completed" ||
      !step.finishedAt ||
      step.childSessionId !== payload.childSessionId ||
      event.entityId !== step.childSessionId
    )
      return false;
    const parent = await storage.durableRuns.getRun(delegation.parentRunId),
      authority = readDurableChatTurnExecutionPayloadAuthority({
        workflowKey: parent.workflowKey,
        durableRunId: parent.runId,
        payload: parent.payload,
      });
    if (
      !authority ||
      authority.workspaceId !== config.workspaceId ||
      authority.sessionId !== config.sourceSessionId ||
      authority.sessionIncarnationId !== meta.lifecycleIntentId ||
      authority.requestActor.actorKind !== "operator" ||
      (authority.requestActor.authActorId ?? authority.requestActor.actorId) !== job.creatorAuthority?.actorId
    )
      return false;
    const trace = await storage.chatTurnTraces.get(authority.turnId),
      message = await storage.chatMessages.get(trace.userMessageId);
    return (
      trace.sessionId === config.sourceSessionId &&
      !trace.parentTurnId &&
      message?.sessionId === config.sourceSessionId &&
      message.role === "user" &&
      message.actorType === "user" &&
      message.sourceAuthority === "operator"
    );
  } catch (error) {
    if (error instanceof NotFoundError) return false;
    throw error;
  }
}
/** Runs inside the existing maintenance cadence. Only bookmarks are added;
 * execution, claims, restart and delivery stay with cron/durable owners. */
export async function runFollowThroughEventSweep(runtime: Runtime) {
  const { storage } = runtime,
    now = runtime.now?.() ?? new Date();
  const pageKey = "follow_through_event_sweep_page_v1",
    page = await storage.systemSettings.get<{ lastJobId: string }>(pageKey);
  let candidates = await storage.cronJobs.listEventJobs({ afterJobId: page?.value.lastJobId ?? "", limit: 21 });
  if (!candidates.length && page?.value.lastJobId) candidates = await storage.cronJobs.listEventJobs({ limit: 21 });
  const jobs = candidates.slice(0, 20),
    summary = { scanned: 0, queued: 0, duplicates: 0, blocked: 0, truncated: candidates.length > jobs.length };
  const service = new FollowThroughEventWakeService({
    readJob: (id) => storage.cronJobs.get(id),
    readEvent: async (id) => {
      try {
        return await storage.hookRuns.get(id);
      } catch (error) {
        if (error instanceof NotFoundError) return undefined;
        throw error;
      }
    },
    validateCanonicalSource: (job, event) => validateFollowThroughEventSource(storage, job, event),
    isEnabled: runtime.isEnabled,
    isQuiet: async (job) => {
      const prefs = await storage.sessionAutonomyPrefs.get(job.actionConfig!.agentTurn!.eventWake!.sourceSessionId),
        window = prefs?.activeHours ?? DEFAULT_SESSION_AUTONOMY_PREFS.activeHours;
      return !isWithinActiveHours(now, { startHour: window.start, endHour: window.end, tz: window.tz });
    },
    readAdmission: (jobId, key) => storage.cronRuns.getByAdmission(jobId, key),
    runCronJobNow: (id, options) => runtime.cron.runCronJobNow(id, options),
  });
  let remaining = 20;
  let lastProcessedJobId = "";
  for (const job of jobs) {
    if (remaining <= 0) {
      summary.truncated = true;
      break;
    }
    lastProcessedJobId = job.jobId;
    const config = job.actionConfig!.agentTurn!.eventWake!,
      key = followThroughEventCursorKey(job);
    let cursor = await storage.systemSettings.get<Cursor>(key);
    if (
      cursor &&
      (cursor.value.version !== 1 ||
        !cursor.value.after ||
        !Number.isFinite(Date.parse(cursor.value.after.completedAt)) ||
        !cursor.value.after.runId)
    ) {
      summary.blocked++;
      continue;
    }
    const events = await storage.hookRuns.listCompletedForFollowThrough({
      workspaceId: config.workspaceId,
      hookId: config.hookId,
      notBefore: config.notBefore,
      after: cursor?.value.after,
      limit: Math.min(20, remaining),
    });
    for (const event of events) {
      remaining--;
      summary.scanned++;
      const result = await service.wakeFollowThroughJob({
        jobId: job.jobId,
        expectedRevision: job.revision,
        eventId: event.runId,
        eventType: "subagent.end",
        workspaceId: config.workspaceId,
        sourceConnectionId: config.hookId,
        payloadHash: hash(event.requestPayload),
      });
      if (result.disposition === "blocked") summary.blocked++;
      else if (result.disposition === "duplicate") summary.duplicates++;
      else summary.queued++;
      if (result.retryable) break;
      const next = await storage.systemSettings.compareAndSet(key, cursor, {
        version: 1,
        after: { completedAt: event.completedAt!, runId: event.runId },
        lastDisposition: result.disposition,
        lastReason: result.reason,
        runId: result.runId,
      } satisfies Cursor);
      if (!next) break;
      cursor = next;
      // One admitted occurrence per job per sweep. The canonical active-run fence
      // prevents backlog bursts while approvals or delivery are unresolved.
      if (result.disposition === "queued") break;
    }
  }
  if (jobs.length && (summary.truncated || page?.value.lastJobId))
    await storage.systemSettings.compareAndSet(pageKey, page, {
      lastJobId: summary.truncated ? lastProcessedJobId : "",
    });
  return summary;
}
