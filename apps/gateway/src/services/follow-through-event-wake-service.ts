import { createHash } from "node:crypto";
import {
  canonicalJsonString,
  hasCurrentCronCreatorAuthority,
  type CronEventSource,
  type CronJobRecord,
  type CronRunRecord,
  type HookRunRecord,
} from "@goatcitadel/contracts";
import type { CronRunOptions, CronRunResult } from "./gateway/cron-automation-service.js";
export interface FollowThroughEventWakeInput extends CronEventSource {
  jobId: string;
  expectedRevision: number;
}
export interface FollowThroughEventWakeResult {
  runId?: string;
  disposition: "queued" | "duplicate" | "blocked";
  reason?: string;
  retryable?: boolean;
}
export interface FollowThroughEventWakeDeps {
  readJob(jobId: string): Promise<CronJobRecord | undefined>;
  readEvent(eventId: string): Promise<HookRunRecord | undefined>;
  /** Checks the persisted hook registration, canonical delegation/step, root user turn and current private scope. */
  validateCanonicalSource(job: CronJobRecord, event: HookRunRecord): Promise<boolean>;
  isEnabled(): Promise<boolean>;
  isQuiet(job: CronJobRecord): Promise<boolean>;
  readAdmission(jobId: string, admissionKey: string): Promise<CronRunRecord | undefined>;
  runCronJobNow(jobId: string, options: CronRunOptions): Promise<CronRunResult>;
}
const payloadHash = (payload: unknown) => createHash("sha256").update(canonicalJsonString(payload)).digest("hex");
const blocked = (reason: string, retryable = false): FollowThroughEventWakeResult => ({
  disposition: "blocked",
  reason,
  retryable,
});
/** Internal adapter only. Events can wake a reviewed job; they cannot choose its prompt, policy, grants or delivery. */
export class FollowThroughEventWakeService {
  public constructor(private readonly deps: FollowThroughEventWakeDeps) {}
  public async wakeFollowThroughJob(input: FollowThroughEventWakeInput): Promise<FollowThroughEventWakeResult> {
    const [job, event] = await Promise.all([this.deps.readJob(input.jobId), this.deps.readEvent(input.eventId)]);
    const config = job?.actionConfig?.agentTurn?.eventWake,
      creator = job?.actionConfig?.agentTurn?.createdBy;
    if (
      !job ||
      job.action !== "agent_turn" ||
      !job.enabled ||
      job.revision !== input.expectedRevision ||
      !config ||
      config.version !== 1 ||
      config.eventType !== input.eventType ||
      config.workspaceId !== input.workspaceId ||
      config.hookId !== input.sourceConnectionId ||
      config.sourceSessionId !== job.actionConfig?.agentTurn?.sessionId ||
      !hasCurrentCronCreatorAuthority(job) ||
      creator?.createdByJobId ||
      (creator?.depth ?? 0) > 0
    )
      return blocked("job_binding_changed");
    if (
      !event ||
      event.runId !== input.eventId ||
      event.hookId !== config.hookId ||
      event.workspaceId !== config.workspaceId ||
      event.trigger !== "subagent.end" ||
      event.mode !== "observe" ||
      event.status !== "completed" ||
      event.entityType !== "chat_subagent" ||
      !event.completedAt ||
      !Number.isFinite(Date.parse(event.completedAt)) ||
      !Number.isFinite(Date.parse(config.notBefore)) ||
      Date.parse(event.createdAt) < Date.parse(config.notBefore) ||
      !/^[a-f0-9]{64}$/u.test(input.payloadHash) ||
      payloadHash(event.requestPayload) !== input.payloadHash
    )
      return blocked("event_binding_changed");
    const eventSource: CronEventSource = {
        eventId: input.eventId,
        eventType: input.eventType,
        workspaceId: input.workspaceId,
        sourceConnectionId: input.sourceConnectionId,
        payloadHash: input.payloadHash,
      },
      admissionKey = `event:${input.eventId}`;
    const previous = await this.deps.readAdmission(job.jobId, admissionKey);
    if (previous)
      return previous.jobRevision === input.expectedRevision &&
        canonicalJsonString(previous.actionSnapshot.eventSource ?? null) === canonicalJsonString(eventSource)
        ? { disposition: "duplicate", runId: previous.runId }
        : blocked("event_identity_reused");
    if (!(await this.deps.validateCanonicalSource(job, event))) return blocked("source_authority_unavailable");
    if (!(await this.deps.isEnabled())) return blocked("autonomy_disabled", true);
    if (await this.deps.isQuiet(job)) return blocked("quiet_hours", true);
    const result = await this.deps.runCronJobNow(job.jobId, {
      expectedRevision: input.expectedRevision,
      reason: "verified_event",
      admissionKey,
      scheduledFor: event.completedAt,
      eventSource,
    });
    const admitted = await this.deps.readAdmission(job.jobId, admissionKey);
    if (!admitted || admitted.runId !== result.runId) return blocked("another_occurrence_active", true);
    if (
      admitted.jobRevision !== input.expectedRevision ||
      canonicalJsonString(admitted.actionSnapshot.eventSource ?? null) !== canonicalJsonString(eventSource)
    )
      return blocked("event_identity_reused");
    return { disposition: "queued", runId: admitted.runId };
  }
}
