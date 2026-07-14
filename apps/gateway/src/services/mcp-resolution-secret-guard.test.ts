import { Buffer } from "node:buffer";
import { describe, expect, it } from "vitest";
import { createMcpResolutionSecretGuard } from "./mcp-resolution-secret-guard.js";

describe("MCP resolution secret guard", () => {
  it("scrubs URL pieces, header values, authorization components, and fixed transforms", () => {
    const fullUrl =
      "https://mcp.example.test/tenant%2Falpha/private-path?token=query-secret&encoded=quote%22secret&space=a+b";
    const guard = createMcpResolutionSecretGuard({
      url: fullUrl,
      headers: [
        { name: "authorization", value: "Bearer header-secret" },
        { name: "x-tenant", value: 'quote"secret' },
      ],
    });
    const canaries = [
      fullUrl,
      "https://mcp.example.test",
      "mcp.example.test",
      "tenant%2Falpha",
      "tenant/alpha",
      "query-secret",
      "Bearer header-secret",
      "header-secret",
      encodeURIComponent("header-secret"),
      Buffer.from("header-secret", "utf8").toString("base64"),
      Buffer.from("header-secret", "utf8").toString("base64url"),
      JSON.stringify('quote"secret'),
      "a b",
    ];
    const scrubbed = guard.scrubText(canaries.join(" | "));

    for (const canary of canaries) expect(scrubbed).not.toContain(canary);
    expect(scrubbed).toContain("[REDACTED]");
  });

  it("scrubs base64 and base64url transforms of transitively percent-decoded header secrets", () => {
    const guard = createMcpResolutionSecretGuard({
      url: "https://mcp.example.test/path",
      headers: [
        { name: "authorization", value: "Bearer %73ecret" },
        { name: "x-secret", value: "%73ecret%3F%3F" },
      ],
    });
    const decoded = "secret??";
    const canaries = [
      "c2VjcmV0",
      Buffer.from(decoded, "utf8").toString("base64"),
      Buffer.from(decoded, "utf8").toString("base64url"),
    ];

    const scrubbed = guard.scrubText(canaries.join(" | "));
    for (const canary of canaries) expect(scrubbed).not.toContain(canary);
    expect(scrubbed).toContain("[REDACTED]");
  });

  it("recursively scrubs errors and causes without invoking attacker getters", () => {
    const guard = createMcpResolutionSecretGuard({
      url: "https://mcp.example.test/private?token=query-secret",
      headers: [{ name: "authorization", value: "Bearer header-secret" }],
    });
    let getterReads = 0;
    const hostile = Object.create(null) as Record<string, unknown>;
    Object.defineProperty(hostile, "secret", {
      enumerable: true,
      get() {
        getterReads += 1;
        return "header-secret";
      },
    });
    Object.defineProperty(hostile, "__proto__", {
      enumerable: true,
      value: { polluted: "header-secret" },
    });
    const error = new Error("failed at https://mcp.example.test/private with header-secret", {
      cause: new Error("query-secret"),
    });
    const scrubbed = guard.scrubDiagnostic({ error, hostile });
    const serialized = JSON.stringify(scrubbed);

    expect(getterReads).toBe(0);
    expect(serialized).not.toContain("mcp.example.test");
    expect(serialized).not.toContain("header-secret");
    expect(serialized).not.toContain("query-secret");
    expect(serialized).toContain("[REDACTED]");
    expect(Object.getPrototypeOf((scrubbed as { hostile: object }).hostile)).toBeNull();
  });

  it("fails closed when the bounded derivation set exceeds its entry or byte cap", () => {
    const query = Array.from({ length: 96 }, (_, index) => `key-${index}=value-${index}`).join("&");
    expect(() =>
      createMcpResolutionSecretGuard({
        url: `https://mcp.example.test/path?${query}`,
        headers: [],
      }),
    ).toThrowError(expect.objectContaining({ code: "secret_guard_failed" }));

    expect(() =>
      createMcpResolutionSecretGuard({
        url: "https://mcp.example.test/path",
        headers: [{ name: "authorization", value: "x".repeat(300_000) }],
      }),
    ).toThrowError(expect.objectContaining({ code: "secret_guard_failed" }));
  });

  it("cannot be serialized and releases all scrubbing capability on dispose", () => {
    const guard = createMcpResolutionSecretGuard({
      url: "https://mcp.example.test/private",
      headers: [{ name: "authorization", value: "Bearer header-secret" }],
    });
    expect(() => JSON.stringify(guard)).toThrowError(expect.objectContaining({ code: "secret_guard_failed" }));
    guard.dispose();
    expect(guard.isDisposed()).toBe(true);
    expect(() => guard.scrubText("header-secret")).toThrowError(
      expect.objectContaining({ code: "secret_guard_failed" }),
    );
  });
});
