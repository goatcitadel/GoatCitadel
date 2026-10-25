import { describe, expect, it } from "vitest";
import type { ChatToolRunRecord } from "@goatcitadel/contracts";
import { getChatToolRunDiagnostics } from "./chat-tool-diagnostics";

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
