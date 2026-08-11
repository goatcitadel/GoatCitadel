import Fastify, { type FastifyInstance } from "fastify";
import { afterEach, describe, expect, it, vi } from "vitest";
import { mobileRoutes } from "./mobile.js";

describe("mobile push registration route", () => {
  let app: FastifyInstance | undefined;

  afterEach(async () => {
    await app?.close();
    app = undefined;
  });

  it("rejects unknown secret fields before delegation and keeps the response no-store", async () => {
    const registerMobilePush = vi.fn();
    app = await buildApp(registerMobilePush);
    const rawToken = "ExpoPushToken[route-secret-token]";
    const extraSecret = "route-malicious-extra-secret";

    const response = await app.inject({
      method: "PUT",
      url: "/api/v1/mobile/current-device/push",
      payload: {
        provider: "expo",
        enabled: true,
        token: rawToken,
        maliciousExtraSecret: extraSecret,
      },
    });

    expect(response.statusCode).toBe(400);
    expect(response.headers["cache-control"]).toBe("no-store");
    expect(response.headers.pragma).toBe("no-cache");
    expect(response.body).not.toContain(rawToken);
    expect(response.body).not.toContain(extraSecret);
    expect(registerMobilePush).not.toHaveBeenCalled();
  });

  it("keeps success, parser, auth, and handler-error responses no-store", async () => {
    const registerMobilePush = vi.fn(async (input: { provider: "expo" | "fcm"; enabled: boolean; token?: string }) => {
      if (input.token === "ExpoPushToken[route-handler-error]") {
        throw new Error("Mobile push token custody is unavailable.");
      }
      return {
        registrationId: "mpr_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
        provider: input.provider,
        registeredAt: "2026-08-09T00:00:00.000Z",
        updatedAt: "2026-08-09T00:00:00.000Z",
        enabled: input.enabled,
        deliveryAvailability: "unavailable" as const,
        revision: 1,
      };
    });
    app = await buildApp(registerMobilePush);

    const successToken = "ExpoPushToken[route-success-secret]";
    const success = await app.inject({
      method: "PUT",
      url: "/api/v1/mobile/current-device/push",
      payload: { provider: "expo", enabled: true, token: successToken },
    });
    const malformed = await app.inject({
      method: "PUT",
      url: "/api/v1/mobile/current-device/push",
      headers: { "content-type": "application/json" },
      payload: "{definitely-not-json",
    });
    const authRejected = await app.inject({
      method: "PUT",
      url: "/api/v1/mobile/current-device/push",
      headers: { "x-test-auth-reject": "true" },
      payload: { provider: "expo", enabled: true, token: "ExpoPushToken[auth-rejected]" },
    });
    const handlerError = await app.inject({
      method: "PUT",
      url: "/api/v1/mobile/current-device/push",
      payload: { provider: "expo", enabled: true, token: "ExpoPushToken[route-handler-error]" },
    });

    expect([success.statusCode, malformed.statusCode, authRejected.statusCode, handlerError.statusCode]).toEqual([
      200, 400, 401, 500,
    ]);
    for (const response of [success, malformed, authRejected, handlerError]) {
      expect(response.headers["cache-control"]).toBe("no-store");
      expect(response.headers.pragma).toBe("no-cache");
    }
    expect(success.body).not.toContain(successToken);
    expect(registerMobilePush).toHaveBeenCalledTimes(2);
  });
});

