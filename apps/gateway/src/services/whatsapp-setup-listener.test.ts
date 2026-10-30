import { describe, expect, it, vi } from "vitest";
import { NotFoundError, type ChannelSetupDraft } from "@goatcitadel/contracts";
import type { ChannelSetupHost } from "./channel-setup-service.js";
import { ChannelSecretCustodyService } from "./channel-secret-custody-service.js";
import { resolveConnectionConfigSecret } from "./channel-secret-resolution.js";
import {
  WHATSAPP_SETUP_LISTEN_MAX_DRAFTS,
  WHATSAPP_SETUP_LISTEN_MS,
  createWhatsAppSetupListener,
} from "./whatsapp-setup-listener.js";
import { buildWhatsAppWebhookSignature } from "./whatsapp-webhook.js";

const warn = vi.hoisted(() => vi.fn());
vi.mock("@goatcitadel/gateway-core", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@goatcitadel/gateway-core")>();
  const scoped = { debug: vi.fn(), info: vi.fn(), warn, error: vi.fn() };
  return { ...actual, logger: { ...actual.logger, child: () => scoped } };
});

const draftId = "11111111-1111-4111-8111-111111111111";
const PHONE_NUMBER_ID = "106540352242922";
const CODE = "Kp4mZ9qRtW";
const APP_SECRET = "app-secret-4f1c9e7a2b";
const VERIFY_TOKEN = "verify-token-9d3a6b";
const ACCESS_TOKEN = "EAAG-access-token-77aa";
const CHALLENGE = "1158201444";
const START = Date.parse("2026-10-29T12:00:00.000Z");

const SHEENA = "16505551234";
const OTHER = "16505559876";

function whatsAppDraft(
  values: Record<string, unknown> = {},
  overrides: Partial<ChannelSetupDraft> = {},
): ChannelSetupDraft {
  return {
    draftId,
    revision: 3,
    catalogId: "channel.whatsapp",
    lifecycleMode: "create",
    draft: { setupPage: "messaging", phoneNumberId: PHONE_NUMBER_ID, setupCode: CODE, ...values },
    secretState: {},
    enabled: true,
    contentVersion: "content",
    adapterVersion: "adapter",
    validationVersion: "validation",
    testVersion: "test",
    createdAt: new Date(START).toISOString(),
    updatedAt: new Date(START).toISOString(),
    ...overrides,
  } as ChannelSetupDraft;
}

/**
 * A setup host that holds `drafts` by id. The draft's saved keys read by the field they are asked for, so a missing
 * one is a key left out of `secrets`. Its `fetchWithTimeout` throws a message that quotes both secrets: the listener
 * never reaches Meta, so it must never be called.
 */
function fakeHost(
  drafts: ChannelSetupDraft[] = [whatsAppDraft()],
  secrets: Record<string, string | undefined> = { appSecret: APP_SECRET, webhookVerifyToken: VERIFY_TOKEN },
) {
  const byId = new Map(drafts.map((draft) => [draft.draftId, draft]));
  const get = vi.fn(async (id: string) => {
    const draft = byId.get(id);
    if (!draft) throw new NotFoundError({ entity: "Channel setup draft", id });
    return draft;
  });
  const fetchWithTimeout = vi.fn(async () => {
    throw new Error(`boom ${APP_SECRET} ${VERIFY_TOKEN}`);
  });
  const resolveConnectionSecret = vi.fn((_config: unknown, directKey: string) => secrets[directKey]);
  const host = {
    storage: { channelSetupDrafts: { get } },
    fetchWithTimeout,
    resolveConnectionSecret,
  } as unknown as ChannelSetupHost;
  return { host, get, fetchWithTimeout, resolveConnectionSecret };
}

function fakeClock() {
  let at = START;
  return {
    now: () => new Date(at),
    advance: (ms: number) => {
      at += ms;
    },
    iso: () => new Date(at).toISOString(),
  };
}

function setup(drafts?: ChannelSetupDraft[], secrets?: Record<string, string | undefined>) {
  const clock = fakeClock();
  const hosted = fakeHost(drafts, secrets);
  const listener = createWhatsAppSetupListener(hosted.host, clock.now);
  return { ...hosted, clock, listener };
}

