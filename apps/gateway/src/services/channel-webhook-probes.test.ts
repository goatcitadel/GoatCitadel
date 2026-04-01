import { describe, expect, it, vi } from "vitest";
import { runWebhookDestinationLiveChecks } from "./channel-webhook-probes.js";

describe("runWebhookDestinationLiveChecks", () => {
  it("posts a Teams sandbox card when live send is enabled", async () => {
    const fetcher = vi.fn(async () => new Response("1", { status: 200 }));

    const result = await runWebhookDestinationLiveChecks({
      channelKey: "teams",
      webhookUrl: "https://outlook.office.com/webhook/example",
      includeSandboxSend: true,
      cardTitle: "GoatCitadel Test",
      checkedAt: "2026-03-29T12:00:00.000Z",
      fetcher,
    });

    expect(fetcher).toHaveBeenCalledWith(
      "https://outlook.office.com/webhook/example",
      expect.objectContaining({
        method: "POST",
      }),
    );
    const [, init] = fetcher.mock.calls[0] as unknown as [string, RequestInit & { body?: BodyInit | null }];
    expect(String(init.body ?? "")).toContain("AdaptiveCard");
    expect(String(init.body ?? "")).toContain("GoatCitadel Test");
    expect(result.checks).toEqual([
      expect.objectContaining({
        key: "teams_sandbox_send",
        status: "pass",
      }),
    ]);
    expect(result.probe.steps).toEqual([
      expect.objectContaining({
        key: "teams_sandbox_send",
        status: "pass",
      }),
    ]);
  });

  it("posts a Google Chat sandbox message into the configured thread key", async () => {
    const fetcher = vi.fn(async () => new Response(JSON.stringify({ name: "spaces/AAAA/messages/123" }), {
      status: 200,
      headers: {
        "Content-Type": "application/json",
      },
    }));

    const result = await runWebhookDestinationLiveChecks({
      channelKey: "google-chat",
      webhookUrl: "https://chat.googleapis.com/v1/spaces/AAAA/messages?key=test&token=test",
      includeSandboxSend: true,
      defaultThreadKey: "ops-thread",
      checkedAt: "2026-03-29T12:00:00.000Z",
      fetcher,
    });

    const [url, init] = fetcher.mock.calls[0] as unknown as [string, RequestInit & { body?: BodyInit | null }];
    expect(url).toContain("threadKey=ops-thread");
    expect(String(init.body ?? "")).toContain("GoatCitadel probe 2026-03-29T12:00:00.000Z");
    expect(result.checks).toEqual([
      expect.objectContaining({
        key: "google_chat_sandbox_send",
        status: "pass",
      }),
    ]);
  });

  it("returns a warning check when non-destructive diagnostics skip webhook sends", async () => {
    const fetcher = vi.fn();

    const result = await runWebhookDestinationLiveChecks({
      channelKey: "teams",
      webhookUrl: "https://outlook.office.com/webhook/example",
      includeSandboxSend: false,
      fetcher,
    });

    expect(fetcher).not.toHaveBeenCalled();
    expect(result.checks).toEqual([
      {
        key: "teams_live_send",
        status: "warn",
        message: "Teams live send probe skipped because non-destructive diagnostics do not post webhook messages.",
      },
    ]);
    expect(result.probe.steps).toEqual([
      expect.objectContaining({
        key: "teams_sandbox_send",
        status: "skipped",
      }),
    ]);
  });

  it("maps webhook failures into actionable probe categories", async () => {
    const fetcher = vi.fn(async () => new Response(JSON.stringify({
      message: "Webhook was rejected.",
    }), {
      status: 403,
      headers: {
        "Content-Type": "application/json",
      },
    }));

    const result = await runWebhookDestinationLiveChecks({
      channelKey: "google-chat",
      webhookUrl: "https://chat.googleapis.com/v1/spaces/AAAA/messages?key=test&token=test",
      includeSandboxSend: true,
      fetcher,
    });

    expect(result.checks).toEqual([
      {
        key: "google_chat_sandbox_send",
        status: "fail",
        message: "Sandbox send: Google Chat returned HTTP 403: Webhook was rejected.",
      },
    ]);
    expect(result.probe.steps).toEqual([
      expect.objectContaining({
        key: "google_chat_sandbox_send",
        status: "fail",
        failureCategory: "permission_mismatch",
      }),
    ]);
  });
});
