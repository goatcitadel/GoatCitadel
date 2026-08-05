import { randomUUID } from "node:crypto";
import {
  CHAT_TIMER_MAX_ACTIVE_PER_SESSION,
  CHAT_TIMER_MAX_ACTIVE_PER_WORKSPACE,
  CHAT_TIMER_MAX_HORIZON_MS,
  CHAT_TIMER_MIN_DELAY_MS,
  NotFoundError,
  ValidationError,
  type ChatMessageRecord,
  type ChatTimerDeliveryStatus,
  type ChatTimerRecord,
  type CreateChatTimerInput,
  type NotificationDispatchResult,
  type RealtimeEvent,
} from "@goatcitadel/contracts";
import type { AsyncStorage as Storage } from "@goatcitadel/storage";

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

  public async list(sessionId: string): Promise<ChatTimerRecord[]> {
    await this.requireSession(sessionId);
    return await this.deps.storage.chatTimers.listBySession(sessionId);
  }

  public async create(sessionId: string, input: CreateChatTimerInput, createdBy: string): Promise<ChatTimerRecord> {
    const workspaceId = await this.requireSession(sessionId);
    const normalized = validateCreateInput(input, await this.deps.storage.chatTimers.databaseNow());
    if (normalized.notificationRuleId) {
      const rule = await this.deps.storage.notificationRouting.getRule(normalized.notificationRuleId);
      if (rule.workspaceId !== workspaceId || rule.lifecycleState !== "active") {
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
      timerId: randomUUID(),
      workspaceId,
      sessionId,
      dueAt: normalized.dueAt,
      timezone: normalized.timezone,
      message: normalized.message,
      ...(normalized.notificationRuleId ? { notificationRuleId: normalized.notificationRuleId } : {}),
      cancelOnNextReply: normalized.cancelOnNextReply ?? false,
      createdBy: createdBy.trim() || "operator",
    });
    await this.publishChanged(timer, "chat_timer_created");
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
      await this.deps.publishRealtime(
        "chat_timer_changed",
        "chat.timer",
        { type: "chat_timers_cancelled_on_reply", sessionId, messageId, count },
        { eventClass: "operational_signal", eventAuthority: "retained_stream", links: { sessionId } },
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
    const now = await this.deps.storage.chatTimers.databaseNow();
    const notice: ChatMessageRecord = {
      messageId: noticeMessageId,
      sessionId: timer.sessionId,
      role: "assistant",
      actorType: "system",
      actorId: "chat-timer",
      content: timer.message,
      timestamp: now,
    };
    await this.deps.storage.chatMessages.upsert(notice, now);

    const deliveryStatus: ChatTimerDeliveryStatus = await (async () => {
      try {
        const result = await this.deps.dispatchNotificationEvent(timer.workspaceId, {
          eventId,
          eventType: "timer.due",
          sessionId: timer.sessionId,
          title: "Chat timer due",
          message: timer.message,
          source: "chat.timer",
          ...(timer.notificationRuleId ? { ruleId: timer.notificationRuleId } : {}),
        });
        return result.status;
      } catch {
        // Preserve the canonical attention event even when the delivery worker
        // fails before it can settle a target. createEvent is idempotent by id.
        await this.deps.storage.notificationRouting.createEvent({
          eventId,
          workspaceId: timer.workspaceId,
          eventType: "timer.due",
          sessionId: timer.sessionId,
          title: "Chat timer due",
          message: timer.message,
          source: "chat.timer",
          createdAt: now,
        });
        return "failed";
      }
    })();

    const fired = await this.deps.storage.chatTimers.markFired(timer.timerId, this.deps.ownerId, {
      noticeMessageId,
      notificationEventId: eventId,
      notificationDeliveryStatus: deliveryStatus,
    });
    await this.publishChanged(fired, "chat_timer_fired");
    await this.deps.publishRealtime(
      "chat_thread_updated",
      "chat.timer",
      { type: "chat_timer_due", sessionId: timer.sessionId, timerId: timer.timerId, noticeMessageId },
      {
        eventClass: "operational_signal",
        eventAuthority: "retained_stream",
        links: { workspaceId: timer.workspaceId, sessionId: timer.sessionId },
      },
    );
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
    await this.deps.publishRealtime(
      "chat_timer_changed",
      "chat.timer",
      { type, timerId: timer.timerId, sessionId: timer.sessionId, status: timer.status, revision: timer.revision },
      {
        eventClass: "operational_signal",
        eventAuthority: "retained_stream",
        links: { workspaceId: timer.workspaceId, sessionId: timer.sessionId },
      },
    );
  }
}

function validateCreateInput(
  input: CreateChatTimerInput,
  nowIso: string,
): CreateChatTimerInput & { cancelOnNextReply: boolean } {
  const dueMs = Date.parse(input.dueAt);
  const nowMs = Date.parse(nowIso);
  if (!Number.isFinite(dueMs)) throw invalid("Timer dueAt must be a valid ISO timestamp.");
  if (dueMs - nowMs < CHAT_TIMER_MIN_DELAY_MS) throw invalid("Timer delay must be at least 5 seconds.");
  if (dueMs - nowMs > CHAT_TIMER_MAX_HORIZON_MS) throw invalid("Timer horizon cannot exceed one year.");
  const timezone = input.timezone.trim();
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: timezone }).format(new Date(nowMs));
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
    ...(input.notificationRuleId?.trim() ? { notificationRuleId: input.notificationRuleId.trim() } : {}),
    cancelOnNextReply: input.cancelOnNextReply === true,
  };
}

function invalid(message: string): ValidationError {
  return new ValidationError({ code: "FIELD_INVALID", message });
}

function sanitizeFailure(error: unknown): string {
  return (error instanceof Error ? error.message : "Timer firing failed.")
    .replace(/https?:\/\/\S+/giu, "[REDACTED_URL]")
    .slice(0, 1_000);
}
