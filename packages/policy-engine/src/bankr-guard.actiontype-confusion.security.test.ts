import { describe, expect, it } from "vitest";
import { normalizeBankrAction } from "./bankr-guard.js";

// Regression coverage for CODEX_FINDING #28: `bankr.read` previously
// accepted `actionType: "read"` even when the prompt clearly asked for a
// write (e.g. `transfer 50 USDC to 0x...`). Because the engine trusted
// the raw `actionType`, the read-only mode, daily caps, per-action caps,
// and approval requirement were ALL bypassed, and the prompt was sent
// straight to `bankr prompt` for execution. The fix: when the claim is
// "read" but the prompt is obviously a write, override to the inferred
// write action so the write-gates fire.

describe("normalizeBankrAction with mismatched actionType/prompt (codex #28)", () => {
  it("overrides actionType=read when the prompt asks for a transfer", () => {
    const normalized = normalizeBankrAction({
      actionType: "read",
      prompt: "transfer 50 USDC to 0xabcd",
    });
    expect(normalized.actionType).toBe("transfer");
  });

  it("overrides actionType=read when the prompt asks for a trade", () => {
    expect(normalizeBankrAction({ actionType: "read", prompt: "buy 0.5 ETH" }).actionType).toBe("trade");
    expect(normalizeBankrAction({ actionType: "read", prompt: "swap USDC to ETH" }).actionType).toBe("trade");
  });

  it("overrides actionType=read when the prompt asks for a sign", () => {
    expect(normalizeBankrAction({ actionType: "read", prompt: "sign this permit" }).actionType).toBe("sign");
  });

  it("overrides actionType=read when the prompt asks for a deploy", () => {
    expect(normalizeBankrAction({ actionType: "read", prompt: "deploy this contract" }).actionType).toBe("deploy");
  });

  it("overrides actionType=read when the prompt asks for a submit", () => {
    expect(normalizeBankrAction({ actionType: "read", prompt: "broadcast this raw transaction" }).actionType).toBe(
      "submit",
    );
  });

  it("preserves actionType=read when the prompt is genuinely a read", () => {
    expect(normalizeBankrAction({ actionType: "read", prompt: "what is my balance" }).actionType).toBe("read");
  });

  it("preserves an explicit write actionType when caller is honest", () => {
    expect(normalizeBankrAction({ actionType: "transfer", prompt: "transfer 50 USDC" }).actionType).toBe("transfer");
  });

  it("does NOT override a non-read claim — caller-supplied write types are honored", () => {
    // If the caller claims "trade" but the prompt mentions "transfer",
    // we keep "trade" — only the read→write override fires, because the
    // attack we're closing is `bankr.read` being used to smuggle writes.
    expect(normalizeBankrAction({ actionType: "trade", prompt: "transfer 50 USDC" }).actionType).toBe("trade");
  });
});
