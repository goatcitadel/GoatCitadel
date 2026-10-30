import type {
  ChatProviderFailureRecord,
  ChatSkillSecurityFailureRecord,
  ChatToolRunRecord,
  ChatTurnFailureClass,
  ChatTurnFailureRecord,
} from "@goatcitadel/contracts";
import { getChatTurnRecoveryAction, type ChatTurnRecoveryAction } from "@goatcitadel/contracts";
import { classifyProviderFailure, type ProviderFailureClass } from "../llm-completion-helpers.js";
import { toPlainRecord } from "./usage-and-attribution.js";

/** Provider refusals that Chat names on their own; the rest fall through to the message checks below. */
const PROVIDER_FAILURE_CLASSES: Partial<Record<ProviderFailureClass, ChatTurnFailureClass>> = {
  rate_limited: "provider_rate_limited",
  context_overflow: "context_too_long",
  business_denial: "provider_billing",
};

export function buildChatTurnFailureRecord(
  failureClass: ChatTurnFailureClass,
  message: string,
  recommendedAction: ChatTurnRecoveryAction = getChatTurnRecoveryAction(failureClass),
  provider?: ChatProviderFailureRecord,
  security?: ChatSkillSecurityFailureRecord,
): ChatTurnFailureRecord {
  return {
    failureClass,
    message,
    retryable:
      failureClass !== "auth_required" &&
      failureClass !== "provider_billing" &&
      failureClass !== "skill_security_blocked" &&
      failureClass !== "guidance_security_blocked",
    recommendedAction,
    ...(provider ? { provider } : {}),
    ...(security ? { security } : {}),
  };
}

export function extractSkillSecurityFailureRecord(error: unknown): ChatSkillSecurityFailureRecord | undefined {
  const details = toPlainRecord((error as { details?: unknown } | undefined)?.details);
  if (!details) return undefined;
  const guidance = details.failureClass === "guidance_security_blocked";
  if (!guidance && details.failureClass !== "skill_security_blocked") return undefined;
  const scannerVersion = readProviderFailureString(details.scannerVersion);
  const skillIds = readStringArray(details.skillIds);
  // A workspace guidance document names its file, never its content; the record stays hash-only.
  const guidanceFiles = guidance ? readStringArray([details.fileName]) : [];
  const ruleIds = readStringArray(details.ruleIds);
  const evidenceHashes = readStringArray(details.evidenceHashes).filter((value) => /^[a-f0-9]{64}$/u.test(value));
  const subjects = guidance ? guidanceFiles.length : skillIds.length;
  if (!scannerVersion || subjects === 0 || ruleIds.length === 0 || evidenceHashes.length === 0) {
    return undefined;
  }
  return { scannerVersion, skillIds, ...(guidance ? { guidanceFiles } : {}), ruleIds, evidenceHashes };
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

function readStringArray(value: unknown): string[] {
  return Array.isArray(value)
    ? [
        ...new Set(
          value
            .filter((item): item is string => typeof item === "string" && item.trim().length > 0)
            .map((item) => item.trim()),
        ),
      ]
    : [];
}

export function classifyChatTurnFailure(input: {
  error?: unknown;
  toolRuns: ChatToolRunRecord[];
}): ChatTurnFailureClass {
  const errorFailureClass = (input.error as { failureClass?: unknown } | undefined)?.failureClass;
  if (errorFailureClass === "skill_security_blocked" || errorFailureClass === "guidance_security_blocked") {
    return errorFailureClass;
  }
  // The provider's own refusal ended the turn, so it outranks an earlier tool failure the model may have worked past.
  const providerFailureClass =
    input.error instanceof Error ? PROVIDER_FAILURE_CLASSES[classifyProviderFailure(input.error)] : undefined;
  if (providerFailureClass) {
    return providerFailureClass;
  }
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
