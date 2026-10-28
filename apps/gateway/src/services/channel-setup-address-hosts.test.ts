import { describe, expect, it, vi } from "vitest";
import type { IntegrationConnection } from "@goatcitadel/contracts";
import { recordAddressHosts, withSavedAddressHosts } from "./channel-setup-address-hosts.js";
import { requireChannelSetupDefinition } from "./channel-setup-definitions.js";
import { projectChannelSetupDraftForPublicResponse } from "./channel-setup-public-projection.js";
import {
  createChannelSetupDraft,
  finalizeChannelSetupDraft,
  reconcileChannelSetupDraftSecretCustody,
  setChannelSetupDraftSecrets,
} from "./channel-setup-service.js";
import { createChannelSetupTestHost } from "./channel-setup-service.test-support.js";

const WORKFLOW_HOST = "default0123456789abcdef.00.environment.api.powerplatform.com";
const WORKFLOW_PATH =
  "/powerautomate/automations/direct/workflows/0123456789abcdef0123456789abcdef/triggers/manual/paths/invoke";
// Synthetic signature, never a real Microsoft callback credential.
const SIGNATURE = "synthetic-workflow-signature";
const WORKFLOW_URL = `https://${WORKFLOW_HOST}:443${WORKFLOW_PATH}?api-version=1&sig=${SIGNATURE}`;
const SLACK_URL = "https://hook-user:hook-pass@hooks.slack.com/services/T000/B000/synthetic-slack-secret?x=1#frag";
/** Pieces of the pasted addresses that are secret: none may be stored, logged or projected. */
const SECRET_PARTS = [
  WORKFLOW_PATH,
  SIGNATURE,
  "sig=",
  "hook-user",
  "hook-pass",
  "/services/",
  "synthetic-slack-secret",
  "frag",
];

function expectNoSecretParts(value: unknown) {
  const text = JSON.stringify(value);
  for (const part of SECRET_PARTS) expect(text).not.toContain(part);
}

async function pasted(catalogId: string, values: Record<string, string>) {
  const host = createChannelSetupTestHost();
  const created = await createChannelSetupDraft(host, { catalogId, lifecycleMode: "create" });
  const saved = await setChannelSetupDraftSecrets(host, created.draftId, {
    expectedRevision: created.revision,
    values,
  });
  return { host, saved };
}

describe("recording the host of a pasted secret address", () => {
  it("records the Teams Workflows host when the webhook address is saved, without its port, path or query", async () => {
    const { host, saved } = await pasted("channel.teams", { webhookUrl: WORKFLOW_URL });

    expect(saved.secretState.webhookUrl).toMatchObject({ configured: true, source: "operator", host: WORKFLOW_HOST });
    expectNoSecretParts(saved);
    expectNoSecretParts(host.storage.channelSetupDrafts.get(saved.draftId));
  });

  it("records only the host of a Slack webhook address that carries credentials, a query and a fragment", async () => {
    const { saved } = await pasted("channel.slack", { webhookUrl: SLACK_URL });

    expect(saved.secretState.webhookUrl?.host).toBe("hooks.slack.com");
    expectNoSecretParts(saved);
  });

  it.each([
    ["a wildcard", "https://*.example.com/hook"],
    ["another scheme", "ftp://files.example.com/hook"],
    ["an address with no scheme", "hooks.slack.com/services/T0/B0/x"],
  ])("records no host for %s", async (_case, webhookUrl) => {
    const { saved } = await pasted("channel.discord", { webhookUrl });

    expect(saved.secretState.webhookUrl).toMatchObject({ configured: true });
    expect(saved.secretState.webhookUrl).not.toHaveProperty("host");
  });

  it("records no host for a secret that is not an address field", async () => {
    const { saved } = await pasted("channel.slack", { botToken: "https://looks-like.example.com/xoxb" });

    expect(saved.secretState.botToken).not.toHaveProperty("host");
  });

  it("drops the host of an earlier address when a new one names none", async () => {
    const { host, saved } = await pasted("channel.slack", { webhookUrl: SLACK_URL });
    const replaced = await setChannelSetupDraftSecrets(host, saved.draftId, {
      expectedRevision: saved.revision,
      values: { webhookUrl: "not an address" },
    });

    expect(replaced.secretState.webhookUrl).not.toHaveProperty("host");
  });

  it("logs neither the address nor its host", async () => {
    const { host, saved } = await pasted("channel.teams", { webhookUrl: WORKFLOW_URL });
    await finalizeChannelSetupDraft(host, saved.draftId, saved.revision);

    expect(host.diagnostics).toHaveBeenCalled();
    expectNoSecretParts(host.diagnostics.mock.calls);
    expect(JSON.stringify(host.diagnostics.mock.calls)).not.toContain(WORKFLOW_HOST);
  });

  it("shows the recorded host in the public draft, and never the address or its locator", async () => {
    const { saved } = await pasted("channel.teams", { webhookUrl: WORKFLOW_URL });

    const projected = projectChannelSetupDraftForPublicResponse(saved);

    expect(projected.draft.webhookUrl).toBe("[REDACTED]");
    expect(projected.secretState.webhookUrl).toEqual({
      configured: true,
      custody: "temporary",
      source: "operator",
      host: WORKFLOW_HOST,
    });
    expectNoSecretParts(projected);
  });

  it("leaves out of the public draft a recorded host that is not a host", () => {
    const draft = {
      ...baseDraft(),
      secretState: { webhookUrl: { configured: true, custody: "temporary" as const, host: "*" } },
      hydration: { status: "clean" as const, fieldState: {}, warnings: [], addressHosts: { webhookUrl: "a/b" } },
    };

    const projected = projectChannelSetupDraftForPublicResponse(draft);

    expect(projected.secretState.webhookUrl).not.toHaveProperty("host");
    expect(projected.hydration).not.toHaveProperty("addressHosts");
  });
});

