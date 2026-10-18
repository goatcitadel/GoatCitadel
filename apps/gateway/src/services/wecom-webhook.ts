import { createCipheriv, createDecipheriv, createHash, randomBytes } from "node:crypto";

const WECOM_WEBHOOK_PATH = /^\/api\/v1\/integrations\/connections\/[^/]+\/wecom\/webhook$/i;
const ENCODING_AES_KEY = /^[A-Za-z0-9+/]{43}$/;
const AES_BLOCK_BYTES = 16;
const PKCS7_BLOCK_BYTES = 32;
const FRAME_HEADER_BYTES = 20; // 16 random bytes + uint32 BE message length
const MAX_XML_BYTES = 256 * 1024;
const XML_DTD = /<!\s*(?:DOCTYPE|ENTITY)/i;

export type WecomNormalization =
  | {
      kind: "message";
      eventId: string;
      actorId: string;
      agentId?: string;
      content: string;
      metadata: Record<string, unknown>;
    }
  | { kind: "ignore"; reason: string };

export function isWecomWebhookPath(url: string): boolean {
  const pathname = url.split("?", 1)[0] ?? url;
  return WECOM_WEBHOOK_PATH.test(pathname);
}

/** sha1 hex of the lexicographically sorted token, timestamp, nonce and encrypted value, concatenated. */
export function computeWecomSignature(token: string, timestamp: string, nonce: string, encrypted: string): string {
  return createHash("sha1").update([token, timestamp, nonce, encrypted].sort().join("")).digest("hex");
}

function deriveKey(encodingAesKey: string): Buffer {
  // Never echo the configured key, even partially.
  const malformed = new Error("WeCom EncodingAESKey is malformed");
  if (typeof encodingAesKey !== "string" || !ENCODING_AES_KEY.test(encodingAesKey)) {
    throw malformed;
  }
  const key = Buffer.from(`${encodingAesKey}=`, "base64");
  if (key.length !== 32) {
    throw malformed;
  }
  return key;
}

export function decryptWecomMessage(input: {
  encodingAesKey: string;
  encrypted: string;
  expectedReceiveId: string;
}): string {
  const key = deriveKey(input.encodingAesKey);
  const ciphertext = Buffer.from(input.encrypted, "base64");
  if (ciphertext.length === 0 || ciphertext.length % AES_BLOCK_BYTES !== 0) {
    throw new Error("WeCom ciphertext is malformed");
  }
  const decipher = createDecipheriv("aes-256-cbc", key, key.subarray(0, AES_BLOCK_BYTES));
  decipher.setAutoPadding(false);
  let padded: Buffer;
  try {
    padded = Buffer.concat([decipher.update(ciphertext), decipher.final()]);
  } catch {
    throw new Error("WeCom ciphertext is malformed");
  }

  const padLength = padded[padded.length - 1] ?? 0;
  if (padLength < 1 || padLength > PKCS7_BLOCK_BYTES || padLength > padded.length) {
    throw new Error("WeCom message padding is invalid");
  }
  for (let index = padded.length - padLength; index < padded.length; index += 1) {
    if (padded[index] !== padLength) {
      throw new Error("WeCom message padding is invalid");
    }
  }
  const frame = padded.subarray(0, padded.length - padLength);
  if (frame.length < FRAME_HEADER_BYTES) {
    throw new Error("WeCom message length is invalid");
  }
  const messageLength = frame.readUInt32BE(AES_BLOCK_BYTES);
  const messageEnd = FRAME_HEADER_BYTES + messageLength;
  if (messageEnd > frame.length) {
    throw new Error("WeCom message length is invalid");
  }
  const receiveId = frame.subarray(messageEnd).toString("utf8");
  if (receiveId !== input.expectedReceiveId) {
    throw new Error("WeCom receive id mismatch");
  }
  return frame.subarray(FRAME_HEADER_BYTES, messageEnd).toString("utf8");
}

/** Test helper: builds the ciphertext WeCom would send. Not used on any runtime path. */
export function encryptWecomMessageForTest(input: {
  encodingAesKey: string;
  message: string;
  receiveId: string;
  random?: Buffer;
}): string {
  const key = deriveKey(input.encodingAesKey);
  const random = input.random ?? randomBytes(AES_BLOCK_BYTES);
  if (random.length !== AES_BLOCK_BYTES) {
    throw new Error("WeCom test random prefix must be 16 bytes");
  }
  const message = Buffer.from(input.message, "utf8");
  const length = Buffer.alloc(4);
  length.writeUInt32BE(message.length);
  const frame = Buffer.concat([random, length, message, Buffer.from(input.receiveId, "utf8")]);
  const padLength = PKCS7_BLOCK_BYTES - (frame.length % PKCS7_BLOCK_BYTES);
  const padded = Buffer.concat([frame, Buffer.alloc(padLength, padLength)]);
  const cipher = createCipheriv("aes-256-cbc", key, key.subarray(0, AES_BLOCK_BYTES));
  cipher.setAutoPadding(false);
  return Buffer.concat([cipher.update(padded), cipher.final()]).toString("base64");
}

