import { describe, expect, it } from "vitest";
import {
  resolveChannelOwnerActorIds,
  type ChannelSetupDraft,
  type ChannelSetupFieldDefinition,
  type IntegrationConnection,
} from "@goatcitadel/contracts";
import { requireChannelSetupDefinition } from "../channel-setup-definitions.js";
import { createSlackDefinition } from "./slack.js";

const slack = requireChannelSetupDefinition("channel.slack");

function connection(config: Record<string, unknown>): IntegrationConnection {
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
    createdAt: "2026-10-28T00:00:00.000Z",
    updatedAt: "2026-10-28T00:00:00.000Z",
  };
}

function draftOf(draft: Record<string, unknown>, hydration?: ChannelSetupDraft["hydration"]): ChannelSetupDraft {
  return {
    draftId: "22222222-2222-2222-2222-222222222222",
    revision: 1,
    catalogId: "channel.slack",
    lifecycleMode: "create",
    enabled: true,
    draft,
    secretState: {},
    ...(hydration ? { hydration } : {}),
    contentVersion: "content.v1",
    adapterVersion: "adapter.v1",
    validationVersion: "validation.v1",
    testVersion: "test.v1",
    createdAt: "2026-10-28T00:00:00.000Z",
    updatedAt: "2026-10-28T00:00:00.000Z",
  };
}

function field(key: string): ChannelSetupFieldDefinition {
  const found = slack.definition.wizard.steps.flatMap((step) => step.fields ?? []).find((entry) => entry.key === key);
  if (!found) {
    throw new Error(`Slack setup has no ${key} field`);
  }
  return found;
}

const BASE_DRAFT = { botToken: "xoxb-123-456-abc", targets: [{ channel: "#ops", default: true }] };
const APP_TOKEN = "xapp-1-A0123-456-abcdef";
const WHEN_SOCKET = { fieldKey: "receiveMode", value: "socket" };