const message = (from: string, extra: Record<string, unknown>, id = `wamid.${from}.${Math.random()}`) => ({
  from,
  id,
  timestamp: "1730203200",
  ...extra,
});
const text = (from: string, body: string) => message(from, { type: "text", text: { body } });

/** A Meta delivery body. `contacts` names the senders, as Meta does. */
function body(
  messages: unknown[],
  options: { phoneNumberId?: string; names?: Record<string, string>; statuses?: unknown[] } = {},
): string {
  const names = options.names ?? { [SHEENA]: "Sheena", [OTHER]: "Omar" };
  return JSON.stringify({
    object: "whatsapp_business_account",
    entry: [
      {
        id: "WABA-1",
        changes: [
          {
            field: "messages",
            value: {
              messaging_product: "whatsapp",
              metadata: {
                display_phone_number: "15551234567",
                phone_number_id: options.phoneNumberId ?? PHONE_NUMBER_ID,
              },
              contacts: Object.entries(names).map(([wa_id, name]) => ({ wa_id, profile: { name } })),
              ...(messages.length > 0 ? { messages } : {}),
              ...(options.statuses ? { statuses: options.statuses } : {}),
            },
          },
        ],
      },
    ],
  });
}

const signed = (payload: string, secret = APP_SECRET) => buildWhatsAppWebhookSignature(payload, secret);
const check = (extra: { mode?: string; verifyToken?: string; challenge?: string } = {}) => ({
  mode: "subscribe",
  verifyToken: VERIFY_TOKEN,
  challenge: CHALLENGE,
  ...extra,
});

