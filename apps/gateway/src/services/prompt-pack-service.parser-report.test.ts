import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { describe, expect, it, vi } from "vitest";

vi.mock("node:sqlite", () => ({
  DatabaseSync: class DatabaseSync {},
  StatementSync: class StatementSync {},
}));

import type { PromptPackScoreRecordV2, PromptPackRunRecord } from "@goatcitadel/contracts";
import {
  PromptPackService,
  buildPromptPackReportSummary,
  extractPromptPackDiagnosticMetadata,
  parsePromptPackTests,
  renderPromptPackMarkdownReport,
} from "./prompt-pack-service.js";
import { DEFAULT_PROMPT_PACK_POLICY_V2 } from "@goatcitadel/contracts";
import { hashPromptPackPolicyV2 } from "@goatcitadel/storage";
import {
  buildCanonicalMergedPromptPackMarkdown,
  buildFocusedV2PromptPackMarkdown,
  buildRepoExpansionPromptPackMarkdown,
  createPack,
  createPromptPackExportService,
  createRun,
  createTest,
  createTrace,
  readRepoFixture,
} from "./prompt-pack-service-test-fixtures.js";

describe("prompt-pack parser, import, export, and reports", () => {
  it("preserves the real env prompt-pack source label", async () => {
    const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), "goat-prompt-pack-env-"));
    const previousSourcePath = process.env.GOATCITADEL_PROMPT_PACK_PATH;
    try {
      const sourcePath = path.join(rootDir, "expanded-pack.md");
      fs.writeFileSync(
        sourcePath,
        [
          "# Chat",
          "",
          "## No Tools",
          "",
          "### TEST-C901: Env source label",
          "",
          "Answer from the env-loaded pack.",
          "",
        ].join("\n"),
        "utf8",
      );
      process.env.GOATCITADEL_PROMPT_PACK_PATH = sourcePath;

      const replacePackTests = vi.fn((input: { packId?: string; name: string; sourceLabel?: string }) => ({
        pack: {
          packId: input.packId ?? "pack-env",
          name: input.name,
          sourceLabel: input.sourceLabel,
          policyHash: "policy-hash",
          createdAt: "2026-03-14T00:00:00.000Z",
          updatedAt: "2026-03-14T00:00:00.000Z",
        },
        tests: [],
      }));
      const service = new PromptPackService(
        {
          storage: {
            promptPacks: {
              listPacks: () => [],
              replacePackTests,
            },
          },
          config: {
            rootDir,
            assistant: {
              workspaceDir: ".",
              durable: {
                enabled: true,
                executionEnabled: true,
                chatAutoPromoteEnabled: true,
              },
            },
          },
          isFeatureEnabled: () => true,
          requireFeatureEnabled: () => undefined,
          publishRealtime: () => undefined,
        } as never,
        {
          createChatSession: vi.fn(),
          agentSendChatMessage: vi.fn(),
          createChatCompletion: vi.fn(),
          getPromptRunnerModelDefaults: () => ({ providerId: "openai", model: "gpt-5.4" }),
          getPromptJudgeModelDefaults: () => ({ providerId: "openai", model: "gpt-5.4" }),
          backgroundTasks: new Set(),
        },
      );
      vi.spyOn(service as never, "refreshPromptPackExportFile").mockImplementation(() => undefined);

      const loaded = await service.ensurePromptPackLoaded();

      expect(replacePackTests).toHaveBeenCalledWith(
        expect.objectContaining({
          sourceLabel: sourcePath,
        }),
      );
      expect(loaded?.sourceLabel).toBe(sourcePath);
      expect(loaded?.sourceLabel).not.toBe("goatcitadel_prompt_pack.md");
    } finally {
      if (previousSourcePath === undefined) {
        delete process.env.GOATCITADEL_PROMPT_PACK_PATH;
      } else {
        process.env.GOATCITADEL_PROMPT_PACK_PATH = previousSourcePath;
      }
      fs.rmSync(rootDir, { recursive: true, force: true });
    }
  });

  it("does not mark current-default autoscores stale when a legacy inherited-default row carried old policy metadata", () => {
    const rootDir = path.join(os.tmpdir(), `goatcitadel-prompt-pack-export-${randomUUID()}`);
    try {
      const pack = {
        packId: "pack-legacy-default",
        name: "Legacy Default Pack",
        testCount: 1,
        policyHash: hashPromptPackPolicyV2(DEFAULT_PROMPT_PACK_POLICY_V2),
        policySource: "inherited_default" as const,
        policyV2: DEFAULT_PROMPT_PACK_POLICY_V2,
        createdAt: "2026-03-16T00:00:00.000Z",
        updatedAt: "2026-03-16T00:00:00.000Z",
      };
      const test = createTest("test-export-current-default", "TEST-EXPORT-CURRENT-DEFAULT");
      const run: PromptPackRunRecord = {
        ...createRun("run-export-current-default", "completed", "2026-03-16T00:40:00.000Z"),
        testId: test.testId,
        responseText: "Completed answer.",
        trace: createTrace("sess-export-current-default"),
      };
      const autoScore: PromptPackScoreRecordV2 = {
        autoScoreId: "auto-export-current-default",
        packId: pack.packId,
        testId: test.testId,
        runId: run.runId,
        scoringSchemaVersion: "v2",
        scorerVersion: "2026-04-16.2",
        judgeRubricVersion: "2026-04-09.1",
        policyHash: pack.policyHash,
        policySource: "inherited_default",
        scoreState: "scored",
        protocol: { protocolPass: true, reasonCodes: [] },
        hardFailReasons: [],
        applicability: {
          taskSuccess: true,
          honesty: true,
          executionQuality: true,
          robustness: true,
          usability: true,
        },
        ruleScores: {
          taskSuccess: 4,
          honesty: 4,
          executionQuality: 4,
          robustness: 4,
          usability: 4,
        },
        finalScores: {
          taskSuccess: 4,
          honesty: 4,
          executionQuality: 4,
          robustness: 4,
          usability: 4,
        },
        disagreement: {},
        weightedScore: 1,
        autoVerdict: "pass",
        judgeStatus: "valid",
        reviewReasons: [],
        degradedReasons: [],
        mergeProvenance: {},
        createdAt: "2026-03-16T00:41:00.000Z",
      };
      const service = new PromptPackService(
        {
          storage: {
            promptPacks: {
              getPack: () => pack,
              listTests: () => [test],
            },
            promptPackRuns: {
              listByPack: () => [run],
            },
            promptPackScores: {
              listByPack: () => [],
            },
            promptPackAutoScoresV2: {
              listByPack: () => [autoScore],
            },
            promptPackHumanReviewsV2: {
              listByPack: () => [],
            },
          },
          gatewaySql: {} as never,
          config: {
            rootDir,
            assistant: {
              workspaceDir: ".",
              durable: {
                enabled: true,
                executionEnabled: true,
                chatAutoPromoteEnabled: true,
              },
            },
          },
        } as never,
        {
          createChatSession: vi.fn(),
          agentSendChatMessage: vi.fn(),
          createChatCompletion: vi.fn(),
          getPromptRunnerModelDefaults: () => ({ providerId: "openai", model: "gpt-5.4" }),
          getPromptJudgeModelDefaults: () => ({ providerId: "openai", model: "gpt-5.4" }),
          backgroundTasks: new Set(),
        },
      );

      const exported = service.exportPromptPack(pack.packId);
      const markdown = fs.readFileSync(exported.path, "utf8");

      expect(markdown).toContain("Active scoring schema: `v3`");
      expect(markdown).toContain("Current-generation latest score rows: 0/1");
      expect(markdown).toContain("Stale latest score rows: 1");
    } finally {
      fs.rmSync(rootDir, { recursive: true, force: true });
    }
  });

  it("creates immutable prompt-pack snapshots while preserving the latest export", () => {
    const rootDir = path.join(os.tmpdir(), `goatcitadel-prompt-pack-snapshots-${randomUUID()}`);
    try {
      const pack = {
        ...createPack("pack-snapshot"),
        name: "goatcitadel_prompt_pack_v5_overall",
      };
      const test = {
        ...createTest("test-snapshot", "TEST-SNAPSHOT"),
        packId: pack.packId,
      };
      const run: PromptPackRunRecord = {
        ...createRun("run-snapshot", "completed", "2026-05-05T21:14:08.000Z"),
        packId: pack.packId,
        testId: test.testId,
        providerId: "openai",
        model: "gpt-5.4",
        executionStyle: "single_turn_harness",
        responseText: "Snapshot export answer.",
        trace: createTrace("sess-snapshot"),
      };
      const service = createPromptPackExportService({ rootDir, pack, tests: [test], runs: [run] });

      const first = service.exportPromptPack(pack.packId);
      const second = service.exportPromptPack(pack.packId);

      expect(first.path).toMatch(/goatcitadel_prompt_pack_v5_overall-pack-snapshot-latest\.md$/);
      expect(fs.existsSync(first.path)).toBe(true);
      expect(first.latestSnapshotPath).toMatch(
        /goatcitadel_prompt_pack_v5_overall_\d{4}-\d{2}-\d{2}_\d{2}-\d{2}-\d{2}Z_openai_gpt-5\.4_harness(?:-\d+)?\.md$/,
      );
      expect(second.latestSnapshotPath).toBeTruthy();
      expect(second.latestSnapshotPath).not.toBe(first.latestSnapshotPath);
      expect(second.snapshotCount).toBe(2);
      expect(fs.readFileSync(second.latestSnapshotPath ?? "", "utf8")).toContain("- Export execution style: `harness`");
    } finally {
      fs.rmSync(rootDir, { recursive: true, force: true });
    }
  });

  it("keeps immutable snapshots when prompt-pack reset clears current runs", () => {
    const rootDir = path.join(os.tmpdir(), `goatcitadel-prompt-pack-reset-${randomUUID()}`);
    try {
      const pack = createPack("pack-reset-snapshot");
      const test = {
        ...createTest("test-reset-snapshot", "TEST-RESET-SNAPSHOT"),
        packId: pack.packId,
      };
      const run: PromptPackRunRecord = {
        ...createRun("run-reset-snapshot", "completed", "2026-05-05T21:14:08.000Z"),
        packId: pack.packId,
        testId: test.testId,
        providerId: "openai",
        model: "gpt-5.4",
        executionStyle: "agentic_surface",
        responseText: "Reset preservation answer.",
        trace: createTrace("sess-reset-snapshot"),
      };
      const service = createPromptPackExportService({ rootDir, pack, tests: [test], runs: [run] });
      const exported = service.exportPromptPack(pack.packId);
      const snapshotPath = exported.latestSnapshotPath ?? "";

      const reset = service.resetPromptPackRunsAndScores(pack.packId, { clearRuns: true, clearScores: true });

      expect(fs.existsSync(exported.path)).toBe(false);
      expect(fs.existsSync(snapshotPath)).toBe(true);
      expect(reset.export.latestSnapshotPath).toBe(snapshotPath);
      expect(reset.export.snapshotCount).toBe(1);
    } finally {
      fs.rmSync(rootDir, { recursive: true, force: true });
    }
  });

  it("renders enriched trace details without dumping unbounded tool output", () => {
    const pack = createPack("pack-trace-report");
    const test = {
      ...createTest("test-trace-report", "TEST-TRACE-REPORT"),
      packId: pack.packId,
    };
    const longContent = "x".repeat(1200);
    const run: PromptPackRunRecord = {
      ...createRun("run-trace-report", "completed", "2026-05-05T21:14:08.000Z"),
      packId: pack.packId,
      testId: test.testId,
      providerId: "openai",
      model: "gpt-5.4",
      executionStyle: "agentic_surface",
      responseText: "Trace report answer.",
      trace: createTrace("sess-trace-report", {
        model: "gpt-5.4",
        routing: {
          primaryProviderId: "openai",
          primaryModel: "gpt-5.4",
          effectiveProviderId: "openai",
          effectiveModel: "gpt-5.4",
          fallbackUsed: true,
          fallbackProviderId: "openrouter",
          fallbackModel: "openai/gpt-5.4",
          fallbackReason: "primary_timeout",
        },
        toolRuns: [
          {
            toolRunId: "tool-trace-report-1",
            turnId: "turn-sess-trace-report",
            sessionId: "sess-trace-report",
            toolName: "file.read_range",
            status: "executed",
            args: { path: "apps/gateway/src/services/prompt-pack-service.ts", startLine: 1, endLine: 50 },
            result: {
              path: "apps/gateway/src/services/prompt-pack-service.ts",
              contentText: longContent,
              artifactId: "artifact-1",
              artifactPath: "artifacts/tool-output/tool-1.txt",
              originalByteLength: longContent.length,
            },
            startedAt: "2026-05-05T21:14:08.000Z",
            finishedAt: "2026-05-05T21:14:08.250Z",
          },
        ],
      }),
    };

    const markdown = renderPromptPackMarkdownReport({
      pack,
      tests: [test],
      runs: [run],
      scores: [],
      autoScoresV2: [],
      humanReviewsV2: [],
      latestAssessments: [],
      summary: buildPromptPackReportSummary([test], [run], [], [], []),
    });

    expect(markdown).toContain("- Export execution style: `agentic`");
    expect(markdown).toContain("- Requested provider/model: `openai / gpt-5.4`");
    expect(markdown).toContain("- Effective provider/model: `openai / gpt-5.4`");
    expect(markdown).toContain("- Fallback reason: primary_timeout");
    expect(markdown).toContain("artifact-1 at artifacts/tool-output/tool-1.txt");
    expect(markdown).toContain("[truncated]");
    expect(markdown).not.toContain(longContent);
  });

  it("parses the repo expansion prompt pack markdown with stable mode and tool tiers", () => {
    const markdown = buildRepoExpansionPromptPackMarkdown();
    const tests = parsePromptPackTests(markdown);

    expect(tests.map((test) => test.code)).toEqual([
      "TEST-D26",
      "TEST-D27",
      "TEST-D28",
      "TEST-D29",
      "TEST-D30",
      "TEST-D31",
      "TEST-D32",
      "TEST-W31",
      "TEST-W32",
    ]);
    expect(tests.slice(0, 7).every((test) => test.mode === "code" && test.toolTier === "explicit-tools")).toBe(true);
    expect(tests.slice(7).every((test) => test.mode === "cowork" && test.toolTier === "explicit-tools")).toBe(true);
    expect(tests[0]?.prompt).toContain("goatcitadel-arena/packages/engine/src/judge/rules-judge.ts");
    expect(tests[7]?.prompt).toContain("Roles in order: `Researcher`, `Architect`, `QA`.");
  });

  it("parses mode headings even when they omit the word tests", () => {
    const tests = parsePromptPackTests(
      [
        "# Chat",
        "",
        "## No Tools",
        "",
        "### TEST-X01: Direct answer",
        "",
        "Prompt body.",
        "",
        "# Cowork",
        "",
        "## Explicit Tools",
        "",
        "### TEST-X02: Coordinated answer",
        "",
        "Another prompt body.",
      ].join("\n"),
    );

    expect(tests).toHaveLength(2);
    expect(tests[0]).toMatchObject({ code: "TEST-X01", mode: "chat", toolTier: "no-tools" });
    expect(tests[1]).toMatchObject({ code: "TEST-X02", mode: "cowork", toolTier: "explicit-tools" });
  });

  it("extracts diagnostic metadata from parser-safe markdown comments", () => {
    const extracted = extractPromptPackDiagnosticMetadata(
      [
        "<!-- Prompt Pack Diagnostics:",
        "Capability Targets: routing, truthfulness",
        "Expected Runtime Signals: no tool calls; concise answer",
        "Likely Failure Classes: routing, model-overconfidence",
        "-->",
        "",
        "Actual prompt body.",
      ].join("\n"),
    );

    expect(extracted.prompt).toBe("Actual prompt body.");
    expect(extracted.diagnosticMetadata).toEqual({
      capabilityTargets: ["routing", "truthfulness"],
      expectedRuntimeSignals: ["no tool calls", "concise answer"],
      likelyFailureClasses: ["routing", "model-overconfidence"],
    });
  });

  it("parses the v4 agentic focused pack with diagnostics and surface guards", () => {
    const markdown = readRepoFixture("goatcitadel_prompt_pack_v4_agentic_focused.md");
    const tests = parsePromptPackTests(markdown);
    const byMode = new Map<string, number>();
    const byModeTier = new Map<string, number>();

    for (const test of tests) {
      if (test.mode) {
        byMode.set(test.mode, (byMode.get(test.mode) ?? 0) + 1);
      }
      if (test.mode && test.toolTier) {
        const key = `${test.mode}/${test.toolTier}`;
        byModeTier.set(key, (byModeTier.get(key) ?? 0) + 1);
      }
    }

    expect(tests).toHaveLength(54);
    expect(new Set(tests.map((test) => test.code)).size).toBe(54);
    expect(byMode.get("chat")).toBe(18);
    expect(byMode.get("cowork")).toBe(18);
    expect(byMode.get("code")).toBe(18);
    for (const mode of ["chat", "cowork", "code"]) {
      for (const toolTier of ["no-tools", "implicit-tools", "explicit-tools"]) {
        expect(byModeTier.get(`${mode}/${toolTier}`)).toBe(6);
      }
    }

    for (const test of tests) {
      expect(test.prompt).not.toContain("Prompt Pack Diagnostics");
      expect(test.diagnosticMetadata?.capabilityTargets.length).toBeGreaterThan(0);
      expect(test.diagnosticMetadata?.expectedRuntimeSignals.length).toBeGreaterThan(0);
      expect(test.diagnosticMetadata?.likelyFailureClasses.length).toBeGreaterThan(0);
    }

    const forbiddenNonCodePattern =
      /\b(repo|repository|patch|source[- ]file|TypeScript|function|unit test|package\.json)\b|apps\/|packages\/|\.ts\b/i;
    for (const test of tests.filter((item) => item.mode === "chat" || item.mode === "cowork")) {
      expect(`${test.title}\n${test.prompt}`).not.toMatch(forbiddenNonCodePattern);
    }
    for (const test of tests.filter((item) => item.mode === "code")) {
      expect(`${test.title}\n${test.prompt}`).toMatch(
        /\b(Code mode|TypeScript|function|repository|prompt-pack|file|tests?|patch|package|\.ts)\b/i,
      );
    }
  });

  it("parses the canonical merged prompt pack markdown with the v4 balanced layout", () => {
    const markdown = buildCanonicalMergedPromptPackMarkdown();
    const tests = parsePromptPackTests(markdown);
    const codes = tests.map((test) => test.code);
    const byMode = new Map<string, number>();
    for (const test of tests) {
      if (!test.mode) {
        continue;
      }
      byMode.set(test.mode, (byMode.get(test.mode) ?? 0) + 1);
    }

    expect(tests).toHaveLength(108);
    expect(new Set(codes).size).toBe(108);
    expect(codes[0]).toBe("TEST-C01");
    expect(codes).toContain("TEST-W27");
    expect(codes).toContain("TEST-D27");
    expect(codes).toContain("TEST-T01");
    expect(codes).toContain("TEST-T27");
    expect(codes[codes.length - 1]).toBe("TEST-T27");
    expect(byMode.get("chat")).toBe(36);
    expect(byMode.get("cowork")).toBe(36);
    expect(byMode.get("code")).toBe(36);
  });

  it("parses the focused v2 prompt pack markdown for recent GoatCitadel capabilities", () => {
    const markdown = buildFocusedV2PromptPackMarkdown();
    const tests = parsePromptPackTests(markdown);
    const byMode = new Map<string, number>();
    for (const test of tests) {
      if (!test.mode) {
        continue;
      }
      byMode.set(test.mode, (byMode.get(test.mode) ?? 0) + 1);
    }

    expect(tests).toHaveLength(96);
    expect(new Set(tests.map((test) => test.code)).size).toBe(96);
    expect(tests[0]?.code).toBe("TEST-C101");
    expect(tests.some((test) => test.code === "TEST-W111" && test.prompt.includes("skill-import-service.ts"))).toBe(
      true,
    );
    expect(tests.some((test) => test.code === "TEST-D110" && test.prompt.includes("update-review-daily"))).toBe(true);
    expect(tests.some((test) => test.code === "TEST-C121" && test.prompt.includes("memory routes"))).toBe(true);
    expect(tests.some((test) => test.code === "TEST-D122" && test.prompt.includes("run-prompt-pack-gates.ts"))).toBe(
      true,
    );
    expect(tests.some((test) => test.code === "TEST-W130" && test.prompt.includes("judge target selection"))).toBe(
      true,
    );
    expect(tests.some((test) => test.code === "TEST-D132" && test.prompt.includes("wall-clock timing"))).toBe(true);
    expect(byMode.get("chat")).toBe(32);
    expect(byMode.get("cowork")).toBe(32);
    expect(byMode.get("code")).toBe(32);
  });

  it("parses the v6 security red-team prompt pack with balanced safety diagnostics", () => {
    const markdown = readRepoFixture("goatcitadel_prompt_pack_v6_security_red_team.md");
    const tests = parsePromptPackTests(markdown);
    const codes = tests.map((test) => test.code);
    const byMode = new Map<string, number>();
    const byModeTier = new Map<string, number>();

    for (const test of tests) {
      if (test.mode) {
        byMode.set(test.mode, (byMode.get(test.mode) ?? 0) + 1);
      }
      if (test.mode && test.toolTier) {
        const key = `${test.mode}/${test.toolTier}`;
        byModeTier.set(key, (byModeTier.get(key) ?? 0) + 1);
      }
    }

    expect(tests).toHaveLength(18);
    expect(new Set(codes).size).toBe(18);
    expect(codes[0]).toBe("TEST-S601");
    expect(codes).toContain("TEST-S612");
    expect(codes[codes.length - 1]).toBe("TEST-S618");
    expect(byMode.get("chat")).toBe(6);
    expect(byMode.get("cowork")).toBe(6);
    expect(byMode.get("code")).toBe(6);
    for (const mode of ["chat", "cowork", "code"]) {
      for (const toolTier of ["no-tools", "implicit-tools", "explicit-tools"]) {
        expect(byModeTier.get(`${mode}/${toolTier}`)).toBe(2);
      }
    }

    for (const test of tests) {
      expect(test.prompt).not.toContain("Prompt Pack Diagnostics");
      expect(test.prompt).not.toMatch(
        /\b(step-by-step abuse|credential collection|stealth|persistence|evasion|weaponization)\b/i,
      );
      expect(test.diagnosticMetadata?.capabilityTargets.length).toBeGreaterThan(0);
      expect(test.diagnosticMetadata?.expectedRuntimeSignals.length).toBeGreaterThan(0);
      expect(test.diagnosticMetadata?.likelyFailureClasses.length).toBeGreaterThan(0);
    }
  });

  it("projects bundled security red-team eval packs without running providers", () => {
    const importedPack = {
      packId: "pack-security",
      name: "Security Red Team",
      sourceLabel: "goatcitadel_prompt_pack_v6_security_red_team.md",
      testCount: 18,
      createdAt: "2026-05-30T00:00:00.000Z",
      updatedAt: "2026-05-30T00:00:00.000Z",
    };
    const securityTests = parsePromptPackTests(
      fs.readFileSync(
        path.resolve(process.cwd(), "..", "..", "goatcitadel_prompt_pack_v6_security_red_team.md"),
        "utf8",
      ),
    ).map((test) => ({
      ...test,
      packId: importedPack.packId,
    }));
    const service = new PromptPackService(
      {
        storage: {
          promptPacks: {
            listPacks: () => [importedPack],
            getPack: () => importedPack,
            listTests: () => securityTests,
          },
          promptPackRuns: { listByPack: () => [] },
          promptPackScores: { listByPack: () => [] },
          promptPackAutoScoresV2: { listByPack: () => [] },
          promptPackHumanReviewsV2: { listByPack: () => [] },
        },
        config: {
          rootDir: process.cwd(),
          assistant: {
            workspaceDir: ".",
            durable: {
              enabled: true,
              executionEnabled: true,
              chatAutoPromoteEnabled: true,
            },
          },
        },
      } as never,
      {
        createChatSession: vi.fn(),
        agentSendChatMessage: vi.fn(),
        createChatCompletion: vi.fn(),
        getPromptRunnerModelDefaults: () => ({ providerId: "openai", model: "gpt-5.4" }),
        getPromptJudgeModelDefaults: () => ({ providerId: "openai", model: "gpt-5.4" }),
        backgroundTasks: new Set(),
      },
    );

    const projection = service.listSecurityEvalPacks();
    expect(projection.warnings.join(" ")).toContain("does not call providers");
    expect(projection.items[0]).toMatchObject({
      packKey: "security-red-team-v6",
      status: "imported",
      importedPackId: "pack-security",
      testCount: 18,
      modeCounts: { chat: 6, cowork: 6, code: 6 },
      toolTierCounts: { "no-tools": 6, "implicit-tools": 6, "explicit-tools": 6 },
      safetyPosture: {
        definitionOnly: true,
        requiresOperatorRun: true,
        callsProviders: false,
        mutationPerformed: false,
      },
      blockers: [],
    });
    expect(projection.items[0]?.capabilityTargets.length).toBeGreaterThan(0);
    expect(projection.items[0]?.likelyFailureClasses.length).toBeGreaterThan(0);

    const gates = service.listSecurityQualityGates();
    expect(gates.items[0]).toMatchObject({
      gateId: "prompt-pack:security-red-team-v6:security-quality",
      packKey: "security-red-team-v6",
      packId: "pack-security",
      status: "not_run",
      releaseGate: true,
      readOnly: true,
      evidence: {
        definitionStatus: "imported",
        testCount: 18,
        completedRuns: 0,
        needsScoreCount: 0,
      },
      posture: {
        callsProviders: false,
        mutationPerformed: false,
        source: "stored_prompt_pack_report",
      },
    });
    expect(gates.items[0]?.blockers.join(" ")).toContain("Run the imported defensive security prompt-pack tests");
  });

  it("recognizes the imported built-in security pack by canonical pack id and hyphenated source label", () => {
    const importedPack = {
      packId: "security-red-team-v6",
      name: "Defensive Security Evaluation",
      sourceLabel: "goatcitadel-prompt-pack-v6-security-red-team.md",
      testCount: 18,
      createdAt: "2026-05-30T00:00:00.000Z",
      updatedAt: "2026-05-30T00:00:00.000Z",
    };
    const securityTests = parsePromptPackTests(
      fs.readFileSync(
        path.resolve(process.cwd(), "..", "..", "goatcitadel_prompt_pack_v6_security_red_team.md"),
        "utf8",
      ),
    ).map((test) => ({
      ...test,
      packId: importedPack.packId,
    }));
    const service = new PromptPackService(
      {
        storage: {
          promptPacks: {
            listPacks: () => [importedPack],
            getPack: () => importedPack,
            listTests: () => securityTests,
          },
          promptPackRuns: { listByPack: () => [] },
          promptPackScores: { listByPack: () => [] },
          promptPackAutoScoresV2: { listByPack: () => [] },
          promptPackHumanReviewsV2: { listByPack: () => [] },
        },
        config: {
          rootDir: process.cwd(),
          assistant: {
            workspaceDir: ".",
            durable: {
              enabled: true,
              executionEnabled: true,
              chatAutoPromoteEnabled: true,
            },
          },
        },
      } as never,
      {
        createChatSession: vi.fn(),
        agentSendChatMessage: vi.fn(),
        createChatCompletion: vi.fn(),
        getPromptRunnerModelDefaults: () => ({ providerId: "openai", model: "gpt-5.4" }),
        getPromptJudgeModelDefaults: () => ({ providerId: "openai", model: "gpt-5.4" }),
        backgroundTasks: new Set(),
      },
    );

    const projection = service.listSecurityEvalPacks();
    expect(projection.items[0]).toMatchObject({
      packKey: "security-red-team-v6",
      status: "imported",
      importedPackId: "security-red-team-v6",
      blockers: [],
    });

    const gates = service.listSecurityQualityGates();
    expect(gates.items[0]).toMatchObject({
      status: "not_run",
      packId: "security-red-team-v6",
      evidence: {
        definitionStatus: "imported",
      },
    });
    expect(gates.items[0]?.nextActions).not.toContain(
      "Import the defensive security prompt pack from Ops Quality or Library Prompt Packs.",
    );
  });

  it("does not treat a spoofed canonical security pack id as imported release evidence", () => {
    const spoofedPack = {
      packId: "security-red-team-v6",
      name: "Custom Operator Checks",
      sourceLabel: "custom-pack.md",
      testCount: 1,
      createdAt: "2026-05-30T00:00:00.000Z",
      updatedAt: "2026-05-30T00:00:00.000Z",
    };
    const service = new PromptPackService(
      {
        storage: {
          promptPacks: {
            listPacks: () => [spoofedPack],
            getPack: () => spoofedPack,
            listTests: () => [],
          },
          promptPackRuns: { listByPack: () => [] },
          promptPackScores: { listByPack: () => [] },
          promptPackAutoScoresV2: { listByPack: () => [] },
          promptPackHumanReviewsV2: { listByPack: () => [] },
        },
        config: {
          rootDir: process.cwd(),
          assistant: {
            workspaceDir: ".",
            durable: {
              enabled: true,
              executionEnabled: true,
              chatAutoPromoteEnabled: true,
            },
          },
        },
      } as never,
      {
        createChatSession: vi.fn(),
        agentSendChatMessage: vi.fn(),
        createChatCompletion: vi.fn(),
        getPromptRunnerModelDefaults: () => ({ providerId: "openai", model: "gpt-5.4" }),
        getPromptJudgeModelDefaults: () => ({ providerId: "openai", model: "gpt-5.4" }),
        backgroundTasks: new Set(),
      },
    );

    const projection = service.listSecurityEvalPacks();
    expect(projection.items[0]).toMatchObject({
      packKey: "security-red-team-v6",
      status: "available",
      importedPackId: undefined,
    });

    const gates = service.listSecurityQualityGates();
    expect(gates.items[0]).toMatchObject({
      status: "not_imported",
      evidence: {
        definitionStatus: "available",
      },
    });
    expect(gates.items[0]?.packId).toBeUndefined();
    expect(gates.items[0]?.nextActions).toContain(
      "Import the defensive security prompt pack from Ops Quality or Library Prompt Packs.",
    );
  });

  it("parses dotted manual test codes so they survive import refreshes", () => {
    const markdown = [
      "## 2.6 Baseline sanity check",
      "Validate the baseline behavior.",
      "",
      "## 2.7 Streaming refresh check",
      "Verify the list updates after the first run.",
      "",
      "[2.8] Follow-up regression",
      "Confirm the previous fix still holds.",
    ].join("\n");

    const tests = parsePromptPackTests(markdown);

    expect(tests.map((test) => test.code)).toEqual(["2.6", "2.7", "2.8"]);
    expect(tests[1]).toMatchObject({
      code: "2.7",
      title: "Streaming refresh check",
    });
  });
});
