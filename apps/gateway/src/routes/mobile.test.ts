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

async function buildApp(registerMobilePush: ReturnType<typeof vi.fn>): Promise<FastifyInstance> {
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
  app.decorate("services", { mobile: { registerMobilePush } } as never);
  await app.register(mobileRoutes);
  return app;
}
