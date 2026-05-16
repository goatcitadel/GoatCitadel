import { describe, expect, it } from "vitest";
import { inferChannelParticipantRole, isBotAuthored } from "./channel-participant-role.js";

describe("inferChannelParticipantRole", () => {
  it("returns assistant for participants with agentProfileId", () => {
    expect(inferChannelParticipantRole({ id: "p1", agentProfileId: "agent-1" })).toBe("assistant");
  });

  it("returns bot for connector-bot participants", () => {
    expect(inferChannelParticipantRole({ id: "p1", connectorType: "discord-bot" })).toBe("bot");
    expect(inferChannelParticipantRole({ id: "p1", connectorType: "bot-slack" })).toBe("bot");
  });

  it("returns human for human-linked participants", () => {
    expect(inferChannelParticipantRole({ id: "p1", userId: "u1" })).toBe("human");
  });

  it("returns system when participant kind is system", () => {
    expect(inferChannelParticipantRole({ id: "p1", kind: "system" })).toBe("system");
  });

  it("returns unknown when no identifying fields", () => {
    expect(inferChannelParticipantRole({ id: "p1" })).toBe("unknown");
  });
});

describe("isBotAuthored", () => {
  it("returns true for bot and assistant", () => {
    expect(isBotAuthored("bot")).toBe(true);
    expect(isBotAuthored("assistant")).toBe(true);
  });

  it("returns false for human, system, unknown", () => {
    expect(isBotAuthored("human")).toBe(false);
    expect(isBotAuthored("system")).toBe(false);
    expect(isBotAuthored("unknown")).toBe(false);
  });
});
