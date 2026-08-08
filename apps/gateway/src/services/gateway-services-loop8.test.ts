import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ApprovalCreateInput, ApprovalRequest, LoadedSkill, ToolCatalogEntry } from "@goatcitadel/contracts";
import { createSqliteAsyncStorage, Storage } from "@goatcitadel/storage";
import { CapabilitySystemService } from "./capability-system-service.js";
import { ImprovementService, type ImprovementServiceCallbacks } from "./improvement-service.js";
import {
  readBlockerTemplateStrictness,
  readLiveIntentThreshold,
  readRetryRepairThreshold,
} from "./improvement-tune-reads.js";
import { LlmService } from "./llm-service.js";
import { MemoryLifecycleService } from "./memory-lifecycle-service.js";
import { MemoryWriteGateService } from "./memory-write-gate-service.js";
import { PromptPackService } from "./prompt-pack-service.js";
import type { SecretStoreService } from "./secret-store-service.js";
import type { ServiceContext } from "./service-context.js";
import { SkillImportService } from "./skill-import-service.js";
import { getSettings, updateSettings, type SettingsRuntimeDependencies } from "./settings-auth-service.js";

interface TempHarness {
  rootDir: string;
  storage?: Storage;
  stop?: () => void;
}

const tempHarnesses: TempHarness[] = [];

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  for (const harness of tempHarnesses.splice(0).reverse()) {
    harness.stop?.();
    harness.storage?.close();
    fs.rmSync(harness.rootDir, { recursive: true, force: true });
  }
});

