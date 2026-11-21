/* eslint-disable no-control-regex -- Reject or strip control characters in untrusted Google content and filenames. */
import nodemailer from "nodemailer";
import { randomUUID } from "node:crypto";
import { createRequire } from "node:module";
import {
  GOOGLE_LIMITS,
  contentHash,
  decodeBase64Url,
  object,
  required,
  sha256,
  strings,
  text,
  type GoogleAttachmentReference,
  type GoogleFilePort,
} from "./google-workspace-common.js";
import { projectGoogleMessage } from "./google-mail-content.js";
type Address = { address?: string; name?: string; group?: Address[] };
const parseAddresses = createRequire(import.meta.url)("nodemailer/lib/addressparser") as (value: string) => Address[];
function mailboxes(value: string): Array<{ address: string; display: string }> {
  const flatten = (items: Address[]): Address[] => items.flatMap((item) => (item.group ? flatten(item.group) : [item]));
  return flatten(parseAddresses(value)).map((item) => {
    const address = required(item.address, "mailbox", 320);
    if (!/^[^\s<>@]+@[^\s<>@]+$/u.test(address)) throw new Error("blocked: Invalid email mailbox.");
    return {
      address: address.toLowerCase(),
      display: item.name ? `${JSON.stringify(required(item.name, "mailbox name", 500))} <${address}>` : address,
    };
  });
}

