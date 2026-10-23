import type { LlmConfigFile } from "@goatcitadel/contracts";
import { describe, expect, it } from "vitest";
import { createNoopSecretStore } from "../test/llm-fixtures.js";
import { createClaudeCodeCliRuntime } from "./llm-provider-claude-code-cli.js";
import { LlmService } from "./llm-service.js";

function buildConfig(capabilities?: Record<string, boolean>): LlmConfigFile {
  return {
    activeProviderId: "claude-code-cli",
    activeModel: "claude-sonnet-5-5",
    providers: [
      {
        providerId: "claude-code-cli",
        label: "Claude Code CLI (local login)",
        baseUrl: "https://api.anthropic.com/v1",
        apiStyle: "claude-code-cli",
        defaultModel: "claude-sonnet-5-5",
        ...(capabilities ? { capabilities } : {}),
      },
    ],
  };
}

function createService(config: LlmConfigFile, bridgeEnabled?: () => boolean, warmEnabled?: () => boolean) {
  return new LlmService(
    config,
    {},
    {
      secretStore: createNoopSecretStore(),
      enforceNetworkAllowlist: false,
      ...(bridgeEnabled ? { claudeCliToolBridgeEnabled: bridgeEnabled } : {}),
      ...(warmEnabled ? { claudeCliWarmContinuationEnabled: warmEnabled } : {}),
    },
  );
}

function cliCapabilities(service: LlmService) {
  const summary = service.listProviders().find((provider) => provider.providerId === "claude-code-cli");
  expect(summary).toBeDefined();
  return summary!.capabilities;
}

const NEVER_ON = [
  "vision",
  "audio",
  "video",
  "jsonMode",
  "webSearch",
  "reasoning",
  "imageGenerate",
  "imageEdit",
] as const;

describe("claude-code-cli capability truth", () => {
  it("reports toolCalling true only when the bridge flag is on", () => {
    let enabled = true;
    const service = createService(buildConfig(), () => enabled);

    const on = cliCapabilities(service);
    expect(on.toolCalling).toBe(true);
    for (const key of NEVER_ON) expect(on[key], key).toBe(false);
    expect(service.describeProviderToolSupport("claude-code-cli")?.toolCalling).toBe(true);
    expect(service.isClaudeCliToolBridgeEnabled()).toBe(true);

    enabled = false;
    const off = cliCapabilities(service);
    expect(off.toolCalling).toBe(false);
    for (const key of NEVER_ON) expect(off[key], key).toBe(false);
    expect(service.describeProviderToolSupport("claude-code-cli")?.toolCalling).toBe(false);
    expect(service.isClaudeCliToolBridgeEnabled()).toBe(false);
  });

  it("is off when no flag option is supplied", () => {
    const service = createService(buildConfig());
    expect(service.isClaudeCliToolBridgeEnabled()).toBe(false);
    expect(cliCapabilities(service).toolCalling).toBe(false);
  });

  it("a configured capabilities override cannot turn on claude-code-cli tool calling when the flag is off", () => {
    const overridden = buildConfig({ toolCalling: true, vision: true, jsonMode: true, webSearch: true });
    const off = cliCapabilities(createService(overridden, () => false));
    expect(off.toolCalling).toBe(false);
    for (const key of NEVER_ON) expect(off[key], key).toBe(false);

    const on = cliCapabilities(createService(overridden, () => true));
    expect(on.toolCalling).toBe(true);
    for (const key of NEVER_ON) expect(on[key], key).toBe(false);
  });

  it("warm continuation needs both flags", () => {
    let bridge = false;
    let warm = true;
    const runtime = createClaudeCodeCliRuntime(
      {},
      { claudeCliToolBridgeEnabled: () => bridge, claudeCliWarmContinuationEnabled: () => warm },
    );
    expect(runtime.warmContinuationEnabled()).toBe(false);

    bridge = true;
    warm = false;
    expect(runtime.warmContinuationEnabled()).toBe(false);

    warm = true;
    expect(runtime.warmContinuationEnabled()).toBe(true);

    bridge = false;
    expect(runtime.warmContinuationEnabled()).toBe(false);

    expect(createClaudeCodeCliRuntime({}).warmContinuationEnabled()).toBe(false);
  });

  it("the warm flag does not change reported toolCalling", () => {
    expect(cliCapabilities(createService(buildConfig(), () => false, () => true)).toolCalling).toBe(false);
    expect(cliCapabilities(createService(buildConfig(), () => true, () => false)).toolCalling).toBe(true);
    expect(cliCapabilities(createService(buildConfig(), () => true, () => true)).toolCalling).toBe(true);
  });

  it("close() reaps the warm registry without error", async () => {
    const service = createService(buildConfig(), () => true, () => true);
    await expect(service.close()).resolves.toBeUndefined();
  });
});
