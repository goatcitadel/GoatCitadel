import { readdirSync, readFileSync } from "node:fs";
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
 * rules match on them, so this guard allows exactly those key shapes, QQ's own sandbox words and the tool-sandbox
 * config key, and nothing else (Ruling R60: one vocabulary, so the guide copy is held to it too).
 */
const servicesDir = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(servicesDir, "..", "..", "..", "..");

const isSourceFile = (name: string) => name.endsWith(".ts") && !/\.test(?:-support)?\.ts$/u.test(name);
const sourcesIn = (dir: string, keep: (name: string) => boolean = () => true) =>
  readdirSync(dir)
    .filter((name) => isSourceFile(name) && keep(name))
    .sort()
    .map((name) => path.join(dir, name));

/**
 * Probe files are found by name, so a new `*-live-probes.ts` (or `channel-*-probes.ts`) cannot slip past the guard.
 * The rest build the finalize blocker, the diagnostics, the setup guides and the channel support notes an operator reads.
 */
const PROBE_SOURCES = sourcesIn(
  servicesDir,
  (name) => name.endsWith("-live-probes.ts") || /^channel-.*-probes\.ts$/u.test(name),
);
const RESULT_SOURCES = [
  "channel-probe-result.ts",
  "channel-setup-eligibility.ts",
  "channel-setup-evidence-service.ts",
  "channel-setup-journey-service.ts",
  "channel-setup-service.ts",
  "integration-diagnostics-service.ts",
].map((name) => path.join(servicesDir, name));
const GUIDE_SOURCES = sourcesIn(path.join(servicesDir, "channel-setup-definitions"));
const SUPPORT_NOTE_SOURCES = [path.join(repoRoot, "packages", "gateway-core", "src", "channel-core.ts")];
const SOURCES = [...new Set([...PROBE_SOURCES, ...RESULT_SOURCES, ...GUIDE_SOURCES, ...SUPPORT_NOTE_SOURCES])];

/** A literal that is exactly a stored key or checklist id. These are contracts, not words an operator reads. */
const STORED_KEY_SHAPES: readonly RegExp[] = [
  /^[a-z_]*sandbox_(?:send|cleanup)$/u, // step keys, and the `_sandbox_send` tail of a template-built key
  /^sandbox$/u, // QQ's `sandbox` field key, and Slack's checklist id
  /^sandbox-channel$/u, // Discord's checklist id
];

/** Phrases that are someone else's words, removed before the check. Anything left that says "sandbox" fails. */
const NOT_OURS: ReadonlyArray<{ reason: string; phrase: string }> = [
  { reason: "QQ's sandbox host, turned on by QQ's Test mode", phrase: "sandbox.api.sgroup.qq.com" },
  { reason: "QQ's Test mode field label", phrase: "Test mode (sandbox)" },
  { reason: "QQ's FAQ wording about its sandbox host", phrase: "QQ's sandbox host" },
  { reason: "QQ's FAQ wording about its sandbox host", phrase: "tried in the sandbox" },
  { reason: "the title of QQ's FAQ page", phrase: "QQ FAQ: the sandbox" },
  { reason: "the config key the operator edits, not the test message", phrase: "toolPolicy.sandbox.networkAllowlist" },
  { reason: "the tool network guard, not the test message", phrase: "remain protected by sandbox guards" },
];

function mentionsSandboxAsAWord(literal: string): boolean {
  if (STORED_KEY_SHAPES.some((shape) => shape.test(literal))) return false;
  const rest = NOT_OURS.reduce((text, { phrase }) => text.split(phrase).join(""), literal);
  return /sandbox/iu.test(rest);
}

function stringLiterals(file: string): string[] {
  const text = readFileSync(file, "utf8");
  const source = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true);
  const literals: string[] = [];
  const visit = (node: ts.Node): void => {
    if (ts.isStringLiteral(node) || ts.isTemplateLiteralToken(node)) literals.push(node.text);
    ts.forEachChild(node, visit);
  };
  visit(source);
  return literals;
}

const relativeToRepo = (file: string) => path.relative(repoRoot, file).replaceAll("\\", "/");

describe("the setup test's message is a test message wherever an operator can read it", () => {
  it.each(SOURCES.map((file) => [relativeToRepo(file), file] as const))(
    "%s has no operator-visible 'sandbox' beyond stored keys and other people's words",
    (_name, file) => {
      const literals = stringLiterals(file);
      const offenders = literals.filter(mentionsSandboxAsAWord);

      expect(offenders).toEqual([]);
      // The scan must have read the file, or an empty result would pass for the wrong reason.
      expect(literals.length).toBeGreaterThan(0);
    },
  );

  it("finds every probe file by name, so a new one is held to the same rule", () => {
    const names = PROBE_SOURCES.map((file) => path.basename(file));

    expect(names).toEqual(
      expect.arrayContaining([
        "channel-bot-live-probes.ts",
        "channel-webhook-probes.ts",
        "matrix-live-probes.ts",
        "nextcloud-talk-live-probes.ts",
        "ntfy-channel-live-probes.ts",
        "qqbot-live-probes.ts",
        "wecom-live-probes.ts",
      ]),
    );
    expect(GUIDE_SOURCES.map((file) => path.basename(file))).toEqual(
      expect.arrayContaining(["discord.ts", "slack.ts", "qqbot.ts"]),
    );
    expect(GUIDE_SOURCES.some((file) => file.endsWith(".test.ts") || file.endsWith(".test-support.ts"))).toBe(false);
  });

  it("flags the old wording and lets stored keys and QQ's own words through", () => {
    expect(mentionsSandboxAsAWord("Sandbox send")).toBe(true);
    expect(mentionsSandboxAsAWord("Guided setup can run a sandbox send/delete probe before finalize.")).toBe(true);
    expect(mentionsSandboxAsAWord("A sandbox channel you can safely test in.")).toBe(true);
    expect(mentionsSandboxAsAWord("slack_sandbox_send")).toBe(false);
    expect(mentionsSandboxAsAWord("_sandbox_cleanup")).toBe(false);
    expect(mentionsSandboxAsAWord("Test mode (sandbox)")).toBe(false);
    expect(mentionsSandboxAsAWord("add sandbox.api.sgroup.qq.com when Test mode is on")).toBe(false);
  });

  it("still finds the stored step keys, so the allowance above is exercised", () => {
    const keys = stringLiterals(path.join(servicesDir, "channel-bot-live-probes.ts")).filter((literal) =>
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
