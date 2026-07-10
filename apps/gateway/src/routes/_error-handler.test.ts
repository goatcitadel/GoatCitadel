import { describe, expect, it, vi } from "vitest";
import { ConflictError } from "@goatcitadel/contracts";
import { sendRouteError } from "./_error-handler.js";

describe("sendRouteError", () => {
  it("returns typed GoatError responses with their declared status and body", () => {
    const reply = createReply();
    const log = {
      warn: vi.fn(),
      error: vi.fn(),
    };

    const payload = sendRouteError(reply as never, new ConflictError({ message: "Already resolved." }), log as never);

    expect(reply.code).toHaveBeenCalledWith(409);
    expect(payload).toEqual({
      error: "Already resolved.",
      code: "STATE_CONFLICT",
    });
    expect(log.warn).toHaveBeenCalledTimes(1);
    expect(log.error).not.toHaveBeenCalled();
  });

  it("projects secrets out of typed GoatError messages and details while preserving safe metadata", () => {
    const reply = createReply();
    const log = { warn: vi.fn(), error: vi.fn() };
    const error = new ConflictError({
      message: "Provider failed with Authorization: Bearer route-error-secret",
      details: {
        webhookUrl: "https://hooks.example.test/services/team/error-path-secret?token=error-query-secret",
        DATABASE_PASSWORD: "tiny-error-secret",
        tokenId: "safe-error-token-id",
      },
    });

    const payload = sendRouteError(reply as never, error, log as never);

    expect(JSON.stringify(payload)).not.toContain("route-error-secret");
    expect(JSON.stringify(payload)).not.toContain("error-path-secret");
    expect(JSON.stringify(payload)).not.toContain("error-query-secret");
    expect(JSON.stringify(payload)).not.toContain("tiny-error-secret");
    expect(payload).toMatchObject({
      error: "Provider failed with Authorization: [REDACTED]",
      details: {
        webhookUrl: "[REDACTED]",
        DATABASE_PASSWORD: "[REDACTED]",
        tokenId: "safe-error-token-id",
      },
    });
    expect(error.message).toContain("route-error-secret");
    expect(error.details?.webhookUrl).toContain("error-path-secret");
    expect(JSON.stringify(log.warn.mock.calls)).not.toContain("route-error-secret");
    expect(JSON.stringify(log.warn.mock.calls)).not.toContain("error-path-secret");
  });

  it("sanitizes unknown errors to a generic 500 body", () => {
    const reply = createReply();
    const log = {
      warn: vi.fn(),
      error: vi.fn(),
    };

    const payload = sendRouteError(
      reply as never,
      new Error("Authorization: Bearer unknown-error-secret"),
      log as never,
    );

    expect(reply.code).toHaveBeenCalledWith(500);
    expect(payload).toEqual({
      error: "Internal server error",
    });
    expect(log.warn).not.toHaveBeenCalled();
    expect(log.error).toHaveBeenCalledTimes(1);
    expect(JSON.stringify(log.error.mock.calls)).not.toContain("unknown-error-secret");
  });
});

function createReply() {
  const reply = {
    code: vi.fn(),
    send: vi.fn((payload: unknown) => payload),
  };
  reply.code.mockReturnValue(reply);
  return reply;
}
