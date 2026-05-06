import { describe, expect, it } from "vitest";
import {
  normalizeAgenticCapabilityAvailability,
  normalizeAgenticCapabilityAvailabilitySet,
  buildAgenticRuntimeAvailability,
} from "./agentic-capability-availability.js";

describe("normalizeAgenticCapabilityAvailability", () => {
  it("marks callable runtime capabilities as callable", () => {
    expect(
      normalizeAgenticCapabilityAvailability({
        capabilityId: "provider:openai",
        label: "OpenAI",
        family: "provider",
        inspectable: true,
        callable: true,
        checkedAt: "2026-05-05T00:00:00.000Z",
      }),
    ).toEqual({
      capabilityId: "provider:openai",
      label: "OpenAI",
      family: "provider",
      status: "callable",
      callable: true,
      reasons: [],
      checkedAt: "2026-05-05T00:00:00.000Z",
    });
  });

  it("keeps inspectable but blocked capabilities visible with reasons", () => {
    expect(
      normalizeAgenticCapabilityAvailability({
        capabilityId: "harness:prompt-pack",
        label: "Prompt Pack Harness",
        family: "harness",
        inspectable: true,
        callable: false,
        reasons: ["No active provider configured.", "No active provider configured."],
        blockedReason: "Prompt-pack runner disabled.",
        checkedAt: "2026-05-05T00:00:00.000Z",
      }),
    ).toEqual({
      capabilityId: "harness:prompt-pack",
      label: "Prompt Pack Harness",
      family: "harness",
      status: "blocked",
      callable: false,
      reasons: ["No active provider configured.", "Prompt-pack runner disabled."],
      checkedAt: "2026-05-05T00:00:00.000Z",
    });
  });

  it("marks inspectable missing configuration as not configured", () => {
    expect(
      normalizeAgenticCapabilityAvailability({
        capabilityId: "provider:local",
        label: "Local Provider",
        family: "provider",
        inspectable: true,
        callable: false,
        configured: false,
        notConfiguredReason: "No provider credential is configured.",
        checkedAt: "2026-05-05T00:00:00.000Z",
      }),
    ).toMatchObject({
      status: "not_configured",
      callable: false,
      reasons: ["No provider credential is configured."],
    });
  });

  it("marks non-inspectable capabilities unavailable even when a runtime says callable", () => {
    expect(
      normalizeAgenticCapabilityAvailability({
        capabilityId: "channel:discord",
        label: "Discord",
        family: "channel",
        inspectable: false,
        callable: true,
        unavailableReason: "Connector is not installed.",
        checkedAt: "2026-05-05T00:00:00.000Z",
      }),
    ).toEqual({
      capabilityId: "channel:discord",
      label: "Discord",
      family: "channel",
      status: "unavailable",
      callable: false,
      reasons: ["Connector is not installed."],
      checkedAt: "2026-05-05T00:00:00.000Z",
    });
  });
});

describe("normalizeAgenticCapabilityAvailabilitySet", () => {
  it("normalizes provider, harness, and channel families", () => {
    const records = normalizeAgenticCapabilityAvailabilitySet({
      providers: [
        {
          capabilityId: "provider:anthropic",
          label: "Anthropic",
          family: "tool",
          inspectable: true,
          callable: false,
          checkedAt: "2026-05-05T00:00:00.000Z",
        },
      ],
      harnesses: [
        {
          capabilityId: "harness:eval",
          label: "Eval Harness",
          family: "tool",
          inspectable: true,
          callable: true,
          checkedAt: "2026-05-05T00:00:00.000Z",
        },
      ],
      channels: [
        {
          capabilityId: "channel:slack",
          label: "Slack",
          family: "tool",
          inspectable: false,
          callable: false,
          checkedAt: "2026-05-05T00:00:00.000Z",
        },
      ],
    });

    expect(records.map((record) => record.family)).toEqual(["provider", "harness", "channel"]);
    expect(records.map((record) => record.status)).toEqual(["blocked", "callable", "unavailable"]);
  });
});

describe("buildAgenticRuntimeAvailability", () => {
  it("normalizes harnesses, providers, plugins, and channels into one non-callable-safe surface", () => {
    const response = buildAgenticRuntimeAvailability({
      generatedAt: "2026-05-05T00:00:00.000Z",
      harnesses: [
        {
          harnessId: "codex_cli",
          label: "Codex CLI",
          status: "unavailable",
          callable: false,
          reasons: ["executable: missing"],
          checkedAt: "2026-05-05T00:00:00.000Z",
        },
      ],
      providers: [
        {
          providerId: "openai",
          label: "OpenAI",
          baseUrl: "https://api.openai.com/v1",
          apiStyle: "openai-chat-completions",
          defaultModel: "gpt-5.1",
          hasApiKey: false,
          apiKeySource: "none",
        },
      ],
      plugins: [
        {
          pluginId: "broken",
          label: "Broken",
          version: "1.0.0",
          enabled: true,
          installedAt: "2026-05-05T00:00:00.000Z",
          updatedAt: "2026-05-05T00:00:00.000Z",
          capabilities: ["channel.send"],
          integrityStatus: "mismatch",
        },
      ],
      channelCatalog: [
        {
          catalogId: "channel.telegram",
          kind: "channel",
          key: "telegram",
          label: "Telegram",
          description: "Telegram",
          maturity: "native",
          runtimeAvailability: "runnable",
          authMethods: ["token"],
          capabilities: ["channel.send"],
        },
      ],
      channelConnections: [],
    });

    expect(response.items.map((item) => [item.capabilityId, item.status, item.callable])).toEqual([
      ["harness:codex_cli", "unavailable", false],
      ["provider:openai", "not_configured", false],
      ["plugin:broken", "unavailable", false],
      ["channel:telegram", "not_configured", false],
    ]);
  });
});
