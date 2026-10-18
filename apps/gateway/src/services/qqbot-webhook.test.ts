import { describe, expect, it } from "vitest";
import { sign } from "node:crypto";
import {
  deriveQqbotEd25519KeyPair,
  isQqbotWebhookPath,
  normalizeQqbotWebhookPayload,
  signQqbotValidation,
  verifyQqbotSignature,
} from "./qqbot-webhook.js";

const SECRET = "naOC0ocQE3shWLAfffVLB1rhYPG7";
// Computed once with a standalone node script (repeat the secret to 32 bytes, PKCS#8 prefix + seed, createPublicKey), then
// publicKey.export({ type: "spki", format: "der" }).subarray(12).toString("hex").
const EXPECTED_PUBLIC_KEY_HEX = "d7c362fe78aef81ff23287b493628b5db02a3c4fe30b215e4d19609b5d76673a";

function signed(body: Buffer, timestamp: string, secret = SECRET): string {
  const { privateKey } = deriveQqbotEd25519KeyPair(secret);
  return sign(null, Buffer.concat([Buffer.from(timestamp, "utf8"), body]), privateKey).toString("hex");
}

describe("QQBot ed25519 verification", () => {
  const body = Buffer.from(JSON.stringify({ op: 0, t: "C2C_MESSAGE_CREATE", d: { id: "m1" } }));
  const timestamp = "1725442341";

  it("pins the seed derivation with a fixed public-key vector", () => {
    const { publicKey } = deriveQqbotEd25519KeyPair(SECRET);
    const raw = publicKey.export({ type: "spki", format: "der" }).subarray(12).toString("hex");
    expect(raw).toBe(EXPECTED_PUBLIC_KEY_HEX);
  });

  it("verifies a good signature", () => {
    expect(
      verifyQqbotSignature({ appSecret: SECRET, signatureHex: signed(body, timestamp), timestamp, rawBody: body }),
    ).toBe(true);
  });

  it("rejects a flipped body byte, a wrong timestamp, a wrong secret and missing or malformed headers", () => {
    const signature = signed(body, timestamp);
    const flipped = Buffer.from(body);
    flipped[3] = flipped[3]! ^ 1;
    expect(verifyQqbotSignature({ appSecret: SECRET, signatureHex: signature, timestamp, rawBody: flipped })).toBe(
      false,
    );
    expect(
      verifyQqbotSignature({ appSecret: SECRET, signatureHex: signature, timestamp: "1725442342", rawBody: body }),
    ).toBe(false);
    expect(verifyQqbotSignature({ appSecret: "other-secret", signatureHex: signature, timestamp, rawBody: body })).toBe(
      false,
    );
    expect(verifyQqbotSignature({ appSecret: SECRET, signatureHex: undefined, timestamp, rawBody: body })).toBe(false);
    expect(
      verifyQqbotSignature({ appSecret: SECRET, signatureHex: signature, timestamp: undefined, rawBody: body }),
    ).toBe(false);
    expect(verifyQqbotSignature({ appSecret: SECRET, signatureHex: "zz", timestamp, rawBody: body })).toBe(false);
    expect(
      verifyQqbotSignature({ appSecret: SECRET, signatureHex: signature.slice(2), timestamp, rawBody: body }),
    ).toBe(false);
  });

  it("signs the validation challenge over eventTs + plainToken", () => {
    const signature = signQqbotValidation({
      appSecret: SECRET,
      eventTs: "1725442341",
      plainToken: "Arq0D5A61EgUu4OxUvOp",
    });
    expect(signature).toMatch(/^[0-9a-f]{128}$/);
    expect(
      verifyQqbotSignature({
        appSecret: SECRET,
        signatureHex: signature,
        timestamp: "1725442341",
        rawBody: Buffer.from("Arq0D5A61EgUu4OxUvOp"),
      }),
    ).toBe(true);
  });
});

describe("QQBot payload normalization", () => {
  const connectionId = "c1";
  const norm = (payload: unknown) => normalizeQqbotWebhookPayload({ connectionId, payload });

  it("returns a validation request only for well-formed tokens", () => {
    expect(norm({ op: 13, d: { plain_token: "Arq0D5A61EgUu4OxUvOp", event_ts: "1725442341" } })).toEqual({
      kind: "validation",
      plainToken: "Arq0D5A61EgUu4OxUvOp",
      eventTs: "1725442341",
    });
    expect(norm({ op: 13, d: { plain_token: '{"op":0}', event_ts: "1725442341" } })).toMatchObject({ kind: "invalid" });
    expect(norm({ op: 13, d: { plain_token: "ok", event_ts: "12ab" } })).toMatchObject({ kind: "invalid" });
    expect(norm({ op: 13, d: { plain_token: "x".repeat(129), event_ts: "1" } })).toMatchObject({ kind: "invalid" });
    expect(norm({ op: 13, d: {} })).toMatchObject({ kind: "invalid" });
  });

  it("normalizes the four message event types", () => {
    expect(
      norm({
        op: 0,
        t: "GROUP_AT_MESSAGE_CREATE",
        id: "e1",
        d: { id: "m1", content: " hi ", group_openid: "G", author: { member_openid: "U" } },
      }),
    ).toMatchObject({
      kind: "message",
      eventId: "m1",
      eventType: "GROUP_AT_MESSAGE_CREATE",
      scope: "group",
      target: "group:G",
      actorId: "U",
      content: "hi",
    });
    expect(
      norm({ op: 0, t: "C2C_MESSAGE_CREATE", d: { id: "m2", content: "yo", author: { user_openid: "U2" } } }),
    ).toMatchObject({ scope: "c2c", target: "user:U2", actorId: "U2", eventId: "m2" });
    expect(
      norm({
        op: 0,
        t: "AT_MESSAGE_CREATE",
        d: { id: "m3", content: "<@!123> hello", channel_id: "CH", author: { id: "A" } },
      }),
    ).toMatchObject({ scope: "channel", target: "channel:CH", actorId: "A", content: "hello" });
    expect(
      norm({ op: 0, t: "DIRECT_MESSAGE_CREATE", d: { id: "m4", content: "dm", guild_id: "GU", author: { id: "A2" } } }),
    ).toMatchObject({ scope: "dm", target: "dm:GU", actorId: "A2" });
  });

  it("ignores other events, other ops and incomplete messages", () => {
    expect(norm({ op: 0, t: "GUILD_CREATE", d: {} })).toMatchObject({ kind: "ignore" });
    expect(norm({ op: 11 })).toMatchObject({ kind: "ignore" });
    expect(norm(null)).toMatchObject({ kind: "ignore" });
    expect(norm({ op: 0, t: "C2C_MESSAGE_CREATE", d: { id: "m", content: "x", author: {} } })).toMatchObject({
      kind: "ignore",
    });
    expect(
      norm({ op: 0, t: "C2C_MESSAGE_CREATE", d: { id: "m", content: "  ", author: { user_openid: "U" } } }),
    ).toMatchObject({ kind: "ignore" });
  });
});

describe("isQqbotWebhookPath", () => {
  it("matches only the connection webhook path", () => {
    expect(isQqbotWebhookPath("/api/v1/integrations/connections/abc/qqbot/webhook")).toBe(true);
    expect(isQqbotWebhookPath("/api/v1/integrations/connections/abc/qqbot/webhook?x=1")).toBe(true);
    expect(isQqbotWebhookPath("/api/v1/integrations/connections/abc/qqbot/other")).toBe(false);
  });
});