function decodePredefinedEntities(value: string): string {
  return value
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, "&");
}

const DUPLICATE_FIELD_ERROR = "WeCom XML repeats a field";

/**
 * Reads flat `<Name><![CDATA[v]]></Name>` or `<Name>v</Name>` fields that are DIRECT children of the root
 * `<xml>` element. A sequential scanner consumes each element's whole content (CDATA or text) before looking
 * for the next tag, so markup inside a user-controlled value (Content) can never be read as a field. A requested
 * field that appears twice at top level is refused. No DTD, entity declaration or nesting support.
 */
export function readWecomXmlFields(xml: string, names: readonly string[]): Record<string, string | undefined> {
  if (Buffer.byteLength(xml, "utf8") > MAX_XML_BYTES) {
    throw new Error("WeCom XML is too large");
  }
  if (XML_DTD.test(xml)) {
    throw new Error("WeCom XML must not contain a DTD or entity declaration");
  }
  for (const name of names) {
    if (!/^[A-Za-z][A-Za-z0-9]*$/.test(name)) {
      throw new Error("WeCom XML field name is invalid");
    }
  }
  const wanted = new Set(names);
  const result: Record<string, string | undefined> = Object.fromEntries(names.map((name) => [name, undefined]));
  const seen = new Set<string>();

  const root = /^\s*(?:<\?xml[^>]*\?>\s*)?<xml>/.exec(xml);
  if (!root) {
    throw new Error("WeCom XML root element is missing");
  }
  let position = root[0].length;
  const open = /\s*<([A-Za-z][A-Za-z0-9]*)(\s*\/)?>/y;
  const rootClose = /\s*<\/xml>\s*$/y;
  for (;;) {
    rootClose.lastIndex = position;
    if (rootClose.test(xml)) {
      return result;
    }
    open.lastIndex = position;
    const tag = open.exec(xml);
    if (!tag) {
      throw new Error("WeCom XML is malformed");
    }
    const name = tag[1] ?? "";
    position = open.lastIndex;
    let value = "";
    if (!tag[2]) {
      const closeTag = `</${name}>`;
      let cursor = position;
      while (cursor < xml.length && /\s/.test(xml.charAt(cursor))) {
        cursor += 1;
      }
      if (xml.startsWith("<![CDATA[", cursor)) {
        // CDATA cannot contain "]]>", so the first terminator ends it. One indexOf, never past this element.
        const start = cursor + "<![CDATA[".length;
        const end = xml.indexOf("]]>", start);
        if (end < 0) {
          throw new Error("WeCom XML is malformed");
        }
        cursor = end + 3;
        while (cursor < xml.length && /\s/.test(xml.charAt(cursor))) {
          cursor += 1;
        }
        if (!xml.startsWith(closeTag, cursor)) {
          throw new Error("WeCom XML is malformed");
        }
        value = xml.slice(start, end);
        position = cursor + closeTag.length;
      } else {
        // Plain text runs to the next "<", which must open this element's own close tag.
        const lt = xml.indexOf("<", position);
        if (lt < 0 || !xml.startsWith(closeTag, lt)) {
          throw new Error("WeCom XML is malformed");
        }
        value = decodePredefinedEntities(xml.slice(position, lt));
        position = lt + closeTag.length;
      }
    }
    if (wanted.has(name)) {
      if (seen.has(name)) {
        throw new Error(DUPLICATE_FIELD_ERROR);
      }
      seen.add(name);
      result[name] = value;
    }
  }
}

export function normalizeWecomMessage(input: { connectionId: string; xml: string }): WecomNormalization {
  let fields: Record<string, string | undefined>;
  try {
    fields = readWecomXmlFields(input.xml, [
      "ToUserName",
      "FromUserName",
      "CreateTime",
      "MsgType",
      "Content",
      "MsgId",
      "AgentID",
    ]);
  } catch (error) {
    if (error instanceof Error && error.message === DUPLICATE_FIELD_ERROR) {
      return { kind: "ignore", reason: "duplicate_field" };
    }
    throw error;
  }
  // Only plain text is dispatched; events and media types are acknowledged and dropped.
  if (fields.MsgType?.trim() !== "text") {
    return { kind: "ignore", reason: "unsupported_msg_type" };
  }
  const eventId = fields.MsgId?.trim();
  const actorId = fields.FromUserName?.trim();
  const content = fields.Content;
  if (!eventId || !actorId || !content?.trim()) {
    return { kind: "ignore", reason: !eventId ? "missing_msg_id" : "missing_fields" };
  }
  const agentId = fields.AgentID?.trim() || undefined;
  return {
    kind: "message",
    eventId,
    actorId,
    ...(agentId ? { agentId } : {}),
    content,
    metadata: {
      msgType: "text",
      createTime: fields.CreateTime?.trim(),
      toUserName: fields.ToUserName?.trim(),
      ...(agentId ? { agentId } : {}),
    },
  };
}
