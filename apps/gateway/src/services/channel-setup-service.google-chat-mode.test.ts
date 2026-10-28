import { describe, expect, it } from "vitest";
import type { IntegrationConnection } from "@goatcitadel/contracts";
import {
  createChannelSetupDraft,
  finalizeChannelSetupDraft,
  setChannelSetupDraftSecrets,
  updateChannelSetupDraft,
} from "./channel-setup-service.js";
import { createChannelSetupTestHost as createHost } from "./channel-setup-service.test-support.js";

/**
 * Finalizing an edited Google Chat connection saves one mode's keys. Switching between the Chat app and the incoming
 * webhook must not carry the other mode's saved keys, or their secret references, into the saved connection.
 */
const CATALOG_ID = "channel.google-chat";
const WEBHOOK_URL = "https://chat.googleapis.com/v1/spaces/AAAAxxxx/messages?key=synthetic-key&token=synthetic-token";
const SAVED_KEY_REF = "keychain:goatcitadel:channel-connection:connection-1:serviceAccountKey:0001";
const SAVED_WEBHOOK_REF = "keychain:goatcitadel:channel-connection:connection-1:webhookUrl:0001";
const KEYCHAIN_REF = /^keychain:goatcitadel:channel-connection:/;
const APP_KEYS = [
  "serviceAccountKeyEnv",
  "serviceAccountKey",
  "audienceType",
  "audience",
  "addOnProjectNumber",
  "defaultSpace",
] as const;
const WEBHOOK_KEYS = ["webhookUrl", "defaultThreadKey"] as const;

const SAVED_APP_WITH_ENV = {
  serviceAccountKeyEnv: "GOOGLE_CHAT_SA_KEY",
  audienceType: "project_number",
  audience: "123456789012",
  defaultSpace: "spaces/AAAAxxxx",
  inboundAccessMode: "allowlist",
  allowedSenders: ["users/1"],
};
const SAVED_APP_WITH_KEY = {
  serviceAccountKey: SAVED_KEY_REF,
  audienceType: "project_number",
  audience: "123456789012",
  defaultSpace: "spaces/AAAAxxxx",
  inboundAccessMode: "allowlist",
  allowedSenders: ["users/1"],
};
const SAVED_WEBHOOK = { webhookUrl: SAVED_WEBHOOK_REF, defaultThreadKey: "ops" };

type Host = ReturnType<typeof createHost>;

function saveConnection(host: Host, config: Record<string, unknown>): Promise<IntegrationConnection> {
  return host.createIntegrationConnection({
    catalogId: CATALOG_ID,
    label: "Google Chat",
    enabled: true,
    status: "connected",
    config,
  });
}

/** An edit draft of the saved connection with the operator's choices on it, and pasted secrets in secure custody. */
async function editDraft(
  host: Host,
  connection: IntegrationConnection,
  chosen: Record<string, unknown>,
  pastedSecrets: Record<string, string> = {},
) {
  const created = await createChannelSetupDraft(host, {
    catalogId: CATALOG_ID,
    connectionId: connection.connectionId,
    lifecycleMode: "edit",
  });
  const chosenDraft = await updateChannelSetupDraft(host, created.draftId, {
    expectedRevision: created.revision,
    draft: { ...created.draft, ...chosen },
  });
  if (Object.keys(pastedSecrets).length === 0) return chosenDraft;
  return setChannelSetupDraftSecrets(host, chosenDraft.draftId, {
    expectedRevision: chosenDraft.revision,
    values: pastedSecrets,
  });
}

describe("finalizing a Google Chat Chat app switched to an incoming webhook", () => {
  it.each([
    ["an environment variable", SAVED_APP_WITH_ENV],
    ["a saved secret reference", SAVED_APP_WITH_KEY],
  ])("saves the webhook and none of the Chat app's keys when its key is %s", async (_label, saved) => {
    const host = createHost();
    const connection = await saveConnection(host, saved);
    const draft = await editDraft(
      host,
      connection,
      { mode: "webhook", defaultThreadKey: "ops" },
      { webhookUrl: WEBHOOK_URL },
    );

    const result = await finalizeChannelSetupDraft(host, draft.draftId, draft.revision);

    expect(result.connection.config).toMatchObject({ defaultThreadKey: "ops" });
    expect(result.connection.config.webhookUrl).toEqual(expect.stringMatching(KEYCHAIN_REF));
    expect(host.channelSecrets?.resolve(result.connection.config.webhookUrl as string)).toBe(WEBHOOK_URL);
    for (const key of APP_KEYS) expect(result.connection.config, key).not.toHaveProperty(key);
    expect(JSON.stringify(result.connection.config)).not.toContain(WEBHOOK_URL);
    expect(JSON.stringify(result.connection.config)).not.toContain(SAVED_KEY_REF);
  });

  it("refuses a webhook draft that still holds a pasted service-account key, so the key's reference is never saved", async () => {
    const host = createHost();
    const connection = await saveConnection(host, SAVED_APP_WITH_ENV);
    const draft = await editDraft(
      host,
      connection,
      { mode: "webhook", defaultThreadKey: "ops" },
      { webhookUrl: WEBHOOK_URL, serviceAccountKey: "synthetic-service-account-key" },
    );

    await expect(finalizeChannelSetupDraft(host, draft.draftId, draft.revision)).rejects.toThrow(/validation errors/);
    expect(host.updateConnectionMock).not.toHaveBeenCalled();
  });
});

