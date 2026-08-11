import { describe, expect, it, vi } from "vitest";
import type { MobilePushApprovalRefreshPayload } from "@goatcitadel/contracts";
import {
  buildExpoDataOnlyPushMessage,
  createConfiguredMobilePushProvider,
  createExpoMobilePushProvider,
  EXPO_PUSH_SEND_URL,
  MOBILE_PUSH_EXPO_ACCESS_TOKEN_ENV,
  MOBILE_PUSH_EXPO_SECRET_PROVIDER_ID,
  resolveMobilePushProviderCredential,
} from "./mobile-push-provider.js";

const PAYLOAD: MobilePushApprovalRefreshPayload = {
  schemaVersion: 1,
  type: "approval_refresh",
  realtimeEventId: "event-1",
  approvalId: "approval-1",
  deepLink: { kind: "approval", approvalId: "approval-1" },
};

function jsonResponse(status: number, body: unknown, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), { status, headers });
}

describe("mobile push provider credential resolution", () => {
  it("is absent by default so the shipped posture stays unavailable", () => {
    expect(resolveMobilePushProviderCredential({ env: {} })).toBeUndefined();
    const provider = createConfiguredMobilePushProvider({ env: {} });
    expect(provider.isAvailable()).toBe(false);
  });

  it("prefers the environment credential and falls back to the OS-keychain provider secret", () => {
    expect(
      resolveMobilePushProviderCredential({
        env: { [MOBILE_PUSH_EXPO_ACCESS_TOKEN_ENV]: "  env-token  " },
      }),
    ).toEqual({ kind: "expo_access_token", accessToken: "env-token", source: "env" });

    const getProviderApiKey = vi.fn((providerId: string) =>
      providerId === MOBILE_PUSH_EXPO_SECRET_PROVIDER_ID ? "keychain-token" : undefined,
    );
    expect(
      resolveMobilePushProviderCredential({
        env: {},
        secretStore: { isAvailable: () => true, getProviderApiKey },
      }),
    ).toEqual({ kind: "expo_access_token", accessToken: "keychain-token", source: "secret_store" });
    expect(getProviderApiKey).toHaveBeenCalledWith(MOBILE_PUSH_EXPO_SECRET_PROVIDER_ID);
  });

  it("fails closed to no credential when custody is unavailable or throws", () => {
    expect(
      resolveMobilePushProviderCredential({
        env: {},
        secretStore: { isAvailable: () => false, getProviderApiKey: () => "never-read" },
      }),
    ).toBeUndefined();
    expect(
      resolveMobilePushProviderCredential({
        env: {},
        secretStore: {
          isAvailable: () => true,
          getProviderApiKey: () => {
            throw new Error("keychain locked");
          },
        },
      }),
    ).toBeUndefined();
  });
});

describe("credentialed Expo provider", () => {
  const credential = { kind: "expo_access_token" as const, accessToken: "expo-access-token", source: "env" as const };

  it("sends a data-only silent payload: no title, body, sound, or subtitle the OS could display", async () => {
    const fetchFn = vi.fn(async () => jsonResponse(200, { data: [{ status: "ok", id: "ticket-1" }] }));
    const provider = createExpoMobilePushProvider({ credential, fetchFn: fetchFn as never });

    const result = await provider.send({
      deliveryId: "mpd_1",
      provider: "expo",
      token: "ExpoPushToken[raw]",
      payload: PAYLOAD,
    });

    expect(result).toEqual({ classification: "delivered", receiptId: "ticket-1" });
    expect(fetchFn).toHaveBeenCalledTimes(1);
    const [url, init] = fetchFn.mock.calls[0]! as unknown as [string, RequestInit];
    expect(url).toBe(EXPO_PUSH_SEND_URL);
    expect(init.method).toBe("POST");
    expect((init.headers as Record<string, string>).authorization).toBe("Bearer expo-access-token");
    // Program-pinned silent shape: the OS must have nothing to display before
    // the companion app's JavaScript validates the hint.
    expect(JSON.parse(init.body as string)).toEqual({
      to: "ExpoPushToken[raw]",
      data: PAYLOAD,
      priority: "high",
      _contentAvailable: true,
    });
    const bodyKeys = Object.keys(JSON.parse(init.body as string));
    expect(bodyKeys).not.toContain("title");
    expect(bodyKeys).not.toContain("body");
    expect(bodyKeys).not.toContain("sound");
    expect(bodyKeys).not.toContain("subtitle");
    expect(buildExpoDataOnlyPushMessage("t", PAYLOAD)).toEqual({
      to: "t",
      data: PAYLOAD,
      priority: "high",
      _contentAvailable: true,
    });
  });

  it("classifies provider outcomes honestly", async () => {
    const cases: Array<{ response: () => Promise<Response>; expected: Record<string, unknown> }> = [
      {
        response: async () =>
          jsonResponse(200, { data: [{ status: "error", details: { error: "DeviceNotRegistered" } }] }),
        expected: { classification: "invalid_token" },
      },
      {
        response: async () =>
          jsonResponse(200, { data: [{ status: "error", details: { error: "MessageRateExceeded" } }] }),
        expected: { classification: "retryable" },
      },
      {
        response: async () =>
          jsonResponse(200, { data: [{ status: "error", details: { error: "InvalidCredentials" } }] }),
        expected: { classification: "provider_unavailable" },
      },
      {
        response: async () => jsonResponse(401, { errors: [{ code: "UNAUTHORIZED" }] }),
        expected: { classification: "provider_unavailable" },
      },
      {
        response: async () => jsonResponse(429, {}, { "retry-after": "7" }),
        expected: { classification: "retryable", retryAfterMs: 7_000 },
      },
      {
        response: async () => jsonResponse(500, {}),
        expected: { classification: "retryable" },
      },
      {
        response: async () => new Response("not json", { status: 200 }),
        expected: { classification: "unknown_after_send" },
      },
      {
        response: async () => {
          throw new Error("socket hang up");
        },
        expected: { classification: "unknown_after_send" },
      },
    ];
    for (const testCase of cases) {
      const provider = createExpoMobilePushProvider({ credential, fetchFn: vi.fn(testCase.response) as never });
      await expect(
        provider.send({ deliveryId: "mpd_1", provider: "expo", token: "ExpoPushToken[raw]", payload: PAYLOAD }),
      ).resolves.toEqual(testCase.expected);
    }
  });

  it("keeps raw FCM delivery unavailable: only the Expo credential exists", async () => {
    const fetchFn = vi.fn();
    const provider = createExpoMobilePushProvider({ credential, fetchFn: fetchFn as never });
    await expect(
      provider.send({ deliveryId: "mpd_1", provider: "fcm", token: "fcm-token", payload: PAYLOAD }),
    ).resolves.toEqual({ classification: "provider_unavailable" });
    expect(fetchFn).not.toHaveBeenCalled();
  });

  it("never leaks the raw device token or access token through classification results", async () => {
    const provider = createExpoMobilePushProvider({
      credential,
      fetchFn: vi.fn(async () => jsonResponse(200, { data: [{ status: "ok", id: "ticket-2" }] })) as never,
    });
    const result = await provider.send({
      deliveryId: "mpd_1",
      provider: "expo",
      token: "ExpoPushToken[super-secret]",
      payload: PAYLOAD,
    });
    expect(JSON.stringify(result)).not.toContain("super-secret");
    expect(JSON.stringify(result)).not.toContain("expo-access-token");
  });
});
