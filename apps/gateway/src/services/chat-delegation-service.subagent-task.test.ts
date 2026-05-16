import { describe, expect, it } from "vitest";
import { buildSubagentTaskFirstMessage, buildDelegationSpecialistSystemPrompt } from "./chat-delegation-service";

describe("buildSubagentTaskFirstMessage", () => {
  it("prefixes the task with [Subagent Task] and includes parent step id", () => {
    const message = buildSubagentTaskFirstMessage({
      role: "architect",
      objective: "Design the new ingestion queue.",
      mode: "sequential",
      parentDelegationStepId: "step-123",
      sharedContext: [],
    });
    expect(message.startsWith("[Subagent Task]")).toBe(true);
    expect(message).toContain("Design the new ingestion queue.");
    expect(message).toContain("architect");
    expect(message).toContain("step-123");
  });
  it("includes prior-step outputs labeled per role", () => {
    const message = buildSubagentTaskFirstMessage({
      role: "implementer",
      objective: "Implement the spec.",
      mode: "sequential",
      parentDelegationStepId: "step-2",
      sharedContext: [{ role: "architect", output: "Spec: queue with retry." }],
    });
    expect(message).toContain("Spec: queue with retry.");
    expect(message).toContain("architect");
  });
  it("uses 'None' for dependency block when sharedContext is empty", () => {
    const message = buildSubagentTaskFirstMessage({
      role: "qa",
      objective: "Test the spec.",
      mode: "parallel",
      parentDelegationStepId: "step-3",
      sharedContext: [],
    });
    expect(message).toContain("None");
  });
});

describe("buildDelegationSpecialistSystemPrompt", () => {
  it("no longer contains the task objective text", () => {
    const prompt = buildDelegationSpecialistSystemPrompt({ role: "architect" });
    expect(prompt).not.toContain("Objective:");
    expect(prompt).toContain("architect");
  });
  it("contains the standard specialist guidance", () => {
    const prompt = buildDelegationSpecialistSystemPrompt({ role: "implementer" });
    expect(prompt).toContain("specialist subagent");
    expect(prompt).toContain("implementer");
  });
});
