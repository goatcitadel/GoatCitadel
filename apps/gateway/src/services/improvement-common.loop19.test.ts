import { describe, expect, it, vi } from "vitest";
import type { ChatCompletionResponse } from "@goatcitadel/contracts";
import {
  clamp01,
  clampProbability,
  extractCompletionText,
  isRecord,
  parseLooseJsonRecord,
  redactForModelJudge,
  safeJsonParse,
  truncateForModelJudge,
  withTimeout,
} from "./improvement-common.js";

describe("improvement common helpers", () => {
  it("parses defensive JSON and clamps score-like values", () => {
    expect(safeJsonParse<{ ok: boolean }>('{"ok":true}', { ok: false })).toEqual({ ok: true });
    expect(safeJsonParse("{not-json", { ok: false })).toEqual({ ok: false });

    expect(clampProbability("0.75")).toBe(0.75);
    expect(clampProbability(5)).toBe(1);
    expect(clampProbability(-1)).toBe(0);
    expect(clampProbability("not-a-number")).toBe(0.5);
    expect(clamp01(-0.25)).toBe(0);
    expect(clamp01(1.25)).toBe(1);
  });

  it("extracts completion text and loose JSON records without accepting arrays", () => {
    const response = {
      choices: [{ message: { content: "candidate answer" } }],
    } as ChatCompletionResponse;

    expect(extractCompletionText(response)).toBe("candidate answer");
    expect(extractCompletionText({ choices: [] } as unknown as ChatCompletionResponse)).toBe("");
    expect(parseLooseJsonRecord('prefix {"score":0.8,"reason":"ok"} suffix')).toEqual({
      score: 0.8,
      reason: "ok",
    });
    expect(parseLooseJsonRecord("no object here")).toBeUndefined();
    expect(parseLooseJsonRecord("{not-json}")).toBeUndefined();
    expect(isRecord({ ok: true })).toBe(true);
    expect(isRecord(["not", "record"])).toBe(false);
  });

  it("redacts secret-like judge input before excerpts can leave the gateway", () => {
    const raw = [
      '{"apiKey":"sk-tool-arg-456","nested":{"session_token":"tok_abc123"}}',
      "TOOL_RESULT_SECRET=sk-tool-result-123",
      "Authorization: Bearer abcdefghijklmnopqrstuvwxyz",
      "account acct_789012 should not be exported",
      "keychain:service/account",
    ].join("\n");

    const redacted = redactForModelJudge(raw);

    expect(redacted).not.toContain("sk-tool-arg-456");
    expect(redacted).not.toContain("tok_abc123");
    expect(redacted).not.toContain("sk-tool-result-123");
    expect(redacted).not.toContain("abcdefghijklmnopqrstuvwxyz");
    expect(redacted).not.toContain("acct_789012");
    expect(redacted).not.toContain("keychain:service/account");
    expect(redacted).toContain("[REDACTED]");
  });

  it("truncates judge input and clears timeout handles after either race winner", async () => {
    expect(truncateForModelJudge("short", 20)).toBe("short");
    expect(truncateForModelJudge("abcdefghijklmnopqrstuvwxyz", 8)).toBe("abcdefgh... [truncated]");

    await expect(withTimeout(Promise.resolve("done"), 1_000, "timed out")).resolves.toBe("done");

    vi.useFakeTimers();
    try {
      const timed = withTimeout(new Promise(() => undefined), 25, "judge timeout");
      const expectation = expect(timed).rejects.toThrow("judge timeout");
      await vi.advanceTimersByTimeAsync(25);
      await expectation;
    } finally {
      vi.useRealTimers();
    }
  });
});
