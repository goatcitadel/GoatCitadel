import { describe, expect, it } from "vitest";
import type {
  ChatProjectRecord,
  PromptPackHumanReviewRecordV2,
  PromptPackScoreRecordV2,
  PromptPackRunRecord,
  PromptPackScoreRecord,
  PromptPackTestRecord,
} from "@goatcitadel/contracts";
import {
  assertPromptPackRunScorable,
  buildPromptPackJudgeRecord,
  buildPromptPackSessionAllowedPaths,
  buildPromptPackSessionToolAllowlist,
  findPromptPackProjectBinding,
  finalizePromptPackResponseText,
  buildPromptPackSessionPrefsOverride,
  buildPromptPackReportSummary,
  pickPromptPackAutoScoreRun,
  buildPromptPackPromptInput,
  buildPromptPackCapabilitySeries,
  buildPromptPackRunFailureRateSeries,
  evaluatePromptPackRunIntegrity,
  evaluatePromptPackRuleScores,
  extractPromptPackCompletionText,
  normalizePromptPackJudgeScores,
  parsePromptPackTests,
  pickReplayBaselineScore,
  resolvePromptPackRunIntegrity,
  resolvePromptPackJudgeTarget,
  resolvePromptPackJudgeTemperature,
  resolvePromptPackJudgeServiceTier,
  resolvePromptPackExecutionProfile,
  resolvePromptPackProjectBinding,
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

  it("resolves repo-root project bindings for repo-native code prompts", () => {
    const codeProfile = resolvePromptPackExecutionProfile({
      test: {
        testId: "test-code-binding",
        packId: "pack-1",
        code: "TEST-BIND-01",
        title: "Repo Binding",
        prompt: "Based on the current GoatCitadel repo, inspect apps/gateway/src/services/prompt-pack-service.ts.",
        orderIndex: 0,
        mode: "code",
        toolTier: "implicit-tools",
        createdAt: "2026-03-21T00:00:00.000Z",
      },
    });

    expect(
      resolvePromptPackProjectBinding(
        codeProfile,
        "Based on the current GoatCitadel repo, inspect apps/gateway/src/services/prompt-pack-service.ts.",
      )?.workspacePath,
    ).toBe("__prompt_pack_repo__");

    expect(
      resolvePromptPackProjectBinding(
        codeProfile,
        "Read fixtures/prompt-pack-workspace/package.json using file/code tools.",
      )?.workspacePath,
    ).toBe("fixtures/prompt-pack-workspace");

    const coworkProfile = resolvePromptPackExecutionProfile({
      test: {
        testId: "test-cowork-binding",
        packId: "pack-1",
        code: "TEST-BIND-02",
        title: "Cowork Repo Binding",
        prompt:
          "Use file or code tools to inspect apps/gateway/src/services/skill-import-service.ts and summarize the next provenance checks.",
        orderIndex: 1,
        mode: "cowork",
        toolTier: "explicit-tools",
        createdAt: "2026-03-21T00:00:00.000Z",
      },
    });

    expect(
      resolvePromptPackProjectBinding(
        coworkProfile,
        "Use file or code tools to inspect apps/gateway/src/services/skill-import-service.ts and summarize the next provenance checks.",
      )?.workspacePath,
    ).toBe("__prompt_pack_repo__");
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
    expect(evaluation.scores.robustnessScore).toBe(2);
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
    expect(
      buildPromptPackSessionPrefsOverride(
        resolvePromptPackExecutionProfile({
          test: {
            testId: "test-chat-repo-inspect",
            packId: "pack-1",
            code: "TEST-04A",
            title: "Chat Repo Inspect",
            prompt: "Inspect the repo if needed and explain the current guidance-loading chain.",
            orderIndex: 0,
            mode: "chat",
            toolTier: "implicit-tools",
            createdAt: "2026-03-14T00:00:00.000Z",
          },
        }),
        "Inspect the repo if needed and explain the current guidance-loading chain.",
      ),
    ).toMatchObject({
      webMode: "off",
      memoryMode: "off",
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
      orchestrationEnabled: false,
      orchestrationVisibility: "explicit",
      orchestrationParallelism: "sequential",
    });

    expect(
      buildPromptPackSessionPrefsOverride(
        noToolsCoworkProfile,
        "Analyze the decision from 3 perspectives: CTO, VP Sales, and Developer Relations. End with one synthesized recommendation.",
      ),
    ).toMatchObject({
      orchestrationEnabled: false,
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
      orchestrationEnabled: false,
      orchestrationVisibility: "explicit",
      orchestrationParallelism: "sequential",
      toolAutonomy: "safe_auto",
    });

    expect(
      buildPromptPackSessionPrefsOverride(
        codeProfile,
        "Read fixtures/prompt-pack-workspace/package.json using file tools.",
      ),
    ).toMatchObject({
      webMode: "off",
      memoryMode: "off",
    });

    expect(
      buildPromptPackSessionPrefsOverride(
        codeProfile,
        "Read package.json using file tools, then use browser.search to check the latest versions.",
      ),
    ).toMatchObject({
      webMode: "auto",
      memoryMode: "off",
    });

    const coworkProfile = resolvePromptPackExecutionProfile({
      test: {
        testId: "test-cowork-explicit-2",
        packId: "pack-1",
        code: "TEST-06",
        title: "Cowork Explicit Tools",
        prompt: "Read local files using file/code tools and produce a role-labeled review.",
        orderIndex: 2,
        mode: "cowork",
        toolTier: "explicit-tools",
        createdAt: "2026-03-14T00:00:00.000Z",
      },
    });
    expect(buildPromptPackSessionPrefsOverride(coworkProfile)).toMatchObject({
      mode: "cowork",
      orchestrationEnabled: false,
      orchestrationVisibility: "explicit",
      orchestrationParallelism: "sequential",
      toolAutonomy: "safe_auto",
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
      "fs.list",
      "fs.stat",
      "file.read_range",
      "file.find",
      "code.search",
      "code.search_files",
      "tests.run",
      "lint.run",
    ]);

    expect(
      buildPromptPackSessionToolAllowlist(
        codeProfile,
        "Run pnpm test and capture the command output before summarizing the repo state.",
      ),
    ).toEqual([
      "fs.read",
      "fs.list",
      "fs.stat",
      "file.read_range",
      "file.find",
      "code.search",
      "code.search_files",
      "tests.run",
      "lint.run",
      "shell.exec",
    ]);

    const coworkProfile = resolvePromptPackExecutionProfile({
      test: {
        testId: "test-cowork-tools",
        packId: "pack-1",
        code: "TEST-TOOLS-02",
        title: "Cowork Tools",
        prompt:
          "Read fixtures/prompt-pack-workspace/package.json using file tools, then use browser.search to compare versions.",
        orderIndex: 1,
        mode: "cowork",
        toolTier: "explicit-tools",
        createdAt: "2026-03-14T00:00:00.000Z",
      },
    });
    expect(
      buildPromptPackSessionToolAllowlist(
        coworkProfile,
        "Read fixtures/prompt-pack-workspace/package.json using file tools, then use browser.search to compare versions.",
      ),
    ).toEqual([
      "fs.read",
      "fs.list",
      "fs.stat",
      "file.read_range",
      "file.find",
      "code.search",
      "code.search_files",
      "browser.search",
    ]);

    expect(
      buildPromptPackSessionToolAllowlist(
        coworkProfile,
        "Use session.status, time.now, git.status, build.run, browser.context.configure, and browser.cookies.get, then explain what worked.",
      ),
    ).toEqual([
      "session.status",
      "time.now",
      "build.run",
      "git.status",
      "browser.cookies.get",
      "browser.context.configure",
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

    expect(
      buildPromptPackSessionToolAllowlist(
        coworkProfile,
        "Use only file/code tools on fixtures/prompt-pack-workspace and produce an audit.",
      ),
    ).toEqual(
      expect.arrayContaining([
        "fs.read",
        "fs.list",
        "fs.stat",
        "file.read_range",
        "file.find",
        "code.search",
        "code.search_files",
      ]),
    );
  });

  it("builds path-scoped read grants for prompt-pack sessions", () => {
    const rootDir = "F:/code/personal-ai";
    const workspaceRoot = "F:/code/personal-ai/workspace";
    expect(
      buildPromptPackSessionAllowedPaths({
        prompt: "Based on the current GoatCitadel repo, inspect apps/gateway/src/services/prompt-pack-service.ts.",
        rootDir,
        workspaceRoot,
        projectWorkspacePath: "__prompt_pack_repo__",
      }),
    ).toEqual(
      expect.arrayContaining([
        "F:\\code\\personal-ai",
        "F:\\code\\personal-ai\\apps\\gateway\\src\\services\\prompt-pack-service.ts",
        "F:\\code\\personal-ai\\apps\\gateway\\src\\services",
      ]),
    );

    expect(
      buildPromptPackSessionAllowedPaths({
        prompt: [
          "Read these files using file/code tools:",
          "- `F:/code/sql-teacher/lib/db/sandbox.ts`",
          "- `F:/code/sql-teacher/lib/db/security.ts`",
        ].join("\n"),
        rootDir,
        workspaceRoot,
      }),
    ).toEqual(
      expect.arrayContaining([
        "F:\\code\\sql-teacher\\lib\\db\\sandbox.ts",
        "F:\\code\\sql-teacher\\lib\\db",
        "F:\\code\\sql-teacher\\lib\\db\\security.ts",
      ]),
    );

    expect(
      buildPromptPackSessionAllowedPaths({
        prompt: "Use only file/code tools on fixtures/prompt-pack-workspace to inspect package.json.",
        rootDir,
        workspaceRoot,
        projectWorkspacePath: "fixtures/prompt-pack-workspace",
      }),
    ).toEqual(
      expect.arrayContaining([
        "F:\\code\\personal-ai\\workspace\\fixtures\\prompt-pack-workspace",
        "F:\\code\\personal-ai\\workspace\\fixtures\\prompt-pack-workspace\\fixtures\\prompt-pack-workspace",
      ]),
    );
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
    expect(coworkInput.prompt).toContain("Do not grade, critique, review, or revise an imagined draft");

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
    expect(codeInput.prompt).toContain("Do not say `based on my inspection`");
    expect(codeInput.prompt).toContain(
      "Do not claim validation or execution unless you include the exact command/check and the result.",
    );
    expect(codeInput.prompt).toContain("Do not name scripts, frameworks, folders, or commands by convention alone.");
    expect(codeInput.prompt).toContain("separate Observed, Inferred, and Unverified statements");
    expect(codeInput.prompt).toContain("Do not claim commands such as `pnpm outdated`");

    const explicitToolsProfile = resolvePromptPackExecutionProfile({
      test: {
        testId: "test-explicit-contract",
        packId: "pack-1",
        code: "TEST-CONTRACT-03",
        title: "Explicit Tools Contract",
        prompt: "Read package.json using file/code tools, then use browser.search to compare versions.",
        orderIndex: 2,
        mode: "chat",
        toolTier: "explicit-tools",
        createdAt: "2026-03-14T00:00:00.000Z",
      },
    });
    const explicitToolsInput = buildPromptPackPromptInput(
      "Read package.json using file/code tools, then use browser.search to compare versions.",
      explicitToolsProfile,
    );
    expect(explicitToolsInput.prompt).toContain("This is an explicit-tools evaluation");
    expect(explicitToolsInput.prompt).toContain(
      "Before drafting findings or recommendations, execute the required tool calls",
    );
    expect(explicitToolsInput.prompt).toContain("Required named tools: `browser.search`");
    expect(explicitToolsInput.prompt).toContain("Required tool families: file/code tools");
    expect(explicitToolsInput.prompt).toContain("Surface tool-backed evidence in the answer.");
    expect(explicitToolsInput.prompt).toContain(
      "A prose-only answer without the required tool evidence is non-compliant.",
    );
    expect(explicitToolsInput.prompt).toContain(
      "If a file/code read is truncated, partial, blocked, or unexpectedly sparse, continue with narrower range reads",
    );
    expect(explicitToolsInput.prompt).toContain("do not write `based on my inspection`");
    expect(explicitToolsInput.prompt).toContain(
      "If local file paths are listed, inspect those paths before answering.",
    );

    const implicitRepoChatProfile = resolvePromptPackExecutionProfile({
      test: {
        testId: "test-chat-repo-contract",
        packId: "pack-1",
        code: "TEST-CONTRACT-03B",
        title: "Repo Chat Contract",
        prompt: "Inspect the repo if needed and explain what is currently loaded today.",
        orderIndex: 3,
        mode: "chat",
        toolTier: "implicit-tools",
        createdAt: "2026-03-14T00:00:00.000Z",
      },
    });
    const implicitRepoChatInput = buildPromptPackPromptInput(
      "Inspect the repo if needed and explain what is currently loaded today.",
      implicitRepoChatProfile,
    );
    expect(implicitRepoChatInput.prompt).toContain("This is a repo-grounded chat evaluation.");
    expect(implicitRepoChatInput.prompt).toContain("Repo inspection assist: enabled.");
    expect(implicitRepoChatInput.prompt).toContain("separate Observed, Inferred, and Unverified claims");

    const explicitCodeProfile = resolvePromptPackExecutionProfile({
      test: {
        testId: "test-code-explicit-contract",
        packId: "pack-1",
        code: "TEST-CONTRACT-04",
        title: "Explicit Code Contract",
        prompt:
          "Read all source files in fixtures/prompt-pack-workspace/ using file tools, then produce an audit report.",
        orderIndex: 3,
        mode: "code",
        toolTier: "explicit-tools",
        createdAt: "2026-03-14T00:00:00.000Z",
      },
    });
    const explicitCodeInput = buildPromptPackPromptInput(
      "Read all source files in fixtures/prompt-pack-workspace/ using file tools, then produce an audit report.",
      explicitCodeProfile,
    );
    expect(explicitCodeInput.prompt).toContain("Prefer file/code tools for read-only inspection or audits.");
    expect(explicitCodeInput.prompt).toContain(
      "Do not use `shell.exec` unless the prompt explicitly requires command execution or a shell-only check.",
    );
    expect(explicitCodeInput.prompt).toContain(
      "Available file/code tools in this run include `fs.read`, `fs.list`, `fs.stat`, `file.read_range`, `file.find`, `code.search`, and `code.search_files`.",
    );
    expect(explicitCodeInput.prompt).toContain(
      "Keep file/code reads inside the prompt-listed scope unless another path is explicitly required",
    );

    const exactSectionCoworkProfile = resolvePromptPackExecutionProfile({
      test: {
        testId: "test-cowork-contract",
        packId: "pack-1",
        code: "TEST-CONTRACT-05",
        title: "Cowork Contract",
        prompt: [
          "Assess whether to adopt event sourcing for a billing system.",
          "Weigh architecture impact, finance/compliance implications, and incident-response tradeoffs.",
          "Only the controller should speak in the final answer.",
          "Output exactly these sections in this order:",
          "- Status Snapshot",
          "- Final Recommendation",
        ].join("\n"),
        orderIndex: 4,
        mode: "cowork",
        toolTier: "explicit-tools",
        createdAt: "2026-03-14T00:00:00.000Z",
      },
    });
    const exactSectionCoworkInput = buildPromptPackPromptInput(
      [
        "Assess whether to adopt event sourcing for a billing system.",
        "Weigh architecture impact, finance/compliance implications, and incident-response tradeoffs.",
        "Only the controller should speak in the final answer.",
        "Output exactly these sections in this order:",
        "- Status Snapshot",
        "- Final Recommendation",
        "",
        "Use browser.interact and http.post if needed.",
      ].join("\n"),
      exactSectionCoworkProfile,
    );
    expect(exactSectionCoworkInput.prompt).toContain(
      "Output exactly these top-level sections in this order: `Status Snapshot`, `Final Recommendation`.",
    );
    expect(exactSectionCoworkInput.prompt).toContain(
      "Cover exactly these named perspectives/lenses: `architecture impact`, `finance/compliance implications`, `incident-response tradeoffs`.",
    );
    expect(exactSectionCoworkInput.prompt).toContain(
      "Use each named perspective/lens verbatim as its own compact subsection before the final recommendation.",
    );
    expect(exactSectionCoworkInput.prompt).toContain("Keep the final answer controller-owned.");
    expect(exactSectionCoworkInput.prompt).toContain("For `browser.interact`, send an explicit `steps` array.");
  });

  it("derives exact cowork role order from title metadata when the prompt only references the requested order", () => {
    const profile = resolvePromptPackExecutionProfile({
      test: {
        testId: "test-cowork-title-roles",
        packId: "pack-1",
        code: "TEST-W101",
        title: "Roles in order Product, Architect, QA",
        prompt:
          "Create a short role-labeled plan for how GoatCitadel prompt-pack v2 should test recently added functionality without repeating the old 108-test balance. Keep the sections in the requested role order.",
        orderIndex: 5,
        mode: "cowork",
        toolTier: "no-tools",
        createdAt: "2026-03-14T00:00:00.000Z",
      },
    });

    const promptInput = buildPromptPackPromptInput(
      "Create a short role-labeled plan for how GoatCitadel prompt-pack v2 should test recently added functionality without repeating the old 108-test balance. Keep the sections in the requested role order.",
      profile,
      "Roles in order Product, Architect, QA",
    );

    expect(promptInput.prompt).toContain(
      "Output exactly these top-level sections in this order: `Product`, `Architect`, `QA`, `Synthesis`.",
    );
    expect(promptInput.prompt).toContain("Do not add extra headings before, between, or after those sections.");
  });

  it("does not append synthesis when the prompt says to keep the requested role order only", () => {
    const profile = resolvePromptPackExecutionProfile({
      test: {
        testId: "test-cowork-title-roles-only",
        packId: "pack-1",
        code: "TEST-W125",
        title: "Roles in order Product, QA",
        prompt:
          "Create role-labeled sections for a qwen-specific no-tools slice that tests strict section discipline, no extra headings, and uncertainty labeling. Keep the requested role order only.",
        orderIndex: 6,
        mode: "cowork",
        toolTier: "no-tools",
        createdAt: "2026-03-14T00:00:00.000Z",
      },
    });

    const promptInput = buildPromptPackPromptInput(
      "Create role-labeled sections for a qwen-specific no-tools slice that tests strict section discipline, no extra headings, and uncertainty labeling. Keep the requested role order only.",
      profile,
      "Roles in order Product, QA",
    );

    expect(promptInput.prompt).toContain("Output exactly these top-level sections in this order: `Product`, `QA`.");
    expect(promptInput.prompt).not.toContain("`Product`, `QA`, `Synthesis`");
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
        runModel: "kimi-k2.5",
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

  it("prefers the latest run when auto-score selection has no explicit run id", () => {
    const latestFailed: PromptPackRunRecord = {
      ...createRun("run-latest-failed", "failed", "2026-03-14T00:10:00.000Z"),
      testId: "test-1",
    };
    const olderCompleted: PromptPackRunRecord = {
      ...createRun("run-older-completed", "completed", "2026-03-13T00:10:00.000Z"),
      testId: "test-1",
    };

    expect(pickPromptPackAutoScoreRun([latestFailed, olderCompleted])?.runId).toBe("run-latest-failed");
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
      scorerVersion: "2026-04-09.1",
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
    expect(tests[0]?.prompt).toContain("F:/code/goatcitadel-arena/packages/engine/src/judge/rules-judge.ts");
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

function buildRepoExpansionPromptPackMarkdown(): string {
  return buildPromptPackMarkdown([
    {
      mode: "code",
      toolTier: "explicit-tools",
      tests: [
        {
          code: "TEST-D26",
          title: "Rules judge inspection",
          prompt:
            "Inspect F:/code/goatcitadel-arena/packages/engine/src/judge/rules-judge.ts and explain the minimal patch.",
        },
        { code: "TEST-D27", title: "Planner follow-up", prompt: "Review the repo-level planner follow-up flow." },
        { code: "TEST-D28", title: "Replay wiring", prompt: "Trace the replay benchmark wiring end to end." },
        { code: "TEST-D29", title: "Capability register", prompt: "Verify the capability register update path." },
        { code: "TEST-D30", title: "Approval resume", prompt: "Inspect the approval resume checkpoint path." },
        { code: "TEST-D31", title: "Storage boundary", prompt: "Check the storage repo usage for runtime state." },
        { code: "TEST-D32", title: "Regression guard", prompt: "Add the narrowest regression guard for this path." },
      ],
    },
    {
      mode: "cowork",
      toolTier: "explicit-tools",
      tests: [
        {
          code: "TEST-W31",
          title: "Role-labeled repo plan",
          prompt: "Roles in order: `Researcher`, `Architect`, `QA`. Produce a compact repo expansion validation plan.",
        },
        {
          code: "TEST-W32",
          title: "Operator rollout",
          prompt: "Coordinate the rollout checklist for the repo expansion lane.",
        },
      ],
    },
  ]);
}

function buildCanonicalMergedPromptPackMarkdown(): string {
  return buildPromptPackMarkdown([
    {
      mode: "chat",
      toolTier: "no-tools",
      tests: [
        ...Array.from({ length: 35 }, (_, index) => createPromptPackFixture(`TEST-C${padPromptPackCode(index + 1)}`)),
        createPromptPackFixture("TEST-D27"),
      ],
    },
    {
      mode: "cowork",
      toolTier: "explicit-tools",
      tests: Array.from({ length: 36 }, (_, index) => createPromptPackFixture(`TEST-W${padPromptPackCode(index + 1)}`)),
    },
    {
      mode: "code",
      toolTier: "explicit-tools",
      tests: [
        ...Array.from({ length: 9 }, (_, index) => createPromptPackFixture(`TEST-D${padPromptPackCode(index + 1)}`)),
        ...Array.from({ length: 27 }, (_, index) => createPromptPackFixture(`TEST-T${padPromptPackCode(index + 1)}`)),
      ],
    },
  ]);
}

function buildFocusedV2PromptPackMarkdown(): string {
  return buildPromptPackMarkdown([
    {
      mode: "chat",
      toolTier: "no-tools",
      tests: Array.from({ length: 32 }, (_, index) => {
        const codeNumber = 101 + index;
        const code = `TEST-C${codeNumber}`;
        if (code === "TEST-C121") {
          return createPromptPackFixture(code, "Trace the memory routes and explain the highest-signal regression.");
        }
        return createPromptPackFixture(code);
      }),
    },
    {
      mode: "cowork",
      toolTier: "explicit-tools",
      tests: Array.from({ length: 32 }, (_, index) => {
        const codeNumber = 101 + index;
        const code = `TEST-W${codeNumber}`;
        if (code === "TEST-W111") {
          return createPromptPackFixture(
            code,
            "Inspect skill-import-service.ts and explain the operator-facing import path.",
          );
        }
        if (code === "TEST-W130") {
          return createPromptPackFixture(code, "Audit judge target selection across the benchmark lane.");
        }
        return createPromptPackFixture(code);
      }),
    },
    {
      mode: "code",
      toolTier: "explicit-tools",
      tests: Array.from({ length: 32 }, (_, index) => {
        const codeNumber = 101 + index;
        const code = `TEST-D${codeNumber}`;
        if (code === "TEST-D110") {
          return createPromptPackFixture(
            code,
            "Review update-review-daily and explain the safest implementation path.",
          );
        }
        if (code === "TEST-D122") {
          return createPromptPackFixture(
            code,
            "Inspect run-prompt-pack-gates.ts and describe the release gate wiring.",
          );
        }
        if (code === "TEST-D132") {
          return createPromptPackFixture(
            code,
            "Measure wall-clock timing behavior and call out retry-sensitive drift.",
          );
        }
        return createPromptPackFixture(code);
      }),
    },
  ]);
}

function buildPromptPackMarkdown(
  sections: Array<{
    mode: "chat" | "cowork" | "code";
    toolTier: "no-tools" | "implicit-tools" | "explicit-tools";
    tests: Array<{ code: string; title: string; prompt: string }>;
  }>,
): string {
  return sections
    .map((section) =>
      [
        `# ${capitalizePromptPackMode(section.mode)}`,
        "",
        `## ${formatPromptPackToolTier(section.toolTier)}`,
        "",
        ...section.tests.flatMap((test) => [`### ${test.code}: ${test.title}`, "", test.prompt, ""]),
      ].join("\n"),
    )
    .join("\n");
}

function createPromptPackFixture(code: string, prompt?: string): { code: string; title: string; prompt: string } {
  return {
    code,
    title: `Fixture ${code}`,
    prompt: prompt ?? `Run the ${code} fixture and summarize the most important finding.`,
  };
}

function padPromptPackCode(value: number): string {
  return value.toString().padStart(2, "0");
}

function capitalizePromptPackMode(mode: "chat" | "cowork" | "code"): string {
  return mode.charAt(0).toUpperCase() + mode.slice(1);
}

function formatPromptPackToolTier(toolTier: "no-tools" | "implicit-tools" | "explicit-tools"): string {
  if (toolTier === "no-tools") {
    return "No Tools";
  }
  if (toolTier === "implicit-tools") {
    return "Implicit Tools";
  }
  return "Explicit Tools";
}

function createScore(scoreId: string, runId: string, createdAt: string, value: 0 | 1 | 2): PromptPackScoreRecord {
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

function createRun(runId: string, status: PromptPackRunRecord["status"], finishedAt: string): PromptPackRunRecord {
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

function createTest(testId: string, code: string): PromptPackTestRecord {
  return {
    testId,
    packId: "pack-1",
    code,
    title: code,
    prompt: `Prompt for ${code}`,
    orderIndex: 0,
    mode: "chat",
    toolTier: "implicit-tools",
    createdAt: "2026-03-14T00:00:00.000Z",
  };
}

function createTrace(
  sessionId: string,
  overrides?: Partial<NonNullable<PromptPackRunRecord["trace"]>>,
): NonNullable<PromptPackRunRecord["trace"]> {
  return {
    turnId: `turn-${sessionId}`,
    sessionId,
    userMessageId: `user-${sessionId}`,
    branchKind: "append",
    status: "completed",
    mode: "chat",
    webMode: "off",
    memoryMode: "off",
    thinkingLevel: "standard",
    startedAt: "2026-03-14T00:00:00.000Z",
    finishedAt: "2026-03-14T00:00:01.000Z",
    toolRuns: [],
    citations: [],
    routing: {},
    ...overrides,
  };
}
