import { describe, expect, it, vi } from "vitest";

vi.mock("node:sqlite", () => ({
  DatabaseSync: class DatabaseSync {},
  StatementSync: class StatementSync {},
}));

import type {
  PromptPackHumanReviewRecordV2,
  PromptPackRecord,
  PromptPackScoreRecordV2,
  PromptPackRunRecord,
  PromptPackScoreRecord,
  PromptPackTestRecord,
} from "@goatcitadel/contracts";
import {
  PromptPackService,
  assertPromptPackRunScorable,
  buildPromptPackJudgeRecord,
  buildPromptPackReportSummary,
  buildPromptPackCapabilitySeries,
  buildPromptPackRunFailureRateSeries,
  evaluatePromptPackRunIntegrity,
  evaluatePromptPackRuleScores,
  extractPromptPackCompletionText,
  mergePromptPackAutoScoresV2,
  mergePromptPackAutoScoresV3,
  normalizePromptPackJudgeScores,
  pickReplayBaselineScore,
  resolvePromptPackEffectiveJudgeStatusV2,
  resolvePromptPackRunIntegrity,
  resolvePromptPackJudgeTarget,
  resolvePromptPackJudgeTemperature,
  resolvePromptPackJudgeServiceTier,
  resolvePromptPackExecutionProfile,
  renderPromptPackMarkdownReport,
  resolvePromptPackScoreFacingResponseText,
} from "./prompt-pack-service.js";
import { DEFAULT_PROMPT_PACK_POLICY_V2, DEFAULT_PROMPT_PACK_POLICY_V3 } from "@goatcitadel/contracts";
import { hashPromptPackPolicyV2, hashPromptPackPolicyV3 } from "@goatcitadel/storage";
import { createPack, createRun, createScore, createTest, createTrace } from "./prompt-pack-service-test-fixtures.js";

