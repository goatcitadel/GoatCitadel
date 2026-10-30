import { describe, expect, it, vi } from "vitest";
import type { ChannelSetupDraft } from "@goatcitadel/contracts";
import type { ChannelSetupHost } from "./channel-setup-service.js";
import type { WhatsAppSetupHeard } from "./whatsapp-setup-listener.js";
import {
  WHATSAPP_ACCOUNT_NOT_FOUND,
  WHATSAPP_APP_REJECTED,
  WHATSAPP_DETAILS_MISSING,
  WHATSAPP_DRAFT_ONLY,
  WHATSAPP_META_REFUSED,
  WHATSAPP_NUMBER_NOT_FOUND,
  WHATSAPP_NUMBER_NOT_IN_ACCOUNT,
  WHATSAPP_OTHER_APP,
  WHATSAPP_SUBSCRIBE_REFUSED,
  WHATSAPP_TOKEN_REJECTED,
  WHATSAPP_UNREACHABLE,
  checkWhatsAppSetup,
  subscribeWhatsAppSetupApp,
} from "./channel-setup-whatsapp-check.js";

const draftId = "11111111-1111-4111-8111-111111111111";
const PHONE_NUMBER_ID = "106540352242922";
const BUSINESS_ACCOUNT_ID = "102290129340398";
const APP_ID = "670843887433847";
/** Characters a URL has to escape, so a token placed in an address anywhere else would show. */
const ACCESS_TOKEN = "EAAG+access/token=77aa";
const APP_SECRET = "app-secret-4f1c9e7a2b";
const VERIFY_TOKEN = "verify-token-9d3a6b";
const APP_TOKEN = `${APP_ID}|${APP_SECRET}`;
const CODE = "Kp4mZ9qRtW";
const GRAPH = "https://graph.facebook.com/v23.0/";

type Reply = { status?: number; body?: unknown };
type Call = {
  verb: string;
  path: string;
  url: string;
  query: URLSearchParams;
  init: RequestInit | undefined;
  authorization: string | undefined;
};
type Script = Record<string, Reply | ((call: Call) => Reply)>;

const NUMBER = { display_phone_number: "+1 555-078-3881", verified_name: "Goat Shop" };
const TOKEN_DATA = { app_id: APP_ID, is_valid: true, expires_at: 0 };
const SUBSCRIBED = { data: [{ whatsapp_business_api_data: { id: APP_ID, name: "Goat app" } }] };

function whatsAppDraft(
  values: Record<string, unknown> = {},
  overrides: Partial<ChannelSetupDraft> = {},
): ChannelSetupDraft {
  return {
    draftId,
    revision: 3,
    catalogId: "channel.whatsapp",
    lifecycleMode: "create",
    draft: {
      setupPage: "messaging",
      phoneNumberId: PHONE_NUMBER_ID,
      businessAccountId: BUSINESS_ACCOUNT_ID,
      appId: APP_ID,
      ...values,
    },
    secretState: {},
    enabled: true,
    contentVersion: "content",
    testVersion: "test",
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    ...overrides,
  } as ChannelSetupDraft;
}

/** What Meta says for a number, a token, an account's numbers and its subscribed apps, when everything is in order. */
const happy = (): Script => ({
  [`GET ${PHONE_NUMBER_ID}`]: { body: NUMBER },
  "GET debug_token": { body: { data: TOKEN_DATA } },
  [`GET ${BUSINESS_ACCOUNT_ID}/phone_numbers`]: {
    body: { data: [{ id: "100000000000001" }, { id: PHONE_NUMBER_ID }] },
  },
  [`GET ${BUSINESS_ACCOUNT_ID}/subscribed_apps`]: { body: SUBSCRIBED },
  [`POST ${BUSINESS_ACCOUNT_ID}/subscribed_apps`]: { body: { success: true } },
});

/**
 * A setup host whose Meta answers from `script`, keyed `VERB path` (for example `GET debug_token`). A saved key reads
 * by the field it is asked for, so a missing one is a key left out of `tokens`. The listener hears `heard`.
 */
