import { readOpenCodeRunSummary, type ChatToolRunRecord } from "@goatcitadel/contracts";

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

export function isFailedCodeModeRequest(run: Pick<ChatToolRunRecord, "toolName" | "result">): boolean {
  return run.toolName === "code_mode.request" && isRecord(run.result) && run.result.status === "failed";
}

export function hasChatToolFailureSignal(run: ChatToolRunRecord): boolean {
  const result = isRecord(run.result) ? run.result : undefined;
  return (
    run.status === "failed" ||
    run.status === "blocked" ||
    isFailedCodeModeRequest(run) ||
    Boolean(run.error) ||
    Boolean(typeof result?.browserFailureClass === "string" && result.browserFailureClass.trim()) ||
    (typeof result?.exitCode === "number" && result.exitCode !== 0) ||
    Boolean(readOpenCodeRunSummary(result?.externalAgent)?.error)
  );
}
