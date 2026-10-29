import { describe, expect, it, vi } from "vitest";
import type { ChannelSetupDraft, IntegrationConnection } from "@goatcitadel/contracts";
import { resolveConnectionConfigSecret } from "./channel-secret-resolution.js";
import { WHATSAPP_DETAILS_MISSING, checkWhatsAppSetup } from "./channel-setup-whatsapp-check.js";
import {
  createChannelSetupDraft,
  createChannelSetupRotateSecretDraft,
  finalizeChannelSetupDraft,
  setChannelSetupDraftSecrets,
  updateChannelSetupDraft,
} from "./channel-setup-service.js";
import { createChannelSetupTestHost } from "./channel-setup-service.test-support.js";

/**
 * Changing WhatsApp's access token from Chat: the key page makes a rotate-secret draft for the saved connection, stores
 * the new token on it, and asks for a check with `askMeta`. The draft carries the connection's IDs and no secret but the
 * new token, so the App secret has to come from the saved connection, read for that connection as its owner.
 *
 * Everything below runs over the real pieces: the setup service makes the saved connection the way a setup does (create,
 * paste, Finalize) and the rotate draft the way the route does, the secure-storage service holds the keys, and the keys
 * are read through the Gateway's shared read (`resolveConnectionConfigSecret`, which `GatewayService.resolveConnectionSecret`
 * calls with nothing added). Only Meta is a fake, and it notes what each request carried.
 */

const PHONE_NUMBER_ID = "106540352242922";
const BUSINESS_ACCOUNT_ID = "102290129340398";
const APP_ID = "670843887433847";
const OLD_TOKEN = "EAAG-OLD-access/token=11aa";
const NEW_TOKEN = "EAAG-NEW-access/token=22bb";
const APP_SECRET = "app-secret-saved-4f1c9e7a2b";
const OTHER_APP_SECRET = "app-secret-of-another-connection-9d3a6b";
const GRAPH = "https://graph.facebook.com/v23.0/";

type Host = ReturnType<typeof createChannelSetupTestHost>;
interface Call {
  verb: string;
  path: string;
  url: string;
  query: URLSearchParams;
  authorization: string | undefined;
}

/** What Meta says when everything is in order. */
const META: Record<string, unknown> = {
  [`GET ${PHONE_NUMBER_ID}`]: { display_phone_number: "+1 555-078-3881", verified_name: "Goat Shop" },
  "GET debug_token": { data: { app_id: APP_ID, is_valid: true, expires_at: 0 } },
  [`GET ${BUSINESS_ACCOUNT_ID}/phone_numbers`]: { data: [{ id: PHONE_NUMBER_ID }] },
  [`GET ${BUSINESS_ACCOUNT_ID}/subscribed_apps`]: {
    data: [{ whatsapp_business_api_data: { id: APP_ID, name: "Goat app" } }],
  },
};

