import type {
  ChannelProbeReport,
  ConnectorDiagnosticReport,
  ChannelSetupFailureCategory,
} from "@goatcitadel/contracts";
export function mapProbeStepsToChecks(steps: ChannelProbeReport["steps"]): ConnectorDiagnosticReport["checks"] {
  for (const step of steps) {
    step.disposition ??=
      step.status === "skipped" ? "blocking" : step.key.endsWith("_sandbox_cleanup") ? "advisory" : "blocking";
    if (step.key.endsWith("_sandbox_cleanup"))
      step.cleanupStatus ??=
        step.status === "pass" ? "completed" : step.status === "skipped" ? "unsupported" : "manual_required";
  }
  return steps
    .filter((step) => step.status !== "skipped")
    .map((step) => ({
      key: step.key,
      status: step.status === "pass" ? "pass" : step.status === "fail" ? "fail" : "warn",
      message: `${step.label}: ${step.message}`,
    }));
}

export function parseJsonRecord(text: string): Record<string, unknown> {
  const payload = parseJsonValue(text);
  return asRecord(payload);
}

export function parseJsonValue(text: string): unknown {
  if (!text.trim()) {
    return {};
  }
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return {};
  }
}

export function inferFailureCategory(statusCode: number): ChannelSetupFailureCategory {
  if (statusCode === 401) {
    return "credential_rejected";
  }
  if (statusCode === 403) {
    return "permission_mismatch";
  }
  if (statusCode === 404) {
    return "destination_mismatch";
  }
  if (statusCode >= 500) {
    return "platform_unavailable";
  }
  return "unknown";
}

export function asString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : undefined;
}

export function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" ? (value as Record<string, unknown>) : {};
}
