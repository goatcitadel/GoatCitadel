import { describe, expect, it, vi } from "vitest";
import { ChannelSecretCustodyService } from "./channel-secret-custody-service.js";
import type { ChannelSetupDraft } from "@goatcitadel/contracts";
import type { ChannelSetupHost } from "./channel-setup-service.js";
import { discoverChannelSetupTelegramTargets } from "./channel-setup-telegram-discovery.js";
const revision = "a".repeat(64);
function host(webhook = true): ChannelSetupHost {
  const connection = {
    connectionId: "connection",
    revision,
    catalogId: "channel.telegram",
    key: "telegram",
    kind: "channel",
    config: { botToken: "keychain:opaque", targets: [{ chatId: "123", label: "Home", default: true }] },
  };
  return {
    storage: {},
    getIntegrationConnection: vi.fn(async () => connection),
    resolveConnectionSecret: vi.fn(() => "test-token"),
    isConnectionUrlAllowlisted: () => true,
    fetchWithTimeout: vi.fn(
      async (url: string) =>
        new Response(
          JSON.stringify({
            ok: true,
            result: url.endsWith("getMe")
              ? { id: 42, username: "bot" }
              : url.endsWith("getWebhookInfo")
                ? { url: webhook ? "https://gateway.example/webhook" : "" }
                : [],
          }),
          { status: 200 },
        ),
    ),
  } as unknown as ChannelSetupHost;
}
describe("credential-safe Telegram discovery", () => {
  it("preserves active webhooks and shows configured destinations without getUpdates", async () => {
    const h = host();
    const response = await discoverChannelSetupTelegramTargets(h, {
      source: "connection",
      connectionId: "connection",
      expectedConnectionRevision: revision,
    });
    expect(response).toMatchObject({
      webhookActive: true,
      botIdentity: { id: "42" },
      items: [{ chatId: "123", source: "connection_config" }],
    });
    expect(h.fetchWithTimeout).toHaveBeenCalledTimes(2);
    expect(JSON.stringify(response)).not.toContain("keychain");
    expect(JSON.stringify(response)).not.toContain("test-token");
  });
  it("discovers from a revision-bound new draft using secure custody without re-entering credentials", async () => {
    const h = host();
    const values = new Map<string, string>();
    const custody = new ChannelSecretCustodyService({
      setSecret: (account: string, value: string) => void values.set(account, value),
      getSecret: (account: string) => values.get(account),
      deleteSecret: (account: string) => void values.delete(account),
    } as never);
    const draftId = "11111111-1111-1111-1111-111111111111";
    const secretRef = custody.storeTemporary(draftId, "botToken", "test-token");
    const draft = {
      draftId,
      revision: 3,
      catalogId: "channel.telegram",
      lifecycleMode: "create",
      draft: { defaultChatId: "123", inboundAccessMode: "allowlist" },
      secretState: { botToken: { configured: true, custody: "temporary", secretRef } },
      enabled: true,
      contentVersion: "content",
      testVersion: "test",
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    } as ChannelSetupDraft;
    h.storage.channelSetupDrafts = { get: vi.fn(async () => draft) } as never;
    h.channelSecrets = custody;
    const response = await discoverChannelSetupTelegramTargets(h, { source: "draft", draftId, expectedRevision: 3 });
    expect(response.botIdentity?.id).toBe("42");
    expect(h.resolveConnectionSecret).toHaveBeenCalledWith(
      expect.objectContaining({ botToken: "test-token" }),
      "botToken",
      "botTokenEnv",
      "channel.telegram",
    );
    expect(h.getIntegrationConnection).not.toHaveBeenCalled();
    expect(JSON.stringify(response)).not.toContain(secretRef);
    await expect(
      discoverChannelSetupTelegramTargets(h, { source: "draft", draftId, expectedRevision: 2 }),
    ).rejects.toThrow("changed");
  });
  it("fails a stale connection before making an external request", async () => {
    const h = host();
    await expect(
      discoverChannelSetupTelegramTargets(h, {
        source: "connection",
        connectionId: "connection",
        expectedConnectionRevision: "b".repeat(64),
      }),
    ).rejects.toThrow("changed");
    expect(h.fetchWithTimeout).not.toHaveBeenCalled();
  });
  it("fails a foreign-channel credential before making an external request", async () => {
    const h = host();
    h.getIntegrationConnection = vi.fn(async () => ({ key: "slack", kind: "channel" }) as never);
    await expect(
      discoverChannelSetupTelegramTargets(h, {
        source: "connection",
        connectionId: "connection",
        expectedConnectionRevision: revision,
      }),
    ).rejects.toThrow("Telegram");
  });
  it("never exposes a credential-bearing transport error", async () => {
    const h = host();
    h.fetchWithTimeout = vi.fn(async () => {
      throw new Error("Network failed https://api.telegram.org/bottest-token/getMe keychain:opaque");
    });
    await expect(
      discoverChannelSetupTelegramTargets(h, {
        source: "connection",
        connectionId: "connection",
        expectedConnectionRevision: revision,
      }),
    ).rejects.toThrow("could not complete");
    try {
      await discoverChannelSetupTelegramTargets(h, {
        source: "connection",
        connectionId: "connection",
        expectedConnectionRevision: revision,
      });
    } catch (error) {
      expect(String(error)).not.toContain("test-token");
      expect(String(error)).not.toContain("keychain");
    }
  });
  it("does not gate discovery on the sandbox network allowlist", async () => {
    const h = host(false);
    delete h.isConnectionUrlAllowlisted;
    const response = await discoverChannelSetupTelegramTargets(h, {
      source: "connection",
      connectionId: "connection",
      expectedConnectionRevision: revision,
    });
    expect(response.botIdentity?.id).toBe("42");
    expect(h.fetchWithTimeout).toHaveBeenCalledTimes(3);
    const refusing = host();
    refusing.isConnectionUrlAllowlisted = () => false;
    expect(
      (
        await discoverChannelSetupTelegramTargets(refusing, {
          source: "connection",
          connectionId: "connection",
          expectedConnectionRevision: revision,
        })
      ).webhookActive,
    ).toBe(true);
  });
  it("does not treat an identity conflict as authenticated discovery", async () => {
    const h = host();
    h.fetchWithTimeout = vi.fn(async () => new Response(JSON.stringify({ ok: false }), { status: 409 }));
    await expect(
      discoverChannelSetupTelegramTargets(h, {
        source: "connection",
        connectionId: "connection",
        expectedConnectionRevision: revision,
      }),
    ).rejects.toThrow("could not complete");
    expect(h.fetchWithTimeout).toHaveBeenCalledOnce();
  });
});