export interface PreparedGoogleMail {
  raw: string;
  sha256: string;
  materialHash: string;
  toolName: string;
  threadId?: string;
  source?: { kind: "message" | "draft"; id: string; messageId: string; contentHash: string };
}
/** Internal fields are reconstructed by the Gateway, never accepted as model-authored authority. */
export function googleMailMaterial(args: Record<string, unknown>): string {
  return contentHash(Object.fromEntries(Object.entries(args).filter(([key]) => !key.startsWith("_google"))));
}
export async function prepareGoogleMail(
  toolName: string,
  input: Record<string, unknown>,
  files: GoogleFilePort | undefined,
  source?: Record<string, unknown>,
  preparedAt = "2000-01-01T00:00:00.000Z",
): Promise<{ args: Record<string, unknown>; prepared: PreparedGoogleMail }> {
  const args = Object.fromEntries(Object.entries(input).filter(([key]) => !key.startsWith("_google")));
  let sourceIdentity: PreparedGoogleMail["source"];
  let existingRaw: string | undefined;
  if (source) {
    const isDraft = source.kind === "draft";
    const raw = object(isDraft ? object(source.full).message : source.full);
    const message = projectGoogleMessage(raw);
    if (message.truncated && toolName !== "gmail.delete_draft")
      throw new Error(
        "blocked: The source message exceeds the review limit. Review a shorter outgoing message instead.",
      );
    sourceIdentity = {
      kind: isDraft ? "draft" : "message",
      id: required(isDraft ? source.draftId : raw.id, "source id"),
      messageId: message.id,
      contentHash: message.contentHash,
    };
    if (toolName === "gmail.delete_draft") {
      if (!isDraft || !text(source.raw)) throw new Error("blocked: Read the draft before deleting it.");
      args.draftId = sourceIdentity.id;
      args._googleSourceSummary = `Draft ${sourceIdentity.id}: ${message.headers.subject ?? "(no subject)"}`;
      const bytes = decodeBase64Url(source.raw, GOOGLE_LIMITS.outgoingBytes);
      return {
        args,
        prepared: {
          raw: String(source.raw),
          sha256: sha256(bytes),
          materialHash: googleMailMaterial(args),
          toolName,
          source: sourceIdentity,
        },
      };
    }
    if (toolName === "gmail.send_draft" || toolName === "gmail.delete_draft") {
      if (!isDraft || !text(source.raw)) throw new Error("blocked: Read the saved draft before sending it.");
      existingRaw = String(source.raw);
      args.draftId = sourceIdentity.id;
      const reviewed = toolName === "gmail.delete_draft" ? message.headers : reviewDraftHeaders(existingRaw, raw);
      args.to = reviewed.to ? [reviewed.to] : [];
      args.cc = reviewed.cc ? [reviewed.cc] : [];
      args.bcc = reviewed.bcc ? [reviewed.bcc] : [];
      args.subject = reviewed.subject ?? "";
      const allBodies = projectGoogleMessage(raw, true);
      if (allBodies.truncated && toolName !== "gmail.delete_draft")
        throw new Error(
          "blocked: The saved draft has more text than can be reviewed. Save a shorter draft before sending.",
        );
      args.bodyText = allBodies.bodyText;
      args._googleDraftHeaders = ["from", "sender", "reply-to"]
        .filter((key) => reviewed[key])
        .map((key) => `${key}: ${reviewed[key]}`)
        .join("\n");
      args._googleAttachmentSummary = message.attachments
        .map((attachment) => `${attachment.filename} (${attachment.size} bytes)`)
        .join(", ");
    } else if (toolName === "gmail.reply") {
      if (isDraft || !message.threadId || !message.headers["message-id"])
        throw new Error("blocked: Read an original message with its thread and Message-ID before replying.");
      args.to = [required(message.headers["reply-to"] ?? message.headers.from, "reply recipient")];
      if (args.replyAll === true) {
        const excluded = new Set(
          [...mailboxes(message.headers["delivered-to"] ?? ""), ...mailboxes(String((args.to as string[])[0]))].map(
            (item) => item.address,
          ),
        );
        const recipients = [...strings(args.cc), message.headers.to ?? "", message.headers.cc ?? ""].flatMap(mailboxes);
        args.cc = [
          ...new Map(
            recipients.filter((item) => !excluded.has(item.address)).map((item) => [item.address, item.display]),
          ).values(),
        ];
      }
      args.subject = message.headers.subject ?? "";
    } else if (toolName === "gmail.forward") {
      if (isDraft) throw new Error("blocked: Forward requires a reviewed received message.");
      args.subject = text(args.subject) ?? `Fwd: ${message.headers.subject ?? ""}`;
      args.bodyText = `${typeof args.bodyText === "string" ? args.bodyText : ""}\n\n---------- Forwarded message ----------\nFrom: ${message.headers.from ?? ""}\nDate: ${message.headers.date ?? ""}\nSubject: ${message.headers.subject ?? ""}\nTo: ${message.headers.to ?? ""}\n\n${message.bodyText}`;
    }
    if (toolName === "gmail.save_draft") {
      if (!isDraft || (args.draftId && args.draftId !== sourceIdentity.id))
        throw new Error("blocked: The reviewed draft does not match the update target.");
      args.draftId = sourceIdentity.id;
    }
    args._googleSourceSummary = `${isDraft ? "Draft" : "Message"} ${sourceIdentity.id}: ${message.headers.subject ?? "(no subject)"}`;
    args._googleSourceContentHash = message.contentHash;
  }
  const to = headerList(args.to, Boolean(existingRaw));
  const cc = headerList(args.cc, Boolean(existingRaw));
  const bcc = headerList(args.bcc, Boolean(existingRaw));
  if (toolName !== "gmail.save_draft" && toolName !== "gmail.delete_draft" && !to.length && !cc.length && !bcc.length)
    throw new Error("blocked: At least one recipient is required.");
  const subject = typeof args.subject === "string" ? args.subject : "";
  if (/[\r\n\x00-\x1f\x7f]/u.test(subject) || Buffer.byteLength(subject) > 998)
    throw new Error("blocked: The subject contains a header injection or exceeds the limit.");
  const body = typeof args.bodyText === "string" ? args.bodyText : "";
  if (Buffer.byteLength(body) > GOOGLE_LIMITS.messageText)
    throw new Error("blocked: Outgoing message text exceeds 128 KiB.");
  const attachmentValues = args.attachments === undefined ? [] : args.attachments;
  if (!Array.isArray(attachmentValues) || attachmentValues.length > 20)
    throw new Error("blocked: At most 20 attachments are allowed.");
  let totalAttachmentBytes = 0;
  const attachments = await Promise.all(
    attachmentValues.map(async (value) => {
      if (!files) throw new Error("blocked: Governed attachment access is unavailable.");
      const ref = object(value);
      const reference: GoogleAttachmentReference = {
        path: required(ref.path, "attachment path", 4096),
        sha256: required(ref.sha256, "attachment hash", 64),
        filename: safeMailFilename(ref.filename),
        ...(text(ref.contentType) ? { contentType: required(ref.contentType, "attachment content type", 200) } : {}),
      };
      if (!/^[a-f0-9]{64}$/u.test(reference.sha256)) throw new Error("blocked: Invalid attachment hash.");
      const bytes = await files.read(reference);
      totalAttachmentBytes += bytes.length;
      if (
        bytes.length > GOOGLE_LIMITS.attachmentBytes ||
        totalAttachmentBytes > GOOGLE_LIMITS.outgoingBytes ||
        sha256(bytes) !== reference.sha256
      )
        throw new Error("blocked: An attachment changed or exceeded its byte limit.");
      return { filename: reference.filename, content: Buffer.from(bytes), contentType: reference.contentType };
    }),
  );
  let raw = existingRaw;
  const materialHash = googleMailMaterial(args);
  if (!raw) {
    const sourceMessage = source
      ? projectGoogleMessage(source.kind === "draft" ? object(source.full).message : source.full)
      : undefined;
    const transport = nodemailer.createTransport({
      streamTransport: true,
      buffer: true,
      newline: "windows",
      disableFileAccess: true,
      disableUrlAccess: true,
    });
    // Gmail determines BCC recipients from the submitted MIME; nodemailer's composer supports keepBcc.
    const threading =
      toolName === "gmail.reply" && sourceMessage
        ? {
            inReplyTo: sourceMessage.headers["message-id"],
            references: [sourceMessage.headers.references, sourceMessage.headers["message-id"]]
              .filter(Boolean)
              .join(" "),
          }
        : source?.kind === "draft" && sourceMessage
          ? { inReplyTo: sourceMessage.headers["in-reply-to"], references: sourceMessage.headers.references }
          : {};
    const mailOptions = {
      to,
      cc,
      bcc,
      keepBcc: true,
      subject,
      text: body,
      attachments,
      date: new Date(preparedAt),
      messageId: `<${randomUUID()}@goatcitadel.local>`,
      ...threading,
      disableFileAccess: true,
      disableUrlAccess: true,
    };
    const result = await transport.sendMail(mailOptions);
    raw = Buffer.from(result.message as Buffer).toString("base64url");
  }
  const bytes = decodeBase64Url(raw, GOOGLE_LIMITS.outgoingBytes);
  const threadId =
    source?.kind === "draft"
      ? text(object(object(source.full).message).threadId)
      : toolName === "gmail.reply" && source
        ? text(object(source.full).threadId)
        : undefined;
  return {
    args,
    prepared: {
      raw,
      sha256: sha256(bytes),
      materialHash,
      toolName,
      ...(sourceIdentity ? { source: sourceIdentity } : {}),
      ...(threadId ? { threadId } : {}),
    },
  };
}
function headerList(value: unknown, savedDraft = false): string[] {
  const result = strings(value);
  if (result.some((item) => item.length > (savedDraft ? 8192 : 998) || !/@/u.test(item)))
    throw new Error("blocked: A recipient address is invalid.");
  return result;
}

