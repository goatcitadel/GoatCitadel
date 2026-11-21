import { describe, expect, it } from "vitest";
import { MemoryWriteGateService } from "./memory-write-gate-service.js";

describe("MemoryWriteGateService secret discrimination", () => {
  const gate = new MemoryWriteGateService();

  it.each([
    "Remember that I prefer low token usage.",
    "I work on tokenization and credential rotation documentation.",
    "Use the OS keychain for passwords; never paste them in chat.",
    "The project has a 4000 token budget.",
  ])("allows harmless security or token vocabulary: %s", (content) => {
    expect(gate.evaluate({ authority: "operator", content }).decision).toBe("allowed");
  });

  it.each([
    "Remember my API key: sk-synthetic1234567890testonly1234567890",
    "Authorization: Bearer synthetic-test-only-abcdefghijklmnopqrstuvwxyz123456789",
    "my password is synthetic-OnlyForTests-49819!",
  ])("blocks actual synthetic secret values without echoing them: %s", (content) => {
    const decision = gate.evaluate({ authority: "operator", content });
    expect(decision.decision).toBe("blocked");
    expect(decision.redactionStatus).toBe("blocked_secret");
    expect(JSON.stringify(decision)).not.toContain(content);
  });

  it("keeps model and external writes proposal-only after harmless vocabulary passes", () => {
    for (const authority of ["agent_proposed", "external_channel"] as const) {
      expect(gate.evaluate({ authority, content: "Prefer a small token budget." }).decision).toBe("proposed");
    }
  });
});
