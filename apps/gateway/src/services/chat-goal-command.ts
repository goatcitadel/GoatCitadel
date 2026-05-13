import type { ChatDelegationStepRecord, ChatMode, LearnedMemoryItemRecord } from "@goatcitadel/contracts";

export interface ChatGoalCommandDependencies {
  extractAndPersistLearnedMemory(
    sessionId: string,
    content: string,
    source: { role: "user" | "assistant"; sourceRef: string },
  ): void;
  getSession(sessionId: string): unknown;
  listChatSessionLearnedMemory(
    sessionId: string,
    limit?: number,
  ): { items: LearnedMemoryItemRecord[]; conflicts: unknown[] };
  runChatDelegation(
    sessionId: string,
    input: {
      objective: string;
      roles: string[];
      mode: "sequential";
      surfaceMode?: ChatMode;
      steps?: Array<{
        stepId: string;
        index: number;
        role: string;
        dependsOnStepIds?: string[];
      }>;
    },
  ): Promise<{ runId: string; taskId?: string; steps: ChatDelegationStepRecord[]; stitchedOutput?: string }>;
  updateChatSessionLearnedMemory(
    sessionId: string,
    itemId: string,
    input: { status?: "active" | "superseded" | "disabled"; content?: string; confidence?: number },
  ): LearnedMemoryItemRecord;
}

type GoalCommandAction = "status" | "pause" | "resume" | "clear" | "run";

interface GoalLoopOptions {
  maxIterations: number;
  budgetUsd: number;
  surfaceMode: ChatMode;
}

interface ParsedGoalCommand {
  action: GoalCommandAction;
  objective: string;
  options: GoalLoopOptions;
}

interface GoalLoopIteration {
  iteration: number;
  runId: string;
  taskId?: string;
  verdict: "pass" | "fail" | "unknown" | "blocked";
  reason?: string;
  costUsd: number;
}

interface GoalLoopResult {
  ok: boolean;
  objective: string;
  stopReason: "goal_hit" | "iteration_cap" | "budget_cap" | "blocked";
  iterations: GoalLoopIteration[];
  totalCostUsd: number;
  maxIterations: number;
  budgetUsd: number;
  latestOutput?: string;
}

const GOAL_LOOP_ITERATION_TIMEOUT_MS = 5 * 60 * 1000;
const LEGACY_RESUME_GOAL_OPTIONS: GoalLoopOptions = {
  maxIterations: 1,
  budgetUsd: 0.5,
  surfaceMode: "code",
};
const activeGoalLoopSessionIds = new Set<string>();

export async function handleGoalCommand(
  deps: ChatGoalCommandDependencies,
  sessionId: string,
  args: string[],
): Promise<{ ok: boolean; message: string }> {
  const parsedGoal = parseGoalCommandArgs(args);
  if (parsedGoal.action === "status") {
    return {
      ok: true,
      message: formatGoalMemoryList(deps.listChatSessionLearnedMemory(sessionId, 200).items),
    };
  }
  if (parsedGoal.action === "pause" || parsedGoal.action === "clear") {
    const goals = listGoalMemoryItems(deps.listChatSessionLearnedMemory(sessionId, 200).items);
    const targets =
      parsedGoal.action === "pause"
        ? goals.filter((item) => item.status === "active" || item.status === "conflict")
        : goals.filter((item) => item.status !== "disabled");
    for (const item of targets) {
      deps.updateChatSessionLearnedMemory(sessionId, item.itemId, { status: "disabled" });
    }
    return {
      ok: true,
      message:
        targets.length === 0
          ? `No ${parsedGoal.action === "pause" ? "active" : "stored"} session goals to ${parsedGoal.action}.`
          : `${parsedGoal.action === "pause" ? "Paused" : "Cleared"} ${targets.length} session goal(s).`,
    };
  }

  let objective = parsedGoal.objective;
  let loopOptions = parsedGoal.options;
  let shouldPersistGoalMemory = true;
  if (activeGoalLoopSessionIds.has(sessionId)) {
    return {
      ok: false,
      message: "A /goal loop is already running for this session. Wait for it to finish before starting another.",
    };
  }
  if (parsedGoal.action === "resume") {
    const paused = listGoalMemoryItems(deps.listChatSessionLearnedMemory(sessionId, 200).items).find(
      (item) => item.status === "disabled",
    );
    if (!paused) {
      return { ok: false, message: "No paused session goal found to resume." };
    }
    deps.updateChatSessionLearnedMemory(sessionId, paused.itemId, { status: "active" });
    const storedGoal = parseStoredGoalMemory(paused.content);
    objective = storedGoal.objective;
    loopOptions = storedGoal.options ?? { ...LEGACY_RESUME_GOAL_OPTIONS, surfaceMode: parsedGoal.options.surfaceMode };
    shouldPersistGoalMemory = false;
  }
  if (!objective) {
    return {
      ok: false,
      message:
        "Usage: /goal Complete [objective] without stopping until [verifiable end state]. Optional: --max-iterations 3 --budget-usd 3",
    };
  }

  activeGoalLoopSessionIds.add(sessionId);
  try {
    const loop = await runGoalLoop(deps, sessionId, objective, loopOptions, {
      persistGoalMemory: shouldPersistGoalMemory,
    });
    return {
      ok: loop.ok,
      message: formatGoalLoopResult(loop),
    };
  } finally {
    activeGoalLoopSessionIds.delete(sessionId);
  }
}

