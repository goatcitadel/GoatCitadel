import { describe, expect, it, vi } from "vitest";
import { runNtfyLiveChecks } from "./channel-bot-live-probes.js";

describe("ntfy channel live probes", () => {
  it("publishes once through the configured topic and keeps cleanup truth explicit", async () => {
    const fetcher = vi.fn(
      async () =>
        new Response(JSON.stringify({ id: "ntfy-message-1" }), {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
    );

    const result = await runNtfyLiveChecks({
      baseUrl: "https://ntfy.example.com/base/",
      topic: "goatcitadel-ops",
      token: "ntfy-test-token",
      priority: "5",
      includeSandboxSend: true,
      fetcher,
      checkedAt: "2026-07-13T20:00:00.000Z",
    });

    expect(fetcher).toHaveBeenCalledTimes(1);
    const [url, init] = fetcher.mock.calls[0] ?? [];
    expect(url).toBe("https://ntfy.example.com/base/goatcitadel-ops");
    expect(init).toMatchObject({ method: "POST" });
    const headers = new Headers(init?.headers);
    expect(headers.get("authorization")).toBe("Bearer ntfy-test-token");
    expect(headers.get("priority")).toBe("5");
    expect(init?.body).toContain("GoatCitadel ntfy probe");
    expect(result.probe).toMatchObject({
      kind: "ntfy_publish",
      mode: "http_publish",
      steps: [
        { key: "ntfy_sandbox_send", status: "pass" },
        { key: "ntfy_sandbox_cleanup", status: "skipped" },
      ],
    });
    expect(result.checks).toEqual([expect.objectContaining({ key: "ntfy_sandbox_send", status: "pass" })]);
  });

  it("does not publish for non-destructive or configured dry-run diagnostics", async () => {
    const fetcher = vi.fn();
    const common = {
      baseUrl: "https://ntfy.example.com",
      topic: "goatcitadel-ops",
      fetcher,
      checkedAt: "2026-07-13T20:00:00.000Z",
    };

    const nonDestructive = await runNtfyLiveChecks({ ...common, includeSandboxSend: false });
    const dryRun = await runNtfyLiveChecks({ ...common, includeSandboxSend: true, dryRun: true });

    expect(fetcher).not.toHaveBeenCalled();
    expect(nonDestructive.checks).toEqual([]);
    expect(nonDestructive.probe.steps).toEqual([
      expect.objectContaining({ key: "ntfy_sandbox_send", status: "skipped" }),
    ]);
    expect(dryRun.probe).toMatchObject({
      mode: "dry_run",
      steps: [
        expect.objectContaining({
          key: "ntfy_sandbox_send",
          status: "skipped",
          message: expect.stringContaining("dry-run"),
        }),
      ],
    });
  });

  it("redacts credentials and records an unknown outcome without retrying a failed publish", async () => {
    const token = "ntfy-super-secret-token";
    const fetcher = vi.fn(async () => {
      throw new Error(`socket closed while using bearer ${token}`);
    });

    const result = await runNtfyLiveChecks({
      baseUrl: "https://ntfy.example.com",
      topic: "goatcitadel-ops",
      token,
      includeSandboxSend: true,
      fetcher,
      checkedAt: "2026-07-13T20:00:00.000Z",
    });

    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(JSON.stringify(result)).not.toContain(token);
    expect(result.probe.steps).toEqual([
      expect.objectContaining({
        key: "ntfy_sandbox_send",
        status: "warn",
        message: expect.stringContaining("outcome may be unknown"),
        failureCategory: "platform_unavailable",
      }),
    ]);
  });

  it("redacts provider rejection bodies and classifies credential failures", async () => {
    const token = "ntfy-rejected-secret-token";
    const fetcher = vi.fn(
      async () =>
        new Response(JSON.stringify({ error: `rejected bearer ${token}` }), {
          status: 401,
          headers: { "content-type": "application/json" },
        }),
    );

    const result = await runNtfyLiveChecks({
      baseUrl: "https://ntfy.example.com",
      topic: "goatcitadel-ops",
      token,
      includeSandboxSend: true,
      fetcher,
      checkedAt: "2026-07-13T20:00:00.000Z",
    });

    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(JSON.stringify(result)).not.toContain(token);
    expect(result.probe.steps).toEqual([
      expect.objectContaining({
        key: "ntfy_sandbox_send",
        status: "fail",
        message: expect.stringContaining("[REDACTED]"),
        failureCategory: "credential_rejected",
      }),
    ]);
  });

  it("fails before network mutation when the topic is malformed", async () => {
    const fetcher = vi.fn();

    const result = await runNtfyLiveChecks({
      baseUrl: "https://ntfy.example.com",
      topic: "invalid/topic",
      includeSandboxSend: true,
      fetcher,
      checkedAt: "2026-07-13T20:00:00.000Z",
    });

    expect(fetcher).not.toHaveBeenCalled();
    expect(result.probe.steps).toEqual([
      expect.objectContaining({
        key: "ntfy_sandbox_send",
        status: "fail",
        message: expect.stringContaining("before the ntfy publish request started"),
        failureCategory: "malformed_value",
      }),
    ]);
  });

  it("fails before network mutation when the base URL embeds credentials", async () => {
    const fetcher = vi.fn();

    const result = await runNtfyLiveChecks({
      baseUrl: "https://operator:secret@ntfy.example.com",
      topic: "goatcitadel-ops",
      includeSandboxSend: true,
      fetcher,
      checkedAt: "2026-07-13T20:00:00.000Z",
    });

    expect(fetcher).not.toHaveBeenCalled();
    expect(result.probe.steps).toEqual([
      expect.objectContaining({
        key: "ntfy_sandbox_send",
        status: "fail",
        message: expect.stringContaining("must not embed credentials"),
        failureCategory: "malformed_value",
      }),
    ]);
  });
});
