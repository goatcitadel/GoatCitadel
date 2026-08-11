import type { MobilePushApprovalRefreshPayload } from "@goatcitadel/contracts";
import { readBoundedResponseJson } from "./bounded-response-reader.js";
import {
  createUnavailableMobilePushProvider,
  type MobilePushProviderPort,
  type MobilePushProviderResult,
} from "./mobile-push-service.js";

/**
 * Credentialed Expo push adapter for the M8 mobile delivery owner.
 *
 * The credential is ABSENT by default: without an operator-provisioned Expo
 * access token (environment variable first, OS-keychain provider secret
 * second) the factory returns the explicit unavailable provider, the delivery
 * scheduler refuses to start, and the API keeps reporting
 * `deliveryAvailability: "unavailable"`. Provisioning the credential is the
 * only switch that turns delivery on.
 *
 * Program requirement (data-only/silent payload): every request body carries
 * ONLY the typed refresh payload under `data` with no `title`/`body`/`sound`,
 * so the OS can never display untrusted push content before the companion
 * app's JavaScript validates the hint against the signed Gateway APIs.
 */
export const MOBILE_PUSH_EXPO_ACCESS_TOKEN_ENV = "GOATCITADEL_MOBILE_PUSH_EXPO_ACCESS_TOKEN";
export const MOBILE_PUSH_EXPO_SECRET_PROVIDER_ID = "mobile-push-expo";
export const EXPO_PUSH_SEND_URL = "https://exp.host/--/api/v2/push/send";

const DEFAULT_SEND_TIMEOUT_MS = 15_000;
const MAX_ACCESS_TOKEN_LENGTH = 4096;

export interface MobilePushProviderCredential {
  kind: "expo_access_token";
  accessToken: string;
  source: "env" | "secret_store";
}

export interface MobilePushCredentialSecretStore {
  isAvailable(): boolean;
  getProviderApiKey(providerId: string): string | undefined;
}

/**
 * Resolves the Expo push credential. Absent-by-default and fail-closed: a
 * missing/blank value anywhere (including an unavailable OS keychain) resolves
 * to `undefined`, which keeps the provider unavailable and the scheduler dark.
 */
export function resolveMobilePushProviderCredential(input: {
  env?: Record<string, string | undefined>;
  secretStore?: MobilePushCredentialSecretStore;
}): MobilePushProviderCredential | undefined {
  const fromEnv = input.env?.[MOBILE_PUSH_EXPO_ACCESS_TOKEN_ENV]?.trim();
  if (fromEnv && fromEnv.length <= MAX_ACCESS_TOKEN_LENGTH) {
    return { kind: "expo_access_token", accessToken: fromEnv, source: "env" };
  }
  try {
    if (!input.secretStore?.isAvailable()) {
      return undefined;
    }
    const fromSecretStore = input.secretStore.getProviderApiKey(MOBILE_PUSH_EXPO_SECRET_PROVIDER_ID)?.trim();
    if (fromSecretStore && fromSecretStore.length <= MAX_ACCESS_TOKEN_LENGTH) {
      return { kind: "expo_access_token", accessToken: fromSecretStore, source: "secret_store" };
    }
  } catch (custodyError) {
    void custodyError;
    // Custody unavailability must degrade to "no credential", never to a crash
    // or an implicit unauthenticated live send.
  }
  return undefined;
}

export interface ExpoMobilePushProviderOptions {
  credential: MobilePushProviderCredential;
  fetchFn?: typeof fetch;
  timeoutMs?: number;
}

/**
 * Builds the exact provider request body. Exported so tests can pin the
 * data-only/silent contract: no `title`, no `body`, no `sound`, no `subtitle`.
 */
export function buildExpoDataOnlyPushMessage(
  token: string,
  payload: MobilePushApprovalRefreshPayload,
): Record<string, unknown> {
  return {
    to: token,
    data: payload,
    priority: "high",
    _contentAvailable: true,
  };
}