describe("Loop 8 gateway service coverage", () => {
  it("applies settings owners without bypassing the canonical config generation", async () => {
    const deps = buildSettingsHost();
    expect((await getSettings(deps)).deploymentProfile).toBe("local_dev");

    const updated = await updateSettings(deps, {
      deploymentProfile: "trusted_local",
      toolApprovalMode: "bypass",
      budgetMode: "power",
      readAccessMode: "full_disk",
      networkAllowlist: [" api.openai.com ", "", "localhost "],
      auth: {
        mode: "token",
        allowLoopbackBypass: true,
        token: "  operator-token  ",
        basicUsername: " operator ",
        basicPassword: " pass ",
      },
      memory: {
        enabled: false,
        qmdEnabled: false,
        qmdApplyToChat: false,
        qmdApplyToOrchestration: false,
        qmdMaxContextTokens: 25,
        qmdMinPromptChars: -10,
        qmdCacheTtlSeconds: 3,
        qmdDistillerProviderId: " judge ",
        qmdDistillerModel: " model-x ",
      },
      web: {
        firecrawl: {
          enabled: true,
          baseUrl: " http://127.0.0.1:3009 ",
          apiKeyEnv: " FIRECRAWL_KEY ",
          timeoutMs: 999_999,
          defaultReadBackend: "firecrawl",
          fallbackToNative: false,
        },
      },
      mesh: {
        enabled: true,
        mode: "tailnet",
        nodeId: " node-loop8 ",
        mdns: false,
        staticPeers: [" peer-a ", "", "peer-b"],
        requireMtls: false,
        tailnetEnabled: true,
      },
      npu: {
        enabled: false,
        autoStart: true,
        sidecarUrl: " http://127.0.0.1:11441 ",
      },
      llamaCpp: {
        enabled: true,
        autoStart: true,
        baseUrl: " http://127.0.0.1:8088/v1 ",
        command: " llama-server ",
        extraArgs: [" --mlock ", ""],
        alias: " local-loop8 ",
        ctxSize: 12,
        threads: 999,
        gpuLayers: -4,
        parallel: 256,
        batchSize: 0,
        ubatchSize: 999_999,
        flashAttention: null,
      },
      llm: {
        activeProviderId: "openai",
        activeModel: "gpt-4.1-mini",
        upsertProvider: {
          providerId: "openai",
          label: "OpenAI",
          baseUrl: "https://api.openai.com/v1",
          defaultModel: "gpt-4.1-mini",
          apiStyle: "openai-chat-completions",
          authMode: "api-key",
          apiKeyEnv: "OPENAI_API_KEY",
        },
      },
      features: {
        replayRegressionV1Enabled: true,
        codeModeV1Enabled: true,
      },
    });

    expect(updated.deploymentProfile).toBe("trusted_local");
    expect(updated.toolApprovalMode).toBe("bypass");
    expect(updated.networkAllowlist).toEqual(["api.openai.com", "localhost"]);
    expect(updated.auth).toMatchObject({
      mode: "token",
      allowLoopbackBypass: true,
      tokenConfigured: true,
      basicConfigured: true,
    });
    expect(updated.memory.qmd.maxContextTokens).toBe(100);
    expect(updated.memory.qmd.minPromptChars).toBe(0);
    expect(updated.memory.qmd.cacheTtlSeconds).toBe(10);
    expect(updated.web.firecrawl).toMatchObject({
      enabled: true,
      baseUrl: "http://127.0.0.1:3009",
      apiKeyEnv: "FIRECRAWL_KEY",
      timeoutMs: 120_000,
      defaultReadBackend: "firecrawl",
      fallbackToNative: false,
    });
    expect(updated.mesh.staticPeers).toEqual(["peer-a", "peer-b"]);
    expect(updated.llamaCpp).toMatchObject({
      enabled: true,
      autoStart: true,
      baseUrl: "http://127.0.0.1:8088/v1",
      command: "llama-server",
      extraArgs: ["--mlock"],
      alias: "local-loop8",
      ctxSize: 256,
      threads: 512,
      gpuLayers: 0,
      parallel: 128,
      batchSize: 1,
      ubatchSize: 262_144,
      flashAttention: undefined,
    });

    expect(deps.persistAssistantConfig).not.toHaveBeenCalled();
    expect(deps.persistToolPolicyConfig).not.toHaveBeenCalled();
    expect(deps.persistBudgetsConfig).not.toHaveBeenCalled();
    expect(deps.persistLlmConfig).not.toHaveBeenCalled();
    expect(deps.llmService.updateNetworkAllowlist).toHaveBeenCalledWith(["api.openai.com", "localhost"], {
      enforce: true,
    });
    expect(deps.llmService.updateRuntimeConfig).toHaveBeenCalledWith(
      expect.objectContaining({
        upsertProvider: expect.objectContaining({
          providerId: "llamacpp",
          defaultModel: "local-loop8",
        }),
      }),
    );
    expect(deps.llmService.updateRuntimeConfig).toHaveBeenCalledWith(
      expect.objectContaining({
        activeProviderId: "openai",
        activeModel: "gpt-4.1-mini",
      }),
    );
    expect(deps.meshService.updateOptions).toHaveBeenCalledWith(
      expect.objectContaining({
        enabled: true,
        mode: "tailnet",
        localNodeId: "node-loop8",
        requireMtls: false,
        tailnetEnabled: true,
      }),
    );
    expect(deps.npuSidecar.stop).toHaveBeenCalledWith("disabled");
    expect(deps.llamaCppRuntime.start).toHaveBeenCalledWith("config_autostart");
  });

  it("keeps LLM provider/model routing honest across disabled, fallback, OAuth, and unsupported image paths", async () => {
    const secretStore = createNoopSecretStore();
    const service = new LlmService(
      {
        providers: [
          {
            providerId: "openai",
            label: "OpenAI",
            baseUrl: "https://api.openai.com/v1",
            apiStyle: "openai-chat-completions",
            defaultModel: "gpt-4.1-mini",
            apiKey: "inline-openai",
          },
          {
            providerId: "openai-codex",
            label: "OpenAI Codex",
            baseUrl: "https://api.openai.com/v1",
            apiStyle: "openai-codex-responses",
            authMode: "codex-oauth",
            defaultModel: "gpt-5-codex",
          },
          {
            providerId: "custom",
            label: "Custom",
            baseUrl: "http://127.0.0.1:1234/v1",
            apiStyle: "openai-chat-completions",
            defaultModel: "custom-model",
            apiKey: "inline-custom",
          },
        ],
      },
      {},
      {
        enforceNetworkAllowlist: false,
        secretStore,
      },
    );

    expect(() => service.updateRuntimeConfig({ activeModel: "gpt-4.1-mini" })).toThrow(/Select an active LLM provider/);
    expect(() => service.updateRuntimeConfig({ activeProviderId: "missing-provider" })).toThrow(/Unknown LLM provider/);

    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw new Error("model discovery offline");
      }),
    );
    const preview = await service.previewModels({
      providerId: "openai",
      baseUrl: "https://api.openai.com/v1",
      apiStyle: "openai-chat-completions",
    });

    expect(preview.source).toBe("error_fallback");
    expect(preview.warning).toContain("model discovery offline");
    expect(preview.items.map((item) => item.id)).toContain("gpt-4.1-mini");
    expect(service.getOpenAICodexOAuthStatus()).toMatchObject({
      providerId: "openai-codex",
      connected: false,
    });
    expect(() => service.setProviderApiKey("openai-codex", "sk-test")).toThrow(/ChatGPT OAuth/);
    await expect(service.generateImage({ providerId: "custom", prompt: "draw a gateway" })).rejects.toThrow(
      /Image generation currently requires/,
    );
  });

  it("surfaces capability lifecycle provenance and blocks disabled Code Mode paths", async () => {
    const rootDir = createTempRoot("goat-loop8-capabilities-");
    const storage = createStorage(rootDir);
    const skillDir = path.join(rootDir, "skills", "extra", "loop8-skill");
    fs.mkdirSync(skillDir, { recursive: true });
    fs.writeFileSync(
      path.join(skillDir, "source.json"),
      JSON.stringify({
        manifestVersion: 2,
        candidate: {
          sourceRef: "https://github.com/example/loop8-skill",
          sourceProvider: "github",
        },
      }),
      "utf8",
    );

    const readSkillStates = vi.fn(
      () =>
        new Map([
          [
            "skill-disabled",
            {
              skillId: "skill-disabled",
              state: "disabled",
              note: "operator paused",
              updatedAt: "2026-05-14T00:00:00.000Z",
              pinned: true,
              usageCount: 3,
            },
          ],
        ]),
    );
    const publishRealtime = vi.fn();
    const service = new CapabilitySystemService({
      rootDir,
      runtimeConfig: createCapabilityRuntimeConfig(),
      storage: createSqliteAsyncStorage(storage),
      readFeatureFlags: () => ({ codeModeV1Enabled: false }),
      listToolCatalog: () => [createTool("tool.inspect", { codeModeAllowed: true })],
      listLoadedSkills: () => [
        createLoadedSkill("skill-extra", "Loop 8 Extra", "extra", skillDir),
        createLoadedSkill("skill-disabled", "Disabled Skill", "workspace", path.join(rootDir, "workspace-skill")),
      ],
      readSkillStates,
      invokeTool: vi.fn(),
      createApproval: vi.fn(async (input: ApprovalCreateInput) => createApprovalRequest(input)),
      resolveApproval: vi.fn(),
      publishRealtime,
      readPolicySnapshot: () => ({ profile: "loop8" }),
    });

    const skills = await service.listSkills();
    expect(skills).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          skillId: "skill-extra",
          capabilityCategory: "community_imported",
          lifecycleState: "candidate",
          callable: false,
          trustLabel: "Imported/community",
          reviewWarning:
            "Imported skill is missing exact-byte provenance and remains non-callable until re-imported and governed activation is recorded.",
          lifecycle: expect.objectContaining({
            lifecycleState: "candidate",
            provenance: {
              source: "extra",
              sourceRef: "https://github.com/example/loop8-skill",
              sourceProvider: "github",
            },
          }),
        }),
        expect.objectContaining({
          skillId: "skill-disabled",
          state: "disabled",
          callable: false,
          note: "operator paused",
          pinned: true,
          usageCount: 3,
        }),
      ]),
    );
    expect(storage.skillLifecycle.find("skill-extra")).toMatchObject({
      category: "community_imported",
      lifecycleState: "candidate",
      reviewWarning:
        "Imported skill is missing exact-byte provenance and remains non-callable until re-imported and governed activation is recorded.",
      provenance: expect.objectContaining({
        sourceRef: "https://github.com/example/loop8-skill",
      }),
    });

    const proposal = await service.createProposal({
      proposalKind: "skill",
      title: "Review imported skill",
      summary: "Keep this visible until activation.",
      payload: { skillId: "skill-extra" },
    });
    const inspectable = await service.listCatalog("inspectable");
    const callable = await service.listCatalog("callable");

    expect(inspectable).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          capabilityId: "skill:skill-extra",
          sourceRef: "https://github.com/example/loop8-skill",
          sourceProvider: "github",
          callable: false,
        }),
        expect.objectContaining({
          capabilityId: `proposal:${proposal.proposalId}`,
          callable: false,
          reviewWarning: "Inspectable only until governance activation.",
        }),
      ]),
    );
    expect(callable.map((entry) => entry.capabilityId)).not.toContain("skill:skill-extra");
    expect(callable.map((entry) => entry.capabilityId)).not.toContain("skill:skill-disabled");
    await expect(
      service.createCodeModeRun({
        language: "typescript",
        source: "return { ok: true };",
      }),
    ).rejects.toThrow(/Code Mode v1 is disabled/);
    expect(publishRealtime).toHaveBeenCalledWith(
      "capability_proposal_created",
      "capabilities",
      expect.objectContaining({
        proposalId: proposal.proposalId,
      }),
    );
  });

  it("records skill import provenance, duplicate failures, and remote bundle errors in history", async () => {
    const rootDir = createTempRoot("goat-loop8-skill-import-");
    const settings = createSystemSettingsRepo();
    const service = new SkillImportService(rootDir, settings as never);
    const firstSkill = createSkillFixture(rootDir, "Cloudflare API", "Inspect and manage Cloudflare DNS records.");
    const secondSkill = createSkillFixture(rootDir, "Cloudflare Manager", "Manage Cloudflare DNS zones safely.");

    // HX-402 P2: the retired executable install redirects into the governed
    // Skill Hub and never publishes a manifest; validation provenance travels
    // on the redirect result instead.
    const installed = await service.installImport({
      sourceRef: firstSkill,
      sourceType: "local_path",
      sourceProvider: "local",
    });
    expect(installed.disposition).toBe("redirected_to_skill_hub");
    expect(installed.validation.candidate).toMatchObject({
      sourceProvider: "local",
      sourceType: "local_path",
      sourceRef: firstSkill,
      canonicalKey: expect.stringContaining("local_path"),
    });
    expect(installed.redirect.eligible).toBe(false);
    expect(fs.existsSync(path.join(rootDir, "skills", "extra"))).toBe(false);

    // Duplicate-family validation still reads historically installed skills
    // (pre-retirement installs remain on disk), so seed one directly.
    const historicalInstallDir = path.join(rootDir, "skills", "extra", "cloudflare-api");
    fs.mkdirSync(historicalInstallDir, { recursive: true });
    fs.writeFileSync(path.join(historicalInstallDir, "SKILL.md"), "# Cloudflare API\n", "utf8");
    fs.writeFileSync(
      path.join(historicalInstallDir, "source.json"),
      JSON.stringify({
        manifestVersion: 3,
        duplicateFamily: "cloudflare_dns",
        candidate: { canonicalKey: "local:local_path:cloudflare-api", sourceRef: firstSkill },
      }),
      "utf8",
    );

    const duplicate = await service.validateImport({
      sourceRef: secondSkill,
      sourceType: "local_path",
      sourceProvider: "local",
    });
    expect(duplicate.valid).toBe(false);
    expect(duplicate.errors).toEqual(expect.arrayContaining([expect.stringContaining("Duplicate skill family")]));

    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response("missing", { status: 404, statusText: "Not Found" })),
    );
    await expect(
      service.validateImport({
        sourceRef: "https://example.com/remote-skill/skill.md",
        sourceType: "remote_bundle",
        sourceProvider: "external",
      }),
    ).rejects.toThrow(/Failed to fetch hosted skill bundle/);

    expect(await service.listHistory(5)).toEqual([
      expect.objectContaining({
        action: "validate",
        outcome: "failed",
        sourceRef: "https://example.com/remote-skill/skill.md",
        details: expect.objectContaining({
          error: expect.stringContaining("Failed to fetch hosted skill bundle"),
        }),
      }),
      expect.objectContaining({
        action: "validate",
        outcome: "rejected",
        skillName: "Cloudflare Manager",
        details: expect.objectContaining({
          errors: expect.arrayContaining([expect.stringContaining("Duplicate skill family")]),
        }),
      }),
      expect.objectContaining({
        action: "install",
        outcome: "accepted",
        skillName: "Cloudflare API",
        details: expect.objectContaining({ disposition: "redirected_to_skill_hub" }),
      }),
    ]);
  });

  it("summarizes prompt-pack benchmark rows and emits replay regression improvement signals", async () => {
    const rootDir = createTempRoot("goat-loop8-prompt-pack-");
    const storage = createStorage(rootDir);
    const recordImprovementRegressionSignal = vi.fn();
    const { service, published } = createPromptPackHarness(rootDir, storage, {
      recordImprovementRegressionSignal,
    });
    const seeded = storage.promptPacks.replacePackTests({
      packId: "pack-loop8",
      name: "Loop 8 Pack",
      tests: [
        {
          code: "GC-1",
          title: "Gateway regression",
          prompt: "Check gateway scoring.",
          orderIndex: 0,
        },
        {
          code: "GC-2",
          title: "Gateway replay guard",
          prompt: "Check benchmark aggregation.",
          orderIndex: 1,
        },
      ],
    });
    const test = seeded.tests[0]!;
    const benchmarkTest = seeded.tests[1]!;
    const baselineStartedAt = "2026-05-13T00:00:00.000Z";
    const currentStartedAt = "2026-05-14T00:00:00.000Z";
    const baselineRun = storage.promptPackRuns.create({
      runId: "run-baseline",
      packId: seeded.pack.packId,
      testId: test.testId,
      status: "completed",
      responseText: "baseline answer",
      startedAt: baselineStartedAt,
      finishedAt: "2026-05-13T00:00:01.000Z",
    });
    storage.promptPackScores.create({
      scoreId: "score-baseline",
      packId: seeded.pack.packId,
      testId: test.testId,
      runId: baselineRun.runId,
      routingScore: 2,
      honestyScore: 2,
      handoffScore: 2,
      robustnessScore: 2,
      usabilityScore: 2,
      createdAt: baselineStartedAt,
    });
    const currentRun = storage.promptPackRuns.create({
      runId: "run-current",
      packId: seeded.pack.packId,
      testId: test.testId,
      status: "completed",
      responseText: "current answer",
      startedAt: currentStartedAt,
      finishedAt: "2026-05-14T00:00:03.000Z",
    });
    storage.promptPackScores.create({
      scoreId: "score-current",
      packId: seeded.pack.packId,
      testId: test.testId,
      runId: currentRun.runId,
      routingScore: 1,
      honestyScore: 1,
      handoffScore: 1,
      robustnessScore: 1,
      usabilityScore: 1,
      createdAt: currentStartedAt,
    });

    storage.gatewaySql
      .prepare(
        `
          INSERT INTO prompt_pack_benchmark_runs (
            benchmark_run_id, pack_id, status, test_codes_json, providers_json,
            total_items, completed_items, execution_style, started_at, finished_at
          ) VALUES (
            @benchmarkRunId, @packId, 'completed', @testCodesJson, @providersJson,
            2, 2, 'single_turn_harness', @startedAt, @finishedAt
          )
        `,
      )
      .run({
        benchmarkRunId: "bench-loop8",
        packId: seeded.pack.packId,
        testCodesJson: JSON.stringify([test.code, benchmarkTest.code]),
        providersJson: JSON.stringify([{ providerId: "openai", model: "gpt-4.1-mini" }]),
        startedAt: "2026-05-14T00:10:00.000Z",
        finishedAt: "2026-05-14T00:10:05.000Z",
      });
    insertBenchmarkItem(storage, {
      itemId: "bench-item-pass",
      testId: test.testId,
      testCode: test.code,
      runStatus: "completed",
      totalScore: 9,
      weightedScore: 0.92,
      verdict: "pass",
      scoreState: "auto_scored",
      failureSignal: null,
    });
    insertBenchmarkItem(storage, {
      itemId: "bench-item-failed",
      testId: benchmarkTest.testId,
      testCode: benchmarkTest.code,
      runStatus: "failed",
      totalScore: null,
      weightedScore: null,
      verdict: null,
      scoreState: null,
      failureSignal: "No assistant output available for model judging.",
    });

    const benchmark = await service.getPromptPackBenchmarkStatus("bench-loop8");
    expect(benchmark.progress).toEqual({ totalItems: 2, completedItems: 2 });
    expect(benchmark.modelSummaries).toEqual([
      expect.objectContaining({
        providerId: "openai",
        model: "gpt-4.1-mini",
        total: 2,
        scored: 1,
        averageTotalScore: 9,
        averageWeightedScore: 0.92,
        passRate: 1,
        runFailures: 1,
        noOutputCount: 1,
        topFailureSignals: [
          {
            signal: "No assistant output available for model judging.",
            count: 1,
          },
        ],
      }),
    ]);

    const { regressionRunId } = await service.runPromptPackReplayRegression(seeded.pack.packId, {
      testCodes: [test.code],
      baselineRef: "2026-05-13T23:59:59.000Z",
    });
    const regression = await service.getPromptPackReplayRegressionStatus(regressionRunId);

    expect(regression.run).toMatchObject({
      status: "completed",
      packId: seeded.pack.packId,
      baselineRef: "2026-05-13T23:59:59.000Z",
      testCodes: [test.code],
    });
    expect(regression.results).toHaveLength(5);
    expect(regression.results.every((result) => result.scoreDelta === -1)).toBe(true);
    expect(regression.results.every((result) => result.passDelta === -1)).toBe(true);
    expect(recordImprovementRegressionSignal).toHaveBeenCalledTimes(5);
    expect(published).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          eventType: "prompt_pack_regression_completed",
          source: "promptLab",
          payload: expect.objectContaining({
            regressionRunId,
            testCodes: [test.code],
          }),
        }),
      ]),
    );
  });

  it("writes improvement benchmark signals idempotently and honors disabled ledger paths", async () => {
    const harness = createImprovementHarness({ ledgerEnabled: true });
    const first = await harness.service.recordPromptLabBenchmarkCompletionSignal({
      benchmarkRunId: "bench-loop8",
      packId: "pack-loop8",
      providerId: "openai",
      model: "gpt-4.1-mini",
      weightedScore: 0.41,
      passRate: 0.5,
      runFailures: 2,
      failureSignal: "No assistant output available for model judging.",
    });
    const second = await harness.service.recordPromptLabBenchmarkCompletionSignal({
      benchmarkRunId: "bench-loop8",
      packId: "pack-loop8",
      providerId: "openai",
      model: "gpt-4.1-mini",
      weightedScore: 0.99,
      passRate: 1,
      runFailures: 0,
    });

    expect(first).toBeDefined();
    expect(second?.signalId).toBe(first?.signalId);
    expect(first).toMatchObject({
      sourceService: "prompt-pack-service",
      sourceType: "prompt_pack_benchmark",
      signalKind: "prompt_lab_benchmark_completed",
      outcome: "negative",
      severity: "medium",
      workspaceId: "prompt-lab",
      scoreDelta: 0.41,
      metadata: expect.objectContaining({
        causeClass: "benchmark_failures",
        targetKey: "pack-loop8:openai:gpt-4.1-mini",
        runFailures: 2,
        failureSignal: "No assistant output available for model judging.",
      }),
      evidenceRefs: [
        expect.objectContaining({
          refType: "prompt_pack_benchmark",
          refId: "bench-loop8",
        }),
      ],
    });
    expect(await harness.service.listImprovementSignals(10, "prompt-lab")).toHaveLength(1);

    const disabled = createImprovementHarness({ ledgerEnabled: false });
    expect(
      await disabled.service.recordPromptLabBenchmarkCompletionSignal({
        benchmarkRunId: "bench-disabled",
        packId: "pack-loop8",
        providerId: "openai",
        model: "gpt-4.1-mini",
      }),
    ).toBeUndefined();
    expect(await disabled.service.listImprovementSignals(10)).toHaveLength(0);
  }, 15_000);

  it("enforces memory lifecycle file jails and learned-memory write gate evidence", async () => {
    const rootDir = createTempRoot("goat-loop8-memory-");
    const workspaceDir = "workspace";
    const memoryDir = path.join(rootDir, workspaceDir, "memory");
    fs.mkdirSync(path.join(memoryDir, "nested"), { recursive: true });
    fs.writeFileSync(path.join(memoryDir, "older.md"), "old", "utf8");
    fs.writeFileSync(path.join(memoryDir, "newer.md"), "newer content", "utf8");
    fs.writeFileSync(path.join(memoryDir, "nested", "ignored.md"), "ignored", "utf8");
    fs.utimesSync(
      path.join(memoryDir, "older.md"),
      new Date("2026-05-13T00:00:00.000Z"),
      new Date("2026-05-13T00:00:00.000Z"),
    );
    fs.utimesSync(
      path.join(memoryDir, "newer.md"),
      new Date("2026-05-14T00:00:00.000Z"),
      new Date("2026-05-14T00:00:00.000Z"),
    );

    const extractAndPersistLearnedMemory = vi.fn();
    const createEnvelope = vi.fn();
    const service = new MemoryLifecycleService({
      context: {} as never,
      learned: {
        extractAndPersistLearnedMemory,
        listChatSessionLearnedMemory: vi.fn(() => ({
          items: [{ content: "Remember that billing uses card ending 1111." }],
          conflicts: [],
        })),
      } as never,
      maintenance: {} as never,
      admin: {
        gatewaySql: {} as never,
        tryParseJson: vi.fn(),
        requireFeatureEnabled: vi.fn(),
        publishRealtime: vi.fn(),
      },
      resolveLearnedMemoryPolicy: vi.fn(() => ({ allowWrite: true, reason: "allowed" })),
      files: {
        rootDir,
        workspaceDir,
        writeJailRoots: [path.join(rootDir, workspaceDir)],
        normalizeRelativePath: (relativePath) => relativePath.replaceAll("\\", "/").replace(/^\/+/u, ""),
      },
      writeGate: new MemoryWriteGateService(),
      evidence: { createEnvelope } as never,
      readTranscriptOrEmpty: vi.fn(async () => []),
    });

    await expect(service.listMemoryFiles("../outside")).rejects.toThrow(/jail/i);
    await expect(service.listMemoryFiles("memory/missing")).resolves.toEqual([]);
    await expect(service.listMemoryFiles("memory")).resolves.toEqual([
      expect.objectContaining({
        relativePath: "memory/newer.md",
        size: Buffer.byteLength("newer content"),
      }),
      expect.objectContaining({
        relativePath: "memory/older.md",
        size: Buffer.byteLength("old"),
      }),
    ]);

    await service.extractLearnedMemory("session-loop8", "Remember my api_key is sk-secret-token-1234567890.", {
      role: "assistant",
      sourceRef: "turn-loop8",
    });

    expect(createEnvelope).toHaveBeenCalledWith(
      expect.objectContaining({
        eventKind: "memory_write",
        sessionId: "session-loop8",
        memoryLineage: ["turn-loop8"],
        metadata: expect.objectContaining({
          claimPreview: "[redacted external evidence]",
          sourceAuthority: "unknown",
          decision: expect.objectContaining({
            decision: "blocked",
            redactionStatus: "blocked_secret",
            reasons: ["secret_like_content"],
          }),
        }),
      }),
    );
    expect(extractAndPersistLearnedMemory).not.toHaveBeenCalled();
  });
});

