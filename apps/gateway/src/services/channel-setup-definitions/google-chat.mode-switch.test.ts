import { describe, expect, it } from "vitest";
import { requireChannelSetupDefinition } from "../channel-setup-definitions.js";
import { buildEphemeralChannelConnection, clearedChannelConfigKeys } from "../channel-setup-helpers.js";
import { guideFinish } from "./guide-finish.test-support.js";

/**
 * A saved Google Chat connection is a Chat app or an incoming webhook, told apart only by which keys it holds.
 * Editing it and changing the mode must leave only the new mode's keys behind.
 */
const { draftOf, connectionOf, verdictOf } = guideFinish("channel.google-chat");

const REVISION = "a".repeat(64);
const WEBHOOK_URL = "https://chat.googleapis.com/v1/spaces/AAAAxxxx/messages?key=synthetic-key&token=synthetic-token";
const SAVED_KEY_REF =
  "keychain:goatcitadel:channel-connection:11111111-1111-1111-1111-111111111111:serviceAccountKey:0001";
const SAVED_WEBHOOK_REF =
  "keychain:goatcitadel:channel-connection:11111111-1111-1111-1111-111111111111:webhookUrl:0001";
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
  audienceType: "endpoint_url",
  audience: "https://gateway.example.test/api/v1/webhooks/google-chat",
  addOnProjectNumber: "123456789012",
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

function guide() {
  return requireChannelSetupDefinition("channel.google-chat");
}

/**
 * What the Gateway tests and finalizes after an edit: the saved connection merged under what the operator chose.
 * The wizard keeps the saved connection's own values on the draft, so a mode change leaves them there, hidden.
 */
async function editedConfig(saved: Record<string, unknown>, chosen: Record<string, unknown>) {
  const connection = { ...connectionOf(saved), revision: REVISION };
  const hydrated = guide().hydrate(connection).draft;
  const draft = draftOf(
    { ...hydrated, ...chosen },
    { connectionId: connection.connectionId, connectionRevision: REVISION },
    "edit",
  );
  const ephemeral = await buildEphemeralChannelConnection({ getIntegrationConnection: async () => connection }, draft);
  return ephemeral.config;
}

describe("Google Chat setup: what a mode change clears", () => {
  it("clears the Chat app's keys when the draft chooses an incoming webhook", () => {
    const normalized = guide().normalize(
      draftOf({ ...SAVED_APP_WITH_ENV, mode: "webhook", webhookUrl: WEBHOOK_URL, defaultThreadKey: "ops" }),
    );

    expect(normalized).toMatchObject({ webhookUrl: WEBHOOK_URL, defaultThreadKey: "ops" });
    for (const key of APP_KEYS) expect(normalized[key], key).toBeNull();
    expect([...clearedChannelConfigKeys(normalized)].sort()).toEqual([...APP_KEYS].sort());
  });

  it("clears the incoming webhook's keys when the draft chooses a Chat app", () => {
    const normalized = guide().normalize(
      draftOf({ mode: "app", serviceAccountKeyEnv: "GOOGLE_CHAT_SA_KEY", audience: "123456789012" }),
    );

    expect(normalized).toMatchObject({ serviceAccountKeyEnv: "GOOGLE_CHAT_SA_KEY", audience: "123456789012" });
    for (const key of WEBHOOK_KEYS) expect(normalized[key], key).toBeNull();
    expect([...clearedChannelConfigKeys(normalized)].sort()).toEqual([...WEBHOOK_KEYS].sort());
  });
});

describe("Google Chat setup: a saved Chat app edited to an incoming webhook", () => {
  const chosen = { mode: "webhook", webhookUrl: WEBHOOK_URL, defaultThreadKey: "ops" };

  it.each([
    ["an environment variable", SAVED_APP_WITH_ENV],
    ["a saved secret reference", SAVED_APP_WITH_KEY],
  ])("keeps none of the Chat app's keys when its key is %s", async (_label, saved) => {
    const config = await editedConfig(saved, chosen);

    expect(config).toMatchObject({ webhookUrl: WEBHOOK_URL, defaultThreadKey: "ops" });
    for (const key of APP_KEYS) expect(config, key).not.toHaveProperty(key);
  });

  it.each([
    ["an environment variable", SAVED_APP_WITH_ENV],
    ["a saved secret reference", SAVED_APP_WITH_KEY],
  ])("runs the webhook checks, not the Chat app check, when its key is %s", async (_label, saved) => {
    const { deps, issues, eligibility } = await verdictOf(await editedConfig(saved, chosen));

    expect(issues.map((issue) => issue.key)).not.toContain("google_chat_app_live_send");
    expect(deps.fetchWithDiagnosticsTimeout).toHaveBeenCalled();
    expect(eligibility).toMatchObject({ allowed: true, blockingReasons: [] });
  });

  it("does not merge the saved Chat app's secret reference back in", async () => {
    const config = await editedConfig(SAVED_APP_WITH_KEY, chosen);

    expect(JSON.stringify(config)).not.toContain(SAVED_KEY_REF);
  });
});

