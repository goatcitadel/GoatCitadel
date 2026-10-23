import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { ChatCompletionRequest, LlmConfigFile } from "@goatcitadel/contracts";
import { describe, expect, it, onTestFinished, vi } from "vitest";
import { createNoopSecretStore } from "../test/llm-fixtures.js";
import type { ClaudeCliSession } from "./claude-code-cli-session.js";
import { buildClaudeCliToolManifest } from "./claude-code-cli-tool-bridge.js";
import { fingerprintClaudeCliStep } from "./claude-code-cli-warm-match.js";
import { createClaudeCodeCliRuntime, type ClaudeCodeCliRuntime } from "./llm-provider-claude-code-cli.js";
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

function createService(
  config: LlmConfigFile,
  bridgeEnabled?: () => boolean,
  warmEnabled?: () => boolean,
  env: NodeJS.ProcessEnv = {},
) {
  return new LlmService(config, env, {
    secretStore: createNoopSecretStore(),
    enforceNetworkAllowlist: false,
    ...(bridgeEnabled ? { claudeCliToolBridgeEnabled: bridgeEnabled } : {}),
    ...(warmEnabled ? { claudeCliWarmContinuationEnabled: warmEnabled } : {}),
  });
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
    expect(
      cliCapabilities(
        createService(
          buildConfig(),
          () => false,
          () => true,
        ),
      ).toolCalling,
    ).toBe(false);
    expect(
      cliCapabilities(
        createService(
          buildConfig(),
          () => true,
          () => false,
        ),
      ).toolCalling,
    ).toBe(true);
    expect(
      cliCapabilities(
        createService(
          buildConfig(),
          () => true,
          () => true,
        ),
      ).toolCalling,
    ).toBe(true);
  });

  it("close() kills a parked warm session", async () => {
    // A temp CLAUDE_CONFIG_DIR keeps the reap's spill check out of the operator's real Claude profile.
    const configDir = await mkdtemp(path.join(os.tmpdir(), "goatcitadel-claude-config-"));
    onTestFinished(() => rm(configDir, { recursive: true, force: true }));
    const service = createService(
      buildConfig(),
      () => true,
      () => true,
      { CLAUDE_CONFIG_DIR: configDir },
    );
    // The runtime is private; reach its registry to park one entry as the provider would.
    const { warm } = (service as unknown as { claudeCodeCli: ClaudeCodeCliRuntime }).claudeCodeCli;
    const kill = vi.fn(async () => undefined);
    const session: ClaudeCliSession = {
      pid: 4242,
      exited: new Promise(() => undefined),
      segment: vi.fn(),
      park: vi.fn(),
      kill,
    };
    const manifest = buildClaudeCliToolManifest([]);
    const request = {
      model: "claude-sonnet-5-5",
      messages: [{ role: "user", content: "hi" }],
    } as ChatCompletionRequest;
    warm.park({
      session,
      runDir: path.join(configDir, "run-close-test-missing"),
      manifest,
      fingerprint: fingerprintClaudeCliStep({
        request,
        attribution: { sessionId: "s1", turnId: "t1" },
        model: "claude-sonnet-5-5",
        system: "",
        manifest,
      })!,
      emitted: { text: "", calls: [] },
      pendingIds: [],
    });
    expect(warm.size).toBe(1);

    await expect(service.close()).resolves.toBeUndefined();

    expect(kill).toHaveBeenCalledTimes(1);
    expect(warm.size).toBe(0);
  });
});
