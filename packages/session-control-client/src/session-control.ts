/**
 * HX-411 governed external session-control client.
 *
 * A typed, portable, no-store client for the already-shipped external control
 * routes under `/api/v1/chat/sessions/:sessionId/control/*`. It is deliberately
 * NOT built on the browser-coupled `client-core.ts` singleton (`import.meta.env`,
 * `window`, correlation-store side effects) so the exact same client can drive
 * both the operator UI and the governed Node CLI. Transport, secret-header
 * construction, and typing live here; companion signing / bearer auth is injected
 * by the caller through {@link SessionControlAuthorize} so this module never
 * hardcodes a credential source.
 *
 * Hard secret rules enforced by construction:
 *  - the plaintext control secret is placed ONLY in the frozen
 *    `X-GoatCitadel-Session-Control-Token` header (see
 *    {@link buildSessionControlSecretHeaders});
 *  - it is never written to a URL, query string, request body, or any object
 *    this module returns for inspection, and this module performs no logging;
 *  - every control response is fetched with `cache: "no-store"`.
 */
import {
  SESSION_CONTROL_CLIENT_INSTANCE_HEADER,
  SESSION_CONTROL_GENERATION_HEADER,
  SESSION_CONTROL_TOKEN_HEADER,
} from "@goatcitadel/contracts";
import type {
  SessionControlDetailResponse,
  SessionControlHeartbeatInput,
  SessionControlHeartbeatResponse,
  SessionControlReconnectInput,
  SessionControlReconnectResponse,
  SessionControlReleaseInput,
  SessionControlReleaseResponse,
  SessionControlRequestInput,
  SessionControlRequestResponse,
} from "@goatcitadel/contracts";

import { ApiRequestError, normalizeHttpMethod, parseApiError, unwrapApiResponse } from "./http-internal.js";

/** A request the caller may need to authenticate and/or companion-sign. */
export interface SessionControlSignableRequest {
  readonly method: string;
  /** Path WITHOUT query string (companion signed mutations forbid query params). */
  readonly path: string;
  /** Parsed request body object, or `undefined` for GET reads. */
  readonly body: unknown;
}

/**
 * Injected authorization hook. Returns the auth headers for a request: at least a
 * companion bearer, plus timestamp/nonce/signature headers for signed mutations.
 * The session-control secret is NOT the authorizer's concern — it is added
 * separately, only into the frozen token header.
 */
export type SessionControlAuthorize = (
  request: SessionControlSignableRequest,
) => Promise<Record<string, string>> | Record<string, string>;

export interface SessionControlClientConfig {
  /** Gateway base URL, e.g. `http://127.0.0.1:8787` (no trailing slash required). */
  readonly baseUrl: string;
  /** Fetch implementation. Defaults to `globalThis.fetch`. */
  readonly fetch?: typeof fetch;
  /** Produces bearer + signature headers per request. */
  readonly authorize: SessionControlAuthorize;
  /**
   * Public client-instance identifier. When set it is sent in the frozen
   * client-instance header on every request (every companion control route
   * requires it). It appears in content-free projections and is never a secret.
   */
  readonly clientInstanceId?: string;
}

export interface SessionControlEventStreamOptions {
  /** Resume the retained stream strictly after this event sequence (read continuity only). */
  readonly afterCursor?: number;
  /** Optional client-chosen stream reader id for diagnostics. */
  readonly clientId?: string;
  readonly signal?: AbortSignal;
}

