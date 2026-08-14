import { describe, expect, it } from "vitest";
import { HOOK_EVENT_REGISTRY, HOOK_TRIGGER_VALUES, deriveHookPhase } from "./hooks.js";

describe("governed hook event registry", () => {
  it("covers every exported trigger and defaults all registrations to metadata scope", () => {
    for (const trigger of HOOK_TRIGGER_VALUES) {
      expect(HOOK_EVENT_REGISTRY[trigger]).toMatchObject({ trigger, defaultDataScope: "metadata" });
    }
  });

  it("allows lifecycle control only at explicit before boundaries", () => {
    expect(HOOK_EVENT_REGISTRY["tool.call.after"].allowedModes).toEqual(["observe"]);
    expect(HOOK_EVENT_REGISTRY["prompt.submit.before"].allowedModes).toContain("intercept");
    expect(HOOK_EVENT_REGISTRY["agent.finalize.before"].allowedModes).toContain("intercept");
    expect(deriveHookPhase("context.compaction.before")).toBe("before");
    expect(deriveHookPhase("subagent.end")).toBe("after");
  });
});