/** A setup host over the real secure-storage service, reading keys as the Gateway does and talking to a fake Meta. */
function whatsAppHost() {
  const host = createChannelSetupTestHost();
  const custody = host.channelSecrets!;
  const storedKeys = {
    getSecret: (account: string) => {
      try {
        return custody.resolve(`keychain:goatcitadel:${account}`);
      } catch {
        return undefined;
      }
    },
  };
  host.resolveConnectionSecret = (config, directKey, envKey, catalogId, owner) =>
    resolveConnectionConfigSecret(storedKeys, config, directKey, envKey, catalogId, owner);
  const calls: Call[] = [];
  host.fetchWithTimeout = vi.fn(async (url: string, init?: RequestInit) => {
    const parsed = new URL(url);
    const verb = init?.method ?? "GET";
    const path = parsed.pathname.replace(/^\/v23\.0\//, "");
    const headers = (init?.headers ?? {}) as Record<string, string>;
    calls.push({ verb, path, url, query: parsed.searchParams, authorization: headers.Authorization });
    const body = META[`${verb} ${path}`];
    return new Response(JSON.stringify(body ?? { error: { code: 803 } }), { status: body ? 200 : 404 });
  });
  /** The check the key page asks for, at the draft's version, with Meta asked. */
  const askMeta = (draft: ChannelSetupDraft) =>
    checkWhatsAppSetup(
      host,
      { heard: () => ({}) },
      { draftId: draft.draftId, expectedRevision: draft.revision, askMeta: true },
    );
  return { host, calls, askMeta };
}

/** A saved WhatsApp connection made the way a setup makes one, with its keys in secure storage. */
async function saveWhatsAppConnection(
  host: Host,
  keys: { accessToken: string; appSecret: string },
): Promise<IntegrationConnection> {
  const created = await createChannelSetupDraft(host, { catalogId: "channel.whatsapp", lifecycleMode: "create" });
  const configured = await updateChannelSetupDraft(host, created.draftId, {
    expectedRevision: created.revision,
    label: "WhatsApp",
    draft: {
      phoneNumberId: PHONE_NUMBER_ID,
      businessAccountId: BUSINESS_ACCOUNT_ID,
      appId: APP_ID,
      defaultTarget: "+15550783881",
    },
  });
  const secured = await setChannelSetupDraftSecrets(host, created.draftId, {
    expectedRevision: configured.revision,
    values: keys,
  });
  return (await finalizeChannelSetupDraft(host, created.draftId, secured.revision)).connection;
}

/** The draft the key page makes: a rotate-secret draft for the saved connection with only the new token stored on it. */
async function rotateDraftWithNewToken(host: Host, connection: IntegrationConnection): Promise<ChannelSetupDraft> {
  const rotate = await createChannelSetupRotateSecretDraft(host, connection.connectionId);
  return setChannelSetupDraftSecrets(host, rotate.draftId, {
    expectedRevision: rotate.revision,
    values: { accessToken: NEW_TOKEN },
  });
}

describe("changing WhatsApp's access token: the check of a rotate-secret draft", () => {
  it("reads the saved connection's App secret and IDs, and asks Meta with the new token", async () => {
    const { host, calls, askMeta } = whatsAppHost();
    const saved = await saveWhatsAppConnection(host, { accessToken: OLD_TOKEN, appSecret: APP_SECRET });
    // The saved connection holds references into secure storage, never a key: the App secret can only be read as its owner.
    expect(saved.config.appSecret).toEqual(expect.stringMatching(/^keychain:goatcitadel:channel-connection:/u));
    expect(JSON.stringify(saved.config)).not.toContain(APP_SECRET);
    const draft = await rotateDraftWithNewToken(host, saved);

    // The draft is for the saved connection, holds its IDs, and holds no key but the new token.
    expect(draft).toMatchObject({ lifecycleMode: "rotate_secret", connectionId: saved.connectionId });
    expect(draft.draft).toMatchObject({
      phoneNumberId: PHONE_NUMBER_ID,
      businessAccountId: BUSINESS_ACCOUNT_ID,
      appId: APP_ID,
    });
    expect(Object.keys(draft.secretState)).toEqual(["accessToken"]);
    expect(JSON.stringify(draft)).not.toContain(APP_SECRET);
    expect(JSON.stringify(draft)).not.toContain(NEW_TOKEN);

    const result = await askMeta(draft);

    expect(result).toEqual({
      number: { displayNumber: "+1 555-078-3881", verifiedName: "Goat Shop" },
      appSubscribed: true,
    });
    expect(calls.map((call) => `${call.verb} ${call.path}`)).toEqual([
      `GET ${PHONE_NUMBER_ID}`,
      "GET debug_token",
      `GET ${BUSINESS_ACCOUNT_ID}/phone_numbers`,
      `GET ${BUSINESS_ACCOUNT_ID}/subscribed_apps`,
    ]);
    const [number, token, numbers, subscribed] = calls;
    // The new token is the bearer on every call that asks about the account, and the one thing `debug_token` is asked about.
    for (const call of [number, numbers, subscribed]) expect(call?.authorization).toBe(`Bearer ${NEW_TOKEN}`);
    expect(token?.query.get("input_token")).toBe(NEW_TOKEN);
    // The saved App ID and the saved App secret ask it, the secret read for the connection that owns it.
    expect(token?.authorization).toBe(`Bearer ${APP_ID}|${APP_SECRET}`);
    // The token that was replaced is never sent, and the App secret is sent only as `debug_token`'s bearer.
    for (const call of calls) {
      expect(`${call.url} ${call.authorization}`).not.toContain(OLD_TOKEN);
      expect(call.verb).toBe("GET");
      expect(call.url.startsWith(GRAPH)).toBe(true);
      if (call !== token) expect(`${call.url} ${call.authorization}`).not.toContain(APP_SECRET);
    }
    // A check only reads: the saved connection is as it was.
    expect(host.updateConnectionMock).not.toHaveBeenCalled();
    expect((await host.getIntegrationConnection(saved.connectionId)).config).toEqual(saved.config);
  });

  it("does not read another connection's App secret, and asks Meta nothing", async () => {
    const { host, calls, askMeta } = whatsAppHost();
    const mine = await saveWhatsAppConnection(host, { accessToken: OLD_TOKEN, appSecret: APP_SECRET });
    const theirs = await saveWhatsAppConnection(host, { accessToken: OLD_TOKEN, appSecret: OTHER_APP_SECRET });
    expect(theirs.connectionId).not.toBe(mine.connectionId);
    // A saved connection that was pointed at the other connection's reference for its App secret.
    host.updateConnectionMock(mine.connectionId, { config: { ...mine.config, appSecret: theirs.config.appSecret } });
    const draft = await rotateDraftWithNewToken(host, await host.getIntegrationConnection(mine.connectionId));

    const error = await askMeta(draft).then(
      () => undefined,
      (caught: unknown) => caught as Error,
    );

    expect(error?.message).toBe(WHATSAPP_DETAILS_MISSING);
    expect(calls).toHaveLength(0);
    expect([error?.message, error?.stack ?? ""].join("\n")).not.toContain(OTHER_APP_SECRET);
  });
});
