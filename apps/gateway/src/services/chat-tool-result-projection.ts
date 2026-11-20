import { createHash } from "node:crypto";
import { redactStructuredSecrets, type ChatCompletionRequest, type ChatToolRunRecord } from "@goatcitadel/contracts";
import { stripRuntimeConfigurationPromptAuthority } from "./runtime-configuration-approval-binding.js";

export function projectToolResultForModel<T>(value: T): T {
  return redactStructuredSecrets(value).value;
}

export function projectHistoryMessagesForModel(
  messages: ChatCompletionRequest["messages"],
): ChatCompletionRequest["messages"] {
  return messages.map((message) => (message.role === "user" ? message : projectToolResultForModel(message)));
}

export function projectToolRunsForModel(toolRuns: ChatToolRunRecord[]): ChatToolRunRecord[] {
  return projectToolResultForModel(
    toolRuns.map((run) => ({ ...run, result: stripRuntimeConfigurationPromptAuthority(run.result) })),
  );
}

export function isSettledToolRunContinuationEvidence(run: ChatToolRunRecord): boolean {
  return run.status === "executed" || run.status === "failed" || run.status === "blocked";
}

export function buildPersistedToolContinuationCallId(run: ChatToolRunRecord): string {
  return `resume_${createHash("sha256").update(run.toolRunId).digest("hex").slice(0, 24)}`;
}

export function buildPersistedToolContinuationResult(run: ChatToolRunRecord): Record<string, unknown> {
  const projectedResult = stripRuntimeConfigurationPromptAuthority(run.result);
  if (run.status === "executed") {
    return projectedResult ?? { status: "executed" };
  }
  return {
    ...(projectedResult ?? {}),
    status: run.status,
    error: run.error ?? (run.status === "blocked" ? "Tool execution was blocked." : "Tool execution failed."),
    ...(run.failureGuidance ? { failureGuidance: run.failureGuidance } : {}),
  };
}

export function serializeToolResultForModel(value: unknown): string {
  return JSON.stringify(projectToolResultForModel(value));
}
