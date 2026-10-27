import type { ChannelSetupDiscoveryResult } from "@goatcitadel/contracts";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { checkTelegramKey } from "./telegram-key-check";

const api = vi.hoisted(() => ({
  submitChannelSetupDraftSecrets: vi.fn(),
  discoverTelegramSetupTargets: vi.fn(),
}));
vi.mock("@goatcitadel/mission-control-shared/api/client", () => api);

const TOKEN = "123456:SECRET-TOKEN";

function discovery(overrides: Partial<ChannelSetupDiscoveryResult> = {}): ChannelSetupDiscoveryResult {
  return {
    items: [],
    warnings: [],
    webhookActive: false,
    botIdentity: { id: "42", username: "MyGoatBot", label: "My Goat Bot" },
    ...overrides,
  };
}

beforeEach(() => {
  api.submitChannelSetupDraftSecrets.mockReset();
  api.discoverTelegramSetupTargets.mockReset();
  api.submitChannelSetupDraftSecrets.mockResolvedValue({ draftId: "draft-1", revision: 5 });
  api.discoverTelegramSetupTargets.mockResolvedValue(discovery());
});

describe("checkTelegramKey", () => {
  it("stores the key, then asks Telegram about the bot with the version the store returned", async () => {
    const calls: string[] = [];
    api.submitChannelSetupDraftSecrets.mockImplementation(async () => {
      calls.push("secrets");
      return { draftId: "draft-1", revision: 5 };
    });
    api.discoverTelegramSetupTargets.mockImplementation(async () => {
      calls.push("discover");
      return discovery();
    });

    await checkTelegramKey({ draftId: "draft-1", expectedRevision: 4, token: TOKEN });

    expect(calls).toEqual(["secrets", "discover"]);
    expect(api.submitChannelSetupDraftSecrets).toHaveBeenCalledWith("draft-1", {
      expectedRevision: 4,
      values: { botToken: TOKEN },
    });
    expect(api.discoverTelegramSetupTargets).toHaveBeenCalledWith({
      source: "draft",
      draftId: "draft-1",
      expectedRevision: 5,
    });
  });

  it("names the bot and reports the draft version after the key was stored", async () => {
    await expect(checkTelegramKey({ draftId: "draft-1", expectedRevision: 4, token: TOKEN })).resolves.toEqual({
      revision: 5,
      bot: { username: "MyGoatBot", label: "My Goat Bot" },
      webhookActive: false,
      conflict: false,
    });
  });

  it("leaves the label out when Telegram sent none", async () => {
    api.discoverTelegramSetupTargets.mockResolvedValue(discovery({ botIdentity: { id: "42", username: "MyGoatBot" } }));
    const check = await checkTelegramKey({ draftId: "draft-1", expectedRevision: 4, token: TOKEN });
    expect(check.bot).toEqual({ username: "MyGoatBot" });
    expect("label" in check.bot).toBe(false);
  });

  it("reports a web address that is set and another app that reads the messages", async () => {
    api.discoverTelegramSetupTargets.mockResolvedValue(discovery({ webhookActive: true }));
    expect(await checkTelegramKey({ draftId: "draft-1", expectedRevision: 4, token: TOKEN })).toMatchObject({
      webhookActive: true,
      conflict: false,
    });
    api.discoverTelegramSetupTargets.mockResolvedValue(discovery({ updatesConflict: true }));
    expect(await checkTelegramKey({ draftId: "draft-1", expectedRevision: 4, token: TOKEN })).toMatchObject({
      webhookActive: false,
      conflict: true,
    });
  });

  it("never clears a web address", async () => {
    await checkTelegramKey({ draftId: "draft-1", expectedRevision: 4, token: TOKEN });
    expect(api.discoverTelegramSetupTargets.mock.calls[0]![0]).not.toHaveProperty("clearWebhook");
  });

  it("fails without asking Telegram when the key could not be stored", async () => {
    api.submitChannelSetupDraftSecrets.mockRejectedValue(new Error("conflict"));
    await expect(checkTelegramKey({ draftId: "draft-1", expectedRevision: 4, token: TOKEN })).rejects.toThrow();
    expect(api.discoverTelegramSetupTargets).not.toHaveBeenCalled();
  });

  it("fails when Telegram names no bot, rather than calling the key good", async () => {
    api.discoverTelegramSetupTargets.mockResolvedValue(discovery({ botIdentity: undefined }));
    await expect(checkTelegramKey({ draftId: "draft-1", expectedRevision: 4, token: TOKEN })).rejects.toThrow();
    api.discoverTelegramSetupTargets.mockResolvedValue(discovery({ botIdentity: { id: "42" } }));
    await expect(checkTelegramKey({ draftId: "draft-1", expectedRevision: 4, token: TOKEN })).rejects.toThrow();
  });

  it("never puts the key in the error it raises itself", async () => {
    api.discoverTelegramSetupTargets.mockResolvedValue(discovery({ botIdentity: undefined }));
    const failure = await checkTelegramKey({ draftId: "draft-1", expectedRevision: 4, token: TOKEN }).catch(
      (error: unknown) => error,
    );
    expect(failure).toBeInstanceOf(Error);
    expect((failure as Error).message).not.toContain("SECRET-TOKEN");
    expect((failure as Error).message).not.toContain(TOKEN);
  });
});