async function runGoalLoop(
  deps: ChatGoalCommandDependencies,
  sessionId: string,
  objective: string,
  options: GoalLoopOptions,
  runtimeOptions: { persistGoalMemory?: boolean } = {},
): Promise<GoalLoopResult> {
  if (runtimeOptions.persistGoalMemory !== false) {
    deps.extractAndPersistLearnedMemory(sessionId, serializeGoalMemory(objective, options), {
      role: "user",
      sourceRef: "chat-command:/goal",
    });
  }

  const iterations: GoalLoopIteration[] = [];
  const seenChildSessions = new Set<string>();
  let latestOutput: string | undefined;
  let totalCostUsd = 0;
  let consecutiveUnknownVerdicts = 0;

  for (let index = 0; index < options.maxIterations; index += 1) {
    if (totalCostUsd >= options.budgetUsd) {
      return buildLoopResult(false, objective, "budget_cap", iterations, totalCostUsd, options, latestOutput);
    }

    const iteration = index + 1;
    let response: Awaited<ReturnType<ChatGoalCommandDependencies["runChatDelegation"]>>;
    try {
      response = await withGoalLoopTimeout(
        deps.runChatDelegation(sessionId, {
          objective: buildGoalIterationObjective({
            objective,
            iteration,
            maxIterations: options.maxIterations,
            previousVerifierOutput: latestOutput,
          }),
          roles: ["coder", "qa"],
          mode: "sequential",
          surfaceMode: options.surfaceMode,
          steps: [
            {
              stepId: `goal-${iteration}-implement`,
              index: 0,
              role: "coder",
            },
            {
              stepId: `goal-${iteration}-verify`,
              index: 1,
              role: "qa",
              dependsOnStepIds: [`goal-${iteration}-implement`],
            },
          ],
        }),
      );
    } catch (error) {
      return buildLoopResult(
        false,
        objective,
        "blocked",
        [
          ...iterations,
          {
            iteration,
            runId: "not-started",
            verdict: "blocked",
            reason: (error as Error).message,
            costUsd: 0,
          },
        ],
        totalCostUsd,
        options,
        latestOutput,
      );
    }

    const iterationCostUsd = estimateDelegationRunCostUsd(deps, response.steps, seenChildSessions);
    totalCostUsd += iterationCostUsd;
    const qaStep = [...response.steps].reverse().find((step) => step.role === "qa");
    latestOutput = qaStep?.output ?? response.stitchedOutput ?? latestOutput;
    const stepBlocked = response.steps.some((step) => step.status === "failed" || step.status === "skipped");
    const verdict = stepBlocked
      ? { status: "blocked" as const, reason: qaStep?.error }
      : parseGoalVerifierVerdict(latestOutput);
    if (verdict.status === "unknown") {
      consecutiveUnknownVerdicts += 1;
    } else {
      consecutiveUnknownVerdicts = 0;
    }
    iterations.push({
      iteration,
      runId: response.runId,
      taskId: response.taskId,
      verdict: verdict.status,
      reason: verdict.reason,
      costUsd: iterationCostUsd,
    });

    if (verdict.status === "pass") {
      return buildLoopResult(true, objective, "goal_hit", iterations, totalCostUsd, options, latestOutput);
    }
    if (verdict.status === "blocked" || consecutiveUnknownVerdicts >= 2) {
      return buildLoopResult(false, objective, "blocked", iterations, totalCostUsd, options, latestOutput);
    }
    if (totalCostUsd >= options.budgetUsd) {
      return buildLoopResult(false, objective, "budget_cap", iterations, totalCostUsd, options, latestOutput);
    }
  }

  return buildLoopResult(
    false,
    objective,
    totalCostUsd >= options.budgetUsd ? "budget_cap" : "iteration_cap",
    iterations,
    totalCostUsd,
    options,
    latestOutput,
  );
}

