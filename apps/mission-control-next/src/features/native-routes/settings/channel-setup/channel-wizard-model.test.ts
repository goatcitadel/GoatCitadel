import { describe, expect, it } from "vitest";
import type { ChannelSetupDefinition, ChannelSetupDraft, ChannelSetupWizardContent } from "@goatcitadel/contracts";
import { channelHosts, inboundWebhookPath, isStepForLifecycle } from "./channel-wizard-model";

function def(wizard: Partial<ChannelSetupWizardContent> = {}): ChannelSetupDefinition {
  return {
    catalog: {
      catalogId: "channel.fixture",
      key: "fixture",
      label: "Fixture",
      description: "A fixture channel.",
      kind: "channel",
      capabilities: ["send"],
      maturity: "native",
      supportedModes: ["guided", "manual"],
    },
    wizard: {
      archetype: "bot_token_target",
      contentVersion: "fixture.v1",
      estimatedMinutes: 5,
      difficulty: "beginner",
      manualModePolicy: "available-secondary",
      introSummary: "A fixture.",
      prerequisites: [],
      steps: [],
      ...wizard,
    },
    adapter: { adapterVersion: "fixture.v1", secretFieldKeys: [] },
    validation: { validationVersion: "fixture.v1", levels: ["structural"] },
    testing: {
      testVersion: "fixture.v1",
      levels: ["structural"],
      safePreFinalize: true,
      supportsManualConfirmation: true,
    },
    troubleshooting: { commonFailures: [] },
    telemetry: { tier: "tier_1", namespace: "channel_setup.fixture" },
    lifecycle: {
      supportedModes: ["create", "edit"],
      supportsDrafts: true,
      supportsEdit: true,
      supportsRepair: false,
      supportsRotateSecret: false,
      supportsRetest: false,
    },
    volatility: {
      officialDocsUrl: "https://example.com/docs",
      lastReviewedAt: "2026-10-27",
      volatility: "low",
      deprecationRisk: "low",
    },
  };
}

function draft(overrides: Partial<ChannelSetupDraft> = {}): ChannelSetupDraft {
  return {
    draftId: "draft-1",
    revision: 1,
    catalogId: "channel.fixture",
    lifecycleMode: "create",
    enabled: true,
    draft: {},
    secretState: {},
    contentVersion: "fixture.v1",
    adapterVersion: "fixture.v1",
    validationVersion: "fixture.v1",
    testVersion: "fixture.v1",
    createdAt: "2026-10-27T00:00:00.000Z",
    updatedAt: "2026-10-27T00:00:00.000Z",
    ...overrides,
  };
}

describe("channelHosts", () => {
  it("lists fixed hosts, hosts of set conditions and hosts of entered addresses, once each", () => {
    const definition = def({
      requiredHosts: ["chat.googleapis.com"],
      hostFields: ["webhookUrl"],
      conditionalHosts: [{ host: "oauth2.googleapis.com", whenAnyFieldSet: ["serviceAccountKeyEnv"] }],
    });
    expect(
      channelHosts(definition, draft(), {
        webhookUrl: "https://chat.googleapis.com/v1/spaces/x",
        serviceAccountKeyEnv: "GOOGLE_CHAT_KEY",
      }),
    ).toEqual(["chat.googleapis.com", "oauth2.googleapis.com"]);
  });

  it("names no host for an address it can't read, and lists a loopback bridge", () => {
    const definition = def({ hostFields: ["baseUrl"] });
    expect(channelHosts(definition, draft(), { baseUrl: "ntfy.example.com" })).toEqual([]);
    expect(channelHosts(definition, draft(), { baseUrl: "http://127.0.0.1:8080" })).toEqual(["127.0.0.1"]);
  });

  it("adds a conditional host only when its field equals the value given", () => {
    const definition = def({
      conditionalHosts: [{ host: "sandbox.api.sgroup.qq.com", whenAnyFieldSet: ["sandbox"], equals: true }],
    });
    expect(channelHosts(definition, draft(), { sandbox: false })).toEqual([]);
    expect(channelHosts(definition, draft(), { sandbox: true })).toEqual(["sandbox.api.sgroup.qq.com"]);
  });

  it("lowercases the host of an entered address and ignores other schemes", () => {
    const definition = def({ hostFields: ["a", "b", "c"] });
    expect(
      channelHosts(definition, draft(), {
        a: "https://Chat.Example.COM/path?x=1",
        b: "ftp://files.example.com/x",
        c: "mailto:someone@example.com",
      }),
    ).toEqual(["chat.example.com"]);
  });

  it("keeps the first occurrence when the same host comes from several places", () => {
    const definition = def({
      requiredHosts: ["api.example.com"],
      hostFields: ["baseUrl"],
      conditionalHosts: [{ host: "api.example.com", whenAnyFieldSet: ["token"] }],
    });
    expect(channelHosts(definition, draft(), { baseUrl: "https://API.example.com/v1", token: "x" })).toEqual([
      "api.example.com",
    ]);
  });

  it("uses a field's default value when nothing was entered", () => {
    const definition = def({
      hostFields: ["baseUrl"],
      steps: [
        {
          id: "collect",
          kind: "field-collection",
          title: "Collect",
          fields: [
            {
              key: "baseUrl",
              label: "Server",
              type: "url",
              required: false,
              explanation: "The server.",
              defaultValue: "https://ntfy.sh",
            },
          ],
        },
      ],
    });
    expect(channelHosts(definition, draft(), {})).toEqual(["ntfy.sh"]);
    expect(channelHosts(definition, draft(), { baseUrl: "https://ntfy.example.org" })).toEqual(["ntfy.example.org"]);
  });

  it("counts a saved secret as a set field for a condition", () => {
    const definition = def({
      conditionalHosts: [{ host: "oauth2.googleapis.com", whenAnyFieldSet: ["serviceAccountKey"] }],
    });
    const saved = draft({ secretState: { serviceAccountKey: { configured: true, custody: "connection" } } });
    expect(channelHosts(definition, saved, {})).toEqual(["oauth2.googleapis.com"]);
  });

  it("does not throw on empty, non-string or malformed input", () => {
    const definition = def({
      requiredHosts: [],
      hostFields: ["a", "b", "c", "d"],
      conditionalHosts: [{ host: "x.example.com", whenAnyFieldSet: [] }],
    });
    expect(channelHosts(definition, draft(), { a: "", b: 42, c: { nested: true }, d: "http://" })).toEqual([]);
    expect(channelHosts(def(), draft(), {})).toEqual([]);
  });

  it("never changes the definition, draft or values it reads", () => {
    const definition = def({
      requiredHosts: ["a.example.com"],
      hostFields: ["url"],
      conditionalHosts: [{ host: "b.example.com", whenAnyFieldSet: ["k"] }],
    });
    const source = draft();
    const values = { url: "https://c.example.com", k: "v" };
    const before = JSON.stringify([definition, source, values]);
    channelHosts(definition, source, values);
    expect(JSON.stringify([definition, source, values])).toBe(before);
  });
});