export interface SessionControlClient {
  /** Register a pending, session-scoped control request (submits only the token hash). */
  createExternalRequest(sessionId: string, input: SessionControlRequestInput): Promise<SessionControlRequestResponse>;
  /** Read the content-free current owner/generation/lease + visible pending requests. */
  getControl(sessionId: string): Promise<SessionControlDetailResponse>;
  /** Renew the live lease. Presents the plaintext control secret in the token header. */
  heartbeat(
    sessionId: string,
    input: SessionControlHeartbeatInput,
    controlSecret: string,
  ): Promise<SessionControlHeartbeatResponse>;
  /**
   * Rotate authority from external generation `N` to `N+1`. The OLD plaintext
   * secret is presented in the token header; the body carries only the SHA-256 of
   * the newly generated secret.
   */
  reconnect(
    sessionId: string,
    input: SessionControlReconnectInput,
    oldControlSecret: string,
  ): Promise<SessionControlReconnectResponse>;
  /** Return ownership to a new operator generation. */
  release(
    sessionId: string,
    input: SessionControlReleaseInput,
    controlSecret: string,
  ): Promise<SessionControlReleaseResponse>;
  /** Open the session-scoped, read-only, cursor-resumed control-event stream. */
  openEventStream(sessionId: string, options?: SessionControlEventStreamOptions): Promise<Response>;
}

export interface SessionControlSecretHeaderInput {
  /** Public client-instance id → client-instance header. */
  readonly clientInstanceId?: string;
  /** Canonical decimal controller generation → generation header. */
  readonly generation?: number;
  /** Plaintext control secret → token header ONLY. */
  readonly controlSecret?: string;
}

/**
 * Canonical construction of the frozen session-control headers. The plaintext
 * secret is placed exclusively in `X-GoatCitadel-Session-Control-Token`; the
 * generation and client-instance values are public. Absent inputs are omitted
 * rather than emitted blank so a missing secret never sends an empty token header
 * (which the Gateway treats as an invalid token, fail-closed).
 */
export function buildSessionControlSecretHeaders(input: SessionControlSecretHeaderInput): Record<string, string> {
  const headers: Record<string, string> = {};

  if (input.clientInstanceId !== undefined) {
    const clientInstanceId = input.clientInstanceId.trim();
    if (clientInstanceId.length === 0) {
      throw new TypeError("Session control client instance is required.");
    }
    headers[SESSION_CONTROL_CLIENT_INSTANCE_HEADER] = clientInstanceId;
  }

  if (input.generation !== undefined) {
    if (!Number.isSafeInteger(input.generation) || input.generation < 1) {
      throw new TypeError("Session control generation is invalid.");
    }
    headers[SESSION_CONTROL_GENERATION_HEADER] = String(input.generation);
  }

  if (input.controlSecret !== undefined) {
    if (input.controlSecret.length === 0) {
      throw new TypeError("Session control secret is required.");
    }
    headers[SESSION_CONTROL_TOKEN_HEADER] = input.controlSecret;
  }

  return headers;
}

