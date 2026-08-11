const ATTACHMENT_MODES = new Set(["managed", "external_override"]);
const MANAGED_PID_STATES = new Set(["missing", "invalid", "running", "stale", "reused", "unverified"]);
const MANAGED_INSTANCE_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;

export function resolveLauncherEndpoint({ defaultUrl, overrideValue }) {
  const normalizedDefaultUrl = normalizeEndpointUrl(defaultUrl, "defaultUrl");
  const normalizedOverride = typeof overrideValue === "string" ? overrideValue.trim() : "";
  if (!normalizedOverride) {
    return {
      url: normalizedDefaultUrl,
      attachmentMode: "managed",
      explicitOverride: false,
    };
  }
  return {
    url: normalizeEndpointUrl(normalizedOverride, "overrideValue"),
    attachmentMode: "external_override",
    explicitOverride: true,
  };
}

export function parseManagedProcessMetadata(raw, { expectedService, isProcessAlive }) {
  if (typeof raw !== "string" || typeof expectedService !== "string" || !expectedService) {
    return { state: "invalid", reason: "invalid_metadata" };
  }
  const normalized = raw.trim();
  // A legacy PID proves only that some process currently has that number. It
  // cannot establish launcher ownership after a restart or PID reuse.
  if (/^[1-9]\d*$/u.test(normalized)) {
    return { state: "invalid", reason: "legacy_integer" };
  }

  let value;
  try {
    value = JSON.parse(normalized);
  } catch {
    return { state: "invalid", reason: "invalid_json" };
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return { state: "invalid", reason: "invalid_metadata" };
  }

  const { pid, processIdentity, instanceId, service, startedAt, servingPid, servingProcessIdentity } = value;
  if (!Number.isSafeInteger(pid) || pid <= 0) {
    return { state: "invalid", reason: "invalid_pid" };
  }
  if (typeof instanceId !== "string" || !MANAGED_INSTANCE_ID_PATTERN.test(instanceId)) {
    return { state: "invalid", reason: "invalid_instance_id" };
  }
  if (!isProcessIdentity(processIdentity)) {
    return { state: "invalid", reason: "invalid_process_identity" };
  }
  if (service !== expectedService) {
    return { state: "invalid", reason: "service_mismatch" };
  }
  if (
    typeof startedAt !== "string" ||
    startedAt.length > 64 ||
    !Number.isFinite(Date.parse(startedAt)) ||
    new Date(startedAt).toISOString() !== startedAt
  ) {
    return { state: "invalid", reason: "invalid_started_at" };
  }
  if (typeof isProcessAlive !== "function") {
    return { state: "invalid", reason: "invalid_process_probe" };
  }
  const hasServingPid = servingPid !== undefined;
  const hasServingIdentity = servingProcessIdentity !== undefined;
  if (hasServingPid !== hasServingIdentity) {
    return { state: "invalid", reason: "incomplete_serving_identity" };
  }
  if (
    hasServingPid &&
    (!Number.isSafeInteger(servingPid) || servingPid <= 0 || !isProcessIdentity(servingProcessIdentity))
  ) {
    return { state: "invalid", reason: "invalid_serving_identity" };
  }

  return {
    pid,
    processIdentity,
    instanceId,
    service,
    startedAt,
    ...(hasServingPid ? { servingPid, servingProcessIdentity } : {}),
    state: isProcessAlive(pid) ? "running" : "stale",
  };
}

