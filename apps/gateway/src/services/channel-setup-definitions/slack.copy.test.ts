import { describe, expect, it, vi } from "vitest";
import type {
  ChannelSetupDraft,
  ChannelSetupFieldDefinition,
  ChannelSetupIssue,
  ChannelSetupRichBlock,
  ChannelSetupStepDefinition,
  ChannelSetupTestResult,
  IntegrationConnection,
} from "@goatcitadel/contracts";
import { runSlackBotLiveChecks } from "../channel-bot-live-probes.js";
import { requireChannelSetupDefinition } from "../channel-setup-definitions.js";
import { evaluateChannelSetupEligibility } from "../channel-setup-eligibility.js";
import {
  buildIntegrationConnectionChecks,
  type IntegrationDiagnosticsPort,
} from "../integration-diagnostics-service.js";
import * as slackModule from "./slack.js";

function guide() {
  return requireChannelSetupDefinition("channel.slack");
}

function step(id: string): ChannelSetupStepDefinition {
  const found = guide().definition.wizard.steps.find((candidate) => candidate.id === id);
  if (!found) throw new Error(`Slack guide has no step ${id}`);
  return found;
}

function field(key: string): ChannelSetupFieldDefinition {
  const found = guide()
    .definition.wizard.steps.flatMap((candidate) => candidate.fields ?? [])
    .find((candidate) => candidate.key === key);
  if (!found) throw new Error(`Slack guide has no field ${key}`);
  return found;
}

function fieldKeys(id: string): string[] {
  return (step(id).fields ?? []).map((candidate) => candidate.key);
}

function textOf(blocks: readonly ChannelSetupRichBlock[] | undefined): string {
  return (blocks ?? []).map((block) => JSON.stringify(block)).join("\n");
}

function notes(id: string): string[] {
  return (step(id).body ?? []).flatMap((block) => (block.kind === "note" ? [block.text] : []));
}

function paragraphs(id: string): string[] {
  return (step(id).body ?? []).flatMap((block) => (block.kind === "paragraph" ? [block.text] : []));
}

function draftOf(
  values: Record<string, unknown>,
  lifecycleMode: ChannelSetupDraft["lifecycleMode"] = "create",
): ChannelSetupDraft {
  return {
    draftId: "22222222-2222-2222-2222-222222222222",
    catalogId: "channel.slack",
    lifecycleMode,
    enabled: true,
    draft: values,
    revision: 1,
    secretState: {},
    contentVersion: "content.v1",
    adapterVersion: "adapter.v1",
    validationVersion: "validation.v1",
    testVersion: "test.v1",
    createdAt: "2026-03-29T00:00:00.000Z",
    updatedAt: "2026-03-29T00:00:00.000Z",
  };
}

function connectionOf(config: Record<string, unknown>): IntegrationConnection {
  return {
    connectionId: "11111111-1111-1111-1111-111111111111",
    catalogId: "channel.slack",
    kind: "channel",
    key: "slack",
    label: "Slack",
    revision: "1",
    enabled: true,
    status: "connected",
    config,
    createdAt: "2026-03-29T00:00:00.000Z",
    updatedAt: "2026-03-29T00:00:00.000Z",
  };
}

const BOT_TOKEN = "xoxb-123-456-abc";
const WEBHOOK_URL = "https://hooks.slack.com/services/T000/B000/XXXX";
const OAUTH_VARIABLES = [
  "GOATCITADEL_SLACK_OAUTH_CLIENT_ID",
  "GOATCITADEL_SLACK_OAUTH_CLIENT_SECRET",
  "GOATCITADEL_SLACK_OAUTH_REDIRECT_URI",
  "GOATCITADEL_SLACK_OAUTH_STATE_SECRET",
];

describe("Slack setup copy", () => {
  it("does not promise a hosted GoatCitadel Slack app", () => {
    // The copy lives inside the definition builder, so build the definition and
    // stringify whatever each export returns (functions are called, data is kept).
    const built = Object.values(slackModule).map((exported) =>
      typeof exported === "function" ? (exported as () => unknown)() : exported,
    );
    const text = JSON.stringify(built);

    expect(text.length).toBeGreaterThan(1000);
    expect(text).not.toContain("hosted GoatCitadel");
    expect(text).not.toContain("GoatCitadel Slack app");
    expect(text).not.toContain("Hosted Slack");
    expect(text).toContain("your Slack app");
  });

  it("uses no words the operator copy rules ban anywhere in the guide", () => {
    const text = JSON.stringify(guide().definition.wizard);

    expect(text).not.toMatch(/posture|provenance|ingress|egress|sandbox message|activation plan/iu);
  });
});