describe("Telegram discovery setup-code sender and webhook clearing", () => {
  const code = "Ab3dEf7hJk";
  const draftId = "11111111-1111-1111-1111-111111111111";
  const connectionInput = {
    source: "connection" as const,
    connectionId: "connection",
    expectedConnectionRevision: revision,
  };
  const startUpdate = (updateId: number, text: string) => ({
    update_id: updateId,
    message: {
      message_id: updateId,
      text,
      from: { id: 42, first_name: "Sam", last_name: "Lee", username: "sam" },
      chat: { id: 42, type: "private", first_name: "Sam", last_name: "Lee" },
    },
  });
  /**
   * A Bot API fake: records each call (method and query) and answers getUpdates from a queue of waiting updates. Like
   * Telegram, a plain getUpdates returns the oldest 100; `offset=-1` returns the newest and forgets every update
   * before it. `sentAfterSkip` arrives once that has happened.
   */
  function bot(
    options: { updates?: unknown[]; getUpdatesStatus?: number; webhookUrl?: string; sentAfterSkip?: unknown[] } = {},
  ) {
    let webhookUrl = options.webhookUrl ?? "";
    let waiting = [...(options.updates ?? [])];
    const methods: string[] = [];
    const urls: string[] = [];
    const fetchWithTimeout = vi.fn(async (url: string) => {
      const call = url.slice(url.lastIndexOf("/") + 1);
      const method = call.split("?", 1)[0]!;
      methods.push(call);
      urls.push(url);
      if (method === "deleteWebhook") webhookUrl = "";
      if (method === "getUpdates" && options.getUpdatesStatus)
        return new Response(JSON.stringify({ ok: false }), { status: options.getUpdatesStatus });
      let result: unknown = true;
      if (method === "getMe") result = { id: 42, username: "bot" };
      else if (method === "getWebhookInfo") result = { url: webhookUrl };
      else if (method === "getUpdates" && call.includes("offset=-1")) {
        result = waiting.slice(-1);
        waiting = [...waiting.slice(-1), ...(options.sentAfterSkip ?? [])];
      } else if (method === "getUpdates") result = waiting.slice(0, 100);
      return new Response(JSON.stringify({ ok: true, result }), { status: 200 });
    });
    return { fetchWithTimeout, methods, urls };
  }
  function draftHost(
    fetchWithTimeout: ChannelSetupHost["fetchWithTimeout"],
    token = "test-token",
    overrides: Partial<ChannelSetupDraft> = {},
  ): ChannelSetupHost {
    const h = host(false);
    const values = new Map<string, string>();
    const custody = new ChannelSecretCustodyService({
      setSecret: (account: string, value: string) => void values.set(account, value),
      getSecret: (account: string) => values.get(account),
      deleteSecret: (account: string) => void values.delete(account),
    } as never);
    const secretRef = custody.storeTemporary(draftId, "botToken", token);
    const draft = {
      draftId,
      revision: 3,
      catalogId: "channel.telegram",
      lifecycleMode: "create",
      draft: { defaultChatId: "123", inboundAccessMode: "allowlist" },
      secretState: { botToken: { configured: true, custody: "temporary", secretRef } },
      enabled: true,
      contentVersion: "content",
      testVersion: "test",
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      ...overrides,
    } as ChannelSetupDraft;
    h.storage.channelSetupDrafts = { get: vi.fn(async () => draft) } as never;
    h.channelSecrets = custody;
    h.resolveConnectionSecret = vi.fn((config: Record<string, unknown>) => String(config.botToken)) as never;
    h.fetchWithTimeout = fetchWithTimeout;
    return h;
  }

  it("returns the code sender when the setup code matches", async () => {
    const telegram = bot({ updates: [startUpdate(1, "hello"), startUpdate(2, `/start ${code}`)] });
    const h = host(false);
    h.fetchWithTimeout = telegram.fetchWithTimeout;
    const response = await discoverChannelSetupTelegramTargets(h, { ...connectionInput, setupCode: code });
    expect(response.codeSender).toEqual({ actorId: "42", chatId: "42", displayName: "Sam Lee", username: "sam" });
    expect(response.updatesTruncated).toBeUndefined();
    expect(response.updatesConflict).toBeUndefined();
    const without = await discoverChannelSetupTelegramTargets(h, connectionInput);
    expect(without.codeSender).toBeUndefined();
    const other = await discoverChannelSetupTelegramTargets(h, { ...connectionInput, setupCode: "another-code" });
    expect(other.codeSender).toBeUndefined();
  });

  it("clears the webhook before reading updates when asked", async () => {
    const telegram = bot({
      webhookUrl: "https://gateway.example/webhook",
      updates: [startUpdate(1, `/start ${code}`)],
    });
    const h = draftHost(telegram.fetchWithTimeout);
    const response = await discoverChannelSetupTelegramTargets(h, {
      source: "draft",
      draftId,
      expectedRevision: 3,
      setupCode: code,
      clearWebhook: true,
    });
    expect(telegram.methods).toEqual(["getMe", "deleteWebhook", "getWebhookInfo", "getUpdates"]);
    expect(telegram.urls[1]).toBe("https://api.telegram.org/bottest-token/deleteWebhook");
    expect(response.webhookActive).toBe(false);
    expect(response.codeSender?.actorId).toBe("42");
  });

  it("keeps an active webhook unless clearing is asked for on a draft", async () => {
    const preserved = bot({ webhookUrl: "https://gateway.example/webhook" });
    const draftResponse = await discoverChannelSetupTelegramTargets(draftHost(preserved.fetchWithTimeout), {
      source: "draft",
      draftId,
      expectedRevision: 3,
      setupCode: code,
    });
    expect(preserved.methods).toEqual(["getMe", "getWebhookInfo"]);
    expect(draftResponse).toMatchObject({ webhookActive: true });
    expect(draftResponse.codeSender).toBeUndefined();
    const connection = bot({ webhookUrl: "https://gateway.example/webhook" });
    const h = host(false);
    h.fetchWithTimeout = connection.fetchWithTimeout;
    await discoverChannelSetupTelegramTargets(h, { ...connectionInput, clearWebhook: true } as never);
    expect(connection.methods).toEqual(["getMe", "getWebhookInfo"]);
  });

  it("marks a full page of updates", async () => {
    const full = bot({ updates: Array.from({ length: 100 }, (_, index) => startUpdate(index + 1, "hello")) });
    const h = host(false);
    h.fetchWithTimeout = full.fetchWithTimeout;
    const response = await discoverChannelSetupTelegramTargets(h, { ...connectionInput, setupCode: code });
    expect(response.updatesTruncated).toBe(true);
    expect(response.codeSender).toBeUndefined();
    const short = bot({ updates: Array.from({ length: 99 }, (_, index) => startUpdate(index + 1, "hello")) });
    h.fetchWithTimeout = short.fetchWithTimeout;
    expect(
      (await discoverChannelSetupTelegramTargets(h, { ...connectionInput, setupCode: code })).updatesTruncated,
    ).toBeUndefined();
  });

  it("marks another reader", async () => {
    const h = host(false);
    h.fetchWithTimeout = bot({ getUpdatesStatus: 409 }).fetchWithTimeout;
    const response = await discoverChannelSetupTelegramTargets(h, { ...connectionInput, setupCode: code });
    expect(response.updatesConflict).toBe(true);
    expect(response.warnings).toEqual([
      "Telegram reports another active update consumer. Keep its delivery mode and choose a configured destination or enter one manually.",
    ]);
    expect(response.codeSender).toBeUndefined();
  });

  it("never puts the bot key in its error", async () => {
    const leaky = vi.fn(async (url: string) => {
      if (url.endsWith("getMe") || url.endsWith("getWebhookInfo"))
        return new Response(JSON.stringify({ ok: true, result: { id: 42, url: "" } }), { status: 200 });
      throw new Error(
        `request to https://api.telegram.org/bot123:SECRET/${url.slice(url.lastIndexOf("/") + 1)} failed`,
      );
    });
    for (const asked of [{}, { clearWebhook: true as const }, { skipWaiting: true as const }]) {
      const h = draftHost(leaky as never, "123:SECRET");
      const failure = await discoverChannelSetupTelegramTargets(h, {
        source: "draft",
        draftId,
        expectedRevision: 3,
        ...asked,
      }).then(
        () => undefined,
        (error: unknown) => error,
      );
      expect(failure).toBeInstanceOf(Error);
      expect(String((failure as Error).message)).not.toContain("123:SECRET");
      expect(String((failure as Error).message)).toContain("could not complete");
    }
  });

  describe("clearing a backlog that hides the hi", () => {
    const SKIP = "getUpdates?offset=-1&limit=1&timeout=0";
    const draftInput = { source: "draft" as const, draftId, expectedRevision: 3, setupCode: code };
    const backlog = () => Array.from({ length: 150 }, (_, index) => startUpdate(index + 1, "hello"));

    it("cannot see the hi past a full page of waiting messages until they are cleared", async () => {
      const telegram = bot({ updates: backlog(), sentAfterSkip: [startUpdate(151, `/start ${code}`)] });
      const stuck = await discoverChannelSetupTelegramTargets(draftHost(telegram.fetchWithTimeout), draftInput);
      expect(stuck.updatesTruncated).toBe(true);
      expect(stuck.codeSender).toBeUndefined();
      expect(telegram.methods).toEqual(["getMe", "getWebhookInfo", "getUpdates"]);
    });

    it("confirms what is waiting once, then looks, and finds a code sent after", async () => {
      const telegram = bot({ updates: backlog(), sentAfterSkip: [startUpdate(151, `/start ${code}`)] });
      const response = await discoverChannelSetupTelegramTargets(draftHost(telegram.fetchWithTimeout), {
        ...draftInput,
        skipWaiting: true,
      });
      expect(telegram.methods).toEqual(["getMe", "getWebhookInfo", SKIP, "getUpdates"]);
      expect(telegram.urls[2]).toBe(`https://api.telegram.org/bottest-token/${SKIP}`);
      expect(response.codeSender?.actorId).toBe("42");
      expect(response.updatesTruncated).toBeUndefined();
      expect(response.updatesConflict).toBeUndefined();
    });

    it("skips only after the web address is cleared, when asked to clear it too", async () => {
      const telegram = bot({
        webhookUrl: "https://gateway.example/webhook",
        updates: backlog(),
        sentAfterSkip: [startUpdate(151, `/start ${code}`)],
      });
      const response = await discoverChannelSetupTelegramTargets(draftHost(telegram.fetchWithTimeout), {
        ...draftInput,
        clearWebhook: true,
        skipWaiting: true,
      });
      expect(telegram.methods).toEqual(["getMe", "deleteWebhook", "getWebhookInfo", SKIP, "getUpdates"]);
      expect(response.codeSender?.actorId).toBe("42");
    });

    it("does not skip unless asked", async () => {
      const telegram = bot({ updates: backlog() });
      await discoverChannelSetupTelegramTargets(draftHost(telegram.fetchWithTimeout), draftInput);
      expect(telegram.methods).toEqual(["getMe", "getWebhookInfo", "getUpdates"]);
    });

    it("does not skip while a web address is active", async () => {
      const telegram = bot({ webhookUrl: "https://gateway.example/webhook", updates: backlog() });
      const response = await discoverChannelSetupTelegramTargets(draftHost(telegram.fetchWithTimeout), {
        ...draftInput,
        skipWaiting: true,
      });
      expect(telegram.methods).toEqual(["getMe", "getWebhookInfo"]);
      expect(response.webhookActive).toBe(true);
    });

    it("does not skip, and reports the other reader, when Telegram answers 409", async () => {
      const telegram = bot({ getUpdatesStatus: 409, updates: backlog() });
      const response = await discoverChannelSetupTelegramTargets(draftHost(telegram.fetchWithTimeout), {
        ...draftInput,
        skipWaiting: true,
      });
      expect(response.updatesConflict).toBe(true);
      expect(response.warnings).toEqual([
        "Telegram reports another active update consumer. Keep its delivery mode and choose a configured destination or enter one manually.",
      ]);
      expect(response.codeSender).toBeUndefined();
      expect(telegram.methods).toEqual(["getMe", "getWebhookInfo", SKIP]);
    });

    it("refuses a draft that belongs to a live connection, before asking Telegram anything", async () => {
      const telegram = bot({ updates: backlog() });
      const h = draftHost(telegram.fetchWithTimeout, "test-token", {
        connectionId: "connection",
        lifecycleMode: "rotate_secret",
      });
      await expect(discoverChannelSetupTelegramTargets(h, { ...draftInput, skipWaiting: true })).rejects.toThrow(
        "Waiting messages can only be cleared while setting up a new Telegram channel.",
      );
      expect(telegram.methods).toEqual([]);
    });

    it("never puts the bot key in a failure to confirm what is waiting", async () => {
      const failing = vi.fn(async (url: string) => {
        if (url.includes("offset=-1")) throw new Error(`request to ${url} failed`);
        return new Response(JSON.stringify({ ok: true, result: url.endsWith("getMe") ? { id: 42 } : { url: "" } }), {
          status: 200,
        });
      });
      const failure = await discoverChannelSetupTelegramTargets(draftHost(failing as never, "123:SECRET"), {
        ...draftInput,
        skipWaiting: true,
      }).then(
        () => undefined,
        (error: unknown) => error,
      );
      expect(failure).toBeInstanceOf(Error);
      expect(String((failure as Error).message)).not.toContain("123:SECRET");
      expect(String((failure as Error).message)).toContain("could not complete");
    });
  });
});
