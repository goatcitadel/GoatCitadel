import { sign } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";
import Fastify, { type FastifyInstance } from "fastify";
import type { DurableInboundChannelAcceptInput } from "../services/channel-inbound-dispatch.js";
import { parseChannelSecretRef } from "../services/channel-secret-custody-service.js";
import { buildGenericChannelInboundSignature } from "../services/generic-channel-webhook.js";
import { buildLineWebhookSignature } from "../services/line-webhook.js";
import { deriveQqbotEd25519KeyPair, signQqbotValidation } from "../services/qqbot-webhook.js";
import { buildSlackSignature } from "../services/slack-webhook.js";
import { computeWecomSignature, encryptWecomMessageForTest } from "../services/wecom-webhook.js";
import { buildWhatsAppWebhookSignature } from "../services/whatsapp-webhook.js";
import { integrationWebhookRoutes } from "./integration-webhooks.js";

/**
 * Every signed-webhook route checks a request against the key its connection saved at setup. Setup keeps each
 * secret in the OS keychain and leaves only a reference in the connection config, so these tests save the
 * reference in the config, keep the real secret in a fake secure store, and read it back the way the gateway does.
 */

const connectionId = "44444444-4444-4444-4444-444444444444";
const otherConnectionId = "55555555-5555-5555-5555-555555555555";
const baseUrl = `/api/v1/integrations/connections/${connectionId}`;

type Response = Awaited<ReturnType<FastifyInstance["inject"]>>;

type Scenario = {
  name: string;
  /** The connection key the route serves. */
  key: string;
  /** Secret field to the real secret; each is saved as a reference. */
  fields: Record<string, string>;
  /** The field whose secret signs the request. */
  signingField: string;
  /** The rest of the connection config. */
  config: Record<string, unknown>;
  /** Sends one request that is signed (or, for a verify token, carries the token) with `signWith`. */
  send: (app: FastifyInstance, signWith: string) => Promise<Response>;
  /** What a request with the wrong signature gets. */
  wrongSignatureStatus: number;
};

const WECOM_AES_KEY = "abcdefghijklmnopqrstuvwxyz0123456789ABCDEFG";
const WECOM_CORP_ID = "wx5823bf96d3bd56c7";
const QQ_APP_SECRET = "naOC0ocQE3shWLAfffVLB1rhYPG7";

const slackPayload = JSON.stringify({
  type: "url_verification",
  team_id: "T111",
  api_app_id: "A111",
  challenge: "challenge-token",
});
const linePayload = JSON.stringify({ destination: "Ubot123", events: [] });
const whatsappPayload = JSON.stringify({
  object: "whatsapp_business_account",
  entry: [
    {
      changes: [
        {
          field: "messages",
          value: {
            metadata: { phone_number_id: "123456789012345", display_phone_number: "+15551234567" },
            contacts: [{ wa_id: "15558675309", profile: { name: "Ada Lovelace" } }],
            messages: [
              {
                from: "15558675309",
                id: "wamid.HBgLNDU2",
                timestamp: "1712182068",
                type: "text",
                text: { body: "Need an operator check-in" },
              },
            ],
          },
        },
      ],
    },
  ],
});
const qqbotPayload = JSON.stringify({
  op: 0,
  id: "GATEWAY_EVENT_1",
  t: "GROUP_AT_MESSAGE_CREATE",
  d: {
    id: "ROBOT1.0_msg1",
    content: " hello bot",
    group_openid: "GROUP1",
    author: { member_openid: "MEMBER1" },
    timestamp: "2026-10-17T10:00:00+08:00",
  },
});
const genericPayload = JSON.stringify({
  eventId: "event-1",
  account: connectionId,
  actorId: "actor-1",
  content: "hello",
});