function fakeHost(
  script: Script,
  options: {
    draft?: ChannelSetupDraft;
    tokens?: Record<string, string | undefined>;
    heard?: WhatsAppSetupHeard;
    channelSecrets?: unknown;
    getIntegrationConnection?: unknown;
  } = {},
) {
  const calls: Call[] = [];
  const fetchWithTimeout = vi.fn(async (url: string, init?: RequestInit) => {
    const parsed = new URL(url);
    const verb = init?.method ?? "GET";
    const path = parsed.pathname.replace(/^\/v23\.0\//, "");
    const headers = (init?.headers ?? {}) as Record<string, string>;
    const call = { verb, path, url, query: parsed.searchParams, init, authorization: headers.Authorization };
    calls.push(call);
    const entry = script[`${verb} ${path}`];
    if (!entry) return new Response(JSON.stringify({ error: { code: 803 } }), { status: 404 });
    const reply = typeof entry === "function" ? entry(call) : entry;
    return new Response(JSON.stringify(reply.body ?? {}), { status: reply.status ?? 200 });
  });
  const draft = options.draft ?? whatsAppDraft();
  const tokens = options.tokens ?? { accessToken: ACCESS_TOKEN, appSecret: APP_SECRET };
  const resolveConnectionSecret = vi.fn((_config: unknown, directKey: string) => tokens[directKey]);
  const host = {
    storage: { channelSetupDrafts: { get: vi.fn(async () => draft) } },
    fetchWithTimeout,
    resolveConnectionSecret,
    channelSecrets: options.channelSecrets,
    getIntegrationConnection: options.getIntegrationConnection,
  } as unknown as ChannelSetupHost;
  const heard = vi.fn((_draftId: string): WhatsAppSetupHeard => options.heard ?? {});
  return { host, calls, fetchWithTimeout, resolveConnectionSecret, listener: { heard } };
}

type Fake = ReturnType<typeof fakeHost>;
const check = (fake: Fake, extra: { askMeta?: boolean; setupCode?: string } = {}) =>
  checkWhatsAppSetup(fake.host, fake.listener, { draftId, expectedRevision: 3, ...extra });
const subscribe = (fake: Fake) => subscribeWhatsAppSetupApp(fake.host, { draftId, expectedRevision: 3 });
const ask = (fake: Fake) => check(fake, { askMeta: true });
const names = (calls: Call[]) => calls.map((call) => `${call.verb} ${call.path}`);

/** The error a call ends in, whatever it is, so a test can look at everything it carries. */
async function failure(promise: Promise<unknown>): Promise<Error> {
  const caught = await promise.then(
    () => undefined,
    (error: unknown) => error,
  );
  expect(caught).toBeInstanceOf(Error);
  return caught as Error;
}

/** A refusal is a fixed sentence: nothing Meta said, no key and no address is in anything it carries. */
function expectOnlyThe(error: Error, sentence: string) {
  expect(error.message).toBe(sentence);
  const everything = [error.message, error.stack ?? "", JSON.stringify(error), String(error.cause ?? "")].join("\n");
  for (const secret of [ACCESS_TOKEN, encodeURIComponent(ACCESS_TOKEN), APP_SECRET, VERIFY_TOKEN, APP_TOKEN]) {
    expect(everything).not.toContain(secret);
  }
  for (const word of ["input_token", "graph.facebook.com", "Bearer", "access_token"]) {
    expect(everything).not.toContain(word);
  }
}

/** Meta's refusal, carrying the keys and an address the way a careless vendor error can. */
const leaky = (status: number, code?: number): Reply => ({
  status,
  body: {
    error: {
      message: `Invalid token ${ACCESS_TOKEN} for ${GRAPH}debug_token?input_token=${ACCESS_TOKEN} ${APP_TOKEN}`,
      code,
    },
  },
});

describe("WhatsApp setup check", () => {
  describe("asking Meta", () => {
    it("names the number and says the token never expires", async () => {
      const fake = fakeHost(happy());
      const result = await ask(fake);
      expect(result).toEqual({
        number: { displayNumber: "+1 555-078-3881", verifiedName: "Goat Shop" },
        appSubscribed: true,
      });
      expect(result).not.toHaveProperty("tokenExpiresAt");
      expect(result).not.toHaveProperty("addressCheckedAt");
      expect(result).not.toHaveProperty("codeSender");
    });

    it("says when a short-lived token stops working", async () => {
      const script = {
        ...happy(),
        "GET debug_token": { body: { data: { ...TOKEN_DATA, expires_at: 1767225600 } } },
      };
      const result = await ask(fakeHost(script));
      expect(result.tokenExpiresAt).toBe("2026-01-01T00:00:00.000Z");
      expect(result.appSubscribed).toBe(true);
    });

    it("says the app is not subscribed when the account lists other apps or none", async () => {
      for (const body of [
        { data: [] },
        { data: [{ whatsapp_business_api_data: { id: "999999999999999", name: "Other app" } }] },
        { data: [{ whatsapp_business_api_data: {} }, {}, "x"] },
      ]) {
        const fake = fakeHost({ ...happy(), [`GET ${BUSINESS_ACCOUNT_ID}/subscribed_apps`]: { body } });
        expect((await ask(fake)).appSubscribed).toBe(false);
      }
    });

    it("asks Meta in a fixed order with the right credentials", async () => {
      const fake = fakeHost(happy());
      await ask(fake);
      expect(names(fake.calls)).toEqual([
        `GET ${PHONE_NUMBER_ID}`,
        "GET debug_token",
        `GET ${BUSINESS_ACCOUNT_ID}/phone_numbers`,
        `GET ${BUSINESS_ACCOUNT_ID}/subscribed_apps`,
      ]);
      const [number, token, numbers, subscribed] = fake.calls;
      expect(number?.url).toBe(`${GRAPH}${PHONE_NUMBER_ID}?fields=display_phone_number,verified_name`);
      expect(numbers?.url).toBe(`${GRAPH}${BUSINESS_ACCOUNT_ID}/phone_numbers?fields=id&limit=100`);
      expect(subscribed?.url).toBe(`${GRAPH}${BUSINESS_ACCOUNT_ID}/subscribed_apps`);
      // The access token is a bearer header, and the one thing `debug_token` is asked about.
      for (const call of [number, numbers, subscribed]) {
        expect(call?.authorization).toBe(`Bearer ${ACCESS_TOKEN}`);
      }
      expect(token?.authorization).toBe(`Bearer ${APP_TOKEN}`);
      expect(token?.query.get("input_token")).toBe(ACCESS_TOKEN);
      expect([...(token?.query.keys() ?? [])]).toEqual(["input_token"]);
      // Nothing else carries a key: not an address (the escaped token only in `input_token`), and not a body.
      for (const call of fake.calls) {
        expect(call.verb).toBe("GET");
        expect(call.init?.body).toBeUndefined();
        expect(call.url).not.toContain(APP_SECRET);
        if (call !== token) {
          expect(call.url).not.toContain(ACCESS_TOKEN);
          expect(call.url).not.toContain(encodeURIComponent(ACCESS_TOKEN));
        }
        if (call !== token) expect(call.authorization).not.toContain(APP_SECRET);
      }
      expect(token?.authorization).not.toContain(ACCESS_TOKEN);
    });

    it("reads the draft's own two keys as the owner of that draft, and no other", async () => {
      const fake = fakeHost(happy());
      await ask(fake);
      expect(fake.resolveConnectionSecret.mock.calls.map((call) => call.slice(1))).toEqual([
        ["accessToken", "accessTokenEnv", "channel.whatsapp", { connectionId: draftId, draftId }],
        ["appSecret", "appSecretEnv", "channel.whatsapp", { connectionId: draftId, draftId }],
      ]);
    });

    it("takes only the access token and the app secret out of secure storage, never the verify token", async () => {
      const resolve = vi.fn((reference: string) => `stored:${reference}`);
      const state = (secretRef: string) => ({ configured: true, secretRef, custody: "temporary", source: "inherited" });
      const draft = whatsAppDraft({}, {
        secretState: {
          accessToken: state("ref-access"),
          appSecret: state("ref-secret"),
          webhookVerifyToken: state("ref-verify"),
        },
      } as Partial<ChannelSetupDraft>);
      const fake = fakeHost(happy(), {
        draft,
        channelSecrets: { assertUsableForDraft: vi.fn(), resolve },
      });
      await ask(fake);
      expect(resolve.mock.calls.map((call) => call[0])).toEqual(["ref-access", "ref-secret"]);
      const [config] = fake.resolveConnectionSecret.mock.calls[0] as [Record<string, unknown>];
      expect(config).toMatchObject({ accessToken: "stored:ref-access", appSecret: "stored:ref-secret" });
      expect(config).not.toHaveProperty("webhookVerifyToken");
    });

    it("adds what the listener heard", async () => {
      const heard = {
        addressCheckedAt: "2026-10-29T12:00:00.000Z",
        code: CODE,
        codeSender: { actorId: "16505551234", displayName: "Sheena" },
      };
      const fake = fakeHost(happy(), { heard });
      const result = await check(fake, { askMeta: true, setupCode: CODE });
      expect(result).toEqual({
        number: { displayNumber: "+1 555-078-3881", verifiedName: "Goat Shop" },
        appSubscribed: true,
        addressCheckedAt: "2026-10-29T12:00:00.000Z",
        codeSender: { actorId: "16505551234", displayName: "Sheena" },
      });
      expect(fake.listener.heard).toHaveBeenCalledExactlyOnceWith(draftId);
    });

    it("reads a saved connection's own details for a rotate draft", async () => {
      const connectionId = "22222222-2222-4222-8222-222222222222";
      const connectionRevision = "a".repeat(64);
      const draft = whatsAppDraft({ phoneNumberId: undefined, businessAccountId: undefined, appId: undefined }, {
        lifecycleMode: "rotate_secret",
        connectionId,
        connectionRevision,
      } as Partial<ChannelSetupDraft>);
      const saved = {
        revision: connectionRevision,
        config: { phoneNumberId: PHONE_NUMBER_ID, businessAccountId: BUSINESS_ACCOUNT_ID, appId: APP_ID },
      };
      const fake = fakeHost(happy(), { draft, getIntegrationConnection: vi.fn(async () => saved) });
      const result = await ask(fake);
      expect(result.appSubscribed).toBe(true);
      expect(fake.resolveConnectionSecret.mock.calls[0]?.[4]).toEqual({ connectionId, draftId });
      expect(names(fake.calls)[0]).toBe(`GET ${PHONE_NUMBER_ID}`);
    });
  });

  describe("what Meta refuses", () => {
    const cases: Array<[string, Script, string, number]> = [
      ["a 401 on the number", { ...happy(), [`GET ${PHONE_NUMBER_ID}`]: leaky(401) }, WHATSAPP_TOKEN_REJECTED, 1],
      [
        "a 400 with code 100 on the number",
        { ...happy(), [`GET ${PHONE_NUMBER_ID}`]: leaky(400, 100) },
        WHATSAPP_NUMBER_NOT_FOUND,
        1,
      ],
      [
        "a 401 with no body on the number",
        { ...happy(), [`GET ${PHONE_NUMBER_ID}`]: { status: 401 } },
        WHATSAPP_TOKEN_REJECTED,
        1,
      ],
      [
        "a 400 with code 190 on the number",
        { ...happy(), [`GET ${PHONE_NUMBER_ID}`]: leaky(400, 190) },
        WHATSAPP_TOKEN_REJECTED,
        1,
      ],
      [
        "a 401 with code 190 on the number",
        { ...happy(), [`GET ${PHONE_NUMBER_ID}`]: leaky(401, 190) },
        WHATSAPP_TOKEN_REJECTED,
        1,
      ],
      [
        "code 190 on the account's numbers",
        { ...happy(), [`GET ${BUSINESS_ACCOUNT_ID}/phone_numbers`]: leaky(400, 190) },
        WHATSAPP_TOKEN_REJECTED,
        3,
      ],
      [
        "code 190 on the account's subscribed apps",
        { ...happy(), [`GET ${BUSINESS_ACCOUNT_ID}/subscribed_apps`]: leaky(400, 190) },
        WHATSAPP_TOKEN_REJECTED,
        4,
      ],
      // The app token asks `debug_token`, so a refusal there is about the App ID and secret, not about the access token.
      ["a 400 on debug_token", { ...happy(), "GET debug_token": leaky(400, 190) }, WHATSAPP_APP_REJECTED, 2],
      [
        "a token that is not valid",
        { ...happy(), "GET debug_token": { body: { data: { ...TOKEN_DATA, is_valid: false } } } },
        WHATSAPP_TOKEN_REJECTED,
        2,
      ],
      [
        "a token made for another app",
        { ...happy(), "GET debug_token": { body: { data: { ...TOKEN_DATA, app_id: "999999999999999" } } } },
        WHATSAPP_OTHER_APP,
        2,
      ],
      [
        "a 400 on the account's numbers",
        { ...happy(), [`GET ${BUSINESS_ACCOUNT_ID}/phone_numbers`]: leaky(400, 100) },
        WHATSAPP_ACCOUNT_NOT_FOUND,
        3,
      ],
      [
        "a list of numbers without the number",
        { ...happy(), [`GET ${BUSINESS_ACCOUNT_ID}/phone_numbers`]: { body: { data: [{ id: "100000000000001" }] } } },
        WHATSAPP_NUMBER_NOT_IN_ACCOUNT,
        3,
      ],
    ];

    it.each(cases)("says so for %s, with only its fixed sentence", async (_name, script, sentence, asked) => {
      const fake = fakeHost(script);
      expectOnlyThe(await failure(ask(fake)), sentence);
      // It stops at the first refusal.
      expect(fake.calls).toHaveLength(asked);
    });

    it("reads code 190 as the access token being refused, whatever the HTTP status, on every call that uses it", async () => {
      // 190 is Graph's access-token error: an expired temporary token must not read as "couldn't reach Meta".
      const tokenCalls: Array<[string, number]> = [
        [`GET ${PHONE_NUMBER_ID}`, 1],
        [`GET ${BUSINESS_ACCOUNT_ID}/phone_numbers`, 3],
        [`GET ${BUSINESS_ACCOUNT_ID}/subscribed_apps`, 4],
      ];
      for (const [call, asked] of tokenCalls) {
        for (const status of [200, 400, 401, 403, 500]) {
          const fake = fakeHost({ ...happy(), [call]: leaky(status, 190) });
          expectOnlyThe(await failure(ask(fake)), WHATSAPP_TOKEN_REJECTED);
          expect(fake.calls, `${call} ${status}`).toHaveLength(asked);
        }
      }
    });

    it("says Meta was unreachable when a call rejects, whatever the rejection quotes", async () => {
      for (const failing of [0, 1, 2, 3]) {
        const fake = fakeHost(happy());
        const answers = fake.fetchWithTimeout.getMockImplementation()!;
        let seen = -1;
        fake.fetchWithTimeout.mockImplementation(async (url: string, init?: RequestInit) => {
          seen += 1;
          if (seen !== failing) return answers(url, init);
          throw Object.assign(new Error(`request to ${url} failed: Authorization: Bearer ${ACCESS_TOKEN}`), {
            cause: new Error(`${APP_TOKEN} ${url}`),
          });
        });
        expectOnlyThe(await failure(ask(fake)), WHATSAPP_UNREACHABLE);
        // Every call before the failing one was answered, so the failure is the one asked about.
        expect(seen).toBe(failing);
      }
    });

    it("says Meta refused the request for any other refusal Meta answered, reading only its code", async () => {
      const refusals: Array<[string, Script, number]> = [
        ["a 403 on the number", { ...happy(), [`GET ${PHONE_NUMBER_ID}`]: leaky(403, 200) }, 1],
        ["a rate limit on the number", { ...happy(), [`GET ${PHONE_NUMBER_ID}`]: leaky(429, 4) }, 1],
        ["a 404 on the number", { ...happy(), [`GET ${PHONE_NUMBER_ID}`]: leaky(404, 803) }, 1],
        ["a 400 that is not a missing number", { ...happy(), [`GET ${PHONE_NUMBER_ID}`]: leaky(400, 10) }, 1],
        ["a 401 on debug_token", { ...happy(), "GET debug_token": leaky(401, 102) }, 2],
        [
          "a 429 on the account's numbers",
          { ...happy(), [`GET ${BUSINESS_ACCOUNT_ID}/phone_numbers`]: leaky(429, 4) },
          3,
        ],
        [
          "a 403 on the account's numbers",
          { ...happy(), [`GET ${BUSINESS_ACCOUNT_ID}/phone_numbers`]: leaky(403, 200) },
          3,
        ],
        [
          "a 400 with code 10 on the account's subscribed apps",
          { ...happy(), [`GET ${BUSINESS_ACCOUNT_ID}/subscribed_apps`]: leaky(400, 10) },
          4,
        ],
        [
          "a 403 on the account's subscribed apps",
          { ...happy(), [`GET ${BUSINESS_ACCOUNT_ID}/subscribed_apps`]: leaky(403, 200) },
          4,
        ],
      ];
      for (const [name, script, asked] of refusals) {
        const fake = fakeHost(script);
        expectOnlyThe(await failure(ask(fake)), WHATSAPP_META_REFUSED);
        // It stops at the refusal.
        expect(fake.calls, name).toHaveLength(asked);
      }
    });

    it("says Meta was unreachable when it is down or its answer can't be read, without quoting the answer", async () => {
      const unusable: Array<[string, Reply]> = [
        ["a busy Meta", leaky(500)],
        ["a Meta that is down", leaky(503, 2)],
        ["a 400 with no reason", { status: 400, body: {} }],
        ["a 404 without Meta's error code", leaky(404)],
        ["an answer with no number", { body: { id: PHONE_NUMBER_ID } }],
        ["an answer with no name", { body: { display_phone_number: "+1 555-078-3881" } }],
        ["an answer that is a list", { body: [] }],
      ];
      for (const [, reply] of unusable) {
        const fake = fakeHost({ ...happy(), [`GET ${PHONE_NUMBER_ID}`]: reply });
        expectOnlyThe(await failure(ask(fake)), WHATSAPP_UNREACHABLE);
      }
      const garbled = fakeHost(happy());
      garbled.fetchWithTimeout.mockResolvedValue(new Response(`not json ${ACCESS_TOKEN}`, { status: 200 }));
      expectOnlyThe(await failure(ask(garbled)), WHATSAPP_UNREACHABLE);
      // A refusal that is not Meta's JSON (a proxy's page, say) can't be read, so it is not taken as Meta's.
      const blocked = fakeHost(happy());
      blocked.fetchWithTimeout.mockResolvedValue(new Response(`<html>${ACCESS_TOKEN}</html>`, { status: 403 }));
      expectOnlyThe(await failure(ask(blocked)), WHATSAPP_UNREACHABLE);
    });

    it("says Meta was unreachable for a token check it cannot read", async () => {
      const unusable: Array<[string, Reply]> = [
        ["a 500", leaky(500)],
        ["no data", { body: {} }],
        ["data that is not a record", { body: { data: "valid" } }],
        ["no verdict", { body: { data: { app_id: APP_ID, expires_at: 0 } } }],
        ["no app", { body: { data: { is_valid: true, expires_at: 0 } } }],
        ["no expiry", { body: { data: { app_id: APP_ID, is_valid: true } } }],
        ["a negative expiry", { body: { data: { ...TOKEN_DATA, expires_at: -1 } } }],
        ["an expiry in text", { body: { data: { ...TOKEN_DATA, expires_at: "1767225600" } } }],
        ["an expiry past any date", { body: { data: { ...TOKEN_DATA, expires_at: 1e15 } } }],
      ];
      for (const [, reply] of unusable) {
        const fake = fakeHost({ ...happy(), "GET debug_token": reply });
        expectOnlyThe(await failure(ask(fake)), WHATSAPP_UNREACHABLE);
        expect(fake.calls).toHaveLength(2);
      }
    });

    it("says Meta was unreachable for lists it cannot read", async () => {
      for (const path of ["phone_numbers", "subscribed_apps"]) {
        for (const reply of [leaky(500), { body: {} }, { body: { data: "x" } }] as Reply[]) {
          const fake = fakeHost({ ...happy(), [`GET ${BUSINESS_ACCOUNT_ID}/${path}`]: reply });
          expectOnlyThe(await failure(ask(fake)), WHATSAPP_UNREACHABLE);
        }
      }
    });

    it("asks Meta nothing when the setup host cannot reach it", async () => {
      const fake = fakeHost(happy());
      const noFetch = { ...fake.host, fetchWithTimeout: undefined } as unknown as ChannelSetupHost;
      await expect(
        checkWhatsAppSetup(noFetch, fake.listener, { draftId, expectedRevision: 3, askMeta: true }),
      ).rejects.toThrow(WHATSAPP_UNREACHABLE);
      const noResolver = { ...fake.host, resolveConnectionSecret: undefined } as unknown as ChannelSetupHost;
      await expect(
        checkWhatsAppSetup(noResolver, fake.listener, { draftId, expectedRevision: 3, askMeta: true }),
      ).rejects.toThrow(WHATSAPP_UNREACHABLE);
      expect(fake.fetchWithTimeout).not.toHaveBeenCalled();
    });
  });

  describe("asking Meta nothing", () => {
    it("makes no call and reads no key without askMeta", async () => {
      const heard = {
        addressCheckedAt: "2026-10-29T12:00:00.000Z",
        code: CODE,
        codeSender: { actorId: "16505551234" },
      };
      const fake = fakeHost(happy(), { heard });
      const result = await check(fake, { setupCode: CODE });
      expect(result).toEqual({
        addressCheckedAt: "2026-10-29T12:00:00.000Z",
        codeSender: { actorId: "16505551234" },
      });
      expect(fake.fetchWithTimeout).not.toHaveBeenCalled();
      expect(fake.resolveConnectionSecret).not.toHaveBeenCalled();
      const alsoFalse = await check(fake, { askMeta: false, setupCode: CODE });
      expect(alsoFalse).toEqual(result);
      expect(fake.fetchWithTimeout).not.toHaveBeenCalled();
    });

    it("names the sender only for the code the listener heard", async () => {
      const heard = { code: CODE, codeSender: { actorId: "16505551234", displayName: "Sheena" } };
      const fake = fakeHost(happy(), { heard });
      expect(await check(fake, { setupCode: "Zz9yXw8vUt" })).toEqual({});
      expect(await check(fake, { setupCode: CODE.toLowerCase() })).toEqual({});
      expect(await check(fake)).toEqual({});
      expect(await check(fake, { setupCode: CODE })).toEqual({
        codeSender: { actorId: "16505551234", displayName: "Sheena" },
      });
    });

    it("reports Meta's address check on its own, and nothing when nothing was heard", async () => {
      const checked = fakeHost(happy(), { heard: { addressCheckedAt: "2026-10-29T12:00:00.000Z" } });
      expect(await check(checked, { setupCode: CODE })).toEqual({ addressCheckedAt: "2026-10-29T12:00:00.000Z" });
      const nothing = fakeHost(happy());
      expect(await check(nothing, { setupCode: CODE })).toEqual({});
      expect(nothing.listener.heard).toHaveBeenCalledWith(draftId);
    });

    it("does not ask for the five details, but still wants a current WhatsApp draft", async () => {
      const bare = whatsAppDraft({ businessAccountId: undefined, appId: undefined, phoneNumberId: undefined });
      const fake = fakeHost(happy(), { draft: bare, tokens: {} });
      await expect(check(fake, { setupCode: CODE })).resolves.toEqual({});
      await expect(checkWhatsAppSetup(fake.host, fake.listener, { draftId, expectedRevision: 2 })).rejects.toThrow(
        "changed",
      );
      const slack = fakeHost(happy(), { draft: whatsAppDraft({}, { catalogId: "channel.slack" }) });
      expectOnlyThe(await failure(check(slack, { setupCode: CODE })), WHATSAPP_DRAFT_ONLY);
      expect(slack.listener.heard).not.toHaveBeenCalled();
    });
  });

  describe("the five details", () => {
    const missing: Array<[string, Record<string, unknown>, Record<string, string | undefined>]> = [
      ["phone number ID", { phoneNumberId: undefined }, { accessToken: ACCESS_TOKEN, appSecret: APP_SECRET }],
      [
        "WhatsApp Business Account ID",
        { businessAccountId: undefined },
        { accessToken: ACCESS_TOKEN, appSecret: APP_SECRET },
      ],
      ["App ID", { appId: undefined }, { accessToken: ACCESS_TOKEN, appSecret: APP_SECRET }],
      ["access token", {}, { appSecret: APP_SECRET }],
      ["app secret", {}, { accessToken: ACCESS_TOKEN }],
    ];

    it.each(missing)("asks Meta nothing without the %s", async (_name, values, tokens) => {
      const fake = fakeHost(happy(), { draft: whatsAppDraft(values), tokens });
      expectOnlyThe(await failure(ask(fake)), WHATSAPP_DETAILS_MISSING);
      expect(fake.fetchWithTimeout).not.toHaveBeenCalled();
    });

    it("never puts an ID that is not digits into an address", async () => {
      for (const key of ["phoneNumberId", "businessAccountId", "appId"]) {
        for (const value of ["../me", "123/456", "12345?fields=x", "12 345 678", "abc12345", "12345", "1".repeat(31)]) {
          const fake = fakeHost(happy(), { draft: whatsAppDraft({ [key]: value }) });
          expectOnlyThe(await failure(ask(fake)), WHATSAPP_DETAILS_MISSING);
          expect(fake.fetchWithTimeout).not.toHaveBeenCalled();
        }
      }
    });
  });

  it("checks only WhatsApp drafts", async () => {
    const fake = fakeHost(happy(), { draft: whatsAppDraft({}, { catalogId: "channel.slack" }) });
    expectOnlyThe(await failure(ask(fake)), WHATSAPP_DRAFT_ONLY);
    expect(fake.fetchWithTimeout).not.toHaveBeenCalled();
    expect(fake.resolveConnectionSecret).not.toHaveBeenCalled();
    expect(fake.listener.heard).not.toHaveBeenCalled();
  });

  it("fails a draft that changed before asking Meta anything", async () => {
    const fake = fakeHost(happy());
    await expect(
      checkWhatsAppSetup(fake.host, fake.listener, { draftId, expectedRevision: 2, askMeta: true }),
    ).rejects.toThrow("changed");
    expect(fake.fetchWithTimeout).not.toHaveBeenCalled();
    expect(fake.resolveConnectionSecret).not.toHaveBeenCalled();
  });
});

describe("WhatsApp setup subscribe", () => {
  it("subscribes the app on request, with a POST that has no body", async () => {
    const fake = fakeHost(happy());
    await expect(subscribe(fake)).resolves.toEqual({ appSubscribed: true });
    expect(names(fake.calls)).toEqual([`POST ${BUSINESS_ACCOUNT_ID}/subscribed_apps`]);
    const [post] = fake.calls;
    expect(post?.url).toBe(`${GRAPH}${BUSINESS_ACCOUNT_ID}/subscribed_apps`);
    expect(post?.authorization).toBe(`Bearer ${ACCESS_TOKEN}`);
    expect(post?.init?.body).toBeUndefined();
    expect(post?.url).not.toContain(ACCESS_TOKEN);
    expect(post?.url).not.toContain(APP_SECRET);
  });

  it("reads only the draft's access token, as the owner of that draft", async () => {
    const fake = fakeHost(happy(), { tokens: { accessToken: ACCESS_TOKEN } });
    await subscribe(fake);
    expect(fake.resolveConnectionSecret).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({ businessAccountId: BUSINESS_ACCOUNT_ID }),
      "accessToken",
      "accessTokenEnv",
      "channel.whatsapp",
      { connectionId: draftId, draftId },
    );
  });

  it("takes the access token alone out of secure storage", async () => {
    const resolve = vi.fn((reference: string) => `stored:${reference}`);
    const state = (secretRef: string) => ({ configured: true, secretRef, custody: "temporary", source: "inherited" });
    const draft = whatsAppDraft({}, {
      secretState: { accessToken: state("ref-access"), appSecret: state("ref-secret") },
    } as Partial<ChannelSetupDraft>);
    const fake = fakeHost(happy(), { draft, channelSecrets: { assertUsableForDraft: vi.fn(), resolve } });
    await subscribe(fake);
    expect(resolve.mock.calls.map((call) => call[0])).toEqual(["ref-access"]);
  });

  it("says Meta didn't let the app receive the messages for a refusal", async () => {
    for (const status of [400, 401, 403]) {
      const fake = fakeHost({ ...happy(), [`POST ${BUSINESS_ACCOUNT_ID}/subscribed_apps`]: leaky(status, 100) });
      expectOnlyThe(await failure(subscribe(fake)), WHATSAPP_SUBSCRIBE_REFUSED);
      expect(fake.calls).toHaveLength(1);
    }
    for (const body of [{ success: false }, {}, { success: "true" }]) {
      const fake = fakeHost({ ...happy(), [`POST ${BUSINESS_ACCOUNT_ID}/subscribed_apps`]: { body } });
      expectOnlyThe(await failure(subscribe(fake)), WHATSAPP_SUBSCRIBE_REFUSED);
    }
  });

  it("says the access token was refused, not that the app was, for code 190 whatever the HTTP status", async () => {
    // 190 is Graph's access-token error, so a bad or expired token is not "Meta didn't let this app receive messages".
    for (const status of [200, 400, 401, 403, 500]) {
      const fake = fakeHost({ ...happy(), [`POST ${BUSINESS_ACCOUNT_ID}/subscribed_apps`]: leaky(status, 190) });
      expectOnlyThe(await failure(subscribe(fake)), WHATSAPP_TOKEN_REJECTED);
      expect(fake.calls, String(status)).toHaveLength(1);
    }
    // Other codes keep their meaning: a refusal that is not about the token is still the subscribe sentence.
    const other = fakeHost({ ...happy(), [`POST ${BUSINESS_ACCOUNT_ID}/subscribed_apps`]: leaky(400, 200) });
    expectOnlyThe(await failure(subscribe(other)), WHATSAPP_SUBSCRIBE_REFUSED);
  });

  it("says Meta refused the request for any other refusal Meta answered", async () => {
    for (const reply of [leaky(429, 4), leaky(404, 803)]) {
      const fake = fakeHost({ ...happy(), [`POST ${BUSINESS_ACCOUNT_ID}/subscribed_apps`]: reply });
      expectOnlyThe(await failure(subscribe(fake)), WHATSAPP_META_REFUSED);
      expect(fake.calls).toHaveLength(1);
    }
  });

  it("says Meta was unreachable for any other trouble, without quoting anything", async () => {
    for (const reply of [leaky(500), leaky(503, 2), leaky(404)]) {
      const fake = fakeHost({ ...happy(), [`POST ${BUSINESS_ACCOUNT_ID}/subscribed_apps`]: reply });
      expectOnlyThe(await failure(subscribe(fake)), WHATSAPP_UNREACHABLE);
    }
    const broken = fakeHost(happy());
    broken.fetchWithTimeout.mockRejectedValue(
      new Error(`request to ${GRAPH}${BUSINESS_ACCOUNT_ID}/subscribed_apps failed: Bearer ${ACCESS_TOKEN}`),
    );
    expectOnlyThe(await failure(subscribe(broken)), WHATSAPP_UNREACHABLE);
    // An answer that is not JSON says nothing about whether Meta let the app in: it is unreachable, not refused.
    const garbled = fakeHost(happy());
    garbled.fetchWithTimeout.mockResolvedValue(new Response(`not json ${ACCESS_TOKEN}`, { status: 200 }));
    expectOnlyThe(await failure(subscribe(garbled)), WHATSAPP_UNREACHABLE);
    const list = fakeHost({ ...happy(), [`POST ${BUSINESS_ACCOUNT_ID}/subscribed_apps`]: { body: [] } });
    expectOnlyThe(await failure(subscribe(list)), WHATSAPP_UNREACHABLE);
  });

  it("asks Meta nothing without the access token or the account ID", async () => {
    const noToken = fakeHost(happy(), { tokens: {} });
    expectOnlyThe(await failure(subscribe(noToken)), WHATSAPP_DETAILS_MISSING);
    expect(noToken.fetchWithTimeout).not.toHaveBeenCalled();
    for (const value of [undefined, "../me", "12345"]) {
      const fake = fakeHost(happy(), { draft: whatsAppDraft({ businessAccountId: value }) });
      expectOnlyThe(await failure(subscribe(fake)), WHATSAPP_DETAILS_MISSING);
      expect(fake.fetchWithTimeout).not.toHaveBeenCalled();
    }
  });

  it("asks Meta nothing when the setup host cannot reach it", async () => {
    const fake = fakeHost(happy());
    const noFetch = { ...fake.host, fetchWithTimeout: undefined } as unknown as ChannelSetupHost;
    await expect(subscribeWhatsAppSetupApp(noFetch, { draftId, expectedRevision: 3 })).rejects.toThrow(
      WHATSAPP_UNREACHABLE,
    );
    const noResolver = { ...fake.host, resolveConnectionSecret: undefined } as unknown as ChannelSetupHost;
    await expect(subscribeWhatsAppSetupApp(noResolver, { draftId, expectedRevision: 3 })).rejects.toThrow(
      WHATSAPP_UNREACHABLE,
    );
    expect(fake.fetchWithTimeout).not.toHaveBeenCalled();
  });

  it("subscribes only for WhatsApp drafts", async () => {
    const fake = fakeHost(happy(), { draft: whatsAppDraft({}, { catalogId: "channel.slack" }) });
    expectOnlyThe(await failure(subscribe(fake)), WHATSAPP_DRAFT_ONLY);
    expect(fake.fetchWithTimeout).not.toHaveBeenCalled();
    expect(fake.resolveConnectionSecret).not.toHaveBeenCalled();
  });

  it("fails a draft that changed before asking Meta anything", async () => {
    const fake = fakeHost(happy());
    await expect(subscribeWhatsAppSetupApp(fake.host, { draftId, expectedRevision: 2 })).rejects.toThrow("changed");
    expect(fake.fetchWithTimeout).not.toHaveBeenCalled();
  });
});