describe("Google Chat setup: a saved incoming webhook edited to a Chat app", () => {
  const chosen = { mode: "app", serviceAccountKeyEnv: "GOOGLE_CHAT_SA_KEY", audience: "123456789012" };

  it("keeps neither the webhook link nor its thread key", async () => {
    const config = await editedConfig(SAVED_WEBHOOK, chosen);

    expect(config).toMatchObject({ serviceAccountKeyEnv: "GOOGLE_CHAT_SA_KEY", audience: "123456789012" });
    for (const key of WEBHOOK_KEYS) expect(config, key).not.toHaveProperty(key);
    expect(JSON.stringify(config)).not.toContain(SAVED_WEBHOOK_REF);
  });

  it("is checked as a Chat app, with no webhook check", async () => {
    const { deps, issues } = await verdictOf(await editedConfig(SAVED_WEBHOOK, chosen));

    expect(issues.map((issue) => issue.key)).toContain("google_chat_app_live_send");
    expect(deps.fetchWithDiagnosticsTimeout).not.toHaveBeenCalled();
  });
});

describe("Google Chat setup: an edit that keeps its mode keeps what is saved", () => {
  it("keeps a Chat app's saved key reference and its other settings while one setting changes", async () => {
    const config = await editedConfig(SAVED_APP_WITH_KEY, { defaultSpace: "spaces/BBBB" });

    expect(config).toMatchObject({
      serviceAccountKey: SAVED_KEY_REF,
      audienceType: "project_number",
      audience: "123456789012",
      defaultSpace: "spaces/BBBB",
      inboundAccessMode: "allowlist",
      allowedSenders: ["users/1"],
    });
    for (const key of WEBHOOK_KEYS) expect(config, key).not.toHaveProperty(key);
  });

  it("keeps a Chat app's key variable while one setting changes", async () => {
    const config = await editedConfig(SAVED_APP_WITH_ENV, { defaultSpace: "spaces/BBBB" });

    expect(config).toMatchObject({
      serviceAccountKeyEnv: "GOOGLE_CHAT_SA_KEY",
      addOnProjectNumber: "123456789012",
      defaultSpace: "spaces/BBBB",
    });
  });

  it("keeps an incoming webhook's saved link reference while its thread key changes", async () => {
    const config = await editedConfig(SAVED_WEBHOOK, { defaultThreadKey: "alerts" });

    expect(config).toMatchObject({ webhookUrl: SAVED_WEBHOOK_REF, defaultThreadKey: "alerts" });
    for (const key of APP_KEYS) expect(config, key).not.toHaveProperty(key);
  });
});

/**
 * Validate on a change to a saved connection. A change never carries the saved key: the draft only records that the
 * connection holds one (the key stays in secure storage under the connection's reference). So a change that leaves
 * the key alone must not ask for it, and one that moves to the other mode, which holds no key yet, must.
 */
describe("Google Chat setup: validating a change to a saved connection", () => {
  function issueKeysAfter(saved: Record<string, unknown>, chosen: Record<string, unknown>): string[] {
    const connection = { ...connectionOf(saved), revision: REVISION };
    const { draft, hydration } = guide().hydrate(connection);
    const edited = draftOf(
      { ...draft, ...chosen },
      { connectionId: connection.connectionId, connectionRevision: REVISION, hydration },
      "edit",
    );
    return guide()
      .validate(edited)
      .map((issue) => issue.key);
  }

  it.each([
    ["an incoming webhook's saved link", SAVED_WEBHOOK, { defaultThreadKey: "alerts" }],
    ["a Chat app's saved key", SAVED_APP_WITH_KEY, { defaultSpace: "spaces/BBBB" }],
    ["a Chat app's key variable", SAVED_APP_WITH_ENV, { defaultSpace: "spaces/BBBB" }],
  ])("asks for nothing when one setting changes and %s stays", (_label, saved, chosen) => {
    expect(issueKeysAfter(saved, chosen)).toEqual([]);
  });

  it("asks for the webhook link when a saved Chat app is switched to an incoming webhook and none is pasted", () => {
    expect(issueKeysAfter(SAVED_APP_WITH_KEY, { mode: "webhook" })).toEqual(["webhookUrl_required"]);
  });

  it("asks for the key when a saved incoming webhook is switched to a Chat app and none is given", () => {
    expect(issueKeysAfter(SAVED_WEBHOOK, { mode: "app", audience: "123456789012" })).toEqual([
      "serviceAccountKey_required",
    ]);
  });

  it("still asks a new setup for the link or the key", () => {
    expect(
      guide()
        .validate(draftOf({ mode: "webhook" }))
        .map((issue) => issue.key),
    ).toEqual(["webhookUrl_required"]);
    expect(
      guide()
        .validate(draftOf({ mode: "app", audience: "123456789012" }))
        .map((issue) => issue.key),
    ).toEqual(["serviceAccountKey_required"]);
  });
});
