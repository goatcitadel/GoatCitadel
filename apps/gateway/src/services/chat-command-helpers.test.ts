import { describe, expect, it } from "vitest";
import { parseDelegateCommand, parsePipelineCommand, parseSlashCommand } from "./chat-command-helpers.js";

describe("chat command helpers", () => {
  it("parses slash commands only when the message starts with a slash", () => {
    expect(parseSlashCommand("hello /delegate")).toBeUndefined();
    expect(parseSlashCommand("   ")).toBeUndefined();
    expect(parseSlashCommand(" /goal   status  ")).toEqual(["/goal", "status"]);
  });

  it("parses delegate command roles, defaults, and validation errors", () => {
    expect(parseDelegateCommand("/delegate product, QA, qa, Coder! :: Ship the release")).toEqual({
      roles: ["product", "qa", "coder"],
      objective: "Ship the release",
    });
    expect(parseDelegateCommand("/delegate :: Use defaults")).toEqual({
      roles: ["product", "architect", "coder", "qa", "ops"],
      objective: "Use defaults",
    });
    expect(parseDelegateCommand("/delegate qa only")).toEqual({ roles: [], error: "missing delimiter" });
    expect(parseDelegateCommand("/delegate , :: ")).toEqual({
      roles: ["product", "architect", "coder", "qa", "ops"],
      objective: "",
      error: "invalid delegate payload",
    });
  });

  it("parses known pipeline templates and rejects malformed payloads", () => {
    expect(parsePipelineCommand("/pipeline BUILD :: implement and verify")).toEqual({
      template: "build",
      roles: ["architect", "coder", "qa"],
      objective: "implement and verify",
    });
    expect(parsePipelineCommand("/pipeline release :: ship")).toEqual({
      template: "release",
      roles: ["qa", "ops", "product"],
      objective: "ship",
    });
    expect(parsePipelineCommand("/pipeline build")).toBeUndefined();
    expect(parsePipelineCommand("/pipeline unknown :: ship")).toBeUndefined();
    expect(parsePipelineCommand("/pipeline triage :: ")).toBeUndefined();
  });
});
