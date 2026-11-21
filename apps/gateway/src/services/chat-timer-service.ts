import { createHash, randomUUID } from "node:crypto";
import {
  CHAT_TIMER_MAX_ACTIVE_PER_SESSION,
  CHAT_TIMER_MAX_ACTIVE_PER_WORKSPACE,
  CHAT_TIMER_MAX_HORIZON_MS,
  CHAT_TIMER_MIN_DELAY_MS,
  ConflictError,
  NotFoundError,
  ValidationError,
  zonedDateTimeToIso,
  type ChatReminderPreview,
  type ToolInvokeRequest,
  type ChatMessageRecord,
  type ChatTimerDeliveryStatus,
  type ChatTimerRecord,
  type CreateChatTimerInput,
  type NotificationDispatchResult,
  type RealtimeEvent,
} from "@goatcitadel/contracts";
import type { AsyncStorage as Storage } from "@goatcitadel/storage";

import { buildCodeModeRequestTurnShape, isCodeModeRequestTurnShapeEligible } from "./code-mode-request-eligibility.js";

const TIMER_MESSAGE_MAX_CHARS = 4_000;
const TIMER_CLAIM_LEASE_MS = 30_000;

export interface ChatTimerServiceDependencies {
  storage: Storage;
  ownerId: string;
  normalizeWorkspaceId(workspaceId?: string): string;
  dispatchNotificationEvent(
    workspaceId: string,
    input: {
      eventId: string;
      eventType: "timer.due";
      sessionId: string;
      title: string;
      message: string;
      source: "chat.timer";
      ruleId?: string;
    },
  ): Promise<NotificationDispatchResult>;
  publishRealtime(
    eventType: string,
    source: string,
    payload: Record<string, unknown>,
    options?: Pick<RealtimeEvent, "eventClass" | "eventAuthority" | "links">,
  ): Promise<unknown>;
}

export class ChatTimerService {
  public constructor(private readonly deps: ChatTimerServiceDependencies) {}

  public async preview(request: ToolInvokeRequest): Promise<ChatReminderPreview> {
    const { sessionId, turnId, args } = request;
    if (!turnId || request.surface !== "chat") throw invalid("Review a reminder from an interactive Chat turn.");
    const workspaceId = await this.requireSession(sessionId);
    const trace = await this.deps.storage.chatTurnTraces.get(turnId);
    if (request.workspaceId !== workspaceId || trace.sessionId !== sessionId)
      throw invalid("Reminder Chat scope changed.");
    const message = await this.deps.storage.chatMessages.get(trace.userMessageId);
    const interactive = isCodeModeRequestTurnShapeEligible(
      buildCodeModeRequestTurnShape({
        mode: trace.mode,
        parentDelegationStepId: message?.parentDelegationStepId,
        permissionProfileId: request.permissionProfileId ?? request.policyContext?.permissionProfileId,
        policyContext: request.policyContext,
      }),
    );
    if (
      !interactive ||
      message?.sessionId !== sessionId ||
      message.sourceAuthority !== "operator" ||
      message.role !== "user"
    ) {
      throw invalid("Review a reminder from an interactive Chat turn.");
    }
    if (
      Object.keys(args).some((key) => !["localDueAt", "timezone", "message"].includes(key)) ||
      typeof args.localDueAt !== "string" ||
      !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/u.test(args.localDueAt) ||
      typeof args.timezone !== "string" ||
      !args.timezone.trim() ||
      args.timezone.length > 128 ||
      (args.message !== undefined &&
        (typeof args.message !== "string" || args.message.length > TIMER_MESSAGE_MAX_CHARS))
    ) {
      throw invalid("Choose a local date and time, timezone, and an optional reminder message.");
    }
    const timezone = args.timezone.trim();
    const dueAt = zonedDateTimeToIso(args.localDueAt, timezone);
    validateDueAt(dueAt, await this.timerClock());
    return {
      localDueAt: args.localDueAt,
      timezone,
      message: typeof args.message === "string" ? args.message.trim() : "",
    };
  }

  public async list(sessionId: string): Promise<ChatTimerRecord[]> {
    await this.requireSession(sessionId);
    return await this.deps.storage.chatTimers.listBySession(sessionId);
  }

