import type {
  ChatProviderFailureRecord,
  ChatToolRunRecord,
  ChatTurnFailureClass,
  ChatTurnFailureRecord,
} from "@goatcitadel/contracts";
import { getChatTurnRecoveryAction, type ChatTurnRecoveryAction } from "@goatcitadel/contracts";
import { toPlainRecord } from "./usage-and-attribution.js";

export function buildChatTurnFailureRecord(
  failureClass: ChatTurnFailureClass,
  message: string,
  recommendedAction: ChatTurnRecoveryAction = getChatTurnRecoveryAction(failureClass),
  provider?: ChatProviderFailureRecord,
): ChatTurnFailureRecord {
  return {
    failureClass,
    message,
    retryable: failureClass !== "auth_required",
    recommendedAction,
    ...(provider ? { provider } : {}),
  };
}

export function extractProviderFailureRecord(error: unknown): ChatProviderFailureRecord | undefined {
  const providerFailure = toPlainRecord((error as { providerFailure?: unknown } | undefined)?.providerFailure);
  if (providerFailure) {
    const provider: ChatProviderFailureRecord = {
      code: readProviderFailureString(providerFailure.code),
      message: readProviderFailureString(providerFailure.message),
      status: readProviderFailureString(providerFailure.status),
      responseId: readProviderFailureString(providerFailure.responseId ?? providerFailure.response_id),
      type: readProviderFailureString(providerFailure.type),
    };
    if (Object.values(provider).some(Boolean)) {
      return provider;
    }
  }
  if (error instanceof Error && error.cause) {
    return extractProviderFailureRecord(error.cause);
  }
  return undefined;
}

function readProviderFailureString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

export function classifyChatTurnFailure(input: {
  error?: unknown;
  toolRuns: ChatToolRunRecord[];
}): ChatTurnFailureClass {
  if (hasToolBlockedFailure(input.toolRuns)) {
    return "tool_blocked";
  }
  if (hasToolFailedFailure(input.toolRuns)) {
    return "tool_failed";
  }
  const normalizedMessage = input.error instanceof Error ? input.error.message.toLowerCase() : "";
  if (normalizedMessage.includes("timed out") || normalizedMessage.includes("timeout")) {
    return "provider_timeout";
  }
  if (
    normalizedMessage.includes("unauthorized") ||
    normalizedMessage.includes("forbidden") ||
    normalizedMessage.includes("api key") ||
    normalizedMessage.includes("401") ||
    normalizedMessage.includes("403") ||
    normalizedMessage.includes("auth")
  ) {
    return "auth_required";
  }
  if (
    normalizedMessage.includes("network") ||
    normalizedMessage.includes("fetch failed") ||
    normalizedMessage.includes("socket") ||
    normalizedMessage.includes("econnreset") ||
    normalizedMessage.includes("enotfound")
  ) {
    return "network_interrupted";
  }
  return "unknown";
}

function hasToolBlockedFailure(toolRuns: ChatToolRunRecord[]): boolean {
  return toolRuns.some((run) => {
    if (run.status === "blocked") {
      return true;
    }
    const failureClass =
      typeof run.result?.browserFailureClass === "string" ? run.result.browserFailureClass : undefined;
    return failureClass === "remote_blocked" || failureClass === "http_error";
  });
}

function hasToolFailedFailure(toolRuns: ChatToolRunRecord[]): boolean {
  return toolRuns.some((run) => run.status === "failed");
}
