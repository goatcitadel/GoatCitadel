import type { CodeModeAiderAdapterResultEnvelope } from "@goatcitadel/contracts";

const OUTCOMES = new Set(["patch_produced", "no_changes", "failed", "refused"]);

export function parseCodeModeAiderAdapterResultEnvelope(value: unknown): CodeModeAiderAdapterResultEnvelope {
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
  if (replay.replaySafe !== false || replay.policy !== "audit_only" || typeof replay.reason !== "string") {
    throw new Error("Aider adapter result envelope replay posture must be audit_only and non-replayable.");
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
