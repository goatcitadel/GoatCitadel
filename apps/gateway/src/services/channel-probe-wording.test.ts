import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import * as ts from "typescript";
import { describe, expect, it, vi } from "vitest";
import {
  runDiscordBotLiveChecks,
  runMattermostBotLiveChecks,
  runSlackBotLiveChecks,
  runTelegramBotLiveChecks,
} from "./channel-bot-live-probes.js";
import { runWebhookDestinationLiveChecks } from "./channel-webhook-probes.js";

/**
 * The setup test's message is called a "test message" everywhere an operator can read it (Ruling R56). The step
 * keys (`slack_sandbox_send`, `ntfy_sandbox_cleanup`, ...) keep the word because stored evidence and the eligibility
 * rules match on them, so this guard allows exactly those key shapes and QQ's own sandbox host, and nothing else.
 */
const servicesDir = path.dirname(fileURLToPath(import.meta.url));

/** Every file that builds a probe step, a diagnostic check or a finalize blocker for the setup test. */
const PROBE_SOURCES = [
  "channel-bot-live-probes.ts",
  "channel-webhook-probes.ts",
  "matrix-live-probes.ts",
  "nextcloud-talk-live-probes.ts",
  "ntfy-channel-live-probes.ts",
  "qqbot-live-probes.ts",
  "wecom-live-probes.ts",
  "channel-probe-result.ts",
  "channel-setup-eligibility.ts",
  "channel-setup-evidence-service.ts",
  "channel-setup-journey-service.ts",
  "channel-setup-service.ts",
  "integration-diagnostics-service.ts",
];

const ALLOWED_SANDBOX_LITERALS: ReadonlyArray<{ reason: string; matches: (literal: string) => boolean }> = [
  {
    reason: "a stored step key, or the `_sandbox_send` / `_sandbox_cleanup` part of a template-built key",
    matches: (literal) => /^[a-z_]*sandbox_(?:send|cleanup)$/u.test(literal),
  },
  {
    reason: "QQ's own sandbox host, which the operator turns on with Test mode",
    matches: (literal) => literal === "https://sandbox.api.sgroup.qq.com",
  },
  {
    reason: "the network guard note: it is about the tool sandbox, not the test message",
    matches: (literal) => literal.includes("remain protected by sandbox guards"),
  },
];

function stringLiterals(fileName: string): string[] {
  const text = readFileSync(path.join(servicesDir, fileName), "utf8");
  const source = ts.createSourceFile(fileName, text, ts.ScriptTarget.Latest, true);
  const literals: string[] = [];
  const visit = (node: ts.Node): void => {
    if (ts.isStringLiteral(node) || ts.isTemplateLiteralToken(node)) literals.push(node.text);
    ts.forEachChild(node, visit);
  };
  visit(source);
  return literals;
}

describe("the setup test's message is a test message wherever an operator can read it", () => {
  it.each(PROBE_SOURCES)("%s has no operator-visible 'sandbox' beyond step keys and QQ's own host", (fileName) => {
    const literals = stringLiterals(fileName);
    const mentioningSandbox = literals.filter((literal) => /sandbox/iu.test(literal));
    const offenders = mentioningSandbox.filter(
      (literal) => !ALLOWED_SANDBOX_LITERALS.some((allowed) => allowed.matches(literal)),
    );

    expect(offenders).toEqual([]);
    // The scan must have read the file, or an empty result would pass for the wrong reason.
    expect(literals.length).toBeGreaterThan(0);
  });

  it("still finds the stored step keys, so the allowance above is exercised", () => {
    const keys = stringLiterals("channel-bot-live-probes.ts").filter((literal) =>
      /^[a-z_]*sandbox_send$/u.test(literal),
    );

    expect(keys).toContain("slack_sandbox_send");
  });
});

function sendAndCleanupText(result: Awaited<ReturnType<typeof runSlackBotLiveChecks>>) {
  return result.probe.steps
    .filter((step) => /_sandbox_(?:send|cleanup)$/u.test(step.key))
    .map((step) => [step.key.replace(/^.*_sandbox_/u, ""), step.status, step.label, step.message]);
}

const SENT = ["send", "pass", "Test send", "Sent the test message."];
const DELETED = ["cleanup", "pass", "Test cleanup", "Deleted the test message."];