describe("the host a connection records for its saved address", () => {
  it("records the host in the connection when a draft is finalized, and keeps the address in custody", async () => {
    const { host, saved } = await pasted("channel.teams", { webhookUrl: WORKFLOW_URL });

    const { connection } = await finalizeChannelSetupDraft(host, saved.draftId, saved.revision);

    expect(connection.config.webhookUrlHost).toBe(WORKFLOW_HOST);
    expect(connection.config.webhookUrl).toEqual(expect.stringMatching(/^keychain:goatcitadel:channel-connection:/));
    expectNoSecretParts(connection);
  });

  it("gives an edit draft the recorded host without reading the saved address from the keychain", async () => {
    const { host, saved } = await pasted("channel.teams", { webhookUrl: WORKFLOW_URL });
    const { connection } = await finalizeChannelSetupDraft(host, saved.draftId, saved.revision);
    const resolve = vi.spyOn(host.channelSecrets!, "resolve");

    const edit = await createChannelSetupDraft(host, {
      catalogId: "channel.teams",
      connectionId: connection.connectionId,
      lifecycleMode: "edit",
    });

    expect(resolve).not.toHaveBeenCalled();
    expect(edit.hydration?.addressHosts).toEqual({ webhookUrl: WORKFLOW_HOST });
    expect(edit.hydration).not.toHaveProperty("rawLegacyConfig");
    expect(projectChannelSetupDraftForPublicResponse(edit).hydration?.addressHosts).toEqual({
      webhookUrl: WORKFLOW_HOST,
    });
  });

  it("leaves the host unknown for a connection saved before hosts were recorded", async () => {
    const host = createChannelSetupTestHost();
    const saved = host.createConnectionMock({
      catalogId: "channel.teams",
      label: "Teams",
      enabled: true,
      status: "connected",
      config: { webhookUrl: "keychain:goatcitadel:channel-connection:legacy", cardTitle: "Ops" },
    }) as IntegrationConnection;

    const edit = await createChannelSetupDraft(host, {
      catalogId: "channel.teams",
      connectionId: saved.connectionId,
      lifecycleMode: "edit",
    });

    expect(edit.hydration?.fieldState.webhookUrl).toBe("configured");
    expect(edit.hydration).not.toHaveProperty("addressHosts");
  });

  it("updates the recorded host when an edit replaces the address", async () => {
    const { host, saved } = await pasted("channel.teams", { webhookUrl: WORKFLOW_URL });
    const first = await finalizeChannelSetupDraft(host, saved.draftId, saved.revision);
    const edit = await createChannelSetupDraft(host, {
      catalogId: "channel.teams",
      connectionId: first.connection.connectionId,
      lifecycleMode: "edit",
    });
    const replaced = await setChannelSetupDraftSecrets(host, edit.draftId, {
      expectedRevision: edit.revision,
      values: { webhookUrl: WORKFLOW_URL.replace(WORKFLOW_HOST, "prod-1.environment.api.powerplatform.com") },
    });

    const { connection } = await finalizeChannelSetupDraft(host, replaced.draftId, replaced.revision);

    expect(connection.config.webhookUrlHost).toBe("prod-1.environment.api.powerplatform.com");
  });

  it("keeps the recorded host through the startup credential repair", async () => {
    const host = createChannelSetupTestHost();
    const draft = host.storage.channelSetupDrafts.create({
      catalogId: "channel.teams",
      lifecycleMode: "edit",
      hydration: {
        status: "opaque-secret",
        fieldState: { webhookUrl: "configured" },
        warnings: [],
        rawLegacyConfig: { cardTitle: "Ops" },
        addressHosts: { webhookUrl: WORKFLOW_HOST },
      },
    });

    await reconcileChannelSetupDraftSecretCustody(host);

    const repaired = host.storage.channelSetupDrafts.get(draft.draftId);
    expect(repaired.hydration).not.toHaveProperty("rawLegacyConfig");
    expect(repaired.hydration?.addressHosts).toEqual({ webhookUrl: WORKFLOW_HOST });
  });
});