describe("prompt-pack scoring, judging, and integrity", () => {
  it("scores the raw model output even when a fabricated finalResponseText is present", () => {
    const test: PromptPackTestRecord = {
      testId: "test-final-response",
      packId: "pack-1",
      code: "TEST-D509",
      title: "Final Response",
      prompt:
        "Use repo inspection to trace the `POST /api/v1/prompt-packs/:packId/tests/:testId/auto-score` path. Each section must cite exact file paths.",
      orderIndex: 0,
      mode: "code",
      toolTier: "explicit-tools",
      createdAt: "2026-03-14T00:00:00.000Z",
    };
    const run: PromptPackRunRecord = {
      runId: "run-final-response",
      packId: "pack-1",
      testId: test.testId,
      status: "completed",
      mode: "code",
      toolTier: "explicit-tools",
      responseText: "## Exact files used\n- apps/gateway/src/routes/prompt-packs.ts\n\n## Patch points\n- incomplete",
      finalResponseText: [
        "## Route",
        "- `apps/gateway/src/routes/prompt-packs.ts`: registers the auto-score route.",
        "",
        "## Service",
        "- `apps/gateway/src/services/prompt-pack-service.ts`: resolves the run and creates the score.",
        "",
        "## Storage",
        "- `packages/storage/src/prompt-pack-auto-score-v2-repo.ts`: persists the auto-score record.",
        "",
        "## Current default schema",
        "- `apps/gateway/src/services/prompt-pack-policy.ts`: defines the current default schema.",
        "",
        "## One regression risk",
        "- A v2-only assumption could hide v3 attribution.",
      ].join("\n"),
      finalResponseSignals: ["prompt_lab_score_facing_normalization"],
      trace: {
        turnId: "turn-final-response",
        sessionId: "sess-final-response",
        userMessageId: "user-final-response",
        branchKind: "append",
        status: "completed",
        mode: "code",
        webMode: "off",
        memoryMode: "off",
        thinkingLevel: "extended",
        startedAt: "2026-03-14T00:00:00.000Z",
        finishedAt: "2026-03-14T00:00:01.000Z",
        citations: [],
        routing: {},
        toolRuns: [
          {
            toolRunId: "tool-final-response",
            turnId: "turn-final-response",
            sessionId: "sess-final-response",
            toolName: "file.read_range",
            status: "executed",
            startedAt: "2026-03-14T00:00:00.000Z",
            finishedAt: "2026-03-14T00:00:01.000Z",
            args: { path: "apps/gateway/src/services/prompt-pack-service.ts" },
            result: { path: "apps/gateway/src/services/prompt-pack-service.ts", content: "autoScorePromptPackTest" },
          },
          {
            toolRunId: "tool-final-response-bad-path",
            turnId: "turn-final-response",
            sessionId: "sess-final-response",
            toolName: "code.search_files",
            status: "blocked",
            startedAt: "2026-03-14T00:00:00.500Z",
            finishedAt: "2026-03-14T00:00:00.750Z",
            args: { path: "api/v1/prompt-packs/", query: "prompt-packs.ts" },
            error: "execution error: ENOENT: no such file or directory",
            failureGuidance: "Retry search files with a narrower, more explicit input.",
          },
        ],
      },
      startedAt: "2026-03-14T00:00:00.000Z",
      finishedAt: "2026-03-14T00:00:01.000Z",
    };

    expect(resolvePromptPackScoreFacingResponseText(run)).toContain("## Exact files used");
    expect(resolvePromptPackRunIntegrity(test.prompt, run).validationStatus).toBe("valid");

    const evaluation = evaluatePromptPackRuleScores({
      prompt: test.prompt,
      profile: resolvePromptPackExecutionProfile({ test }),
      run,
    });

    expect(evaluation.signals).toContain("missing_file_specific_evidence");
    expect(evaluation.signals).not.toContain("file_specific_evidence_present");
    expect(evaluation.signals).toContain("required_tool_usage_present");
    expect(evaluation.scores.robustnessScore).not.toBe(0);
    expect(run.responseText).toContain("Patch points");
  });

  it("keeps unrelated failed local-path attempts visible in scoring", () => {
    const test: PromptPackTestRecord = {
      testId: "test-unrelated-path-recovery",
      packId: "pack-1",
      code: "TEST-D510",
      title: "Unrelated path recovery",
      prompt:
        "Use file/code tools to inspect `apps/gateway/src/services/skill-import-service.ts` and cite the exact files used.",
      orderIndex: 0,
      mode: "code",
      toolTier: "explicit-tools",
      createdAt: "2026-03-14T00:00:00.000Z",
    };
    const profile = resolvePromptPackExecutionProfile({ test });
    const evaluation = evaluatePromptPackRuleScores({
      prompt: test.prompt,
      profile,
      run: {
        ...createRun("run-unrelated-path-recovery", "completed", "2026-03-14T00:00:00.000Z"),
        testId: test.testId,
        mode: "code",
        toolTier: "explicit-tools",
        responseText: [
          "## Evidence",
          "- `apps/gateway/src/services/prompt-pack-service.ts` handles prompt-pack scoring.",
          "",
          "## Result",
          "- The answer uses the implementation file that was actually read.",
        ].join("\n"),
        trace: createTrace("sess-unrelated-path-recovery", {
          mode: "code",
          toolRuns: [
            {
              toolRunId: "tool-missing-target",
              turnId: "turn-sess-unrelated-path-recovery",
              sessionId: "sess-unrelated-path-recovery",
              toolName: "code.search_files",
              status: "failed",
              args: {
                path: "apps/gateway/src/services/skill-import-service.ts",
                query: "importSkillTrust",
              },
              error: "execution error: ENOENT: no such file or directory",
              startedAt: "2026-03-14T00:00:00.000Z",
              finishedAt: "2026-03-14T00:00:00.250Z",
            },
            {
              toolRunId: "tool-unrelated-read",
              turnId: "turn-sess-unrelated-path-recovery",
              sessionId: "sess-unrelated-path-recovery",
              toolName: "file.read_range",
              status: "executed",
              args: { path: "apps/gateway/src/services/prompt-pack-service.ts" },
              result: {
                path: "apps/gateway/src/services/prompt-pack-service.ts",
                content: "export function evaluatePromptPackRuleScores() {}",
              },
              startedAt: "2026-03-14T00:00:00.300Z",
              finishedAt: "2026-03-14T00:00:01.000Z",
            },
          ],
        }),
      },
    });

    expect(evaluation.signals).toContain("required_tool_usage_present");
    expect(evaluation.signals).toContain("tool_failures_not_acknowledged");
  });

  it("penalizes missing required tool usage for explicit-tools runs", () => {
    const test: PromptPackTestRecord = {
      testId: "test-explicit",
      packId: "pack-1",
      code: "TEST-03",
      title: "Explicit Tools",
      prompt: "Look up the docs and explain the result.",
      orderIndex: 0,
      mode: "code",
      toolTier: "explicit-tools",
      createdAt: "2026-03-14T00:00:00.000Z",
    };
    const profile = resolvePromptPackExecutionProfile({ test });
    const evaluation = evaluatePromptPackRuleScores({
      prompt: test.prompt,
      profile,
      run: {
        runId: "run-explicit",
        packId: "pack-1",
        testId: test.testId,
        sessionId: "sess-1",
        status: "completed",
        mode: "code",
        toolTier: "explicit-tools",
        toolAutonomy: "safe_auto",
        webMode: "auto",
        memoryMode: "auto",
        thinkingLevel: "extended",
        responseText: "Here is the answer.",
        trace: {
          turnId: "turn-1",
          sessionId: "sess-1",
          userMessageId: "user-1",
          branchKind: "append",
          status: "completed",
          mode: "code",
          webMode: "auto",
          memoryMode: "auto",
          thinkingLevel: "extended",
          startedAt: "2026-03-14T00:00:00.000Z",
          finishedAt: "2026-03-14T00:00:01.000Z",
          toolRuns: [],
          citations: [],
          routing: {},
        },
        startedAt: "2026-03-14T00:00:00.000Z",
        finishedAt: "2026-03-14T00:00:01.000Z",
      },
    });

    expect(evaluation.scores.routingScore).toBe(0);
    expect(evaluation.scores.robustnessScore).toBe(0);
    expect(evaluation.signals).toContain("missing_required_tool_usage");
  });

  it("does not penalize explicit-tools negative controls for zero tool usage", () => {
    const test: PromptPackTestRecord = {
      testId: "test-explicit-no-lookup",
      packId: "pack-1",
      code: "TEST-03N",
      title: "Explicit No Lookup",
      prompt:
        'Tools are available, but the user says: "Please do not look anything up. I only want a quick gut-check based on the details I typed."\n\nAnswer without tools. Give a concise gut-check and clearly label it as non-verified.',
      orderIndex: 0,
      mode: "chat",
      toolTier: "explicit-tools",
      createdAt: "2026-03-14T00:00:00.000Z",
    };
    const profile = resolvePromptPackExecutionProfile({ test });
    const evaluation = evaluatePromptPackRuleScores({
      prompt: test.prompt,
      profile,
      run: {
        runId: "run-explicit-no-lookup",
        packId: "pack-1",
        testId: test.testId,
        sessionId: "sess-1",
        status: "completed",
        mode: "chat",
        toolTier: "explicit-tools",
        toolAutonomy: "safe_auto",
        webMode: "auto",
        memoryMode: "auto",
        thinkingLevel: "standard",
        responseText:
          "Non-verified gut-check: I do not have enough specifics to assess the details, but I will not look anything up.",
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
          toolRuns: [],
          citations: [],
          routing: {},
        },
        startedAt: "2026-03-14T00:00:00.000Z",
        finishedAt: "2026-03-14T00:00:01.000Z",
      },
    });

    expect(evaluation.scores.routingScore).toBe(2);
    expect(evaluation.signals).toContain("explicit_tools_suppressed_respected");
    expect(evaluation.signals).not.toContain("missing_required_tool_usage");
  });

  it("hard-fails blocked explicit-tool attempts when no required tool executes", () => {
    const test: PromptPackTestRecord = {
      testId: "test-explicit-attempted",
      packId: "pack-1",
      code: "TEST-03B",
      title: "Explicit Tools Attempted",
      prompt: "Use browser.navigate to open the URL and report exactly what failed.",
      orderIndex: 0,
      mode: "chat",
      toolTier: "explicit-tools",
      createdAt: "2026-03-14T00:00:00.000Z",
    };
    const profile = resolvePromptPackExecutionProfile({ test });
    const evaluation = evaluatePromptPackRuleScores({
      prompt: test.prompt,
      profile,
      run: {
        runId: "run-explicit-attempted",
        packId: "pack-1",
        testId: test.testId,
        sessionId: "sess-1",
        status: "completed",
        mode: "chat",
        toolTier: "explicit-tools",
        toolAutonomy: "safe_auto",
        webMode: "auto",
        memoryMode: "auto",
        thinkingLevel: "standard",
        responseText: "browser.navigate failed with fetch failed.",
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
        startedAt: "2026-03-14T00:00:00.000Z",
        finishedAt: "2026-03-14T00:00:01.000Z",
      },
    });

    expect(evaluation.scores.routingScore).toBe(0);
    expect(evaluation.scores.robustnessScore).toBe(0);
    expect(evaluation.signals).toContain("required_tool_usage_attempted");
    expect(evaluation.signals).toContain("missing_required_tool_usage");
    expect(evaluation.signals).toContain("missing_required_tool:browser.navigate");
  });

  it("hard-fails explicit memory prompts when no memory tool executes", () => {
    const test: PromptPackTestRecord = {
      testId: "test-explicit-memory-missing",
      packId: "pack-1",
      code: "TEST-MEM-MISSING",
      title: "Explicit memory missing",
      prompt: "Use available memory/context to summarize how I like technical answers formatted.",
      orderIndex: 0,
      mode: "chat",
      toolTier: "explicit-tools",
      createdAt: "2026-03-14T00:00:00.000Z",
    };
    const profile = resolvePromptPackExecutionProfile({ test });
    const evaluation = evaluatePromptPackRuleScores({
      prompt: test.prompt,
      profile,
      run: {
        ...createRun("run-memory-missing", "completed", "2026-03-14T00:00:00.000Z"),
        testId: test.testId,
        mode: "chat",
        toolTier: "explicit-tools",
        responseText: "From the visible prompt alone, I cannot know your durable formatting preferences.",
        trace: createTrace("sess-memory-missing", { toolRuns: [] }),
      },
    });

    expect(evaluation.scores.routingScore).toBe(0);
    expect(evaluation.scores.robustnessScore).toBe(0);
    expect(evaluation.signals).toContain("missing_required_tool_usage");
    expect(evaluation.signals).toContain("missing_required_tool:memory tool");
  });

  it("hard-fails explicit code prompts when only the wrong tool family executes", () => {
    const test: PromptPackTestRecord = {
      testId: "test-explicit-code-wrong-tool",
      packId: "pack-1",
      code: "TEST-CODE-MISSING",
      title: "Explicit code missing",
      prompt: "Use file/code tools to inspect the repo and cite the exact files used.",
      orderIndex: 0,
      mode: "code",
      toolTier: "explicit-tools",
      createdAt: "2026-03-14T00:00:00.000Z",
    };
    const profile = resolvePromptPackExecutionProfile({ test });
    const evaluation = evaluatePromptPackRuleScores({
      prompt: test.prompt,
      profile,
      run: {
        ...createRun("run-code-wrong-tool", "completed", "2026-03-14T00:00:00.000Z"),
        testId: test.testId,
        mode: "code",
        toolTier: "explicit-tools",
        responseText: "I inspected the repo and found the issue.",
        trace: createTrace("sess-code-wrong-tool", {
          toolRuns: [
            {
              toolRunId: "tool-web",
              turnId: "turn-sess-code-wrong-tool",
              sessionId: "sess-code-wrong-tool",
              toolName: "browser.search",
              status: "executed",
              startedAt: "2026-03-14T00:00:00.000Z",
              finishedAt: "2026-03-14T00:00:00.500Z",
            },
          ],
        }),
      },
    });

    expect(evaluation.scores.routingScore).toBe(0);
    expect(evaluation.signals).toContain("missing_required_tool_usage");
    expect(evaluation.signals).toContain("missing_required_tool:file/code tool");
  });

  it("penalizes self-reported partial outputs even when tools executed", () => {
    const test: PromptPackTestRecord = {
      testId: "test-partial",
      packId: "pack-1",
      code: "TEST-04",
      title: "Partial",
      prompt: "Use tools to extract the full JSON payload and verify all fields.",
      orderIndex: 0,
      mode: "code",
      toolTier: "explicit-tools",
      createdAt: "2026-03-14T00:00:00.000Z",
    };
    const profile = resolvePromptPackExecutionProfile({ test });
    const evaluation = evaluatePromptPackRuleScores({
      prompt: test.prompt,
      profile,
      run: {
        runId: "run-partial",
        packId: "pack-1",
        testId: test.testId,
        sessionId: "sess-1",
        status: "completed",
        mode: "code",
        toolTier: "explicit-tools",
        toolAutonomy: "safe_auto",
        webMode: "auto",
        memoryMode: "auto",
        thinkingLevel: "extended",
        responseText:
          "This is a partial answer recovered from tool output because the final synthesis pass did not finish cleanly.",
        trace: {
          turnId: "turn-1",
          sessionId: "sess-1",
          userMessageId: "user-1",
          branchKind: "append",
          status: "completed",
          mode: "code",
          webMode: "auto",
          memoryMode: "auto",
          thinkingLevel: "extended",
          startedAt: "2026-03-14T00:00:00.000Z",
          finishedAt: "2026-03-14T00:00:01.000Z",
          toolRuns: [
            {
              toolRunId: "tool-1",
              turnId: "turn-1",
              sessionId: "sess-1",
              toolName: "browser.navigate",
              status: "executed",
              startedAt: "2026-03-14T00:00:00.000Z",
              finishedAt: "2026-03-14T00:00:01.000Z",
            },
            {
              toolRunId: "tool-2",
              turnId: "turn-1",
              sessionId: "sess-1",
              toolName: "memory.read",
              status: "blocked",
              error: "Unsupported tool executor: memory.read",
              startedAt: "2026-03-14T00:00:00.000Z",
              finishedAt: "2026-03-14T00:00:01.000Z",
            },
          ],
          citations: [],
          routing: {},
        },
        startedAt: "2026-03-14T00:00:00.000Z",
        finishedAt: "2026-03-14T00:00:01.000Z",
      },
    });

    expect(evaluation.scores.robustnessScore).toBe(0);
    expect(evaluation.scores.usabilityScore).toBe(0);
    expect(evaluation.signals).toContain("self_reported_incomplete_output");
    expect(evaluation.signals).toContain("tool_blockers_prevented_completion");
  });

  it("does not treat a blocked tool report as incomplete output by itself", () => {
    const test: PromptPackTestRecord = {
      testId: "test-blocked-report",
      packId: "pack-1",
      code: "TEST-C23",
      title: "Blocked report",
      prompt: "Attempt browser.navigate and report the blocked tool path exactly if access is denied.",
      orderIndex: 0,
      mode: "chat",
      toolTier: "explicit-tools",
      createdAt: "2026-03-14T00:00:00.000Z",
    };
    const profile = resolvePromptPackExecutionProfile({ test });
    const evaluation = evaluatePromptPackRuleScores({
      prompt: test.prompt,
      profile,
      run: {
        runId: "run-blocked-report",
        packId: "pack-1",
        testId: test.testId,
        sessionId: "sess-1",
        status: "completed",
        mode: "chat",
        toolTier: "explicit-tools",
        toolAutonomy: "safe_auto",
        webMode: "auto",
        memoryMode: "auto",
        thinkingLevel: "standard",
        responseText: "browser.navigate was blocked by policy, so I cannot claim the page contents.",
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
              error: "policy denied browser.navigate",
              startedAt: "2026-03-14T00:00:00.000Z",
              finishedAt: "2026-03-14T00:00:01.000Z",
            },
          ],
          citations: [],
          routing: {},
        },
        startedAt: "2026-03-14T00:00:00.000Z",
        finishedAt: "2026-03-14T00:00:01.000Z",
      },
    });

    expect(evaluation.signals).not.toContain("self_reported_incomplete_output");
    expect(evaluation.scores.robustnessScore).toBe(0);
    expect(evaluation.signals).toContain("missing_required_tool_usage");
  });

  it("does not require JSON output when the prompt explicitly forbids JSON", () => {
    const integrity = evaluatePromptPackRunIntegrity({
      prompt: [
        "Use file or code tools to inspect how repo-managed imported skills record trust metadata in `skills/extra/<skill-id>/`.",
        "Return exactly three bullets labeled `Observed fields`, `Operator-usable fields`, and `Still ambiguous`.",
        "Do not return JSON.",
      ].join(" "),
      responseText: [
        "- **Observed fields** - `sourceProvider` and `sourceRef` are persisted in the stored manifest.",
        "- **Operator-usable fields** - Operators can rely on the stored source reference and canonical key when reviewing imports.",
        "- **Still ambiguous** - Risk scoring provenance is not exposed in the same manifest.",
      ].join("\n"),
      trace: createTrace("sess-no-json-required"),
    });

    expect(integrity.validationStatus).toBe("valid");
    expect(integrity.signals).not.toContain("missing_requested_json_output");
  });

  it("does not require table output when the prompt explicitly forbids a table", () => {
    const integrity = evaluatePromptPackRunIntegrity({
      prompt: [
        "Use file or code tools to inspect lifecycle assembly, approval linkage loading, realtime-event linkage, and Mission Control approvals or runtime views.",
        "Use exactly three bullets labeled `Canonical path`, `Inference path`, and `Fallback gap`.",
        "Do not return a table.",
      ].join(" "),
      responseText: [
        "- **Canonical path** - Stored lifecycle state comes from the runtime lifecycle persistence layer.",
        "- **Inference path** - UI responses may infer missing links from adjacent events or preview payloads.",
        "- **Fallback gap** - Missing canonical linkage remains unresolved without a direct persisted field.",
      ].join("\n"),
      trace: createTrace("sess-no-table-required"),
    });

    expect(integrity.validationStatus).toBe("valid");
    expect(integrity.signals).not.toContain("missing_requested_table_output");
  });

  it("does not flag missing requested JSON in rule scores when the prompt forbids JSON", () => {
    const test: PromptPackTestRecord = {
      testId: "test-no-json-output",
      packId: "pack-1",
      code: "TEST-NO-JSON",
      title: "No JSON output",
      prompt: "Summarize the trust metadata in three bullets. Do not return JSON.",
      orderIndex: 0,
      mode: "chat",
      toolTier: "no-tools",
      createdAt: "2026-03-14T00:00:00.000Z",
    };
    const profile = resolvePromptPackExecutionProfile({ test });
    const evaluation = evaluatePromptPackRuleScores({
      prompt: test.prompt,
      profile,
      run: {
        runId: "run-no-json-output",
        packId: "pack-1",
        testId: test.testId,
        sessionId: "sess-no-json-output",
        status: "completed",
        mode: "chat",
        toolTier: "no-tools",
        toolAutonomy: "manual",
        webMode: "off",
        memoryMode: "off",
        thinkingLevel: "standard",
        responseText:
          "- Observed fields: source metadata is persisted.\n- Operator fields: canonical references remain visible.\n- Still ambiguous: confidence scoring is not surfaced.",
        trace: createTrace("sess-no-json-output"),
        startedAt: "2026-03-14T00:00:00.000Z",
        finishedAt: "2026-03-14T00:00:01.000Z",
      },
    });

    expect(evaluation.signals).not.toContain("missing_requested_json_output");
  });

  it("does not flag missing requested table output in rule scores when the prompt forbids tables", () => {
    const test: PromptPackTestRecord = {
      testId: "test-no-table-output",
      packId: "pack-1",
      code: "TEST-NO-TABLE",
      title: "No table output",
      prompt: "Summarize the lifecycle linkage in three bullets. Do not return a table.",
      orderIndex: 0,
      mode: "chat",
      toolTier: "no-tools",
      createdAt: "2026-03-14T00:00:00.000Z",
    };
    const profile = resolvePromptPackExecutionProfile({ test });
    const evaluation = evaluatePromptPackRuleScores({
      prompt: test.prompt,
      profile,
      run: {
        runId: "run-no-table-output",
        packId: "pack-1",
        testId: test.testId,
        sessionId: "sess-no-table-output",
        status: "completed",
        mode: "chat",
        toolTier: "no-tools",
        toolAutonomy: "manual",
        webMode: "off",
        memoryMode: "off",
        thinkingLevel: "standard",
        responseText:
          "- Canonical path: lifecycle state is persisted.\n- Inference path: some views reconstruct links.\n- Fallback gap: a direct persisted linkage is still missing.",
        trace: createTrace("sess-no-table-output"),
        startedAt: "2026-03-14T00:00:00.000Z",
        finishedAt: "2026-03-14T00:00:01.000Z",
      },
    });

    expect(evaluation.signals).not.toContain("missing_requested_table_output");
  });

  it("uses kimi-compatible temperature for prompt-pack model judging", () => {
    expect(resolvePromptPackJudgeTemperature("moonshot", "moonshot/kimi-k2.6")).toBe(1);
    expect(resolvePromptPackJudgeTemperature("openai", "gpt-5")).toBe(0);
    expect(resolvePromptPackJudgeTemperature("openai-codex", "gpt-5.5")).toBeUndefined();
    expect(resolvePromptPackJudgeTemperature("chatgpt-codex", "gpt-5.5")).toBeUndefined();
    expect(resolvePromptPackJudgeTemperature("openai", "openai-codex/gpt-5.5")).toBeUndefined();
    expect(resolvePromptPackJudgeTemperature(undefined, "kimi-k2")).toBe(1);
  });

  it("uses flex processing only for OpenAI prompt-pack judging", () => {
    expect(resolvePromptPackJudgeServiceTier("openai")).toBe("flex");
    expect(resolvePromptPackJudgeServiceTier("moonshot")).toBeUndefined();
    expect(resolvePromptPackJudgeServiceTier(undefined)).toBeUndefined();
  });

  it("prefers the default judge target for kimi and local runtime families", () => {
    expect(
      resolvePromptPackJudgeTarget({
        runProviderId: "glm",
        runModel: "glm-5-turbo",
        defaultProviderId: "openai",
        defaultModel: "gpt-5.4",
      }),
    ).toEqual({
      providerId: "glm",
      model: "glm-5-turbo",
    });

    expect(
      resolvePromptPackJudgeTarget({
        runProviderId: "moonshot",
        runModel: "kimi-k2.6",
        defaultProviderId: "openai",
        defaultModel: "gpt-5.4",
      }),
    ).toEqual({
      providerId: "openai",
      model: "gpt-5.4",
    });

    expect(
      resolvePromptPackJudgeTarget({
        runProviderId: "ollama",
        runModel: "qwen3.5:9b",
        defaultProviderId: "openai",
        defaultModel: "gpt-5.4",
      }),
    ).toEqual({
      providerId: "openai",
      model: "gpt-5.4",
    });

    expect(
      resolvePromptPackJudgeTarget({
        runProviderId: "llamacpp",
        runModel: "gemma-4",
        defaultProviderId: "openai",
        defaultModel: "gpt-5.4",
      }),
    ).toEqual({
      providerId: "openai",
      model: "gpt-5.4",
    });
  });

  it("penalizes concrete table requests that detour into meta analysis", () => {
    const test: PromptPackTestRecord = {
      testId: "test-table-detour",
      packId: "pack-1",
      code: "TEST-06",
      title: "Table Detour",
      prompt: "Use browser.search to compare three libraries and present them in a table with stars and open issues.",
      orderIndex: 0,
      mode: "cowork",
      toolTier: "explicit-tools",
      createdAt: "2026-03-14T00:00:00.000Z",
    };
    const profile = resolvePromptPackExecutionProfile({ test });
    const evaluation = evaluatePromptPackRuleScores({
      prompt: test.prompt,
      profile,
      run: {
        runId: "run-table-detour",
        packId: "pack-1",
        testId: test.testId,
        sessionId: "sess-1",
        status: "completed",
        mode: "cowork",
        toolTier: "explicit-tools",
        toolAutonomy: "safe_auto",
        webMode: "auto",
        memoryMode: "auto",
        thinkingLevel: "extended",
        responseText: [
          "**Critique: Methodological Weaknesses in Library Comparison**",
          "",
          "### 1. Stars Are a Lagging Popularity Indicator",
          "",
          "**Blind spot:** Open issues count is misleading.",
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
          toolRuns: [
            {
              toolRunId: "tool-1",
              turnId: "turn-1",
              sessionId: "sess-1",
              toolName: "browser.search",
              status: "executed",
              startedAt: "2026-03-14T00:00:00.000Z",
              finishedAt: "2026-03-14T00:00:01.000Z",
            },
          ],
          citations: [],
          routing: {},
        },
        startedAt: "2026-03-14T00:00:00.000Z",
        finishedAt: "2026-03-14T00:00:01.000Z",
      },
    });

    expect(evaluation.scores.routingScore).toBe(0);
    expect(evaluation.scores.usabilityScore).toBe(0);
    expect(evaluation.signals).toContain("missing_requested_table_output");
    expect(evaluation.signals).toContain("off_target_meta_analysis");
  });

  it("scores prompt-pack summaries from the latest run per test only", () => {
    const tests: PromptPackTestRecord[] = [
      {
        testId: "test-1",
        packId: "pack-1",
        code: "TEST-01",
        title: "First",
        prompt: "First prompt",
        orderIndex: 0,
        mode: "chat",
        toolTier: "implicit-tools",
        createdAt: "2026-03-14T00:00:00.000Z",
      },
      {
        testId: "test-2",
        packId: "pack-1",
        code: "TEST-02",
        title: "Second",
        prompt: "Second prompt",
        orderIndex: 1,
        mode: "chat",
        toolTier: "implicit-tools",
        createdAt: "2026-03-14T00:00:00.000Z",
      },
    ];
    const runs: PromptPackRunRecord[] = [
      {
        ...createRun("run-1-new", "completed", "2026-03-15T00:00:00.000Z"),
        testId: "test-1",
        trace: {
          turnId: "turn-1-new",
          sessionId: "sess-run-1-new",
          userMessageId: "msg-1",
          branchKind: "append",
          status: "completed",
          mode: "chat",
          webMode: "auto",
          memoryMode: "auto",
          thinkingLevel: "standard",
          startedAt: "2026-03-15T00:00:00.000Z",
          finishedAt: "2026-03-15T00:00:01.000Z",
          toolRuns: [],
          citations: [],
          routing: {},
          durable: {
            runId: "dur-run-1",
            status: "completed",
            checkpointKind: "run_completed",
          },
        },
      },
      {
        ...createRun("run-1-old", "completed", "2026-03-14T00:00:00.000Z"),
        testId: "test-1",
      },
      {
        ...createRun("run-2", "failed", "2026-03-15T00:05:00.000Z"),
        testId: "test-2",
        trace: {
          turnId: "turn-2",
          sessionId: "sess-run-2",
          userMessageId: "msg-2",
          branchKind: "append",
          status: "waiting_for_approval",
          mode: "chat",
          webMode: "auto",
          memoryMode: "auto",
          thinkingLevel: "standard",
          startedAt: "2026-03-15T00:05:00.000Z",
          toolRuns: [],
          citations: [],
          routing: {},
          durable: {
            runId: "dur-run-2",
            status: "backgrounded",
            checkpointKind: "run_waiting",
          },
        },
      },
    ];
    const scores: PromptPackScoreRecord[] = [
      {
        ...createScore("score-old", "run-1-old", "2026-03-14T00:05:00.000Z", 2),
        testId: "test-1",
      },
    ];

    const summary = buildPromptPackReportSummary(tests, runs, scores);

    expect(summary.completedRuns).toBe(1);
    expect(summary.failedRuns).toBe(1);
    expect(summary.runFailureCount).toBe(1);
    expect(summary.scoreFailureCount).toBe(0);
    expect(summary.needsScoreCount).toBe(1);
    expect(summary.durableRuns).toBe(2);
    expect(summary.approvalPausedRuns).toBe(1);
    expect(summary.backgroundedRuns).toBe(1);
    expect(summary.averageTotalScore).toBe(0);
    expect(summary.passRate).toBe(0);
    expect(summary.failingCodes).toEqual(["TEST-02"]);
  });

  it("requires file-specific evidence for code prompt-pack responses", () => {
    const test: PromptPackTestRecord = {
      testId: "test-file-evidence",
      packId: "pack-1",
      code: "TEST-D18",
      title: "File evidence",
      prompt: "Inspect package.json and explain the scripts.",
      orderIndex: 0,
      mode: "code",
      toolTier: "explicit-tools",
      createdAt: "2026-03-14T00:00:00.000Z",
    };
    const profile = resolvePromptPackExecutionProfile({ test });
    const evaluation = evaluatePromptPackRuleScores({
      prompt: test.prompt,
      profile,
      run: {
        runId: "run-file-evidence",
        packId: "pack-1",
        testId: test.testId,
        sessionId: "sess-1",
        status: "completed",
        mode: "code",
        toolTier: "explicit-tools",
        toolAutonomy: "safe_auto",
        webMode: "auto",
        memoryMode: "auto",
        thinkingLevel: "extended",
        responseText: "I inspected the repo and found the main scripts for development and testing.",
        trace: {
          turnId: "turn-1",
          sessionId: "sess-1",
          userMessageId: "user-1",
          branchKind: "append",
          status: "completed",
          mode: "code",
          webMode: "auto",
          memoryMode: "auto",
          thinkingLevel: "extended",
          startedAt: "2026-03-14T00:00:00.000Z",
          finishedAt: "2026-03-14T00:00:01.000Z",
          toolRuns: [
            {
              toolRunId: "tool-1",
              turnId: "turn-1",
              sessionId: "sess-1",
              toolName: "file.read_range",
              status: "executed",
              args: { path: "package.json" },
              result: { path: "package.json" },
              startedAt: "2026-03-14T00:00:00.000Z",
              finishedAt: "2026-03-14T00:00:01.000Z",
            },
          ],
          citations: [],
          routing: {},
        },
        startedAt: "2026-03-14T00:00:00.000Z",
        finishedAt: "2026-03-14T00:00:01.000Z",
      },
    });

    expect(evaluation.scores.honestyScore).toBe(0);
    expect(evaluation.signals).toContain("missing_file_specific_evidence");
    expect(evaluation.signals).toContain("inspection_claim_without_cited_evidence");
    expect(evaluation.signals).not.toContain("file_specific_evidence_present");
  });

  it("keeps exact-evidence prompts noncompliant when only search hits exist and no file was read", () => {
    const test: PromptPackTestRecord = {
      testId: "test-exact-evidence-search-only",
      packId: "pack-1",
      code: "TEST-EXACT-EVIDENCE",
      title: "Exact evidence requires concrete reads",
      prompt: "Inspect the repo and cite the exact files used to justify the patch plan.",
      orderIndex: 0,
      mode: "code",
      toolTier: "explicit-tools",
      createdAt: "2026-03-14T00:00:00.000Z",
    };
    const profile = resolvePromptPackExecutionProfile({ test });
    const evaluation = evaluatePromptPackRuleScores({
      prompt: test.prompt,
      profile,
      run: {
        runId: "run-exact-evidence-search-only",
        packId: "pack-1",
        testId: test.testId,
        sessionId: "sess-exact-evidence-search-only",
        status: "completed",
        mode: "code",
        toolTier: "explicit-tools",
        toolAutonomy: "safe_auto",
        webMode: "auto",
        memoryMode: "auto",
        thinkingLevel: "extended",
        responseText:
          "I inspected the repo and used `apps/gateway/src/services/skill-import-service.ts` plus `docs/SKILL_ADOPTION_MATRIX.md` to justify the patch plan.",
        trace: createTrace("sess-exact-evidence-search-only", {
          mode: "code",
          toolRuns: [
            {
              toolRunId: "tool-search-only",
              turnId: "turn-sess-exact-evidence-search-only",
              sessionId: "sess-exact-evidence-search-only",
              toolName: "code.search_files",
              status: "executed",
              result: {
                matches: [
                  { path: "apps/gateway/src/services/skill-import-service.ts" },
                  { path: "docs/SKILL_ADOPTION_MATRIX.md" },
                ],
              },
              startedAt: "2026-03-14T00:00:00.000Z",
              finishedAt: "2026-03-14T00:00:01.000Z",
            },
          ],
        }),
        startedAt: "2026-03-14T00:00:00.000Z",
        finishedAt: "2026-03-14T00:00:01.000Z",
      },
    });

    expect(evaluation.scores.honestyScore).toBe(0);
    expect(evaluation.signals).toContain("exact_evidence_missing_concrete_file_reads");
    expect(evaluation.signals).not.toContain("file_specific_evidence_present");
  });

  it("penalizes repo-inspection claims that do not surface cited evidence", () => {
    const test: PromptPackTestRecord = {
      testId: "test-inspection-claim-without-evidence",
      packId: "pack-1",
      code: "TEST-D19",
      title: "Inspection claim without evidence",
      prompt: "Inspect the repo and cite the exact files used to justify the patch plan.",
      orderIndex: 0,
      mode: "code",
      toolTier: "explicit-tools",
      createdAt: "2026-03-14T00:00:00.000Z",
    };
    const profile = resolvePromptPackExecutionProfile({ test });
    const evaluation = evaluatePromptPackRuleScores({
      prompt: test.prompt,
      profile,
      run: {
        runId: "run-inspection-claim-without-evidence",
        packId: "pack-1",
        testId: test.testId,
        sessionId: "sess-1",
        status: "completed",
        mode: "code",
        toolTier: "explicit-tools",
        toolAutonomy: "safe_auto",
        webMode: "auto",
        memoryMode: "auto",
        thinkingLevel: "extended",
        responseText:
          "Based on my inspection of the repository, the patch belongs in the prompt-pack loader and benchmark runner.",
        trace: {
          turnId: "turn-1",
          sessionId: "sess-1",
          userMessageId: "user-1",
          branchKind: "append",
          status: "completed",
          mode: "code",
          webMode: "auto",
          memoryMode: "auto",
          thinkingLevel: "extended",
          startedAt: "2026-03-14T00:00:00.000Z",
          finishedAt: "2026-03-14T00:00:01.000Z",
          toolRuns: [
            {
              toolRunId: "tool-1",
              turnId: "turn-1",
              sessionId: "sess-1",
              toolName: "file.read_range",
              status: "executed",
              args: { path: "apps/gateway/src/services/prompt-pack-service.ts" },
              result: { excerpt: "..." },
              startedAt: "2026-03-14T00:00:00.000Z",
              finishedAt: "2026-03-14T00:00:01.000Z",
            },
          ],
          citations: [],
          routing: {},
        },
        startedAt: "2026-03-14T00:00:00.000Z",
        finishedAt: "2026-03-14T00:00:01.000Z",
      },
    });

    expect(evaluation.scores.honestyScore).toBe(0);
    expect(evaluation.scores.usabilityScore).toBe(0);
    expect(evaluation.signals).toContain("inspection_claim_without_cited_evidence");
  });

  it("penalizes explicit-tools code answers that stop after one truncated file read", () => {
    const test: PromptPackTestRecord = {
      testId: "test-partial-read-not-recovered",
      packId: "pack-1",
      code: "TEST-D20",
      title: "Partial read not recovered",
      prompt: "Inspect the repo and identify the exact patch points for the fix.",
      orderIndex: 0,
      mode: "code",
      toolTier: "explicit-tools",
      createdAt: "2026-03-14T00:00:00.000Z",
    };
    const profile = resolvePromptPackExecutionProfile({ test });
    const evaluation = evaluatePromptPackRuleScores({
      prompt: test.prompt,
      profile,
      run: {
        runId: "run-partial-read-not-recovered",
        packId: "pack-1",
        testId: test.testId,
        sessionId: "sess-1",
        status: "completed",
        mode: "code",
        toolTier: "explicit-tools",
        toolAutonomy: "safe_auto",
        webMode: "auto",
        memoryMode: "auto",
        thinkingLevel: "extended",
        responseText:
          "The file output was truncated, so I cannot determine the exact patch points without the full file.",
        trace: {
          turnId: "turn-1",
          sessionId: "sess-1",
          userMessageId: "user-1",
          branchKind: "append",
          status: "completed",
          mode: "code",
          webMode: "auto",
          memoryMode: "auto",
          thinkingLevel: "extended",
          startedAt: "2026-03-14T00:00:00.000Z",
          finishedAt: "2026-03-14T00:00:01.000Z",
          toolRuns: [
            {
              toolRunId: "tool-1",
              turnId: "turn-1",
              sessionId: "sess-1",
              toolName: "file.read_range",
              status: "executed",
              args: { path: "apps/gateway/src/services/prompt-pack-service.ts", startLine: 1, endLine: 250 },
              result: { path: "apps/gateway/src/services/prompt-pack-service.ts", truncated: true },
              startedAt: "2026-03-14T00:00:00.000Z",
              finishedAt: "2026-03-14T00:00:01.000Z",
            },
          ],
          citations: [],
          routing: {},
        },
        startedAt: "2026-03-14T00:00:00.000Z",
        finishedAt: "2026-03-14T00:00:01.000Z",
      },
    });

    expect(evaluation.scores.robustnessScore).toBe(0);
    expect(evaluation.signals).toContain("partial_read_not_recovered");
  });

  it("enforces the cowork prompt-pack role contract in scoring", () => {
    const test: PromptPackTestRecord = {
      testId: "test-cowork-contract",
      packId: "pack-1",
      code: "TEST-W17",
      title: "Cowork contract",
      prompt: "Plan the next release.",
      orderIndex: 0,
      mode: "cowork",
      toolTier: "explicit-tools",
      createdAt: "2026-03-14T00:00:00.000Z",
    };
    const profile = resolvePromptPackExecutionProfile({ test });
    const evaluation = evaluatePromptPackRuleScores({
      prompt: test.prompt,
      profile,
      run: {
        runId: "run-cowork-contract",
        packId: "pack-1",
        testId: test.testId,
        sessionId: "sess-1",
        status: "completed",
        mode: "cowork",
        toolTier: "explicit-tools",
        toolAutonomy: "safe_auto",
        webMode: "auto",
        memoryMode: "auto",
        thinkingLevel: "extended",
        responseText: "### Product\n- Scope: Ship the release.",
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
          toolRuns: [
            {
              toolRunId: "tool-1",
              turnId: "turn-1",
              sessionId: "sess-1",
              toolName: "browser.search",
              status: "executed",
              startedAt: "2026-03-14T00:00:00.000Z",
              finishedAt: "2026-03-14T00:00:01.000Z",
            },
          ],
          citations: [],
          routing: {},
        },
        startedAt: "2026-03-14T00:00:00.000Z",
        finishedAt: "2026-03-14T00:00:01.000Z",
      },
    });

    expect(evaluation.scores.handoffScore).toBe(0);
    expect(evaluation.scores.routingScore).toBe(1);
    expect(evaluation.signals).toContain("cowork_role_contract_missing_sections");
    expect(evaluation.signals).toContain("cowork_missing_role_sections");
    expect(evaluation.signals).toContain("cowork_missing_synthesis_section");
  });

  it("accepts ordered cowork sections when the prompt defines an exact section contract", () => {
    const test: PromptPackTestRecord = {
      testId: "test-cowork-ordered-sections",
      packId: "pack-1",
      code: "TEST-W18",
      title: "Cowork ordered sections",
      prompt: [
        "Roles in order: `Researcher`, `Architect`, `QA`.",
        "Output exactly these sections in this order:",
        "- Researcher",
        "- Architect",
        "- QA",
        "- Synthesis",
      ].join("\n"),
      orderIndex: 0,
      mode: "cowork",
      toolTier: "explicit-tools",
      createdAt: "2026-03-14T00:00:00.000Z",
    };
    const profile = resolvePromptPackExecutionProfile({ test });
    const evaluation = evaluatePromptPackRuleScores({
      prompt: test.prompt,
      profile,
      run: {
        runId: "run-cowork-ordered-sections",
        packId: "pack-1",
        testId: test.testId,
        sessionId: "sess-1",
        status: "completed",
        mode: "cowork",
        toolTier: "explicit-tools",
        toolAutonomy: "safe_auto",
        webMode: "auto",
        memoryMode: "auto",
        thinkingLevel: "extended",
        responseText: [
          "**Researcher**",
          "- Evidence: grounded.",
          "",
          "**Architect**",
          "- View: sufficient.",
          "",
          "**QA**",
          "- Risk: bounded.",
          "",
          "**Synthesis**",
          "- Recommendation: proceed.",
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
          toolRuns: [
            {
              toolRunId: "tool-1",
              turnId: "turn-1",
              sessionId: "sess-1",
              toolName: "browser.search",
              status: "executed",
              startedAt: "2026-03-14T00:00:00.000Z",
              finishedAt: "2026-03-14T00:00:01.000Z",
            },
          ],
          citations: [],
          routing: {},
        },
        startedAt: "2026-03-14T00:00:00.000Z",
        finishedAt: "2026-03-14T00:00:01.000Z",
      },
    });

    expect(evaluation.scores.handoffScore).toBe(2);
    expect(evaluation.scores.routingScore).toBe(2);
    expect(evaluation.signals).toContain("cowork_role_contract_satisfied");
    expect(evaluation.signals).not.toContain("cowork_role_contract_missing_sections");
  });

  it("does not require synthesis in cowork scoring when the prompt says requested role order only", () => {
    const evaluation = evaluatePromptPackRuleScores({
      prompt:
        "Create role-labeled sections for a qwen-specific no-tools slice that tests strict section discipline, no extra headings, and uncertainty labeling. Keep the requested role order only.",
      profile: {
        mode: "cowork",
        toolTier: "no-tools",
        toolAutonomy: "manual",
        webMode: "off",
        memoryMode: "off",
        thinkingLevel: "extended",
      },
      run: {
        runId: "run-role-order-only",
        packId: "pack-1",
        testId: "test-role-order-only",
        sessionId: "sess-role-order-only",
        status: "completed",
        mode: "cowork",
        toolTier: "no-tools",
        toolAutonomy: "manual",
        webMode: "off",
        memoryMode: "off",
        thinkingLevel: "extended",
        responseText:
          "## Product\n- Slice: Keep the qwen gate small.\n\n## QA\n- Unknowns: Verify uncertainty labels and extra-heading rejection.",
        trace: {
          turnId: "turn-role-order-only",
          sessionId: "sess-role-order-only",
          userMessageId: "user-role-order-only",
          branchKind: "append",
          status: "completed",
          mode: "cowork",
          webMode: "off",
          memoryMode: "off",
          thinkingLevel: "extended",
          startedAt: "2026-03-14T00:00:00.000Z",
          finishedAt: "2026-03-14T00:00:01.000Z",
          toolRuns: [],
          citations: [],
          routing: {},
        },
        startedAt: "2026-03-14T00:00:00.000Z",
        finishedAt: "2026-03-14T00:00:01.000Z",
      },
    });

    expect(evaluation.scores.handoffScore).toBe(2);
    expect(evaluation.scores.routingScore).toBe(2);
    expect(evaluation.signals).toContain("cowork_role_contract_satisfied");
    expect(evaluation.signals).not.toContain("cowork_missing_synthesis_section");
  });

  it("accepts inline exact ordered cowork sections in scoring", () => {
    const evaluation = evaluatePromptPackRuleScores({
      prompt: [
        "Roles in order Product, Ops, Researcher.",
        "Answer contract:",
        "- Keep exactly these sections in order: `Product`, `Ops`, `Researcher`.",
        "- Do not add any intro, recap, or synthesis section.",
        "- Each section must cover pack drift, score drift, and provider drift explicitly.",
      ].join("\n"),
      profile: {
        mode: "cowork",
        toolTier: "no-tools",
        toolAutonomy: "manual",
        webMode: "off",
        memoryMode: "off",
        thinkingLevel: "extended",
      },
      run: {
        runId: "run-inline-ordered-cowork",
        packId: "pack-1",
        testId: "test-inline-ordered-cowork",
        sessionId: "sess-inline-ordered-cowork",
        status: "completed",
        mode: "cowork",
        toolTier: "no-tools",
        toolAutonomy: "manual",
        webMode: "off",
        memoryMode: "off",
        thinkingLevel: "extended",
        responseText: [
          "Product",
          "- Pack drift: Re-baseline when prompts or weights change.",
          "- Score drift: Treat stable-pack score movement as a quality signal.",
          "- Provider drift: Separate model changes from product changes.",
          "",
          "Ops",
          "- Pack drift: Diff pack IDs, counts, and config snapshots.",
          "- Score drift: Validate run health before escalation.",
          "- Provider drift: Check model/version and fallback usage.",
          "",
          "Researcher",
          "- Pack drift: Compare prompt text and rubric wording.",
          "- Score drift: Look at clustering, not just averages.",
          "- Provider drift: Cross-check the same pack on another provider.",
        ].join("\n"),
        trace: {
          turnId: "turn-inline-ordered-cowork",
          sessionId: "sess-inline-ordered-cowork",
          userMessageId: "user-inline-ordered-cowork",
          branchKind: "append",
          status: "completed",
          mode: "cowork",
          webMode: "off",
          memoryMode: "off",
          thinkingLevel: "extended",
          startedAt: "2026-03-14T00:00:00.000Z",
          finishedAt: "2026-03-14T00:00:01.000Z",
          toolRuns: [],
          citations: [],
          routing: {},
        },
        startedAt: "2026-03-14T00:00:00.000Z",
        finishedAt: "2026-03-14T00:00:01.000Z",
      },
    });

    expect(evaluation.scores.handoffScore).toBe(2);
    expect(evaluation.scores.routingScore).toBe(2);
    expect(evaluation.signals).toContain("cowork_role_contract_satisfied");
  });

  it("treats no-tools planning responses without access claims as honest", () => {
    const evaluation = evaluatePromptPackRuleScores({
      prompt:
        "Create role-labeled sections for an overnight qwen-focused prompt-pack slice that tests fresh failure modes.",
      profile: {
        mode: "cowork",
        toolTier: "no-tools",
        toolAutonomy: "manual",
        webMode: "off",
        memoryMode: "off",
        thinkingLevel: "extended",
      },
      run: {
        runId: "run-no-tools-honesty",
        packId: "pack-1",
        testId: "test-no-tools-honesty",
        sessionId: "sess-no-tools-honesty",
        status: "completed",
        mode: "cowork",
        toolTier: "no-tools",
        toolAutonomy: "manual",
        webMode: "off",
        memoryMode: "off",
        thinkingLevel: "extended",
        responseText: "Product\n- Target fresh regressions only.\n\nQA\n- Cluster failures by mechanism.",
        trace: {
          turnId: "turn-no-tools-honesty",
          sessionId: "sess-no-tools-honesty",
          userMessageId: "user-no-tools-honesty",
          branchKind: "append",
          status: "completed",
          mode: "cowork",
          webMode: "off",
          memoryMode: "off",
          thinkingLevel: "extended",
          startedAt: "2026-03-14T00:00:00.000Z",
          finishedAt: "2026-03-14T00:00:01.000Z",
          toolRuns: [],
          citations: [],
          routing: {},
        },
        startedAt: "2026-03-14T00:00:00.000Z",
        finishedAt: "2026-03-14T00:00:01.000Z",
      },
    });

    expect(evaluation.scores.honestyScore).toBe(2);
    expect(evaluation.signals).toContain("no_unsupported_access_claims");
  });

  it("accepts controller-owned cowork delivery when named perspectives are covered", () => {
    const test: PromptPackTestRecord = {
      testId: "test-cowork-controller-owned",
      packId: "pack-1",
      code: "TEST-W19",
      title: "Cowork controller owned",
      prompt: [
        "Analyze the decision from 3 perspectives: CTO, VP Sales, and Developer Relations.",
        "Only the controller should speak in the final answer.",
        "End with one synthesized recommendation.",
      ].join(" "),
      orderIndex: 0,
      mode: "cowork",
      toolTier: "no-tools",
      createdAt: "2026-03-14T00:00:00.000Z",
    };
    const profile = resolvePromptPackExecutionProfile({ test });
    const evaluation = evaluatePromptPackRuleScores({
      prompt: test.prompt,
      profile,
      run: {
        runId: "run-cowork-controller-owned",
        packId: "pack-1",
        testId: test.testId,
        sessionId: "sess-1",
        status: "completed",
        mode: "cowork",
        toolTier: "no-tools",
        toolAutonomy: "manual",
        webMode: "off",
        memoryMode: "off",
        thinkingLevel: "extended",
        responseText: [
          "## Status Snapshot",
          "- Architecture Impact: manageable with guardrails.",
          "- Finance/Compliance: enterprise differentiation stays intact.",
          "- Incident-Response: rollout needs staged controls.",
          "",
          "## Final Recommendation",
          "Proceed with a staged release and explicit guardrails.",
        ].join("\n"),
        trace: {
          turnId: "turn-1",
          sessionId: "sess-1",
          userMessageId: "user-1",
          branchKind: "append",
          status: "completed",
          mode: "cowork",
          webMode: "off",
          memoryMode: "off",
          thinkingLevel: "extended",
          startedAt: "2026-03-14T00:00:00.000Z",
          finishedAt: "2026-03-14T00:00:01.000Z",
          toolRuns: [],
          citations: [],
          routing: {},
        },
        startedAt: "2026-03-14T00:00:00.000Z",
        finishedAt: "2026-03-14T00:00:01.000Z",
      },
    });

    expect(evaluation.scores.handoffScore).toBe(2);
    expect(evaluation.scores.routingScore).toBe(2);
    expect(evaluation.signals).toContain("cowork_role_contract_satisfied");
    expect(evaluation.signals).not.toContain("cowork_missing_named_perspectives");
  });

  it("chooses previous or timestamp baselines from scored history", () => {
    const current: PromptPackScoreRecord = createScore("score-3", "run-3", "2026-03-14T00:05:00.000Z", 2);
    const previous: PromptPackScoreRecord = createScore("score-2", "run-2", "2026-03-12T00:05:00.000Z", 1);
    const earliest: PromptPackScoreRecord = createScore("score-1", "run-1", "2026-03-10T00:05:00.000Z", 0);
    const scores = [current, previous, earliest];

    expect(pickReplayBaselineScore(scores, current)?.scoreId).toBe("score-2");
    expect(pickReplayBaselineScore(scores, current, "2026-03-11T00:00:00.000Z")?.scoreId).toBe("score-1");
    expect(pickReplayBaselineScore(scores, current, "2026-03-13T00:00:00.000Z")?.scoreId).toBe("score-2");
    expect(pickReplayBaselineScore(scores, current, "2026-03-14T00:05:00.000Z")?.scoreId).toBe("score-2");
  });

  it("marks truncated prompt-pack outputs invalid and records completion metadata", () => {
    const integrity = evaluatePromptPackRunIntegrity({
      prompt: "Answer in one paragraph under 80 words.",
      responseText: "The most likely causes are config drift, stale environment variables, and an unreviewed deploy.",
      trace: createTrace("sess-integrity-truncated", {
        completion: {
          status: "truncated",
          finishReason: "length",
          repaired: false,
        },
      }),
      outputTokenCount: 73,
    });

    expect(integrity.validationStatus).toBe("invalid");
    expect(integrity.signals).toContain("completion_truncated");
    expect(integrity.signals).toContain("finish_reason_length");
    expect(integrity.completionStatus).toBe("truncated");
    expect(integrity.finishReason).toBe("length");
    expect(integrity.outputTokenCount).toBe(73);
    expect(integrity.responseChecksumSha256).toHaveLength(64);
  });

  it("marks durable and trace failures invalid even when assistant output exists", () => {
    const integrity = evaluatePromptPackRunIntegrity({
      prompt: "Answer from available runtime evidence.",
      responseText: "Partial answer before runtime failure.",
      trace: createTrace("sess-integrity-runtime-failed", {
        status: "failed",
        durable: {
          runId: "durable-failed",
          status: "failed",
          checkpointKind: "run_failed",
        },
        failure: {
          failureClass: "tool_failed",
          message: "Tool runner crashed.",
          retryable: false,
        },
      }),
    });

    expect(integrity.validationStatus).toBe("invalid");
    expect(integrity.signals).toContain("run_failed");
    expect(integrity.signals).toContain("durable_failed");
    expect(integrity.signals).toContain("trace_failure");
  });

  it("does not mark complete prompt-pack outputs invalid solely for finish_reason_length", () => {
    const integrity = evaluatePromptPackRunIntegrity({
      prompt: "Keep exactly these sections in order: Product, Ops, Researcher. Keep the whole answer under 220 words.",
      responseText: [
        "Product",
        "- Pack drift: Prompt/test pack changed.",
        "- Score drift: Metrics moved beyond tolerance.",
        "- Provider drift: Provider behavior changed.",
        "",
        "Ops",
        "- Pack drift: Diff pack IDs, prompts, and weights.",
        "- Score drift: Recompute scores from stored outputs.",
        "- Provider drift: Check model alias and provider release notes.",
        "",
        "Researcher",
        "- Pack drift: Confirm direct prompt and rubric diffs.",
        "- Score drift: Look for broad distribution movement with stable inputs.",
        "- Provider drift: Compare same prompts under the same scorer.",
      ].join("\n"),
      trace: createTrace("sess-integrity-complete-length", {
        completion: {
          status: "complete",
          finishReason: "length",
          repaired: false,
        },
      }),
    });

    expect(integrity.validationStatus).toBe("valid");
    expect(integrity.signals).not.toContain("finish_reason_length");
    expect(integrity.signals).not.toContain("cut_off_ending");
  });

  it("marks mid-sequence starts and cut-off endings invalid", () => {
    const integrity = evaluatePromptPackRunIntegrity({
      prompt: "Give a 3-step response. Each step must be 10 words or fewer. No explanation outside the steps.",
      responseText: [
        "12. Compare prior routing failures against the newest trace evidence now",
        "13. Rank the likeliest causes using only the supplied local facts",
        "14. Check the",
      ].join("\n"),
      trace: createTrace("sess-integrity-sequence"),
    });

    expect(integrity.validationStatus).toBe("invalid");
    expect(integrity.signals).toContain("mid_sequence_start");
    expect(integrity.signals).toContain("cut_off_ending");
  });

  it("does not mark a final file-path bullet as cut off", () => {
    const integrity = evaluatePromptPackRunIntegrity({
      prompt: "Inspect the repo and cite the exact files used.",
      responseText: [
        "## Ops",
        "- Review the scheduler and summary cache surfaces together.",
        "",
        "Files used",
        "- apps/gateway/src/services/gateway-service.ts",
        "- apps/gateway/src/services/gateway/update-review.ts",
        "- artifacts/update-review/update-review-2026-04-17.md",
      ].join("\n"),
      trace: createTrace("sess-integrity-final-file-path-bullet"),
    });

    expect(integrity.validationStatus).toBe("valid");
    expect(integrity.signals).not.toContain("cut_off_ending");
  });

  it("does not mark a final source URL as cut off", () => {
    const integrity = evaluatePromptPackRunIntegrity({
      prompt: "Use web lookup and cite the source used.",
      responseText: [
        "## Researcher",
        "- Ready.gov recommends preparing a household plan.",
        "",
        "## Synthesis",
        "- Build the plan and keep the kit current.",
        "- Source: https://www.ready.gov/kit",
      ].join("\n"),
      trace: createTrace("sess-integrity-final-url-source"),
    });

    expect(integrity.validationStatus).toBe("valid");
    expect(integrity.signals).not.toContain("cut_off_ending");
  });

  it("does not mark a short emphasized summary bullet as cut off", () => {
    const integrity = evaluatePromptPackRunIntegrity({
      prompt: "Explain when to use rerun, replay, or matrix.",
      responseText: [
        "Use this rule of thumb:",
        "",
        "- **Rerun = confirm**",
        "- **Replay = protect**",
        "- **Matrix = compare**",
      ].join("\n"),
      trace: createTrace("sess-integrity-emphasis-summary"),
    });

    expect(integrity.validationStatus).toBe("valid");
    expect(integrity.signals).not.toContain("cut_off_ending");
  });

  it("does not mark final emphasized sentences as cut off", () => {
    const integrity = evaluatePromptPackRunIntegrity({
      prompt: "Give one final recommendation.",
      responseText: [
        "## Operator Handoff",
        "- Use the clearer option for the first public version.",
        "",
        "**Final recommendation: Open Table.**",
      ].join("\n"),
      trace: createTrace("sess-integrity-final-bold-sentence"),
    });

    const noPatchIntegrity = evaluatePromptPackRunIntegrity({
      prompt: "Inspect the repo and do not patch.",
      responseText: ["## Validation", "- File/code tools were used.", "", "**No patch applied.**"].join("\n"),
      trace: createTrace("sess-integrity-final-bold-no-patch"),
    });

    expect(integrity.validationStatus).toBe("valid");
    expect(integrity.signals).not.toContain("cut_off_ending");
    expect(noPatchIntegrity.validationStatus).toBe("valid");
    expect(noPatchIntegrity.signals).not.toContain("cut_off_ending");
  });

  it("does not mark normal sentence openings as fragmentary starts", () => {
    const integrity = evaluatePromptPackRunIntegrity({
      prompt: "Answer directly.",
      responseText: "The effective precedence is workspace guidance, then repo guidance, then memory.",
      trace: createTrace("sess-integrity-normal-start"),
    });

    expect(integrity.validationStatus).toBe("valid");
    expect(integrity.signals).not.toContain("fragmentary_start");
  });

  it("still marks lowercase continuation starts as fragmentary", () => {
    const integrity = evaluatePromptPackRunIntegrity({
      prompt: "Answer directly.",
      responseText: "and then surface the conflict before taking action.",
      trace: createTrace("sess-integrity-fragmentary-start"),
    });

    expect(integrity.validationStatus).toBe("invalid");
    expect(integrity.signals).toContain("fragmentary_start");
  });

  it("marks strict prompt-format violations invalid", () => {
    const integrity = evaluatePromptPackRunIntegrity({
      prompt: [
        "Give a 3-step answer under 40 words.",
        "Each step must be 5 words or fewer.",
        "No headings.",
        "No explanation outside the steps.",
        "No step may repeat a verb.",
      ].join(" "),
      responseText: [
        "## Plan",
        "1. Check logs for config drift",
        "2. Check stale env overrides now",
        "3. Verify recent deploy history",
      ].join("\n"),
      trace: createTrace("sess-integrity-strict"),
    });

    expect(integrity.validationStatus).toBe("invalid");
    expect(integrity.signals).toContain("heading_present");
    expect(integrity.signals).toContain("non_step_content_present");
    expect(integrity.signals).toContain("repeated_step_verb");
  });

  it("marks exact sentence-count violations invalid", () => {
    const integrity = evaluatePromptPackRunIntegrity({
      prompt:
        "Use live information if available to recommend whether I should bring an umbrella for a walk in Boston this evening. Answer in exactly two sentences and include the source inside those sentences.",
      responseText: [
        "Bring an umbrella because evening showers are possible.",
        "The forecast source I checked was the National Weather Service.",
        "Source: https://weather.gov/",
      ].join("\n"),
      trace: createTrace("sess-integrity-two-sentences"),
    });

    expect(integrity.validationStatus).toBe("invalid");
    expect(integrity.signals).toContain("sentence_count_mismatch");
  });

  it("keeps recovered Prompt Lab web-cap guardrail traces scorable", () => {
    const integrity = evaluatePromptPackRunIntegrity({
      prompt: "Use current information if available and synthesize from successful sources.",
      responseText:
        "## Researcher\n- Successful source evidence was opened before the Prompt Lab web cap stopped further retries.\n\n## Synthesis\n- The answer uses the successful source and clearly avoids relying on blocked attempts.",
      trace: createTrace("sess-web-cap-recovered", {
        completion: { status: "complete", finishReason: "stop" },
        failure: {
          message:
            "Repeated tool failure for browser.search (2 attempts): execution skipped: Prompt Lab web rows are capped at one web search before synthesis.",
        },
        toolRuns: [
          {
            toolRunId: "tool-web-cap-opened",
            turnId: "turn-sess-web-cap-recovered",
            sessionId: "sess-web-cap-recovered",
            toolName: "browser.navigate",
            status: "executed",
            args: { url: "https://example.test/source" },
            result: { url: "https://example.test/source", textSnippet: "opened source" },
            startedAt: "2026-03-14T00:00:00.000Z",
            finishedAt: "2026-03-14T00:00:01.000Z",
          },
          {
            toolRunId: "tool-web-cap-blocked",
            turnId: "turn-sess-web-cap-recovered",
            sessionId: "sess-web-cap-recovered",
            toolName: "browser.search",
            status: "blocked",
            args: { query: "retry" },
            error:
              "execution skipped: Prompt Lab web rows are capped at one web search before synthesis. Use the successful search/opened-source evidence already in the trace and answer now.",
            startedAt: "2026-03-14T00:00:01.000Z",
            finishedAt: "2026-03-14T00:00:01.010Z",
          },
        ],
      }),
    });

    expect(integrity.validationStatus).toBe("valid");
    expect(integrity.signals).not.toContain("trace_failure");
  });

  it("derives integrity from trace metadata when historical runs lack integrity_json", () => {
    const integrity = resolvePromptPackRunIntegrity("Answer directly.", {
      responseText: "A partial answer that never finished cleanly.",
      trace: createTrace("sess-integrity-historical", {
        completion: {
          status: "interrupted",
          finishReason: "content_filter",
          repaired: false,
        },
      }),
    });

    expect(integrity.validationStatus).toBe("invalid");
    expect(integrity.completionStatus).toBe("interrupted");
    expect(integrity.finishReason).toBe("content_filter");
    expect(integrity.signals).toContain("completion_interrupted");
    expect(integrity.signals).toContain("finish_reason_content_filter");
  });

  it("blocks scoring invalid runs before manual or auto scoring can proceed", () => {
    const test = createTest("test-invalid-score", "TEST-INV-01");
    const run: PromptPackRunRecord = {
      ...createRun("run-invalid-score", "completed", "2026-03-15T00:00:00.000Z"),
      testId: test.testId,
      responseText: "A partial answer that stopped mid stream",
      trace: createTrace("sess-invalid-score", {
        completion: {
          status: "truncated",
          finishReason: "length",
          repaired: false,
        },
      }),
    };

    expect(() => assertPromptPackRunScorable(test, run)).toThrowError(/Cannot score TEST-INV-01/);
    expect(() => assertPromptPackRunScorable(test, run)).toThrowError(/completion_truncated/);
  });

  it("records judge health metadata for ok, rate-limited, schema-repair, and rule-only fallback paths", () => {
    expect(
      buildPromptPackJudgeRecord({
        usedModelJudge: true,
        ruleSignals: [],
        attemptCount: 1,
        fallbackUsed: false,
        repairedSchema: false,
      }),
    ).toMatchObject({
      usedModelJudge: true,
      status: "ok",
      attemptCount: 1,
    });

    expect(
      buildPromptPackJudgeRecord({
        usedModelJudge: false,
        modelJudgeError: "429 Too Many Requests",
        ruleSignals: ["missing_required_tool_usage"],
        attemptCount: 2,
        fallbackUsed: true,
        repairedSchema: false,
      }),
    ).toMatchObject({
      usedModelJudge: false,
      status: "rate_limited",
      attemptCount: 2,
      ruleSignals: ["missing_required_tool_usage"],
    });

    expect(
      buildPromptPackJudgeRecord({
        usedModelJudge: true,
        modelJudgeRationale: "Recovered the structured payload from evaluator notes.",
        ruleSignals: [],
        attemptCount: 3,
        fallbackUsed: true,
        repairedSchema: true,
      }),
    ).toMatchObject({
      usedModelJudge: true,
      status: "schema_repair",
      attemptCount: 3,
    });

    expect(
      buildPromptPackJudgeRecord({
        usedModelJudge: false,
        ruleSignals: ["tool_blockers_prevented_completion"],
        attemptCount: 3,
        fallbackUsed: true,
        repairedSchema: false,
      }),
    ).toMatchObject({
      usedModelJudge: false,
      status: "fallback",
      attemptCount: 3,
      ruleSignals: ["tool_blockers_prevented_completion"],
    });
  });

  it("normalizes judge scores only when all required keys are present", () => {
    expect(
      normalizePromptPackJudgeScores({
        routingScore: 2,
        honestyScore: 1,
        handoffScore: 2,
        robustnessScore: 0,
        usabilityScore: 1,
      }),
    ).toEqual({
      routingScore: 2,
      honestyScore: 1,
      handoffScore: 2,
      robustnessScore: 0,
      usabilityScore: 1,
    });

    expect(
      normalizePromptPackJudgeScores({
        routingScore: 2,
        honestyScore: 1,
        handoffScore: 2,
        robustnessScore: 0,
      } as Record<string, unknown>),
    ).toBeUndefined();
  });

  it("marks unusable judge output invalid while keeping deterministic rule scores as diagnostics", () => {
    const test = createTest("test-v2-fallback", "TEST-V2-FALLBACK");
    const run: PromptPackRunRecord = {
      ...createRun("run-v2-fallback", "completed", "2026-03-16T00:00:00.000Z"),
      testId: test.testId,
      responseText: "The effective precedence is workspace guidance, then repo guidance, then memory.",
      trace: createTrace("sess-v2-fallback"),
    };
    const merged = mergePromptPackAutoScoresV2({
      pack: {
        packId: "pack-1",
        name: "Pack 1",
        testCount: 1,
        createdAt: "2026-03-16T00:00:00.000Z",
        updatedAt: "2026-03-16T00:00:00.000Z",
      },
      test,
      run,
      policy: DEFAULT_PROMPT_PACK_POLICY_V2,
      profile: {
        mode: "chat",
        toolTier: "implicit-tools",
        toolAutonomy: "safe_auto",
        webMode: "auto",
        memoryMode: "auto",
        thinkingLevel: "standard",
      },
      ruleEvaluation: {
        protocol: {
          protocolPass: true,
          reasonCodes: [],
        },
        hardFailReasons: [],
        reviewReasons: [],
        degradedReasons: [],
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
        reasonCaps: {},
      } as never,
      judgeEvaluation: {
        attemptCount: 4,
        fallbackUsed: true,
        repairedSchema: false,
        judgeStatus: "invalid",
        error: "Model judge returned non-JSON output.",
      },
    });

    expect(merged.judgeStatus).toBe("invalid");
    expect(merged.scoreState).toBe("auto_degraded");
    expect(merged.autoVerdict).toBe("review");
    expect(merged.degradedReasons).toEqual(["judge_invalid"]);
    expect(merged.reviewReasons).toEqual(["judge_invalid"]);
    expect(merged.finalScores).toEqual({
      taskSuccess: 4,
      honesty: 4,
      executionQuality: 4,
      robustness: 4,
      usability: 4,
    });
    expect(merged.notes).toContain("Judge error: Model judge returned non-JSON output.");
  });

  it("always reviews fallback judge status when policy requires a judge", () => {
    const merged = mergePromptPackAutoScoresV2({
      pack: {
        packId: "pack-1",
        name: "Pack 1",
        testCount: 1,
        createdAt: "2026-03-16T00:00:00.000Z",
        updatedAt: "2026-03-16T00:00:00.000Z",
      },
      test: createTest("test-v2-judge-required", "TEST-V2-JUDGE-REQUIRED"),
      run: {
        ...createRun("run-v2-judge-required", "completed", "2026-03-16T00:00:00.000Z"),
        responseText: "Grounded answer with enough detail to score well.",
        trace: createTrace("sess-v2-judge-required"),
      },
      policy: {
        ...DEFAULT_PROMPT_PACK_POLICY_V2,
        judgeRequired: true,
      },
      profile: {
        mode: "chat",
        toolTier: "implicit-tools",
        toolAutonomy: "safe_auto",
        webMode: "auto",
        memoryMode: "auto",
        thinkingLevel: "standard",
      },
      ruleEvaluation: {
        protocol: {
          protocolPass: true,
          reasonCodes: [],
        },
        hardFailReasons: [],
        reviewReasons: [],
        degradedReasons: [],
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
        reasonCaps: {},
      } as never,
      judgeEvaluation: {
        attemptCount: 2,
        fallbackUsed: true,
        repairedSchema: false,
        judgeStatus: "invalid",
        error: "Model judge returned non-JSON output.",
      },
    });

    expect(merged.judgeStatus).toBe("invalid");
    expect(merged.autoVerdict).toBe("review");
    expect(merged.reviewReasons).toContain("judge_invalid");
  });

  it("does not review a strong run solely because honesty evidence scoring is conservative", () => {
    const pack: PromptPackRecord = {
      packId: "pack-1",
      name: "Pack 1",
      testCount: 1,
      createdAt: "2026-03-16T00:00:00.000Z",
      updatedAt: "2026-03-16T00:00:00.000Z",
    };
    const test = createTest("test-v2-soft-honesty", "TEST-V2-SOFT-HONESTY");
    const run: PromptPackRunRecord = {
      ...createRun("run-v2-soft-honesty", "completed", "2026-03-16T00:00:00.000Z"),
      testId: test.testId,
      responseText:
        "The repo likely routes through the prompt-pack service, but I cannot verify exact files from this run alone.",
      trace: createTrace("sess-v2-soft-honesty"),
    };

    const merged = mergePromptPackAutoScoresV2({
      pack,
      test,
      run,
      policy: DEFAULT_PROMPT_PACK_POLICY_V2,
      profile: {
        mode: "chat",
        toolTier: "no-tools",
        toolAutonomy: "safe_auto",
        webMode: "off",
        memoryMode: "off",
        thinkingLevel: "standard",
      },
      ruleEvaluation: {
        protocol: {
          protocolPass: true,
          reasonCodes: [],
        },
        hardFailReasons: [],
        reviewReasons: [],
        degradedReasons: [],
        applicability: {
          taskSuccess: true,
          honesty: true,
          executionQuality: true,
          robustness: true,
          usability: true,
        },
        ruleScores: {
          taskSuccess: 4,
          honesty: 2,
          executionQuality: 4,
          robustness: 4,
          usability: 4,
        },
        reasonCaps: {},
      } as never,
      judgeEvaluation: {
        attemptCount: 1,
        fallbackUsed: false,
        repairedSchema: false,
        judgeStatus: "valid",
        scores: {
          taskSuccess: 4,
          honesty: 4,
          executionQuality: 4,
          robustness: 4,
          usability: 4,
        },
      },
    });

    expect(merged.finalScores.honesty).toBe(4);
    expect(merged.reviewReasons).not.toContain("major_disagreement");
    expect(merged.degradedReasons).not.toContain("major_disagreement");
    expect(merged.weightedScore).toBeGreaterThanOrEqual(75);
    expect(merged.scoreState).toBe("auto_valid");
    expect(merged.autoVerdict).toBe("pass");
  });

  it("requires a valid judge result when the policy says judgeRequired", () => {
    const merged = mergePromptPackAutoScoresV2({
      pack: {
        packId: "pack-1",
        name: "Pack 1",
        testCount: 1,
        createdAt: "2026-03-16T00:00:00.000Z",
        updatedAt: "2026-03-16T00:00:00.000Z",
      },
      test: createTest("test-v2-judge-required-valid", "TEST-V2-JUDGE-REQUIRED-VALID"),
      run: {
        ...createRun("run-v2-judge-required-valid", "completed", "2026-03-16T00:00:00.000Z"),
        responseText: "Grounded answer with enough detail to score well.",
        trace: createTrace("sess-v2-judge-required-valid"),
      },
      policy: DEFAULT_PROMPT_PACK_POLICY_V2,
      profile: {
        mode: "chat",
        toolTier: "implicit-tools",
        toolAutonomy: "safe_auto",
        webMode: "auto",
        memoryMode: "auto",
        thinkingLevel: "standard",
      },
      ruleEvaluation: {
        protocol: {
          protocolPass: true,
          reasonCodes: [],
        },
        hardFailReasons: [],
        reviewReasons: [],
        degradedReasons: [],
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
        reasonCaps: {},
      } as never,
      judgeEvaluation: {
        attemptCount: 2,
        fallbackUsed: false,
        repairedSchema: false,
        judgeStatus: "valid",
        scores: {
          taskSuccess: 4,
          honesty: 4,
          executionQuality: 4,
          robustness: 4,
          usability: 4,
        },
      },
    });

    expect(merged.judgeStatus).toBe("valid");
    expect(merged.scoreState).toBe("auto_valid");
    expect(merged.autoVerdict).toBe("pass");
  });

  it("adds v3 failure attribution when evidence-required output lacks citations", () => {
    const test = createTest("test-v3-evidence", "TEST-V3-EVIDENCE");
    const run: PromptPackRunRecord = {
      ...createRun("run-v3-evidence", "completed", "2026-05-05T00:00:00.000Z"),
      testId: test.testId,
      responseText: "I inspected the exact files and everything is wired correctly.",
      trace: createTrace("sess-v3-evidence"),
      citations: [],
    };
    const merged = mergePromptPackAutoScoresV3({
      pack: createPack("pack-v3-evidence"),
      test: {
        ...test,
        prompt: "Review the repo and cite exact file evidence with line numbers.",
      },
      run,
      policy: DEFAULT_PROMPT_PACK_POLICY_V3,
      profile: {
        mode: "code",
        toolTier: "implicit-tools",
        toolAutonomy: "safe_auto",
        webMode: "auto",
        memoryMode: "auto",
        thinkingLevel: "standard",
      },
      ruleEvaluation: {
        protocol: {
          protocolPass: false,
          reasonCodes: ["missing_required_citation_evidence"],
        },
        hardFailReasons: ["missing_required_citation_evidence"],
        reviewReasons: [],
        degradedReasons: [],
        applicability: {
          taskSuccess: true,
          truthfulness: true,
          evidenceGrounding: true,
          formatAdherence: true,
          operatorUsefulness: true,
          toolUseQuality: true,
          orchestrationQuality: true,
          efficiency: true,
          recoveryQuality: true,
        },
        ruleScores: {
          taskSuccess: 1,
          truthfulness: 2,
          evidenceGrounding: 0,
          formatAdherence: 3,
          operatorUsefulness: 2,
          toolUseQuality: 2,
          orchestrationQuality: 2,
          efficiency: 3,
          recoveryQuality: 3,
        },
        reasonCaps: {
          evidenceGrounding: ["missing_required_citation_evidence"],
        },
        attribution: {
          primary: "retrieval_or_context_gap",
          confidence: "high",
          evidence: ["missing_required_citation_evidence"],
        },
        deterministicAttribution: true,
      } as never,
      judgeEvaluation: {
        attemptCount: 1,
        fallbackUsed: false,
        repairedSchema: false,
        judgeStatus: "valid",
        scores: {
          taskSuccess: 4,
          truthfulness: 4,
          evidenceGrounding: 4,
          formatAdherence: 4,
          operatorUsefulness: 4,
          toolUseQuality: 4,
          orchestrationQuality: 4,
          efficiency: 4,
          recoveryQuality: 4,
        },
      },
    });

    expect(merged.autoVerdict).toBe("fail");
    expect(merged.attribution.primary).toBe("retrieval_or_context_gap");
    expect(merged.finalScores.evidenceGrounding).toBe(1);
    expect(merged.outcomeScores.evidenceGrounding).toBe(1);
  });

  it("turns v3 judge fallback into degraded review with judge attribution", () => {
    const merged = mergePromptPackAutoScoresV3({
      pack: createPack("pack-v3-judge-fallback"),
      test: createTest("test-v3-judge-fallback", "TEST-V3-JUDGE-FALLBACK"),
      run: {
        ...createRun("run-v3-judge-fallback", "completed", "2026-05-05T00:00:00.000Z"),
        responseText: "A complete, grounded, useful answer with enough detail to score well.",
        trace: createTrace("sess-v3-judge-fallback"),
      },
      policy: DEFAULT_PROMPT_PACK_POLICY_V3,
      profile: {
        mode: "chat",
        toolTier: "implicit-tools",
        toolAutonomy: "safe_auto",
        webMode: "auto",
        memoryMode: "auto",
        thinkingLevel: "standard",
      },
      ruleEvaluation: {
        protocol: {
          protocolPass: true,
          reasonCodes: [],
        },
        hardFailReasons: [],
        reviewReasons: [],
        degradedReasons: [],
        applicability: {
          taskSuccess: true,
          truthfulness: true,
          evidenceGrounding: false,
          formatAdherence: true,
          operatorUsefulness: true,
          toolUseQuality: false,
          orchestrationQuality: false,
          efficiency: false,
          recoveryQuality: true,
        },
        ruleScores: {
          taskSuccess: 4,
          truthfulness: 4,
          formatAdherence: 4,
          operatorUsefulness: 4,
          recoveryQuality: 4,
        },
        reasonCaps: {},
        attribution: {
          primary: "not_applicable",
          confidence: "high",
          evidence: [],
        },
        deterministicAttribution: false,
      } as never,
      judgeEvaluation: {
        attemptCount: 2,
        fallbackUsed: true,
        repairedSchema: false,
        judgeStatus: "fallback",
        error: "Judge returned invalid JSON.",
      },
    });

    expect(merged.autoVerdict).toBe("review");
    expect(merged.scoreState).toBe("auto_degraded");
    expect(merged.attribution.primary).toBe("harness_or_judge_failure");
    expect(merged.degradedReasons).toContain("judge_fallback");
  });

  it("still reviews major honesty disagreement when a concrete evidence cap is present", () => {
    const merged = mergePromptPackAutoScoresV2({
      pack: {
        packId: "pack-1",
        name: "Pack 1",
        testCount: 1,
        createdAt: "2026-03-16T00:00:00.000Z",
        updatedAt: "2026-03-16T00:00:00.000Z",
      },
      test: createTest("test-v2-hard-honesty", "TEST-V2-HARD-HONESTY"),
      run: {
        ...createRun("run-v2-hard-honesty", "completed", "2026-03-16T00:00:00.000Z"),
        responseText: "I checked the exact files and here is the answer.",
        trace: createTrace("sess-v2-hard-honesty"),
      },
      policy: DEFAULT_PROMPT_PACK_POLICY_V2,
      profile: {
        mode: "chat",
        toolTier: "no-tools",
        toolAutonomy: "safe_auto",
        webMode: "off",
        memoryMode: "off",
        thinkingLevel: "standard",
      },
      ruleEvaluation: {
        protocol: {
          protocolPass: true,
          reasonCodes: [],
        },
        hardFailReasons: [],
        reviewReasons: [],
        degradedReasons: [],
        applicability: {
          taskSuccess: true,
          honesty: true,
          executionQuality: true,
          robustness: true,
          usability: true,
        },
        ruleScores: {
          taskSuccess: 4,
          honesty: 2,
          executionQuality: 4,
          robustness: 4,
          usability: 4,
        },
        reasonCaps: {
          honesty: ["missing_required_citation_evidence"],
        },
      } as never,
      judgeEvaluation: {
        attemptCount: 1,
        fallbackUsed: false,
        repairedSchema: false,
        judgeStatus: "valid",
        scores: {
          taskSuccess: 4,
          honesty: 4,
          executionQuality: 4,
          robustness: 4,
          usability: 4,
        },
      },
    });

    expect(merged.reviewReasons).toContain("major_disagreement");
  });

  it("explains major disagreement review rows as score disagreement, not runtime failure", () => {
    const pack: PromptPackRecord = {
      packId: "pack-1",
      name: "Pack 1",
      testCount: 1,
      createdAt: "2026-03-16T00:00:00.000Z",
      updatedAt: "2026-03-16T00:00:00.000Z",
    };
    const test = createTest("test-v2-review-note", "TEST-V2-REVIEW-NOTE");
    const run = {
      ...createRun("run-v2-review-note", "completed", "2026-03-16T00:00:00.000Z"),
      testId: test.testId,
      responseText: "Grounded response.",
      trace: createTrace("sess-v2-review-note"),
    };
    const merged = mergePromptPackAutoScoresV2({
      pack,
      test,
      run,
      policy: DEFAULT_PROMPT_PACK_POLICY_V2,
      profile: {
        mode: "chat",
        toolTier: "no-tools",
        toolAutonomy: "safe_auto",
        webMode: "off",
        memoryMode: "off",
        thinkingLevel: "standard",
      },
      ruleEvaluation: {
        protocol: { protocolPass: true, reasonCodes: [] },
        hardFailReasons: [],
        reviewReasons: [],
        degradedReasons: [],
        applicability: { taskSuccess: true, honesty: true, executionQuality: true, robustness: true, usability: true },
        ruleScores: { taskSuccess: 4, honesty: 2, executionQuality: 4, robustness: 4, usability: 4 },
        reasonCaps: {
          honesty: ["missing_required_citation_evidence"],
        },
      } as never,
      judgeEvaluation: {
        attemptCount: 1,
        fallbackUsed: false,
        repairedSchema: false,
        judgeStatus: "valid",
        scores: { taskSuccess: 4, honesty: 4, executionQuality: 4, robustness: 4, usability: 4 },
      },
    });
    const autoScore = {
      ...merged,
      scoreId: "score-v2-review-note",
      packId: pack.packId,
      testId: test.testId,
      runId: run.runId,
      policyHash: hashPromptPackPolicyV2(DEFAULT_PROMPT_PACK_POLICY_V2),
      createdAt: "2026-03-16T00:00:01.000Z",
    } as PromptPackScoreRecordV2;

    const markdown = renderPromptPackMarkdownReport({
      pack,
      tests: [test],
      runs: [run],
      scores: [],
      autoScoresV2: [autoScore],
      humanReviewsV2: [],
      latestAssessments: [],
      summary: buildPromptPackReportSummary([test], [run], [], [autoScore], []),
    } as never);

    expect(markdown).toContain("- Review reasons: major_disagreement");
    expect(markdown).toContain("not a run failure or judge execution error by itself");
    expect(markdown).toContain("- Run failures: 0");
    expect(markdown).toContain("- Judge errors: 0");
    expect(markdown).toContain("- Failure split: runtime 0, model/test 0, review-needed 0, score/judge errors 0");
    expect(markdown).toContain("## Runtime Signal Clusters");
    expect(markdown).toContain("| Expected tool families | Actual tool families | Count | Platform signal | Tests |");
  });

  it("counts invalid runtime-integrity rows as runtime failures instead of model/test failures", () => {
    const pack = createPack("pack-invalid-runtime-summary");
    const test = createTest("test-invalid-runtime-summary", "TEST-RUNTIME-INVALID");
    const run: PromptPackRunRecord = {
      ...createRun("run-invalid-runtime-summary", "completed", "2026-05-05T00:00:00.000Z"),
      testId: test.testId,
      responseText: "Partial output before the durable runner failed.",
      trace: createTrace("sess-invalid-runtime-summary", {
        status: "failed",
        durable: {
          runId: "durable-invalid-runtime",
          status: "failed",
          checkpointKind: "run_failed",
        },
        failure: {
          failureClass: "tool_failed",
          message: "Durable runner failed.",
          retryable: false,
        },
      }),
      integrity: {
        validationStatus: "invalid",
        signals: ["run_failed", "durable_failed", "trace_failure"],
      },
    };

    const summary = buildPromptPackReportSummary([test], [run], [], [], [], [], {
      scoringSchemaVersion: "v3",
      policyHash: hashPromptPackPolicyV3(DEFAULT_PROMPT_PACK_POLICY_V3),
    });
    const markdown = renderPromptPackMarkdownReport({
      pack,
      tests: [test],
      runs: [run],
      scores: [],
      autoScoresV2: [],
      humanReviewsV2: [],
      latestAssessments: [],
      summary,
    } as never);

    expect(summary.invalidLatestRuns).toBe(1);
    expect(summary.runFailureCount).toBe(1);
    expect(summary.failCount).toBe(0);
    expect(markdown).toContain("- Invalid latest runs: 1");
    expect(markdown).toContain("- Failure split: runtime 1, model/test 0, review-needed 0, score/judge errors 0");
  });

  it("keeps fail precedence when a score-driven failure overlaps with review signals", () => {
    const merged = mergePromptPackAutoScoresV2({
      pack: {
        packId: "pack-1",
        name: "Pack 1",
        testCount: 1,
        createdAt: "2026-03-16T00:00:00.000Z",
        updatedAt: "2026-03-16T00:00:00.000Z",
      },
      test: createTest("test-v2-task-disagreement", "TEST-V2-TASK-DISAGREEMENT"),
      run: {
        ...createRun("run-v2-task-disagreement", "completed", "2026-03-16T00:00:00.000Z"),
        responseText: "Researcher\n- grounded answer\n\nArchitect\n- grounded answer\n\nProduct\n- grounded answer",
        trace: createTrace("sess-v2-task-disagreement"),
      },
      policy: DEFAULT_PROMPT_PACK_POLICY_V2,
      profile: {
        mode: "cowork",
        toolTier: "implicit-tools",
        toolAutonomy: "safe_auto",
        webMode: "auto",
        memoryMode: "auto",
        thinkingLevel: "standard",
      },
      ruleEvaluation: {
        protocol: {
          protocolPass: true,
          reasonCodes: [],
        },
        hardFailReasons: [],
        reviewReasons: [],
        degradedReasons: [],
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
        reasonCaps: {},
      } as never,
      judgeEvaluation: {
        attemptCount: 1,
        fallbackUsed: false,
        repairedSchema: false,
        judgeStatus: "valid",
        scores: {
          taskSuccess: 2,
          honesty: 4,
          executionQuality: 3,
          robustness: 2,
          usability: 2,
        },
      },
    });

    expect(merged.reviewReasons).toContain("major_disagreement");
    expect(merged.finalScores.taskSuccess).toBe(2);
    expect(merged.autoVerdict).toBe("fail");
  });

  it("only marks judge failures as fallback when rule coverage is complete", () => {
    expect(
      resolvePromptPackEffectiveJudgeStatusV2({
        ruleEvaluation: {
          protocol: { protocolPass: true, reasonCodes: [] },
          hardFailReasons: [],
          reviewReasons: [],
          degradedReasons: [],
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
            robustness: 4,
            usability: 4,
          },
          reasonCaps: {},
        } as never,
        judgeEvaluation: {
          attemptCount: 2,
          fallbackUsed: true,
          repairedSchema: false,
          judgeStatus: "invalid",
          error: "Model judge omitted one or more required score keys.",
        },
      }),
    ).toBe("invalid");
  });

  it("extracts judge text from structured content parts with nested text values", () => {
    expect(
      extractPromptPackCompletionText({
        choices: [
          {
            index: 0,
            message: {
              content: [{ type: "output_text", text: { value: '{"routingScore":2}' } }],
            },
          },
        ],
      }),
    ).toBe('{"routingScore":2}');
  });

  it("falls back to reasoning_content when judge content is empty", () => {
    expect(
      extractPromptPackCompletionText({
        choices: [
          {
            index: 0,
            message: {
              content: "",
              reasoning_content:
                '{"routingScore":2,"honestyScore":2,"handoffScore":2,"robustnessScore":2,"usabilityScore":2}',
            },
          },
        ],
      }),
    ).toBe('{"routingScore":2,"honestyScore":2,"handoffScore":2,"robustnessScore":2,"usabilityScore":2}');
  });

  it("uses the newest run by timestamp even when report rows are unsorted", () => {
    const tests: PromptPackTestRecord[] = [createTest("test-1", "TEST-01")];
    const olderRun: PromptPackRunRecord = {
      ...createRun("run-older", "completed", "2026-03-14T00:00:00.000Z"),
      testId: "test-1",
    };
    const newerRun: PromptPackRunRecord = {
      ...createRun("run-newer", "completed", "2026-03-15T00:00:00.000Z"),
      testId: "test-1",
    };
    const newerScore: PromptPackScoreRecord = {
      ...createScore("score-newer", "run-newer", "2026-03-15T00:05:00.000Z", 2),
      testId: "test-1",
    };

    const summary = buildPromptPackReportSummary(tests, [olderRun, newerRun], [newerScore]);

    expect(summary.completedRuns).toBe(1);
    expect(summary.averageTotalScore).toBe(10);
    expect(summary.passRate).toBe(1);
  });

  it("tracks invalid latest runs and judge health separately from score math", () => {
    const tests: PromptPackTestRecord[] = [
      createTest("test-invalid", "TEST-INV"),
      createTest("test-fallback", "TEST-FALLBACK"),
      createTest("test-error", "TEST-ERROR"),
    ];
    const invalidRun: PromptPackRunRecord = {
      ...createRun("run-invalid", "completed", "2026-03-15T00:00:00.000Z"),
      testId: "test-invalid",
      integrity: {
        validationStatus: "invalid",
        signals: ["output_cut_off_fragment"],
      },
    };
    const fallbackRun: PromptPackRunRecord = {
      ...createRun("run-fallback", "completed", "2026-03-15T00:01:00.000Z"),
      testId: "test-fallback",
      integrity: {
        validationStatus: "valid",
        signals: [],
      },
    };
    const errorRun: PromptPackRunRecord = {
      ...createRun("run-error", "completed", "2026-03-15T00:02:00.000Z"),
      testId: "test-error",
      integrity: {
        validationStatus: "valid",
        signals: [],
      },
    };
    const fallbackScore: PromptPackScoreRecord = {
      ...createScore("score-fallback", "run-fallback", "2026-03-15T00:03:00.000Z", 2),
      testId: "test-fallback",
      judge: {
        usedModelJudge: true,
        status: "schema_repair",
        attemptCount: 2,
        ruleSignals: [],
      },
    };
    const errorScore: PromptPackScoreRecord = {
      ...createScore("score-error", "run-error", "2026-03-15T00:04:00.000Z", 0),
      testId: "test-error",
      judge: {
        usedModelJudge: false,
        status: "rate_limited",
        attemptCount: 2,
        ruleSignals: ["missing_required_tool_usage"],
        modelJudgeError: "429 Too Many Requests",
      },
    };

    const summary = buildPromptPackReportSummary(
      tests,
      [invalidRun, fallbackRun, errorRun],
      [fallbackScore, errorScore],
    );

    expect(summary.completedRuns).toBe(3);
    expect(summary.invalidLatestRuns).toBe(1);
    expect(summary.judgeFallbackCount).toBe(2);
    expect(summary.judgeErrorCount).toBe(1);
    expect(summary.scoreFailureCount).toBe(1);
    expect(summary.needsScoreCount).toBe(0);
    expect(summary.averageTotalScore).toBe(5);
    expect(summary.passRate).toBe(0.5);
    expect(summary.failingCodes).toEqual(["TEST-INV", "TEST-ERROR"]);
  });

  it("treats stale latest autoscores as needing rescore when the policy hash changed", () => {
    const tests = [createTest("test-v2-stale-policy", "TEST-V2-STALE-POLICY")];
    const run: PromptPackRunRecord = {
      ...createRun("run-v2-stale-policy", "completed", "2026-03-16T00:30:00.000Z"),
      testId: "test-v2-stale-policy",
      trace: createTrace("sess-v2-stale-policy"),
    };
    const staleScore: PromptPackScoreRecordV2 = {
      autoScoreId: "auto-v2-stale-policy",
      packId: "pack-1",
      testId: "test-v2-stale-policy",
      runId: "run-v2-stale-policy",
      scoringSchemaVersion: "v2",
      scorerVersion: "2026-04-16.2",
      judgeRubricVersion: "2026-04-09.1",
      policyHash: "policy-old",
      policySource: "inherited_default",
      scoreState: "auto_valid",
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
      weightedScore: 92,
      autoVerdict: "pass",
      judgeStatus: "valid",
      reviewReasons: [],
      degradedReasons: [],
      mergeProvenance: {},
      createdAt: "2026-03-16T00:31:00.000Z",
    };

    const summary = buildPromptPackReportSummary(tests, [run], [], [staleScore], [], [], {
      policyHash: "policy-current",
    });

    expect(summary.needsScoreCount).toBe(1);
    expect(summary.staleLatestAutoScoreCount).toBe(1);
    expect(summary.autoScoredRuns).toBe(0);
    expect(summary.passCount).toBe(0);
    expect(summary.effectivePassRate).toBe(0);
  });

  it("treats stale latest autoscores as needing rescore when the scorer generation changed", () => {
    const tests = [createTest("test-v2-stale-scorer", "TEST-V2-STALE-SCORER")];
    const run: PromptPackRunRecord = {
      ...createRun("run-v2-stale-scorer", "completed", "2026-03-16T00:30:00.000Z"),
      testId: "test-v2-stale-scorer",
      trace: createTrace("sess-v2-stale-scorer"),
    };
    const staleScore: PromptPackScoreRecordV2 = {
      autoScoreId: "auto-v2-stale-scorer",
      packId: "pack-1",
      testId: "test-v2-stale-scorer",
      runId: "run-v2-stale-scorer",
      scoringSchemaVersion: "v2",
      scorerVersion: "2026-04-01.1",
      judgeRubricVersion: "2026-04-09.1",
      policyHash: "policy-current",
      policySource: "inherited_default",
      scoreState: "auto_valid",
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
      weightedScore: 92,
      autoVerdict: "pass",
      judgeStatus: "valid",
      reviewReasons: [],
      degradedReasons: [],
      mergeProvenance: {},
      createdAt: "2026-03-16T00:31:00.000Z",
    };

    const summary = buildPromptPackReportSummary(tests, [run], [], [staleScore], [], [], {
      policyHash: "policy-current",
    });

    expect(summary.needsScoreCount).toBe(1);
    expect(summary.staleLatestAutoScoreCount).toBe(1);
    expect(summary.autoScoredRuns).toBe(0);
    expect(summary.passCount).toBe(0);
    expect(summary.effectivePassRate).toBe(0);
  });

  it("summarizes v2 scores, degraded rows, and human override verdicts separately", () => {
    const tests: PromptPackTestRecord[] = [
      createTest("test-v2-pass", "TEST-V2-PASS"),
      createTest("test-v2-review", "TEST-V2-REVIEW"),
    ];
    const passRun: PromptPackRunRecord = {
      ...createRun("run-v2-pass", "completed", "2026-03-16T00:00:00.000Z"),
      testId: "test-v2-pass",
    };
    const reviewRun: PromptPackRunRecord = {
      ...createRun("run-v2-review", "completed", "2026-03-16T00:10:00.000Z"),
      testId: "test-v2-review",
    };
    const passScore: PromptPackScoreRecordV2 = {
      autoScoreId: "auto-v2-pass",
      packId: "pack-1",
      testId: "test-v2-pass",
      runId: "run-v2-pass",
      scoringSchemaVersion: "v2",
      scorerVersion: "2026-04-16.2",
      judgeRubricVersion: "2026-04-09.1",
      policyHash: "policy-hash",
      policySource: "inherited_default",
      assertionSetVersion: undefined,
      scoreState: "auto_valid",
      protocol: {
        protocolPass: true,
        reasonCodes: [],
      },
      hardFailReasons: [],
      applicability: {
        taskSuccess: true,
        honesty: true,
        executionQuality: true,
        robustness: true,
        usability: true,
      },
      ruleScores: {
        taskSuccess: 3,
        honesty: 3,
        executionQuality: 3,
        robustness: 3,
        usability: 3,
      },
      judgeScores: {
        taskSuccess: 4,
        honesty: 3,
        executionQuality: 3,
        robustness: 3,
        usability: 4,
      },
      finalScores: {
        taskSuccess: 4,
        honesty: 3,
        executionQuality: 3,
        robustness: 3,
        usability: 4,
      },
      disagreement: {
        taskSuccess: 1,
        usability: 1,
      },
      weightedScore: 82.5,
      autoVerdict: "pass",
      reviewReasons: [],
      degradedReasons: [],
      mergeProvenance: {},
      judgeStatus: "valid",
      notes: "",
      createdAt: "2026-03-16T00:05:00.000Z",
    };
    const degradedReviewScore: PromptPackScoreRecordV2 = {
      ...passScore,
      autoScoreId: "auto-v2-review",
      testId: "test-v2-review",
      runId: "run-v2-review",
      scoreState: "auto_degraded",
      finalScores: {
        taskSuccess: 2,
        honesty: 3,
        executionQuality: 2,
        robustness: 2,
        usability: 2,
      },
      weightedScore: 56.3,
      autoVerdict: "review",
      reviewReasons: ["judge_invalid"],
      degradedReasons: ["judge_invalid"],
      judgeStatus: "invalid",
      createdAt: "2026-03-16T00:15:00.000Z",
    };
    const overrideReview: PromptPackHumanReviewRecordV2 = {
      reviewId: "review-v2-review",
      packId: "pack-1",
      testId: "test-v2-review",
      runId: "run-v2-review",
      autoScoreId: "auto-v2-review",
      reviewerId: "qa-user",
      scores: {
        taskSuccess: 3,
        honesty: 3,
        executionQuality: 3,
        robustness: 3,
        usability: 3,
      },
      applicability: {
        taskSuccess: true,
        honesty: true,
        executionQuality: true,
        robustness: true,
        usability: true,
      },
      overrideVerdict: "pass",
      notes: "Manual adjudication accepted the bounded answer.",
      createdAt: "2026-03-16T00:20:00.000Z",
    };

    const summary = buildPromptPackReportSummary(
      tests,
      [passRun, reviewRun],
      [],
      [passScore, degradedReviewScore],
      [overrideReview],
      [],
      {
        scoringSchemaVersion: "v2",
        policyHash: "policy-hash",
      },
    );

    expect(summary.autoScoredRuns).toBe(2);
    expect(summary.humanReviewedRuns).toBe(1);
    expect(summary.degradedScoreCount).toBe(1);
    expect(summary.passCount).toBe(2);
    expect(summary.reviewCount).toBe(0);
    expect(summary.failCount).toBe(0);
    expect(summary.averageWeightedScore).toBeCloseTo(69.4, 1);
    expect(summary.effectivePassRate).toBe(1);
    expect(summary.failingCodes).toEqual([]);
  });

  it("treats fallback judge rows as review blockers in report summary", () => {
    const tests = [createTest("test-v2-fallback-summary", "TEST-V2-FALLBACK-SUMMARY")];
    const runs: PromptPackRunRecord[] = [
      {
        ...createRun("run-v2-fallback-summary", "completed", "2026-03-16T00:30:00.000Z"),
        testId: "test-v2-fallback-summary",
        responseText: "The effective precedence is workspace guidance, then repo guidance, then memory.",
        trace: createTrace("sess-v2-fallback-summary"),
      },
    ];
    const fallbackScore: PromptPackScoreRecordV2 = {
      autoScoreId: "auto-v2-fallback-summary",
      packId: "pack-1",
      testId: "test-v2-fallback-summary",
      runId: "run-v2-fallback-summary",
      scoringSchemaVersion: "v2",
      scorerVersion: "2026-04-16.2",
      judgeRubricVersion: "2026-04-09.1",
      policyHash: "policy-hash",
      policySource: "inherited_default",
      assertionSetVersion: undefined,
      scoreState: "auto_valid",
      protocol: {
        protocolPass: true,
        reasonCodes: [],
      },
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
      judgeScores: undefined,
      finalScores: {
        taskSuccess: 4,
        honesty: 4,
        executionQuality: 4,
        robustness: 4,
        usability: 4,
      },
      disagreement: {},
      weightedScore: 100,
      autoVerdict: "review",
      reviewReasons: ["judge_fallback"],
      degradedReasons: ["judge_fallback"],
      mergeProvenance: {},
      judgeStatus: "fallback",
      notes: "Judge fallback: deterministic rule scores were used because the model judge output was unusable.",
      createdAt: "2026-03-16T00:31:00.000Z",
    };

    const summary = buildPromptPackReportSummary(tests, runs, [], [fallbackScore], [], [], {
      scoringSchemaVersion: "v2",
      policyHash: "policy-hash",
    });

    expect(summary.judgeFallbackCount).toBe(1);
    expect(summary.judgeErrorCount).toBe(0);
    expect(summary.degradedScoreCount).toBe(0);
    expect(summary.passCount).toBe(0);
    expect(summary.reviewCount).toBe(1);
  });

  it("recomputes auto scores when force is true instead of reusing the current score row", async () => {
    const pack = {
      packId: "pack-1",
      name: "Pack 1",
      testCount: 1,
      policyHash: "policy-hash",
      policySource: "inherited_default" as const,
      createdAt: "2026-03-16T00:00:00.000Z",
      updatedAt: "2026-03-16T00:00:00.000Z",
    };
    const test = createTest("test-force-rescore", "TEST-V2-FORCE");
    const run: PromptPackRunRecord = {
      ...createRun("run-force-rescore", "completed", "2026-03-16T00:40:00.000Z"),
      testId: test.testId,
      responseText: "The effective precedence is workspace guidance, then repo guidance, then memory.",
      trace: createTrace("sess-force-rescore"),
    };
    const existingScore: PromptPackScoreRecordV2 = {
      autoScoreId: "auto-existing",
      packId: pack.packId,
      testId: test.testId,
      runId: run.runId,
      scoringSchemaVersion: "v2",
      scorerVersion: "2026-04-16.2",
      judgeRubricVersion: "2026-04-09.1",
      policyHash: "policy-hash",
      policySource: "inherited_default",
      assertionSetVersion: undefined,
      scoreState: "auto_valid",
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
      judgeScores: {
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
      weightedScore: 100,
      autoVerdict: "pass",
      reviewReasons: [],
      degradedReasons: [],
      mergeProvenance: {},
      judgeStatus: "valid",
      notes: "",
      createdAt: "2026-03-16T00:41:00.000Z",
    };
    const createAutoScore = vi.fn((input: PromptPackScoreRecordV2) => input);
    const service = new PromptPackService(
      {
        storage: {
          promptPacks: {
            getPack: () => pack,
            getTest: () => test,
            listTests: () => [test],
          },
          promptPackRuns: {
            listByTest: () => [run],
            get: () => run,
            listByPack: () => [run],
          },
          promptPackAutoScoresV2: {
            listByRun: () => [existingScore],
            create: createAutoScore,
            listByPack: () => [existingScore],
          },
          promptPackScores: {
            listByRun: () => [],
            listByPack: () => [],
          },
          promptPackHumanReviewsV2: {
            listByPack: () => [],
          },
        },
        gatewaySql: {} as never,
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
        createChatSession: vi.fn(),
        agentSendChatMessage: vi.fn(),
        createChatCompletion: vi.fn(async () => ({
          choices: [
            {
              index: 0,
              message: {
                role: "assistant",
                content:
                  '{"routingScore":2,"honestyScore":2,"handoffScore":2,"robustnessScore":2,"usabilityScore":2,"rationale":"Looks good."}',
              },
              finish_reason: "stop",
            },
          ],
        })),
        getPromptRunnerModelDefaults: () => ({ providerId: "openai", model: "gpt-5.4" }),
        getPromptJudgeModelDefaults: () => ({ providerId: "openai", model: "gpt-5.4" }),
        backgroundTasks: new Set(),
      },
    );
    vi.spyOn(service as never, "refreshPromptPackExportFile").mockImplementation(() => undefined);

    const result = await service.autoScorePromptPackTest({
      packId: pack.packId,
      testId: test.testId,
      runId: run.runId,
      force: true,
      scoringSchemaVersion: "v2",
    });

    expect(createAutoScore).toHaveBeenCalledTimes(1);
    expect(result.score.autoScoreId).toBe(existingScore.autoScoreId);
  });

  it("keeps auto-scoring successful when export refresh fails after persistence", async () => {
    const pack = {
      packId: "pack-1",
      name: "Pack 1",
      testCount: 1,
      policyHash: "policy-hash",
      policySource: "inherited_default" as const,
      createdAt: "2026-03-16T00:00:00.000Z",
      updatedAt: "2026-03-16T00:00:00.000Z",
    };
    const test = createTest("test-export-refresh", "TEST-V2-EXPORT");
    const run: PromptPackRunRecord = {
      ...createRun("run-export-refresh", "completed", "2026-03-16T00:40:00.000Z"),
      testId: test.testId,
      responseText: "The correct precedence is workspace guidance, then repo guidance, then memory.",
      trace: createTrace("sess-export-refresh"),
    };
    const createAutoScore = vi.fn((input: PromptPackScoreRecordV2) => input);
    const service = new PromptPackService(
      {
        storage: {
          promptPacks: {
            getPack: () => pack,
            getTest: () => test,
            listTests: () => [test],
          },
          promptPackRuns: {
            listByTest: () => [run],
            get: () => run,
            listByPack: () => [run],
          },
          promptPackAutoScoresV2: {
            listByRun: () => [],
            create: createAutoScore,
            listByPack: () => [],
          },
          promptPackScores: {
            listByRun: () => [],
            listByPack: () => [],
          },
          promptPackHumanReviewsV2: {
            listByPack: () => [],
          },
        },
        gatewaySql: {} as never,
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
        createChatSession: vi.fn(),
        agentSendChatMessage: vi.fn(),
        createChatCompletion: vi.fn(async () => ({
          choices: [
            {
              index: 0,
              message: {
                role: "assistant",
                content:
                  '{"routingScore":2,"honestyScore":2,"handoffScore":2,"robustnessScore":2,"usabilityScore":2,"rationale":"Looks good."}',
              },
              finish_reason: "stop",
            },
          ],
        })),
        getPromptRunnerModelDefaults: () => ({ providerId: "openai", model: "gpt-5.4" }),
        getPromptJudgeModelDefaults: () => ({ providerId: "openai", model: "gpt-5.4" }),
        backgroundTasks: new Set(),
      },
    );
    vi.spyOn(service as never, "refreshPromptPackExportFile").mockImplementation(() => {
      throw new Error("disk full");
    });

    const result = await service.autoScorePromptPackTest({
      packId: pack.packId,
      testId: test.testId,
      runId: run.runId,
      force: true,
    });

    expect(createAutoScore).toHaveBeenCalledTimes(1);
    expect(result.score.runId).toBe(run.runId);
    expect(result.score.judgeStatus).toBe("valid");
  });

  it("continues batch auto-scoring after a per-test failure and prefers completed runs", async () => {
    const firstTest = createTest("test-batch-1", "TEST-BATCH-01");
    const secondTest = createTest("test-batch-2", "TEST-BATCH-02");
    const olderCompleted: PromptPackRunRecord = {
      ...createRun("run-batch-completed", "completed", "2026-03-16T00:40:00.000Z"),
      testId: firstTest.testId,
      responseText: "Completed answer.",
      trace: createTrace("sess-batch-completed"),
    };
    const latestFailed: PromptPackRunRecord = {
      ...createRun("run-batch-failed", "failed", "2026-03-16T00:41:00.000Z"),
      testId: firstTest.testId,
    };
    const secondCompleted: PromptPackRunRecord = {
      ...createRun("run-batch-second", "completed", "2026-03-16T00:42:00.000Z"),
      testId: secondTest.testId,
      responseText: "Completed answer.",
      trace: createTrace("sess-batch-second"),
    };
    const service = new PromptPackService(
      {
        storage: {
          promptPacks: {
            getPack: () => ({
              packId: "pack-1",
              name: "Pack 1",
              policyHash: "policy-hash",
            }),
            listTests: () => [firstTest, secondTest],
          },
          promptPackRuns: {
            listByTest: (testId: string) =>
              testId === firstTest.testId ? [latestFailed, olderCompleted] : [secondCompleted],
          },
          promptPackAutoScoresV2: {
            listByRun: () => [],
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
    const autoScoreSpy = vi
      .spyOn(service, "autoScorePromptPackTest")
      .mockRejectedValueOnce(new Error("Cannot score first run"))
      .mockResolvedValueOnce({
        score: {
          autoScoreId: "auto-batch-second",
        },
        run: secondCompleted,
      } as never);

    const result = await service.autoScorePromptPackBatch({
      packId: "pack-1",
      onlyUnscored: false,
      limit: 2,
    });

    expect(autoScoreSpy).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({
        testId: firstTest.testId,
        runId: olderCompleted.runId,
      }),
    );
    expect(autoScoreSpy).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({
        testId: secondTest.testId,
        runId: secondCompleted.runId,
      }),
    );
    expect(result.items).toHaveLength(1);
    expect(result.skipped).toBe(1);
    expect(result.errors).toEqual([
      {
        testId: firstTest.testId,
        runId: olderCompleted.runId,
        error: "Cannot score first run",
      },
    ]);
  });

  it("builds trend series from historical score and run timestamps only", () => {
    const capabilitySeries = buildPromptPackCapabilitySeries(
      [
        createScore("score-1", "run-1", "2026-03-10T00:05:00.000Z", 0),
        createScore("score-2", "run-2", "2026-03-12T00:05:00.000Z", 1),
        createScore("score-3", "run-3", "2026-03-14T00:05:00.000Z", 2),
      ],
      "routing",
    );
    expect(capabilitySeries).toEqual([
      { timestamp: "2026-03-10T00:05:00.000Z", value: 0 },
      { timestamp: "2026-03-12T00:05:00.000Z", value: 0.5 },
      { timestamp: "2026-03-14T00:05:00.000Z", value: 1 },
    ]);

    const failureSeries = buildPromptPackRunFailureRateSeries([
      createRun("run-1", "completed", "2026-03-10T00:00:01.000Z"),
      createRun("run-2", "failed", "2026-03-12T00:00:02.000Z"),
      createRun("run-3", "completed", "2026-03-14T00:00:03.000Z"),
    ]);
    expect(failureSeries).toEqual([
      { timestamp: "2026-03-10T00:00:01.000Z", value: 0 },
      { timestamp: "2026-03-12T00:00:02.000Z", value: 0.5 },
      { timestamp: "2026-03-14T00:00:03.000Z", value: 0.3333 },
    ]);
  });
});


describe("score-facing response integrity", () => {
  it("ignores fabricated finalResponseText and scores the raw model output", () => {
    const run: PromptPackRunRecord = {
      runId: "run-integrity-fabricated",
      packId: "pack-1",
      testId: "test-1",
      sessionId: "sess-integrity-fabricated",
      status: "completed",
      mode: "chat",
      toolTier: "implicit-tools",
      toolAutonomy: "safe_auto",
      webMode: "auto",
      memoryMode: "auto",
      thinkingLevel: "standard",
      responseText: "I exhausted the current tool approaches after several attempts.",
      finalResponseText: "## Route\n- A polished answer the model never produced.",
      finalResponseSignals: ["prompt_lab_score_facing_normalization"],
      startedAt: "2026-03-14T00:00:00.000Z",
      finishedAt: "2026-03-14T00:00:01.000Z",
    };
    expect(resolvePromptPackScoreFacingResponseText(run)).toBe(
      "I exhausted the current tool approaches after several attempts.",
    );
  });

  it("returns the raw response text when no finalResponseText exists", () => {
    const run: PromptPackRunRecord = {
      runId: "run-integrity-no-final",
      packId: "pack-1",
      testId: "test-1",
      sessionId: "sess-integrity-no-final",
      status: "completed",
      mode: "chat",
      toolTier: "implicit-tools",
      toolAutonomy: "safe_auto",
      webMode: "auto",
      memoryMode: "auto",
      thinkingLevel: "standard",
      responseText: "plain answer",
      finalResponseText: undefined,
      startedAt: "2026-03-14T00:00:00.000Z",
      finishedAt: "2026-03-14T00:00:01.000Z",
    };
    expect(resolvePromptPackScoreFacingResponseText(run)).toBe("plain answer");
  });
});