describe("finalizing a Google Chat incoming webhook switched to a Chat app", () => {
  it("saves the Chat app and neither the saved webhook link nor its thread key", async () => {
    const host = createHost();
    const connection = await saveConnection(host, SAVED_WEBHOOK);
    const draft = await editDraft(host, connection, {
      mode: "app",
      serviceAccountKeyEnv: "GOOGLE_CHAT_SA_KEY",
      audience: "123456789012",
    });

    const result = await finalizeChannelSetupDraft(host, draft.draftId, draft.revision);

    expect(result.connection.config).toMatchObject({
      serviceAccountKeyEnv: "GOOGLE_CHAT_SA_KEY",
      audience: "123456789012",
      inboundAccessMode: "allowlist",
    });
    for (const key of WEBHOOK_KEYS) expect(result.connection.config, key).not.toHaveProperty(key);
    expect(JSON.stringify(result.connection.config)).not.toContain(SAVED_WEBHOOK_REF);
  });

  it("does not save a webhook link that was pasted into the draft before the mode changed to Chat app", async () => {
    const host = createHost();
    const created = await createChannelSetupDraft(host, { catalogId: CATALOG_ID, lifecycleMode: "create" });
    const pasted = await setChannelSetupDraftSecrets(host, created.draftId, {
      expectedRevision: created.revision,
      values: { webhookUrl: WEBHOOK_URL },
    });
    const pastedRef = pasted.secretState.webhookUrl?.secretRef as string;
    const chosen = await updateChannelSetupDraft(host, created.draftId, {
      expectedRevision: pasted.revision,
      draft: { ...pasted.draft, mode: "app", serviceAccountKeyEnv: "GOOGLE_CHAT_SA_KEY", audience: "123456789012" },
    });

    const result = await finalizeChannelSetupDraft(host, created.draftId, chosen.revision);

    expect(result.connection.config).toMatchObject({ serviceAccountKeyEnv: "GOOGLE_CHAT_SA_KEY" });
    for (const key of WEBHOOK_KEYS) expect(result.connection.config, key).not.toHaveProperty(key);
    // The abandoned paste is still cleaned out of secure storage.
    expect(() => host.channelSecrets?.resolve(pastedRef)).toThrow(/unavailable/);
  });
});

// A saved pasted key or link is not rehydrated into an edit draft, so Finalize asks for it again; a saved
// reference that an edit keeps is pinned at the merge boundary (google-chat.mode-switch.test.ts) instead.
describe("finalizing a Google Chat edit that keeps its mode", () => {
  it("keeps a Chat app's saved key variable and its other settings while one setting changes", async () => {
    const host = createHost();
    const connection = await saveConnection(host, SAVED_APP_WITH_ENV);
    const draft = await editDraft(host, connection, { mode: "app", defaultSpace: "spaces/BBBB" });

    const result = await finalizeChannelSetupDraft(host, draft.draftId, draft.revision);

    expect(result.connection.config).toMatchObject({
      serviceAccountKeyEnv: "GOOGLE_CHAT_SA_KEY",
      audience: "123456789012",
      defaultSpace: "spaces/BBBB",
      allowedSenders: ["users/1"],
    });
    for (const key of WEBHOOK_KEYS) expect(result.connection.config, key).not.toHaveProperty(key);
  });

  it("replaces an incoming webhook's saved link with a newly pasted one and keeps its settings", async () => {
    const host = createHost();
    const connection = await saveConnection(host, SAVED_WEBHOOK);
    const draft = await editDraft(
      host,
      connection,
      { mode: "webhook", defaultThreadKey: "alerts" },
      { webhookUrl: WEBHOOK_URL },
    );

    const result = await finalizeChannelSetupDraft(host, draft.draftId, draft.revision);

    const saved = result.connection.config.webhookUrl as string;
    expect(saved).toEqual(expect.stringMatching(KEYCHAIN_REF));
    expect(saved).not.toBe(SAVED_WEBHOOK_REF);
    expect(host.channelSecrets?.resolve(saved)).toBe(WEBHOOK_URL);
    expect(result.connection.config).toMatchObject({ defaultThreadKey: "alerts" });
    for (const key of APP_KEYS) expect(result.connection.config, key).not.toHaveProperty(key);
  });

  it("replaces a Chat app's key with a newly pasted one and keeps nothing of the old reference", async () => {
    const host = createHost();
    const connection = await saveConnection(host, SAVED_APP_WITH_KEY);
    const draft = await editDraft(host, connection, { mode: "app" }, { serviceAccountKey: "synthetic-new-key" });

    const result = await finalizeChannelSetupDraft(host, draft.draftId, draft.revision);

    const saved = result.connection.config.serviceAccountKey as string;
    expect(saved).toEqual(expect.stringMatching(KEYCHAIN_REF));
    expect(saved).not.toBe(SAVED_KEY_REF);
    expect(host.channelSecrets?.resolve(saved)).toBe("synthetic-new-key");
  });
});