function buildLoopResult(
  ok: boolean,
  objective: string,
  stopReason: GoalLoopResult["stopReason"],
  iterations: GoalLoopIteration[],
  totalCostUsd: number,
  options: GoalLoopOptions,
  latestOutput?: string,
): GoalLoopResult {
  return {
    ok,
    objective,
    stopReason,
    iterations,
    totalCostUsd,
    maxIterations: options.maxIterations,
    budgetUsd: options.budgetUsd,
    latestOutput,
  };
}

function parseGoalCommandArgs(args: string[]): ParsedGoalCommand {
  const defaultOptions: GoalLoopOptions = {
    maxIterations: 3,
    budgetUsd: 3,
    surfaceMode: "code",
  };
  if (args.length === 0 || args[0]?.toLowerCase() === "list" || args[0]?.toLowerCase() === "status") {
    return { action: "status", objective: "", options: defaultOptions };
  }
  const first = args[0]?.toLowerCase();
  if ((first === "pause" || first === "resume" || first === "clear") && args.length === 1) {
    return { action: first, objective: "", options: defaultOptions };
  }
  if (first === "pause" || first === "resume" || first === "clear") {
    return { action: "run", objective: "", options: defaultOptions };
  }

  const objectiveParts: string[] = [];
  const options = { ...defaultOptions };
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index]!;
    const [flag, inlineValue] = arg.split("=", 2);
    if (flag === "--max-iterations" || flag === "--iterations") {
      const raw = inlineValue ?? args[++index];
      options.maxIterations = clampInteger(Number(raw), 1, 8, defaultOptions.maxIterations);
      continue;
    }
    if (flag === "--budget-usd" || flag === "--max-cost-usd" || flag === "--budget") {
      const raw = inlineValue ?? args[++index];
      options.budgetUsd = clampNumber(Number(raw), 0.01, 100, defaultOptions.budgetUsd);
      continue;
    }
    if (flag === "--surface") {
      const raw = (inlineValue ?? args[++index] ?? "").toLowerCase();
      if (raw === "chat" || raw === "cowork" || raw === "code") {
        options.surfaceMode = raw;
      }
      continue;
    }
    objectiveParts.push(arg);
  }
  return {
    action: "run",
    objective: objectiveParts.join(" ").trim(),
    options,
  };
}

function buildGoalIterationObjective(input: {
  objective: string;
  iteration: number;
  maxIterations: number;
  previousVerifierOutput?: string;
}): string {
  return [
    `Goal: ${input.objective}`,
    `Iteration: ${input.iteration}/${input.maxIterations}`,
    "",
    "Work loop:",
    "1. Implement the smallest safe change that advances the goal.",
    "2. Run the validation that proves progress, or identify the exact blocker if validation cannot run.",
    "3. Keep changes scoped to the goal and preserve existing project patterns.",
    "",
    "The qa step must decide whether the verifiable stopping condition is met.",
    "The qa final response must end with exact lines:",
    "GOAL_STATUS: pass|fail",
    "GOAL_REASON: <one sentence>",
    input.previousVerifierOutput ? `\nPrevious verifier output:\n${input.previousVerifierOutput.slice(0, 3000)}` : "",
  ]
    .filter(Boolean)
    .join("\n");
}

function parseGoalVerifierVerdict(output?: string): { status: GoalLoopIteration["verdict"]; reason?: string } {
  const text = output?.trim() ?? "";
  if (!text) {
    return { status: "unknown", reason: "Verifier returned no output." };
  }
  const statusMatch = text.match(/^GOAL_STATUS:\s*(pass|fail)\s*$/im);
  const reasonMatch = text.match(/^GOAL_REASON:\s*(.+)$/im);
  if (statusMatch?.[1]?.toLowerCase() === "pass") {
    return { status: "pass", reason: reasonMatch?.[1]?.trim() };
  }
  if (statusMatch?.[1]?.toLowerCase() === "fail") {
    return { status: "fail", reason: reasonMatch?.[1]?.trim() };
  }
  return { status: "unknown", reason: "Verifier did not emit GOAL_STATUS." };
}

function estimateDelegationRunCostUsd(
  deps: ChatGoalCommandDependencies,
  steps: ChatDelegationStepRecord[],
  seenChildSessions: Set<string>,
): number {
  let cost = 0;
  for (const step of steps) {
    if (!step.childSessionId || seenChildSessions.has(step.childSessionId)) {
      continue;
    }
    seenChildSessions.add(step.childSessionId);
    const session = deps.getSession(step.childSessionId) as { costUsdTotal?: unknown } | undefined;
    if (typeof session?.costUsdTotal === "number" && Number.isFinite(session.costUsdTotal)) {
      cost += Math.max(0, session.costUsdTotal);
    }
  }
  return roundCurrency(cost);
}