export function createSessionControlClient(config: SessionControlClientConfig): SessionControlClient {
  const fetchImpl = config.fetch ?? globalThis.fetch;
  if (typeof fetchImpl !== "function") {
    throw new TypeError("Session control client requires a fetch implementation.");
  }
  const baseUrl = trimTrailingSlashes(config.baseUrl);

  async function execute<TResponse>(command: SessionControlCommand): Promise<TResponse> {
    const path = command.path;
    const authHeaders = await config.authorize({ method: command.method, path, body: command.body });
    const headers: Record<string, string> = {
      ...authHeaders,
      ...buildSessionControlSecretHeaders({
        clientInstanceId: config.clientInstanceId,
        generation: command.generation,
        controlSecret: command.controlSecret,
      }),
    };

    let serializedBody: string | undefined;
    if (command.body !== undefined) {
      if (command.idempotencyKey === undefined) {
        throw new TypeError("Session control mutation requires an idempotency key.");
      }
      serializedBody = JSON.stringify(command.body);
      headers["Content-Type"] = "application/json";
      // The Gateway idempotency plugin requires an Idempotency-Key header on every
      // mutation; the control idempotency key doubles as it so exact retries
      // converge at the HTTP layer too.
      headers["Idempotency-Key"] = command.idempotencyKey;
    }

    const url = `${baseUrl}${path}${command.query ? `?${command.query}` : ""}`;
    const init: RequestInit = {
      method: command.method,
      headers,
      cache: "no-store",
    };
    if (serializedBody !== undefined) init.body = serializedBody;
    if (command.signal) init.signal = command.signal;

    let response: Response;
    try {
      response = await fetchImpl(url, init);
    } catch (error) {
      throw new ApiRequestError(`Network error ${command.method} ${path}: ${(error as Error).message}`, {
        kind: "network",
        method: command.method,
        path,
        cause: error,
      });
    }

    if (command.returnRawResponse) {
      if (!response.ok) throw await toHttpError(response, command.method, path);
      return response as unknown as TResponse;
    }

    if (!response.ok) {
      throw await toHttpError(response, command.method, path);
    }

    if (response.status === 204 || response.status === 205) {
      return undefined as TResponse;
    }
    const text = await response.text();
    if (!text) return undefined as TResponse;
    let payload: unknown;
    try {
      payload = JSON.parse(text);
    } catch (error) {
      throw new ApiRequestError(`Protocol error ${command.method} ${path}: malformed JSON response`, {
        kind: "protocol",
        method: command.method,
        path,
        bodyText: text,
        cause: error,
      });
    }
    return unwrapApiResponse<TResponse>(payload);
  }

  function controlPath(sessionId: string, suffix: string): string {
    return `/api/v1/chat/sessions/${encodeURIComponent(sessionId)}/control${suffix}`;
  }

  return {
    createExternalRequest(sessionId, input) {
      return execute<SessionControlRequestResponse>({
        method: "POST",
        path: controlPath(sessionId, "/requests"),
        body: input,
        idempotencyKey: input.idempotencyKey,
      });
    },
    getControl(sessionId) {
      return execute<SessionControlDetailResponse>({
        method: "GET",
        path: controlPath(sessionId, ""),
        body: undefined,
      });
    },
    heartbeat(sessionId, input, controlSecret) {
      return execute<SessionControlHeartbeatResponse>({
        method: "POST",
        path: controlPath(sessionId, "/heartbeat"),
        body: input,
        idempotencyKey: input.idempotencyKey,
        controlSecret,
        generation: input.expectedGeneration,
      });
    },
    reconnect(sessionId, input, oldControlSecret) {
      return execute<SessionControlReconnectResponse>({
        method: "POST",
        path: controlPath(sessionId, "/reconnect"),
        body: input,
        idempotencyKey: input.idempotencyKey,
        controlSecret: oldControlSecret,
        generation: input.expectedGeneration,
      });
    },
    release(sessionId, input, controlSecret) {
      return execute<SessionControlReleaseResponse>({
        method: "POST",
        path: controlPath(sessionId, "/release"),
        body: input,
        idempotencyKey: input.idempotencyKey,
        controlSecret,
        generation: input.expectedGeneration,
      });
    },
    openEventStream(sessionId, options) {
      const query = new URLSearchParams();
      if (options?.afterCursor !== undefined) query.set("afterCursor", String(options.afterCursor));
      if (options?.clientId) query.set("clientId", options.clientId);
      return execute<Response>({
        method: "GET",
        path: controlPath(sessionId, "/events/stream"),
        body: undefined,
        query: query.toString() || undefined,
        signal: options?.signal,
        returnRawResponse: true,
      });
    },
  };
}

interface SessionControlCommand {
  readonly method: string;
  readonly path: string;
  readonly body: unknown;
  readonly query?: string;
  readonly idempotencyKey?: string;
  readonly controlSecret?: string;
  readonly generation?: number;
  readonly signal?: AbortSignal;
  readonly returnRawResponse?: boolean;
}

async function toHttpError(response: Response, method: string, path: string): Promise<ApiRequestError> {
  const bodyText = await safeReadText(response);
  const parsed = parseApiError(bodyText);
  return new ApiRequestError(`API error ${response.status}: ${bodyText}`, {
    kind: "http",
    method: normalizeHttpMethod(method),
    path,
    status: response.status,
    body: parsed.body,
    bodyText,
    authMode: parsed.authMode,
  });
}

async function safeReadText(response: Response): Promise<string> {
  try {
    return await response.text();
  } catch {
    return "";
  }
}

function trimTrailingSlashes(baseUrl: string): string {
  let end = baseUrl.length;
  while (end > 0 && baseUrl.charCodeAt(end - 1) === 47) end -= 1;
  return baseUrl.slice(0, end);
}
