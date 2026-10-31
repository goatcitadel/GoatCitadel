import { describe, expect, it } from "vitest";
import type { ChatToolRunRecord } from "@goatcitadel/contracts";
import { getChatToolRunDiagnostics, isFailedCodeModeRequest } from "./chat-tool-diagnostics";

function run(result: Record<string, unknown>): ChatToolRunRecord {
  return {
    toolRunId: "tool-run-1",
    turnId: "turn-1",
    sessionId: "session-1",
    toolName: "presentations.create",
    status: "executed",
    startedAt: "2026-10-11T00:00:00.000Z",
    result,
  };
}

const NOT_INJECTED = "Governed design instructions were not injected; renderer defaults were used.";

describe("getChatToolRunDiagnostics design-instruction posture", () => {
  it("states when the full design report records that governed instructions were not injected", () => {
    const diagnostics = getChatToolRunDiagnostics(
      run({
        path: "C:/workspace/goatcitadel_out/brief.pptx",
        designReport: {
          designQuality: { status: "warning", runtimeInstructions: { status: "not_injected", skills: [] } },
        },
      }),
    );
    expect(diagnostics.summary).toBe(NOT_INJECTED);
    expect(diagnostics.hasFailureSignal).toBe(false);
  });

  it("reads the compacted receipt after the design report was virtualized away", () => {
    const diagnostics = getChatToolRunDiagnostics(
      run({
        artifactSummary: "Stored presentations.create output as an artifact.",
        designQuality: { status: "warning", runtimeInstructionsStatus: "not_injected", runtimeSkillCount: 0 },
      }),
    );
    expect(diagnostics.summary).toBe(`Stored presentations.create output as an artifact. ${NOT_INJECTED}`);
  });

  it("stays quiet when instructions were injected or design quality was skipped", () => {
    expect(
      getChatToolRunDiagnostics(
        run({ designQuality: { status: "applied", runtimeInstructionsStatus: "injected", runtimeSkillCount: 1 } }),
      ).summary,
    ).toBeUndefined();
    expect(
      getChatToolRunDiagnostics(
        run({
          designReport: { designQuality: { status: "skipped", runtimeInstructions: { status: "not_injected" } } },
        }),
      ).summary,
    ).toBeUndefined();
    expect(getChatToolRunDiagnostics(run({ message: "done" })).summary).toBe("done");
  });
});

describe("getChatToolRunDiagnostics for a Chat Code Mode request", () => {
  const request = (result: Record<string, unknown>): ChatToolRunRecord => ({
    ...run(result),
    toolName: "code_mode.request",
  });

  it("treats a request whose code failed as a failure, with its error as the summary", () => {
    // The tool call settles as executed so the turn can resume; the outcome is in its result.
    const failed = request({ runId: "r1", status: "failed", error: "Code Mode is off.", durationMs: 0 });
    expect(isFailedCodeModeRequest(failed)).toBe(true);
    expect(getChatToolRunDiagnostics(failed)).toMatchObject({ hasFailureSignal: true, summary: "Code Mode is off." });
  });

  it("keeps a completed request, and another tool's failed status, as they were", () => {
    const completed = request({ runId: "r1", status: "completed", durationMs: 1200 });
    expect(isFailedCodeModeRequest(completed)).toBe(false);
    expect(getChatToolRunDiagnostics(completed).hasFailureSignal).toBe(false);
    expect(isFailedCodeModeRequest(run({ status: "failed" }))).toBe(false);
  });
});