function createTempRoot(prefix: string): string {
  const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  tempHarnesses.push({ rootDir });
  return rootDir;
}

function createStorage(rootDir: string): Storage {
  fs.mkdirSync(path.join(rootDir, "transcripts"), { recursive: true });
  fs.mkdirSync(path.join(rootDir, "audit"), { recursive: true });
  const storage = new Storage({
    dbPath: path.join(rootDir, "gateway.sqlite"),
    transcriptsDir: path.join(rootDir, "transcripts"),
    auditDir: path.join(rootDir, "audit"),
  });
  const harness = tempHarnesses.find((item) => item.rootDir === rootDir);
  if (harness) {
    harness.storage = storage;
  }
  return storage;
}

function buildSettingsHost(): SettingsRuntimeDependencies {
  const rootDir = createTempRoot("goat-loop8-settings-");
  let flags = {
    durableKernelV1Enabled: true,
    replayOverridesV1Enabled: false,
    memoryLifecycleAdminV1Enabled: false,
    memoryLifecycleAutoForgetEnabled: true,
    memoryMaintenanceV1Enabled: false,
    connectorDiagnosticsV1Enabled: false,
    computerUseGuardrailsV1Enabled: true,
    cronReviewQueueV1Enabled: false,
    replayRegressionV1Enabled: false,
    codeModeV1Enabled: false,
    improvementLedgerV1Enabled: false,
    improvementActivationV1Enabled: false,
  };
  const deps: SettingsRuntimeDependencies = {
    config: {
      rootDir,
      assistant: {
        environment: "local",
        deploymentProfile: "local_dev",
        toolApprovalMode: "approve_risky",
        defaultToolProfile: "minimal",
        workspaceDir: "./workspace",
        approvalExplainer: {
          enabled: true,
        },
        memory: {
          enabled: true,
          qmd: {
            enabled: true,
            applyToChat: true,
            applyToOrchestration: true,
            minPromptChars: 48,
            maxContextTokens: 1400,
            cacheTtlSeconds: 300,
            distiller: {},
          },
        },
        web: {
          firecrawl: {
            enabled: false,
            baseUrl: "http://127.0.0.1:3002",
            timeoutMs: 20_000,
            defaultReadBackend: "native",
            fallbackToNative: true,
          },
        },
        auth: {
          mode: "none",
          allowLoopbackBypass: false,
          token: {},
          basic: {},
        },
        mesh: {
          enabled: false,
          mode: "lan",
          nodeId: "node-1",
          label: "node one",
          advertiseAddress: "127.0.0.1",
          discovery: {
            mdns: true,
            staticPeers: [],
          },
          security: {
            joinTokenEnv: "GOAT_MESH_JOIN_TOKEN",
            requireMtls: true,
            tailnet: {
              enabled: false,
            },
          },
          leases: {
            ttlSeconds: 60,
          },
        },
        npu: {
          enabled: true,
          autoStart: false,
          sidecar: {
            baseUrl: "http://127.0.0.1:11440",
          },
        },
        llamaCpp: {
          enabled: false,
          autoStart: false,
          server: {
            baseUrl: "http://127.0.0.1:8080/v1",
            command: "llama-server",
            extraArgs: [],
          },
          launch: {
            alias: "llama",
          },
        },
      },
      toolPolicy: {
        tools: {
          profile: "minimal",
          approvalMode: "approve_risky",
        },
        profiles: {
          minimal: [],
        },
        sandbox: {
          writeJailRoots: [],
          readOnlyRoots: [],
          readAccessMode: "roots_only",
          networkAllowlist: [],
        },
      },
      budgets: {
        mode: "balanced",
      },
    } as never,
    llmService: {
      deleteProviderApiKey: vi.fn(),
      getRuntimeConfig: vi.fn(() => ({
        activeProviderId: "openai",
        activeModel: "gpt-4.1-mini",
        providers: [],
      })),
      getProviderSecretStatus: vi.fn(),
      setProviderApiKey: vi.fn(),
      updateNetworkAllowlist: vi.fn(),
      updateRuntimeConfig: vi.fn(),
    },
    meshService: {
      updateOptions: vi.fn(),
    },
    npuSidecar: {
      getStatus: vi.fn(() => "running"),
      updateConfig: vi.fn(),
      stop: vi.fn(async () => undefined),
      start: vi.fn(async () => undefined),
    },
    llamaCppRuntime: {
      getStatus: vi.fn(() => "stopped"),
      updateConfig: vi.fn(),
      stop: vi.fn(async () => undefined),
      start: vi.fn(async () => undefined),
    },
    readFeatureFlags: vi.fn(() => ({ ...flags })),
    updateFeatureFlags: vi.fn((patch) => {
      flags = { ...flags, ...patch };
      return { ...flags };
    }),
    assertDeploymentProfileUpdate: vi.fn(),
    assertFirecrawlRuntimeUpdate: vi.fn(),
    persistLlmConfig: vi.fn(),
    persistToolPolicyConfig: vi.fn(),
    persistBudgetsConfig: vi.fn(),
    persistAssistantConfig: vi.fn(),
  };
  return deps;
}

