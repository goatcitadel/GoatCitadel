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
    const fetcher = vi.fn(
      async () =>
        new Response(JSON.stringify({ name: "spaces/AAAA/messages/123" }), {
          status: 200,
          headers: {
            "Content-Type": "application/json",
          },
        }),
    );

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

  it.each(["plain", "json"] as const)("redacts echoed Teams callback URLs and decoded signatures in %s failures", async (format) => {
    const signature = "synthetic+workflow/signature=private";
    const encodedSignature = encodeURIComponent(signature).replaceAll("%2B", "%2b");
    const webhookUrl = "https://defaultenvironment.00.environment.api.powerplatform.com/powerautomate/automations/direct/cu/20/workflows/0123456789abcdef0123456789abcdef/triggers/manual/paths/invoke?api-version=1&sig=" + encodedSignature;
    const detail = "Workflow permission denied. Callback " + webhookUrl + " decoded " + signature + " raw " + encodedSignature + " encoded " + encodeURIComponent(webhookUrl);
    const result = await runWebhookDestinationLiveChecks({ channelKey: "teams", webhookUrl, includeSandboxSend: true, fetcher: vi.fn(async () => new Response(format === "json" ? JSON.stringify({ message: detail }) : detail, { status: 403 })) });
    const publicResult = JSON.stringify(result);
    expect(publicResult).not.toContain(webhookUrl);
    expect(publicResult).not.toContain(signature);
    expect(publicResult).not.toContain(encodedSignature);
    expect(publicResult).not.toContain(encodeURIComponent(webhookUrl));
    expect(result.probe.steps[0]).toMatchObject({ status: "fail", failureCategory: "permission_mismatch" });
    expect(result.probe.steps[0]?.message).toContain("HTTP 403");
    expect(result.probe.steps[0]?.message).toContain("Workflow permission denied");
    expect(result.probe.steps[0]?.message).toContain("[REDACTED]");
  });

  it.each([
    { channelKey: "google-chat" as const, webhookUrl: "https://chat.googleapis.com/v1/spaces/AAAA/messages?key=synthetic-google-key&token=synthetic-google-token", secret: "synthetic-google-token" },
    { channelKey: "slack" as const, webhookUrl: "https://hooks.slack.com/services/Tsynthetic/Bsynthetic/synthetic-slack-callback", secret: "synthetic-slack-callback" },
    { channelKey: "discord" as const, webhookUrl: "https://discord.com/api/webhooks/123456789012345678/synthetic-discord-callback", secret: "synthetic-discord-callback" },
  ])("redacts standalone query or path callback credentials for $channelKey", async ({ channelKey, webhookUrl, secret }) => {
    const result = await runWebhookDestinationLiveChecks({ channelKey, webhookUrl, includeSandboxSend: true, fetcher: vi.fn(async () => new Response("Callback refused: " + webhookUrl + " credential " + secret, { status: 401 })) });
    expect(JSON.stringify(result)).not.toContain(webhookUrl);
    expect(JSON.stringify(result)).not.toContain(secret);
    expect(result.probe.steps[0]).toMatchObject({ status: "fail", failureCategory: "credential_rejected" });
  });

  it("bounds error details after redaction without retaining a truncated signature", async () => {
    const signature = "synthetic-long-callback-signature-crossing-boundary";
    const webhookUrl = "https://tenant.environment.api.powerplatform.com/powerautomate/automations/direct/workflows/test/triggers/manual/paths/invoke?sig=" + signature;
    const detail = "Destination unavailable. " + "a".repeat(1730) + signature + "b".repeat(4000);
    const result = await runWebhookDestinationLiveChecks({ channelKey: "teams", webhookUrl, includeSandboxSend: true, fetcher: vi.fn(async () => new Response(detail, { status: 500 })) });
    expect(result.probe.steps[0]).toMatchObject({ status: "warn", failureCategory: "platform_unavailable" });
    expect(result.probe.steps[0]?.message).toContain("HTTP 500");
    expect(result.probe.steps[0]?.message.length).toBeLessThanOrEqual(2048);
    expect(result.checks[0]?.message.length).toBeLessThanOrEqual(2048);
    expect(JSON.stringify(result)).not.toContain(signature);
    expect(JSON.stringify(result)).not.toContain("synthetic-long-callback-signature");
  });

  it("keeps fetch exceptions containing callback credentials private and reports an uncertain outcome without retry", async () => {
    const webhookUrl = "https://tenant.environment.api.powerplatform.com/powerautomate/automations/direct/workflows/test/triggers/manual/paths/invoke?sig=synthetic-thrown-signature";
    const fetcher = vi.fn(async () => { throw new Error("Network failed for " + webhookUrl + " synthetic-thrown-signature"); });
    const result = await runWebhookDestinationLiveChecks({ channelKey: "teams", webhookUrl, includeSandboxSend: true, fetcher });
    expect(fetcher).toHaveBeenCalledOnce();
    expect(result.probe.steps[0]).toMatchObject({ status: "warn", failureCategory: "platform_unavailable" });
    expect(result.probe.steps[0]?.message).toContain("uncertain");
    expect(JSON.stringify(result)).not.toContain(webhookUrl);
    expect(JSON.stringify(result)).not.toContain("synthetic-thrown-signature");
  });

  it("retains a known HTTP rejection when the optional provider body cannot be read", async () => {
    const body = new ReadableStream({ start(controller) { controller.error(new Error("provider body unavailable")); } });
    const result = await runWebhookDestinationLiveChecks({ channelKey: "teams", webhookUrl: "https://tenant.environment.api.powerplatform.com/workflow?sig=synthetic", includeSandboxSend: true, fetcher: vi.fn(async () => new Response(body, { status: 403 })) });
    expect(result.probe.steps[0]).toMatchObject({ status: "fail", failureCategory: "permission_mismatch", message: "Teams returned HTTP 403." });
  });

  it("maps webhook failures into actionable probe categories", async () => {
    const fetcher = vi.fn(
      async () =>
        new Response(
          JSON.stringify({
            message: "Webhook was rejected.",
          }),
          {
            status: 403,
            headers: {
              "Content-Type": "application/json",
            },
          },
        ),
    );

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
