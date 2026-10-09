import { describe, expect, it, vi } from "vitest";
import type { ChannelSetupDraft, IntegrationConnection } from "@goatcitadel/contracts";
import { requireChannelSetupDefinition } from "./channel-setup-definitions.js";
import { runWebhookDestinationLiveChecks } from "./channel-webhook-probes.js";

const WORKFLOW_ID = "0123456789abcdef0123456789abcdef";
const WORKFLOW_HOST = "default0123456789abcdef.00.environment.api.powerplatform.com";
const WORKFLOW_PATH = "/powerautomate/automations/direct/workflows/" + WORKFLOW_ID + "/triggers/manual/paths/invoke";
// Synthetic signature, never a real Microsoft callback credential.
const WORKFLOW_URL = "https://" + WORKFLOW_HOST + WORKFLOW_PATH + "?api-version=1&sig=synthetic-workflow-signature";
const definition = requireChannelSetupDefinition("channel.teams");
function draft(values: Record<string, unknown>, lifecycleMode: ChannelSetupDraft["lifecycleMode"] = "create"): ChannelSetupDraft {
  return { draftId: "teams-draft", revision: 1, catalogId: "channel.teams", lifecycleMode, enabled: true, draft: values, secretState: {}, contentVersion: definition.definition.wizard.contentVersion, adapterVersion: definition.definition.adapter.adapterVersion, validationVersion: definition.definition.validation.validationVersion, testVersion: definition.definition.testing.testVersion, createdAt: "2026-10-09T00:00:00.000Z", updatedAt: "2026-10-09T00:00:00.000Z" };
}
function connection(config: Record<string, unknown>): IntegrationConnection {
  return { connectionId: "teams-connection", revision: "generation-one", catalogId: "channel.teams", kind: "channel", key: "teams", label: "Teams", enabled: true, status: "connected", config, createdAt: "2026-10-09T00:00:00.000Z", updatedAt: "2026-10-09T00:00:00.000Z" };
}