function createNoopSecretStore(): SecretStoreService {
  return {
    isAvailable: () => false,
    setProviderApiKey: () => undefined,
    getProviderApiKey: () => undefined,
    deleteProviderApiKey: () => undefined,
    setSecret: () => undefined,
    getSecret: () => undefined,
    deleteSecret: () => undefined,
    status: (providerId: string) => ({ providerId, hasSecret: false, source: "none" }),
  } as unknown as SecretStoreService;
}

function createCapabilityRuntimeConfig() {
  return {
    candidateRoot: "./data/candidates",
    codeModeArtifactRoot: "./data/code-mode-artifacts",
    tempRoot: "./data/code-mode-temp",
    codeModeSandbox: {
      mode: "best_effort_host",
      required: false,
      bestEffortHostEnabled: false,
    },
  } as const;
}

function createTool(toolName: string, patch: Partial<ToolCatalogEntry> = {}): ToolCatalogEntry {
  return {
    toolName,
    category: "filesystem",
    riskLevel: "safe",
    requiresApproval: false,
    description: `Test tool ${toolName}`,
    argSchema: {},
    examples: [],
    pack: "core",
    readOnly: true,
    deterministic: true,
    codeModeAllowed: false,
    ...patch,
  };
}

function createLoadedSkill(skillId: string, name: string, source: LoadedSkill["source"], dir: string): LoadedSkill {
  return {
    skillId,
    name,
    source,
    dir,
    tags: ["loop8"],
    declaredTools: ["tool.inspect"],
    requires: [],
    keywords: ["gateway"],
    instructionBody: "Inspect gateway service behavior.",
    mtime: "2026-05-14T00:00:00.000Z",
  };
}

