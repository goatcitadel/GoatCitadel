import { describe, expect, it } from "vitest";
import {
  applyLlmRequestHookPatch,
  applyOrchestrationPhaseHookPatch,
  mergeLlmRequestHookPatch,
  parseApprovalCreateHookPatch,
  parseLlmModelSelectHookPatch,
  parseLlmRequestHookPatch,
  parseOrchestrationPhaseHookPatch,
  parseOrchestrationRunHookPatch,
  parseToolCallHookPatch,
} from "./hook-patch-helpers.js";

describe("hook patch helpers", () => {
  it("parses and applies LLM request patches without broad route harnessing", () => {
    expect(parseLlmModelSelectHookPatch({ providerId: " openai ", model: " gpt-5.5 " })).toEqual({
      providerId: "openai",
      model: "gpt-5.5",
    });
    expect(parseLlmModelSelectHookPatch({ providerId: " " })).toBeUndefined();

    const patch = parseLlmRequestHookPatch({
      providerId: "anthropic",
      model: "claude",
      prependMessages: [{ role: "system", content: "prepend", name: " planner " }],
      appendMessages: [{ role: "tool", content: "done", tool_call_id: " call-1 " }],
      tools: [{ name: "tool" }, null, ["bad"]],
      toolChoice: { type: "auto" },
      metadata: { source: "test" },
    });
    expect(patch).toMatchObject({
      providerId: "anthropic",
      model: "claude",
      tools: [{ name: "tool" }],
      metadata: { source: "test" },
    });

    const merged = mergeLlmRequestHookPatch(
      {
        prependMessages: [{ role: "developer", content: "first" }],
        appendMessages: [{ role: "assistant", content: "tail" }],
        metadata: { before: true },
      },
      patch!,
    );
    expect(merged.prependMessages).toHaveLength(2);
    expect(merged.appendMessages).toHaveLength(2);
    expect(merged.metadata).toEqual({ before: true, source: "test" });

    const request = applyLlmRequestHookPatch(
      {
        providerId: "openai",
        model: "old",
        messages: [{ role: "user", content: "body" }],
        metadata: { existing: true },
      } as any,
      merged,
    );
    expect(request).toMatchObject({
      providerId: "anthropic",
      model: "claude",
      tool_choice: { type: "auto" },
      metadata: { existing: true, before: true, source: "test" },
    });
    expect(request.messages.map((message) => message.role)).toEqual([
      "developer",
      "system",
      "user",
      "assistant",
      "tool",
    ]);
    expect(parseLlmRequestHookPatch({ prependMessages: [{ role: "bad", content: "ignored" }] })).toBeUndefined();
  });

  it("parses tool approval and orchestration hook patches", () => {
    expect(parseToolCallHookPatch({ toolName: " shell.command ", args: { command: "date" } })).toEqual({
      toolName: "shell.command",
      args: { command: "date" },
    });
    expect(parseToolCallHookPatch({ args: [] })).toBeUndefined();

    expect(
      parseApprovalCreateHookPatch({
        riskLevel: "nuclear",
        payloadMerge: { command: "rm" },
        previewMerge: { title: "Danger" },
        expiresAt: null,
      }),
    ).toEqual({
      riskLevel: "nuclear",
      payloadMerge: { command: "rm" },
      previewMerge: { title: "Danger" },
      expiresAt: null,
    });
    expect(parseApprovalCreateHookPatch({ riskLevel: "unknown" })).toBeUndefined();

    expect(parseOrchestrationRunHookPatch({ maxIterations: " 4 ", maxRuntimeMinutes: 10, maxCostUsd: 0.5 })).toEqual({
      maxIterations: 4,
      maxRuntimeMinutes: 10,
      maxCostUsd: 0.5,
    });
    expect(parseOrchestrationRunHookPatch({ maxIterations: 0, maxCostUsd: -1 })).toBeUndefined();

    const phasePatch = parseOrchestrationPhaseHookPatch({
      ownerAgentId: " qa ",
      specPath: " specs/run.md ",
      loopMode: "compaction",
      requiresApproval: false,
    });
    expect(phasePatch).toEqual({
      ownerAgentId: "qa",
      specPath: "specs/run.md",
      loopMode: "compaction",
      requiresApproval: false,
    });
    expect(parseOrchestrationPhaseHookPatch({ loopMode: "invalid" })).toBeUndefined();

    const patched = applyOrchestrationPhaseHookPatch(
      {
        waves: [
          {
            waveId: "wave-1",
            phases: [
              { phaseId: "phase-1", label: "Plan", ownerAgentId: "old", specPath: "old.md" },
              { phaseId: "phase-2", label: "Review", ownerAgentId: "reviewer" },
            ],
          },
        ],
      } as any,
      "phase-1",
      phasePatch!,
    );
    expect(patched.waves[0].phases[0]).toMatchObject({
      ownerAgentId: "qa",
      specPath: "specs/run.md",
      loopMode: "compaction",
      requiresApproval: false,
    });
    expect(patched.waves[0].phases[1]).toMatchObject({ ownerAgentId: "reviewer" });
  });
});
