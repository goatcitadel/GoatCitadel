import type { RealtimeEvent } from "@goatcitadel/contracts";
import type { AsyncStorage as Storage, InterruptedDurableChatSecureConfigurationCandidate } from "@goatcitadel/storage";
import { buildChatTurnRealtimeOptions } from "./chat-turn-realtime.js";

export interface ChatSecureConfigurationRecoveryDeps {
  storage: Pick<Storage, "sessionMutationAdmissions">;
  validateAuthority(candidate: InterruptedDurableChatSecureConfigurationCandidate): Promise<void>;
  publishRealtime(
    eventType: string,
    source: string,
    payload: Record<string, unknown>,
    options?: Pick<RealtimeEvent, "eventClass" | "eventAuthority" | "links" | "correlationId">,
  ): Promise<unknown>;
  recordDevDiagnostic(input: {
    level: "info" | "warn";
    category: "chat";
    event: string;
    message: string;
    sessionId?: string;
    turnId?: string;
    context?: Record<string, unknown>;
  }): void;
  limit?: number;
}

export interface ChatSecureConfigurationRecoveryResult {
  scanned: number;
  recoveredPromptIds: string[];
  quarantinedPromptIds: string[];
  notificationFailures: number;
  persistenceFailures: number;
  limitReached: boolean;
}

const DEFAULT_RECOVERY_LIMIT = 500;

/**
 * Recover secure configuration reservations left active by a dead Gateway.
 * Current deny-wins authority validation happens before the exact reservation
 * CAS. Invalid policy or consumed approval authority is quarantined and
 * expired without minting a successor prompt. No secret response bytes enter
 * this coordinator.
 */
export async function recoverInterruptedChatSecureConfigurations(
  deps: ChatSecureConfigurationRecoveryDeps,
): Promise<ChatSecureConfigurationRecoveryResult> {
  const limit = normalizeLimit(deps.limit);
  const result: ChatSecureConfigurationRecoveryResult = {
    scanned: 0,
    recoveredPromptIds: [],
    quarantinedPromptIds: [],
    notificationFailures: 0,
    persistenceFailures: 0,
    limitReached: false,
  };

  while (result.scanned < limit) {
    let candidate: InterruptedDurableChatSecureConfigurationCandidate | undefined;
    try {
      candidate = await deps.storage.sessionMutationAdmissions.findNextInterruptedDurableChatSecureConfiguration();
    } catch {
      result.persistenceFailures += 1;
      recordDiagnosticSafely(deps, {
        level: "warn",
        category: "chat",
        event: "chat.secure_configuration.recovery_candidate_failed",
        message: "Secure configuration recovery could not read the next durable candidate; it remains fail-closed.",
      });
      break;
    }
    if (!candidate) return result;
    result.scanned += 1;

    let approvalAuthority: "not_required" | "preserve" | "reject";
    try {
      await deps.validateAuthority(candidate);
      approvalAuthority = candidate.approvedAction ? "preserve" : "not_required";
    } catch {
      approvalAuthority = "reject";
    }

    try {
      const outcome = await deps.storage.sessionMutationAdmissions.recoverInterruptedDurableChatSecureConfiguration({
        reservationId: candidate.reservationId,
        promptId: candidate.promptId,
        approvalAuthority,
        ...(approvalAuthority === "preserve" ? { approvedAction: candidate.approvedAction } : {}),
      });
      if (outcome.disposition === "none") continue;
      const recovered = outcome.disposition === "recovered";
      if (recovered) result.recoveredPromptIds.push(outcome.promptId);
      else result.quarantinedPromptIds.push(outcome.previousPromptId);
      recordDiagnosticSafely(deps, {
        level: recovered ? "info" : "warn",
        category: "chat",
        event: recovered
          ? "chat.secure_configuration.recovered_after_restart"
          : "chat.secure_configuration.quarantined_after_restart",
        message: recovered
          ? "Recovered an interrupted secure configuration prompt on its original durable Chat turn."
          : "Quarantined an interrupted secure configuration prompt because its current authority was no longer valid.",
        sessionId: candidate.sessionId,
        turnId: candidate.turnId,
        context: {
          runId: candidate.durableRunId,
          targetId: candidate.targetId,
          previousPromptId: outcome.previousPromptId,
          ...(recovered ? { promptId: outcome.promptId } : {}),
        },
      });
      try {
        await deps.publishRealtime(
          "chat_thread_updated",
          "chat",
          {
            type: recovered
              ? "chat_thread_secure_configuration_recovered"
              : "chat_thread_secure_configuration_quarantined",
            sessionId: candidate.sessionId,
            turnId: candidate.turnId,
            runId: candidate.durableRunId,
            targetId: candidate.targetId,
            previousPromptId: outcome.previousPromptId,
            ...(recovered ? { promptId: outcome.promptId, expiresAt: outcome.expiresAt } : {}),
          },
          buildChatTurnRealtimeOptions({
            sessionId: candidate.sessionId,
            turnId: candidate.turnId,
            runId: candidate.durableRunId,
          }),
        );
      } catch {
        result.notificationFailures += 1;
        recordDiagnosticSafely(deps, {
          level: "warn",
          category: "chat",
          event: "chat.secure_configuration.recovery_notification_failed",
          message: "Secure configuration recovery persisted, but its realtime notification failed.",
          sessionId: candidate.sessionId,
          turnId: candidate.turnId,
        });
      }
    } catch {
      result.persistenceFailures += 1;
      recordDiagnosticSafely(deps, {
        level: "warn",
        category: "chat",
        event: "chat.secure_configuration.recovery_persistence_failed",
        message: "Secure configuration recovery failed its durable compare-and-set; the candidate remains fail-closed.",
        sessionId: candidate.sessionId,
        turnId: candidate.turnId,
      });
      break;
    }
  }

  if (result.scanned === limit) {
    try {
      result.limitReached =
        (await deps.storage.sessionMutationAdmissions.findNextInterruptedDurableChatSecureConfiguration()) !==
        undefined;
    } catch {
      result.persistenceFailures += 1;
      recordDiagnosticSafely(deps, {
        level: "warn",
        category: "chat",
        event: "chat.secure_configuration.recovery_limit_check_failed",
        message: "Secure configuration recovery could not verify whether its bounded startup scan was complete.",
      });
    }
  }
  return result;
}

function normalizeLimit(value: number | undefined): number {
  if (value === undefined) return DEFAULT_RECOVERY_LIMIT;
  return Number.isSafeInteger(value) && value >= 1 && value <= DEFAULT_RECOVERY_LIMIT ? value : DEFAULT_RECOVERY_LIMIT;
}

function recordDiagnosticSafely(
  deps: ChatSecureConfigurationRecoveryDeps,
  input: Parameters<ChatSecureConfigurationRecoveryDeps["recordDevDiagnostic"]>[0],
): void {
  try {
    deps.recordDevDiagnostic(input);
  } catch {
    // Recovery truth is durable. Diagnostics are best-effort only.
  }
}
