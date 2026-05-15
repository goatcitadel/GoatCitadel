import { describe, expect, it } from "vitest";
import * as entry from "./index";

describe("threaded-surface-core package entry", () => {
  it("exports the runtime host and shared helpers", () => {
    expect(entry.MissionThreadedControllerHost).toBeTypeOf("function");
    expect(entry.formatSessionLabel).toBeTypeOf("function");
    expect(entry.resolveChatRefreshPlan).toBeTypeOf("function");
  });
});
