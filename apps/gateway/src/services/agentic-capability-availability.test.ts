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

  it("marks inspectable capabilities unavailable when the runtime supplies an unavailable reason", () => {
    expect(
      normalizeAgenticCapabilityAvailability({
        capabilityId: "tool:browser-state",
        label: "Browser State",
        family: "tool",
        inspectable: true,
        callable: false,
        unavailableReason: "State tools are restricted to trusted-local mode.",
        checkedAt: "2026-05-05T00:00:00.000Z",
      }),
    ).toMatchObject({
      status: "unavailable",
      callable: false,
      reasons: ["State tools are restricted to trusted-local mode."],
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

    expect(response.items.map((item) => [item.capabilityId, item.status, item.callable])).toEqual(
      expect.arrayContaining([
        ["harness:codex_cli", "unavailable", false],
        ["provider:openai", "not_configured", false],
        ["plugin:broken", "unavailable", false],
        ["channel:telegram", "not_configured", false],
        ["scalability:openai_agents_sdk", "blocked", false],
        ["scalability:claude_agent_sdk", "unavailable", false],
        ["scalability:a2a_protocol", "blocked", false],
      ]),
    );
    expect(response.scalability).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          trackId: "openai_agents_sdk",
          status: "blocked",
          callable: false,
          implementationStatus: "partial",
        }),
        expect.objectContaining({
          trackId: "a2a_protocol",
          kind: "agent_protocol",
          status: "blocked",
          callable: false,
          implementationStatus: "partial",
        }),
      ]),
    );
  });

  it("preserves callable OAuth providers, plugin trust posture, and blocked channel reasons", () => {
    const response = buildAgenticRuntimeAvailability({
      generatedAt: "2026-05-05T00:00:00.000Z",
      providers: [
        {
          providerId: "codex",
          label: "Codex",
          baseUrl: "https://api.openai.com/v1",
          apiStyle: "openai-responses",
          defaultModel: "codex-mini",
          hasApiKey: false,
          apiKeySource: "none",
          oauthStatus: { connected: true },
        },
      ],
      plugins: [
        {
          pluginId: "local",
          label: "Local Plugin",
          version: "1.0.0",
          enabled: true,
          installedAt: "2026-05-05T00:00:00.000Z",
          updatedAt: "2026-05-05T00:00:00.000Z",
          capabilities: ["channel.send"],
          source: "plugins/local",
          sourceMetadata: {
            type: "local",
            display: "Local: plugin",
            integrityStatus: "not_applicable",
          },
        },
        {
          pluginId: "unknown",
          label: "Unknown Plugin",
          version: "1.0.0",
          enabled: true,
          installedAt: "2026-05-05T00:00:00.000Z",
          updatedAt: "2026-05-05T00:00:00.000Z",
          capabilities: ["channel.send"],
          source: "manual",
          integrityStatus: "unknown",
        },
        {
          pluginId: "critical",
          label: "Critical Plugin",
          version: "1.0.0",
          enabled: true,
          installedAt: "2026-05-05T00:00:00.000Z",
          updatedAt: "2026-05-05T00:00:00.000Z",
          capabilities: ["channel.send"],
          source: "manual",
          integrityStatus: "verified",
          trustWarnings: [
            {
              code: "critical_warning",
              message: "Critical trust failure.",
              severity: "critical",
            },
          ],
        },
      ],
      channelCatalog: [
        {
          catalogId: "channel.slack",
          kind: "channel",
          key: "slack",
          label: "Slack",
          description: "Slack",
          maturity: "native",
          runtimeAvailability: "runnable",
          authMethods: ["oauth"],
          capabilities: ["channel.send"],
        },
        {
          catalogId: "channel.discord",
          kind: "channel",
          key: "discord",
          label: "Discord",
          description: "Discord",
          maturity: "native",
          runtimeAvailability: "runnable",
          authMethods: ["token"],
          capabilities: ["channel.send"],
        },
        {
          catalogId: "channel.web",
          kind: "channel",
          key: "web",
          label: "Web",
          description: "Web",
          maturity: "planned",
          runtimeAvailability: "catalog",
          authMethods: [],
          capabilities: ["channel.send"],
        },
        {
          catalogId: "integration.obsidian",
          kind: "integration",
          key: "obsidian",
          label: "Obsidian",
          description: "Obsidian",
          maturity: "native",
          runtimeAvailability: "runnable",
          authMethods: [],
          capabilities: ["note.read"],
        },
      ],
      channelConnections: [
        {
          connectionId: "slack-1",
          catalogId: "channel.slack",
          enabled: false,
          status: "connected",
          createdAt: "2026-05-05T00:00:00.000Z",
          updatedAt: "2026-05-05T00:00:00.000Z",
        },
        {
          connectionId: "discord-1",
          catalogId: "channel.discord",
          enabled: true,
          status: "error",
          lastError: "Token rejected.",
          createdAt: "2026-05-05T00:00:00.000Z",
          updatedAt: "2026-05-05T00:00:00.000Z",
        },
      ],
    });

    expect(response.items.map((item) => [item.capabilityId, item.status, item.callable, item.reasons])).toEqual(
      expect.arrayContaining([
        ["provider:codex", "callable", true, []],
        ["plugin:local", "callable", true, []],
        [
          "plugin:unknown",
          "blocked",
          false,
          ["Integrity: unverified", "Runtime status: blocked", "Runtime health probe has not passed."],
        ],
        [
          "plugin:critical",
          "not_configured",
          false,
          [
            "Runtime status: not_configured",
            "Plugin has a critical trust warning and is excluded from callable runtime.",
          ],
        ],
        ["channel:slack", "blocked", false, ["Channel connection is disabled."]],
        ["channel:discord", "blocked", false, ["Token rejected."]],
        [
          "channel:web",
          "unavailable",
          false,
          ["Channel runtime is catalog-only or blocked.", "No channel connection is configured."],
        ],
        [
          "scalability:a2a_protocol",
          "blocked",
          false,
          expect.arrayContaining([
            "A2A has gateway-owned Agent Card draft and task-export preview routes, but callable protocol traffic remains blocked.",
          ]),
        ],
      ]),
    );
  });

  it("classifies OpenAI base URLs by parsed host instead of substring", () => {
    const realOpenAi = buildAgenticRuntimeAvailability({
      generatedAt: "2026-05-05T00:00:00.000Z",
      providers: [
        {
          providerId: "custom",
          label: "Custom provider",
          baseUrl: "https://API.OpenAI.COM/v1",
          apiStyle: "openai-chat-completions",
          defaultModel: "gpt-5.1",
          hasApiKey: false,
          apiKeySource: "none",
        },
      ],
    });
    const spoofedOpenAi = buildAgenticRuntimeAvailability({
      generatedAt: "2026-05-05T00:00:00.000Z",
      providers: [
        {
          providerId: "custom",
          label: "Custom provider",
          baseUrl: "https://attacker.example/v1?upstream=api.openai.com",
          apiStyle: "openai-chat-completions",
          defaultModel: "gpt-5.1",
          hasApiKey: false,
          apiKeySource: "none",
        },
        {
          providerId: "custom-substring",
          label: "Custom provider",
          baseUrl: "https://api.openai.com.attacker.example/v1",
          apiStyle: "openai-chat-completions",
          defaultModel: "gpt-5.1",
          hasApiKey: false,
          apiKeySource: "none",
        },
      ],
    });

    expect(realOpenAi.scalability).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          trackId: "openai_agents_sdk",
          status: "blocked",
          implementationStatus: "partial",
        }),
      ]),
    );
    expect(spoofedOpenAi.scalability).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          trackId: "openai_agents_sdk",
          status: "unavailable",
          implementationStatus: "missing",
        }),
      ]),
    );
  });

  it("distinguishes Claude provider support from Claude Agent SDK availability", () => {
    const response = buildAgenticRuntimeAvailability({
      generatedAt: "2026-05-05T00:00:00.000Z",
      providers: [
        {
          providerId: "claude-code",
          label: "Claude Code",
          baseUrl: "https://api.anthropic.com/v1",
          apiStyle: "anthropic-messages",
          defaultModel: "claude-sonnet-4-6",
          hasApiKey: false,
          apiKeySource: "none",
          oauthStatus: { connected: true },
        },
      ],
    });

    expect(response.scalability).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          trackId: "claude_agent_sdk",
          status: "blocked",
          callable: false,
          implementationStatus: "partial",
          reasons: expect.arrayContaining([
            "No @anthropic-ai/claude-agent-sdk dependency or SDK-backed gateway adapter is registered.",
          ]),
        }),
      ]),
    );
  });
});
