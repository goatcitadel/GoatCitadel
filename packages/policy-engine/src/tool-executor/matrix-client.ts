import { createHash, randomUUID } from "node:crypto";
import { assertHostAllowed, fetchAllowlistedOnce, readBoundedResponseJson } from "../sandbox/network-guard.js";

/**
 * Minimal Matrix client-server API (v3) client for outbound channel actions.
 * Transaction ids dedupe a re-sent request only when the caller passes a stable idempotency key.
 * Every request goes through the connection allowlist (and the tool grant
 * allowlist when present); response bodies are read through the bounded reader
 * and error text never includes the access token.
 */
export type MatrixFetcher = (url: string, init: RequestInit) => Promise<Response>;

export interface MatrixClientContext {
  homeserverUrl: string;
  accessToken: string;
  allowlist: string[];
  grantAllowlist?: string[];
  /** Optional transport (the comms executor injects its boundary-tracking fetcher). */
  fetcher?: MatrixFetcher;
}

const MATRIX_REQUEST_TIMEOUT_MS = 20_000;
const MATRIX_RESPONSE_LIMITS = { maxBytes: 64 * 1024, timeoutMs: 10_000 } as const;
const MATRIX_TXN_ID_LENGTH = 32;
const DEFAULT_TYPING_TIMEOUT_MS = 30_000;

/**
 * Transaction id: deterministic only when the caller supplies an idempotency key (and chunk index), else random.
 * The gateway does not yet pass one, so retried sends currently get a fresh id and are not deduped by the homeserver.
 */
export function deriveMatrixTxnId(idempotencyKey: string | undefined, chunkIndex = 0): string {
  const key = idempotencyKey?.trim();
  if (!key) {
    return randomUUID();
  }
  return createHash("sha256").update(`${key}:${chunkIndex}`).digest("hex").slice(0, MATRIX_TXN_ID_LENGTH);
}

export async function matrixSendText(
  ctx: MatrixClientContext,
  input: { roomId: string; body: string; txnId: string; replyToEventId?: string; threadRootId?: string },
): Promise<{ eventId: string }> {
  const content: Record<string, unknown> = { msgtype: "m.text", body: input.body };
  if (input.threadRootId) {
    content["m.relates_to"] = {
      rel_type: "m.thread",
      event_id: input.threadRootId,
      is_falling_back: true,
      "m.in_reply_to": { event_id: input.replyToEventId ?? input.threadRootId },
    };
  } else if (input.replyToEventId) {
    content["m.relates_to"] = { "m.in_reply_to": { event_id: input.replyToEventId } };
  }
  return putForEventId(
    ctx,
    `/rooms/${enc(input.roomId)}/send/m.room.message/${enc(input.txnId)}`,
    content,
    "matrix.send",
  );
}

export async function matrixReact(
  ctx: MatrixClientContext,
  input: { roomId: string; eventId: string; key: string; txnId: string },
): Promise<{ eventId: string }> {
  return putForEventId(
    ctx,
    `/rooms/${enc(input.roomId)}/send/m.reaction/${enc(input.txnId)}`,
    { "m.relates_to": { rel_type: "m.annotation", event_id: input.eventId, key: input.key } },
    "matrix.react",
  );
}

export async function matrixRedact(
  ctx: MatrixClientContext,
  input: { roomId: string; eventId: string; txnId: string; reason?: string },
): Promise<{ eventId: string }> {
  return putForEventId(
    ctx,
    `/rooms/${enc(input.roomId)}/redact/${enc(input.eventId)}/${enc(input.txnId)}`,
    input.reason ? { reason: input.reason } : {},
    "matrix.unsend",
  );
}

export async function matrixSetTyping(
  ctx: MatrixClientContext,
  input: { roomId: string; userId: string; typing: boolean; timeoutMs?: number },
): Promise<void> {
  await matrixRequest(
    ctx,
    "PUT",
    `/rooms/${enc(input.roomId)}/typing/${enc(input.userId)}`,
    { typing: input.typing, ...(input.typing ? { timeout: input.timeoutMs ?? DEFAULT_TYPING_TIMEOUT_MS } : {}) },
    "matrix.typing",
  );
}

export async function matrixWhoAmI(ctx: MatrixClientContext): Promise<{ userId: string }> {
  const body = await matrixRequest(ctx, "GET", "/account/whoami", undefined, "matrix.whoami");
  const userId = typeof body.user_id === "string" ? body.user_id.trim() : "";
  if (!userId) {
    throw new Error("matrix.whoami returned no user_id");
  }
  return { userId };
}

async function putForEventId(
  ctx: MatrixClientContext,
  apiPath: string,
  content: Record<string, unknown>,
  label: string,
): Promise<{ eventId: string }> {
  const body = await matrixRequest(ctx, "PUT", apiPath, content, label);
  const eventId = typeof body.event_id === "string" ? body.event_id.trim() : "";
  if (!eventId) {
    throw new Error(`${label} returned no event_id`);
  }
  return { eventId };
}

async function matrixRequest(
  ctx: MatrixClientContext,
  method: "GET" | "PUT",
  apiPath: string,
  content: Record<string, unknown> | undefined,
  label: string,
): Promise<Record<string, unknown>> {
  const base = ctx.homeserverUrl.trim().replace(/\/+$/, "");
  if (!/^https?:\/\//i.test(base)) {
    throw new Error("Matrix homeserver URL must use http or https");
  }
  const url = `${base}/_matrix/client/v3${apiPath}`;
  const headers: Record<string, string> = { Authorization: `Bearer ${ctx.accessToken}` };
  if (content !== undefined) {
    headers["Content-Type"] = "application/json";
  }
  const init: RequestInit = { method, headers, ...(content !== undefined ? { body: JSON.stringify(content) } : {}) };
  const response = ctx.fetcher ? await ctx.fetcher(url, init) : await defaultFetch(ctx, url, init);
  const parsed = await readMatrixBody(response);
  if (!response.ok) {
    const errcode = typeof parsed.errcode === "string" ? parsed.errcode : undefined;
    const error = typeof parsed.error === "string" ? parsed.error : undefined;
    const detail = [errcode, error].filter(Boolean).join(": ").split(ctx.accessToken).join("[redacted]");
    throw new Error(`${label} failed (${response.status})${detail ? `: ${detail}` : ""}`);
  }
  return parsed;
}

async function defaultFetch(ctx: MatrixClientContext, url: string, init: RequestInit): Promise<Response> {
  assertHostAllowed(url, ctx.allowlist);
  if (ctx.grantAllowlist && ctx.grantAllowlist.length > 0) {
    assertHostAllowed(url, ctx.grantAllowlist);
  }
  return fetchAllowlistedOnce(url, {
    allowlist: ctx.allowlist,
    additionalAllowlists: ctx.grantAllowlist ? [ctx.grantAllowlist] : undefined,
    init: { ...init, signal: AbortSignal.timeout(MATRIX_REQUEST_TIMEOUT_MS) },
  });
}

async function readMatrixBody(response: Response): Promise<Record<string, unknown>> {
  try {
    const value = await readBoundedResponseJson(response, MATRIX_RESPONSE_LIMITS);
    return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
  } catch {
    // Non-JSON or oversized bodies: surface only the HTTP status.
    return {};
  }
}

function enc(value: string): string {
  return encodeURIComponent(value);
}