describe("probes that delete their post say what happened, and never ask for a message that is gone", () => {
  it("Slack sends and deletes the test message", async () => {
    const fetcher = vi.fn(async (url: string) =>
      url.endsWith("/chat.postMessage")
        ? new Response(JSON.stringify({ ok: true, ts: "1.1", channel: "C1" }), { status: 200 })
        : new Response(JSON.stringify({ ok: true }), { status: 200 }),
    );

    const result = await runSlackBotLiveChecks({ token: "t", channel: "C1", includeSandboxSend: true, fetcher });

    expect(sendAndCleanupText(result)).toEqual([SENT, DELETED]);
  });

  it("Telegram sends and deletes the test message", async () => {
    const fetcher = vi.fn(async (url: string) =>
      url.endsWith("/sendMessage")
        ? new Response(JSON.stringify({ ok: true, result: { message_id: 7 } }), { status: 200 })
        : new Response(JSON.stringify({ ok: true }), { status: 200 }),
    );

    const result = await runTelegramBotLiveChecks({ token: "t", chatId: "1", includeSandboxSend: true, fetcher });

    expect(sendAndCleanupText(result)).toEqual([SENT, DELETED]);
  });

  it("Discord sends and deletes the test message", async () => {
    const fetcher = vi.fn(async (url: string, init?: RequestInit) => {
      if (url.endsWith("/messages") && init?.method === "POST") {
        return new Response(JSON.stringify({ id: "m1" }), { status: 200 });
      }
      return new Response(JSON.stringify({ id: "x" }), { status: 200 });
    });

    const result = await runDiscordBotLiveChecks({
      token: "t",
      channelId: "c1",
      runtimeMode: "bridge",
      includeSandboxSend: true,
      fetcher,
    });

    expect(sendAndCleanupText(result)).toEqual([SENT, DELETED]);
  });

  it("Mattermost sends and deletes the test message", async () => {
    const fetcher = vi.fn(async (url: string, init?: RequestInit) => {
      if (url.endsWith("/api/v4/posts") && init?.method === "POST") {
        return new Response(JSON.stringify({ id: "p1" }), { status: 201 });
      }
      return new Response(JSON.stringify({ id: "bot-1" }), { status: 200 });
    });

    const result = await runMattermostBotLiveChecks({
      serverUrl: "https://chat.example.com",
      token: "t",
      defaultChannel: "town-square",
      defaultTeam: "ops",
      includeSandboxSend: true,
      fetcher,
    });

    expect(sendAndCleanupText(result)).toEqual([SENT, DELETED]);
  });

  it("Slack says it could not delete the test message when Slack refuses the delete", async () => {
    const fetcher = vi.fn(async (url: string) =>
      url.endsWith("/chat.delete")
        ? new Response("", { status: 403 })
        : new Response(JSON.stringify({ ok: true, ts: "1.1", channel: "C1" }), { status: 200 }),
    );

    const result = await runSlackBotLiveChecks({ token: "t", channel: "C1", includeSandboxSend: true, fetcher });

    expect(sendAndCleanupText(result)).toEqual([
      SENT,
      ["cleanup", "warn", "Test cleanup", "Slack returned HTTP 403 while deleting the test message."],
    ]);
  });

  it("Discord and Mattermost say the test message was sent but could not be deleted", async () => {
    const discord = await runDiscordBotLiveChecks({
      token: "t",
      channelId: "c1",
      runtimeMode: "bridge",
      includeSandboxSend: true,
      fetcher: vi.fn(async (url: string, init?: RequestInit) =>
        init?.method === "DELETE"
          ? new Response("", { status: 500 })
          : new Response(JSON.stringify({ id: "m1" }), { status: 200 }),
      ),
    });
    const mattermost = await runMattermostBotLiveChecks({
      serverUrl: "https://chat.example.com",
      token: "t",
      defaultChannel: "town-square",
      defaultTeam: "ops",
      includeSandboxSend: true,
      fetcher: vi.fn(async (url: string, init?: RequestInit) => {
        if (init?.method === "DELETE") return new Response("", { status: 500 });
        if (url.endsWith("/api/v4/posts") && init?.method === "POST") {
          return new Response(JSON.stringify({ id: "p1" }), { status: 201 });
        }
        return new Response(JSON.stringify({ id: "bot-1" }), { status: 200 });
      }),
    });

    for (const result of [discord, mattermost]) {
      expect(sendAndCleanupText(result)[1]).toEqual([
        "cleanup",
        "warn",
        "Test cleanup",
        "Sent the test message, but deleting it failed with HTTP 500.",
      ]);
    }
  });
});

describe("webhook probes", () => {
  it.each(["google-chat", "teams", "slack", "discord"] as const)(
    "%s names the test message and asks to confirm only the one it really sent",
    async (channelKey) => {
      const fetcher = vi.fn(async () => new Response("ok", { status: 200 }));
      const sent = await runWebhookDestinationLiveChecks({
        channelKey,
        webhookUrl: "https://hooks.example.test/abc",
        includeSandboxSend: true,
        fetcher,
      });
      const notSent = await runWebhookDestinationLiveChecks({
        channelKey,
        webhookUrl: "https://hooks.example.test/abc",
        includeSandboxSend: false,
        fetcher,
      });

      expect(sent.probe.steps).toEqual([
        expect.objectContaining({
          label: "Test send",
          status: "pass",
          message: "Webhook accepted the test message. Confirm it arrived in the intended destination.",
        }),
      ]);
      expect(notSent.probe.steps).toEqual([
        expect.objectContaining({
          label: "Test send",
          status: "skipped",
          message:
            "Non-destructive diagnostics did not send the test message. Run the guided test or retest flow to send it, then confirm it arrived.",
        }),
      ]);
      expect(fetcher).toHaveBeenCalledTimes(1);
    },
  );
});