const scenarios: readonly Scenario[] = [
  {
    name: "Telegram webhook secret",
    key: "telegram",
    fields: { webhookSecret: "telegram-real-webhook-secret" },
    signingField: "webhookSecret",
    config: { botToken: "telegram-bot-token" },
    send: (app, signWith) =>
      app.inject({
        method: "POST",
        url: `${baseUrl}/telegram/webhook`,
        headers: { "content-type": "application/json", "x-telegram-bot-api-secret-token": signWith },
        payload: JSON.stringify({ update_id: 9001 }),
      }),
    wrongSignatureStatus: 401,
  },
  {
    name: "Slack signing secret",
    key: "slack",
    fields: { signingSecret: "slack-real-signing-secret" },
    signingField: "signingSecret",
    config: { slackTeamId: "T111", slackAppId: "A111" },
    send: (app, signWith) => {
      const timestamp = String(Math.floor(Date.now() / 1000));
      return app.inject({
        method: "POST",
        url: `${baseUrl}/slack/webhook`,
        headers: {
          "content-type": "application/json",
          "x-slack-request-timestamp": timestamp,
          "x-slack-signature": buildSlackSignature(timestamp, slackPayload, signWith),
        },
        payload: slackPayload,
      });
    },
    wrongSignatureStatus: 401,
  },
  {
    name: "LINE channel secret",
    key: "line",
    fields: { channelSecret: "line-real-channel-secret" },
    signingField: "channelSecret",
    config: { channelAccessToken: "line-channel-access-token" },
    send: (app, signWith) =>
      app.inject({
        method: "POST",
        url: `${baseUrl}/line/webhook`,
        headers: {
          "content-type": "application/json",
          "x-line-signature": buildLineWebhookSignature(linePayload, signWith),
        },
        payload: linePayload,
      }),
    wrongSignatureStatus: 401,
  },
  {
    name: "WhatsApp app secret",
    key: "whatsapp",
    fields: { appSecret: "whatsapp-real-app-secret" },
    signingField: "appSecret",
    config: { accessToken: "whatsapp-access-token", phoneNumberId: "123456789012345" },
    send: (app, signWith) =>
      app.inject({
        method: "POST",
        url: `${baseUrl}/whatsapp/webhook`,
        headers: {
          "content-type": "application/json",
          "x-hub-signature-256": buildWhatsAppWebhookSignature(whatsappPayload, signWith),
        },
        payload: whatsappPayload,
      }),
    wrongSignatureStatus: 401,
  },
  {
    name: "WhatsApp verify token",
    key: "whatsapp",
    fields: { webhookVerifyToken: "whatsapp-real-verify-token" },
    signingField: "webhookVerifyToken",
    config: { accessToken: "whatsapp-access-token", phoneNumberId: "123456789012345" },
    send: (app, signWith) =>
      app.inject({
        method: "GET",
        url: `${baseUrl}/whatsapp/webhook?hub.mode=subscribe&hub.verify_token=${encodeURIComponent(signWith)}&hub.challenge=challenge-123`,
      }),
    wrongSignatureStatus: 401,
  },
  {
    name: "QQ app secret",
    key: "qqbot",
    fields: { appSecret: QQ_APP_SECRET },
    signingField: "appSecret",
    config: { appId: "1020", inboundAccessMode: "allowlist", allowedSenders: ["MEMBER1"] },
    send: (app, signWith) => {
      const timestamp = "1725442341";
      const { privateKey } = deriveQqbotEd25519KeyPair(signWith);
      const signature = sign(null, Buffer.concat([Buffer.from(timestamp), Buffer.from(qqbotPayload)]), privateKey);
      return app.inject({
        method: "POST",
        url: `${baseUrl}/qqbot/webhook`,
        headers: {
          "content-type": "application/json",
          "x-signature-ed25519": signature.toString("hex"),
          "x-signature-timestamp": timestamp,
        },
        payload: qqbotPayload,
      });
    },
    wrongSignatureStatus: 401,
  },
  {
    name: "WeCom callback token and AES key",
    key: "wecom",
    fields: { callbackToken: "wecom-real-callback-token", encodingAesKey: WECOM_AES_KEY },
    signingField: "callbackToken",
    config: { corpId: WECOM_CORP_ID, agentId: "1000002" },
    send: (app, signWith) => {
      const echostr = encryptWecomMessageForTest({
        encodingAesKey: WECOM_AES_KEY,
        message: "1616140317555161061",
        receiveId: WECOM_CORP_ID,
      });
      const query = new URLSearchParams({
        msg_signature: computeWecomSignature(signWith, "1409659813", "1372623149", echostr),
        timestamp: "1409659813",
        nonce: "1372623149",
        echostr,
      });
      return app.inject({ method: "GET", url: `${baseUrl}/wecom/webhook?${query.toString()}` });
    },
    wrongSignatureStatus: 401,
  },
  {
    name: "WeCom callback token and AES key on a message",
    key: "wecom",
    fields: { callbackToken: "wecom-real-callback-token", encodingAesKey: WECOM_AES_KEY },
    signingField: "callbackToken",
    config: {
      corpId: WECOM_CORP_ID,
      agentId: "1000002",
      inboundAccessMode: "allowlist",
      allowedSenders: ["zhangsan"],
    },
    send: (app, signWith) => {
      const message =
        `<xml><ToUserName><![CDATA[${WECOM_CORP_ID}]]></ToUserName><FromUserName><![CDATA[zhangsan]]></FromUserName>` +
        `<CreateTime>1348831860</CreateTime><MsgType><![CDATA[text]]></MsgType><Content><![CDATA[hello bot]]></Content>` +
        `<MsgId>1234567890123456</MsgId><AgentID>1000002</AgentID></xml>`;
      const encrypted = encryptWecomMessageForTest({
        encodingAesKey: WECOM_AES_KEY,
        message,
        receiveId: WECOM_CORP_ID,
      });
      const query = new URLSearchParams({
        msg_signature: computeWecomSignature(signWith, "1409659813", "1372623149", encrypted),
        timestamp: "1409659813",
        nonce: "1372623149",
      });
      return app.inject({
        method: "POST",
        url: `${baseUrl}/wecom/webhook?${query.toString()}`,
        headers: { "content-type": "text/xml" },
        payload: `<xml><ToUserName><![CDATA[${WECOM_CORP_ID}]]></ToUserName><Encrypt><![CDATA[${encrypted}]]></Encrypt><AgentID><![CDATA[1000002]]></AgentID></xml>`,
      });
    },
    wrongSignatureStatus: 401,
  },
  {
    name: "generic inbound secret",
    key: "custom-channel",
    fields: { inboundSecret: "generic-real-inbound-secret" },
    signingField: "inboundSecret",
    config: {},
    send: (app, signWith) => {
      const timestamp = String(Math.floor(Date.now() / 1000));
      return app.inject({
        method: "POST",
        url: `${baseUrl}/custom-channel/inbound`,
        headers: {
          "content-type": "application/json",
          "x-goatcitadel-channel-timestamp": timestamp,
          "x-goatcitadel-channel-signature": buildGenericChannelInboundSignature(timestamp, genericPayload, signWith),
        },
        payload: genericPayload,
      });
    },
    wrongSignatureStatus: 401,
  },
];

