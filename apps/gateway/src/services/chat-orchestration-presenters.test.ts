import { describe, expect, it } from "vitest";

import { buildDelegationFailureGuidance, renderExecutionPlanAsMarkdown } from "./chat-orchestration-presenters.js";

describe("chat orchestration presenters", () => {
  it("exports the route-facing presenter helpers", () => {
    expect(buildDelegationFailureGuidance).toBeTypeOf("function");
    expect(renderExecutionPlanAsMarkdown).toBeTypeOf("function");
  });
});
