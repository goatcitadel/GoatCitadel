import { createHash } from "node:crypto";
import {
  canonicalJsonString,
  ConflictError,
  NotFoundError,
  redactSecretText,
  type CronJobRecord,
  type FollowThroughSetupInput,
  type FollowThroughSetupResponse,
} from "@goatcitadel/contracts";
import { normalizeAgentTurnCronActionConfig } from "./gateway/cron-agent-turn-support.js";
import { normalizeCronSchedule, type CronAutomationService } from "./gateway/cron-automation-service.js";
type Scope = { workspaceId: string; sessionId: string; actorId?: string };
export interface FollowThroughSetupSource extends Omit<FollowThroughSetupResponse, "version" | "sourceHash"> {
  sessionIncarnationId: string;
  active: boolean;
  privateOperator: boolean;
  enabled: boolean;
  citadelId?: string;
  conversationContextHash?: string;
}
export interface FollowThroughSetupDeps {
  readSource(input: Scope): Promise<FollowThroughSetupSource>;
  getJob(id: string): Promise<CronJobRecord | undefined>;
  createJob: CronAutomationService["createCronJob"];
  now?: () => Date;
}
const hash = (value: unknown) => createHash("sha256").update(canonicalJsonString(value)).digest("hex");
export class FollowThroughSetupService {
  public constructor(private readonly deps: FollowThroughSetupDeps) {}
  public async inspect(input: Scope): Promise<FollowThroughSetupResponse> {
    return this.project(input, await this.source(input));
  }
  public async create(input: FollowThroughSetupInput & { actorId?: string }): Promise<CronJobRecord> {
    const source = await this.source(input),
      review = this.project(input, source);
    if (
      review.sourceHash !== input.expectedSetupHash ||
      review.blockedReasons.length ||
      !input.actorId ||
      !source.citadelId ||
      !review.profiles.some((profile) => profile.profileId === input.permissionProfileId)
    )
      throw new ConflictError({
        message: "Setup, access or limits changed. Refresh and review the current schedule before creating it.",
      });
    if (!/^[A-Za-z0-9_-]{16,100}$/u.test(input.operationId) || !input.purpose.trim() || input.purpose.length > 2000)
      throw new ConflictError({ message: "Choose an exact scheduled purpose." });
    const channelId = input.delivery.kind === "channel" ? input.delivery.connectionId : undefined;
    const channel = review.channelDestinations?.find((item) => item.connectionId === channelId);
    if (input.delivery.kind === "channel" && !channel)
      throw new ConflictError({ message: "Refresh and review a current delivery destination in this workspace." });
    const purpose = input.purpose.normalize("NFKC").trim(),
      redacted = redactSecretText(purpose, { env: process.env });
    if (redacted.redactionCount > 0)
      throw new ConflictError({
        message: "Keep credentials in their setup owner; remove secret values from the scheduled purpose.",
      });
    const now = this.deps.now?.() ?? new Date(),
      trigger = input.trigger;
    if (
      trigger.kind === "once" &&
      (!Number.isFinite(Date.parse(trigger.at)) || Date.parse(trigger.at) <= now.getTime())
    )
      throw new ConflictError({ message: "Choose a future one-shot time and review it again." });
    if (
      trigger.kind === "event" &&
      (!review.eventSources.some((hook) => hook.hookId === trigger.hookId) ||
        !Number.isFinite(Date.parse(trigger.notBefore)) ||
        Math.abs(Date.parse(trigger.notBefore) - now.getTime()) > 5 * 60_000)
    )
      throw new ConflictError({
        message: "Refresh the event start and choose a current verified observer before reviewing it.",
      });
    if (trigger.kind === "event" && source.quietHours && trigger.timezone !== source.quietHours.timezone)
      throw new ConflictError({
        message: "The conversation's quiet-hour timezone changed. Refresh and review its active hours.",
      });
    const actionConfig = normalizeAgentTurnCronActionConfig({
      agentTurn: {
        sessionId: input.sessionId,
        workspaceId: input.workspaceId,
        prompt: purpose,
        deliverMode: channel ? "always" : "on_notify",
        ...(channel
          ? {
              deliveryChannel: {
                connectionId: channel.connectionId,
                connectionRevision: channel.revision,
                channelKey: channel.channelKey,
                target: channel.target,
              },
            }
          : {}),
        createdBy: {
          operatorId: input.actorId,
          authActorId: input.actorId,
          permissionProfileId: input.permissionProfileId,
          permissionProfileRevision: review.profiles.find((profile) => profile.profileId === input.permissionProfileId)!
            .revision,
          depth: 0,
        },
        ...(trigger.kind === "once"
          ? { oneShot: { at: trigger.at, timezone: trigger.timezone } }
          : trigger.kind === "event"
            ? {
                eventWake: {
                  version: 1,
                  eventType: "subagent.end",
                  hookId: trigger.hookId,
                  workspaceId: input.workspaceId,
                  sourceSessionId: input.sessionId,
                  notBefore: trigger.notBefore,
                  timezone: trigger.timezone,
                },
              }
            : {}),
      },
    });
    const spec = {
      jobId: `follow-${hash({ workspaceId: input.workspaceId, sessionId: input.sessionId, actorId: input.actorId, operationId: input.operationId }).slice(0, 40)}`,
      name: purpose.replace(/\s+/gu, " ").slice(0, 96),
      description: purpose,
      action: "agent_turn" as const,
      actionConfig,
      schedule:
        trigger.kind === "recurring" ? normalizeCronSchedule(trigger.schedule) : `0 0 * * * ${trigger.timezone}`,
      enabled: true,
      citadelId: source.citadelId,
    };
    const expected = hash(spec),
      assertReplay = (job: CronJobRecord) => {
        if (
          hash({
            jobId: job.jobId,
            name: job.name,
            description: job.description,
            action: job.action,
            actionConfig: job.actionConfig,
            schedule: job.schedule,
            enabled: job.enabled,
            citadelId: job.citadelId,
          }) !== expected
        )
          throw new ConflictError({
            message:
              "This creation identity already belongs to different schedule material. Inspect the existing schedule.",
          });
        return job;
      };
    const existing = await this.deps.getJob(spec.jobId);
    if (existing) return assertReplay(existing);
    try {
      return assertReplay(
        await this.deps.createJob(spec, { actorId: input.actorId, source: "authenticated_operator" }),
      );
    } catch (error) {
      const raced = await this.deps.getJob(spec.jobId);
      if (raced) return assertReplay(raced);
      throw error;
    }
  }
  private async source(input: Scope) {
    const source = await this.deps.readSource(input);
    if (
      source.workspaceId !== input.workspaceId ||
      source.sessionId !== input.sessionId ||
      !source.active ||
      !source.privateOperator
    )
      throw new NotFoundError({ entity: "Chat schedule setup", id: input.sessionId });
    return source;
  }
  private project(input: Scope, source: FollowThroughSetupSource): FollowThroughSetupResponse {
    const blockedReasons = [
      ...source.blockedReasons,
      ...(!input.actorId ? ["Sign in as a Gateway operator before creating agentic schedules."] : []),
      ...(!source.enabled ? ["Scheduled Chat work is turned off. Review its installation setup first."] : []),
      ...(!source.citadelId ? ["This workspace has no active citadel binding."] : []),
    ];
    return {
      version: 1,
      workspaceId: source.workspaceId,
      sessionId: source.sessionId,
      configRevision: source.configRevision,
      profiles: source.profiles,
      eventSources: source.eventSources,
      channelDestinations: source.channelDestinations ?? [],
      limits: source.limits,
      quietHours: source.quietHours,
      blockedReasons,
      sourceHash: hash({ source, actorId: input.actorId ?? null }),
    };
  }
}
