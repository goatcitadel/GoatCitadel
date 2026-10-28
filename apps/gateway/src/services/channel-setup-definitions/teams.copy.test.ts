import { describe, expect, it, vi } from "vitest";
import type {
  ChannelSetupDraft,
  ChannelSetupFieldDefinition,
  ChannelSetupIssue,
  ChannelSetupStepDefinition,
  ChannelSetupTestResult,
  IntegrationConnection,
} from "@goatcitadel/contracts";
import { runWebhookDestinationLiveChecks } from "../channel-webhook-probes.js";
import { requireChannelSetupDefinition } from "../channel-setup-definitions.js";
import { evaluateChannelSetupEligibility } from "../channel-setup-eligibility.js";
import { INTEGRATION_CATALOG, getIntegrationFormSchema } from "../integration-catalog.js";
import {
  buildIntegrationConnectionChecks,
  type IntegrationDiagnosticsPort,
} from "../integration-diagnostics-service.js";

function guide() {
  return requireChannelSetupDefinition("channel.teams");
}

function step(id: string): ChannelSetupStepDefinition {
  const found = guide().definition.wizard.steps.find((candidate) => candidate.id === id);
  if (!found) throw new Error(`Teams guide has no step ${id}`);
  return found;
}

function field(key: string): ChannelSetupFieldDefinition {
  const found = guide()
    .definition.wizard.steps.flatMap((candidate) => candidate.fields ?? [])
    .find((candidate) => candidate.key === key);
  if (!found) throw new Error(`Teams guide has no field ${key}`);
  return found;
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
    catalogId: "channel.teams",
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
    catalogId: "channel.teams",
    kind: "channel",
    key: "teams",
    label: "Teams",
    revision: "1",
    enabled: true,
    status: "connected",
    config,
    createdAt: "2026-03-29T00:00:00.000Z",
    updatedAt: "2026-03-29T00:00:00.000Z",
  };
}

// Synthetic signature, never a real Microsoft callback credential.
const WORKFLOW_URL =
  "https://default0123456789abcdef.00.environment.api.powerplatform.com/powerautomate/automations/direct/workflows/0123456789abcdef0123456789abcdef/triggers/manual/paths/invoke?api-version=1&sig=synthetic-workflow-signature";

describe("Teams setup copy", () => {
  it("uses no words the operator copy rules ban anywhere in the guide", () => {
    const text = JSON.stringify(guide().definition.wizard);

    expect(text).not.toMatch(/posture|provenance|ingress|egress|sandbox message|activation plan/iu);
  });

  it("claims no public web address", () => {
    expect(JSON.stringify(guide().definition.wizard)).not.toMatch(/https:\/\/<your public address>/u);
  });
});

describe("Teams setup guide: what it says up front (item 4)", () => {
  it("opens with the intro, prerequisites and first message from the audit", () => {
    const wizard = guide().definition.wizard;

    expect(wizard.introSummary).toBe(
      "Post cards to a Microsoft Teams channel through a Workflows webhook. Sends only: Teams can't message GoatCitadel. No public web address is needed.",
    );
    expect(wizard.prerequisites).toEqual([
      "A Teams Workflows webhook whose trigger allows Anyone. Tenant-only triggers don't work.",
      "A co-owner on the workflow is recommended.",
      "Old Office 365 connector URLs stopped working in May 2026; make a new Workflows webhook.",
    ]);
    expect(paragraphs("first-message")).toEqual([
      "Check the test card appeared in the channel. If it didn't, open the workflow's run history in Teams.",
    ]);
  });

  it("is a send-only guide: no sender step and no destinations step", () => {
    const ids = guide().definition.wizard.steps.map((candidate) => candidate.id);

    expect(ids).not.toContain("sender-access");
    expect(ids).not.toContain("collect-values-destinations");
    expect(guide().definition.wizard.steps.map((candidate) => candidate.title)).not.toContain(
      "Choose destinations and access",
    );
  });
});

