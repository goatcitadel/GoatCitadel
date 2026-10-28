import { describe, expect, it } from "vitest";
import type { ChannelSetupDefinition, ChannelSetupDraft, ChannelSetupWizardContent } from "@goatcitadel/contracts";
import {
  channelHosts,
  inboundWebhookPath,
  isStepForLifecycle,
  receivesOnWebhook,
  SECRET_REDACTION_MARKER,
  unreadableHostFields,
} from "./channel-wizard-model";

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
    expect(channelHosts(definition, draft(), { baseUrl: "http://127.0.0.1:8080" })).toEqual(["127.0.0.1:8080"]);
  });

  it("keeps an address's own port, so allowing it opens that port and not every port on the host", () => {
    const definition = def({ hostFields: ["a", "b", "c"] });
    expect(
      channelHosts(definition, draft(), {
        a: "http://bridge.lan:8080/api",
        b: "https://chat.example.com:443/hook",
        c: "http://ntfy.lan:80",
      }),
    ).toEqual(["bridge.lan:8080", "chat.example.com", "ntfy.lan"]);
  });

  it("names no host for a port-only address without a scheme, and does not throw", () => {
    const definition = def({ hostFields: ["baseUrl"] });
    for (const baseUrl of ["127.0.0.1:8080", "localhost:8080"]) {
      expect(() => channelHosts(definition, draft(), { baseUrl })).not.toThrow();
      expect(channelHosts(definition, draft(), { baseUrl })).toEqual([]);
    }
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

  it("never names a wildcard or any other address that is not a single host", () => {
    const definition = def({ hostFields: ["a"] });
    for (const a of [
      "https://*/",
      "https://%2A/",
      "https://*.x/",
      "https://*.example.com/hook",
      // The Gateway's network guard reads `example.com.` and `example.com` as different hosts, so neither is offered.
      "https://example.com./",
    ]) {
      expect(channelHosts(definition, draft(), { a }), a).toEqual([]);
    }
  });

  it("names a host with underscores, as Docker and LAN names use them", () => {
    const definition = def({ hostFields: ["a", "b"] });
    expect(
      channelHosts(definition, draft(), { a: "http://signal_cli:8080/v1", b: "https://a_b.example.com/" }),
    ).toEqual(["signal_cli:8080", "a_b.example.com"]);
  });

  it("names a DNS name or an IP address, including a bracketed IPv6 address", () => {
    const definition = def({ hostFields: ["a", "b", "c", "d"] });
    expect(
      channelHosts(definition, draft(), {
        a: "https://my-host.example.co.uk/x",
        b: "http://192.168.0.199:3002",
        c: "http://[::1]:8080/",
        d: "https://xn--bcher-kva.example/",
      }),
    ).toEqual(["my-host.example.co.uk", "192.168.0.199:3002", "[::1]:8080", "xn--bcher-kva.example"]);
  });

  describe("for a saved secret address", () => {
    const definition = def({ hostFields: ["webhookUrl"] });
    const pasted = (host?: string) =>
      draft({
        secretState: {
          webhookUrl: { configured: true, custody: "temporary", source: "operator", ...(host ? { host } : {}) },
        },
      });
    const edited = (host: string) =>
      draft({
        lifecycleMode: "edit",
        hydration: {
          status: "opaque-secret",
          fieldState: { webhookUrl: "configured" },
          warnings: [],
          addressHosts: { webhookUrl: host },
        },
      });

    it("offers the host the Gateway recorded when the address was saved", () => {
      expect(channelHosts(definition, pasted("hooks.slack.com"), { webhookUrl: SECRET_REDACTION_MARKER })).toEqual([
        "hooks.slack.com",
      ]);
    });

    it("offers the host the saved connection recorded, on a draft that holds no value for it", () => {
      expect(channelHosts(definition, edited("tenant.environment.api.powerplatform.com"), {})).toEqual([
        "tenant.environment.api.powerplatform.com",
      ]);
    });

    it("takes the address saved in this draft over the connection's, even when the new one names no host", () => {
      const replaced = { ...edited("old.example.com"), secretState: pasted("new.example.com").secretState };
      expect(channelHosts(definition, replaced, { webhookUrl: SECRET_REDACTION_MARKER })).toEqual(["new.example.com"]);
      const unreadable = { ...edited("old.example.com"), secretState: pasted().secretState };
      expect(channelHosts(definition, unreadable, { webhookUrl: SECRET_REDACTION_MARKER })).toEqual([]);
    });

    it("reads an address being typed, not the recorded host", () => {
      expect(channelHosts(definition, pasted("old.example.com"), { webhookUrl: "https://new.example.com/x" })).toEqual([
        "new.example.com",
      ]);
    });

    it("never offers a recorded value that is not a host", () => {
      for (const host of ["*", "*.example.com", "[REDACTED]", "a/b", "https://x.example.com"]) {
        expect(channelHosts(definition, pasted(host), { webhookUrl: SECRET_REDACTION_MARKER }), host).toEqual([]);
        expect(channelHosts(definition, edited(host), {}), host).toEqual([]);
      }
    });
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

describe("unreadableHostFields", () => {
  const withFields = () =>
    def({
      hostFields: ["webhookUrl", "baseUrl", "unlabelled"],
      steps: [
        {
          id: "collect",
          kind: "field-collection",
          title: "Collect",
          fields: [
            { key: "webhookUrl", label: "Webhook URL", type: "url", required: true, explanation: "x", sensitive: true },
            { key: "baseUrl", label: "Server", type: "url", required: false, explanation: "x" },
          ],
        },
      ],
    });

  const saved = (label: string) => ({ label, kind: "saved" });
  const typed = (label: string) => ({ label, kind: "typed" });

  it("names a set address whose value is redacted, as the editor holds a saved secret", () => {
    expect(unreadableHostFields(withFields(), draft(), { webhookUrl: SECRET_REDACTION_MARKER })).toEqual([
      saved("Webhook URL"),
    ]);
  });

  it("names a saved secret the editor holds no value for", () => {
    const configured = draft({ secretState: { webhookUrl: { configured: true, custody: "connection" } } });
    expect(unreadableHostFields(withFields(), configured, {})).toEqual([saved("Webhook URL")]);
  });

  it("names no saved address whose host the Gateway recorded", () => {
    const pasted = draft({
      secretState: { webhookUrl: { configured: true, custody: "temporary", host: "hooks.example.com" } },
    });
    expect(unreadableHostFields(withFields(), pasted, { webhookUrl: SECRET_REDACTION_MARKER })).toEqual([]);
    const edited = draft({
      hydration: {
        status: "opaque-secret",
        fieldState: { webhookUrl: "configured" },
        warnings: [],
        addressHosts: { webhookUrl: "hooks.example.com" },
      },
    });
    expect(unreadableHostFields(withFields(), edited, {})).toEqual([]);
  });

  it("names nothing for an address that names a host, or for one that is not set", () => {
    const definition = withFields();
    expect(unreadableHostFields(definition, draft(), { webhookUrl: "https://hooks.example.com/x" })).toEqual([]);
    expect(unreadableHostFields(definition, draft(), {})).toEqual([]);
    expect(unreadableHostFields(definition, draft(), { webhookUrl: "", baseUrl: "   " })).toEqual([]);
  });

  it("names, as typed, a set address that is not an http or https URL, a wildcard and a trailing dot", () => {
    const definition = withFields();
    expect(unreadableHostFields(definition, draft(), { baseUrl: "ntfy.example.com" })).toEqual([typed("Server")]);
    expect(unreadableHostFields(definition, draft(), { baseUrl: "ftp://files.example.com/" })).toEqual([
      typed("Server"),
    ]);
    expect(unreadableHostFields(definition, draft(), { baseUrl: "https://*/" })).toEqual([typed("Server")]);
    expect(unreadableHostFields(definition, draft(), { baseUrl: "https://example.com./" })).toEqual([typed("Server")]);
    expect(unreadableHostFields(definition, draft(), { webhookUrl: "https://*.example.com/", baseUrl: "x" })).toEqual([
      typed("Webhook URL"),
      typed("Server"),
    ]);
  });

  it("does not name a field the operator can't see, and names each label once", () => {
    const definition = withFields();
    expect(unreadableHostFields(definition, draft(), { unlabelled: "nonsense" })).toEqual([]);
    const twice = def({ ...withFields().wizard, hostFields: ["webhookUrl", "webhookUrl"] });
    expect(unreadableHostFields(twice, draft(), { webhookUrl: SECRET_REDACTION_MARKER })).toEqual([
      saved("Webhook URL"),
    ]);
  });

  it("gives nothing for a channel with no host fields, and never changes what it reads", () => {
    expect(unreadableHostFields(def(), draft(), { webhookUrl: SECRET_REDACTION_MARKER })).toEqual([]);
    const definition = withFields();
    const source = draft();
    const values = { webhookUrl: SECRET_REDACTION_MARKER };
    const before = JSON.stringify([definition, source, values]);
    unreadableHostFields(definition, source, values);
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

  it("gives no path, and does not throw, for an id that can't be encoded", () => {
    const always = def({ inboundWebhook: { pathTemplate: "/hooks/{connectionId}" } });
    for (const id of ["\uD800", "a\uDC00b", "ok\uD83D"]) {
      expect(() => inboundWebhookPath(always, {}, id)).not.toThrow();
      expect(inboundWebhookPath(always, {}, id)).toBeUndefined();
    }
    expect(inboundWebhookPath(always, {}, "😀")).toBe("/hooks/%F0%9F%98%80");
  });

  it("escapes every occurrence of the id placeholder", () => {
    const twice = def({ inboundWebhook: { pathTemplate: "/a/{connectionId}/b/{connectionId}" } });
    expect(inboundWebhookPath(twice, {}, "x y")).toBe("/a/x%20y/b/x%20y");
  });

  describe("when it waits for a field to be set", () => {
    const googleChat = def({
      inboundWebhook: {
        pathTemplate: "/hooks/{connectionId}/google-chat",
        whenAnyFieldSet: ["serviceAccountKeyEnv"],
      },
    });

    it("gives the path only once a named field is set to text or true", () => {
      expect(inboundWebhookPath(googleChat, {}, "c-1")).toBeUndefined();
      expect(inboundWebhookPath(googleChat, { webhookUrl: "https://chat.googleapis.com/v1/x" }, "c-1")).toBeUndefined();
      for (const empty of ["", "   ", false, 0, null, [], {}]) {
        expect(inboundWebhookPath(googleChat, { serviceAccountKeyEnv: empty }, "c-1"), String(empty)).toBeUndefined();
      }
      expect(inboundWebhookPath(googleChat, { serviceAccountKeyEnv: "GOOGLE_CHAT_KEY" }, "c-1")).toBe(
        "/hooks/c-1/google-chat",
      );
      const flag = def({ inboundWebhook: { pathTemplate: "/hooks/{connectionId}", whenAnyFieldSet: ["enabled"] } });
      expect(inboundWebhookPath(flag, { enabled: true }, "c-1")).toBe("/hooks/c-1");
      expect(inboundWebhookPath(flag, { enabled: false }, "c-1")).toBeUndefined();
    });

    it("takes the listed fields as alternatives", () => {
      const either = def({
        inboundWebhook: { pathTemplate: "/hooks/{connectionId}", whenAnyFieldSet: ["keyEnv", "key"] },
      });
      expect(inboundWebhookPath(either, { key: "[REDACTED]" }, "c-1")).toBe("/hooks/c-1");
      expect(inboundWebhookPath(either, { keyEnv: "KEY" }, "c-1")).toBe("/hooks/c-1");
      expect(inboundWebhookPath(either, {}, "c-1")).toBeUndefined();
    });

    it("applies a field default before asking whether it is set", () => {
      const withDefault = def({
        inboundWebhook: { pathTemplate: "/hooks/{connectionId}", whenAnyFieldSet: ["keyEnv"] },
        steps: [
          {
            id: "collect",
            kind: "field-collection",
            title: "Collect",
            fields: [
              { key: "keyEnv", label: "Key", type: "text", required: false, explanation: "x", defaultValue: "KEY" },
            ],
          },
        ],
      });
      expect(inboundWebhookPath(withDefault, {}, "c-1")).toBe("/hooks/c-1");
    });

    it("needs both this and the field it equals, when both are given", () => {
      const both = def({
        inboundWebhook: {
          pathTemplate: "/hooks/{connectionId}",
          whenFieldEquals: { fieldKey: "receiveMode", value: "webhook" },
          whenAnyFieldSet: ["keyEnv"],
        },
      });
      expect(inboundWebhookPath(both, { receiveMode: "webhook", keyEnv: "KEY" }, "c-1")).toBe("/hooks/c-1");
      expect(inboundWebhookPath(both, { receiveMode: "webhook" }, "c-1")).toBeUndefined();
      expect(inboundWebhookPath(both, { receiveMode: "poll", keyEnv: "KEY" }, "c-1")).toBeUndefined();
    });

    it("treats an empty list as no condition, and changes nothing it reads", () => {
      const none = def({ inboundWebhook: { pathTemplate: "/hooks/{connectionId}", whenAnyFieldSet: [] } });
      expect(inboundWebhookPath(none, {}, "c-1")).toBe("/hooks/c-1");
      const values = { serviceAccountKeyEnv: "KEY" };
      const before = JSON.stringify([googleChat, values]);
      inboundWebhookPath(googleChat, values, "c-1");
      expect(JSON.stringify([googleChat, values])).toBe(before);
    });
  });
});

describe("receivesOnWebhook", () => {
  const telegram = def({
    inboundWebhook: {
      pathTemplate: "/api/v1/integrations/connections/{connectionId}/telegram/webhook",
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
            defaultValue: "poll",
          },
        ],
      },
    ],
  });

  it("is true exactly when the webhook condition holds after defaults, with no connection id needed", () => {
    expect(receivesOnWebhook(telegram, {})).toBe(false);
    expect(receivesOnWebhook(telegram, { receiveMode: "poll" })).toBe(false);
    expect(receivesOnWebhook(telegram, { receiveMode: "webhook" })).toBe(true);
    expect(receivesOnWebhook(def({ inboundWebhook: { pathTemplate: "/hooks/{connectionId}" } }), {})).toBe(true);
  });

  it("is false for a channel with no inbound webhook", () => {
    expect(receivesOnWebhook(def(), {})).toBe(false);
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
