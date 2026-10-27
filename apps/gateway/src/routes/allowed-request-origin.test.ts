import type { FastifyReply, FastifyRequest } from "fastify";
import { afterEach, describe, expect, it, vi } from "vitest";
import { allowedRequestOrigin, rejectDisallowedRequestOrigin } from "./allowed-request-origin.js";

const request = (headers: Record<string, string>, authMode: string = "token") =>
  ({ headers, server: { gatewayConfig: { assistant: { auth: { mode: authMode } } } } }) as unknown as FastifyRequest;
function reply() {
  const send = vi.fn();
  const code = vi.fn(() => ({ send }));
  return { reply: { code } as unknown as FastifyReply, code, send };
}

describe("allowed request origin", () => {
  const original = { ...process.env };
  afterEach(() => {
    process.env = { ...original };
  });

  it("uses the shared policy, including loopback dev ports and blank-env defaults", () => {
    process.env.GOATCITADEL_ALLOWED_ORIGINS = "";
    process.env.NODE_ENV = "development";
    expect(allowedRequestOrigin(request({ origin: "http://localhost:5173" }))).toBe("http://localhost:5173");
    expect(allowedRequestOrigin(request({ origin: "http://127.0.0.1:62949" }))).toBe("http://127.0.0.1:62949");
    expect(allowedRequestOrigin(request({ origin: "https://evil.example.com" }))).toBeUndefined();
  });

  it("does not hand sign-in back to an arbitrary loopback port when auth is off or config is missing", () => {
    process.env.GOATCITADEL_ALLOWED_ORIGINS = "";
    process.env.NODE_ENV = "development";
    expect(allowedRequestOrigin(request({ origin: "http://127.0.0.1:62949" }, "none"))).toBeUndefined();
    expect(allowedRequestOrigin(request({ origin: "http://localhost:5173" }, "none"))).toBe("http://localhost:5173");
    const bare = { headers: { origin: "http://127.0.0.1:62949" } } as unknown as FastifyRequest;
    expect(allowedRequestOrigin(bare)).toBeUndefined();
    const bareDefault = { headers: { origin: "http://localhost:5173" } } as unknown as FastifyRequest;
    expect(allowedRequestOrigin(bareDefault)).toBe("http://localhost:5173");
    const rejected = reply();
    expect(rejectDisallowedRequestOrigin(request({ origin: "http://127.0.0.1:62949" }, "none"), rejected.reply)).toBe(
      true,
    );
    expect(rejected.code).toHaveBeenCalledWith(400);
  });

  it("returns a clear 400 for a disallowed browser origin, and leaves headerless clients alone", () => {
    delete process.env.GOATCITADEL_ALLOWED_ORIGINS;
    const bad = reply();
    expect(rejectDisallowedRequestOrigin(request({ origin: "https://evil.example.com" }), bad.reply)).toBe(true);
    expect(bad.code).toHaveBeenCalledWith(400);
    const good = reply();
    expect(rejectDisallowedRequestOrigin(request({ origin: "http://localhost:5173" }), good.reply)).toBe(false);
    expect(rejectDisallowedRequestOrigin(request({}), good.reply)).toBe(false);
    expect(good.code).not.toHaveBeenCalled();
  });
});