describe("inboundWebhookPath", () => {
  const telegram = def({
    inboundWebhook: {
      pathTemplate: "/api/v1/integrations/connections/{connectionId}/telegram/webhook",
      whenFieldEquals: { fieldKey: "receiveMode", value: "webhook" },
    },
  });

  it("gives the webhook path only for a saved connection whose condition holds, escaping the id once", () => {
    expect(inboundWebhookPath(telegram, { receiveMode: "poll" }, "c-1")).toBeUndefined();
    expect(inboundWebhookPath(telegram, { receiveMode: "webhook" }, undefined)).toBeUndefined();
    expect(inboundWebhookPath(telegram, { receiveMode: "webhook" }, "c 1/2")).toBe(
      "/api/v1/integrations/connections/c%201%2F2/telegram/webhook",
    );
  });

  it("returns nothing when the channel has no inbound webhook or the id is empty", () => {
    expect(inboundWebhookPath(def(), {}, "c-1")).toBeUndefined();
    expect(inboundWebhookPath(telegram, { receiveMode: "webhook" }, "")).toBeUndefined();
  });

  it("always gives the path when no condition is set", () => {
    const always = def({ inboundWebhook: { pathTemplate: "/hooks/{connectionId}" } });
    expect(inboundWebhookPath(always, {}, "abc")).toBe("/hooks/abc");
  });

  it("applies field defaults before checking the condition", () => {
    const withDefault = def({
      inboundWebhook: {
        pathTemplate: "/hooks/{connectionId}",
        whenFieldEquals: { fieldKey: "receiveMode", value: "webhook" },
      },
      steps: [
        {
          id: "collect",
          kind: "field-collection",
          title: "Collect",
          fields: [
            {
              key: "receiveMode",
              label: "How to receive",
              type: "select",
              required: false,
              explanation: "How messages arrive.",
              defaultValue: "webhook",
            },
          ],
        },
      ],
    });
    expect(inboundWebhookPath(withDefault, {}, "abc")).toBe("/hooks/abc");
    expect(inboundWebhookPath(withDefault, { receiveMode: "poll" }, "abc")).toBeUndefined();
  });

  it("escapes every occurrence of the id placeholder", () => {
    const twice = def({ inboundWebhook: { pathTemplate: "/a/{connectionId}/b/{connectionId}" } });
    expect(inboundWebhookPath(twice, {}, "x y")).toBe("/a/x%20y/b/x%20y");
  });
});

describe("isStepForLifecycle", () => {
  it("hides setup-only steps only when a saved channel is changed", () => {
    expect(isStepForLifecycle({ id: "b", kind: "instruction", title: "B", createOnly: true }, "edit")).toBe(false);
    expect(isStepForLifecycle({ id: "b", kind: "instruction", title: "B", createOnly: true }, "create")).toBe(true);
    expect(isStepForLifecycle({ id: "o", kind: "intro", title: "O" }, "edit")).toBe(true);
  });

  it("hides setup-only steps for every lifecycle other than create", () => {
    const step = { id: "b", kind: "instruction", title: "B", createOnly: true } as const;
    for (const mode of ["edit", "repair", "rotate_secret", "retest"] as const) {
      expect(isStepForLifecycle(step, mode)).toBe(false);
    }
  });
});
