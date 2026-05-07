import { describe, expect, it, vi } from "vitest";

vi.mock("node:sqlite", () => ({
  DatabaseSync: class DatabaseSync {},
  StatementSync: class StatementSync {},
}));

import type { ChatProjectRecord } from "@goatcitadel/contracts";
import {
  PromptPackService,
  buildPromptPackSessionAllowedPaths,
  buildPromptPackSessionToolAllowlist,
  findPromptPackProjectBinding,
  buildPromptPackSessionPrefsOverride,
  buildPromptPackPromptInput,
  requiresPromptPackCitationEvidence,
  resolvePromptPackExecutionStyle,
  resolvePromptPackExecutionProfile,
  resolvePromptPackProjectBinding,
} from "./prompt-pack-service.js";

describe("prompt-pack grants, profiles, and allowlists", () => {
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
    const repoProject: ChatProjectRecord = {
      ...legacyProject,
      projectId: "repo-project",
      name: "Prompt Lab Repo",
      description: "Auto-created project binding for prompt-pack repo evaluations.",
      workspacePath: "__prompt_pack_repo__",
    };
    const externalProject: ChatProjectRecord = {
      ...legacyProject,
      projectId: "external-project",
      name: "Prompt Lab External Paths",
      description: "Auto-created project binding for prompt-pack evaluations with explicit external file paths.",
      workspacePath: "F:\\code",
    };

    expect(findPromptPackProjectBinding([legacyProject, repoProject])).toMatchObject({
      projectId: "legacy-project",
    });
    expect(findPromptPackProjectBinding([repoProject, legacyProject, currentProject])).toMatchObject({
      projectId: "current-project",
    });
    expect(findPromptPackProjectBinding([currentProject, legacyProject], "F:\\code")).toBeUndefined();
    expect(findPromptPackProjectBinding([currentProject, legacyProject, externalProject], "F:\\code")).toMatchObject({
      projectId: "external-project",
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

    const everydayCoworkProfile = resolvePromptPackExecutionProfile({
      test: {
        testId: "test-cowork-no-binding",
        packId: "pack-1",
        code: "TEST-BIND-02B",
        title: "Everyday Cowork",
        prompt:
          "Cowork request: Research whether a weekend farmers market is likely to be busy and help me plan when to arrive.",
        orderIndex: 2,
        mode: "cowork",
        toolTier: "implicit-tools",
        createdAt: "2026-03-21T00:00:00.000Z",
      },
    });

    expect(
      resolvePromptPackProjectBinding(
        everydayCoworkProfile,
        "Cowork request: Research whether a weekend farmers market is likely to be busy and help me plan when to arrive.",
      ),
    ).toBeUndefined();

    const implicitRepoChatProfile = resolvePromptPackExecutionProfile({
      test: {
        testId: "test-chat-binding",
        packId: "pack-1",
        code: "TEST-BIND-03",
        title: "Implicit Repo Chat Binding",
        prompt:
          "Inspect the repo if needed and explain what an operator should trust when realtime updates are degraded. Cite the exact files used.",
        orderIndex: 2,
        mode: "chat",
        toolTier: "implicit-tools",
        createdAt: "2026-03-21T00:00:00.000Z",
      },
    });

    expect(
      resolvePromptPackProjectBinding(
        implicitRepoChatProfile,
        "Inspect the repo if needed and explain what an operator should trust when realtime updates are degraded. Cite the exact files used.",
      )?.workspacePath,
    ).toBe("__prompt_pack_repo__");

    expect(
      resolvePromptPackProjectBinding(
        codeProfile,
        [
          "Using file/code tools, inspect these local files only:",
          "- `F:/code/sql-teacher/package.json`",
          "- `F:/code/card-identifier/README.md`",
        ].join("\n"),
        {
          rootDir: "F:/code/personal-ai",
          workspaceRoot: "F:/code/personal-ai/workspace",
        },
      ),
    ).toMatchObject({
      workspacePath: "F:\\code",
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

    expect(
      buildPromptPackSessionPrefsOverride(
        codeProfile,
        'Tools are available, but the user says: "Please do not look anything up." Answer without tools.',
      ),
    ).toMatchObject({
      toolAutonomy: "manual",
      webMode: "off",
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

    expect(resolvePromptPackExecutionStyle(undefined)).toBe("single_turn_harness");
    expect(resolvePromptPackExecutionStyle("agentic_surface")).toBe("agentic_surface");
    expect(resolvePromptPackExecutionStyle("unexpected")).toBe("single_turn_harness");
    expect(buildPromptPackSessionPrefsOverride(coworkProfile, "", "agentic_surface")).toMatchObject({
      mode: "cowork",
      orchestrationEnabled: true,
      orchestrationVisibility: "expandable",
      orchestrationParallelism: "parallel",
      toolAutonomy: "safe_auto",
    });

    const lightweightCoworkProfile = resolvePromptPackExecutionProfile({
      test: {
        testId: "test-lightweight-cowork",
        packId: "pack-1",
        code: "TEST-W406",
        title: "Cowork Lightweight",
        prompt:
          'Cowork request: "I might eventually want a plan for a birthday weekend, but for now just help me think of the first two questions."\n\nStay lightweight. Do not create a full workflow.',
        orderIndex: 3,
        mode: "cowork",
        toolTier: "no-tools",
        createdAt: "2026-03-14T00:00:00.000Z",
      },
    });
    expect(
      buildPromptPackSessionPrefsOverride(
        lightweightCoworkProfile,
        'Cowork request: "I might eventually want a plan for a birthday weekend, but for now just help me think of the first two questions."\n\nStay lightweight. Do not create a full workflow.',
        "agentic_surface",
      ),
    ).toMatchObject({
      mode: "cowork",
      orchestrationEnabled: false,
      orchestrationVisibility: "explicit",
      orchestrationParallelism: "sequential",
      toolAutonomy: "manual",
    });

    const toolChoiceCoworkProfile = resolvePromptPackExecutionProfile({
      test: {
        testId: "test-tool-choice-cowork",
        packId: "pack-1",
        code: "TEST-W409",
        title: "Cowork Tool Choice",
        prompt:
          'Cowork request: "Help me decide between two possible names for a local discussion club: Open Table and Friday Circle."\n\nUse tools only if useful.',
        orderIndex: 4,
        mode: "cowork",
        toolTier: "implicit-tools",
        createdAt: "2026-03-14T00:00:00.000Z",
      },
    });
    expect(
      buildPromptPackSessionPrefsOverride(
        toolChoiceCoworkProfile,
        'Cowork request: "Help me decide between two possible names for a local discussion club: Open Table and Friday Circle."\n\nUse tools only if useful.',
        "agentic_surface",
      ),
    ).toMatchObject({
      mode: "cowork",
      orchestrationEnabled: false,
      orchestrationVisibility: "explicit",
      orchestrationParallelism: "sequential",
      toolAutonomy: "safe_auto",
    });

    const robotVacuumCoworkPrompt =
      "I need a low-maintenance robot vacuum for a small apartment with one pet. Compare what criteria matter most before buying.\n\nUse current information if available. Do not invent prices or availability.";
    const robotVacuumCoworkProfile = resolvePromptPackExecutionProfile({
      test: {
        testId: "test-v5-robot-vacuum-cowork",
        packId: "pack-1",
        code: "TEST-W506",
        title: "Cowork Robot Vacuum",
        prompt: robotVacuumCoworkPrompt,
        orderIndex: 5,
        mode: "cowork",
        toolTier: "implicit-tools",
        createdAt: "2026-05-05T00:00:00.000Z",
      },
    });
    expect(
      buildPromptPackSessionPrefsOverride(robotVacuumCoworkProfile, robotVacuumCoworkPrompt, "agentic_surface"),
    ).toMatchObject({
      mode: "cowork",
      orchestrationEnabled: false,
      orchestrationVisibility: "explicit",
      orchestrationParallelism: "sequential",
      toolAutonomy: "safe_auto",
    });

    expect(
      buildPromptPackSessionToolAllowlist(
        resolvePromptPackExecutionProfile({
          test: {
            testId: "test-v5-memory-chat",
            packId: "pack-1",
            code: "TEST-C510",
            title: "Chat Memory",
            prompt:
              "Use available memory/context to tell me whether I have previously preferred concise or detailed project reviews.",
            orderIndex: 6,
            mode: "chat",
            toolTier: "explicit-tools",
            createdAt: "2026-05-05T00:00:00.000Z",
          },
        }),
        "Use available memory/context to tell me whether I have previously preferred concise or detailed project reviews.",
      ),
    ).toEqual(expect.arrayContaining(["memory.search", "memory.read"]));
    expect(
      buildPromptPackSessionToolAllowlist(
        resolvePromptPackExecutionProfile({
          test: {
            testId: "test-v5-live-weather-chat",
            packId: "pack-1",
            code: "TEST-C512",
            title: "Chat Live Weather",
            prompt:
              "Use live information if available to recommend whether I should bring an umbrella for a walk in Boston this evening.",
            orderIndex: 7,
            mode: "chat",
            toolTier: "explicit-tools",
            createdAt: "2026-05-05T00:00:00.000Z",
          },
        }),
        "Use live information if available to recommend whether I should bring an umbrella for a walk in Boston this evening.",
      ),
    ).toEqual(expect.arrayContaining(["browser.search", "browser.navigate", "browser.extract"]));
  });

  it("resumes stale benchmark runs when status is requested", () => {
    const service = Object.create(PromptPackService.prototype) as PromptPackService & Record<string, unknown>;
    const staleRun = {
      benchmark_run_id: "ppb-stale",
      pack_id: "pack-1",
      status: "running",
      test_codes_json: "[]",
      providers_json: "[]",
      total_items: 54,
      completed_items: 54,
      claimed_by_worker_id: "old-worker",
      claim_heartbeat_at: "2000-01-01T00:00:00.000Z",
      claim_expires_at: "2000-01-01T00:01:00.000Z",
      execution_style: "single_turn_harness",
      error: null,
      started_at: "2026-03-16T00:00:00.000Z",
      finished_at: null,
    };
    service.getPromptPackBenchmarkRunRow = vi.fn(() => staleRun);
    service.listPromptPackBenchmarkItems = vi.fn(() => []);
    service.enqueuePromptPackBenchmarkTask = vi.fn();

    const status = service.getPromptPackBenchmarkStatus("ppb-stale");

    expect(status.run.status).toBe("running");
    expect(status.progress.completedItems).toBe(54);
    expect(service.enqueuePromptPackBenchmarkTask).toHaveBeenCalledWith("ppb-stale");
  });

  it("does not resume actively claimed benchmark runs when status is requested", () => {
    const service = Object.create(PromptPackService.prototype) as PromptPackService & Record<string, unknown>;
    const activeRun = {
      benchmark_run_id: "ppb-active",
      pack_id: "pack-1",
      status: "running",
      test_codes_json: "[]",
      providers_json: "[]",
      total_items: 54,
      completed_items: 30,
      claimed_by_worker_id: "active-worker",
      claim_heartbeat_at: "2999-01-01T00:00:00.000Z",
      claim_expires_at: "2999-01-01T00:01:00.000Z",
      execution_style: "single_turn_harness",
      error: null,
      started_at: "2026-03-16T00:00:00.000Z",
      finished_at: null,
    };
    service.getPromptPackBenchmarkRunRow = vi.fn(() => activeRun);
    service.listPromptPackBenchmarkItems = vi.fn(() => []);
    service.enqueuePromptPackBenchmarkTask = vi.fn();

    const status = service.getPromptPackBenchmarkStatus("ppb-active");

    expect(status.run.status).toBe("running");
    expect(status.progress.completedItems).toBe(30);
    expect(service.enqueuePromptPackBenchmarkTask).not.toHaveBeenCalled();
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
      "browser.navigate",
      "browser.extract",
    ]);

    expect(
      buildPromptPackSessionToolAllowlist(
        coworkProfile,
        'Use web lookup to answer: "What are two current public safety tips for severe heat?" Provide a short answer, then a "Source used" line.',
      ),
    ).toEqual(["browser.search", "browser.navigate", "browser.extract"]);

    expect(
      buildPromptPackSessionToolAllowlist(
        coworkProfile,
        'The user asks: "Find one reliable source on whether the local museum is open late this Friday, then answer with the source." Use Chat style. If a lookup is available, cite exactly the source you used.',
      ),
    ).toEqual(["browser.search", "browser.navigate", "browser.extract"]);

    expect(
      buildPromptPackSessionToolAllowlist(
        coworkProfile,
        'Cowork request: "Research whether a weekend farmers market is likely to be busy and help me plan when to arrive." Use available tools if they are appropriate.',
      ),
    ).toEqual(["browser.search", "browser.navigate", "browser.extract"]);

    expect(
      buildPromptPackSessionToolAllowlist(
        coworkProfile,
        'Cowork request: "Find a plausible public venue for a small meetup and draft the decision path, but do not contact anyone." Use available lookup if appropriate.',
      ),
    ).toEqual(["browser.search", "browser.navigate", "browser.extract"]);

    expect(
      buildPromptPackSessionToolAllowlist(
        coworkProfile,
        'Cowork request: "Plan a low-stress evening routine for me based on what you know about my preferences." Use available memory or context if present.',
      ),
    ).toEqual(["memory.read", "memory.search"]);

    expect(
      buildPromptPackSessionToolAllowlist(
        coworkProfile,
        'Tools are available, but the user says: "Please do not look anything up. I only want a quick gut-check based on the details I typed." Answer without tools.',
      ),
    ).toEqual([]);

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

    const implicitRepoChatProfile = resolvePromptPackExecutionProfile({
      test: {
        testId: "test-chat-repo-tools",
        packId: "pack-1",
        code: "TEST-TOOLS-04",
        title: "Implicit Repo Chat Tools",
        prompt:
          "Inspect the repo if needed and explain what an operator should trust when realtime updates are degraded. Cite the exact files used.",
        orderIndex: 3,
        mode: "chat",
        toolTier: "implicit-tools",
        createdAt: "2026-03-14T00:00:00.000Z",
      },
    });
    expect(
      buildPromptPackSessionToolAllowlist(
        implicitRepoChatProfile,
        "Inspect the repo if needed and explain what an operator should trust when realtime updates are degraded. Cite the exact files used.",
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

    const implicitRepoCoworkProfile = resolvePromptPackExecutionProfile({
      test: {
        testId: "test-cowork-repo-tools",
        packId: "pack-1",
        code: "TEST-TOOLS-05",
        title: "Implicit Repo Cowork Tools",
        prompt:
          "Inspect the repo if needed and produce role-labeled sections describing paused versus waiting wake handling. Cite the exact files used.",
        orderIndex: 4,
        mode: "cowork",
        toolTier: "implicit-tools",
        createdAt: "2026-03-14T00:00:00.000Z",
      },
    });
    expect(
      buildPromptPackSessionToolAllowlist(
        implicitRepoCoworkProfile,
        "Inspect the repo if needed and produce role-labeled sections describing paused versus waiting wake handling. Cite the exact files used.",
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
        prompt: [
          "Read these files using file/code tools:",
          "- `F:/code/sql-teacher/lib/db/sandbox.ts`",
          "- `F:/code/sql-teacher/lib/db/security.ts`",
        ].join("\n"),
        rootDir,
        workspaceRoot,
        projectWorkspacePath: "F:/code",
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
        prompt: [
          "Read these files using file/code tools:",
          "- `F:/code/sql-teacher/lib/db/sandbox.ts`",
          "- `F:/code/sql-teacher/lib/db/security.ts`",
        ].join("\n"),
        rootDir,
        workspaceRoot,
        projectWorkspacePath: "F:/code",
      }),
    ).not.toContain("F:\\code");

    expect(
      buildPromptPackSessionAllowedPaths({
        prompt: "Use only file/code tools on fixtures/prompt-pack-workspace to inspect package.json.",
        rootDir,
        workspaceRoot,
        projectWorkspacePath: "fixtures/prompt-pack-workspace",
      }),
    ).toEqual(expect.arrayContaining(["F:\\code\\personal-ai\\workspace\\fixtures\\prompt-pack-workspace"]));
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
    expect(coworkInput.prompt).toContain("Planner, Researcher, Risk Review, Operator Handoff, or Synthesis");
    expect(coworkInput.prompt).toContain("Do not default to Coder, Architect, QA, Ops");
    expect(coworkInput.prompt).toContain("Keep role sections distinct");
    expect(coworkInput.prompt).toContain("Do not repeat the same bullets across multiple role sections");
    expect(coworkInput.prompt).toContain("Do not mention repo paths, source files, tool traces");
    expect(coworkInput.prompt).toContain("Do not grade, critique, review, or revise an imagined draft");

    const coworkNamedSectionsInput = buildPromptPackPromptInput(
      "Produce a multi-role decision brief with sections for Members, Organizer, and Risk Review, then give a single recommendation.",
      coworkProfile,
    );
    expect(coworkNamedSectionsInput.prompt).toContain(
      "Output exactly these top-level sections in this order: `Members`, `Organizer`, `Risk Review`, `Synthesis`.",
    );
    expect(coworkNamedSectionsInput.prompt).not.toContain("Coder, Architect, QA, Ops");

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
    expect(codeInput.prompt).toContain("Because tools are disabled, do not invent repo-native file paths");
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

    const noLookupExplicitInput = buildPromptPackPromptInput(
      [
        'Tools are available, but the user says: "Please do not look anything up. I only want a quick gut-check based on the details I typed."',
        "",
        "Answer without tools. Give a concise gut-check and clearly label it as non-verified.",
      ].join("\n"),
      explicitToolsProfile,
    );
    expect(noLookupExplicitInput.prompt).toContain("explicitly forbids tool use. Do not call tools.");
    expect(noLookupExplicitInput.prompt).toContain("label any answer as non-verified");
    expect(noLookupExplicitInput.prompt).not.toContain("A prose-only answer without the required tool evidence");

    const plainWebLookupInput = buildPromptPackPromptInput(
      'Use web lookup to answer: "What are two current public safety tips for severe heat?" Provide a short answer, then a "Source used" line.',
      explicitToolsProfile,
    );
    expect(plainWebLookupInput.prompt).toContain("Required tool families: web lookup tools");
    expect(plainWebLookupInput.prompt).toContain("Available web tools in this run include `browser.search`");
    expect(plainWebLookupInput.prompt).not.toContain("Available file/code tools in this run");
    expect(plainWebLookupInput.prompt).not.toContain("If a file/code read is truncated");
    expect(plainWebLookupInput.prompt).not.toContain("exact patch points/assertions");

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

  it("preserves non-code cowork role order and avoids repo fallback roles", () => {
    const profile = resolvePromptPackExecutionProfile({
      test: {
        testId: "test-cowork-v4-role-order",
        packId: "pack-1",
        code: "TEST-W401",
        title: "Role order preservation",
        prompt:
          'Cowork request: "Use three roles in this order: Researcher, Product, Operator. Help me decide whether to host a small community workshop next month."',
        orderIndex: 5,
        mode: "cowork",
        toolTier: "no-tools",
        createdAt: "2026-03-14T00:00:00.000Z",
      },
    });

    const promptInput = buildPromptPackPromptInput(
      [
        'Cowork request: "Use three roles in this order: Researcher, Product, Operator. Help me decide whether to host a small community workshop next month."',
        "",
        "No tools are available. Produce role-labeled sections in the requested order, then end with one synthesized recommendation and one uncertainty to resolve.",
      ].join("\n"),
      profile,
    );

    expect(promptInput.prompt).toContain(
      "Output exactly these top-level sections in this order: `Researcher`, `Product`, `Operator`, `Synthesis`.",
    );
    expect(promptInput.prompt).toContain("Do not mention repo paths, source files, tool traces");
    expect(promptInput.prompt).not.toContain("file-specific evidence");
    expect(promptInput.prompt).not.toContain("repo-level claims");
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

  it("treats no-synthesis cowork prompts as exact requested-role order runs", () => {
    const profile = resolvePromptPackExecutionProfile({
      test: {
        testId: "test-cowork-no-synthesis",
        packId: "pack-1",
        code: "TEST-W103",
        title: "Roles in order Product, Ops",
        prompt:
          "Draft a role-labeled recovery plan for unstable prompt-pack baselines. Keep the sections in the requested order. Do not add a synthesis section.",
        orderIndex: 7,
        mode: "cowork",
        toolTier: "no-tools",
        createdAt: "2026-03-14T00:00:00.000Z",
      },
    });

    const promptInput = buildPromptPackPromptInput(
      "Draft a role-labeled recovery plan for unstable prompt-pack baselines. Keep the sections in the requested order. Do not add a synthesis section.",
      profile,
      "Roles in order Product, Ops",
    );

    expect(promptInput.prompt).toContain("Output exactly these top-level sections in this order: `Product`, `Ops`.");
    expect(promptInput.prompt).toContain(
      "Use only those top-level sections. Do not add Synthesis, Conclusion, Final Answer, Summary, or extra subheadings.",
    );
    expect(promptInput.prompt).not.toContain("`Product`, `Ops`, `Synthesis`");
  });

  it("adds a global length cap for no-tools requested-order cowork runs", () => {
    const profile = resolvePromptPackExecutionProfile({
      test: {
        testId: "test-cowork-length-cap",
        packId: "pack-1",
        code: "TEST-W102",
        title: "Roles in order Researcher, QA",
        prompt:
          "Produce role-labeled sections defining how GoatCitadel should score retrieval honesty when evidence is partial, stale, or contradictory. Keep the requested role order and do not add extra headings.",
        orderIndex: 7,
        mode: "cowork",
        toolTier: "no-tools",
        createdAt: "2026-03-14T00:00:00.000Z",
      },
    });

    const promptInput = buildPromptPackPromptInput(
      "Produce role-labeled sections defining how GoatCitadel should score retrieval honesty when evidence is partial, stale, or contradictory. Keep the requested role order and do not add extra headings.",
      profile,
      "Roles in order Researcher, QA",
    );

    expect(promptInput.prompt).toContain(
      "Keep the whole answer under about 220 words unless the prompt explicitly requires more detail.",
    );
  });

  it("tells explicit file/code runs not to search for output-contract labels literally", () => {
    const profile = resolvePromptPackExecutionProfile({
      test: {
        testId: "test-explicit-label-search-guard",
        packId: "pack-1",
        code: "TEST-C149",
        title: "Exact evidence for operator truth labeling",
        prompt:
          "Use file or code tools to inspect Mission Control approvals, runtime, and live-feed UI plus the related APIs. Cite the exact files used.",
        orderIndex: 8,
        mode: "chat",
        toolTier: "explicit-tools",
        createdAt: "2026-03-14T00:00:00.000Z",
      },
    });

    const promptInput = buildPromptPackPromptInput(
      "Use file or code tools to inspect Mission Control approvals, runtime, and live-feed UI plus the related APIs. Cite the exact files used.",
      profile,
    );

    expect(promptInput.prompt).toContain("Do not search the repo for the output-contract labels themselves");
    expect(promptInput.prompt).toContain(
      "After path discovery returns likely matches, read at least one concrete implementation file",
    );
    expect(promptInput.prompt).toContain(
      "For exact-evidence, exact-file, exact-patch-point, or exact-rollout-wiring asks, a pure path-discovery pass is not enough.",
    );
    expect(promptInput.prompt).toContain(
      "Do not stop after only `code.search_files` or `file.find` hits when the prompt asks for exact grounding.",
    );
  });

  it("only requires citation evidence when the prompt actually asks for file-grounded citations", () => {
    expect(requiresPromptPackCitationEvidence("Separate policy from implementation evidence.")).toBe(false);
    expect(requiresPromptPackCitationEvidence("Explain the result and cite the exact files used.")).toBe(true);
    expect(requiresPromptPackCitationEvidence("Include line numbers for each claim.")).toBe(true);
  });
});
