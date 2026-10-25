import { randomUUID } from "node:crypto";
import { GOOGLE_WORKSPACE_CATALOG_ID, redactSecretText } from "@goatcitadel/contracts";
import type { AsyncStorage } from "@goatcitadel/storage";
import { readBoundedResponseText } from "./bounded-response-reader.js";
import { runIdempotentExternalSideEffect } from "./external-side-effect-runner-service.js";

export const GOOGLE_AUTHORIZE_URL = "https://accounts.google.com/o/oauth2/v2/auth";
const GOOGLE_TOKEN_URL = "https://oauth2.googleapis.com/token";
const GOOGLE_REVOKE_URL = "https://oauth2.googleapis.com/revoke";
const GMAIL_PROFILE_URL = "https://gmail.googleapis.com/gmail/v1/users/me/profile";
const REQUEST_TIMEOUT_MS = 15_000;
const MAX_RESPONSE_BYTES = 64 * 1024;

export type GoogleTokenRequestKind = "authorization_code" | "refresh_token" | "revoke";

/** A definite answer from Google. Transport failures throw instead, so the ledger records them as unknown. */
export interface GoogleOAuthResponse {
  ok: boolean;
  status: number;
  body: Record<string, unknown>;
}

/** The request reached Google but its outcome is unknown; Google may hold a grant GoatCitadel never received. */
export class GoogleOAuthOutcomeUnknownError extends Error {
  public constructor(message: string) {
    super(message);
    this.name = "GoogleOAuthOutcomeUnknownError";
  }
}

export type GoogleOAuthLedgerStorage = Pick<
  AsyncStorage,
  "runImmediateTransaction" | "mutationIdempotency" | "externalSideEffectRuns"
>;

/**
 * Sends one form-encoded request to Google's OAuth endpoints inside the shared external side-effect
 * ledger (boundary `google_oauth_token`), like MCP client registration and MCP token requests. The
 * ledger records the request kind only; codes, tokens and client secrets never reach it.
 */
export class GoogleOAuthClient {
  private readonly fetchFn: typeof fetch;

  public constructor(
    private readonly storage: GoogleOAuthLedgerStorage,
    fetchFn?: typeof fetch,
  ) {
    this.fetchFn = fetchFn ?? fetch;
  }

  public exchange(connectionId: string, params: Record<string, string>): Promise<GoogleOAuthResponse> {
    return this.ledgered(connectionId, "authorization_code", GOOGLE_TOKEN_URL, {
      grant_type: "authorization_code",
      ...params,
    });
  }

  public refresh(connectionId: string, params: Record<string, string>): Promise<GoogleOAuthResponse> {
    return this.ledgered(connectionId, "refresh_token", GOOGLE_TOKEN_URL, { grant_type: "refresh_token", ...params });
  }

  /** RFC 7009 revocation. Revoking the refresh token also ends every access token issued from it. */
  public revoke(connectionId: string, token: string): Promise<GoogleOAuthResponse> {
    return this.ledgered(connectionId, "revoke", GOOGLE_REVOKE_URL, { token });
  }

  /** Best-effort account label for readiness; needs a Gmail read grant and never throws. */
  public async readGmailAddress(accessToken: string): Promise<string | undefined> {
    try {
      const response = await this.fetchFn(GMAIL_PROFILE_URL, {
        method: "GET",
        headers: { Authorization: `Bearer ${accessToken}` },
        redirect: "manual",
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });
      const body = parseJsonObject(await this.readBody(response, "Gmail profile"));
      const email = typeof body.emailAddress === "string" ? body.emailAddress.trim() : "";
      return response.ok && /^[^\s@]{1,128}@[^\s@]{1,253}$/u.test(email) ? email : undefined;
    } catch {
      // The label is cosmetic: a failed profile read leaves the sign-in connected without one.
      return undefined;
    }
  }

  private async ledgered(
    connectionId: string,
    kind: GoogleTokenRequestKind,
    url: string,
    params: Record<string, string>,
  ): Promise<GoogleOAuthResponse> {
    let answer: GoogleOAuthResponse | undefined;
    const run = await runIdempotentExternalSideEffect({
      mutationStore: this.storage.mutationIdempotency,
      sideEffectRunStore: this.storage.externalSideEffectRuns,
      runClaimTransaction: (work) => this.storage.runImmediateTransaction(work),
      requireDurableBoundaryRecord: true,
      boundary: "google_oauth_token",
      catalogId: GOOGLE_WORKSPACE_CATALOG_ID,
      connectionId,
      actionId: kind,
      actorScope: connectionId,
      idempotencyKey: `google-oauth:${kind}:${randomUUID()}`,
      checkedAt: new Date().toISOString(),
      payload: { kind },
      label: kind === "revoke" ? "Google sign-in revocation" : "Google sign-in token request",
      execute: async (claim) => {
        await claim.markExternalCallStarted();
        answer = await this.post(url, params);
        return { kind, status: answer.status, ok: answer.ok };
      },
    });
    if (run.status === "executed") {
      if (answer) return answer;
      throw new GoogleOAuthOutcomeUnknownError("The Google request finished without a response.");
    }
    const reason = redactSecretText(run.status === "failed" ? run.error.message : run.message).value.slice(0, 512);
    if (run.status === "failed" && run.claim.resumeState === "manual_review_unknown_external_outcome") {
      throw new GoogleOAuthOutcomeUnknownError(
        `The Google ${kind === "revoke" ? "revocation" : "token request"} was sent but its outcome is unknown (${reason}).`,
      );
    }
    throw new Error(`The Google ${kind === "revoke" ? "revocation" : "token request"} did not run: ${reason}`);
  }

  private async post(url: string, params: Record<string, string>): Promise<GoogleOAuthResponse> {
    const response = await this.fetchFn(url, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded", Accept: "application/json" },
      body: new URLSearchParams(params),
      redirect: "manual",
      // Bounds the whole exchange, including a stall before response headers.
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
    const text = await this.readBody(response, "Google OAuth");
    return { ok: response.ok, status: response.status, body: parseJsonObject(text) };
  }

  private readBody(response: Response, label: string): Promise<string> {
    return readBoundedResponseText(response, { maxBytes: MAX_RESPONSE_BYTES, timeoutMs: 5_000, label });
  }
}

/** Google's `error` and `error_description`, single-line and bounded; never echoes a token. */
export function describeGoogleOAuthError(response: GoogleOAuthResponse): string {
  const clean = (value: unknown) =>
    typeof value === "string" ? redactSecretText(value.replace(/\s+/gu, " ").trim()).value.slice(0, 200) : undefined;
  const error = clean(response.body.error);
  const description = clean(response.body.error_description);
  if (error && description) return `${error}: ${description}`;
  return error ?? `HTTP ${response.status}`;
}

function parseJsonObject(text: string): Record<string, unknown> {
  try {
    const parsed: unknown = JSON.parse(text);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}