function formatGoalLoopResult(result: GoalLoopResult): string {
  const status =
    result.stopReason === "goal_hit"
      ? "Goal hit"
      : result.stopReason === "budget_cap"
        ? "Budget cap hit"
        : result.stopReason === "blocked"
          ? "Blocked"
          : "Iteration cap hit";
  const lines = [
    `${status}: ${result.objective}`,
    `Iterations: ${result.iterations.length}/${result.maxIterations}`,
    `Estimated cost: $${result.totalCostUsd.toFixed(4)} / $${result.budgetUsd.toFixed(2)}`,
    "",
    "Runs:",
    ...result.iterations.map((iteration) => {
      const reason = iteration.reason ? ` - ${iteration.reason}` : "";
      return `- ${iteration.iteration}: ${iteration.verdict} (${iteration.runId})${reason}`;
    }),
  ];
  if (result.latestOutput) {
    lines.push("", "Latest verifier output:", result.latestOutput.slice(0, 1200));
  }
  if (result.stopReason !== "goal_hit") {
    lines.push("", "Use /goal resume to continue the latest paused goal, or /goal clear to clear stored goals.");
  }
  return lines.join("\n");
}

function formatGoalMemoryList(items: LearnedMemoryItemRecord[]): string {
  const goals = listGoalMemoryItems(items);
  if (goals.length === 0) {
    return [
      "No session goals recorded.",
      "Usage: /goal Complete [objective] without stopping until [verifiable end state].",
    ].join("\n");
  }
  return [
    "Session goals:",
    ...goals.slice(0, 8).map((item) => {
      const confidence = Math.round(item.confidence * 100);
      return `- Goal: ${parseStoredGoalMemory(item.content).objective} [${item.status}, ${confidence}%, ${item.itemId.slice(0, 8)}]`;
    }),
  ].join("\n");
}

function listGoalMemoryItems(items: LearnedMemoryItemRecord[]): LearnedMemoryItemRecord[] {
  return items.filter((item) => item.itemType === "goal" && item.status !== "superseded" && item.status !== "dropped");
}

function stripGoalPrefix(value: string): string {
  return value.replace(/^goal:\s*/i, "").trim();
}

function serializeGoalMemory(objective: string, options: GoalLoopOptions): string {
  return [
    `Goal: ${objective}`,
    `GOAL_OPTIONS: maxIterations=${options.maxIterations}; budgetUsd=${options.budgetUsd}; surface=${options.surfaceMode}`,
  ].join("\n");
}

function parseStoredGoalMemory(content: string): { objective: string; options?: GoalLoopOptions } {
  const lines = content.split(/\r?\n/);
  const objective = stripGoalPrefix(lines[0] ?? content);
  const optionsLine = lines.find((line) => /^GOAL_OPTIONS:/i.test(line));
  if (!optionsLine) {
    return { objective };
  }
  const options = parseGoalOptionsLine(optionsLine);
  return options ? { objective, options } : { objective };
}

function parseGoalOptionsLine(line: string): GoalLoopOptions | undefined {
  const raw = line.replace(/^GOAL_OPTIONS:\s*/i, "");
  const fields = new Map(
    raw
      .split(";")
      .map((part) => part.trim().split("=", 2))
      .filter((part): part is [string, string] => Boolean(part[0]) && Boolean(part[1])),
  );
  const surfaceMode = fields.get("surface");
  return {
    maxIterations: clampInteger(Number(fields.get("maxIterations")), 1, 8, 3),
    budgetUsd: clampNumber(Number(fields.get("budgetUsd")), 0.01, 100, 3),
    surfaceMode: surfaceMode === "chat" || surfaceMode === "cowork" || surfaceMode === "code" ? surfaceMode : "code",
  };
}

async function withGoalLoopTimeout<T>(promise: Promise<T>): Promise<T> {
  let timeoutId: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timeoutId = setTimeout(() => reject(new Error("Goal-loop iteration timeout")), GOAL_LOOP_ITERATION_TIMEOUT_MS);
  });
  try {
    return await Promise.race([promise, timeout]);
  } finally {
    if (timeoutId) {
      clearTimeout(timeoutId);
    }
  }
}

function clampInteger(value: number, min: number, max: number, fallback: number): number {
  if (!Number.isFinite(value)) {
    return fallback;
  }
  return Math.max(min, Math.min(max, Math.trunc(value)));
}

function clampNumber(value: number, min: number, max: number, fallback: number): number {
  if (!Number.isFinite(value)) {
    return fallback;
  }
  return Math.max(min, Math.min(max, value));
}

function roundCurrency(value: number): number {
  return Math.round(value * 10000) / 10000;
}
