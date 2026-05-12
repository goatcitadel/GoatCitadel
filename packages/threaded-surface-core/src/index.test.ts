import { describe, expect, it } from "vitest";

describe("threaded-surface-core package entry", () => {
  it("exports the runtime host and shared helpers", async () => {
    const entry = await import("./index");

    expect(entry.MissionThreadedControllerHost).toBeTypeOf("function");
    expect(entry.formatSessionLabel).toBeTypeOf("function");
    expect(entry.resolveChatRefreshPlan).toBeTypeOf("function");
  }, 15_000);
});