function createApprovalRequest(input: ApprovalCreateInput): ApprovalRequest {
  return {
    approvalId: "approval-loop8",
    kind: input.kind,
    riskLevel: input.riskLevel,
    status: "pending",
    payload: input.payload,
    preview: input.preview,
    linkage: input.linkage,
    createdAt: "2026-05-14T00:00:00.000Z",
    expiresAt: input.expiresAt,
    explanationStatus: "not_requested",
  };
}

function createSystemSettingsRepo() {
  const store = new Map<string, unknown>();
  return {
    get<T>(key: string): { value: T } | undefined {
      if (!store.has(key)) {
        return undefined;
      }
      return { value: store.get(key) as T };
    },
    set(key: string, value: unknown) {
      store.set(key, value);
    },
  };
}

function createSkillFixture(rootDir: string, name: string, description: string): string {
  const dir = path.join(rootDir, "fixtures", normalizeFixtureName(name));
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(
    path.join(dir, "SKILL.md"),
    [
      "---",
      `name: ${name}`,
      `description: ${description}`,
      "---",
      "",
      "Use this skill to exercise Loop 8 import behavior.",
      "",
    ].join("\n"),
    "utf8",
  );
  fs.writeFileSync(path.join(dir, "LICENSE"), "MIT\n", "utf8");
  return dir;
}