describe("Slack receive mode setup", () => {
  it("offers two ways to receive, today's by default", () => {
    const receiveMode = field("receiveMode");

    expect(receiveMode.type).toBe("select");
    expect(receiveMode.advanced).toBe(true);
    expect(receiveMode.required).toBe(false);
    expect(receiveMode.defaultValue).toBe("webhook");
    expect(receiveMode.options).toEqual([
      { value: "socket", label: "GoatCitadel keeps a connection open to Slack (no public web address needed)" },
      { value: "webhook", label: "Slack sends events to a public web address (needs an OAuth install)" },
    ]);
  });

  it("asks for the app-level token only for Socket Mode", () => {
    const appToken = field("appToken");
    const appTokenEnv = field("appTokenEnv");

    expect(appToken.visibleWhenFieldEquals).toEqual(WHEN_SOCKET);
    expect(appTokenEnv.visibleWhenFieldEquals).toEqual(WHEN_SOCKET);
    expect(slack.definition.adapter.secretFieldKeys).toContain("appToken");
    expect(appToken.type).toBe("secret");
    expect(appToken.sensitive).toBe(true);
    expect(appToken.required).toBe(false);
    expect(appTokenEnv.type).toBe("text");
  });

  it("describes the app-level token the way a person finds it", () => {
    const raw = createSlackDefinition().definition.wizard.steps.flatMap((step) => step.fields ?? []);
    const rawAppToken = raw.find((entry) => entry.key === "appToken");
    const rawAppTokenEnv = raw.find((entry) => entry.key === "appTokenEnv");

    expect(rawAppToken?.label).toBe("App-level token");
    expect(rawAppToken?.placeholder).toBe("xapp-…");
    expect(JSON.stringify(rawAppToken?.whereToFind)).toContain(
      "From Basic Information › App-Level Tokens in your Slack app, with the connections:write scope.",
    );
    expect(rawAppTokenEnv?.placeholder).toBe("SLACK_APP_TOKEN");
    expect(field("appToken").label).toBe("App-level token");
  });

  it("words the variable-name field like the other secret variables", () => {
    const appTokenEnv = field("appTokenEnv");

    expect(appTokenEnv.label).toBe("App-level token from an environment variable (advanced)");
    expect(appTokenEnv.advanced).toBe(true);
    expect(appTokenEnv.explanation).toContain(
      "The variable's name must start with SLACK_ (for example SLACK_APP_TOKEN)",
    );
  });

  it("puts each pasted secret ahead of its variable name", () => {
    const keys = slack.definition.wizard.steps.flatMap((step) => (step.fields ?? []).map((entry) => entry.key));

    expect(keys.indexOf("receiveMode")).toBeLessThan(keys.indexOf("appToken"));
    expect(keys.indexOf("appToken")).toBeLessThan(keys.indexOf("appTokenEnv"));
  });

  it("hydrates older connections as webhook connections", () => {
    expect(slack.hydrate(connection({ botToken: "xoxb-1", signingSecret: "s3cret" })).draft.receiveMode).toBe(
      "webhook",
    );
    expect(slack.hydrate(connection({ botToken: "xoxb-1", receiveMode: "socket" })).draft.receiveMode).toBe("socket");
    expect(slack.hydrate(connection({ botToken: "xoxb-1", receiveMode: "webhook" })).draft.receiveMode).toBe("webhook");
    expect(slack.hydrate(connection({ botToken: "xoxb-1", receiveMode: "carrier-pigeon" })).draft.receiveMode).toBe(
      "webhook",
    );
  });

  it("reports the saved app-level token as configured without handing it back", () => {
    const withToken = slack.hydrate(connection({ botToken: "xoxb-1", receiveMode: "socket", appToken: APP_TOKEN }));
    const withVariable = slack.hydrate(
      connection({ botToken: "xoxb-1", receiveMode: "socket", appTokenEnv: "SLACK_APP_TOKEN" }),
    );
    const without = slack.hydrate(connection({ botToken: "xoxb-1" }));

    expect(withToken.hydration.fieldState.appToken).toBe("configured");
    expect(withToken.draft).not.toHaveProperty("appToken");
    expect(JSON.stringify(withToken.draft)).not.toContain(APP_TOKEN);
    expect(withVariable.hydration.fieldState.appToken).toBe("configured");
    expect(withVariable.hydration.fieldState.appTokenEnv).toBe("configured");
    expect(withVariable.draft.appTokenEnv).toBe("SLACK_APP_TOKEN");
    expect(withVariable.hydration.status).toBe("opaque-secret");
    expect(without.hydration.fieldState.appToken).toBe("unknown");
  });

  it("keeps the mode, the token reference and who said hi", () => {
    const normalized = slack.normalize(
      draftOf({
        ...BASE_DRAFT,
        receiveMode: "socket",
        appToken: APP_TOKEN,
        appTokenEnv: "SLACK_APP_TOKEN",
        ownerActorIds: ["U0123ABC"],
      }),
    );

    expect(normalized.receiveMode).toBe("socket");
    expect(normalized.appToken).toBe(APP_TOKEN);
    expect(normalized.appTokenEnv).toBe("SLACK_APP_TOKEN");
    expect(normalized.ownerActorIds).toEqual(["u0123abc"]);
  });

  it("carries a saved app-level token through an edit that does not retype it", () => {
    const raw = { botToken: "xoxb-1", receiveMode: "socket", appToken: "keychain:goatcitadel:channel-x:appToken" };
    const hydrated = slack.hydrate(connection(raw));
    const normalized = slack.normalize(draftOf(hydrated.draft, hydrated.hydration));

    expect(normalized.receiveMode).toBe("socket");
    expect(normalized.appToken).toBe(raw.appToken);
  });

  it("stores owner ids in the canonical form the rest of GoatCitadel compares against", () => {
    const ownerActorIds = [" U1 ", "u1", "U2", "", "   ", 5];
    const normalized = slack.normalize(draftOf({ ...BASE_DRAFT, ownerActorIds }));

    expect(normalized.ownerActorIds).toEqual(["u1", "u2"]);
    expect(normalized.ownerActorIds).toEqual(resolveChannelOwnerActorIds({ ownerActorIds }));
  });

  it("omits ownerActorIds and an unknown receiveMode when the draft has none", () => {
    expect(slack.normalize(draftOf(BASE_DRAFT))).not.toHaveProperty("ownerActorIds");
    expect(slack.normalize(draftOf({ ...BASE_DRAFT, ownerActorIds: [] }))).not.toHaveProperty("ownerActorIds");
    expect(slack.normalize(draftOf({ ...BASE_DRAFT, ownerActorIds: ["  ", 7] }))).not.toHaveProperty("ownerActorIds");
    expect(slack.normalize(draftOf(BASE_DRAFT))).not.toHaveProperty("receiveMode");
    expect(slack.normalize(draftOf({ ...BASE_DRAFT, receiveMode: "carrier-pigeon" }))).not.toHaveProperty(
      "receiveMode",
    );
  });

  it("carries ownerActorIds through hydrate and normalize", () => {
    const hydrated = slack.hydrate(connection({ ...BASE_DRAFT, ownerActorIds: ["U1", " U2 ", "u1"] }));

    expect(hydrated.draft.ownerActorIds).toEqual(["u1", "u2"]);
    expect(hydrated.hydration.fieldState.ownerActorIds).toBe("configured");
    expect(slack.hydrate(connection(BASE_DRAFT)).hydration.fieldState.ownerActorIds).toBe("unknown");
    expect(slack.normalize(draftOf(hydrated.draft)).ownerActorIds).toEqual(["u1", "u2"]);
  });

  it("needs an app-level token for Socket Mode", () => {
    const issues = slack.validate(draftOf({ ...BASE_DRAFT, receiveMode: "socket" }));

    expect(issues).toEqual([
      expect.objectContaining({
        fieldKey: "appToken",
        level: "error",
        message: "Socket Mode needs the app-level token.",
        failureCategory: "missing_input",
      }),
    ]);
  });

  it("accepts a typed app-level token, a variable name or a saved token for Socket Mode", () => {
    expect(slack.validate(draftOf({ ...BASE_DRAFT, receiveMode: "socket", appToken: APP_TOKEN }))).toEqual([]);
    expect(slack.validate(draftOf({ ...BASE_DRAFT, receiveMode: "socket", appTokenEnv: "SLACK_APP_TOKEN" }))).toEqual(
      [],
    );
    const hydrated = slack.hydrate(connection({ ...BASE_DRAFT, receiveMode: "socket", appToken: APP_TOKEN }));
    expect(slack.validate(draftOf(hydrated.draft, hydrated.hydration))).toEqual([]);
  });

  it("says what an app-level token starts with when a typed one does not", () => {
    const issues = slack.validate(draftOf({ ...BASE_DRAFT, receiveMode: "socket", appToken: "xoxb-1-2-3" }));

    expect(issues).toEqual([
      expect.objectContaining({
        fieldKey: "appToken",
        level: "error",
        message: "App-level tokens start with xapp-.",
        failureCategory: "malformed_value",
      }),
    ]);
    expect(JSON.stringify(issues)).not.toContain("xoxb-1-2-3");
  });

  it("does not ask a webhook connection for an app-level token", () => {
    expect(slack.validate(draftOf({ ...BASE_DRAFT, receiveMode: "webhook" }))).toEqual([]);
    expect(slack.validate(draftOf(BASE_DRAFT))).toEqual([]);
  });

  it("flags an unknown receive mode during validation", () => {
    const issues = slack.validate(draftOf({ ...BASE_DRAFT, receiveMode: "carrier-pigeon" }));

    expect(issues).toEqual([expect.objectContaining({ fieldKey: "receiveMode", level: "error" })]);
  });

  it("refuses a variable name that Slack's rule would not read", () => {
    const issues = slack.validate(draftOf({ ...BASE_DRAFT, receiveMode: "socket", appTokenEnv: "DISCORD_APP_TOKEN" }));

    expect(issues).toEqual([expect.objectContaining({ fieldKey: "appTokenEnv", level: "error" })]);
  });
});