describe("mobile approval key routes", () => {
  let app: FastifyInstance | undefined;

  afterEach(async () => {
    await app?.close();
    app = undefined;
  });

  it("rejects unknown/secret-shaped fields before delegation and stays no-store", async () => {
    const registerMobileApprovalKey = vi.fn();
    app = await buildApp(vi.fn(), { registerMobileApprovalKey });

    const response = await app.inject({
      method: "PUT",
      url: "/api/v1/mobile/current-device/approval-key",
      payload: {
        enabled: true,
        algorithm: "ed25519",
        publicKeyPem: "-----BEGIN PUBLIC KEY-----\nstub\n-----END PUBLIC KEY-----",
        keyProvenance: "secure_hardware",
        privateKeyPem: "route-must-never-accept-this",
      },
    });

    expect(response.statusCode).toBe(400);
    expect(response.headers["cache-control"]).toBe("no-store");
    expect(response.body).not.toContain("route-must-never-accept-this");
    expect(registerMobileApprovalKey).not.toHaveBeenCalled();
  });

  it("registers, disables, lists, and operator-revokes through the typed service boundary", async () => {
    const registration = {
      keyId: "mak_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
      algorithm: "ed25519",
      enabled: true,
      keyProvenance: "secure_hardware",
      publicKeySha256: "a".repeat(64),
      registeredAt: "2026-08-11T00:00:00.000Z",
      updatedAt: "2026-08-11T00:00:00.000Z",
      revision: 1,
      verificationAvailability: "unavailable" as const,
    };
    const registerMobileApprovalKey = vi.fn(async (input: { enabled: boolean }) => ({
      ...registration,
      enabled: input.enabled,
    }));
    const listMobileApprovalKeys = vi.fn(async () => ({ items: [] }));
    const revokeMobileApprovalKeys = vi.fn(async () => ({ revoked: 1, keyIds: [registration.keyId] }));
    app = await buildApp(vi.fn(), {
      registerMobileApprovalKey,
      listMobileApprovalKeys,
      revokeMobileApprovalKeys,
    });

    const registered = await app.inject({
      method: "PUT",
      url: "/api/v1/mobile/current-device/approval-key",
      payload: {
        enabled: true,
        algorithm: "ed25519",
        publicKeyPem: "-----BEGIN PUBLIC KEY-----\nstub\n-----END PUBLIC KEY-----",
        keyProvenance: "secure_hardware",
      },
    });
    const disabled = await app.inject({
      method: "PUT",
      url: "/api/v1/mobile/current-device/approval-key",
      payload: { enabled: false },
    });
    const listed = await app.inject({ method: "GET", url: "/api/v1/mobile/approval-keys?limit=5" });
    const revoked = await app.inject({
      method: "POST",
      url: "/api/v1/mobile/approval-keys/revoke",
      payload: { grantId: "grant-1" },
    });
    const revokeRejected = await app.inject({
      method: "POST",
      url: "/api/v1/mobile/approval-keys/revoke",
      payload: { grantId: "grant-1", extra: "field" },
    });

    expect(registered.statusCode).toBe(200);
    expect(registered.headers["cache-control"]).toBe("no-store");
    expect(registered.json()).toMatchObject({ enabled: true, verificationAvailability: "unavailable" });
    expect(disabled.statusCode).toBe(200);
    expect(registerMobileApprovalKey).toHaveBeenCalledTimes(2);
    expect(registerMobileApprovalKey).toHaveBeenLastCalledWith(
      { enabled: false },
      expect.objectContaining({ grantId: "grant-1", companionSessionId: "companion-session-1" }),
    );
    expect(listed.statusCode).toBe(200);
    expect(listMobileApprovalKeys).toHaveBeenCalledWith({ limit: 5 });
    expect(revoked.statusCode).toBe(200);
    expect(revoked.json()).toEqual({ revoked: 1, keyIds: [registration.keyId] });
    expect(revokeMobileApprovalKeys).toHaveBeenCalledWith({ grantId: "grant-1" }, expect.any(Object));
    expect(revokeRejected.statusCode).toBe(400);
  });
});

async function buildApp(
  registerMobilePush: ReturnType<typeof vi.fn>,
  extraMobileMethods: Record<string, ReturnType<typeof vi.fn>> = {},
): Promise<FastifyInstance> {
  const app = Fastify();
  app.addHook("onRequest", async (request, reply) => {
    if (request.headers["x-test-auth-reject"] === "true") {
      return reply.code(401).send({ error: "Unauthorized" });
    }
    request.authActorId = "companion:test";
    request.authActorSource = "companion";
    request.authDeviceId = "device-1";
    request.authGrantId = "grant-1";
    request.authCompanionSessionId = "companion-session-1";
    request.authPrincipalPurpose = "general_companion";
  });
  app.decorate("services", { mobile: { registerMobilePush, ...extraMobileMethods } } as never);
  app.decorate("requireOperatorAuth", (async () => undefined) as never);
  await app.register(mobileRoutes);
  return app;
}