  public async create(
    sessionId: string,
    input: CreateChatTimerInput,
    createdBy: string,
    attempt?: { key: string; replayOnly: boolean },
  ): Promise<ChatTimerRecord> {
    const workspaceId = await this.requireSession(sessionId);
    const actor = createdBy.trim() || "operator";
    const timerId = attempt
      ? createHash("sha256")
          .update(JSON.stringify(["chat-timer", workspaceId, sessionId, actor, attempt.key]))
          .digest("hex")
      : randomUUID();
    if (attempt) {
      // A transport retry can arrive after the countdown fired or its destination changed.
      // Recover the original receipt before applying new-timer readiness or time bounds.
      try {
        const saved = await this.requireScopedTimer(timerId, sessionId, workspaceId);
        if (
          saved.createdBy !== actor ||
          Date.parse(saved.dueAt) !== Date.parse(input.dueAt) ||
          saved.timezone !== input.timezone.trim() ||
          saved.message !== input.message.trim() ||
          saved.notificationRuleId !==
            (input.notificationRuleId === null ? null : input.notificationRuleId?.trim() || undefined) ||
          saved.cancelOnNextReply !== Boolean(input.cancelOnNextReply)
        ) {
          throw new ConflictError({ message: "The saved timer differs from this confirmation." });
        }
        return saved;
      } catch (error) {
        if (!(error instanceof NotFoundError) || attempt.replayOnly) throw error;
      }
    }
    const normalized = validateCreateInput(input, await this.timerClock());
    if (normalized.notificationRuleId) {
      const rule = await this.deps.storage.notificationRouting.getRule(normalized.notificationRuleId);
      const activeTargets = (await this.deps.storage.notificationRouting.listTargets(workspaceId)).filter(
        (target) => target.lifecycleState === "active",
      );
      if (
        rule.workspaceId !== workspaceId ||
        rule.lifecycleState !== "active" ||
        !rule.eventTypes.includes("timer.due") ||
        !rule.targetIds.length ||
        !rule.targetIds.every((id) => activeTargets.some((target) => target.targetId === id))
      ) {
        throw new NotFoundError({ entity: "Notification rule", id: normalized.notificationRuleId });
      }
    }
    if ((await this.deps.storage.chatTimers.countActiveBySession(sessionId)) >= CHAT_TIMER_MAX_ACTIVE_PER_SESSION) {
      throw invalid("This Chat already has the maximum of 25 active timers.");
    }
    if (
      (await this.deps.storage.chatTimers.countActiveByWorkspace(workspaceId)) >= CHAT_TIMER_MAX_ACTIVE_PER_WORKSPACE
    ) {
      throw invalid("This workspace already has the maximum of 100 active timers.");
    }
    const timer = await this.deps.storage.chatTimers.create({
      timerId,
      workspaceId,
      sessionId,
      dueAt: normalized.dueAt,
      timezone: normalized.timezone,
      message: normalized.message,
      notificationRuleId: normalized.notificationRuleId,
      cancelOnNextReply: normalized.cancelOnNextReply ?? false,
      createdBy: actor,
    });
    try {
      await this.publishChanged(timer, "chat_timer_created");
    } catch (cause) {
      throw Object.assign(new Error("Timer saved. Refresh session timers to see it.", { cause }), {
        mutationCommitted: true,
      });
    }
    return timer;
  }

  public async cancel(sessionId: string, timerId: string, expectedRevision: number): Promise<ChatTimerRecord> {
    const workspaceId = await this.requireSession(sessionId);
    const timer = await this.requireScopedTimer(timerId, sessionId, workspaceId);
    const cancelled = await this.deps.storage.chatTimers.cancel(timer.timerId, expectedRevision);
    await this.publishChanged(cancelled, "chat_timer_cancelled");
    return cancelled;
  }

  public async cancelOnCommittedReply(sessionId: string, messageId: string): Promise<number> {
    await this.requireSession(sessionId);
    const count = await this.deps.storage.chatTimers.cancelOnNextReply(sessionId, messageId);
    if (count > 0) {
      await this.publishTimerSignal(
        "chat_timer_changed",
        { type: "chat_timers_cancelled_on_reply", sessionId, messageId, count },
        { sessionId },
      );
    }
    return count;
  }

  public async runDue(limit = 25): Promise<{ claimed: number; fired: number; failed: number }> {
    const timers = await this.deps.storage.chatTimers.claimDue(this.deps.ownerId, limit, TIMER_CLAIM_LEASE_MS);
    let fired = 0;
    let failed = 0;
    for (const timer of timers) {
      try {
        await this.fireClaimedTimer(timer);
        fired += 1;
      } catch (error) {
        failed += 1;
        const message = sanitizeFailure(error);
        try {
          const settled = await this.deps.storage.chatTimers.markFailed(timer.timerId, this.deps.ownerId, message);
          await this.publishChanged(settled, "chat_timer_failed");
        } catch (settlementError) {
          void settlementError;
          // A lost claim is canonical repository truth; another worker owns settlement.
        }
      }
    }
    return { claimed: timers.length, fired, failed };
  }

