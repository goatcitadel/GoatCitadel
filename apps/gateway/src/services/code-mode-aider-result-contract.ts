import type {
  ChatSessionWorkbenchValidationStatus,
  CodeModeAiderAdapterResultEnvelope,
  CodeModeAiderPromotionRecord,
  CodeModeAiderWorkspacePin,
} from "@goatcitadel/contracts";

const OUTCOMES = new Set(["patch_produced", "no_changes", "failed", "refused"]);
const VALIDATION_STATUSES = new Set(["idle", "pending", "passed", "failed"]);
const GIT_HEAD = /^[0-9a-f]{40}(?:[0-9a-f]{24})?$/;
const SHA256_HEX = /^[0-9a-f]{64}$/;

export interface ParseCodeModeAiderEnvelopeOptions {
  promotion?: unknown;
}

export function parseCodeModeAiderAdapterResultEnvelope(
  value: unknown,
  options?: ParseCodeModeAiderEnvelopeOptions,
): CodeModeAiderAdapterResultEnvelope {
  if (!isRecord(value)) {
    throw new Error("Aider adapter result envelope must be an object.");
  }
  if (value.contractVersion !== 1) {
    throw new Error("Aider adapter result envelope contractVersion must be 1.");
  }
  if (value.adapterId !== "aider-cli-adapter") {
    throw new Error("Aider adapter result envelope adapterId must be aider-cli-adapter.");
  }
  if (typeof value.outcome !== "string" || !OUTCOMES.has(value.outcome)) {
    throw new Error("Aider adapter result envelope outcome is invalid.");
  }
  const command = requireRecord(value.command, "command");
  const argvRedacted = command.argvRedacted;
  if (!Array.isArray(argvRedacted) || argvRedacted.some((item) => typeof item !== "string" || item.length === 0)) {
    throw new Error("Aider adapter result envelope command.argvRedacted must contain redacted command tokens.");
  }
  const replay = requireRecord(value.replay, "replay");
  if (
    replay.replaySafe !== false ||
    (replay.policy !== "audit_only" && replay.policy !== "promoted") ||
    typeof replay.reason !== "string"
  ) {
    throw new Error(
      "Aider adapter result envelope replay posture must be non-replayable with an audit_only or promoted policy and a reason.",
    );
  }
  const promotion =
    options?.promotion === undefined || options.promotion === null
      ? undefined
      : parseCodeModeAiderPromotionRecord(options.promotion);
  if (replay.policy === "audit_only" && promotion?.status === "promoted") {
    throw new Error("Aider adapter result envelope audit_only posture cannot carry a promoted promotion record.");
  }
  if (replay.policy === "promoted") {
    if (promotion?.status !== "promoted") {
      throw new Error("Aider adapter result envelope promoted posture requires a promoted promotion record.");
    }
    if (value.outcome !== "patch_produced" || !isRecord(value.patchArtifact)) {
      throw new Error("Aider adapter result envelope promoted posture requires a patch_produced outcome.");
    }
    const artifact = requireRecord(value.patchArtifact.artifact, "patchArtifact.artifact");
    if (promotion.patchSha256 !== artifact.sha256 || promotion.patchArtifactId !== artifact.artifactId) {
      throw new Error("Aider adapter result envelope promotion record does not match the patch artifact.");
    }
  }
  if (value.outcome === "patch_produced" && !isRecord(value.patchArtifact)) {
    throw new Error("Aider adapter result envelope patch_produced outcome requires patchArtifact.");
  }
  if (isRecord(value.patchArtifact)) {
    validatePatchArtifact(value.patchArtifact);
  }
  if (isRecord(value.stdoutArtifact)) {
    validateArtifact(value.stdoutArtifact, "stdoutArtifact");
  }
  if (isRecord(value.stderrArtifact)) {
    validateArtifact(value.stderrArtifact, "stderrArtifact");
  }
  if ((value.outcome === "failed" || value.outcome === "refused") && !isRecord(value.error)) {
    throw new Error("Aider adapter result envelope failed/refused outcome requires error evidence.");
  }
  return value as unknown as CodeModeAiderAdapterResultEnvelope;
}

export function parseCodeModeAiderWorkspacePin(value: unknown): CodeModeAiderWorkspacePin {
  const pin = requireRecord(value, "workspace pin");
  if (pin.version !== 1) {
    throw new Error("Aider workspace pin version must be 1.");
  }
  const sessionId = requireNonEmptyString(pin.sessionId, "pin.sessionId");
  const worktreeIdentityHash = requirePattern(pin.worktreeIdentityHash, SHA256_HEX, "pin.worktreeIdentityHash");
  const worktreeHead = requirePattern(pin.worktreeHead, GIT_HEAD, "pin.worktreeHead");
  const worktreeStateHash = requirePattern(pin.worktreeStateHash, SHA256_HEX, "pin.worktreeStateHash");
  const capturedAt = requireNonEmptyString(pin.capturedAt, "pin.capturedAt");
  return { version: 1, sessionId, worktreeIdentityHash, worktreeHead, worktreeStateHash, capturedAt };
}