describe("Slack setup guide: what it says up front (items 4 and 5)", () => {
  it("opens with the intro, prerequisites and first message from the audit", () => {
    const wizard = guide().definition.wizard;

    expect(wizard.introSummary).toBe(
      "Send messages from your own Slack app into the channels you choose. Receiving messages needs an app installed with OAuth and a public HTTPS address.",
    );
    expect(wizard.prerequisites).toEqual([
      "Your own Slack app with the chat:write scope, installed to your workspace.",
      "The bot invited to each private channel (/invite @your-app).",
      "To receive messages: an OAuth install from here with message history scopes, and a public HTTPS address for this Gateway.",
    ]);
    expect(paragraphs("first-message")).toEqual([
      "Check the test message arrived. To receive messages (OAuth installs only): in your Slack app open Event Subscriptions, paste this connection's webhook address, subscribe to message events, and allow your Slack member ID under Who may message this bot.",
    ]);
  });

  it("says in the overview that a pasted bot token is the main path and OAuth is advanced", () => {
    expect(notes("overview")).toContain(
      "Paste a bot token from your own Slack app. Installing with OAuth is an advanced option: it needs your own Slack app, a public HTTPS redirect address and four settings on the Gateway.",
    );
  });
});

describe("Slack setup guide: creating the app (item 1)", () => {
  it("replaces the unfinishable OAuth checklist with the steps to create an app and copy its token", () => {
    const create = step("create-app");

    expect(create.title).toBe("Create your Slack app and copy its bot token");
    expect(create.kind).toBe("instruction");
    expect(create.createOnly).toBe(true);
    expect(create.checklist).toBeUndefined();
    expect(create.body).toContainEqual({
      kind: "list",
      ordered: true,
      items: [
        "Open api.slack.com/apps › Create New App › From scratch, and pick your workspace.",
        "Open OAuth & Permissions. Under Bot Token Scopes add chat:write. Add chat:write.public if you won't invite the bot to the channel.",
        "Click Install to Workspace and allow it.",
        "Copy the Bot User OAuth Token (it starts with xoxb-).",
        "For a private channel, type /invite @your-app in that channel.",
      ],
    });
    expect(textOf(create.body)).toContain("https://api.slack.com/apps");
  });

  it("puts the app steps before the token field and hides them when a saved channel is changed", () => {
    const ids = guide().definition.wizard.steps.map((candidate) => candidate.id);

    expect(ids.indexOf("create-app")).toBeGreaterThan(ids.indexOf("prerequisites"));
    expect(ids.indexOf("create-app")).toBeLessThan(ids.indexOf("collect-values-identity"));
    expect(
      guide()
        .definition.wizard.steps.filter((candidate) => candidate.createOnly)
        .map((candidate) => candidate.id),
    ).toEqual(["overview", "prerequisites", "create-app"]);
  });

  it("leaves no step asking a person to tick a box for a button that is not on that step", () => {
    const labels = guide().definition.wizard.steps.flatMap((candidate) =>
      (candidate.checklist ?? []).map((item) => item.label),
    );

    expect(labels).not.toContain("Click Connect Slack");
    expect(step("oauth-install").checklist).toBeUndefined();
  });

  it("keeps OAuth as an advanced option that names the four settings it needs", () => {
    const oauth = step("oauth-install");
    const text = textOf(oauth.body);

    expect(oauth.title).toBe("Connect Slack with OAuth");
    expect(oauth.kind).toBe("instruction");
    for (const name of OAUTH_VARIABLES) {
      expect(text, name).toContain(name);
    }
    expect(text).toContain("restart GoatCitadel");
    expect(text).toMatch(/advanced/iu);
  });

  it("opens an edit guide on the account stage, not on Before you start (Ruling R36)", () => {
    // "identity" is the stage the cockpit and Classic wizards label "Connect account".
    expect(step("oauth-install").stage).toBe("identity");
    const firstOnEdit = guide().definition.wizard.steps.find((candidate) => !candidate.createOnly);
    expect(firstOnEdit?.stage).toBe("identity");
  });

  it("asks for a bot token or a webhook, not for OAuth, when neither is given", () => {
    const issues = guide().validate(draftOf({ targets: [{ channel: "#ops", default: true }] }));

    expect(issues).toEqual([
      expect.objectContaining({
        key: "slack_auth_missing",
        fieldKey: "botToken",
        message: "Paste the bot token (starts with xoxb-), or a webhook URL for send-only.",
        level: "error",
      }),
    ]);
  });
});