export function assessLauncherEndpointOwnership({
  attachmentMode,
  pidState,
  endpointResponded,
  endpointHealthy,
  identityMatched,
  launchInProgress = false,
}) {
  if (!ATTACHMENT_MODES.has(attachmentMode)) {
    throw new Error(`Unsupported launcher endpoint attachment mode: ${attachmentMode}`);
  }
  if (!MANAGED_PID_STATES.has(pidState)) {
    throw new Error(`Unsupported managed PID state: ${pidState}`);
  }
  for (const [label, value] of Object.entries({ endpointResponded, endpointHealthy, identityMatched, launchInProgress })) {
    if (typeof value !== "boolean") {
      throw new Error(`${label} must be a boolean.`);
    }
  }
  if (endpointHealthy && !endpointResponded) {
    throw new Error("A healthy endpoint must have responded.");
  }

  if (attachmentMode === "external_override") {
    return {
      attachmentMode,
      pidState,
      endpointResponded,
      endpointHealthy,
      identityMatched,
      readinessAccepted: endpointHealthy,
      collision: false,
      launchAction: endpointHealthy ? "attach" : "wait_external",
      reason: endpointHealthy ? "external_override_ready" : "external_override_unavailable",
    };
  }

  // A live lifecycle-lock holder for this exact service is affirmative
  // evidence of a managed launch that has not finished publishing metadata.
  // Waiting is bounded by the caller's deadline; without that evidence the
  // fail-closed collision refusal below is unchanged. A running-but-mismatched
  // identity stays a collision even mid-launch.
  if (launchInProgress && endpointResponded && pidState !== "running") {
    return {
      attachmentMode,
      pidState,
      endpointResponded,
      endpointHealthy,
      identityMatched,
      readinessAccepted: false,
      collision: false,
      launchAction: "wait_managed",
      reason: "managed_launch_in_progress",
    };
  }

  if (pidState === "unverified") {
    return {
      attachmentMode,
      pidState,
      endpointResponded,
      endpointHealthy,
      identityMatched,
      readinessAccepted: false,
      collision: endpointResponded,
      launchAction: endpointResponded ? "reject_collision" : "wait_managed",
      reason: "managed_process_identity_unverified",
    };
  }

  if (pidState === "running") {
    if (endpointResponded && !identityMatched) {
      return {
        attachmentMode,
        pidState,
        endpointResponded,
        endpointHealthy,
        identityMatched,
        readinessAccepted: false,
        collision: true,
        launchAction: "reject_collision",
        reason: "managed_identity_mismatch",
      };
    }
    const readinessAccepted = endpointHealthy && identityMatched;
    return {
      attachmentMode,
      pidState,
      endpointResponded,
      endpointHealthy,
      identityMatched,
      readinessAccepted,
      collision: false,
      launchAction: readinessAccepted ? "attach" : "wait_managed",
      reason: readinessAccepted ? "managed_endpoint_ready" : "managed_process_not_ready",
    };
  }

  return {
    attachmentMode,
    pidState,
    endpointResponded,
    endpointHealthy,
    identityMatched,
    readinessAccepted: false,
    collision: endpointResponded,
    launchAction: endpointResponded ? "reject_collision" : "spawn",
    reason: endpointResponded ? "managed_endpoint_collision" : "managed_endpoint_available",
  };
}

export function assessManagedStopSafety({ attachmentMode, pidState, identityMatched }) {
  if (!ATTACHMENT_MODES.has(attachmentMode)) {
    throw new Error(`Unsupported launcher endpoint attachment mode: ${attachmentMode}`);
  }
  if (!MANAGED_PID_STATES.has(pidState)) {
    throw new Error(`Unsupported managed PID state: ${pidState}`);
  }
  if (typeof identityMatched !== "boolean") {
    throw new Error("identityMatched must be a boolean.");
  }
  if (attachmentMode !== "managed") {
    return { allowed: false, reason: "external_override" };
  }
  if (pidState !== "running") {
    return { allowed: false, reason: `metadata_${pidState}` };
  }
  if (!identityMatched) {
    return { allowed: false, reason: "identity_unverified" };
  }
  return { allowed: true, reason: "managed_identity_verified" };
}

export function buildEndpointOwnershipDiagnostic(assessment) {
  return {
    attachmentMode: assessment.attachmentMode,
    pidState: assessment.pidState,
    endpointResponded: assessment.endpointResponded,
    endpointHealthy: assessment.endpointHealthy,
    identityVerified: assessment.identityMatched,
    readinessAccepted: assessment.readinessAccepted,
    conflict: assessment.collision,
    launchAction: assessment.launchAction,
    reason: assessment.reason,
  };
}

export function formatManagedEndpointCollision({ serviceLabel, defaultUrl, overrideEnvKey, assessment }) {
  if (assessment.attachmentMode !== "managed" || assessment.collision !== true) {
    throw new Error("A managed endpoint collision message requires a managed collision assessment.");
  }
  const endpoint = safeEndpointOrigin(defaultUrl);
  const ownershipProblem =
    assessment.reason === "managed_identity_mismatch"
      ? "its health identity does not match the managed process metadata"
      : `its managed process metadata is ${assessment.pidState}`;
  return (
    `${serviceLabel} default endpoint ${endpoint} is reachable, but ${ownershipProblem}. ` +
    `Stop the process using that endpoint, or set ${overrideEnvKey} explicitly to attach to an intentional external runtime.`
  );
}

export function safeEndpointOrigin(value) {
  try {
    const parsed = new URL(value);
    return `${parsed.protocol}//${parsed.hostname}${parsed.port ? `:${parsed.port}` : ""}`;
  } catch {
    return "[configured endpoint]";
  }
}

function normalizeEndpointUrl(value, label) {
  if (typeof value !== "string" || !value.trim()) {
    throw new Error(`${label} must be a non-empty URL string.`);
  }
  const trimmed = value.trim();
  return trimmed.endsWith("/") ? trimmed.slice(0, -1) : trimmed;
}

function isProcessIdentity(value) {
  return (
    typeof value === "string" &&
    value.length > 0 &&
    value.length <= 256 &&
    (/^windows:\d+$/u.test(value) || /^linux:[0-9a-z-]+:\d+$/u.test(value) || /^posix:[^\r\n]+$/u.test(value))
  );
}