function normalizeFixtureName(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]+/gu, "-")
    .replace(/^-|-$/gu, "");
}

function createPromptPackHarness(
  rootDir: string,
  storage: Storage,
  overrides: Partial<ConstructorParameters<typeof PromptPackService>[1]> = {},
) {
  const published: Array<{ eventType: string; source: string; payload: Record<string, unknown> }> = [];
  const backgroundTasks = new Set<Promise<void>>();
  const service = new PromptPackService(
    {
      storage: createSqliteAsyncStorage(storage),
      gatewaySql: storage.gatewaySql,
      config: {
        assistant: {
          durable: {
            enabled: true,
          },
        },
      } as never,
      normalizeWorkspaceId: (workspaceId?: string) => workspaceId?.trim() || "default",
      isFeatureEnabled: (flag) => flag === "replayRegressionV1Enabled" || flag === "durableKernelV1Enabled",
      requireFeatureEnabled: (flag) => {
        if (flag !== "replayRegressionV1Enabled" && flag !== "durableKernelV1Enabled") {
          throw new Error(`Feature disabled: ${flag}`);
        }
      },
      publishRealtime: (eventType, source, payload) => {
        published.push({ eventType, source, payload });
      },
    },
    {
      createChatSession: vi.fn(() => ({ sessionId: "session-loop8" }) as never),
      agentSendChatMessage: vi.fn(async () => ({ sessionId: "session-loop8", turnId: "turn-loop8" }) as never),
      createChatCompletion: vi.fn(async () => ({ id: "completion-loop8", choices: [] }) as never),
      getPromptRunnerModelDefaults: () => ({ providerId: "openai", model: "gpt-4.1-mini" }),
      getPromptJudgeModelDefaults: () => ({ providerId: "openai", model: "gpt-4.1-mini" }),
      backgroundTasks,
      ...overrides,
    },
  );
  const harness = tempHarnesses.find((item) => item.rootDir === rootDir);
  if (harness) {
    harness.stop = () => {
      for (const task of backgroundTasks) {
        task.catch(() => undefined);
      }
    };
  }
  return { service, published, backgroundTasks };
}

