import { describe, expect, it } from "vitest";
import { createCipheriv } from "node:crypto";
import {
  computeWecomSignature,
  decryptWecomMessage,
  encryptWecomMessageForTest,
  isWecomWebhookPath,
  normalizeWecomMessage,
  readWecomXmlFields,
} from "./wecom-webhook.js";

// 43 base64 characters; decodes (with the implicit "=") to 32 bytes.
const AES_KEY = "abcdefghijklmnopqrstuvwxyz0123456789ABCDEFG";
const CORP_ID = "wx5823bf96d3bd56c7";
const FIXED_RANDOM = Buffer.from("0123456789abcdef", "utf8");

describe("WeCom signature", () => {
  it("matches a hand-computed SHA-1 vector over the sorted, concatenated values", () => {
    // printf '13726231491409659813abctok' | sha1sum
    expect(computeWecomSignature("tok", "1409659813", "1372623149", "abc")).toBe(
      "7d6dddc0d68315ac7701beea6887b7470ff17b95",
    );
  });

  it("sorts its inputs, so argument position does not matter", () => {
    expect(computeWecomSignature("abc", "1372623149", "1409659813", "tok")).toBe(
      computeWecomSignature("tok", "1409659813", "1372623149", "abc"),
    );
  });
});

describe("WeCom AES-CBC message crypto", () => {
  function encryptRaw(plaintext: Buffer): string {
    const key = Buffer.from(`${AES_KEY}=`, "base64");
    const cipher = createCipheriv("aes-256-cbc", key, key.subarray(0, 16));
    cipher.setAutoPadding(false);
    return Buffer.concat([cipher.update(plaintext), cipher.final()]).toString("base64");
  }

  function framed(message: string, receiveId: string): Buffer {
    const msg = Buffer.from(message, "utf8");
    const len = Buffer.alloc(4);
    len.writeUInt32BE(msg.length);
    return Buffer.concat([FIXED_RANDOM, len, msg, Buffer.from(receiveId, "utf8")]);
  }

  function decryptRaw(encrypted: string): string {
    return decryptWecomMessage({ encodingAesKey: AES_KEY, encrypted, expectedReceiveId: CORP_ID });
  }

  it("round-trips with a fixed key and fixed random prefix, including non-ASCII text", () => {
    const input = {
      encodingAesKey: AES_KEY,
      message: "<xml>héllo 你好</xml>",
      receiveId: CORP_ID,
      random: FIXED_RANDOM,
    };
    const encrypted = encryptWecomMessageForTest(input);
    expect(encrypted).toBe(encryptWecomMessageForTest(input));
    expect(decryptRaw(encrypted)).toBe("<xml>héllo 你好</xml>");
  });

  it("pads with PKCS#7 at block size 32 (an aligned plaintext gains a full block)", () => {
    // 16 random + 4 length + 12 message + 0 receive id = 32 bytes.
    const encrypted = encryptWecomMessageForTest({
      encodingAesKey: AES_KEY,
      message: "twelve bytes",
      receiveId: "",
      random: FIXED_RANDOM,
    });
    expect(Buffer.from(encrypted, "base64").length).toBe(64);
    expect(decryptWecomMessage({ encodingAesKey: AES_KEY, encrypted, expectedReceiveId: "" })).toBe("twelve bytes");
  });

  it("throws on a receive id mismatch without echoing either id", () => {
    const encrypted = encryptWecomMessageForTest({
      encodingAesKey: AES_KEY,
      message: "hi",
      receiveId: "wxforeign",
      random: FIXED_RANDOM,
    });
    let message = "";
    try {
      decryptRaw(encrypted);
    } catch (error) {
      message = (error as Error).message;
    }
    expect(message).toBe("WeCom receive id mismatch");
  });

  it("rejects bad padding: zero, oversized, and inconsistent pad bytes", () => {
    const body = framed("hello", CORP_ID);
    const padCount = 32 - (body.length % 32);
    expect(padCount).toBeGreaterThan(1);
    const zeroPadded = Buffer.concat([body, Buffer.alloc(padCount, 0)]);
    const bigPad = Buffer.concat([body, Buffer.alloc(padCount, 33)]);
    const mixed = Buffer.concat([body, Buffer.alloc(padCount - 1, 1), Buffer.from([padCount])]);
    for (const bad of [zeroPadded, bigPad, mixed]) {
      expect(() => decryptRaw(encryptRaw(bad))).toThrow("WeCom message padding is invalid");
    }
  });

  it("accepts a correctly padded raw frame (control for the bad-padding cases)", () => {
    const body = framed("hello", CORP_ID);
    const padCount = 32 - (body.length % 32);
    expect(decryptRaw(encryptRaw(Buffer.concat([body, Buffer.alloc(padCount, padCount)])))).toBe("hello");
  });

  it("rejects a declared message length that overruns the payload", () => {
    const body = framed("hello", CORP_ID);
    body.writeUInt32BE(9999, 16);
    const padCount = 32 - (body.length % 32);
    const padded = Buffer.concat([body, Buffer.alloc(padCount, padCount)]);
    expect(() => decryptRaw(encryptRaw(padded))).toThrow("WeCom message length is invalid");
  });

  it("rejects ciphertext that is empty or not a whole number of AES blocks", () => {
    expect(() => decryptRaw("")).toThrow("WeCom ciphertext is malformed");
    expect(() => decryptRaw(Buffer.alloc(17).toString("base64"))).toThrow("WeCom ciphertext is malformed");
  });

  it("throws a generic message for a malformed key and never echoes the key", () => {
    for (const bad of ["short", `${AES_KEY}X`, "!".repeat(43), ""]) {
      let message = "";
      try {
        decryptWecomMessage({ encodingAesKey: bad, encrypted: "AAAA", expectedReceiveId: CORP_ID });
      } catch (error) {
        message = (error as Error).message;
      }
      expect(message).toBe("WeCom EncodingAESKey is malformed");
    }
    expect(() => encryptWecomMessageForTest({ encodingAesKey: "short", message: "x", receiveId: CORP_ID })).toThrow(
      "WeCom EncodingAESKey is malformed",
    );
  });
});

