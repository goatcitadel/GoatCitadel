import { describe, expect, it } from "vitest";
import { normalizeChannelCommandInput } from "./channel-command-contract.js";

describe("channel command normalization", () => {
  it("normalizes shared channel commands and aliases", () => {
    expect(normalizeChannelCommandInput("/set-home", { platform: "discord" })).toMatchObject({
      handled: true,
      name: "sethome",
      command: "/sethome",
      commandText: "/sethome",
    });
    expect(normalizeChannelCommandInput("/status@GoatBot", { platform: "telegram" })).toMatchObject({
      handled: true,
      name: "status",
      command: "/status",
    });
  });

  it("uses remote approval action tokens rather than token ids", () => {
    expect(normalizeChannelCommandInput("/approve grat_secret_token", { platform: "discord" })).toMatchObject({
      handled: true,
      name: "approve",
      approvalDecision: "approve",
      approvalToken: "grat_secret_token",
      commandText: "/approve grat_secret_token",
    });
    expect(normalizeChannelCommandInput("/deny grat_secret_token", { platform: "telegram" })).toMatchObject({
      handled: true,
      name: "deny",
      approvalDecision: "reject",
      approvalToken: "grat_secret_token",
    });
  });

  it("preserves run details requests for downstream handling", () => {
    expect(normalizeChannelCommandInput("/run details durable-run-1", { platform: "discord" })).toMatchObject({
      handled: true,
      name: "run",
      command: "/run",
      runDetailId: "durable-run-1",
      commandText: "/run details durable-run-1",
    });
  });

  it("normalizes channel lookup commands on Telegram and Discord", () => {
    expect(normalizeChannelCommandInput("/memory release proof", { platform: "telegram" })).toMatchObject({
      handled: true,
      name: "memory",
      commandText: "/memory release proof",
      argText: "release proof",
    });
    expect(normalizeChannelCommandInput("/recall installer", { platform: "discord" })).toMatchObject({
      handled: true,
      name: "recall",
      commandText: "/recall installer",
    });
    expect(normalizeChannelCommandInput("/search approvals", { platform: "discord" })).toMatchObject({
      handled: true,
      name: "search",
      commandText: "/search approvals",
    });
  });

  it("rejects commands that are not supported on the requested platform", () => {
    expect(normalizeChannelCommandInput("/start", { platform: "discord" })).toMatchObject({
      handled: false,
    });
  });
});
