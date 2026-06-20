import type {
  AgenticCapabilityAvailability,
  AgenticHarnessAvailabilityStatus,
  AgenticPluginProviderRuntimeStatus,
} from "@goatcitadel/contracts";

export interface PluginProviderRuntimeInput {
  runtimeId: string;
  kind: AgenticPluginProviderRuntimeStatus["kind"];
  label: string;
  manifestSource?: string;
  integrityStatus?: AgenticPluginProviderRuntimeStatus["integrityStatus"];
  permissions?: string[];
  secretsRequired?: string[];
  secretsConfigured?: string[];
  rollbackRef?: string;
  healthOk?: boolean;
  healthMessage?: string;
  approvedForCallableUse?: boolean;
  runtimeAvailable?: boolean;
  checkedAt?: string;
}

export function normalizePluginProviderRuntimeStatus(
  input: PluginProviderRuntimeInput,
): AgenticPluginProviderRuntimeStatus {
  const integrityStatus = input.integrityStatus ?? "unverified";
  const runtimeAvailable = input.runtimeAvailable ?? false;
  const approved = input.approvedForCallableUse ?? false;
  const secretsRequired = dedupeStrings(input.secretsRequired ?? []);
  const secretsConfigured = dedupeStrings(input.secretsConfigured ?? []);
  const missingSecrets = secretsRequired.filter((secret) => !secretsConfigured.includes(secret));
  const secretReady = missingSecrets.length === 0;
  const healthOk = (input.healthOk ?? false) && secretReady;
  const status = resolveRuntimeStatus({ integrityStatus, runtimeAvailable, approved, healthOk });
  const callableExposure = resolveCallableExposure({ integrityStatus, runtimeAvailable, approved, healthOk });

  return {
    runtimeId: input.runtimeId.trim(),
    kind: input.kind,
    label: input.label.trim(),
    status,
    manifestSource: input.manifestSource?.trim() || undefined,
    integrityStatus,
    permissions: dedupeStrings(input.permissions ?? []),
    secretsRequired,
    secretReadiness: {
      required: secretsRequired,
      configured: secretsConfigured,
      missing: missingSecrets,
    },
    rollbackRef: input.rollbackRef?.trim() || undefined,
    callableExposure,
    healthCheckedAt: input.checkedAt ?? new Date().toISOString(),
    healthMessage:
      input.healthMessage?.trim() ||
      defaultHealthMessage({ integrityStatus, runtimeAvailable, approved, healthOk, missingSecrets }),
  };
}

export function runtimeStatusToCapabilityAvailability(
  input: AgenticPluginProviderRuntimeStatus,
): AgenticCapabilityAvailability {
  return {
    capabilityId: `${input.kind}:${input.runtimeId}`,
    label: input.label,
    family: input.kind,
    status: input.callableExposure,
    callable: input.callableExposure === "callable",
    reasons: buildCapabilityReasons(input),
    checkedAt: input.healthCheckedAt ?? new Date().toISOString(),
  };
}

export function assertNoCallableExposureForUnsafeRuntimes(records: AgenticPluginProviderRuntimeStatus[]): {
  passed: boolean;
  failures: Array<{ runtimeId: string; reason: string }>;
} {
  const failures: Array<{ runtimeId: string; reason: string }> = [];
  for (const record of records) {
    const unsafe =
      record.integrityStatus === "corrupt" ||
      record.integrityStatus === "quarantined" ||
      record.status === "not_configured" ||
      record.status === "unavailable" ||
      record.status === "blocked";
    if (unsafe && record.callableExposure === "callable") {
      failures.push({
        runtimeId: record.runtimeId,
        reason: `${record.kind} ${record.runtimeId} is ${record.status}/${record.integrityStatus} but is callable.`,
      });
    }
  }
  return {
    passed: failures.length === 0,
    failures,
  };
}

function resolveRuntimeStatus(input: {
  integrityStatus: AgenticPluginProviderRuntimeStatus["integrityStatus"];
  runtimeAvailable: boolean;
  approved: boolean;
  healthOk: boolean;
}): AgenticHarnessAvailabilityStatus {
  if (input.integrityStatus === "corrupt" || input.integrityStatus === "quarantined") {
    return "unavailable";
  }
  if (!input.runtimeAvailable) {
    return "not_configured";
  }
  if (!input.approved || !input.healthOk || input.integrityStatus === "unverified") {
    return "blocked";
  }
  return "callable";
}

function resolveCallableExposure(input: {
  integrityStatus: AgenticPluginProviderRuntimeStatus["integrityStatus"];
  runtimeAvailable: boolean;
  approved: boolean;
  healthOk: boolean;
}): AgenticCapabilityAvailability["status"] {
  if (input.integrityStatus === "corrupt" || input.integrityStatus === "quarantined") {
    return "unavailable";
  }
  if (!input.runtimeAvailable) {
    return "not_configured";
  }
  if (!input.approved || !input.healthOk || input.integrityStatus === "unverified") {
    return "blocked";
  }
  return "callable";
}

function defaultHealthMessage(input: {
  integrityStatus: AgenticPluginProviderRuntimeStatus["integrityStatus"];
  runtimeAvailable: boolean;
  approved: boolean;
  healthOk: boolean;
  missingSecrets?: string[];
}): string | undefined {
  if (input.integrityStatus === "corrupt") {
    return "Manifest is corrupt and has been excluded from callable runtime.";
  }
  if (input.integrityStatus === "quarantined") {
    return "Runtime is quarantined and excluded from callable runtime.";
  }
  if (!input.runtimeAvailable) {
    return "Runtime is not configured or not available.";
  }
  if (!input.approved) {
    return "Runtime is inspectable but not approved for callable use.";
  }
  if (input.missingSecrets?.length) {
    return `Missing required SecretRef values: ${input.missingSecrets.join(", ")}.`;
  }
  if (!input.healthOk) {
    return "Runtime health probe has not passed.";
  }
  return undefined;
}

function buildCapabilityReasons(input: AgenticPluginProviderRuntimeStatus): string[] {
  return dedupeStrings([
    input.integrityStatus === "verified" ? undefined : `Integrity: ${input.integrityStatus}`,
    input.status === "callable" ? undefined : `Runtime status: ${input.status}`,
    input.healthMessage,
    input.secretReadiness?.missing.length
      ? `Missing SecretRefs: ${input.secretReadiness.missing.join(", ")}`
      : undefined,
  ]);
}

function dedupeStrings(values: Array<string | undefined>): string[] {
  const seen = new Set<string>();
  const result: string[] = [];
  for (const value of values) {
    const normalized = value?.trim();
    if (!normalized || seen.has(normalized)) {
      continue;
    }
    seen.add(normalized);
    result.push(normalized);
  }
  return result;
}
