import { describe, expect, it } from "vitest";
import { buildOrchestrationCommandSuggestions } from "./chat-command-suggestions";

describe("buildOrchestrationCommandSuggestions", () => {
  it("returns nothing when draft does not start with a known orchestration command", () => {
    expect(buildOrchestrationCommandSuggestions({ draft: "" })).toEqual([]);
    expect(buildOrchestrationCommandSuggestions({ draft: "hello" })).toEqual([]);
    expect(buildOrchestrationCommandSuggestions({ draft: "/model claude" })).toEqual([]);
  });

  it("suggests steer/queue variants when draft begins with /steer or /queue", () => {
    const suggestions = buildOrchestrationCommandSuggestions({ draft: "/steer please retry the last step" });
    expect(suggestions.map((item) => item.command)).toEqual(["/steer <instruction>"]);
    expect(suggestions[0]!.applyValue).toBe("/steer please retry the last step");

    const queue = buildOrchestrationCommandSuggestions({ draft: "/queue" });
    expect(queue.map((item) => item.command)).toEqual(["/queue steer", "/queue followup", "/queue collect"]);
  });

  it("suggests goal variants when draft begins with /goal", () => {
    const suggestions = buildOrchestrationCommandSuggestions({ draft: "/goal ship the kanban" });
    expect(suggestions.map((item) => item.command)).toEqual(["/goal <target>"]);
    expect(suggestions[0]!.applyValue).toBe("/goal ship the kanban");

    const bare = buildOrchestrationCommandSuggestions({ draft: "/goal" });
    expect(bare.map((item) => item.command)).toEqual(["/goal <target>", "/goal status", "/goal clear"]);
  });
});
