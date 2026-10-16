import type { ModelComparisonPromptResult, ModelComparisonRun, PromptPackRunRecord } from "@goatcitadel/contracts";
import { ConflictError } from "@goatcitadel/contracts";
import type { ModelComparisonRoutePort } from "./model-comparison-route-service.js";
import {
  buildModelComparisonAdvisory,
  computeRunLatencyMs,
  type ModelComparisonService,
} from "./model-comparison-service.js";

export interface ModelComparisonRunStatePort {
  get(comparisonId: string): Promise<ModelComparisonRun>;
  updateStatus(
    comparisonId: string,
    update: {
      status: ModelComparisonRun["status"];
      updatedAt: string;
      completedAt?: string | null;
      error?: string | null;
    },
  ): Promise<ModelComparisonRun>;
  upsertResult(
    comparisonId: string,
    result: ModelComparisonPromptResult,
    updatedAt: string,
  ): Promise<ModelComparisonRun>;
}

export type ModelComparisonPromptPackRunner = (
  packId: string,
  testId: string,
  input: { providerId: string; model: string; signal: AbortSignal },
) => Promise<PromptPackRunRecord>;

export interface ModelComparisonExecutionServiceDependencies {
  repository: ModelComparisonRunStatePort;
  runPromptPackTest: ModelComparisonPromptPackRunner;
  onBackgroundError?: (comparisonId: string, error: unknown) => void;
  clock?: () => Date;
}

const COMPARISON_CONCURRENCY = 2;

interface ComparisonWorkItem {
  result: ModelComparisonPromptResult;
  providerId: string;
  model: string;
}

interface ActiveComparison {
  controller: AbortController;
  settled: Promise<void>;
}

/** Runs blind comparisons through the governed prompt-pack runner; one live executor per comparison. */
export class ModelComparisonExecutionService {
  private readonly active = new Map<string, ActiveComparison>();

  public constructor(private readonly deps: ModelComparisonExecutionServiceDependencies) {}

  public async startComparison(comparisonId: string): Promise<ModelComparisonRun> {
    if (this.active.has(comparisonId)) {
      throw new ConflictError({ message: "Comparison is already running." });
    }
    const controller = new AbortController();
    let markSettled!: () => void;
    const settled = new Promise<void>((resolve) => (markSettled = resolve));
    this.active.set(comparisonId, { controller, settled });
    const release = () => {
      this.active.delete(comparisonId);
      markSettled();
    };
    let running: ModelComparisonRun;
    try {
      running = await this.markRunning(comparisonId);
    } catch (error) {
      release();
      throw error;
    }
    void this.runInBackground(running, controller.signal).finally(release);
    return withAdvisory(running);
  }

  public async cancelComparison(comparisonId: string): Promise<ModelComparisonRun> {
    const entry = this.active.get(comparisonId);
    if (entry) {
      entry.controller.abort();
      await entry.settled;
      return withAdvisory(await this.readRun(comparisonId));
    }
    const run = await this.readRun(comparisonId);
    if (run.status !== "running") {
      throw new ConflictError({ message: `Comparison is ${run.status}; only a running comparison can be cancelled.` });
    }
    const now = this.nowIso();
    return withAdvisory(
      await this.writeStatus(comparisonId, { status: "cancelled", updatedAt: now, completedAt: now }),
    );
  }

  public async whenSettled(comparisonId: string): Promise<void> {
    await this.active.get(comparisonId)?.settled;
  }

  private async markRunning(comparisonId: string): Promise<ModelComparisonRun> {
    const run = await this.readRun(comparisonId);
    if (run.status === "completed") {
      throw new ConflictError({ message: "Comparison already completed." });
    }
    return await this.writeStatus(comparisonId, {
      status: "running",
      updatedAt: this.nowIso(),
      completedAt: null,
      error: null,
    });
  }

  private async runInBackground(run: ModelComparisonRun, signal: AbortSignal): Promise<void> {
    try {
      await this.executeComparison(run, signal);
    } catch (error) {
      const now = this.nowIso();
      await this.writeStatus(run.comparisonId, {
        status: "failed",
        updatedAt: now,
        completedAt: now,
        error: error instanceof Error ? error.message : String(error),
      }).catch((statusError: unknown) => this.deps.onBackgroundError?.(run.comparisonId, statusError));
    }
  }

  private async executeComparison(run: ModelComparisonRun, signal: AbortSignal): Promise<void> {
    const queue = buildComparisonWorkItems(run);
    let failure: { error: unknown } | undefined;
    const worker = async () => {
      while (!signal.aborted && !failure) {
        const item = queue.shift();
        if (!item) {
          return;
        }
        await this.runWorkItem(run, item, signal).catch((error: unknown) => {
          failure ??= { error };
        });
      }
    };
    await Promise.all(Array.from({ length: COMPARISON_CONCURRENCY }, worker));
    if (failure) {
      throw failure.error;
    }
    await this.finishComparison(run.comparisonId, signal.aborted);
  }