export function createExpoMobilePushProvider(options: ExpoMobilePushProviderOptions): MobilePushProviderPort {
  const timeoutMs = Math.max(1_000, Math.floor(options.timeoutMs ?? DEFAULT_SEND_TIMEOUT_MS));
  const fetchFn = options.fetchFn ?? globalThis.fetch;
  return {
    isAvailable: () => true,
    send: async (input): Promise<MobilePushProviderResult> => {
      if (input.provider !== "expo") {
        // Only the Expo credential exists. Raw FCM delivery needs its own
        // credentialed adapter and stays honestly unavailable until then.
        return { classification: "provider_unavailable" };
      }
      const body = JSON.stringify(buildExpoDataOnlyPushMessage(input.token, input.payload));
      const abort = new AbortController();
      const timeout = setTimeout(() => abort.abort(), timeoutMs);
      timeout.unref?.();
      let response: Response;
      try {
        response = await fetchFn(EXPO_PUSH_SEND_URL, {
          method: "POST",
          headers: {
            accept: "application/json",
            "content-type": "application/json",
            authorization: `Bearer ${options.credential.accessToken}`,
          },
          body,
          signal: abort.signal,
        });
      } catch {
        // The request may or may not have crossed the provider boundary.
        // Never guess "failed cleanly": the outbox quarantines ambiguity.
        return { classification: "unknown_after_send" };
      } finally {
        clearTimeout(timeout);
      }
      return await classifyExpoResponse(response);
    },
  };
}

/**
 * Composition-root factory: resolve the credential once and return either the
 * credentialed Expo adapter or the explicit production-dark unavailable
 * provider. Never throws.
 */
export function createConfiguredMobilePushProvider(input: {
  env?: Record<string, string | undefined>;
  secretStore?: MobilePushCredentialSecretStore;
  fetchFn?: typeof fetch;
  timeoutMs?: number;
}): MobilePushProviderPort {
  const credential = resolveMobilePushProviderCredential(input);
  if (!credential) {
    return createUnavailableMobilePushProvider();
  }
  return createExpoMobilePushProvider({ credential, fetchFn: input.fetchFn, timeoutMs: input.timeoutMs });
}

async function classifyExpoResponse(response: Response): Promise<MobilePushProviderResult> {
  if (response.status === 401 || response.status === 403) {
    return { classification: "provider_unavailable" };
  }
  if (response.status === 429) {
    return { classification: "retryable", retryAfterMs: parseRetryAfterMs(response.headers.get("retry-after")) };
  }
  if (!response.ok) {
    // 4xx/5xx envelope rejections did not enqueue the message; bounded retry
    // (then dead-letter) keeps the outbox honest without duplicate risk.
    return { classification: "retryable" };
  }
  let parsed: unknown;
  try {
    parsed = await readBoundedResponseJson(response, {
      maxBytes: 64 * 1024,
      timeoutMs: 10_000,
      label: "expo push ticket",
    });
  } catch {
    // A 2xx we cannot interpret may still have enqueued the message.
    return { classification: "unknown_after_send" };
  }
  const ticket = readFirstExpoTicket(parsed);
  if (!ticket) {
    return { classification: "unknown_after_send" };
  }
  if (ticket.status === "ok") {
    return typeof ticket.id === "string" && ticket.id.trim()
      ? { classification: "delivered", receiptId: ticket.id }
      : { classification: "delivered" };
  }
  switch (ticket.errorCode) {
    case "DeviceNotRegistered":
      return { classification: "invalid_token" };
    case "InvalidCredentials":
      return { classification: "provider_unavailable" };
    case "MessageRateExceeded":
      return { classification: "retryable" };
    default:
      return { classification: "retryable" };
  }
}

interface ExpoTicketView {
  status: "ok" | "error";
  id?: string;
  errorCode?: string;
}

function readFirstExpoTicket(parsed: unknown): ExpoTicketView | undefined {
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    return undefined;
  }
  const data = (parsed as Record<string, unknown>).data;
  if (!Array.isArray(data) || data.length < 1) {
    return undefined;
  }
  const first = data[0];
  if (!first || typeof first !== "object" || Array.isArray(first)) {
    return undefined;
  }
  const record = first as Record<string, unknown>;
  if (record.status === "ok") {
    return { status: "ok", id: typeof record.id === "string" ? record.id : undefined };
  }
  if (record.status === "error") {
    const details = record.details;
    const errorCode =
      details && typeof details === "object" && !Array.isArray(details)
        ? (details as Record<string, unknown>).error
        : undefined;
    return { status: "error", errorCode: typeof errorCode === "string" ? errorCode : undefined };
  }
  return undefined;
}

function parseRetryAfterMs(headerValue: string | null): number | undefined {
  if (!headerValue) {
    return undefined;
  }
  const seconds = Number.parseInt(headerValue, 10);
  if (Number.isFinite(seconds) && seconds >= 0) {
    return Math.min(15 * 60_000, seconds * 1_000);
  }
  return undefined;
}
