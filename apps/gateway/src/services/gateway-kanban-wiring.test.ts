import { describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  fetchAllowlisted: vi.fn(async () => new Response(null, { status: 204 })),
}));

vi.mock("@goatcitadel/policy-engine", () => ({
  fetchAllowlisted: mocks.fetchAllowlisted,
}));

import { createDefaultArtifactProbers } from "./gateway-kanban-wiring.js";

describe("createDefaultArtifactProbers", () => {
  it("uses the guarded allowlisted fetch path for URL artifact HEAD probes", async () => {
    const probers = createDefaultArtifactProbers({
      networkAllowlist: ["example.com"],
      httpTimeoutMs: 1234,
    });

    await expect(probers.http.headOk("https://example.com/artifact")).resolves.toBe(true);

    expect(mocks.fetchAllowlisted).toHaveBeenCalledWith(
      "https://example.com/artifact",
      expect.objectContaining({
        allowlist: ["example.com"],
        timeoutMs: 1234,
        init: { method: "HEAD" },
      }),
    );
  });

  it("propagates policy block errors instead of masking them as missing artifacts", async () => {
    mocks.fetchAllowlisted.mockRejectedValueOnce(new Error("Private resolved address is blocked: https://example.com"));
    const probers = createDefaultArtifactProbers({ networkAllowlist: ["example.com"] });

    await expect(probers.http.headOk("https://example.com/artifact")).rejects.toThrow(/blocked/i);
  });
});
