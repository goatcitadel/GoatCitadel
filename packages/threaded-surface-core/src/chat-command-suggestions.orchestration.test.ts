import { describe, expect, it } from "vitest";
import { buildOrchestrationCommandSuggestions } from "./chat-command-suggestions";

describe("buildOrchestrationCommandSuggestions", () => {
  it("returns nothing when draft does not start with a known orchestration command", () => {
    expect(buildOrchestrationCommandSuggestions({ draft: "" })).toEqual([]);
    expect(buildOrchestrationCommandSuggestions({ draft: "hello" })).toEqual([]);
    expect(buildOrchestrationCommandSuggestions({ draft: "/model claude" })).toEqual([]);
  });

  it("suggests steer variant when draft begins with /steer and an instruction", () => {
    const suggestions = buildOrchestrationCommandSuggestions({ draft: "/steer please retry the last step" });
    expect(suggestions.map((item) => item.command)).toEqual(["/steer <instruction>"]);
    expect(suggestions[0]!.applyValue).toBe("/steer please retry the last step");
  });

  it("suggests bare /steer with trailing space applyValue when no instruction provided", () => {
    const suggestions = buildOrchestrationCommandSuggestions({ draft: "/steer" });
    expect(suggestions.map((item) => item.command)).toEqual(["/steer <instruction>"]);
    expect(suggestions[0]!.applyValue).toBe("/steer ");
  });

  it("suggests all queue variants when draft is bare /queue", () => {
    const queue = buildOrchestrationCommandSuggestions({ draft: "/queue" });
    expect(queue.map((item) => item.command)).toEqual(["/queue steer", "/queue followup", "/queue collect"]);
  });

  it("filters /queue suggestions by subcommand prefix match", () => {
    const suggestions = buildOrchestrationCommandSuggestions({ draft: "/queue fo" });
    expect(suggestions.map((item) => item.command)).toEqual(["/queue followup"]);
  });

  it("does not match /queue subcommands by mere letter co-occurrence", () => {
    const suggestions = buildOrchestrationCommandSuggestions({ draft: "/queue e" });
    expect(suggestions.map((item) => item.command)).toEqual([]);
  });

  it("suggests goal variant when draft begins with /goal and a target", () => {
    const suggestions = buildOrchestrationCommandSuggestions({ draft: "/goal ship the kanban" });
    expect(suggestions.map((item) => item.command)).toEqual(["/goal <target>"]);
    expect(suggestions[0]!.applyValue).toBe("/goal ship the kanban");
  });

  it("suggests all goal variants when draft is bare /goal", () => {
    const bare = buildOrchestrationCommandSuggestions({ draft: "/goal" });
    expect(bare.map((item) => item.command)).toEqual(["/goal <target>", "/goal status", "/goal clear"]);
  });

  it("suggests bare /goal with trailing space applyValue when no target provided", () => {
    const bare = buildOrchestrationCommandSuggestions({ draft: "/goal" });
    const goalSet = bare.find((item) => item.key === "goal-set");
    expect(goalSet).toBeDefined();
    expect(goalSet!.applyValue).toBe("/goal ");
  });
});