/** The full/raw reads must describe exactly the same bounded recipient headers. Never review a lossy subset. */
function reviewDraftHeaders(raw: string, full: Record<string, unknown>): Record<string, string> {
  const bytes = decodeBase64Url(raw, GOOGLE_LIMITS.outgoingBytes);
  const end = bytes.indexOf("\r\n\r\n");
  const lfEnd = bytes.indexOf("\n\n");
  const boundary = end >= 0 ? end : lfEnd;
  if (boundary < 0 || boundary > 65536)
    throw new Error("blocked: The saved draft headers cannot be reviewed safely. Save a fresh draft.");
  const selected = new Set(["to", "cc", "bcc", "subject", "from", "sender", "reply-to"]);
  const parse = (entries: Array<{ name: string; value: string }>) => {
    const result: Record<string, string> = {};
    for (const { name, value } of entries) {
      const key = name.toLowerCase();
      if (key.startsWith("resent-")) throw new Error("blocked: Resent draft headers require a fresh draft.");
      if (!selected.has(key)) continue;
      const normalized = value.replace(/\r?\n[ \t]+/gu, " ").trim();
      if (Object.hasOwn(result, key) || normalized.length > 8192 || /[\x00-\x1f\x7f]/u.test(normalized))
        throw new Error("blocked: Duplicate, oversized or ambiguous draft headers. Save a fresh draft.");
      result[key] = normalized;
    }
    return result;
  };
  const lines = bytes
    .subarray(0, boundary)
    .toString("utf8")
    .replace(/\r?\n[ \t]+/gu, " ")
    .split(/\r?\n/u);
  const rawHeaders = parse(
    lines.map((line) => {
      const colon = line.indexOf(":");
      if (colon <= 0) throw new Error("blocked: Invalid saved draft header.");
      return { name: line.slice(0, colon), value: line.slice(colon + 1) };
    }),
  );
  const fullHeaders = parse(
    (Array.isArray(object(full.payload).headers) ? (object(full.payload).headers as unknown[]) : []).map((item) => {
      const header = object(item);
      return { name: String(header.name), value: String(header.value) };
    }),
  );
  if (contentHash(rawHeaders) !== contentHash(fullHeaders))
    throw new Error("blocked: The saved draft raw headers differ from the reviewed message. Read it again.");
  return rawHeaders;
}
export function safeMailFilename(value: unknown): string {
  const name = required(value, "attachment filename", 255);
  if (/[\\/:<>"|?*]/u.test(name) || name === "." || name === ".." || /[. ]$/u.test(name))
    throw new Error("blocked: Unsafe attachment filename.");
  return name;
}