describe("Teams setup guide: creating the workflow (items 1 and 2)", () => {
  it("does not ask a person to tick a box for an owner and co-owner they may not have", () => {
    const create = step("create-webhook");
    const labels = (create.checklist ?? []).map((item) => item.label);

    expect((create.checklist ?? []).map((item) => item.id)).toEqual(["channel", "workflow", "copied"]);
    expect(labels).not.toContain("Confirm an owner and co-owner");
    expect(JSON.stringify(create.checklist)).not.toMatch(/co-owner/iu);
  });

  it("keeps the co-owner as a recommendation in the step text", () => {
    expect(paragraphs("create-webhook")).toContain(
      "Keep the Teams action connection signed in. Workflows belong to users and can stop when their owner or connection becomes unavailable. Adding a co-owner is recommended so the workflow keeps running if the owner leaves.",
    );
  });

  it("gives the easiest way first and still says to set the trigger to Anyone", () => {
    expect(paragraphs("create-webhook")[0]).toBe(
      "Easiest: in the channel, open More options (⋯) › Workflows › 'Send webhook alerts to a channel'. Then open its trigger and set Who can trigger the flow? to Anyone.",
    );
    expect(paragraphs("create-webhook")).toContain(
      "Or build it yourself: create a flow with When a Teams webhook request is received and an action that posts the received Adaptive Card to that channel.",
    );
    expect(paragraphs("create-webhook")).toContain(
      "Choose Anyone for trigger authentication. GoatCitadel uses the signed webhook URL as its credential and sends no Microsoft Entra token, so tenant-only and specific-user triggers don't work.",
    );
  });

  it("hides the two setup-only steps when a saved channel is changed", () => {
    expect(
      guide()
        .definition.wizard.steps.filter((candidate) => candidate.createOnly)
        .map((candidate) => candidate.id),
    ).toEqual(["overview", "create-webhook"]);
  });
});

describe("Teams setup guide: the webhook field and the test (items 3 and A15)", () => {
  it("asks for the Workflows webhook URL by name when none is given, and jumps to the field", () => {
    const [issue] = guide().validate(draftOf({}));

    expect(issue).toMatchObject({
      key: "webhookUrl_required",
      fieldKey: "webhookUrl",
      level: "error",
      message: "Paste the Workflows webhook URL.",
    });
    expect(field("webhookUrl").label).toBe("Webhook URL");
  });

  it("keeps the webhook URL a real field the host list can read", () => {
    expect(guide().definition.wizard.hostFields).toEqual(["webhookUrl"]);
  });

  it("tells a person to check the card and the run history, without 'acknowledging' a receipt", () => {
    expect(paragraphs("test")).toContain(
      "A successful HTTP response proves the workflow accepted the request. Check the card arrived in the channel. If it didn't, open the workflow's run history.",
    );
    expect(JSON.stringify(guide().definition.wizard)).not.toMatch(/acknowledging the receipt|confirmed receipt/iu);
  });

  it("finishes on the test card that already arrived", () => {
    expect(paragraphs("finish")).toEqual([
      "Finish saves the connection. The test already posted a card; check that it arrived in the channel.",
    ]);
    expect(step("finish").successCriteria).toEqual([
      "A Workflows webhook URL whose trigger allows Anyone is set.",
      "The test card arrived in the Teams channel.",
    ]);
  });
});

describe("Teams setup guide: when the test fails (A13)", () => {
  it("lists the failures a Teams setup really hits, on the test step", () => {
    const ids = (step("test").troubleshooting ?? []).map((item) => item.id);

    expect(ids).toEqual(
      expect.arrayContaining(["trigger-not-anyone", "card-missing", "retired-connector", "host-not-allowed"]),
    );
  });

  it("points at the Anyone setting, the run history and the allowed-hosts button", () => {
    const items = step("test").troubleshooting ?? [];
    const byId = (id: string) => items.find((item) => item.id === id)?.body ?? "";

    expect(byId("trigger-not-anyone")).toContain("Who can trigger the flow?");
    expect(byId("trigger-not-anyone")).toContain("Anyone");
    expect(byId("card-missing")).toContain("run history");
    expect(byId("retired-connector")).toContain("make a new Workflows webhook");
    expect(byId("host-not-allowed")).toContain("Allow these hosts");
  });
});

