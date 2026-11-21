import { summarizeGmailMessage } from "@goatcitadel/contracts";
import {
  GMAIL_API,
  GOOGLE_LIMITS,
  cursorScope,
  decodeBase64Url,
  id,
  integer,
  nextCursor,
  object,
  readCursor,
  required,
  sha256,
  strings,
  text,
  untrusted,
  type GoogleRuntimePort,
} from "./google-workspace-common.js";
import { projectGoogleMessage } from "./google-mail-content.js";
import { googleMailMaterial, safeMailFilename, type PreparedGoogleMail } from "./google-mail-compose.js";

export async function executeGoogleMailAction(
  toolName: string,
  args: Record<string, unknown>,
  port: GoogleRuntimePort,
  prepared?: PreparedGoogleMail,
): Promise<Record<string, unknown>> {
  const http = port.http;
  if (toolName === "gmail.read") {
    const scope = cursorScope(toolName, args, port.identity);
    const url = new URL(`${GMAIL_API}/messages`);
    url.searchParams.set(
      "maxResults",
      String(Math.min(25, Math.max(1, typeof args.maxResults === "number" ? Math.floor(args.maxResults) : 10))),
    );
    if (text(args.query)) url.searchParams.set("q", String(args.query));
    const token = readCursor(args.pageToken, scope);
    if (token) url.searchParams.set("pageToken", token);
    const page = await http(url.toString(), { readOnly: true });
    const records = [];
    for (const item of (Array.isArray(page.messages) ? page.messages : []).slice(0, 25)) {
      const messageId = text(object(item).id);
      // A malformed provider list entry must not turn the remaining readable messages into a failed batch.
      if (!messageId || /[\s/\\?#\u0000-\u001f]/u.test(messageId) || messageId === "." || messageId === "..") continue;
      const detailUrl = new URL(`${GMAIL_API}/messages/${id(messageId, "messageId")}`);
      detailUrl.searchParams.set("format", "metadata");
      for (const header of ["From", "To", "Subject", "Date"]) detailUrl.searchParams.append("metadataHeaders", header);
      const summary = summarizeGmailMessage(await http(detailUrl.toString(), { readOnly: true, missingAsEmpty: true }));
      if (summary) records.push(summary);
    }
    return untrusted({ records, ...nextCursor(page.nextPageToken, scope) }, "gmail:users/me/messages");
  }
  if (toolName === "gmail.get_message") {
    const raw = await completeMessage(
      await http(`${GMAIL_API}/messages/${id(args.messageId, "messageId")}?format=full`, { readOnly: true }),
      port,
    );
    const message = projectGoogleMessage(raw);
    const snapshot = await port.captureSource?.({ kind: "message", full: raw });
    return untrusted(
      { message, ...(snapshot ? { googleSourceSnapshot: snapshot } : {}) },
      `gmail:message:${message.id}`,
    );
  }
  if (toolName === "gmail.get_thread") {
    const threadId = id(args.threadId, "threadId");
    const minimal = await http(`${GMAIL_API}/threads/${threadId}?format=minimal&fields=id,messages(id)`, {
      readOnly: true,
    });
    const ids = (Array.isArray(minimal.messages) ? minimal.messages : [])
      .map((value) => text(object(value).id))
      .filter((value): value is string => Boolean(value));
    const offset = integer(args.offset, 0, 0, 100_000);
    const messages = [];
    let bytes = 0;
    let truncated = false;
    for (const messageId of ids.slice(offset, offset + GOOGLE_LIMITS.threadMessages)) {
      const message = projectGoogleMessage(
        await completeMessage(
          await http(`${GMAIL_API}/messages/${id(messageId, "messageId")}?format=full`, { readOnly: true }),
          port,
        ),
      );
      const nextBytes = Buffer.byteLength(message.bodyText);
      if (bytes + nextBytes > GOOGLE_LIMITS.threadText) {
        truncated = true;
        break;
      }
      bytes += nextBytes;
      messages.push(message);
      truncated ||= message.truncated;
    }
    const nextOffset = offset + messages.length;
    return untrusted(
      {
        threadId: args.threadId,
        messages,
        truncated,
        hasMore: nextOffset < ids.length,
        ...(nextOffset < ids.length ? { nextOffset } : {}),
      },
      `gmail:thread:${args.threadId}`,
    );
  }
  if (toolName === "gmail.list_labels") {
    const page = await http(`${GMAIL_API}/labels`, { readOnly: true });
    return untrusted({ records: (Array.isArray(page.labels) ? page.labels : []).slice(0, 1000) }, "gmail:labels");
  }
  if (toolName === "gmail.list_drafts") {
    const scope = cursorScope(toolName, args, port.identity);
    const url = new URL(`${GMAIL_API}/drafts`);
    url.searchParams.set("maxResults", String(integer(args.maxResults, 25, 1, 100)));
    const token = readCursor(args.pageToken, scope);
    if (token) url.searchParams.set("pageToken", token);
    const page = await http(url.toString(), { readOnly: true });
    return untrusted(
      { records: Array.isArray(page.drafts) ? page.drafts : [], ...nextCursor(page.nextPageToken, scope) },
      "gmail:drafts",
    );
  }
  if (toolName === "gmail.get_draft") {
    const draftId = id(args.draftId, "draftId");
    const full = await http(`${GMAIL_API}/drafts/${draftId}?format=full`, { readOnly: true });
    full.message = await completeMessage(object(full.message), port);
    const raw = await http(`${GMAIL_API}/drafts/${draftId}?format=raw`, { readOnly: true });
    const message = projectGoogleMessage(full.message);
    if (object(raw.message).id !== message.id || !text(object(raw.message).raw))
      throw new Error("blocked: The draft changed while it was being read. Read it again.");
    decodeBase64Url(object(raw.message).raw, GOOGLE_LIMITS.outgoingBytes);
    const snapshot = await port.captureSource?.({
      kind: "draft",
      draftId: args.draftId,
      full,
      raw: object(raw.message).raw,
    });
    return untrusted(
      { draftId: args.draftId, message, ...(snapshot ? { googleSourceSnapshot: snapshot } : {}) },
      `gmail:draft:${args.draftId}`,
    );
  }
  if (toolName === "gmail.download_attachment") {
    if (!port.files) throw new Error("blocked: Governed artifact storage is unavailable.");
    const filename = safeMailFilename(args.filename);
    const message = await completeMessage(
      await http(`${GMAIL_API}/messages/${id(args.messageId, "messageId")}?format=full`, { readOnly: true }),
      port,
    );
    const projection = projectGoogleMessage(message);
    if (projection.contentHash !== args._googleAttachmentSourceHash)
      throw new Error("blocked: The attachment source changed after review. Read the message again.");
    const descriptor = projection.attachments.find(
      (item) => item.attachmentId === args.attachmentId && item.filename === filename,
    );
    if (!descriptor || descriptor.size > GOOGLE_LIMITS.attachmentBytes)
      throw new Error("blocked: Attachment identity, filename or size does not match the reviewed message.");
    let data: unknown;
    if (String(args.attachmentId).startsWith("part:")) {
      const stack: unknown[] = [message.payload];
      let seen = 0;
      while (stack.length && ++seen <= 1000) {
        const part = object(stack.pop());
        if ((text(part.partId) ?? "0") === descriptor.partId) {
          data = object(part.body).data;
          break;
        }
        if (Array.isArray(part.parts)) stack.push(...part.parts);
      }
    } else {
      const attachment = await http(
        `${GMAIL_API}/messages/${id(args.messageId, "messageId")}/attachments/${id(args.attachmentId, "attachmentId")}`,
        { readOnly: true },
      );
      data = attachment.data;
    }
    const bytes = decodeBase64Url(data, GOOGLE_LIMITS.attachmentBytes);
    if (bytes.length !== descriptor.size)
      throw new Error("blocked: Downloaded attachment size differs from the reviewed descriptor.");
    const artifact = await port.files.write({ bytes, filename, contentType: descriptor.contentType });
    return untrusted(
      { artifact, path: artifact.path, bytesWritten: bytes.length, byteLength: bytes.length, sha256: sha256(bytes) },
      `gmail:attachment:${args.messageId}:${args.attachmentId}`,
    );
  }
  if (
    [
      "gmail.send",
      "gmail.reply",
      "gmail.forward",
      "gmail.save_draft",
      "gmail.send_draft",
      "gmail.delete_draft",
    ].includes(toolName)
  ) {
    if (
      !prepared ||
      prepared.toolName !== toolName ||
      prepared.materialHash !== googleMailMaterial(args) ||
      sha256(decodeBase64Url(prepared.raw, GOOGLE_LIMITS.outgoingBytes)) !== prepared.sha256
    )
      throw new Error("blocked: A Gateway-prepared immutable message review is required. Prepare this action again.");
    if (prepared.source) {
      const source = prepared.source;
      const current = await http(
        source.kind === "draft"
          ? `${GMAIL_API}/drafts/${id(source.id, "draftId")}?format=full`
          : `${GMAIL_API}/messages/${id(source.id, "messageId")}?format=full`,
        { readOnly: true },
      );
      const projected = projectGoogleMessage(
        await completeMessage(object(source.kind === "draft" ? current.message : current), port),
      );
      if (projected.id !== source.messageId || projected.contentHash !== source.contentHash)
        throw new Error(
          "blocked: The source message or draft changed after review. Read it again and request a new approval.",
        );
    }
    const message = { raw: prepared.raw, ...(prepared.threadId ? { threadId: prepared.threadId } : {}) };
    let result: Record<string, unknown>;
    if (toolName === "gmail.delete_draft") {
      if (prepared.source?.kind !== "draft") throw new Error("blocked: Read the draft before deleting it.");
      await http(`${GMAIL_API}/drafts/${id(prepared.source.id, "draftId")}`, { method: "DELETE" });
      return { providerMessageId: prepared.source.id, deleted: true };
    }
    if (toolName === "gmail.send_draft")
      result = await http(`${GMAIL_API}/drafts/send`, { method: "POST", body: { id: prepared.source?.id, message } });
    else if (toolName === "gmail.save_draft")
      result = await http(`${GMAIL_API}/drafts${args.draftId ? `/${id(args.draftId, "draftId")}` : ""}`, {
        method: args.draftId ? "PUT" : "POST",
        body: { message },
      });
    else result = await http(`${GMAIL_API}/messages/send`, { method: "POST", body: message });
    const providerMessageId = required(result.id, "Google confirmation id");
    return {
      providerMessageId,
      ...(toolName === "gmail.save_draft"
        ? { draftId: providerMessageId, messageId: object(result.message).id, sent: false }
        : { messageId: providerMessageId, sent: true }),
    };
  }
  if (toolName === "gmail.modify_message") {
    const messageId = id(args.messageId, "messageId");
    const operation = required(args.operation, "operation");
    if (operation === "trash" || operation === "restore") {
      const result = await http(`${GMAIL_API}/messages/${messageId}/${operation === "trash" ? "trash" : "untrash"}`, {
        method: "POST",
        body: {},
      });
      return { providerMessageId: required(result.id, "message id"), operation };
    }
    const mutations: Record<string, { addLabelIds: string[]; removeLabelIds: string[] }> = {
      archive: { addLabelIds: [], removeLabelIds: ["INBOX"] },
      unarchive: { addLabelIds: ["INBOX"], removeLabelIds: [] },
      mark_read: { addLabelIds: [], removeLabelIds: ["UNREAD"] },
      mark_unread: { addLabelIds: ["UNREAD"], removeLabelIds: [] },
      labels: { addLabelIds: strings(args.addLabelIds), removeLabelIds: strings(args.removeLabelIds) },
    };
    const body = mutations[operation];
    if (
      !body ||
      (!body.addLabelIds.length && !body.removeLabelIds.length) ||
      [...body.addLabelIds, ...body.removeLabelIds].some((label) => ["SENT", "DRAFT", "TRASH", "SPAM"].includes(label))
    )
      throw new Error("blocked: Invalid label change; use the explicit Trash/restore action for Trash.");
    const result = await http(`${GMAIL_API}/messages/${messageId}/modify`, { method: "POST", body });
    return { providerMessageId: required(result.id, "message id"), operation };
  }
  if (toolName === "gmail.create_label" || toolName === "gmail.update_label") {
    const name = required(args.name, "label name", 225);
    const result = await http(
      `${GMAIL_API}/labels${toolName === "gmail.update_label" ? `/${id(args.labelId, "labelId")}` : ""}`,
      { method: toolName === "gmail.update_label" ? "PATCH" : "POST", body: { name } },
    );
    return { providerMessageId: required(result.id, "label id"), label: result };
  }
  throw new Error(`Unsupported native Gmail action: ${toolName}`);
}

/** Gmail may externalize even text MIME bodies; hydrate only unnamed textual parts, never binary attachments. */
async function completeMessage(
  message: Record<string, unknown>,
  port: GoogleRuntimePort,
): Promise<Record<string, unknown>> {
  let nodes = 0;
  let total = 0;
  async function visit(value: unknown, depth: number): Promise<void> {
    if (++nodes > 1000 || depth > 20) throw new Error("blocked: Message MIME structure exceeds its limit.");
    const part = object(value);
    const body = object(part.body);
    const mime = text(part.mimeType)?.toLowerCase();
    if (
      !text(part.filename) &&
      (mime === "text/plain" || mime === "text/html") &&
      body.attachmentId &&
      (typeof body.data !== "string" || (body.data.length === 0 && body.size !== 0))
    ) {
      if (typeof body.size === "number" && body.size > GOOGLE_LIMITS.attachmentBytes)
        throw new Error("blocked: External text body exceeds the message review limit.");
      const response = await port.http(
        `${GMAIL_API}/messages/${id(message.id, "messageId")}/attachments/${id(body.attachmentId, "body attachmentId")}`,
        { readOnly: true },
      );
      const bytes = decodeBase64Url(response.data, GOOGLE_LIMITS.attachmentBytes);
      if (typeof body.size === "number" && bytes.length !== body.size)
        throw new Error("blocked: External text body size differs from its message descriptor.");
      total += bytes.length;
      if (total > GOOGLE_LIMITS.outgoingBytes) throw new Error("blocked: Text MIME bodies exceed the review limit.");
      body.data = response.data;
    }
    for (const child of Array.isArray(part.parts) ? part.parts : []) await visit(child, depth + 1);
  }
  await visit(message.payload, 0);
  return message;
}
