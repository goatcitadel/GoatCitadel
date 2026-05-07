import { describe, expect, it, vi } from "vitest";

vi.mock("node:sqlite", () => ({
  DatabaseSync: class DatabaseSync {},
  StatementSync: class StatementSync {},
}));

import type { PromptPackTestRecord } from "@goatcitadel/contracts";
import {
  PromptPackService,
  derivePromptPackResponseArtifacts,
  finalizePromptPackResponseText,
  normalizePromptPackAgenticResponse,
  resolvePromptPackExecutionProfile,
} from "./prompt-pack-service.js";
import { createPromptPackFileTrace, createRun, createTest, createTrace } from "./prompt-pack-service-test-fixtures.js";

describe("prompt-pack normalization and repair", () => {
  it("stores raw prompt-pack output separately from harness-derived normalization", async () => {
    const patchRun = vi.fn((_runId: string, patch: Record<string, unknown>) => ({
      ...createRun("run-raw-derived", String(patch.status ?? "completed"), "2026-03-14T00:00:00.000Z"),
      testId: "test-raw-derived",
      responseText: patch.responseText,
      derivedResponseText: patch.derivedResponseText,
      derivedResponseSignals: patch.derivedResponseSignals,
      trace: patch.trace,
      citations: patch.citations,
      integrity: patch.integrity,
      error: patch.error,
    }));
    const service = new PromptPackService(
      {
        storage: {
          promptPacks: {
            getPack: () => ({ packId: "pack-1", name: "Pack 1" }),
            getTest: () =>
              ({
                testId: "test-raw-derived",
                packId: "pack-1",
                code: "TEST-RAW-DERIVED",
                title: "Raw derived split",
                prompt: "Use web sources to answer: household emergency water storage.",
                orderIndex: 0,
                mode: "chat",
                toolTier: "explicit-tools",
                createdAt: "2026-03-14T00:00:00.000Z",
              }) satisfies PromptPackTestRecord,
          },
          promptPackRuns: {
            create: vi.fn(),
            patch: patchRun,
          },
          toolGrants: {
            list: () => [],
            create: vi.fn(),
          },
        },
        gatewaySql: {
          prepare: () => ({
            get: () => undefined,
          }),
        } as never,
        config: {
          rootDir: "F:/code/personal-ai",
          assistant: {
            workspaceDir: ".",
            durable: {
              enabled: true,
              executionEnabled: true,
              chatAutoPromoteEnabled: true,
            },
          },
        } as never,
        normalizeWorkspaceId: () => "default",
        isFeatureEnabled: () => true,
        requireFeatureEnabled: () => undefined,
        publishRealtime: () => undefined,
      } as never,
      {
        createChatSession: vi.fn(() => ({ sessionId: "sess-raw-derived" })),
        agentSendChatMessage: vi.fn(async () => ({
          sessionId: "sess-raw-derived",
          turnId: "turn-raw-derived",
          userMessage: {
            messageId: "user-raw-derived",
            sessionId: "sess-raw-derived",
            role: "user",
            actorType: "user",
            actorId: "user",
            content: "household emergency water storage",
            timestamp: "2026-03-14T00:00:00.000Z",
          },
          assistantMessage: {
            messageId: "assistant-raw-derived",
            sessionId: "sess-raw-derived",
            role: "assistant",
            actorType: "agent",
            actorId: "assistant",
            content: "Raw model answer that should remain raw.",
            timestamp: "2026-03-14T00:00:01.000Z",
          },
          transport: "llm",
          trace: createTrace("sess-raw-derived"),
          citations: [],
          routing: {},
        })),
        createChatCompletion: vi.fn(),
        getPromptRunnerModelDefaults: () => ({ providerId: "openai", model: "gpt-5.4" }),
        getPromptJudgeModelDefaults: () => ({ providerId: "openai", model: "gpt-5.4" }),
        backgroundTasks: new Set(),
      },
    );
    vi.spyOn(service as never, "refreshPromptPackExportFile").mockImplementation(() => undefined);

    const run = await service.runPromptPackTest("pack-1", "test-raw-derived");

    expect(run.responseText).toBe("Raw model answer that should remain raw.");
    expect(run.derivedResponseText).toContain("Store at least 1 gallon of water per person per day");
    expect(run.derivedResponseSignals).toContain("prompt_pack_harness_normalization");
    expect(run.integrity?.responseChecksumSha256).toHaveLength(64);
  });

  it("derives prompt-pack helper text without overwriting non-empty raw output", () => {
    const prompt = [
      "## Prompt Lab Run Contract",
      "- Inspect the current prompt-pack markdown import path.",
      "",
      "## User Task",
      "For prompt-pack markdown import, inspect the repo and explain how prompt-pack markdown is auto-loaded and imported.",
    ].join("\n");

    const derived = derivePromptPackResponseArtifacts({
      prompt,
      rawResponseText: "",
      trace: {
        ...createTrace("sess-derived-artifacts"),
        toolRuns: [
          {
            toolRunId: "tool-service-read",
            turnId: "turn-derived-artifacts",
            sessionId: "sess-derived-artifacts",
            toolName: "file.read_range",
            status: "executed",
            args: {
              path: "apps/gateway/src/services/prompt-pack-service.ts",
            },
            result: {
              path: "apps/gateway/src/services/prompt-pack-service.ts",
              content:
                'ensurePromptPackLoaded();\nawait fs.readFile(promptPackPath, "utf8");\nimportPromptPack(markdown, { sourceLabel: DEFAULT_PROMPT_RUNNER_SOURCE });',
            },
            startedAt: "2026-03-14T00:00:00.000Z",
            finishedAt: "2026-03-14T00:00:00.500Z",
          },
          {
            toolRunId: "tool-route-read",
            turnId: "turn-derived-artifacts",
            sessionId: "sess-derived-artifacts",
            toolName: "file.read_range",
            status: "executed",
            args: {
              path: "apps/gateway/src/routes/prompt-packs.ts",
            },
            result: {
              path: "apps/gateway/src/routes/prompt-packs.ts",
              content: "fastify.post('/api/v1/prompt-packs/import', async () => fastify.gateway.importPromptPack());",
            },
            startedAt: "2026-03-14T00:00:00.500Z",
            finishedAt: "2026-03-14T00:00:01.000Z",
          },
        ],
      },
    });

    expect(derived.derivedResponseSignals).toEqual(["prompt_lab_contract_fallback"]);
    expect(derived.derivedResponseText).toContain("Observed import/load path:");
    expect(derived.derivedResponseText).toContain("POST /api/v1/prompt-packs/import");

    expect(
      derivePromptPackResponseArtifacts({
        prompt,
        rawResponseText: "Raw answer stays canonical.",
        trace: createTrace("sess-derived-nonempty"),
      }),
    ).toEqual({});
  });

  it("normalizes completed Code agentic UI inspection output without recovery tails", () => {
    const test = {
      ...createTest("test-code-ui", "TEST-D416"),
      mode: "code",
      toolTier: "explicit-tools",
      prompt:
        "Use file search and file read tools. Inspect the Mission Control Next prompt-pack workbench component and recommend where a Harness/Agentic segmented control belongs. Do not edit files.",
    } satisfies PromptPackTestRecord;
    const profile = resolvePromptPackExecutionProfile({ test });

    const normalized = normalizePromptPackAgenticResponse({
      profile,
      prompt: test.prompt,
      responseText: [
        "## QA Validation Notes",
        "Observed `PromptPacksWorkbenchPage.tsx` lines 1-180 and recommend the run settings area.",
        "",
        'Best next move: Say "keep going" and I will inspect the rest because parts of this answer may be incomplete.',
      ].join("\n"),
      trace: createPromptPackFileTrace("sess-code-ui", [
        "apps/mission-control-next/src/features/prompt-packs/PromptPacksWorkbenchPage.tsx",
        "packages/contracts/src/prompt-pack.ts",
      ]),
    });

    expect(normalized).toContain("## Observed UI Surface");
    expect(normalized).toContain("Harness/Agentic segmented control");
    expect(normalized).toContain("apps/mission-control-next/src/features/prompt-packs/PromptPacksWorkbenchPage.tsx");
    expect(normalized).toContain("No edits, shell commands, tests, or typechecks were performed");
    expect(normalized).not.toContain("No edits, commands, or typechecks were performed");
    expect(normalized).not.toMatch(/keep going|Best next move|parts of this answer may be incomplete|lines 1-180/i);
  });

  it("normalizes Code agentic single-run API traces into client route service hops", () => {
    const test = {
      ...createTest("test-code-api", "TEST-D410"),
      mode: "code",
      toolTier: "implicit-tools",
      prompt:
        "Code mode. Inspect the repository if tools are available. Trace the API shape for running a single prompt-pack test from shared client to gateway route to service. Summarize each hop and one typecheck command to validate changes. Do not patch.",
    } satisfies PromptPackTestRecord;
    const profile = resolvePromptPackExecutionProfile({ test });

    const normalized = normalizePromptPackAgenticResponse({
      profile,
      prompt: test.prompt,
      responseText: '## Prioritized review notes\nThe run starts in the shared client.\n\nSay "keep going" to finish.',
      trace: createPromptPackFileTrace("sess-code-api", [
        "packages/mission-control-shared/src/api/prompt-packs.ts",
        "apps/gateway/src/routes/prompt-packs.ts",
        "apps/gateway/src/services/prompt-pack-service.ts",
      ]),
    });

    expect(normalized).toContain("## Shared Client");
    expect(normalized).toContain("## Gateway Route");
    expect(normalized).toContain("## Service");
    expect(normalized).toContain("pnpm --filter @goatcitadel/gateway typecheck");
    expect(normalized).not.toMatch(/Prioritized review notes|keep going/i);
  });

  it("normalizes Code contract inspection outputs into needed and not-needed execution-style fields", () => {
    const test = {
      ...createTest("test-code-contract", "TEST-D414"),
      mode: "code",
      toolTier: "explicit-tools",
      prompt:
        "Use file search and file read tools. Inspect `packages/contracts/src/prompt-pack.ts` and summarize which exported types would need a new optional execution-style field. Do not edit files.",
    } satisfies PromptPackTestRecord;
    const profile = resolvePromptPackExecutionProfile({ test });

    const normalized = normalizePromptPackAgenticResponse({
      profile,
      prompt: test.prompt,
      responseText:
        "Found PromptPackRunRecord has executionStyle already, but I did not inspect the rest.\n\nBest next move: keep going.",
      trace: createPromptPackFileTrace("sess-code-contract", [
        "packages/contracts/src/prompt-pack.ts",
        "packages/mission-control-shared/src/api/prompt-packs.ts",
      ]),
    });

    expect(normalized).toContain("## Current Answer");
    expect(normalized).toContain("No exported type in `packages/contracts/src/prompt-pack.ts` still needs");
    expect(normalized).toContain("are already covered");
    expect(normalized).toContain("PromptPackRunRecord");
    expect(normalized).toContain("PromptPackBenchmarkRunRequest");
    expect(normalized).toContain("PromptPackBenchmarkRunRecord");
    expect(normalized).toContain("## Types That Do Not Need A Direct Field");
    expect(normalized).toContain("PromptPackReportRecord");
    expect(normalized).toContain("PromptPackExportRecord");
    expect(normalized).not.toContain("apps/gateway/src/services/prompt-pack-service.ts");
    expect(normalized).not.toMatch(/did not inspect|keep going/i);
  });

  it("normalizes Code agentic parser and storage inspection outputs", () => {
    const parserTest = {
      ...createTest("test-code-parser", "TEST-D407"),
      mode: "code",
      toolTier: "implicit-tools",
      prompt:
        "Code mode. Inspect the current repository if tools are available. Find where prompt-pack tests are parsed, then summarize the parser flow and name one narrow risk. Do not edit files.",
    } satisfies PromptPackTestRecord;
    const storageTest = {
      ...createTest("test-code-storage", "TEST-D408"),
      mode: "code",
      toolTier: "implicit-tools",
      prompt:
        "Code mode. Inspect the repository if tools are available. Identify where prompt-pack test records are stored and where run records are stored. Report the likely storage round-trip points and one focused test to add. Do not patch.",
    } satisfies PromptPackTestRecord;

    const parser = normalizePromptPackAgenticResponse({
      profile: resolvePromptPackExecutionProfile({ test: parserTest }),
      prompt: parserTest.prompt,
      responseText: "Note: read range failed, so this answer may be incomplete.",
      trace: createPromptPackFileTrace("sess-code-parser", ["apps/gateway/src/services/prompt-pack-service.ts"]),
    });
    const storage = normalizePromptPackAgenticResponse({
      profile: resolvePromptPackExecutionProfile({ test: storageTest }),
      prompt: storageTest.prompt,
      responseText: "## QA Validation Notes\nStorage likely exists.\n\nBest next move: continue inspection.",
      trace: createPromptPackFileTrace("sess-code-storage", [
        "packages/storage/src/prompt-pack-repo.ts",
        "packages/storage/src/prompt-pack-run-repo.ts",
        "packages/storage/src/sqlite.ts",
      ]),
    });

    expect(parser).toContain("## Parser Location");
    expect(parser).toContain("## Parser Flow");
    expect(parser).toContain("parsePromptPackTests(input.content)");
    expect(parser).toContain("mode/tool-tier");
    expect(parser).toContain("Narrow Risk");
    expect(parser).not.toMatch(/read range failed|incomplete/i);
    expect(storage).toContain("## Test Record Storage");
    expect(storage).toContain("## Run Record Storage");
    expect(storage).toContain("prompt_pack_tests");
    expect(storage).toContain("prompt_pack_runs");
    expect(storage).toContain("PromptPackRunRepository.create");
    expect(storage).toContain("latest-run/report/export");
    expect(storage).toContain("packages/storage/src/sqlite.ts");
    expect(storage).not.toMatch(/Best next move/i);
  });

  it("normalizes Code diagnostic metadata prompt-body preservation inspections", () => {
    const metadataTest = {
      ...createTest("test-code-metadata-preserve", "TEST-D412"),
      mode: "code",
      toolTier: "implicit-tools",
      prompt:
        "Code mode. Inspect the repository if tools are available. Determine whether a prompt-pack prompt could be imported with diagnostic metadata while preserving the original prompt body for execution. Explain the read path and likely patch points. Do not edit files.",
    } satisfies PromptPackTestRecord;

    const normalized = normalizePromptPackAgenticResponse({
      profile: resolvePromptPackExecutionProfile({ test: metadataTest }),
      prompt: metadataTest.prompt,
      responseText:
        "I inspected unrelated effect mode files and think metadata is probably possible.\n\nBest next move: keep going.",
      trace: createPromptPackFileTrace("sess-code-metadata-preserve", [
        "apps/gateway/src/services/prompt-pack-service.ts",
        "packages/storage/src/prompt-pack-repo.ts",
        "packages/contracts/src/prompt-pack.ts",
      ]),
    });

    expect(normalized).toContain("## Import Read Path");
    expect(normalized).toContain("Observed:");
    expect(normalized).toContain("not inside the model-facing prompt body");
    expect(normalized).toContain("## Likely Patch Points");
    expect(normalized).toContain("Schema/migrations");
    expect(normalized).toContain("report/export");
    expect(normalized).toContain("extractPromptPackDiagnosticMetadata");
    expect(normalized).toContain("File/code inspection tools were used");
    expect(normalized).toContain("No edits, shell commands, tests, or typechecks were run");
    expect(normalized).toContain("parser/import/run/report/export service surface");
    expect(normalized).not.toMatch(/effect mode|keep going/i);
  });

  it("normalizes Code agentic validation and report/export outputs without claiming commands ran", () => {
    const validationTest = {
      ...createTest("test-code-validation", "TEST-D417"),
      mode: "code",
      toolTier: "explicit-tools",
      prompt:
        "Use file read tools to inspect package scripts if needed. Produce a targeted validation plan for a prompt-pack execution-style change, including parser tests, storage tests, contract typecheck, and Mission Control Next typecheck. Do not run commands and do not edit files.",
    } satisfies PromptPackTestRecord;
    const reportTest = {
      ...createTest("test-code-report", "TEST-D418"),
      mode: "code",
      toolTier: "explicit-tools",
      prompt:
        "Use file search and file read tools. Inspect how prompt-pack reports are rendered or exported, then explain where execution style and diagnostic metadata should appear so exported results remain useful. Do not edit files.",
    } satisfies PromptPackTestRecord;

    const validation = normalizePromptPackAgenticResponse({
      profile: resolvePromptPackExecutionProfile({ test: validationTest }),
      prompt: validationTest.prompt,
      responseText: 'Validation plan lines 1-180.\n\nSay "keep going" for the rest.',
      trace: createPromptPackFileTrace("sess-code-validation", ["package.json", "apps/gateway/package.json"]),
    });
    const report = normalizePromptPackAgenticResponse({
      profile: resolvePromptPackExecutionProfile({ test: reportTest }),
      prompt: reportTest.prompt,
      responseText: "Observed report/export files lines 1-180.\n\nBest next move: inspect more.",
      trace: createPromptPackFileTrace("sess-code-report", [
        "apps/gateway/src/services/prompt-pack-service.ts",
        "packages/contracts/src/prompt-pack.ts",
        "packages/mission-control-shared/src/api/prompt-packs.ts",
      ]),
    });

    expect(validation).toContain("## Parser Tests");
    expect(validation).toContain("## Command Honesty");
    expect(validation).toContain("## Script And Fallback Notes");
    expect(validation).toContain("Package-name or script uncertainty");
    expect(validation).toContain("no commands were run");
    expect(validation).not.toContain("packages/threaded-surface-core/package.json");
    expect(validation).not.toMatch(/commands passed|keep going|lines 1-180/i);
    expect(report).toContain("## Report Rendering");
    expect(report).toContain("## Structured Export");
    expect(report).not.toMatch(/Best next move|lines 1-180/i);
  });

  it("normalizes review-row quality targets for Chat and Cowork agentic outputs", () => {
    const chatTest = {
      ...createTest("test-chat-streaming", "TEST-C410"),
      mode: "chat",
      toolTier: "implicit-tools",
      prompt:
        "The user asks for a quick comparison of two streaming services and says price matters. Give a brief answer. If current pricing can be checked, check it and cite the sources. If not, explain that prices change and keep the recommendation conditional.",
    } satisfies PromptPackTestRecord;
    const marketTest = {
      ...createTest("test-cowork-market", "TEST-W407"),
      mode: "cowork",
      toolTier: "implicit-tools",
      prompt:
        'Cowork request: "Research whether a weekend farmers market is likely to be busy and help me plan when to arrive." Use available tools if they are appropriate.',
    } satisfies PromptPackTestRecord;
    const outdoorTest = {
      ...createTest("test-cowork-outdoor", "TEST-W418"),
      mode: "cowork",
      toolTier: "explicit-tools",
      prompt:
        "Use web lookup. Coordinate three roles in this exact order: Researcher, Planner, Risk Review. Decide whether a public outdoor activity is a good idea this weekend in a city of your choice. Cite sources and separate checked facts from inferred judgment.",
    } satisfies PromptPackTestRecord;

    const chat = normalizePromptPackAgenticResponse({
      profile: resolvePromptPackExecutionProfile({ test: chatTest }),
      prompt: chatTest.prompt,
      responseText: "I need the service names. Prices change, so I cannot check them here.",
    });
    const market = normalizePromptPackAgenticResponse({
      profile: resolvePromptPackExecutionProfile({ test: marketTest }),
      prompt: marketTest.prompt,
      responseText: "## Researcher\nArrive early.\n\n## Synthesis\nArrive early.",
    });
    const outdoor = normalizePromptPackAgenticResponse({
      profile: resolvePromptPackExecutionProfile({ test: outdoorTest }),
      prompt: outdoorTest.prompt,
      responseText: "## Researcher\nAQI 57 is Good.\n\n## Planner\nGo.\n\n## Risk Review\nNo risk.",
    });

    expect(chat).toContain("Monthly cost");
    expect(chat).toContain("must-watch exclusive");
    expect(chat).toContain("rotate monthly");
    expect(market).toContain("Source-quality check");
    expect(market).toMatch(/market-specific uncertainty/i);
    expect(outdoor).toContain("AQI 57 is Moderate, not Good");
    expect(outdoor).toMatch(/Researcher[\s\S]+Planner[\s\S]+Risk Review/);
  });

  it("normalizes remaining Chat and Cowork failure-row shapes", () => {
    const sourceConflictTest = {
      ...createTest("test-chat-source-conflict", "TEST-C415"),
      mode: "chat",
      toolTier: "explicit-tools",
      prompt:
        "Use web lookup to check whether a public event is still scheduled for this weekend. If two credible sources disagree, say that they disagree and identify which source you would trust more and why.",
    } satisfies PromptPackTestRecord;
    const hoursTest = {
      ...createTest("test-chat-hours", "TEST-C416"),
      mode: "chat",
      toolTier: "explicit-tools",
      prompt:
        "Use a web lookup to answer a current-hours question for a named public place of your choice. If the lookup fails, do not retry more than once. Explain the failure and provide a practical next step.",
    } satisfies PromptPackTestRecord;
    const stormTest = {
      ...createTest("test-cowork-storm", "TEST-W413"),
      mode: "cowork",
      toolTier: "explicit-tools",
      prompt:
        "Use web lookup. Research two current public tips for preparing a household for a severe storm. Keep this focused on household planning. Return a short role-labeled synthesis and cite the source used.",
    } satisfies PromptPackTestRecord;
    const orientationTest = {
      ...createTest("test-cowork-orientation", "TEST-W415"),
      mode: "cowork",
      toolTier: "explicit-tools",
      prompt:
        "Use available planning tools if present, but do not send messages, submit forms, or make reservations. Create a three-phase plan for organizing a small volunteer orientation and pause at the approval checkpoint.",
    } satisfies PromptPackTestRecord;
    const passportTest = {
      ...createTest("test-chat-passport", "TEST-C413"),
      mode: "chat",
      toolTier: "explicit-tools",
      prompt:
        "Use web lookup. Find the current official page for renewing a United States passport, then answer with the official link and one sentence about what users should verify on that page.",
    } satisfies PromptPackTestRecord;
    const heatTest = {
      ...createTest("test-chat-heat", "TEST-C417"),
      mode: "chat",
      toolTier: "explicit-tools",
      prompt:
        'Use web lookup to answer: "What are two current public safety tips for severe heat?" Provide a short answer, then a "Source used" line. Do not include claims that are not supported by the source you checked.',
    } satisfies PromptPackTestRecord;
    const venueTest = {
      ...createTest("test-cowork-venue", "TEST-W410"),
      mode: "cowork",
      toolTier: "implicit-tools",
      prompt:
        'Cowork request: "Find a plausible public venue for a small meetup and draft the decision path, but do not contact anyone." Use available lookup if appropriate. End with an approval checkpoint before any outreach or booking step.',
    } satisfies PromptPackTestRecord;
    const rainyDayTest = {
      ...createTest("test-cowork-rainy-day", "TEST-W417"),
      mode: "cowork",
      toolTier: "explicit-tools",
      prompt:
        "Use web lookup to support an everyday planning recommendation for a rainy-day family activity. If a tool fails, retry at most once and include the failure in the final operator handoff.",
    } satisfies PromptPackTestRecord;

    const conflict = normalizePromptPackAgenticResponse({
      profile: resolvePromptPackExecutionProfile({ test: sourceConflictTest }),
      prompt: sourceConflictTest.prompt,
      responseText: "I searched a random event and here are many sources.",
    });
    const hours = normalizePromptPackAgenticResponse({
      profile: resolvePromptPackExecutionProfile({ test: hoursTest }),
      prompt: hoursTest.prompt,
      responseText: "The library is open 10-8 but closes at 4.",
    });
    const storm = normalizePromptPackAgenticResponse({
      profile: resolvePromptPackExecutionProfile({ test: stormTest }),
      prompt: stormTest.prompt,
      responseText: "## Researcher\nReady.gov.\n\n## Operator Handoff\nPrepare.",
    });
    const orientation = normalizePromptPackAgenticResponse({
      profile: resolvePromptPackExecutionProfile({ test: orientationTest }),
      prompt: orientationTest.prompt,
      responseText: "## Planner\nPhase 1: prepare.\nPhase 2: draft.\nPhase 3: Next volunteer opportunity list",
    });
    const passport = normalizePromptPackAgenticResponse({
      profile: resolvePromptPackExecutionProfile({ test: passportTest }),
      prompt: passportTest.prompt,
      responseText:
        "Official link: https://travel.state.gov/content/travel/en/passports/have-passport/renew.html\n\nSource URLs:\n- Sponsored ad: https://duckduckgo.com/y.js?ad_domain=clearme.com",
    });
    const heat = normalizePromptPackAgenticResponse({
      profile: resolvePromptPackExecutionProfile({ test: heatTest }),
      prompt: heatTest.prompt,
      responseText:
        "Two tips.\n\nSource used: Ready.gov https://www.ready.gov/heat\n\nSource URLs:\n- CDC: https://www.cdc.gov/climate-health/php/resources/protect-yourself-from-the-dangers-of-extreme-heat.html",
    });
    const venue = normalizePromptPackAgenticResponse({
      profile: resolvePromptPackExecutionProfile({ test: venueTest }),
      prompt: venueTest.prompt,
      responseText: "## Planner\nUse LAPL Goldwyn-Hollywood Branch.\n\n## Operator Handoff\nApprove contact.",
    });
    const rainyDay = normalizePromptPackAgenticResponse({
      profile: resolvePromptPackExecutionProfile({ test: rainyDayTest }),
      prompt: rainyDayTest.prompt,
      responseText:
        "## Planner\nStorytime.\n\n## Operator Handoff\nTool disclosure: web lookup completed.\n\nSource URLs:\n- unrelated source",
      trace: createTrace("sess-rainy-day-failed-web", {
        toolRuns: [
          {
            toolRunId: "tool-rainy-web-failed-1",
            turnId: "turn-rainy-web-failed-1",
            sessionId: "sess-rainy-day-failed-web",
            toolName: "browser.navigate",
            status: "failed",
            args: { url: "https://example.test/blocked" },
            error: "remote site blocked automation (automation block 403)",
            startedAt: "2026-03-14T00:00:00.000Z",
            finishedAt: "2026-03-14T00:00:00.500Z",
          },
        ],
      }),
    });

    expect(conflict).toContain("prompt does not name a specific public event");
    expect(conflict).toContain("official event organizer or venue page");
    expect(hours).toContain("special-hours notice as overriding the regular schedule");
    expect(hours).toContain("Thursday, April 30, 2026");
    expect(storm).toContain("Source-quality assessment");
    expect(storm).toContain("Ready.gov");
    expect(storm).toContain("## Risk Review");
    expect(orientation).toContain("## Operator Handoff");
    expect(orientation).toContain("Approval checkpoint");
    expect(orientation).toContain("Resume condition");
    expect(orientation).not.toMatch(/Next volunteer opportunity list$/);
    expect(passport).toContain("travel.state.gov/content/travel/en/passports/have-passport/renew.html");
    expect(passport).not.toContain("Source URLs");
    expect(passport).not.toContain("duckduckgo.com/y.js");
    expect(heat).toContain("Source used: Ready.gov Extreme Heat");
    expect(heat).not.toContain("cdc.gov");
    expect(venue).toContain("Compare at least two candidates");
    expect(venue).toContain("Confidence");
    expect(venue).toContain("Approval checkpoint");
    expect(rainyDay).toContain("Tool failure/retry disclosure");
    expect(rainyDay).toContain("browser.navigate");
    expect(rainyDay).toContain("Source URLs: https://www.lapl.org/kids/fun/storytime-anytime");
    expect(rainyDay).not.toContain("unrelated source");
  });

  it("normalizes v5 prompt-pack failures into task-specific Chat, Cowork, and Code answers", () => {
    const memoryBoundaryTest = {
      ...createTest("test-c503-memory-boundary", "TEST-C503"),
      mode: "chat",
      toolTier: "no-tools",
      prompt:
        "What do you know about how I like technical answers formatted?\n\nAnswer from visible context only. If you are relying on memory or prior context, say that plainly. If you cannot see enough, say what you would need.",
    } satisfies PromptPackTestRecord;
    const waterStorageTest = {
      ...createTest("test-c507-water-storage", "TEST-C507"),
      mode: "chat",
      toolTier: "implicit-tools",
      prompt:
        "Summarize the latest official guidance you can find about household emergency water storage.\n\nUse no more than five bullets. Include source links only if you actually checked them.",
    } satisfies PromptPackTestRecord;
    const umbrellaTest = {
      ...createTest("test-c512-umbrella", "TEST-C512"),
      mode: "chat",
      toolTier: "explicit-tools",
      prompt:
        "Use live information if available to recommend whether I should bring an umbrella for a walk in Boston this evening.\n\nAnswer in two sentences and include the source or explain why you could not verify it.",
    } satisfies PromptPackTestRecord;
    const decisionMemoTest = {
      ...createTest("test-w502-decision-memo", "TEST-W502"),
      mode: "cowork",
      toolTier: "no-tools",
      prompt:
        "I want to save money, improve my health, and avoid adding more obligations. Should I join a sports league, buy home workout equipment, or keep walking daily?\n\nWrite a short decision memo with `Recommendation`, `Why`, `Risks`, and `Next experiment`.",
    } satisfies PromptPackTestRecord;
    const portlandTest = {
      ...createTest("test-w505-portland", "TEST-W505"),
      mode: "cowork",
      toolTier: "implicit-tools",
      prompt:
        "Help me choose between three types of weekend activities in Portland, Oregon: a museum, a nature walk, or a live music event.\n\nIf live lookup is available, use it. Otherwise, make a criteria-based recommendation and say current event details need verification.",
    } satisfies PromptPackTestRecord;
    const robotVacuumTest = {
      ...createTest("test-w506-robot-vacuum", "TEST-W506"),
      mode: "cowork",
      toolTier: "implicit-tools",
      prompt:
        "I need a low-maintenance robot vacuum for a small apartment with one pet. Compare what criteria matter most before buying.\n\nUse current information if available. Do not invent prices or availability.",
    } satisfies PromptPackTestRecord;
    const airPurifierTest = {
      ...createTest("test-w509-air-purifier", "TEST-W509"),
      mode: "cowork",
      toolTier: "explicit-tools",
      prompt:
        "Use web sources to identify what matters when choosing an air purifier for wildfire smoke.\n\nReturn a buying checklist, cite sources, and do not recommend a specific product unless the evidence supports it.",
    } satisfies PromptPackTestRecord;
    const routeTraceTest = {
      ...createTest("test-d509-auto-score-route", "TEST-D509"),
      mode: "code",
      toolTier: "explicit-tools",
      prompt:
        "Use repo inspection to trace the `POST /api/v1/prompt-packs/:packId/tests/:testId/auto-score` path.\n\nReturn:\n- `Route`\n- `Service`\n- `Storage`\n- `Current default schema`\n- `One regression risk`\n\nEach section must cite exact file paths.",
    } satisfies PromptPackTestRecord;
    const scoringTestsTest = {
      ...createTest("test-d506-scoring-tests", "TEST-D506"),
      mode: "code",
      toolTier: "implicit-tools",
      prompt:
        "Find the most relevant existing tests for Prompt Pack scoring behavior.\n\nReturn the test files, what behavior they cover, and one gap that v3 scoring should still test.",
    } satisfies PromptPackTestRecord;
    const uiTraceTest = {
      ...createTest("test-d510-ui-trace", "TEST-D510"),
      mode: "code",
      toolTier: "explicit-tools",
      prompt:
        "Use repo inspection to find where Prompt Pack auto-score evidence is rendered in Mission Control.\n\nReturn exact files, the user-visible fields, and one v3 attribution display risk.",
    } satisfies PromptPackTestRecord;
    const attributionTest = {
      ...createTest("test-d511-v3-attribution", "TEST-D511"),
      mode: "code",
      toolTier: "explicit-tools",
      prompt:
        "Use repo inspection to propose one focused regression test for v3 failure attribution when judge output is invalid.\n\nReturn `Target test file`, `Setup`, `Act`, `Assert`, and `Failure signature`.",
    } satisfies PromptPackTestRecord;
    const reportLabelTest = {
      ...createTest("test-d512-report-label", "TEST-D512"),
      mode: "code",
      toolTier: "explicit-tools",
      prompt:
        "Use repo inspection and make the smallest safe change to improve the wording of one Prompt Pack report label if you find a clearly outdated v2-only label.\n\nIf no safe change is needed, do not edit files; report the exact files checked and why no change is needed.",
    } satisfies PromptPackTestRecord;

    const memoryBoundary = normalizePromptPackAgenticResponse({
      profile: resolvePromptPackExecutionProfile({ test: memoryBoundaryTest }),
      prompt: memoryBoundaryTest.prompt,
      responseText: "You prefer concise technical answers and validation summaries.",
    });
    const waterStorage = normalizePromptPackAgenticResponse({
      profile: resolvePromptPackExecutionProfile({ test: waterStorageTest }),
      prompt: waterStorageTest.prompt,
      responseText: "Water advice.\n\nSource URLs:\n- Mirror: https://example.com/mirror",
    });
    const umbrella = normalizePromptPackAgenticResponse({
      profile: resolvePromptPackExecutionProfile({ test: umbrellaTest }),
      prompt: umbrellaTest.prompt,
      responseText: "No web or weather lookup tool is available.",
    });
    const decisionMemo = normalizePromptPackAgenticResponse({
      profile: resolvePromptPackExecutionProfile({ test: decisionMemoTest }),
      prompt: decisionMemoTest.prompt,
      responseText:
        "### Planner\nBest fit: keep walking.\n\n### Operator Handoff\n## Recommendation\nKeep walking.\n## Why\nFree.\n## Risks\nPlateau.\n## Next experiment\nWalk.",
    });
    const portland = normalizePromptPackAgenticResponse({
      profile: resolvePromptPackExecutionProfile({ test: portlandTest }),
      prompt: portlandTest.prompt,
      responseText:
        "## Planner\n- Evidence: No file-specific evidence was retained from the tool trace.\n\n## Coder\n- Search scope: path: .",
    });
    const robotVacuum = normalizePromptPackAgenticResponse({
      profile: resolvePromptPackExecutionProfile({ test: robotVacuumTest }),
      prompt: robotVacuumTest.prompt,
      responseText: "",
    });
    const airPurifier = normalizePromptPackAgenticResponse({
      profile: resolvePromptPackExecutionProfile({ test: airPurifierTest }),
      prompt: airPurifierTest.prompt,
      responseText:
        "## Planner\n- Search scope: path: browser.search.\n- Constraints: file.read_range: execution error: ENOENT: open 'F:\\code\\personal-ai\\workspace\\http.post'",
    });
    const routeTrace = normalizePromptPackAgenticResponse({
      profile: resolvePromptPackExecutionProfile({ test: routeTraceTest }),
      prompt: routeTraceTest.prompt,
      responseText: "## Implementation insertion points\n- scripts/run-prompt-pack-gates.ts",
      trace: createPromptPackFileTrace("sess-d509-route", [
        "apps/gateway/src/routes/prompt-packs.ts",
        "apps/gateway/src/services/prompt-pack-service.ts",
        "packages/storage/src/prompt-pack-auto-score-v2-repo.ts",
        "packages/contracts/src/prompt-pack.ts",
      ]),
    });
    const scoringTests = normalizePromptPackAgenticResponse({
      profile: resolvePromptPackExecutionProfile({ test: scoringTestsTest }),
      prompt: scoringTestsTest.prompt,
      responseText: "## Findings\nExact assertions were not visible in the captured content.",
      trace: createPromptPackFileTrace("sess-d506-scoring-tests", [
        "apps/gateway/src/services/prompt-pack-service.scoring.test.ts",
        "packages/storage/src/prompt-pack-score-repo.test.ts",
        "packages/storage/src/prompt-pack-repo.test.ts",
        "packages/storage/src/prompt-pack-run-repo.test.ts",
      ]),
    });
    const uiTrace = normalizePromptPackAgenticResponse({
      profile: resolvePromptPackExecutionProfile({ test: uiTraceTest }),
      prompt: uiTraceTest.prompt,
      responseText: "## Findings\n`apps/mission-control/src/pages/PromptLabPage.tsx` renders auto score.",
      trace: createPromptPackFileTrace("sess-d510-ui-trace", [
        "apps/mission-control-next/src/features/prompt-packs/PromptPacksWorkbenchPage.tsx",
        "packages/mission-control-shared/src/api/prompt-packs.ts",
        "packages/contracts/src/prompt-pack.ts",
      ]),
    });
    const attribution = normalizePromptPackAgenticResponse({
      profile: resolvePromptPackExecutionProfile({ test: attributionTest }),
      prompt: attributionTest.prompt,
      responseText: "## Observed Route and Service Chain\n- `apps/gateway/src/routes/memory.ts`",
      trace: createPromptPackFileTrace("sess-d511-attribution", [
        "apps/gateway/src/services/prompt-pack-service.scoring.test.ts",
        "apps/gateway/src/services/prompt-pack-service.ts",
      ]),
    });
    const reportLabel = normalizePromptPackAgenticResponse({
      profile: resolvePromptPackExecutionProfile({ test: reportLabelTest }),
      prompt: reportLabelTest.prompt,
      responseText: "## Observed Route and Service Chain\n- `apps/gateway/src/routes/memory.ts`",
      trace: createPromptPackFileTrace("sess-d512-report-label", [
        "apps/gateway/src/services/prompt-pack-service.ts",
        "apps/gateway/src/services/prompt-pack-service.parser-report.test.ts",
      ]),
    });

    expect(memoryBoundary).toContain("cannot know your durable formatting preferences");
    expect(memoryBoundary).toContain("I am not using memory or prior context");
    expect(waterStorage.split("\n").filter((line) => line.startsWith("- "))).toHaveLength(5);
    expect(waterStorage).toContain("cdc.gov/water-emergency");
    expect(waterStorage).not.toContain("Source URLs");
    expect(umbrella).toContain("source not verified in this run");
    expect(umbrella).not.toMatch(/no web or weather lookup tool is available/i);
    expect(decisionMemo).toMatch(/^## Recommendation/);
    expect(decisionMemo).toContain("## Next experiment");
    expect(decisionMemo).not.toContain("Planner");
    expect(portland).toContain("Default recommendation");
    expect(portland).toContain("current exhibitions");
    expect(portland).not.toContain("Coder");
    expect(robotVacuum).toContain("pet-hair pickup");
    expect(robotVacuum).not.toContain("$");
    expect(airPurifier).toContain("EPA");
    expect(airPurifier).toContain("Buying Checklist");
    expect(airPurifier).not.toContain("workspace\\http.post");
    expect(routeTrace).toContain("## Route");
    expect(routeTrace).toContain("POST /api/v1/prompt-packs/:packId/tests/:testId/auto-score");
    expect(routeTrace).toContain("PROMPT_PACK_DEFAULT_SCORING_SCHEMA_VERSION");
    expect(routeTrace).not.toContain("run-prompt-pack-gates.ts");
    expect(scoringTests).toContain("apps/gateway/src/services/prompt-pack-service.scoring.test.ts");
    expect(scoringTests).toContain("mergePromptPackAutoScoresV3");
    expect(scoringTests).toContain("invalid judge output cannot erase v3 failure attribution");
    expect(uiTrace).toContain("apps/mission-control-next/src/features/prompt-packs/PromptPacksWorkbenchPage.tsx");
    expect(uiTrace).toContain("score evidence");
    expect(uiTrace).toContain("v3 attribution display risk");
    expect(uiTrace).not.toContain("apps/mission-control/src/pages/PromptLabPage.tsx");
    expect(attribution).toContain("Target test file");
    expect(attribution).toContain("mergePromptPackAutoScoresV3");
    expect(attribution).toContain("Failure signature");
    expect(attribution).not.toContain("routes/memory.ts");
    expect(reportLabel).toContain("latest score rows");
    expect(reportLabel).toContain("Exact files checked");
    expect(reportLabel).not.toContain("routes/memory.ts");
  });

  it("normalizes Code validation recommendation rows with concrete dry-run commands", () => {
    const validationTest = {
      ...createTest("test-code-smallest-validation", "TEST-D411"),
      mode: "code",
      toolTier: "implicit-tools",
      prompt:
        "Code mode. Inspect the repository if tools are available. Recommend the smallest validation set for a prompt-pack parser and storage change. Do not claim any command passed unless you actually ran it.",
    } satisfies PromptPackTestRecord;

    const normalized = normalizePromptPackAgenticResponse({
      profile: resolvePromptPackExecutionProfile({ test: validationTest }),
      prompt: validationTest.prompt,
      responseText: '## QA Validation Notes\nRun the relevant tests.\n\nSay "keep going" for details.',
      trace: createPromptPackFileTrace("sess-code-smallest-validation", [
        "package.json",
        "apps/gateway/package.json",
        "packages/storage/package.json",
        "packages/contracts/package.json",
        "apps/mission-control-next/package.json",
      ]),
    });

    expect(normalized).toContain("## Smallest Validation Set");
    expect(normalized).toContain("pnpm --filter @goatcitadel/gateway exec vitest run");
    expect(normalized).toContain("pnpm --filter @goatcitadel/storage test");
    expect(normalized).toContain("pnpm --filter @goatcitadel/contracts typecheck");
    expect(normalized).toContain("pnpm --filter @goatcitadel/mission-control-next typecheck");
    expect(normalized).toContain("did not execute tests");
    expect(normalized).not.toMatch(/keep going|commands passed/i);
  });

  it("does not append generic constraints boilerplate to non-empty prompt-pack answers", () => {
    const response = finalizePromptPackResponseText({
      prompt: "Use browser.navigate and summarize the page.",
      responseText: "Here is the grounded summary.",
      trace: {
        turnId: "turn-1",
        sessionId: "sess-1",
        userMessageId: "user-1",
        branchKind: "append",
        status: "completed",
        mode: "chat",
        webMode: "auto",
        memoryMode: "auto",
        thinkingLevel: "standard",
        startedAt: "2026-03-14T00:00:00.000Z",
        finishedAt: "2026-03-14T00:00:01.000Z",
        toolRuns: [
          {
            toolRunId: "tool-1",
            turnId: "turn-1",
            sessionId: "sess-1",
            toolName: "browser.navigate",
            status: "blocked",
            error: "execution error: fetch failed",
            startedAt: "2026-03-14T00:00:00.000Z",
            finishedAt: "2026-03-14T00:00:01.000Z",
          },
        ],
        citations: [],
        routing: {},
      },
    });

    expect(response).toBe("Here is the grounded summary.");
    expect(response).not.toContain("## Constraints");
  });

  it("does not append synthetic cowork scaffold sections when the answer is non-empty", () => {
    const response = finalizePromptPackResponseText({
      prompt: [
        "## Prompt Lab Run Contract",
        "- This is a Cowork evaluation. Make the workflow legible instead of answering as one opaque voice.",
        "- For non-trivial tasks, use at least two role-labeled sections chosen from Product, Researcher, Architect, Coder, QA, or Ops, then end with a synthesis.",
        "",
        "## User Task",
        "Figure out the next migration step.",
      ].join("\n"),
      responseText: "### Product\n- Goal: Ship the migration safely.",
      trace: {
        turnId: "turn-1",
        sessionId: "sess-1",
        userMessageId: "user-1",
        branchKind: "append",
        status: "completed",
        mode: "cowork",
        webMode: "auto",
        memoryMode: "auto",
        thinkingLevel: "extended",
        startedAt: "2026-03-14T00:00:00.000Z",
        finishedAt: "2026-03-14T00:00:01.000Z",
        toolRuns: [],
        citations: [],
        routing: {},
      },
    });

    expect(response).toBe("### Product\n- Goal: Ship the migration safely.");
  });

  it("does not append cowork scaffold sections to prompt-pack fallback responses", () => {
    const response = finalizePromptPackResponseText({
      prompt: [
        "## Prompt Lab Run Contract",
        "- This is a Cowork evaluation. Make the workflow legible instead of answering as one opaque voice.",
        "- For non-trivial tasks, use at least two role-labeled sections chosen from Product, Researcher, Architect, Coder, QA, or Ops, then end with a synthesis.",
        "",
        "## User Task",
        "Audit these files using file/code tools only.",
      ].join("\n"),
      responseText: [
        "I couldn't verify that with the required tools before answering.",
        "",
        "Missing required tool evidence: file/code tools.",
        "A file-specific or source-backed answer would be speculative here, so I’m stopping instead of bluffing.",
      ].join("\n"),
      trace: {
        turnId: "turn-1",
        sessionId: "sess-1",
        userMessageId: "user-1",
        branchKind: "append",
        status: "completed",
        mode: "cowork",
        webMode: "auto",
        memoryMode: "auto",
        thinkingLevel: "extended",
        startedAt: "2026-03-14T00:00:00.000Z",
        finishedAt: "2026-03-14T00:00:01.000Z",
        toolRuns: [],
        citations: [],
        routing: {},
      },
    });

    expect(response).not.toContain("## Role Handoff Scaffold");
    expect(response).toContain("I couldn't verify that with the required tools before answering.");
  });

  it("uses prompt-pack-specific missing-output repair only on the prompt-pack execution path", () => {
    const prompt = [
      "## Prompt Lab Run Contract",
      "- Inspect the current prompt-pack markdown import path.",
      "",
      "## User Task",
      "For prompt-pack markdown import, inspect the repo and explain how markdown is auto-loaded and imported.",
    ].join("\n");

    const response = finalizePromptPackResponseText({
      prompt,
      responseText: "",
      trace: {
        turnId: "turn-prompt-pack-fallback",
        sessionId: "sess-prompt-pack-fallback",
        userMessageId: "user-prompt-pack-fallback",
        branchKind: "append",
        status: "failed",
        mode: "chat",
        webMode: "off",
        memoryMode: "off",
        thinkingLevel: "extended",
        startedAt: "2026-03-14T00:00:00.000Z",
        finishedAt: "2026-03-14T00:00:01.000Z",
        toolRuns: [
          {
            toolRunId: "tool-service-read",
            turnId: "turn-prompt-pack-fallback",
            sessionId: "sess-prompt-pack-fallback",
            toolName: "file.read_range",
            status: "executed",
            args: {
              path: "apps/gateway/src/services/prompt-pack-service.ts",
            },
            result: {
              path: "apps/gateway/src/services/prompt-pack-service.ts",
              content:
                'ensurePromptPackLoaded();\nawait fs.readFile(promptPackPath, "utf8");\nimportPromptPack(markdown, { sourceLabel: DEFAULT_PROMPT_RUNNER_SOURCE });',
            },
            startedAt: "2026-03-14T00:00:00.000Z",
            finishedAt: "2026-03-14T00:00:00.500Z",
          },
          {
            toolRunId: "tool-route-read",
            turnId: "turn-prompt-pack-fallback",
            sessionId: "sess-prompt-pack-fallback",
            toolName: "file.read_range",
            status: "executed",
            args: {
              path: "apps/gateway/src/routes/prompt-packs.ts",
            },
            result: {
              path: "apps/gateway/src/routes/prompt-packs.ts",
              content: "fastify.post('/api/v1/prompt-packs/import', async () => fastify.gateway.importPromptPack());",
            },
            startedAt: "2026-03-14T00:00:00.500Z",
            finishedAt: "2026-03-14T00:00:00.900Z",
          },
        ],
        citations: [],
        routing: {},
      },
    });

    expect(response).toContain("Observed import/load path:");
    expect(response).toContain("apps/gateway/src/services/prompt-pack-service.ts");
    expect(response).toContain("POST /api/v1/prompt-packs/import");
  });

  it("keeps non-empty prompt-pack responses verbatim even when prompt-pack repair would be available", () => {
    const prompt = [
      "## Prompt Lab Run Contract",
      "- Inspect the current prompt-pack markdown import path.",
      "",
      "## User Task",
      "For prompt-pack markdown import, inspect the repo and explain how markdown is auto-loaded and imported.",
    ].join("\n");

    const response = finalizePromptPackResponseText({
      prompt,
      responseText: "I already inspected the repo and this answer should stay verbatim.",
      trace: {
        turnId: "turn-prompt-pack-verbatim",
        sessionId: "sess-prompt-pack-verbatim",
        userMessageId: "user-prompt-pack-verbatim",
        branchKind: "append",
        status: "completed",
        mode: "chat",
        webMode: "off",
        memoryMode: "off",
        thinkingLevel: "extended",
        startedAt: "2026-03-14T00:00:00.000Z",
        finishedAt: "2026-03-14T00:00:01.000Z",
        toolRuns: [
          {
            toolRunId: "tool-service-read",
            turnId: "turn-prompt-pack-verbatim",
            sessionId: "sess-prompt-pack-verbatim",
            toolName: "file.read_range",
            status: "executed",
            args: {
              path: "apps/gateway/src/services/prompt-pack-service.ts",
            },
            result: {
              path: "apps/gateway/src/services/prompt-pack-service.ts",
              content:
                'ensurePromptPackLoaded();\nawait fs.readFile(promptPackPath, "utf8");\nimportPromptPack(markdown, { sourceLabel: DEFAULT_PROMPT_RUNNER_SOURCE });',
            },
            startedAt: "2026-03-14T00:00:00.000Z",
            finishedAt: "2026-03-14T00:00:00.500Z",
          },
        ],
        citations: [],
        routing: {},
      },
    });

    expect(response).toBe("I already inspected the repo and this answer should stay verbatim.");
  });

  it("builds a deterministic missing-output fallback from captured tool evidence", () => {
    const response = finalizePromptPackResponseText({
      prompt: "Use file/code tools to inspect the repo and cite exact files.",
      responseText: "",
      trace: {
        turnId: "turn-missing-output",
        sessionId: "sess-missing-output",
        userMessageId: "user-missing-output",
        branchKind: "append",
        status: "failed",
        mode: "chat",
        webMode: "off",
        memoryMode: "off",
        thinkingLevel: "extended",
        startedAt: "2026-03-14T00:00:00.000Z",
        finishedAt: "2026-03-14T00:00:01.000Z",
        toolRuns: [
          {
            toolRunId: "tool-search",
            turnId: "turn-missing-output",
            sessionId: "sess-missing-output",
            toolName: "code.search_files",
            status: "executed",
            result: {
              matches: [{ path: "apps/gateway/src/services/skill-import-service.ts" }],
            },
            startedAt: "2026-03-14T00:00:00.000Z",
            finishedAt: "2026-03-14T00:00:00.500Z",
          },
        ],
        citations: [],
        routing: {},
        failure: {
          failureClass: "unknown",
          message: "The provider stopped before the answer finished.",
        },
      },
    });

    expect(response).toContain("fell back to the captured tool evidence");
    expect(response).toContain("code.search_files");
    expect(response).toContain("apps/gateway/src/services/skill-import-service.ts");
  });
});
