import { describe, expect, it } from "vitest";
import type {
  ChatProjectRecord,
  PromptPackRunRecord,
  PromptPackScoreRecord,
  PromptPackTestRecord,
} from "@goatcitadel/contracts";
import {
  buildPromptPackSessionToolAllowlist,
  findPromptPackProjectBinding,
  finalizePromptPackResponseText,
  buildPromptPackSessionPrefsOverride,
  buildPromptPackPromptInput,
  buildPromptPackCapabilitySeries,
  buildPromptPackRunFailureRateSeries,
  evaluatePromptPackRuleScores,
  pickReplayBaselineScore,
  resolvePromptPackJudgeTarget,
  resolvePromptPackJudgeTemperature,
  resolvePromptPackJudgeServiceTier,
  resolvePromptPackExecutionProfile,
} from "./prompt-pack-service.js";

describe("prompt-pack helpers", () => {
  it("finds prompt-pack project bindings and prefers the jailed fixture workspace path", () => {
    const legacyProject: ChatProjectRecord = {
      projectId: "legacy-project",
      workspaceId: "default",
      name: "Prompt Lab Workspace",
      description: "Auto-created project binding for prompt-pack code evaluations.",
      workspacePath: ".",
      lifecycleStatus: "active",
      createdAt: "2026-03-16T00:00:00.000Z",
      updatedAt: "2026-03-16T00:00:00.000Z",
    };
    const currentProject: ChatProjectRecord = {
      ...legacyProject,
      projectId: "current-project",
      workspacePath: "fixtures/prompt-pack-workspace",
    };

    expect(findPromptPackProjectBinding([legacyProject])).toMatchObject({
      projectId: "legacy-project",
    });
    expect(findPromptPackProjectBinding([legacyProject, currentProject])).toMatchObject({
      projectId: "current-project",
    });
  });

  it("resolves no-tools profiles and honors mode presets", () => {
    const noToolsProfile = resolvePromptPackExecutionProfile({
      test: {
        testId: "test-no-tools",
        packId: "pack-1",
        code: "TEST-01",
        title: "No Tools",
        prompt: "Answer only from the prompt.",
        orderIndex: 0,
        mode: "chat",
        toolTier: "no-tools",
        createdAt: "2026-03-14T00:00:00.000Z",
      },
    });
    expect(noToolsProfile).toEqual({
      mode: "chat",
      toolTier: "no-tools",
      toolAutonomy: "manual",
      webMode: "off",
      memoryMode: "off",
      thinkingLevel: "standard",
    });

    const codeProfile = resolvePromptPackExecutionProfile({
      test: {
        testId: "test-code",
        packId: "pack-1",
        code: "TEST-02",
        title: "Code",
        prompt: "Inspect the repo and explain the fix.",
        orderIndex: 1,
        mode: "code",
        toolTier: "explicit-tools",
        createdAt: "2026-03-14T00:00:00.000Z",
      },
    });
    expect(codeProfile.mode).toBe("code");
    expect(codeProfile.toolTier).toBe("explicit-tools");
    expect(codeProfile.toolAutonomy).toBe("safe_auto");
    expect(codeProfile.webMode).toBe("auto");
    expect(codeProfile.memoryMode).toBe("auto");
    expect(codeProfile.thinkingLevel).toBe("extended");
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

  it("treats blocked explicit-tool attempts as attempted usage", () => {
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

    expect(evaluation.scores.routingScore).toBe(1);
    expect(evaluation.signals).toContain("required_tool_usage_attempted");
    expect(evaluation.signals).not.toContain("missing_required_tool_usage");
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
        responseText: "This is a partial answer recovered from tool output because the final synthesis pass did not finish cleanly.",
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

  it("builds deterministic session overrides for prompt-pack runs", () => {
    const chatProfile = resolvePromptPackExecutionProfile({
      test: {
        testId: "test-chat",
        packId: "pack-1",
        code: "TEST-04",
        title: "Chat",
        prompt: "Answer directly.",
        orderIndex: 0,
        mode: "chat",
        toolTier: "no-tools",
        createdAt: "2026-03-14T00:00:00.000Z",
      },
    });
    expect(buildPromptPackSessionPrefsOverride(chatProfile)).toMatchObject({
      mode: "chat",
      planningMode: "off",
      orchestrationEnabled: false,
      orchestrationParallelism: "sequential",
    });

    const noToolsCodeProfile = resolvePromptPackExecutionProfile({
      test: {
        testId: "test-code-no-tools",
        packId: "pack-1",
        code: "TEST-04B",
        title: "Code No Tools",
        prompt: "Answer without tools.",
        orderIndex: 0,
        mode: "code",
        toolTier: "no-tools",
        createdAt: "2026-03-14T00:00:00.000Z",
      },
    });
    expect(buildPromptPackSessionPrefsOverride(noToolsCodeProfile)).toMatchObject({
      mode: "code",
      toolAutonomy: "manual",
      webMode: "off",
      memoryMode: "off",
      orchestrationEnabled: false,
      orchestrationVisibility: "explicit",
    });

    const noToolsCoworkProfile = resolvePromptPackExecutionProfile({
      test: {
        testId: "test-cowork-no-tools",
        packId: "pack-1",
        code: "TEST-04C",
        title: "Cowork No Tools",
        prompt: "Analyze and synthesize without tools.",
        orderIndex: 0,
        mode: "cowork",
        toolTier: "no-tools",
        createdAt: "2026-03-14T00:00:00.000Z",
      },
    });
    expect(buildPromptPackSessionPrefsOverride(noToolsCoworkProfile)).toMatchObject({
      mode: "cowork",
      toolAutonomy: "manual",
      webMode: "off",
      memoryMode: "off",
      orchestrationEnabled: true,
      orchestrationVisibility: "explicit",
      orchestrationParallelism: "parallel",
    });

    const codeProfile = resolvePromptPackExecutionProfile({
      test: {
        testId: "test-code-2",
        packId: "pack-1",
        code: "TEST-05",
        title: "Code",
        prompt: "Inspect files and fix the issue.",
        orderIndex: 1,
        mode: "code",
        toolTier: "explicit-tools",
        createdAt: "2026-03-14T00:00:00.000Z",
      },
    });
    expect(buildPromptPackSessionPrefsOverride(codeProfile)).toMatchObject({
      mode: "code",
      planningMode: "off",
      orchestrationEnabled: true,
      orchestrationVisibility: "explicit",
      orchestrationParallelism: "sequential",
      toolAutonomy: "safe_auto",
    });

    expect(buildPromptPackSessionPrefsOverride(codeProfile, "Read fixtures/prompt-pack-workspace/package.json using file tools.")).toMatchObject({
      webMode: "off",
      memoryMode: "off",
    });

    expect(buildPromptPackSessionPrefsOverride(codeProfile, "Read package.json using file tools, then use browser.search to check the latest versions.")).toMatchObject({
      webMode: "auto",
      memoryMode: "off",
    });
  });

  it("builds prompt-pack session tool allowlists from mode and explicit directives", () => {
    const codeProfile = resolvePromptPackExecutionProfile({
      test: {
        testId: "test-code-tools",
        packId: "pack-1",
        code: "TEST-TOOLS-01",
        title: "Code Tools",
        prompt: "Read local project files and implement a fix.",
        orderIndex: 0,
        mode: "code",
        toolTier: "explicit-tools",
        createdAt: "2026-03-14T00:00:00.000Z",
      },
    });
    expect(buildPromptPackSessionToolAllowlist(codeProfile)).toEqual([
      "fs.read",
      "file.read_range",
      "file.find",
      "code.search",
      "code.search_files",
      "shell.exec",
      "tests.run",
      "lint.run",
    ]);

    const coworkProfile = resolvePromptPackExecutionProfile({
      test: {
        testId: "test-cowork-tools",
        packId: "pack-1",
        code: "TEST-TOOLS-02",
        title: "Cowork Tools",
        prompt: "Read fixtures/prompt-pack-workspace/package.json using file tools, then use browser.search to compare versions.",
        orderIndex: 1,
        mode: "cowork",
        toolTier: "explicit-tools",
        createdAt: "2026-03-14T00:00:00.000Z",
      },
    });
    expect(buildPromptPackSessionToolAllowlist(
      coworkProfile,
      "Read fixtures/prompt-pack-workspace/package.json using file tools, then use browser.search to compare versions.",
    )).toEqual([
      "fs.read",
      "file.read_range",
      "file.find",
      "code.search",
      "code.search_files",
      "browser.search",
    ]);

    const noToolsProfile = resolvePromptPackExecutionProfile({
      test: {
        testId: "test-no-tools-allowlist",
        packId: "pack-1",
        code: "TEST-TOOLS-03",
        title: "No Tools",
        prompt: "Answer directly.",
        orderIndex: 2,
        mode: "chat",
        toolTier: "no-tools",
        createdAt: "2026-03-14T00:00:00.000Z",
      },
    });
    expect(buildPromptPackSessionToolAllowlist(noToolsProfile, "Use browser.search if needed.")).toEqual([]);
  });

  it("wraps cowork, code, and explicit-tools prompts with prompt-lab contracts", () => {
    const coworkProfile = resolvePromptPackExecutionProfile({
      test: {
        testId: "test-cowork-contract",
        packId: "pack-1",
        code: "TEST-CONTRACT-01",
        title: "Cowork Contract",
        prompt: "Map the tradeoffs and recommend a path.",
        orderIndex: 0,
        mode: "cowork",
        toolTier: "no-tools",
        createdAt: "2026-03-14T00:00:00.000Z",
      },
    });
    const coworkInput = buildPromptPackPromptInput("Map the tradeoffs and recommend a path.", coworkProfile);
    expect(coworkInput.prompt).toContain("## Prompt Lab Run Contract");
    expect(coworkInput.prompt).toContain("This is a Cowork evaluation");
    expect(coworkInput.prompt).toContain("use at least two role-labeled sections");
    expect(coworkInput.prompt).toContain("end with a synthesis");

    const codeProfile = resolvePromptPackExecutionProfile({
      test: {
        testId: "test-code-contract",
        packId: "pack-1",
        code: "TEST-CONTRACT-02",
        title: "Code Contract",
        prompt: "Inspect the repo and explain the fix.",
        orderIndex: 1,
        mode: "code",
        toolTier: "no-tools",
        createdAt: "2026-03-14T00:00:00.000Z",
      },
    });
    const codeInput = buildPromptPackPromptInput("Inspect the repo and explain the fix.", codeProfile);
    expect(codeInput.prompt).toContain("This is a Code evaluation");
    expect(codeInput.prompt).toContain("name the exact file paths");
    expect(codeInput.prompt).toContain("Do not claim validation or execution unless you include the exact command/check and the result.");

    const explicitToolsProfile = resolvePromptPackExecutionProfile({
      test: {
        testId: "test-explicit-contract",
        packId: "pack-1",
        code: "TEST-CONTRACT-03",
        title: "Explicit Tools Contract",
        prompt: "Read package.json using file tools, then use browser.search to compare versions.",
        orderIndex: 2,
        mode: "chat",
        toolTier: "explicit-tools",
        createdAt: "2026-03-14T00:00:00.000Z",
      },
    });
    const explicitToolsInput = buildPromptPackPromptInput(
      "Read package.json using file tools, then use browser.search to compare versions.",
      explicitToolsProfile,
    );
    expect(explicitToolsInput.prompt).toContain("This is an explicit-tools evaluation");
    expect(explicitToolsInput.prompt).toContain("Required named tools: `browser.search`");
    expect(explicitToolsInput.prompt).toContain("Required tool families: file/code tools");
    expect(explicitToolsInput.prompt).toContain("Surface tool-backed evidence in the answer.");
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

  it("uses kimi-compatible temperature for prompt-pack model judging", () => {
    expect(resolvePromptPackJudgeTemperature("moonshot", "moonshot/kimi-k2.5")).toBe(1);
    expect(resolvePromptPackJudgeTemperature("openai", "gpt-5")).toBe(0);
    expect(resolvePromptPackJudgeTemperature(undefined, "kimi-k2")).toBe(1);
  });

  it("uses flex processing only for OpenAI prompt-pack judging", () => {
    expect(resolvePromptPackJudgeServiceTier("openai")).toBe("flex");
    expect(resolvePromptPackJudgeServiceTier("moonshot")).toBeUndefined();
    expect(resolvePromptPackJudgeServiceTier(undefined)).toBeUndefined();
  });

  it("prefers the run model for judging except for kimi-family runs", () => {
    expect(resolvePromptPackJudgeTarget({
      runProviderId: "glm",
      runModel: "glm-5-turbo",
      defaultProviderId: "glm",
      defaultModel: "glm-5",
    })).toEqual({
      providerId: "glm",
      model: "glm-5-turbo",
    });

    expect(resolvePromptPackJudgeTarget({
      runProviderId: "moonshot",
      runModel: "kimi-k2.5",
      defaultProviderId: "glm",
      defaultModel: "glm-5",
    })).toEqual({
      providerId: "glm",
      model: "glm-5",
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

  it("chooses previous or timestamp baselines from scored history", () => {
    const current: PromptPackScoreRecord = createScore("score-3", "run-3", "2026-03-14T00:05:00.000Z", 2);
    const previous: PromptPackScoreRecord = createScore("score-2", "run-2", "2026-03-12T00:05:00.000Z", 1);
    const earliest: PromptPackScoreRecord = createScore("score-1", "run-1", "2026-03-10T00:05:00.000Z", 0);
    const scores = [current, previous, earliest];

    expect(pickReplayBaselineScore(scores, current)?.scoreId).toBe("score-2");
    expect(pickReplayBaselineScore(scores, current, "2026-03-11T00:00:00.000Z")?.scoreId).toBe("score-1");
    expect(pickReplayBaselineScore(scores, current, "2026-03-13T00:00:00.000Z")?.scoreId).toBe("score-2");
  });

  it("builds trend series from historical score and run timestamps only", () => {
    const capabilitySeries = buildPromptPackCapabilitySeries([
      createScore("score-1", "run-1", "2026-03-10T00:05:00.000Z", 0),
      createScore("score-2", "run-2", "2026-03-12T00:05:00.000Z", 1),
      createScore("score-3", "run-3", "2026-03-14T00:05:00.000Z", 2),
    ], "routing");
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

function createScore(
  scoreId: string,
  runId: string,
  createdAt: string,
  value: 0 | 1 | 2,
): PromptPackScoreRecord {
  return {
    scoreId,
    packId: "pack-1",
    testId: "test-1",
    runId,
    routingScore: value,
    honestyScore: value,
    handoffScore: value,
    robustnessScore: value,
    usabilityScore: value,
    totalScore: value * 5,
    createdAt,
  };
}

function createRun(
  runId: string,
  status: PromptPackRunRecord["status"],
  finishedAt: string,
): PromptPackRunRecord {
  return {
    runId,
    packId: "pack-1",
    testId: "test-1",
    sessionId: `sess-${runId}`,
    status,
    mode: "chat",
    toolTier: "implicit-tools",
    toolAutonomy: "safe_auto",
    webMode: "auto",
    memoryMode: "auto",
    thinkingLevel: "standard",
    startedAt: finishedAt,
    finishedAt,
  };
}
