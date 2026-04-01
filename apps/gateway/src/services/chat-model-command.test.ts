import { describe, expect, it } from "vitest";
import { parseChatModelCommandTarget } from "./chat-model-command.js";

describe("parseChatModelCommandTarget", () => {
  it("parses provider-qualified model targets", () => {
    expect(parseChatModelCommandTarget("moonshot/kimi-k2")).toEqual({
      providerId: "moonshot",
      model: "kimi-k2",
    });
  });

  it("falls back to model-only targets for backward compatibility", () => {
    expect(parseChatModelCommandTarget("gpt-5.4")).toEqual({
      model: "gpt-5.4",
    });
  });

  it("rejects malformed provider-qualified targets", () => {
    expect(parseChatModelCommandTarget("moonshot/")).toBeNull();
    expect(parseChatModelCommandTarget("/kimi-k2")).toBeNull();
    expect(parseChatModelCommandTarget("   ")).toBeNull();
  });
});
