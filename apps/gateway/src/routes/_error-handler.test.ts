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

    const payload = sendRouteError(
      reply as never,
      new ConflictError({ message: "Already resolved." }),
      log as never,
    );

    expect(reply.code).toHaveBeenCalledWith(409);
    expect(payload).toEqual({
      error: "Already resolved.",
      code: "STATE_CONFLICT",
    });
    expect(log.warn).toHaveBeenCalledTimes(1);
    expect(log.error).not.toHaveBeenCalled();
  });

  it("sanitizes unknown errors to a generic 500 body", () => {
    const reply = createReply();
    const log = {
      warn: vi.fn(),
      error: vi.fn(),
    };

    const payload = sendRouteError(
      reply as never,
      new Error("sensitive internal detail"),
      log as never,
    );

    expect(reply.code).toHaveBeenCalledWith(500);
    expect(payload).toEqual({
      error: "Internal server error",
    });
    expect(log.warn).not.toHaveBeenCalled();
    expect(log.error).toHaveBeenCalledTimes(1);
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
