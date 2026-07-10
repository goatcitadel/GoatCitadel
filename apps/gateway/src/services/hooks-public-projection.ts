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
  return records.map(projectPublicSecretValue);
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
