import {
  SECRET_REDACTION_MARKER,
  type HookActionConfig,
  type HookRecord,
  type HookRunRecord,
  type HookUpdateInput,
} from "@goatcitadel/contracts";
import { preserveKnownPublicProjectionSecretsForUpdate } from "./integration-connection-public-projection.js";
import { projectPublicSecretValue } from "./public-secret-projection.js";

export function projectHookRecordForPublicResponse(record: HookRecord): HookRecord {
  const projected = projectPublicSecretValue(record);
  return {
    ...projected,
    action: projectHookActionForPublicResponse(record.action),
  };
}

export function projectHookRecordsForPublicResponse(records: HookRecord[]): HookRecord[] {
  return records.map(projectHookRecordForPublicResponse);
}

export function projectHookRunsForPublicResponse(records: HookRunRecord[]): HookRunRecord[] {
  return records.map((record) => {
    // Delivery payloads and remote responses are retained only in Gateway-owned
    // evidence. A client needs status and retry truth, not the data that crossed
    // the egress boundary (which could itself contain secrets or prompt text).
    const { requestPayload: _requestPayload, responsePayload: _responsePayload, decision: _decision, patchSummary: _patchSummary, errorText, ...safeRecord } = record;
    return projectPublicSecretValue({
      ...safeRecord,
      ...(errorText ? { errorText: summarizeHookRunError(errorText) } : {}),
    }) as HookRunRecord;
  });
}

export function preserveHookSecretsForPublicUpdate(current: HookRecord, input: HookUpdateInput): HookUpdateInput {
  if (input.action === undefined) {
    return { ...input };
  }

  const action = preserveKnownPublicProjectionSecretsForUpdate(
    current.action as unknown as Record<string, unknown>,
    projectHookActionForPublicResponse(current.action) as unknown as Record<string, unknown>,
    input.action as unknown as Record<string, unknown>,
  ) as unknown as HookActionConfig;
  return {
    ...input,
    action,
  };
}

function projectHookActionForPublicResponse(action: HookActionConfig): HookActionConfig {
  if (action.type === "managed_package") {
    return action;
  }
  const projected = projectPublicSecretValue(action);
  return {
    ...projected,
    webhook: {
      ...projected.webhook,
      // Hook URLs are executable destinations and may embed opaque path
      // credentials without a provider-specific label. Keep the complete URL
      // hidden and use this exact same projection for update reconciliation.
      url: SECRET_REDACTION_MARKER,
    },
  };
}

function summarizeHookRunError(errorText: string): string {
  const httpStatus = errorText.match(/\b([45]\d\d)\b/);
  if (httpStatus) return `webhook_http_${httpStatus[1]}`;
  if (/timed out/i.test(errorText)) return "hook_delivery_timed_out";
  if (/circuit breaker/i.test(errorText)) return "hook_circuit_breaker_open";
  if (/signing secret/i.test(errorText)) return "hook_signing_secret_unavailable";
  if (/disabled/i.test(errorText)) return "hook_disabled";
  return "hook_delivery_failed";
}