function referenceFor(owner: string, field: string): string {
  return `keychain:goatcitadel:channel-connection:${owner}:${field}:00000000-0000-4000-8000-000000000001`;
}

/** The fake secure store: account to secret, holding each field's real secret under its reference's account. */
function secureStoreWith(owner: string, fields: Record<string, string>): Map<string, string> {
  return new Map(
    Object.entries(fields).map(([field, secret]) => [
      parseChannelSecretRef(referenceFor(owner, field)).account,
      secret,
    ]),
  );
}

/** Reads a saved key the way the gateway does: a reference names an account in the secure store. */
function readSecureStore(secureStore: Map<string, string>) {
  return vi.fn((secretRef: string): string | undefined => {
    try {
      return secureStore.get(parseChannelSecretRef(secretRef).account);
    } catch {
      return undefined;
    }
  });
}

function acceptedResult(event: DurableInboundChannelAcceptInput) {
  return {
    accepted: true as const,
    durableAccepted: true as const,
    deduped: false,
    replied: false as const,
    queued: true,
    eventType: event.eventType,
    inboundEventId: `inbound:${event.message.eventId}`,
  };
}

describe("signed webhooks use the key saved for the connection", () => {
  let app: FastifyInstance | null = null;

  afterEach(async () => {
    if (app) {
      await app.close();
      app = null;
    }
  });

  async function buildApp(
    scenario: Scenario,
    input: { owner: string; secureStore: Map<string, string> },
  ): Promise<{ app: FastifyInstance; readSecret: ReturnType<typeof readSecureStore> }> {
    const readSecret = readSecureStore(input.secureStore);
    const config = {
      ...scenario.config,
      ...Object.fromEntries(Object.keys(scenario.fields).map((field) => [field, referenceFor(input.owner, field)])),
    };
    const next = Fastify();
    next.decorate("services", {
      integrationWebhooks: {
        getIntegrationConnection: vi.fn(() => ({
          connectionId,
          revision: "rev-1",
          key: scenario.key,
          enabled: true,
          status: "connected" as const,
          config,
        })),
        acceptInboundChannelEvent: vi.fn(async (event: DurableInboundChannelAcceptInput) => acceptedResult(event)),
        recordDevDiagnostic: vi.fn(),
        isVoiceInboundEnabled: () => false,
        resolveChannelConnectionSecret: readSecret,
      },
    } as never);
    await next.register(integrationWebhookRoutes);
    app = next;
    return { app: next, readSecret };
  }

  function expectNoSecretLeak(scenario: Scenario, response: Response): void {
    for (const field of Object.keys(scenario.fields)) {
      expect(response.body).not.toContain(scenario.fields[field]!);
      expect(response.body).not.toContain("keychain:");
    }
  }

  it("signs the QQ callback validation reply with the saved app secret", async () => {
    const qq = scenarios.find((scenario) => scenario.name === "QQ app secret")!;
    const ctx = await buildApp(qq, {
      owner: connectionId,
      secureStore: secureStoreWith(connectionId, qq.fields),
    });
    const plainToken = "Arq0D5A61EgUu4OxUvOp";
    const eventTs = "1725442341";

    // QQ sends the validation unsigned, so the reply is the only place the app secret shows.
    const response = await ctx.app.inject({
      method: "POST",
      url: `${baseUrl}/qqbot/webhook`,
      headers: { "content-type": "application/json" },
      payload: JSON.stringify({ op: 13, d: { plain_token: plainToken, event_ts: eventTs } }),
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({
      plain_token: plainToken,
      signature: signQqbotValidation({ appSecret: QQ_APP_SECRET, eventTs, plainToken }),
    });
  });

  describe.each(scenarios)("$name", (scenario) => {
    const signingSecret = scenario.fields[scenario.signingField]!;

    it("accepts a request that carries the saved key", async () => {
      const ctx = await buildApp(scenario, {
        owner: connectionId,
        secureStore: secureStoreWith(connectionId, scenario.fields),
      });

      const response = await scenario.send(ctx.app, signingSecret);

      expect(response.statusCode).toBe(200);
      expectNoSecretLeak(scenario, response);
      expect(ctx.readSecret).toHaveBeenCalled();
      for (const [secretRef] of ctx.readSecret.mock.calls) {
        expect(secretRef.startsWith(`keychain:goatcitadel:channel-connection:${connectionId}:`)).toBe(true);
      }
    });

    it("rejects a request that carries the reference text instead of the saved key", async () => {
      const ctx = await buildApp(scenario, {
        owner: connectionId,
        secureStore: secureStoreWith(connectionId, scenario.fields),
      });

      const response = await scenario.send(ctx.app, referenceFor(connectionId, scenario.signingField));

      expect(response.statusCode).toBe(scenario.wrongSignatureStatus);
      expectNoSecretLeak(scenario, response);
    });

    it("treats a reference to another connection's key as missing, without reading it", async () => {
      const ctx = await buildApp(scenario, {
        owner: otherConnectionId,
        secureStore: secureStoreWith(otherConnectionId, scenario.fields),
      });

      for (const signWith of [signingSecret, referenceFor(otherConnectionId, scenario.signingField)]) {
        const response = await scenario.send(ctx.app, signWith);
        expect(response.statusCode).toBe(400);
        expectNoSecretLeak(scenario, response);
      }
      expect(ctx.readSecret).not.toHaveBeenCalled();
    });

    it("treats a key that is gone from secure storage as missing", async () => {
      const ctx = await buildApp(scenario, { owner: connectionId, secureStore: new Map() });

      for (const signWith of [signingSecret, referenceFor(connectionId, scenario.signingField)]) {
        const response = await scenario.send(ctx.app, signWith);
        expect(response.statusCode).toBe(400);
        expectNoSecretLeak(scenario, response);
      }
    });
  });
});