describe("Slack setup guide: the fields (item 2)", () => {
  it("puts the bot token first and calls it a bot token", () => {
    expect(fieldKeys("collect-values-identity")[0]).toBe("botToken");
    expect(field("botToken").label).toBe("Bot token");
    expect(field("botToken").advanced).not.toBe(true);
    expect(field("botToken").required).toBe(false);
  });

  it("names the OAuth install and the webhook for what they are", () => {
    expect(field("slackInstallId").label).toBe("Connected Slack install (OAuth only)");
    expect(field("webhookUrl").label).toBe("Incoming webhook URL (send-only)");
  });

  it("lists the bot token first when it asks for one of the ways to connect", () => {
    const alternatives = step("collect-values-identity").requiredAnyOf?.[0] ?? [];

    expect(alternatives[0]).toBe("botToken");
    expect(alternatives).toEqual(
      expect.arrayContaining(["botToken", "botTokenEnv", "slackInstallId", "webhookUrl", "webhookUrlEnv"]),
    );
  });

  it("keeps the webhook URL a real field the host list can read", () => {
    expect(guide().definition.wizard.hostFields).toEqual(["webhookUrl"]);
  });
});

describe("Slack setup guide: receiving messages (item 3)", () => {
  it("says what this version of Slack can receive", () => {
    expect(notes("overview")).toContain(
      "In this version Slack can receive messages only from an app installed with OAuth here, with message history scopes (set GOATCITADEL_SLACK_OAUTH_SCOPES) and a public HTTPS address. A pasted bot token can send but not receive.",
    );
  });

  it("shows the signing secret only for an OAuth install, and says so", () => {
    const secret = field("signingSecret");

    expect(secret.label).toBe("Signing secret (OAuth installs that receive messages)");
    expect(secret.visibleWhenFieldEquals).toEqual({ fieldKey: "authMode", value: "oauth" });
  });

  it("keeps the OAuth mark on an edit draft so a connected install still shows its signing secret", () => {
    const hydrated = guide().hydrate(connectionOf({ authMode: "oauth", botToken: BOT_TOKEN, defaultChannel: "#ops" }));
    const condition = field("signingSecret").visibleWhenFieldEquals;

    expect(hydrated.draft.authMode).toBe("oauth");
    expect(hydrated.draft[condition?.fieldKey ?? ""]).toBe(condition?.value);
  });

  it("does not show the signing secret for a pasted token", () => {
    const hydrated = guide().hydrate(connectionOf({ botToken: BOT_TOKEN, defaultChannel: "#ops" }));

    expect(hydrated.draft.authMode).toBeUndefined();
  });
});

describe("Slack setup guide: who may message the bot (item 6, A7, A8)", () => {
  it("says what a Slack sender identity looks like", () => {
    const allowed = step("sender-access").fields?.find((candidate) => candidate.key === "allowedSenders");

    expect(allowed?.explanation).toBe("Your Slack member ID (starts with U).");
  });

  it("offers the open-access choice only for a connection that was saved open", () => {
    const mode = step("sender-access").fields?.find((candidate) => candidate.key === "inboundAccessMode");
    const fresh = guide().hydrate(
      connectionOf({ botToken: BOT_TOKEN, defaultChannel: "#ops", allowedSenders: ["U1"] }),
    );
    const open = guide().hydrate(
      connectionOf({ botToken: BOT_TOKEN, defaultChannel: "#ops", inboundAccessMode: "open_legacy" }),
    );
    const condition = mode?.visibleWhenFieldEquals;

    expect(condition).toBeDefined();
    expect(fresh.draft[condition?.fieldKey ?? ""]).not.toBe(condition?.value);
    expect(open.draft[condition?.fieldKey ?? ""]).toBe(condition?.value);
  });
});

