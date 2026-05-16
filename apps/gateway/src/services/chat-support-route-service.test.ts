import { describe, expect, it, vi } from "vitest";
import { ChatSupportRouteService } from "./chat-support-route-service.js";

function createDeps() {
  const call = (method: string) => vi.fn((...args: unknown[]) => ({ method, args }));
  return {
    commands: {
      listChatCommandCatalog: call("listChatCommandCatalog"),
      parseChatCommand: call("parseChatCommand"),
    },
    learnedMemory: {
      listChatSessionLearnedMemory: call("listChatSessionLearnedMemory"),
      rebuildChatSessionLearnedMemory: call("rebuildChatSessionLearnedMemory"),
      updateChatSessionLearnedMemory: call("updateChatSessionLearnedMemory"),
    },
    prefs: {
      getChatSessionPrefs: call("getChatSessionPrefs"),
      updateChatSessionPrefs: call("updateChatSessionPrefs"),
    },
    proactive: {
      getChatSessionProactiveStatus: call("getChatSessionProactiveStatus"),
      listChatSessionProactiveRuns: call("listChatSessionProactiveRuns"),
      triggerChatSessionProactive: call("triggerChatSessionProactive"),
      updateChatSessionProactivePolicy: call("updateChatSessionProactivePolicy"),
    },
    research: {
      getChatResearchRun: call("getChatResearchRun"),
      runChatResearch: call("runChatResearch"),
    },
    specialists: {
      createChatSessionSpecialistCandidate: call("createChatSessionSpecialistCandidate"),
      listChatSessionSpecialistCandidates: call("listChatSessionSpecialistCandidates"),
      updateChatSessionSpecialistCandidate: call("updateChatSessionSpecialistCandidate"),
    },
    steer: {
      submitChatSteerInstruction: call("submitChatSteerInstruction"),
    },
    goal: {
      getChatSessionGoal: call("getChatSessionGoal"),
      setChatSessionGoal: call("setChatSessionGoal"),
      clearChatSessionGoal: call("clearChatSessionGoal"),
    },
  };
}

describe("ChatSupportRouteService", () => {
  it("forwards chat support operations to their dependency groups", () => {
    const deps = createDeps();
    const service = new ChatSupportRouteService(deps as never);

    expect(service.getChatSessionPrefs("session-1")).toEqual({
      method: "getChatSessionPrefs",
      args: ["session-1"],
    });
    expect(service.updateChatSessionPrefs("session-1", { mode: "cowork" } as never)).toEqual({
      method: "updateChatSessionPrefs",
      args: ["session-1", { mode: "cowork" }],
    });
    expect(service.listChatCommandCatalog()).toEqual({ method: "listChatCommandCatalog", args: [] });
    expect(service.parseChatCommand("session-1", "/dream")).toEqual({
      method: "parseChatCommand",
      args: ["session-1", "/dream"],
    });
    expect(service.runChatResearch("session-1", { query: "q", mode: "quick" })).toEqual({
      method: "runChatResearch",
      args: ["session-1", { query: "q", mode: "quick" }],
    });
    expect(service.getChatResearchRun("session-1", "run-1")).toEqual({
      method: "getChatResearchRun",
      args: ["session-1", "run-1"],
    });
    expect(service.getChatSessionProactiveStatus("session-1")).toEqual({
      method: "getChatSessionProactiveStatus",
      args: ["session-1"],
    });
    expect(service.updateChatSessionProactivePolicy("session-1", { proactiveMode: "observe" } as never)).toEqual({
      method: "updateChatSessionProactivePolicy",
      args: ["session-1", { proactiveMode: "observe" }],
    });
    expect(service.triggerChatSessionProactive("session-1", { source: "manual", reason: "test" })).toEqual({
      method: "triggerChatSessionProactive",
      args: ["session-1", { source: "manual", reason: "test" }],
    });
    expect(service.listChatSessionProactiveRuns("session-1", 5)).toEqual({
      method: "listChatSessionProactiveRuns",
      args: ["session-1", 5],
    });
    expect(service.listChatSessionLearnedMemory("session-1", 6)).toEqual({
      method: "listChatSessionLearnedMemory",
      args: ["session-1", 6],
    });
    expect(service.updateChatSessionLearnedMemory("session-1", "memory-1", { status: "accepted" } as never)).toEqual({
      method: "updateChatSessionLearnedMemory",
      args: ["session-1", "memory-1", { status: "accepted" }],
    });
    expect(service.rebuildChatSessionLearnedMemory("session-1")).toEqual({
      method: "rebuildChatSessionLearnedMemory",
      args: ["session-1"],
    });
    expect(service.listChatSessionSpecialistCandidates("session-1", 4)).toEqual({
      method: "listChatSessionSpecialistCandidates",
      args: ["session-1", 4],
    });
    expect(
      service.createChatSessionSpecialistCandidate("session-1", {
        suggestion: { role: "qa", prompt: "check it" } as never,
      }),
    ).toEqual({
      method: "createChatSessionSpecialistCandidate",
      args: ["session-1", { suggestion: { role: "qa", prompt: "check it" } }],
    });
    expect(
      service.updateChatSessionSpecialistCandidate("session-1", "candidate-1", { status: "accepted" } as never),
    ).toEqual({
      method: "updateChatSessionSpecialistCandidate",
      args: ["session-1", "candidate-1", { status: "accepted" }],
    });
    expect(service.submitChatSteerInstruction("session-1", { instruction: "focus" })).toEqual({
      method: "submitChatSteerInstruction",
      args: ["session-1", { instruction: "focus" }],
    });
    expect(service.getChatSessionGoal("session-1")).toEqual({
      method: "getChatSessionGoal",
      args: ["session-1"],
    });
    expect(service.setChatSessionGoal("session-1", { goal: "ship" })).toEqual({
      method: "setChatSessionGoal",
      args: ["session-1", { goal: "ship" }],
    });
    expect(service.clearChatSessionGoal("session-1")).toEqual({
      method: "clearChatSessionGoal",
      args: ["session-1"],
    });
  });
});