describe("Teams Workflows guided setup", () => {
  it.each([
    WORKFLOW_URL,
    WORKFLOW_URL.replace("/direct/workflows/", "/direct/cu/20/workflows/"),
    WORKFLOW_URL.replace("/invoke?", "/invoke/?"),
    WORKFLOW_URL.replace(WORKFLOW_HOST, "defaultenvironment.environment.api.powerplatform.com:443"),
  ])("recognizes signed current Power Automate trigger shapes without claiming delivery: %s", (webhookUrl) => {
    expect(definition.validate(draft({ webhookUrl }))).toEqual([]);
    expect(definition.definition.testing.levels).toContain("live-send");
    expect(definition.definition.testing.levels).toContain("manual-confirm");
  });

  it.each([
    WORKFLOW_URL.replace("https:", "http:"),
    WORKFLOW_URL.replace(WORKFLOW_HOST, WORKFLOW_HOST + ".attacker.test"),
    WORKFLOW_URL.replace(WORKFLOW_HOST, "attacker-environment.api.powerplatform.com"),
    WORKFLOW_URL.replace(WORKFLOW_HOST, "environment.api.powerplatform.com"),
    WORKFLOW_URL.replace(WORKFLOW_HOST, "user:password@" + WORKFLOW_HOST),
    WORKFLOW_URL.replace(WORKFLOW_HOST, WORKFLOW_HOST + ":444"),
    WORKFLOW_URL + "#hidden-credential",
    WORKFLOW_URL.replace(WORKFLOW_PATH, "/powerautomate/automations/direct/workflows/" + WORKFLOW_ID + "/triggers/manual/paths/invoke/extra"),
    WORKFLOW_URL.replace("/direct/workflows/", "/direct/cu/not-a-number/workflows/"),
    WORKFLOW_URL.replace("sig=synthetic-workflow-signature", "sig="),
    WORKFLOW_URL.replace("&sig=synthetic-workflow-signature", ""),
    WORKFLOW_URL + "&sig=another-signature",
    "https://teams.microsoft.com/l/channel/channel-id",
    "Bearer synthetic-entra-token",
    "https://prod-12.westus.logic.azure.com.attacker.test/workflows/" + WORKFLOW_ID + "/triggers/manual/paths/invoke?sig=synthetic",
    "https://prod-12.westus.logic.azure.com/not-a-workflow?sig=synthetic",
  ])("rejects unsafe, spoofed or unsupported credential input: %s", (webhookUrl) => {
    const issues = definition.validate(draft({ webhookUrl }));
    expect(issues).toEqual([expect.objectContaining({ fieldKey: "webhookUrl", level: "error", failureCategory: "malformed_value" })]);
    expect(JSON.stringify(issues)).not.toContain(webhookUrl);
    expect(JSON.stringify(issues)).not.toContain("synthetic-workflow-signature");
    expect(JSON.stringify(issues)).not.toContain("synthetic-entra-token");
  });

  it.each(["https://outlook.office.com/webhook/old-connector", "https://tenant.webhook.office.com/webhookb2/old-connector"])("blocks retired Office connector creation and retains migration visibility on edits: %s", (webhookUrl) => {
    expect(definition.validate(draft({ webhookUrl }))).toEqual([expect.objectContaining({ key: "teams_retired_connector", level: "error", failureCategory: "deprecated_path" })]);
    const edit = draft({ webhookUrl }, "edit");
    expect(definition.validate(edit)).toEqual([expect.objectContaining({ key: "teams_retired_connector", level: "warn", failureCategory: "deprecated_path" })]);
    expect(definition.normalize(edit)).toMatchObject({ webhookUrl });
  });

  it("checks a saved opaque legacy connector and preserves env-backed credentials without re-entry", () => {
    const legacyUrl = "https://outlook.office.com/webhook/old-connector";
    const inherited = definition.hydrate(connection({ webhookUrl: legacyUrl, cardTitle: "Ops" }));
    const inheritedDraft = { ...draft(inherited.draft, "edit"), hydration: inherited.hydration };
    expect(inherited.draft).not.toHaveProperty("webhookUrl");
    expect(definition.validate(inheritedDraft)).toEqual([expect.objectContaining({ key: "teams_retired_connector", level: "warn" })]);
    expect(definition.normalize(inheritedDraft)).toMatchObject({ webhookUrl: legacyUrl, cardTitle: "Ops" });
    const env = definition.hydrate(connection({ webhookUrlEnv: "TEAMS_WORKFLOW_URL", cardTitle: "Ops" }));
    const envDraft = { ...draft(env.draft, "edit"), hydration: env.hydration };
    expect(definition.validate(envDraft)).toEqual([]);
    expect(definition.normalize(envDraft)).toMatchObject({ webhookUrlEnv: "TEAMS_WORKFLOW_URL", cardTitle: "Ops" });
    expect(definition.normalize(envDraft)).not.toHaveProperty("webhookUrl");
  });

  it("retains an exact legacy workflow shape with migration guidance and live proof requirements", () => {
    const webhookUrl = "https://prod-12.westus.logic.azure.com/workflows/" + WORKFLOW_ID + "/triggers/manual/paths/invoke?api-version=2016-06-01&sig=synthetic";
    expect(definition.validate(draft({ webhookUrl }))).toEqual([expect.objectContaining({ key: "teams_workflow_url_legacy", level: "info", failureCategory: "deprecated_path" })]);
    expect(definition.normalize(draft({ webhookUrl }))).toMatchObject({ webhookUrl });
  });

  it("explains supported trigger authentication, ownership, retirement and destination confirmation", () => {
    const wizard = JSON.stringify(definition.definition.wizard);
    expect(wizard).toContain("Anyone");
    expect(wizard).toContain("co-owner");
    expect(wizard).toContain("Microsoft Entra");
    expect(wizard).toContain("retired");
    expect(wizard).toContain("run history");
    expect(definition.definition.volatility.preferredPathLabel).toBe("Workflows webhook (Anyone)");
    expect(definition.definition.validation.validationVersion).toBe("2026.10.teams.workflows.v2");
  });

  it("posts the existing Adaptive Card envelope without a bearer header and distinguishes HTTP acceptance from visible receipt", async () => {
    const fetcher = vi.fn(async (_url: string, _init?: RequestInit) => new Response("", { status: 202 }));
    const result = await runWebhookDestinationLiveChecks({ channelKey: "teams", webhookUrl: WORKFLOW_URL, includeSandboxSend: true, fetcher });
    const [url, init] = fetcher.mock.calls[0]!;
    expect(url).toBe(WORKFLOW_URL);
    expect(new Headers(init?.headers).get("authorization")).toBeNull();
    const payload = JSON.parse(String(init?.body));
    expect(payload).toMatchObject({ type: "message", attachments: [{ contentType: "application/vnd.microsoft.card.adaptive", content: { type: "AdaptiveCard" } }] });
    expect(result.probe.steps[0]).toMatchObject({ status: "pass" });
    expect(result.probe.steps[0]?.message).toContain("Confirm it arrived");
  });
});