describe("Slack setup guide: the test and finishing (item 7)", () => {
  it("says the webhook-only test post stays in the channel", () => {
    expect(paragraphs("test")).toContain("The webhook-only path sends one test post that stays in the channel.");
    expect(textOf(step("test").body)).not.toContain("rely on manual confirmation");
  });

  it("tells a person who pasted a token to copy it again or fix the scope, not to reconnect", async () => {
    const advice = "Copy the bot token again, or add the missing scope and reinstall the app.";
    const failure = (error: string) =>
      vi.fn(async () => new Response(JSON.stringify({ ok: false, error }), { status: 200 }));
    const message = async (error: string) =>
      (await runSlackBotLiveChecks({ token: BOT_TOKEN, includeSandboxSend: false, fetcher: failure(error) })).probe
        .steps[0]?.message;

    expect(await message("invalid_auth")).toBe(`Slack rejected the stored bot token. ${advice}`);
    expect(await message("token_revoked")).toBe(`Slack rejected the stored bot token. ${advice}`);
    expect(await message("missing_scope")).toBe(`The Slack app is missing a required permission scope. ${advice}`);
    expect(await message("invalid_auth")).not.toContain("Reconnect Slack");
  });

  it("finishes on the test message that already arrived", () => {
    expect(JSON.stringify(step("finish"))).not.toMatch(/sandbox message/iu);
    expect(step("finish").successCriteria).toEqual([
      "A bot token or an incoming webhook URL is set.",
      "A channel target is set when you use a bot token.",
      "The test message arrived in Slack.",
    ]);
  });
});

describe("Slack setup guide: a webhook needs no channel target (item 8)", () => {
  it("does not ask a webhook-only setup for a channel", () => {
    expect(guide().validate(draftOf({ webhookUrl: WEBHOOK_URL }))).toEqual([]);
  });

  it("still asks a bot-token setup for a channel", () => {
    expect(guide().validate(draftOf({ botToken: BOT_TOKEN }))).toEqual([
      expect.objectContaining({ key: "targets_required", fieldKey: "targets" }),
    ]);
    expect(guide().validate(draftOf({ botToken: BOT_TOKEN, targets: [{ channel: "#ops", default: true }] }))).toEqual(
      [],
    );
  });

  it("still asks for a channel when a webhook comes with a bot token", () => {
    expect(guide().validate(draftOf({ botToken: BOT_TOKEN, webhookUrl: WEBHOOK_URL }))).toEqual([
      expect.objectContaining({ key: "targets_required", fieldKey: "targets" }),
    ]);
  });

  it("still asks an empty draft for both a way to connect and a channel", () => {
    expect(
      guide()
        .validate(draftOf({}))
        .map((issue) => issue.key),
    ).toEqual(expect.arrayContaining(["slack_auth_missing", "targets_required"]));
  });
});

/** The Gateway's own structural checks for a Slack connection, as the setup test reads them. */
function slackChecks(config: Record<string, unknown>) {
  const port: IntegrationDiagnosticsPort = {
    config: {
      toolPolicy: { tools: { profile: "default" }, sandbox: { networkAllowlist: [] } },
    } as unknown as IntegrationDiagnosticsPort["config"],
    fetchWithDiagnosticsTimeout: vi.fn(async () => new Response("{}")),
    getDiscordRuntimeStatus: vi.fn(() => undefined),
    // The webhook host is allowed here, so only the target check can hold a webhook-only setup back.
    isConnectionUrlAllowlisted: vi.fn(() => true),
    readConnectionConfigValue: vi.fn((values: Record<string, unknown>, key: string) => {
      const value = values[key];
      return typeof value === "string" ? value : undefined;
    }),
    resolveConnectionSecret: vi.fn((values: Record<string, unknown>, key: string) => {
      const value = values[key];
      return typeof value === "string" ? value : undefined;
    }),
  };
  return buildIntegrationConnectionChecks(port, { ...connectionOf(config), key: "slack" });
}