describe("recordAddressHosts", () => {
  const teams = requireChannelSetupDefinition("channel.teams").definition;
  const ntfy = requireChannelSetupDefinition("channel.ntfy").definition;

  it("sets, removes or keeps each secret address field's host, and returns a new config", () => {
    const config = { webhookUrl: "keychain:ref", webhookUrlHost: "old.example.com", cardTitle: "Ops" };
    const configured = { configured: true, custody: "temporary" as const };

    expect(recordAddressHosts(teams, { webhookUrl: { ...configured, host: "new.example.com" } }, config)).toEqual({
      ...config,
      webhookUrlHost: "new.example.com",
    });
    expect(recordAddressHosts(teams, { webhookUrl: configured }, config)).not.toHaveProperty("webhookUrlHost");
    expect(recordAddressHosts(teams, {}, config)).toEqual(config);
    expect(recordAddressHosts(teams, { webhookUrl: { ...configured, host: "*" } }, config)).not.toHaveProperty(
      "webhookUrlHost",
    );
    expect(config.webhookUrlHost).toBe("old.example.com");
  });

  it("records nothing for an address field that is not secret", () => {
    const config = { baseUrl: "https://ntfy.example.com" };

    expect(
      recordAddressHosts(ntfy, { baseUrl: { configured: true, custody: "temporary", host: "x.example.com" } }, config),
    ).toEqual(config);
  });
});

describe("withSavedAddressHosts", () => {
  const teams = withSavedAddressHosts(requireChannelSetupDefinition("channel.teams"));
  const connectionOf = (config: Record<string, unknown>): IntegrationConnection => ({
    connectionId: "teams-connection",
    revision: "a".repeat(64),
    catalogId: "channel.teams",
    kind: "channel",
    key: "teams",
    label: "Teams",
    enabled: true,
    status: "connected",
    config,
    createdAt: "2026-10-28T00:00:00.000Z",
    updatedAt: "2026-10-28T00:00:00.000Z",
  });

  it.each([
    ["no saved address", { webhookUrlHost: WORKFLOW_HOST }],
    [
      "an address named by an environment variable",
      { webhookUrlEnv: "TEAMS_WEBHOOK_URL", webhookUrlHost: WORKFLOW_HOST },
    ],
    ["a wildcard", { webhookUrl: "keychain:ref", webhookUrlHost: "*" }],
    ["a path", { webhookUrl: "keychain:ref", webhookUrlHost: "evil.example.com/x" }],
    ["the redaction marker", { webhookUrl: "keychain:ref", webhookUrlHost: "[REDACTED]" }],
  ])("brings back no host for %s", (_case, config) => {
    expect(teams.hydrate(connectionOf(config)).hydration).not.toHaveProperty("addressHosts");
  });

  it("brings back the recorded host of a saved address", () => {
    expect(
      teams.hydrate(connectionOf({ webhookUrl: "keychain:ref", webhookUrlHost: WORKFLOW_HOST })).hydration.addressHosts,
    ).toEqual({ webhookUrl: WORKFLOW_HOST });
  });
});

function baseDraft() {
  return {
    draftId: "draft-x",
    revision: 1,
    catalogId: "channel.teams",
    lifecycleMode: "create" as const,
    enabled: true,
    draft: {},
    secretState: {},
    contentVersion: "c",
    adapterVersion: "a",
    validationVersion: "v",
    testVersion: "t",
    createdAt: "2026-10-28T00:00:00.000Z",
    updatedAt: "2026-10-28T00:00:00.000Z",
  };
}