describe("WhatsApp setup listener", () => {
  it("answers Meta's check with the challenge and notes the time", async () => {
    const { listener, clock } = setup();
    expect(await listener.answerCheck(draftId, check())).toEqual({ status: 200, challenge: CHALLENGE });
    expect(listener.heard(draftId)).toEqual({ addressCheckedAt: clock.iso() });
    expect(listener.heard(draftId).addressCheckedAt).toBe("2026-10-29T12:00:00.000Z");
  });

  it("reads the draft's own keys, as the owner of that draft, and only the two the listener needs", async () => {
    const { listener, resolveConnectionSecret } = setup();
    await listener.answerCheck(draftId, check());
    const empty = JSON.stringify({ object: "whatsapp_business_account" });
    await listener.hearDelivery(draftId, empty, signed(empty));
    expect(resolveConnectionSecret.mock.calls.map((call) => call.slice(1))).toEqual([
      ["webhookVerifyToken", "webhookVerifyTokenEnv", "channel.whatsapp", { connectionId: draftId, draftId }],
      ["appSecret", "appSecretEnv", "channel.whatsapp", { connectionId: draftId, draftId }],
    ]);
  });

  it("refuses a check with the wrong token or no challenge", async () => {
    const { listener } = setup();
    expect(await listener.answerCheck(draftId, check({ verifyToken: "not-the-token" }))).toEqual({ status: 401 });
    expect(await listener.answerCheck(draftId, check({ verifyToken: undefined }))).toEqual({ status: 401 });
    expect(await listener.answerCheck(draftId, check({ challenge: undefined }))).toEqual({ status: 400 });
    expect(await listener.answerCheck(draftId, check({ challenge: "" }))).toEqual({ status: 400 });
    expect(await listener.answerCheck(draftId, check({ mode: "unsubscribe" }))).toEqual({ status: 400 });
    expect(await listener.answerCheck(draftId, check({ mode: undefined }))).toEqual({ status: 400 });
    expect(listener.heard(draftId)).toEqual({});
  });

  it("refuses a token of the same length in other letters without throwing", async () => {
    const { listener } = setup();
    // Same number of characters as the real token, but more bytes once encoded.
    const lookalike = "é".repeat(VERIFY_TOKEN.length);
    expect(await listener.answerCheck(draftId, check({ verifyToken: lookalike }))).toEqual({ status: 401 });
    expect(listener.heard(draftId)).toEqual({});
  });

  it("refuses a check when the draft has no verify token yet", async () => {
    const { listener } = setup([whatsAppDraft()], { appSecret: APP_SECRET });
    expect(await listener.answerCheck(draftId, check())).toEqual({ status: 401 });
    expect(await listener.answerCheck(draftId, check({ verifyToken: "" }))).toEqual({ status: 401 });
    expect(listener.heard(draftId)).toEqual({});
  });

  it("answers 404 for a draft not made on the Chat page, another channel's draft, or no draft", async () => {
    const otherId = "22222222-2222-4222-8222-222222222222";
    const settingsId = "33333333-3333-4333-8333-333333333333";
    const slackId = "44444444-4444-4444-8444-444444444444";
    const editId = "55555555-5555-4555-8555-555555555555";
    const { listener, resolveConnectionSecret } = setup([
      whatsAppDraft({}, { draftId: otherId, draft: { phoneNumberId: PHONE_NUMBER_ID, setupCode: CODE } }),
      whatsAppDraft({ setupPage: "settings" }, { draftId: settingsId }),
      whatsAppDraft({}, { draftId: slackId, catalogId: "channel.slack" }),
      whatsAppDraft({}, { draftId: editId, lifecycleMode: "edit" }),
    ]);
    const payload = body([text(SHEENA, CODE)]);
    for (const id of [otherId, settingsId, slackId, editId, "66666666-6666-4666-8666-666666666666"]) {
      expect(await listener.answerCheck(id, check())).toEqual({ status: 404 });
      expect(await listener.hearDelivery(id, payload, signed(payload))).toEqual({ status: 404 });
      expect(listener.heard(id)).toEqual({});
    }
    // No key is read for a draft that doesn't qualify.
    expect(resolveConnectionSecret).not.toHaveBeenCalled();
  });

  it("hears the code from the person who sent it", async () => {
    const { listener } = setup();
    const payload = body([text(SHEENA, " Kp4mZ9qRtW ")]);
    expect(await listener.hearDelivery(draftId, payload, signed(payload))).toEqual({ status: 200 });
    expect(listener.heard(draftId)).toEqual({
      code: CODE,
      codeSender: { actorId: "16505551234", displayName: "Sheena" },
    });
  });

  it("hears the sender without a name when the profile has none", async () => {
    const { listener } = setup();
    const payload = body([text(SHEENA, CODE)], { names: {} });
    expect(await listener.hearDelivery(draftId, payload, signed(payload))).toEqual({ status: 200 });
    expect(listener.heard(draftId)).toEqual({ code: CODE, codeSender: { actorId: SHEENA } });
  });

  it("names the sender from their own contact, never from another person's", async () => {
    const { listener } = setup();
    const payload = body([text(OTHER, CODE)], { names: { [SHEENA]: "Sheena", "16505550000": "Someone else" } });
    await listener.hearDelivery(draftId, payload, signed(payload));
    expect(listener.heard(draftId).codeSender).toEqual({ actorId: OTHER });
  });

  it("hears only a message that is the code and nothing else", async () => {
    const { listener } = setup();
    const notTheCode = [
      body([text(SHEENA, "my code is Kp4mZ9qRtW")]),
      body([text(SHEENA, "kp4mz9qrtw")]),
      body([text(SHEENA, "Kp4mZ9qRt")]),
      body([text(SHEENA, "")]),
      body([message(SHEENA, { type: "image", image: { id: "media-1", caption: CODE } })]),
      // Only a text message counts, whatever else a message carries.
      body([message(SHEENA, { type: "image", text: { body: CODE } })]),
      body([message(SHEENA, { type: "text", text: {} })]),
      body([message("", { type: "text", text: { body: CODE } })]),
      body([], {
        statuses: [{ id: "wamid.out", status: "delivered", timestamp: "1730203200", recipient_id: SHEENA }],
      }),
    ];
    for (const payload of notTheCode) {
      expect(await listener.hearDelivery(draftId, payload, signed(payload))).toEqual({ status: 200 });
      expect(listener.heard(draftId)).toEqual({});
    }
  });

  it("hears nothing when the draft has no setup code", async () => {
    const { listener } = setup([whatsAppDraft({ setupCode: undefined })]);
    const payload = body([text(SHEENA, ""), text(SHEENA, CODE)]);
    expect(await listener.hearDelivery(draftId, payload, signed(payload))).toEqual({ status: 200 });
    expect(listener.heard(draftId)).toEqual({});
  });

  it("the newest sender of the current code replaces the earlier one", async () => {
    const { listener } = setup();
    const first = body([text(SHEENA, CODE)]);
    const second = body([text(OTHER, CODE)]);
    await listener.hearDelivery(draftId, first, signed(first));
    expect(listener.heard(draftId).codeSender).toEqual({ actorId: SHEENA, displayName: "Sheena" });
    await listener.hearDelivery(draftId, second, signed(second));
    expect(listener.heard(draftId)).toEqual({ code: CODE, codeSender: { actorId: OTHER, displayName: "Omar" } });
    // Within one delivery the last message is the newest.
    const both = body([text(SHEENA, CODE), text(OTHER, CODE)]);
    await listener.hearDelivery(draftId, both, signed(both));
    expect(listener.heard(draftId).codeSender?.actorId).toBe(OTHER);
  });

  it("keeps what it heard when later messages are not the code, and keeps the address check beside it", async () => {
    const { listener, clock } = setup();
    await listener.answerCheck(draftId, check());
    const sent = body([text(SHEENA, CODE)]);
    await listener.hearDelivery(draftId, sent, signed(sent));
    const chatter = body([text(OTHER, "hello there")]);
    await listener.hearDelivery(draftId, chatter, signed(chatter));
    expect(listener.heard(draftId)).toEqual({
      addressCheckedAt: clock.iso(),
      code: CODE,
      codeSender: { actorId: SHEENA, displayName: "Sheena" },
    });
  });

  it("keeps no message text, only the code and who sent it", async () => {
    const { listener } = setup();
    const payload = body([text(SHEENA, `  ${CODE}  `)]);
    await listener.hearDelivery(draftId, payload, signed(payload));
    const kept = JSON.stringify(listener.heard(draftId));
    expect(kept).not.toContain("wamid");
    expect(kept).not.toContain("1730203200");
    expect(Object.keys(listener.heard(draftId)).sort()).toEqual(["code", "codeSender"]);
  });

  it("refuses a delivery Meta didn't sign for this draft", async () => {
    const { listener } = setup();
    const payload = body([text(SHEENA, CODE)]);
    expect(await listener.hearDelivery(draftId, payload, signed(payload, "some-other-app-secret"))).toEqual({
      status: 401,
    });
    expect(await listener.hearDelivery(draftId, payload, undefined)).toEqual({ status: 401 });
    expect(await listener.hearDelivery(draftId, payload, "")).toEqual({ status: 401 });
    expect(await listener.hearDelivery(draftId, payload, "sha256=not-hex")).toEqual({ status: 401 });
    // A signature over different bytes is not a signature over these.
    expect(await listener.hearDelivery(draftId, `${payload} `, signed(payload))).toEqual({ status: 401 });
    const elsewhere = body([text(SHEENA, CODE)], { phoneNumberId: "999" });
    expect(await listener.hearDelivery(draftId, elsewhere, signed(elsewhere))).toEqual({ status: 403 });
    expect(listener.heard(draftId)).toEqual({});
  });

  it("refuses every delivery while the draft has no app secret", async () => {
    const { listener } = setup([whatsAppDraft()], { webhookVerifyToken: VERIFY_TOKEN });
    const payload = body([text(SHEENA, CODE)]);
    // Signed by whoever knows how to sign with nothing: still refused.
    expect(await listener.hearDelivery(draftId, payload, signed(payload, ""))).toEqual({ status: 401 });
    expect(await listener.hearDelivery(draftId, payload, signed(payload))).toEqual({ status: 401 });
    expect(listener.heard(draftId)).toEqual({});
  });

  it("answers a signed delivery that isn't JSON with 400, and a draft without a phone number ID with 400", async () => {
    const { listener } = setup();
    const garbage = "not json at all";
    expect(await listener.hearDelivery(draftId, garbage, signed(garbage))).toEqual({ status: 400 });
    const noPhone = setup([whatsAppDraft({ phoneNumberId: undefined })]);
    const payload = body([text(SHEENA, CODE)]);
    expect(await noPhone.listener.hearDelivery(draftId, payload, signed(payload))).toEqual({ status: 400 });
    expect(listener.heard(draftId)).toEqual({});
    expect(noPhone.listener.heard(draftId)).toEqual({});
  });

  describe("what it remembers", () => {
    const manyDrafts = () => {
      const ids = Array.from(
        { length: WHATSAPP_SETUP_LISTEN_MAX_DRAFTS + 1 },
        (_, index) => `00000000-0000-4000-8000-${String(index).padStart(12, "0")}`,
      );
      return { ids, ...setup(ids.map((id) => whatsAppDraft({}, { draftId: id }))) };
    };

    it("forgets after 15 minutes, and keeps at most 32 drafts", async () => {
      expect(WHATSAPP_SETUP_LISTEN_MS).toBe(15 * 60_000);
      expect(WHATSAPP_SETUP_LISTEN_MAX_DRAFTS).toBe(32);

      const { listener, clock } = setup();
      await listener.answerCheck(draftId, check());
      clock.advance(WHATSAPP_SETUP_LISTEN_MS - 1);
      expect(listener.heard(draftId)).toEqual({ addressCheckedAt: "2026-10-29T12:00:00.000Z" });
      clock.advance(1);
      expect(listener.heard(draftId)).toEqual({});

      const crowd = manyDrafts();
      for (const id of crowd.ids) {
        await crowd.listener.answerCheck(id, check());
        crowd.clock.advance(1_000);
      }
      expect(crowd.listener.heard(crowd.ids[0]!)).toEqual({});
      for (const id of crowd.ids.slice(1)) expect(crowd.listener.heard(id).addressCheckedAt).toBeDefined();
    });

    it("lets a note refresh a draft, so the next oldest is the one that goes", async () => {
      const { ids, listener, clock } = manyDrafts();
      for (const id of ids.slice(0, WHATSAPP_SETUP_LISTEN_MAX_DRAFTS)) {
        await listener.answerCheck(id, check());
        clock.advance(1_000);
      }
      await listener.answerCheck(ids[0]!, check());
      clock.advance(1_000);
      await listener.answerCheck(ids[WHATSAPP_SETUP_LISTEN_MAX_DRAFTS]!, check());
      expect(listener.heard(ids[1]!)).toEqual({});
      for (const id of [ids[0]!, ...ids.slice(2)]) expect(listener.heard(id).addressCheckedAt).toBeDefined();
    });

    it("keeps what was heard while it is being added to", async () => {
      const { listener, clock } = setup();
      await listener.answerCheck(draftId, check());
      clock.advance(WHATSAPP_SETUP_LISTEN_MS - 1);
      const sent = body([text(SHEENA, CODE)]);
      await listener.hearDelivery(draftId, sent, signed(sent));
      clock.advance(WHATSAPP_SETUP_LISTEN_MS - 1);
      expect(listener.heard(draftId).codeSender?.actorId).toBe(SHEENA);
      clock.advance(1);
      expect(listener.heard(draftId)).toEqual({});
    });
  });

  it("never quotes a secret", async () => {
    const { listener, fetchWithTimeout, get } = setup();
    const payload = body([text(SHEENA, CODE)]);
    const results: unknown[] = [];
    const run = async (work: () => Promise<unknown>) => {
      try {
        results.push(await work());
      } catch (error) {
        results.push(error, (error as Error).message);
      }
    };
    await run(() => listener.answerCheck(draftId, check({ verifyToken: "wrong" })));
    await run(() => listener.hearDelivery(draftId, payload, signed(payload, "wrong")));
    await run(() => listener.hearDelivery(draftId, payload, signed(payload)));
    // A draft store that fails with a message holding both secrets.
    get.mockRejectedValueOnce(new Error(`disk failed near ${APP_SECRET} and ${VERIFY_TOKEN}`));
    await run(() => listener.answerCheck(draftId, check()));
    get.mockRejectedValueOnce(new Error(`disk failed near ${APP_SECRET} and ${VERIFY_TOKEN}`));
    await run(() => listener.hearDelivery(draftId, payload, signed(payload)));

    const everything = JSON.stringify([results, listener.heard(draftId), warn.mock.calls]);
    expect(everything).not.toContain(APP_SECRET);
    expect(everything).not.toContain(VERIFY_TOKEN);
    // Nothing threw, and Meta is never reached.
    expect(results.every((result) => typeof result === "object" && result !== null)).toBe(true);
    expect(fetchWithTimeout).not.toHaveBeenCalled();
  });

  it("answers 404 when the draft or its keys cannot be read, and logs only the kind of failure", async () => {
    warn.mockClear();
    const { listener, get, resolveConnectionSecret } = setup();
    get.mockRejectedValueOnce(new Error(`disk failed near ${APP_SECRET}`));
    expect(await listener.answerCheck(draftId, check())).toEqual({ status: 404 });
    resolveConnectionSecret.mockImplementationOnce(() => {
      throw new Error(`keychain failed for ${VERIFY_TOKEN}`);
    });
    expect(await listener.answerCheck(draftId, check())).toEqual({ status: 404 });
    expect(listener.heard(draftId)).toEqual({});
    expect(warn).toHaveBeenCalledTimes(2);
    for (const call of warn.mock.calls) {
      expect(call[0]).toEqual(expect.any(String));
      expect(call[1]).toEqual({ errorType: "Error" });
    }
    // A draft that simply isn't there is the ordinary 404, not a failure to report.
    warn.mockClear();
    expect(await listener.answerCheck("77777777-7777-4777-8777-777777777777", check())).toEqual({ status: 404 });
    expect(warn).not.toHaveBeenCalled();
  });

  describe("with the keys in secure storage", () => {
    function securedHost() {
      const store = new Map<string, string>();
      const getSecret = vi.fn((account: string) => store.get(account));
      const custody = new ChannelSecretCustodyService({
        setSecret: (account, value) => void store.set(account, value),
        getSecret,
        deleteSecret: (account) => void store.delete(account),
      });
      const stored = (field: string, value: string) => ({
        configured: true,
        custody: "temporary" as const,
        source: "inherited" as const,
        secretRef: custody.storeTemporary(draftId, field, value),
      });
      const draft = whatsAppDraft(
        {},
        {
          secretState: {
            accessToken: stored("accessToken", ACCESS_TOKEN),
            appSecret: stored("appSecret", APP_SECRET),
            webhookVerifyToken: stored("webhookVerifyToken", VERIFY_TOKEN),
          },
        },
      );
      const host = {
        storage: { channelSetupDrafts: { get: vi.fn(async () => draft) } },
        channelSecrets: custody,
        resolveConnectionSecret: (
          config: Record<string, unknown>,
          directKey: string,
          envKey: string,
          catalogId: string,
          owner: { connectionId: string; draftId?: string },
        ) => resolveConnectionConfigSecret({ getSecret }, config, directKey, envKey, catalogId, owner),
      } as unknown as ChannelSetupHost;
      return { host, getSecret };
    }

    it("reads the app secret and the verify token from there, and never the access token", async () => {
      const clock = fakeClock();
      const { host, getSecret } = securedHost();
      const listener = createWhatsAppSetupListener(host, clock.now);

      expect(await listener.answerCheck(draftId, check())).toEqual({ status: 200, challenge: CHALLENGE });
      expect(await listener.answerCheck(draftId, check({ verifyToken: ACCESS_TOKEN }))).toEqual({ status: 401 });
      const payload = body([text(SHEENA, CODE)]);
      expect(await listener.hearDelivery(draftId, payload, signed(payload))).toEqual({ status: 200 });
      expect(await listener.hearDelivery(draftId, payload, signed(payload, ACCESS_TOKEN))).toEqual({ status: 401 });
      expect(listener.heard(draftId).codeSender).toEqual({ actorId: SHEENA, displayName: "Sheena" });

      const accounts = getSecret.mock.calls.map(([account]) => account);
      expect(accounts.length).toBeGreaterThan(0);
      expect(accounts.some((account) => account.includes(":accessToken:"))).toBe(false);
    });
  });
});
