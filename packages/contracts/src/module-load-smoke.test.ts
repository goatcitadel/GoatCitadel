import { describe, expect, it } from "vitest";
import type { HookTrigger } from "./hooks.js";

describe("contracts module load smoke", () => {
  it("loads contracts index exports", async () => {
    const mod = await import("./index.js");
    expect(mod).toBeTruthy();
    expect(typeof mod).toBe("object");
  });

  it("includes gateway.dispatch.before in HookTrigger", () => {
    const trigger: HookTrigger = "gateway.dispatch.before";
    expect(trigger).toBe("gateway.dispatch.before");
  });

  it("includes transform_llm_output in HookTrigger", () => {
    const trigger: HookTrigger = "transform_llm_output";
    expect(trigger).toBe("transform_llm_output");
  });

  it("includes approval.request.before in HookTrigger", () => {
    const trigger: HookTrigger = "approval.request.before";
    expect(trigger).toBe("approval.request.before");
  });

  it("includes approval.response.after in HookTrigger", () => {
    const trigger: HookTrigger = "approval.response.after";
    expect(trigger).toBe("approval.response.after");
  });
});
