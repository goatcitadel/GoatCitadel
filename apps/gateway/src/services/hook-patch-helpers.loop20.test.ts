import { describe, expect, it } from "vitest";
import {
  applyLlmRequestHookPatch,
  applyOrchestrationPhaseHookPatch,
  mergeLlmRequestHookPatch,
  parseApprovalCreateHookPatch,
  parseLlmRequestHookPatch,
  parseOrchestrationPhaseHookPatch,
  parseOrchestrationRunHookPatch,
  parseToolCallHookPatch,
} from "./hook-patch-helpers.js";

describe("hook patch helper loop20 tails", () => {
  it("keeps sparse LLM patches narrow while preserving valid message content arrays", () => {
    const patch = parseLlmRequestHookPatch({
      appendMessages: [
        { role: "assistant", content: [{ type: "text", text: "structured" }], name: " " },
        { role: "tool", content: "done", tool_call_id: " tool-call-1 " },
        { role: "user", content: 42 },
        null,
      ],
      tools: "not-tools",
      toolChoice: "auto",
      metadata: ["not-metadata"],
    });

    expect(patch).toEqual({
      appendMessages: [
        { role: "assistant", content: [{ type: "text", text: "structured" }] },
        { role: "tool", content: "done", tool_call_id: "tool-call-1" },
      ],
      toolChoice: "auto",
    });

    const request = applyLlmRequestHookPatch(
      {
        providerId: "openai",
        model: "gpt",
        messages: [{ role: "user", content: "start" }],
      } as any,
      patch!,
    );

    expect(request).toMatchObject({
      providerId: "openai",
      model: "gpt",
      tool_choice: "auto",
    });
    expect(request.messages).toHaveLength(3);
  });

  it("parses approval and orchestration numeric tails without accepting invalid shapes", () => {
    expect(parseToolCallHookPatch({ toolName: " ", args: { ok: true } })).toEqual({ args: { ok: true } });
    expect(parseApprovalCreateHookPatch({ expiresAt: " 2026-05-01T00:00:00.000Z " })).toEqual({
      expiresAt: "2026-05-01T00:00:00.000Z",
    });
    expect(parseApprovalCreateHookPatch({ payloadMerge: [], previewMerge: [], expiresAt: "" })).toBeUndefined();
    expect(parseOrchestrationRunHookPatch({ maxIterations: "5x", maxRuntimeMinutes: " 6 " })).toEqual({
      maxIterations: 5,
      maxRuntimeMinutes: 6,
    });
    expect(
      parseOrchestrationRunHookPatch({ maxIterations: "", maxRuntimeMinutes: 1.5, maxCostUsd: Infinity }),
    ).toBeUndefined();
  });

  it("merges sparse LLM patches without inventing empty message or metadata fields", () => {
    expect(mergeLlmRequestHookPatch(undefined, { model: "gpt-5.5" })).toEqual({ model: "gpt-5.5" });
  });

  it("leaves unmatched orchestration phases intact and applies partial boolean-only patches", () => {
    const booleanOnlyPatch = parseOrchestrationPhaseHookPatch({ requiresApproval: true });
    expect(booleanOnlyPatch).toEqual({ requiresApproval: true });

    const plan = {
      waves: [
        {
          waveId: "wave-1",
          phases: [
            { phaseId: "phase-1", label: "Plan", requiresApproval: false },
            { phaseId: "phase-2", label: "Review", requiresApproval: false },
          ],
        },
      ],
    } as any;

    const unchanged = applyOrchestrationPhaseHookPatch(plan, "missing", {
      ownerAgentId: "qa",
      requiresApproval: true,
    });
    expect(unchanged.waves[0].phases).toEqual(plan.waves[0].phases);

    const patched = applyOrchestrationPhaseHookPatch(plan, "phase-2", booleanOnlyPatch!);
    expect(patched.waves[0].phases[0]).toMatchObject({ phaseId: "phase-1", requiresApproval: false });
    expect(patched.waves[0].phases[1]).toMatchObject({ phaseId: "phase-2", requiresApproval: true });
  });
});
