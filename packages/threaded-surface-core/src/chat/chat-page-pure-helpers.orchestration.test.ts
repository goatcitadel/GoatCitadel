import { describe, expect, it } from "vitest";
import { parseGoalCommand, parseQueueCommand, resolveMidTurnDisposition } from "./chat-page-pure-helpers";

describe("resolveMidTurnDisposition", () => {
  it("returns 'idle' when no stream is active", () => {
    expect(resolveMidTurnDisposition({ hasActiveStream: false, draft: "hi" })).toBe("idle");
  });
  it("returns 'steer' when active stream and draft is /steer or /queue steer", () => {
    expect(resolveMidTurnDisposition({ hasActiveStream: true, draft: "/steer go faster" })).toBe("steer");
    expect(resolveMidTurnDisposition({ hasActiveStream: true, draft: "/queue steer go faster" })).toBe("steer");
  });
  it("returns 'queue' when active stream and draft is /queue followup", () => {
    expect(resolveMidTurnDisposition({ hasActiveStream: true, draft: "/queue followup later" })).toBe("queue");
  });
  it("defaults to 'steer' for plain mid-turn drafts (OpenClaw 2026.5.14 #77023 default)", () => {
    expect(resolveMidTurnDisposition({ hasActiveStream: true, draft: "tweak the wording" })).toBe("steer");
  });
});

describe("parseGoalCommand", () => {
  it("returns null when draft is not a /goal command", () => {
    expect(parseGoalCommand("hi")).toBeNull();
    expect(parseGoalCommand("/steer x")).toBeNull();
  });
  it("recognizes set/status/clear", () => {
    expect(parseGoalCommand("/goal ship kanban")).toEqual({ kind: "set", text: "ship kanban" });
    expect(parseGoalCommand("/goal status")).toEqual({ kind: "status" });
    expect(parseGoalCommand("/goal clear")).toEqual({ kind: "clear" });
    expect(parseGoalCommand("/goal")).toEqual({ kind: "status" });
  });
});

describe("parseQueueCommand", () => {
  it("recognizes local queue commands and strips routing prefixes", () => {
    expect(parseQueueCommand("/queue steer stay scoped")).toEqual({ kind: "steer", text: "stay scoped" });
    expect(parseQueueCommand("/queue followup run the tests")).toEqual({ kind: "followup", text: "run the tests" });
    expect(parseQueueCommand("/queue collect add this to the batch")).toEqual({
      kind: "collect",
      text: "add this to the batch",
    });
  });

  it("returns null for unknown queue subcommands", () => {
    expect(parseQueueCommand("/queue ship it")).toBeNull();
    expect(parseQueueCommand("/goal pause")).toBeNull();
  });
});
