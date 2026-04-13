import { describe, expect, it, vi } from "vitest";
import { createGatewayLogger } from "./runtime-ux.js";

describe("runtime logger coverage", () => {
  it("sanitizes circular metadata without crashing in verbose mode", () => {
    const logger = createGatewayLogger(true);
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    const circular: Record<string, unknown> = {
      authMode: "token",
      queryParam: "access_token",
    };
    circular.self = circular;
    circular.list = [circular];

    expect(() => {
      logger.warn(
        circular,
        "assistant.auth.token.queryParam is deprecated for normal gateway requests; only SSE bridge tokens still use query parameters.",
      );
    }).not.toThrow();
    expect(warnSpy).toHaveBeenCalled();
  });
});
