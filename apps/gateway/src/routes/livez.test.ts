import Fastify from "fastify";
import { describe, expect, it } from "vitest";
import { livezRoute } from "./livez.js";

describe("livezRoute", () => {
  it("returns a 200 with a minimal status body and no service dependencies", async () => {
    const app = Fastify();
    await app.register(livezRoute);

    const response = await app.inject({ method: "GET", url: "/livez" });

    expect(response.statusCode).toBe(200);
    const body = response.json() as { status: string; service: string; uptimeSeconds: number };
    expect(body.status).toBe("ok");
    expect(body.service).toBe("gateway");
    expect(Number.isInteger(body.uptimeSeconds)).toBe(true);
    expect(body.uptimeSeconds).toBeGreaterThanOrEqual(0);

    await app.close();
  });

  it("does not need the gateway storage runtime to respond", async () => {
    // /livez is intentionally service-free. Registering it on a bare Fastify
    // instance (no @goatcitadel/storage plugin, no decorators) must work.
    const app = Fastify();
    await app.register(livezRoute);

    const response = await app.inject({ method: "GET", url: "/livez" });
    expect(response.statusCode).toBe(200);

    await app.close();
  });
});