export function parseCodeModeAiderPromotionRecord(value: unknown): CodeModeAiderPromotionRecord {
  const record = requireRecord(value, "promotion record");
  if (record.version !== 1) {
    throw new Error("Aider promotion record version must be 1.");
  }
  if (record.status !== "applying" && record.status !== "promoted") {
    throw new Error("Aider promotion record status is invalid.");
  }
  const parsed: CodeModeAiderPromotionRecord = {
    version: 1,
    status: record.status,
    approvalId: requireNonEmptyString(record.approvalId, "promotion.approvalId"),
    patchArtifactId: requireNonEmptyString(record.patchArtifactId, "promotion.patchArtifactId"),
    patchSha256: requirePattern(record.patchSha256, SHA256_HEX, "promotion.patchSha256"),
    pin: parseCodeModeAiderWorkspacePin(record.pin),
    startedAt: requireNonEmptyString(record.startedAt, "promotion.startedAt"),
  };
  if (record.status === "promoted") {
    parsed.promotedAt = requireNonEmptyString(record.promotedAt, "promotion.promotedAt");
  } else if (record.promotedAt !== undefined) {
    parsed.promotedAt = requireNonEmptyString(record.promotedAt, "promotion.promotedAt");
  }
  if (record.resolvedBy !== undefined) {
    parsed.resolvedBy = requireNonEmptyString(record.resolvedBy, "promotion.resolvedBy");
  }
  if (record.changedFiles !== undefined) {
    if (!Array.isArray(record.changedFiles) || record.changedFiles.some((f) => typeof f !== "string" || !f)) {
      throw new Error("Aider promotion record changedFiles must be non-empty strings.");
    }
    parsed.changedFiles = [...(record.changedFiles as string[])];
  }
  if (record.workbenchValidationStatus !== undefined) {
    if (
      typeof record.workbenchValidationStatus !== "string" ||
      !VALIDATION_STATUSES.has(record.workbenchValidationStatus)
    ) {
      throw new Error("Aider promotion record workbenchValidationStatus is invalid.");
    }
    parsed.workbenchValidationStatus = record.workbenchValidationStatus as ChatSessionWorkbenchValidationStatus;
  }
  return parsed;
}

export function withPromotedCodeModeAiderReplayPosture(
  envelope: CodeModeAiderAdapterResultEnvelope,
  promotion: CodeModeAiderPromotionRecord,
): CodeModeAiderAdapterResultEnvelope {
  return {
    ...envelope,
    replay: {
      replaySafe: false,
      policy: "promoted",
      reason: `Patch promoted into the Chat workbench under approval ${promotion.approvalId}; it is never re-applied.`,
    },
  };
}

function requireNonEmptyString(value: unknown, field: string): string {
  if (typeof value !== "string" || !value) {
    throw new Error(`Aider ${field} must be a non-empty string.`);
  }
  return value;
}

function requirePattern(value: unknown, pattern: RegExp, field: string): string {
  if (typeof value !== "string" || !pattern.test(value)) {
    throw new Error(`Aider ${field} is malformed.`);
  }
  return value;
}

function requireRecord(value: unknown, field: string): Record<string, unknown> {
  if (!isRecord(value)) {
    throw new Error(`Aider adapter result envelope ${field} must be an object.`);
  }
  return value;
}

function validatePatchArtifact(value: Record<string, unknown>): void {
  if (value.kind !== "unified_diff" && value.kind !== "git_patch") {
    throw new Error("Aider adapter result envelope patchArtifact.kind is invalid.");
  }
  validateArtifact(requireRecord(value.artifact, "patchArtifact.artifact"), "patchArtifact.artifact");
}

function validateArtifact(value: Record<string, unknown>, field: string): void {
  for (const key of ["artifactId", "relPath", "sha256", "mimeType", "createdAt"]) {
    if (typeof value[key] !== "string" || !value[key]) {
      throw new Error(`Aider adapter result envelope ${field}.${key} must be a non-empty string.`);
    }
  }
  if (typeof value.bytes !== "number" || !Number.isFinite(value.bytes) || value.bytes < 0) {
    throw new Error(`Aider adapter result envelope ${field}.bytes must be a non-negative number.`);
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}