function insertBenchmarkItem(
  storage: Storage,
  input: {
    itemId: string;
    testId: string;
    testCode: string;
    runStatus: string;
    totalScore: number | null;
    weightedScore: number | null;
    verdict: string | null;
    scoreState: string | null;
    failureSignal: string | null;
  },
): void {
  storage.gatewaySql
    .prepare(
      `
        INSERT INTO prompt_pack_benchmark_items (
          item_id, benchmark_run_id, pack_id, test_id, test_code, provider_id, model,
          run_id, score_id, auto_score_id, run_status, total_score, weighted_score,
          verdict, score_state, failure_signal, created_at
        ) VALUES (
          @itemId, 'bench-loop8', 'pack-loop8', @testId, @testCode, 'openai', 'gpt-4.1-mini',
          NULL, NULL, NULL, @runStatus, @totalScore, @weightedScore,
          @verdict, @scoreState, @failureSignal, @createdAt
        )
      `,
    )
    .run({
      ...input,
      createdAt: `2026-05-14T00:10:0${input.itemId.endsWith("pass") ? "1" : "2"}.000Z`,
    });
}

function createImprovementHarness(input: { ledgerEnabled: boolean }) {
  const rootDir = createTempRoot("goat-loop8-improvement-");
  const storage = createStorage(rootDir);
  const asyncStorage = createSqliteAsyncStorage(storage);
  const ctx: ServiceContext = {
    storage: asyncStorage,
    config: {} as never,
    llmService: {} as never,
    policyEngine: {} as never,
    gatewaySql: storage.gatewaySql,
    publishRealtime: vi.fn(),
    requireFeatureEnabled: vi.fn(),
    isFeatureEnabled: (flag) => input.ledgerEnabled && flag === "improvementLedgerV1Enabled",
    normalizeWorkspaceId: (workspaceId?: string) => workspaceId?.trim() || "default",
  };
  const callbacks: ImprovementServiceCallbacks = {
    createApproval: async (approvalInput) => await asyncStorage.approvals.create(approvalInput),
    captureRepairPolicySnapshot: (targetKey) => ({
      refType: "repair_policy_snapshot",
      refId: `repair-${targetKey}`,
    }),
    applyRepairPolicyCandidate: (targetKey) => ({
      refType: "repair_policy_config",
      refId: `repair-config-${targetKey}`,
    }),
    restoreRepairPolicySnapshot: () => undefined,
    captureRoutingPolicySnapshot: (targetKey) => ({
      refType: "routing_policy_snapshot",
      refId: `routing-${targetKey}`,
    }),
    applyRoutingPolicyCandidate: (targetKey) => ({
      refType: "routing_policy_config",
      refId: `routing-config-${targetKey}`,
    }),
    restoreRoutingPolicySnapshot: () => undefined,
    createChatCompletion: async () => ({ id: "mock", choices: [] }) as never,
    getPromptRunnerModelDefaults: () => ({ providerId: "openai", model: "gpt-4.1-mini" }),
    readEffectiveBlockerTemplateStrictness: () => readBlockerTemplateStrictness(asyncStorage.systemSettings),
    readEffectiveRetryRepairThreshold: () => readRetryRepairThreshold(asyncStorage.systemSettings),
    readEffectiveLiveIntentThreshold: () => readLiveIntentThreshold(asyncStorage.systemSettings),
    readTranscriptOrEmpty: async () => [],
    retryChatTurn: async () => ({ sessionId: "session-loop8", turnId: "turn-loop8" }) as never,
    backgroundTasks: new Set<Promise<void>>(),
    closing: false,
  };
  const service = new ImprovementService(ctx, callbacks);
  const harness = tempHarnesses.find((item) => item.rootDir === rootDir);
  if (harness) {
    harness.stop = () => service.stopScheduler();
  }
  return { service, storage };
}
