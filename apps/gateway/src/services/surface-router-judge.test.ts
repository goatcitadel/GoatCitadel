import { describe, it, expect, vi } from "vitest";
import type { ChatCompletionResponse } from "@goatcitadel/contracts";
import { parseSurfaceJudgeResult, buildSurfaceRouterJudge } from "./surface-router-judge.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeCompletion(content: string): ChatCompletionResponse {
  return {
    choices: [
      {
        index: 0,
        message: { content } as Record<string, unknown>,
        finish_reason: "stop",
      },
    ],
  };
}

// ---------------------------------------------------------------------------
// parseSurfaceJudgeResult — pure unit tests
// ---------------------------------------------------------------------------

describe("parseSurfaceJudgeResult", () => {
  it("parses valid compact JSON for chat mode", () => {
    const result = parseSurfaceJudgeResult('{"mode":"chat","confidence":0.9}');
    expect(result).toEqual({ mode: "chat", confidence: 0.9 });
  });

  it("normalizes valid compact JSON for cowork mode into chat", () => {
    const result = parseSurfaceJudgeResult('{"mode":"cowork","confidence":0.75}');
    expect(result).toEqual({ mode: "chat", confidence: 0.75 });
  });

  it("normalizes valid compact JSON for code mode into chat", () => {
    const result = parseSurfaceJudgeResult('{"mode":"code","confidence":0.82}');
    expect(result).toEqual({ mode: "chat", confidence: 0.82 });
  });

  it("extracts JSON embedded in surrounding prose", () => {
    const result = parseSurfaceJudgeResult('Here is the classification: {"mode":"cowork","confidence":0.88} — done.');
    expect(result).toEqual({ mode: "chat", confidence: 0.88 });
  });

  it("extracts JSON from a fenced ```json block", () => {
    const content = '```json\n{"mode":"code","confidence":0.95}\n```';
    const result = parseSurfaceJudgeResult(content);
    expect(result).toEqual({ mode: "chat", confidence: 0.95 });
  });

  it("returns undefined for content with no JSON object", () => {
    expect(parseSurfaceJudgeResult("Just plain text, no braces.")).toBeUndefined();
  });

  it("returns undefined for invalid JSON", () => {
    expect(parseSurfaceJudgeResult("{mode: chat, confidence: 0.9}")).toBeUndefined();
  });

  it("returns undefined when mode is not a recognised surface ('banana')", () => {
    expect(parseSurfaceJudgeResult('{"mode":"banana","confidence":0.9}')).toBeUndefined();
  });

  it("defaults confidence to 0.6 when confidence is missing", () => {
    const result = parseSurfaceJudgeResult('{"mode":"chat"}');
    expect(result).toEqual({ mode: "chat", confidence: 0.6 });
  });

  it("defaults confidence to 0.6 when confidence is NaN", () => {
    const result = parseSurfaceJudgeResult('{"mode":"chat","confidence":null}');
    expect(result).toEqual({ mode: "chat", confidence: 0.6 });
  });

  it("clamps confidence above 1 to 1", () => {
    const result = parseSurfaceJudgeResult('{"mode":"chat","confidence":1.5}');
    expect(result).toEqual({ mode: "chat", confidence: 1 });
  });

  it("clamps confidence below 0 to 0", () => {
    const result = parseSurfaceJudgeResult('{"mode":"chat","confidence":-0.3}');
    expect(result).toEqual({ mode: "chat", confidence: 0 });
  });
});

// ---------------------------------------------------------------------------
// buildSurfaceRouterJudge — integration-style unit tests
// ---------------------------------------------------------------------------

describe("buildSurfaceRouterJudge", () => {
  const baseInput = {
    prompt: "Fix the TypeScript error in my auth module",
    citadelId: "citadel-abc",
    priors: [],
  };

  it("returns a parsed result and forwards providerId/model from resolveModelDefaults", async () => {
    const createChatCompletion = vi.fn().mockResolvedValue(makeCompletion('{"mode":"code","confidence":0.82}'));
    const resolveModelDefaults = vi.fn().mockReturnValue({ providerId: "openai", model: "gpt-5.4" });
    const judge = buildSurfaceRouterJudge({ createChatCompletion, resolveModelDefaults });

    const result = await judge(baseInput);

    expect(result).toEqual({ mode: "chat", confidence: 0.82 });
    expect(createChatCompletion).toHaveBeenCalledOnce();
    const callArg = createChatCompletion.mock.calls[0][0] as { providerId: string; model: string };
    expect(callArg.providerId).toBe("openai");
    expect(callArg.model).toBe("gpt-5.4");
  });

  it("includes prior corrections in the user message", async () => {
    const createChatCompletion = vi.fn().mockResolvedValue(makeCompletion('{"mode":"cowork","confidence":0.78}'));
    const judge = buildSurfaceRouterJudge({
      createChatCompletion,
      resolveModelDefaults: () => ({}),
    });

    await judge({
      prompt: "Compare these three approaches",
      citadelId: "cit-1",
      priors: [{ fromMode: "chat", toMode: "cowork", recordedAt: "2026-06-01T00:00:00Z" }],
    });

    const userMsg = (
      createChatCompletion.mock.calls[0][0] as { messages: Array<{ role: string; content: string }> }
    ).messages.find((m) => m.role === "user");
    expect(userMsg?.content).toContain("chat->cowork");
  });

  it("returns undefined when createChatCompletion throws", async () => {
    const createChatCompletion = vi.fn().mockRejectedValue(new Error("network error"));
    const judge = buildSurfaceRouterJudge({
      createChatCompletion,
      resolveModelDefaults: () => ({}),
    });

    const result = await judge(baseInput);
    expect(result).toBeUndefined();
  });

  it("returns undefined when the model returns prose with no JSON", async () => {
    const createChatCompletion = vi.fn().mockResolvedValue(makeCompletion("I cannot classify this message."));
    const judge = buildSurfaceRouterJudge({
      createChatCompletion,
      resolveModelDefaults: () => ({}),
    });

    const result = await judge(baseInput);
    expect(result).toBeUndefined();
  });

  it("uses empty string when choices array is missing", async () => {
    const createChatCompletion = vi.fn().mockResolvedValue({} satisfies ChatCompletionResponse);
    const judge = buildSurfaceRouterJudge({
      createChatCompletion,
      resolveModelDefaults: () => ({}),
    });

    const result = await judge(baseInput);
    expect(result).toBeUndefined();
  });
});