describe("Teams setup guide: the catalog text matches the guide (item 4)", () => {
  it("says Teams sends cards through a Workflows webhook and cannot receive", () => {
    const entry = INTEGRATION_CATALOG.find((candidate) => candidate.catalogId === "channel.teams");

    expect(entry?.description).toBe(
      "Send Adaptive Card notifications to a Teams channel through a Workflows webhook. Sends only.",
    );
    expect(guide().definition.catalog.description).toBe(entry?.description);
  });

  it("does not advertise threads", () => {
    const entry = INTEGRATION_CATALOG.find((candidate) => candidate.catalogId === "channel.teams");

    expect(entry?.capabilities).not.toContain("threads");
    expect(entry?.capabilities).toEqual(expect.arrayContaining(["chat", "attachments"]));
  });

  it("shows a Workflows address, not a retired connector address, in the manual form", () => {
    const placeholder = getIntegrationFormSchema("channel.teams")?.fields.find(
      (candidate) => candidate.key === "webhookUrl",
    )?.placeholder;

    expect(placeholder).toBe("https://<environment>.environment.api.powerplatform.com/...");
  });
});

/** The Gateway's own structural checks for a Teams connection, as the setup test reads them. */
function teamsChecks(config: Record<string, unknown>, hostAllowed = true) {
  const port: IntegrationDiagnosticsPort = {
    config: {
      toolPolicy: { tools: { profile: "default" }, sandbox: { networkAllowlist: [] } },
    } as unknown as IntegrationDiagnosticsPort["config"],
    fetchWithDiagnosticsTimeout: vi.fn(async () => new Response("{}")),
    getDiscordRuntimeStatus: vi.fn(() => undefined),
    isConnectionUrlAllowlisted: vi.fn(() => hostAllowed),
    readConnectionConfigValue: vi.fn((values: Record<string, unknown>, key: string) => {
      const value = values[key];
      return typeof value === "string" ? value : undefined;
    }),
    resolveConnectionSecret: vi.fn((values: Record<string, unknown>, key: string) => {
      const value = values[key];
      return typeof value === "string" ? value : undefined;
    }),
  };
  return buildIntegrationConnectionChecks(port, connectionOf(config));
}

describe("Teams Workflows webhook: the whole path can finish (end to end)", () => {
  it("passes validation, the structural checks and the live send, and is allowed to finalize", async () => {
    const config = { webhookUrl: WORKFLOW_URL, cardTitle: "GoatCitadel" };
    const validation = guide().validate(draftOf(config));
    const live = await runWebhookDestinationLiveChecks({
      channelKey: "teams",
      webhookUrl: WORKFLOW_URL,
      includeSandboxSend: true,
      cardTitle: "GoatCitadel",
      fetcher: vi.fn(async () => new Response("", { status: 202 })),
    });
    const issues: ChannelSetupIssue[] = [...teamsChecks(config), ...live.checks]
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
      probe: live.probe,
      checkedAt: "2026-03-29T00:00:00.000Z",
    };

    expect(validation).toEqual([]);
    expect(issues).toEqual([]);
    expect(evaluateChannelSetupEligibility(result, connectionOf(config))).toMatchObject({
      allowed: true,
      blockingReasons: [],
    });
  });

  it("holds finalize back only on the allowed-hosts check, which the test step offers to fix", () => {
    const checks = teamsChecks({ webhookUrl: WORKFLOW_URL }, false);

    expect(checks.filter((check) => check.status !== "pass").map((check) => check.key)).toEqual(["url"]);
  });

  it("asks only for the webhook URL: the step has one required way in and nothing else to tick", () => {
    expect(step("collect-values-identity").requiredAnyOf).toEqual([["webhookUrl", "webhookUrlEnv"]]);
    expect(
      (step("collect-values-identity").fields ?? []).filter((candidate) => candidate.required).map((c) => c.key),
    ).toEqual([]);
    expect(field("cardTitle").advanced).toBe(true);
  });
});