  private async runWorkItem(run: ModelComparisonRun, item: ComparisonWorkItem, signal: AbortSignal): Promise<void> {
    const pending: ModelComparisonPromptResult = { ...item.result, error: undefined };
    await this.writeResult(run.comparisonId, pending);
    let next: ModelComparisonPromptResult;
    try {
      const promptRun = await this.deps.runPromptPackTest(run.packId, item.result.testId, {
        providerId: item.providerId,
        model: item.model,
        signal,
      });
      next = applyPromptPackRun(pending, promptRun);
    } catch (error) {
      if (signal.aborted) {
        return;
      }
      next = { ...pending, error: error instanceof Error ? error.message : String(error) };
    }
    await this.writeResult(run.comparisonId, next);
  }

  private async finishComparison(comparisonId: string, aborted: boolean): Promise<void> {
    const now = this.nowIso();
    if (aborted) {
      await this.writeStatus(comparisonId, { status: "cancelled", updatedAt: now, completedAt: now });
      return;
    }
    const latest = await this.readRun(comparisonId);
    const failedCount = latest.results.filter(
      (result) => Boolean(result.error?.trim()) || !result.responseText?.trim(),
    ).length;
    await this.writeStatus(comparisonId, {
      status: failedCount > 0 ? "failed" : "completed",
      updatedAt: now,
      completedAt: now,
      error: failedCount > 0 ? `${failedCount} of ${latest.results.length} results failed.` : null,
    });
  }

  private async readRun(comparisonId: string): Promise<ModelComparisonRun> {
    return await this.deps.repository.get(comparisonId);
  }

  private async writeStatus(
    comparisonId: string,
    update: Parameters<ModelComparisonRunStatePort["updateStatus"]>[1],
  ): Promise<ModelComparisonRun> {
    return await this.deps.repository.updateStatus(comparisonId, update);
  }

  private async writeResult(comparisonId: string, result: ModelComparisonPromptResult): Promise<void> {
    await this.deps.repository.upsertResult(comparisonId, result, this.nowIso());
  }

  private nowIso(): string {
    return (this.deps.clock?.() ?? new Date()).toISOString();
  }
}

/** One route-facing port: record ownership stays with the comparison service, run control with the executor. */
export function createModelComparisonRoutePort(
  comparisons: ModelComparisonService,
  execution: ModelComparisonExecutionService,
): ModelComparisonRoutePort {
  return {
    createComparison: (input) => comparisons.createComparison(input),
    listComparisons: (limit) => comparisons.listComparisons(limit),
    getComparison: (comparisonId) => comparisons.getComparison(comparisonId),
    addJudgment: (comparisonId, input) => comparisons.addJudgment(comparisonId, input),
    startComparison: (comparisonId) => execution.startComparison(comparisonId),
    cancelComparison: (comparisonId) => execution.cancelComparison(comparisonId),
  };
}

function withAdvisory(run: ModelComparisonRun): ModelComparisonRun {
  return { ...run, advisory: buildModelComparisonAdvisory(run) };
}

function buildComparisonWorkItems(run: ModelComparisonRun): ComparisonWorkItem[] {
  const candidates = new Map(run.candidates.map((candidate) => [candidate.candidateId, candidate]));
  return run.results.flatMap((result) => {
    const candidate = candidates.get(result.candidateId);
    if (!candidate || (result.responseText?.trim() && !result.error?.trim())) {
      return [];
    }
    return [{ result, providerId: candidate.providerId, model: candidate.model }];
  });
}

function applyPromptPackRun(
  pending: ModelComparisonPromptResult,
  promptRun: PromptPackRunRecord,
): ModelComparisonPromptResult {
  // Failed and approval-paused runs never expose partial text to blind judges.
  const responseText =
    promptRun.status === "failed" || promptRun.status === "approval_paused"
      ? undefined
      : promptRun.responseText?.trim() || undefined;
  return {
    ...pending,
    runId: promptRun.runId,
    responseText,
    latencyMs: computeRunLatencyMs(promptRun),
    error: resolvePromptPackRunError(promptRun, responseText),
  };
}

function resolvePromptPackRunError(
  promptRun: PromptPackRunRecord,
  responseText: string | undefined,
): string | undefined {
  if (promptRun.status === "failed") {
    return promptRun.error ?? "Prompt-pack run failed.";
  }
  if (promptRun.status === "approval_paused") {
    return "Prompt-pack run paused for approval.";
  }
  return responseText ? undefined : "Prompt-pack run returned no response.";
}
