/* eslint-disable no-control-regex -- Reject or strip control characters in untrusted Google content and filenames. */
import { GOOGLE_LIMITS, boundedText, contentHash, decodeBase64Url, object, text } from "./google-workspace-common.js";

const HEADERS = new Set([
  "from",
  "to",
  "cc",
  "bcc",
  "reply-to",
  "subject",
  "date",
  "message-id",
  "in-reply-to",
  "references",
  "delivered-to",
]);
export interface GoogleMessageProjection extends Record<string, unknown> {
  id: string;
  threadId?: string;
  headers: Record<string, string>;
  bodyText: string;
  truncated: boolean;
  attachments: Array<{ attachmentId: string; filename: string; contentType: string; size: number; partId: string }>;
  contentHash: string;
}
export function projectGoogleMessage(input: unknown, reviewAllAlternatives = false): GoogleMessageProjection {
  const raw = object(input);
  if (!text(raw.id)) throw new Error("Google did not return a message identity.");
  const payload = object(raw.payload);
  const headers: Record<string, string> = {};
  for (const item of Array.isArray(payload.headers) ? payload.headers.slice(0, 200) : []) {
    const header = object(item);
    const name = text(header.name)?.toLowerCase();
    if (name && HEADERS.has(name) && typeof header.value === "string")
      headers[name] = decodeHeader(header.value)
        .replace(/[\r\n\x00-\x1f\x7f]/gu, " ")
        .slice(0, 8192);
  }
  const plain: string[] = [];
  const html: string[] = [];
  const attachments: GoogleMessageProjection["attachments"] = [];
  let nodes = 0;
  let missingText = false;
  function visit(value: unknown, depth: number): void {
    if (depth > 20 || ++nodes > 1000) throw new Error("Google message MIME structure exceeded the limit.");
    const part = object(value);
    const body = object(part.body);
    const filename = text(part.filename);
    const mime = text(part.mimeType)?.toLowerCase() ?? "application/octet-stream";
    if (
      filename ||
      (mime !== "text/plain" &&
        mime !== "text/html" &&
        !mime.startsWith("multipart/") &&
        (body.attachmentId || body.data))
    ) {
      attachments.push({
        attachmentId: text(body.attachmentId) ?? `part:${text(part.partId) ?? "0"}`,
        filename: filename?.slice(0, 255) ?? "attachment",
        contentType: mime,
        size: typeof body.size === "number" ? body.size : 0,
        partId: text(part.partId) ?? "0",
      });
    } else if (
      (mime === "text/plain" || mime === "text/html") &&
      body.attachmentId &&
      (typeof body.data !== "string" || (body.data.length === 0 && body.size !== 0))
    ) {
      missingText = true;
    } else if (typeof body.data === "string" && (mime === "text/plain" || mime === "text/html")) {
      const contentType = (Array.isArray(part.headers) ? part.headers : [])
        .map(object)
        .find((header) => text(header.name)?.toLowerCase() === "content-type");
      const charset = String(contentType?.value ?? "").match(/charset\s*=\s*["']?([^\s;"']+)/iu)?.[1] ?? "utf-8";
      let decoded: string;
      try {
        decoded = new TextDecoder(charset).decode(decodeBase64Url(body.data, GOOGLE_LIMITS.attachmentBytes));
      } catch {
        throw new Error(`Google message uses an unsupported character encoding: ${charset}`);
      }
      (mime === "text/plain" ? plain : html).push(decoded);
    }
    for (const child of Array.isArray(part.parts) ? part.parts : []) visit(child, depth + 1);
  }
  visit(payload, 0);
  const htmlText = html.map(htmlToPlainText).join("\n");
  const body = boundedText(
    reviewAllAlternatives && plain.length && htmlText
      ? `${plain.join("\n")}\n\n[HTML alternative, converted to text]\n${htmlText}`
      : plain.length
        ? plain.join("\n")
        : htmlText,
    GOOGLE_LIMITS.messageText,
  );
  const result = {
    id: String(raw.id),
    ...(text(raw.threadId) ? { threadId: String(raw.threadId) } : {}),
    headers,
    bodyText: body.text,
    truncated: body.truncated || missingText,
    ...(missingText ? { incompleteReason: "A textual MIME part was not loaded." } : {}),
    attachments,
    labelIds: Array.isArray(raw.labelIds) ? raw.labelIds.filter((item) => typeof item === "string").slice(0, 100) : [],
  };
  return { ...result, contentHash: contentHash(result) };
}
function decodeHeader(value: string): string {
  return value
    .replace(/\?=\s+(?==\?)/gu, "?=")
    .replace(/=\?([^?\s]+)\?([bq])\?([^?]*)\?=/giu, (original, charset: string, encoding: string, encoded: string) => {
      try {
        const bytes =
          encoding.toLowerCase() === "b"
            ? Buffer.from(encoded, "base64")
            : Buffer.from(
                encoded
                  .replace(/_/gu, " ")
                  .replace(/=([a-f0-9]{2})/giu, (_match, hex: string) => String.fromCharCode(Number.parseInt(hex, 16))),
                "latin1",
              );
        return new TextDecoder(charset).decode(bytes);
      } catch {
        return original;
      }
    });
}
function htmlToPlainText(value: string): string {
  return value
    .replace(/<(script|style|head)\b[^>]*>[\s\S]*?<\/\1\s*>/giu, "")
    .replace(
      /<[^>]+\b(?:href|src)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))[^>]*>/giu,
      (_tag, quoted, single, bare) => ` [link/resource: ${quoted ?? single ?? bare}] `,
    )
    .replace(/<(?:br|\/p|\/div|\/li)\b[^>]*>/giu, "\n")
    .replace(/<[^>]*>/gu, "")
    .replace(
      /&(?:amp|lt|gt|quot|apos|nbsp);/gu,
      (entity) =>
        ({ "&amp;": "&", "&lt;": "<", "&gt;": ">", "&quot;": '"', "&apos;": "'", "&nbsp;": " " })[entity] ?? entity,
    )
    .trim();
}