/** What the setup test does with those checks: every one that is not a pass becomes an issue, then eligibility reads them. */
function eligibilityOf(config: Record<string, unknown>) {
  const issues: ChannelSetupIssue[] = slackChecks(config)
    .filter((check) => check.status !== "pass")
    .map((check) => ({
      key: check.key,
      level: check.status === "fail" ? ("error" as const) : ("warn" as const),
      message: check.message,
    }));
  const result: ChannelSetupTestResult = {
    draftId: "22222222-2222-2222-2222-222222222222",
    draftRevision: 1,
    status: issues.some((issue) => issue.level === "error") ? "error" : issues.length > 0 ? "warn" : "ok",
    levels: [],
    issues,
    checkedAt: "2026-03-29T00:00:00.000Z",
  };
  return { issues, eligibility: evaluateChannelSetupEligibility(result, connectionOf(config)) };
}

const MISSING_TARGET = "Default Slack channel is missing.";

describe("Slack setup guide: a webhook-only setup can finish (item 8, fix round 1)", () => {
  it("does not stop a webhook-only person on the channel targets step", () => {
    // The wizard blocks Continue on a required field that is shown and empty.
    expect(field("targets").required).toBe(false);
  });

  it("still sends a bot-token setup with no channel to the targets field", () => {
    const [issue] = guide().validate(draftOf({ botToken: BOT_TOKEN }));

    expect(issue).toMatchObject({ key: "targets_required", fieldKey: "targets", level: "error" });
  });

  it("does not tell a person who has not connected yet to add a channel target", () => {
    const [issue] = guide().validate(draftOf({}));

    expect(issue?.key).toBe("slack_auth_missing");
    expect((issue?.nextSteps ?? []).join(" ")).not.toMatch(/target|channel/iu);
    expect((issue?.nextSteps ?? []).join(" ")).toContain("webhook");
  });

  it("says a webhook-only setup needs no channel, in the targets field's own words", () => {
    expect(field("targets").explanation).toContain("Leave this empty for a webhook-only setup");
  });

  it("raises no channel check for a webhook-only connection", () => {
    const checks = slackChecks({ webhookUrl: WEBHOOK_URL });

    expect(checks.find((check) => check.key === "target")).toBeUndefined();
    expect(checks.find((check) => check.key === "auth")).toMatchObject({ status: "pass" });
  });

  it("lets a webhook-only test finalize without a channel", () => {
    const { issues, eligibility } = eligibilityOf({ webhookUrl: WEBHOOK_URL });

    expect(issues.map((issue) => issue.message)).not.toContain(MISSING_TARGET);
    expect(eligibility.blockingReasons).not.toContain(MISSING_TARGET);
  });

  it("still warns, and still blocks, when a bot-token connection has no default channel", () => {
    const checks = slackChecks({ botToken: BOT_TOKEN });
    const { eligibility } = eligibilityOf({ botToken: BOT_TOKEN });

    expect(checks.find((check) => check.key === "target")).toMatchObject({ status: "warn", message: MISSING_TARGET });
    expect(eligibility.blockingReasons).toContain(MISSING_TARGET);
  });

  it("still warns when a webhook comes with a bot token and no default channel", () => {
    const checks = slackChecks({ botToken: BOT_TOKEN, webhookUrl: WEBHOOK_URL });

    expect(checks.find((check) => check.key === "target")).toMatchObject({ status: "warn", message: MISSING_TARGET });
  });

  it("is satisfied by a default channel on a bot-token connection", () => {
    const checks = slackChecks({ botToken: BOT_TOKEN, defaultChannel: "#ops" });

    expect(checks.find((check) => check.key === "target")).toMatchObject({ status: "pass" });
  });
});

describe("Slack setup guide: when the test fails (A13)", () => {
  it("lists the failures a Slack setup really hits, on the test step", () => {
    const ids = (step("test").troubleshooting ?? []).map((item) => item.id);

    expect(ids).toEqual(
      expect.arrayContaining([
        "token-credential_rejected",
        "token-permission_mismatch",
        "not-in-channel",
        "channel-not-found",
        "missing-scope",
      ]),
    );
  });

  it("tells a person to invite the app or add the scope that lets it post anywhere", () => {
    const notInChannel = (step("test").troubleshooting ?? []).find((item) => item.id === "not-in-channel");

    expect(notInChannel?.body).toContain("/invite @your-app");
    expect(notInChannel?.body).toContain("chat:write.public");
  });
});
