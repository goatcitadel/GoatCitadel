import fs from "node:fs";
import path from "node:path";
import { vi } from "vitest";

import type {
  PromptPackRecord,
  PromptPackRunRecord,
  PromptPackScoreRecord,
  PromptPackTestRecord,
} from "@goatcitadel/contracts";
import { PromptPackService } from "./prompt-pack-service.js";

export function readRepoFixture(fileName: string): string {
  const candidates = [
    path.resolve(process.cwd(), fileName),
    path.resolve(process.cwd(), "..", "..", fileName),
    path.resolve(process.cwd(), "..", "..", "..", fileName),
  ];
  const filePath = candidates.find((candidate) => fs.existsSync(candidate));
  if (!filePath) {
    throw new Error(`Fixture not found: ${fileName}`);
  }
  return fs.readFileSync(filePath, "utf8");
}

export function buildRepoExpansionPromptPackMarkdown(): string {
  return buildPromptPackMarkdown([
    {
      mode: "code",
      toolTier: "explicit-tools",
      tests: [
        {
          code: "TEST-D26",
          title: "Rules judge inspection",
          prompt: "Inspect goatcitadel-arena/packages/engine/src/judge/rules-judge.ts and explain the minimal patch.",
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

export function buildCanonicalMergedPromptPackMarkdown(): string {
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

export function buildFocusedV2PromptPackMarkdown(): string {
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

export function buildPromptPackMarkdown(
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

export function createPromptPackFixture(
  code: string,
  prompt?: string,
): { code: string; title: string; prompt: string } {
  return {
    code,
    title: `Fixture ${code}`,
    prompt: prompt ?? `Run the ${code} fixture and summarize the most important finding.`,
  };
}

export function padPromptPackCode(value: number): string {
  return value.toString().padStart(2, "0");
}

export function capitalizePromptPackMode(mode: "chat" | "cowork" | "code"): string {
  return mode.charAt(0).toUpperCase() + mode.slice(1);
}

export function formatPromptPackToolTier(toolTier: "no-tools" | "implicit-tools" | "explicit-tools"): string {
  if (toolTier === "no-tools") {
    return "No Tools";
  }
  if (toolTier === "implicit-tools") {
    return "Implicit Tools";
  }
  return "Explicit Tools";
}

export function createScore(
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

export function createRun(
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

export function createPromptPackExportService(input: {
  rootDir: string;
  pack: PromptPackRecord;
  tests: PromptPackTestRecord[];
  runs: PromptPackRunRecord[];
}): PromptPackService {
  return new PromptPackService(
    {
      storage: {
        promptPacks: {
          getPack: () => input.pack,
          listTests: () => input.tests,
        },
        promptPackRuns: {
          listByPack: () => input.runs,
          deleteByPack: () => input.runs.length,
        },
        promptPackScores: {
          listByPack: () => [],
          deleteByPack: () => 0,
        },
        promptPackAutoScoresV2: {
          listByPack: () => [],
          deleteByPack: () => 0,
        },
        promptPackHumanReviewsV2: {
          listByPack: () => [],
          deleteByPack: () => 0,
        },
      },
      gatewaySql: {
        runImmediateTransaction: (fn: () => void) => fn(),
      },
      config: {
        rootDir: input.rootDir,
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
}

export function createPack(packId: string): PromptPackRecord {
  return {
    packId,
    name: packId,
    testCount: 1,
    createdAt: "2026-05-05T00:00:00.000Z",
    updatedAt: "2026-05-05T00:00:00.000Z",
  };
}

export function createTest(testId: string, code: string): PromptPackTestRecord {
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

export function createTrace(
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