describe("WeCom XML reader", () => {
  it("reads CDATA and plain flat fields and leaves missing names undefined", () => {
    const xml =
      "<xml><ToUserName><![CDATA[corp]]></ToUserName><AgentID>1000002</AgentID><Content><![CDATA[a < b & c]]></Content></xml>";
    expect(readWecomXmlFields(xml, ["ToUserName", "AgentID", "Content", "MsgId"])).toEqual({
      ToUserName: "corp",
      AgentID: "1000002",
      Content: "a < b & c",
      MsgId: undefined,
    });
  });

  it("decodes only predefined entities in plain values", () => {
    expect(readWecomXmlFields("<xml><Content>a &amp; b &lt;c&gt;</Content></xml>", ["Content"]).Content).toBe(
      "a & b <c>",
    );
  });

  it("rejects DOCTYPE and ENTITY declarations in any case", () => {
    expect(() => readWecomXmlFields('<!DOCTYPE x [<!ENTITY e "v">]><xml><A>1</A></xml>', ["A"])).toThrow(
      "WeCom XML must not contain a DTD or entity declaration",
    );
    expect(() => readWecomXmlFields("<xml><!entity e><A>1</A></xml>", ["A"])).toThrow(
      "WeCom XML must not contain a DTD or entity declaration",
    );
  });

  it("rejects XML over 256 KiB", () => {
    expect(() => readWecomXmlFields(`<xml><A>${"x".repeat(256 * 1024)}</A></xml>`, ["A"])).toThrow(
      "WeCom XML is too large",
    );
  });
});

describe("WeCom normalization", () => {
  const textXml =
    `<xml><ToUserName><![CDATA[${CORP_ID}]]></ToUserName><FromUserName><![CDATA[zhangsan]]></FromUserName>` +
    "<CreateTime>1348831860</CreateTime><MsgType><![CDATA[text]]></MsgType><Content><![CDATA[ hello there ]]></Content>" +
    "<MsgId>1234567890123456</MsgId><AgentID>1000002</AgentID></xml>";

  it("normalizes a text message", () => {
    expect(normalizeWecomMessage({ connectionId: "c1", xml: textXml })).toEqual({
      kind: "message",
      eventId: "1234567890123456",
      actorId: "zhangsan",
      agentId: "1000002",
      content: "hello there",
      metadata: { msgType: "text", createTime: "1348831860", toUserName: CORP_ID, agentId: "1000002" },
    });
  });

  it("ignores events, other message types and incomplete text messages", () => {
    const event =
      "<xml><FromUserName>u</FromUserName><MsgType><![CDATA[event]]></MsgType><Event><![CDATA[subscribe]]></Event></xml>";
    expect(normalizeWecomMessage({ connectionId: "c1", xml: event })).toEqual({
      kind: "ignore",
      reason: "unsupported_msg_type",
    });
    expect(
      normalizeWecomMessage({
        connectionId: "c1",
        xml: "<xml><FromUserName>u</FromUserName><MsgType>image</MsgType><MsgId>1</MsgId></xml>",
      }),
    ).toEqual({ kind: "ignore", reason: "unsupported_msg_type" });
    expect(
      normalizeWecomMessage({
        connectionId: "c1",
        xml: "<xml><FromUserName>u</FromUserName><MsgType>text</MsgType><Content>hi</Content></xml>",
      }),
    ).toEqual({ kind: "ignore", reason: "missing_fields" });
  });
});

describe("isWecomWebhookPath", () => {
  it("matches the callback path, ignores the query string and rejects other paths", () => {
    expect(isWecomWebhookPath("/api/v1/integrations/connections/abc/wecom/webhook")).toBe(true);
    expect(isWecomWebhookPath("/api/v1/integrations/connections/abc/wecom/webhook?msg_signature=x")).toBe(true);
    expect(isWecomWebhookPath("/api/v1/integrations/connections/abc/wecom/webhook/extra")).toBe(false);
    expect(isWecomWebhookPath("/api/v1/integrations/connections/abc/qqbot/webhook")).toBe(false);
  });
});