  private async fireClaimedTimer(timer: ChatTimerRecord): Promise<void> {
    const noticeMessageId = `timer-notice-${timer.timerId}`;
    const eventId = `timer-due-${timer.timerId}`;
    const now = await this.timerClock();
    const notice: ChatMessageRecord = {
      messageId: noticeMessageId,
      sessionId: timer.sessionId,
      role: "assistant",
      actorType: "system",
      actorId: "chat-timer",
      sourceAuthority: "trusted_lifecycle",
      content: timer.message,
      timestamp: now,
    };
    await this.deps.storage.chatMessages.upsert(notice, now);

    const event = {
      eventId,
      eventType: "timer.due" as const,
      sessionId: timer.sessionId,
      title: "Chat timer due",
      message: timer.message,
      source: "chat.timer" as const,
    };
    const retainEvent = () =>
      this.deps.storage.notificationRouting.createEvent({ ...event, workspaceId: timer.workspaceId, createdAt: now });
    const deliveryStatus: ChatTimerDeliveryStatus = await (async () => {
      if (timer.notificationRuleId === null) {
        await retainEvent();
        return "no_targets";
      }
      try {
        const result = await this.deps.dispatchNotificationEvent(timer.workspaceId, {
          ...event,
          ...(timer.notificationRuleId ? { ruleId: timer.notificationRuleId } : {}),
        });
        return result.status;
      } catch {
        // Preserve the canonical attention event even when the delivery worker
        // fails before it can settle a target. createEvent is idempotent by id.
        await retainEvent();
        return "failed";
      }
    })();

    const fired = await this.deps.storage.chatTimers.markFired(timer.timerId, this.deps.ownerId, {
      noticeMessageId,
      notificationEventId: eventId,
      notificationDeliveryStatus: deliveryStatus,
    });
    await this.publishChanged(fired, "chat_timer_fired");
    await this.publishTimerSignal(
      "chat_thread_updated",
      { type: "chat_timer_due", sessionId: timer.sessionId, timerId: timer.timerId, noticeMessageId },
      { workspaceId: timer.workspaceId, sessionId: timer.sessionId },
    );
  }

  private timerClock(): Promise<string> {
    return this.deps.storage.chatTimers.databaseNow();
  }

  private async requireSession(sessionId: string): Promise<string> {
    const session = await this.deps.storage.chatSessionMeta.get(sessionId);
    if (!session) throw new NotFoundError({ entity: "Chat session", id: sessionId });
    return this.deps.normalizeWorkspaceId(session.workspaceId);
  }

  private async requireScopedTimer(timerId: string, sessionId: string, workspaceId: string): Promise<ChatTimerRecord> {
    const timer = await this.deps.storage.chatTimers.get(timerId);
    if (timer.sessionId !== sessionId || timer.workspaceId !== workspaceId) {
      throw new NotFoundError({ entity: "Chat timer", id: timerId });
    }
    return timer;
  }

  private async publishChanged(timer: ChatTimerRecord, type: string): Promise<void> {
    await this.publishTimerSignal(
      "chat_timer_changed",
      { type, timerId: timer.timerId, sessionId: timer.sessionId, status: timer.status, revision: timer.revision },
      { workspaceId: timer.workspaceId, sessionId: timer.sessionId },
    );
  }

  private async publishTimerSignal(
    eventType: "chat_timer_changed" | "chat_thread_updated",
    payload: Record<string, unknown>,
    links: { sessionId: string; workspaceId?: string },
  ): Promise<void> {
    await this.deps.publishRealtime(eventType, "chat.timer", payload, {
      eventClass: "operational_signal",
      eventAuthority: "retained_stream",
      links,
    });
  }
}

function validateCreateInput(
  input: CreateChatTimerInput,
  nowIso: string,
): CreateChatTimerInput & { cancelOnNextReply: boolean } {
  const dueMs = validateDueAt(input.dueAt, nowIso);
  const timezone = input.timezone.trim();
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: timezone });
  } catch {
    throw invalid("Timer timezone must be a valid IANA timezone.");
  }
  const message = input.message.trim();
  if (!message || message.length > TIMER_MESSAGE_MAX_CHARS) {
    throw invalid(`Timer message must contain 1-${TIMER_MESSAGE_MAX_CHARS} characters.`);
  }
  return {
    dueAt: new Date(dueMs).toISOString(),
    timezone,
    message,
    notificationRuleId: input.notificationRuleId === null ? null : input.notificationRuleId?.trim() || undefined,
    cancelOnNextReply: input.cancelOnNextReply === true,
  };
}

function validateDueAt(dueAt: string, nowIso: string): number {
  const dueMs = Date.parse(dueAt);
  const delay = dueMs - Date.parse(nowIso);
  if (!Number.isFinite(dueMs)) throw invalid("Timer dueAt must be a valid ISO timestamp.");
  if (delay < CHAT_TIMER_MIN_DELAY_MS) throw invalid("Timer delay must be at least 5 seconds.");
  if (delay > CHAT_TIMER_MAX_HORIZON_MS) throw invalid("Timer horizon cannot exceed one year.");
  return dueMs;
}

function invalid(message: string): ValidationError {
  return new ValidationError({ code: "FIELD_INVALID", message });
}

function sanitizeFailure(error: unknown): string {
  return (error instanceof Error ? error.message : "Timer firing failed.")
    .replace(/https?:\/\/\S+/giu, "[REDACTED_URL]")
    .slice(0, 1_000);
}
