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
  /** Compare-and-swap move to `running`; undefined when another writer changed the record first. */
  claimRun(
    comparisonId: string,
    claim: { expectedStatus: ModelComparisonRun["status"]; expectedUpdatedAt: string; updatedAt: string },
  ): Promise<ModelComparisonRun | undefined>;
  /** Extends the execution lease; false once the record is no longer `running`. */
  renewRunLease(comparisonId: string, updatedAt: string): Promise<boolean>;
  /** Terminal write applied only while still `running`; undefined when it no longer applies. */
  finishRun(
    comparisonId: string,
    update: {
      status: ModelComparisonRun["status"];
      updatedAt: string;
      completedAt: string | null;
      error: string | null;
    },
  ): Promise<ModelComparisonRun | undefined>;
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
  /** Lease TTL override for tests; defaults to {@link COMPARISON_RUN_LEASE_TTL_MS}. */
  leaseTtlMs?: number;
}

const COMPARISON_CONCURRENCY = 2;
/** A `running` record not renewed for this long is presumed orphaned by a dead process. */
export const COMPARISON_RUN_LEASE_TTL_MS = 5 * 60_000;

interface ComparisonWorkItem {
  result: ModelComparisonPromptResult;
  providerId: string;
  model: string;
}

interface ActiveComparison {
  controller: AbortController;
  settled: Promise<void>;
}

type TerminalUpdate = Parameters<ModelComparisonRunStatePort["finishRun"]>[1];

/**
 * Runs blind comparisons through the governed prompt-pack runner. The in-memory
 * `active` map guards this process; a repository compare-and-swap claim plus a
 * renewed lease guards against other gateway processes sharing the store.
 */
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
    void this.runInBackground(running, controller)
      .catch((error: unknown) => this.reportBackgroundError(comparisonId, error))
      .finally(release);
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
    // The run may be owned by another process; its executor sees the cancel on
    // its next lease renewal and stops dispatching.
    const now = this.nowIso();
    const cancelled = await this.writeTerminal(comparisonId, {
      status: "cancelled",
      updatedAt: now,
      completedAt: now,
      error: null,
    });
    if (cancelled) {
      return withAdvisory(cancelled);
    }
    const latest = await this.readRun(comparisonId);
    if (latest.status === "cancelled") {
      return withAdvisory(latest);
    }
    throw new ConflictError({ message: `Comparison is ${latest.status}; only a running comparison can be cancelled.` });
  }

  public async whenSettled(comparisonId: string): Promise<void> {
    await this.active.get(comparisonId)?.settled;
  }

  private async markRunning(comparisonId: string): Promise<ModelComparisonRun> {
    const run = await this.readRun(comparisonId);
    if (run.status === "completed") {
      throw new ConflictError({ message: "Comparison already completed." });
    }
    if (run.status === "running" && !this.isLeaseExpired(run)) {
      throw new ConflictError({ message: "Comparison is already running." });
    }
    const claimed = await this.deps.repository.claimRun(comparisonId, {
      expectedStatus: run.status,
      expectedUpdatedAt: run.updatedAt,
      updatedAt: this.nowIso(),
    });
    if (!claimed) {
      throw new ConflictError({ message: "Comparison was claimed by another run." });
    }
    return claimed;
  }

  private async runInBackground(run: ModelComparisonRun, controller: AbortController): Promise<void> {
    const stopLeaseRenewal = this.startLeaseRenewal(run.comparisonId, controller);
    try {
      await this.executeComparison(run, controller);
    } catch (error) {
      const now = this.nowIso();
      await this.writeTerminal(run.comparisonId, {
        status: "failed",
        updatedAt: now,
        completedAt: now,
        error: error instanceof Error ? error.message : String(error),
      }).catch((statusError: unknown) => this.reportBackgroundError(run.comparisonId, statusError));
    } finally {
      stopLeaseRenewal();
    }
  }

  private async executeComparison(run: ModelComparisonRun, controller: AbortController): Promise<void> {
    const signal = controller.signal;
    const queue = buildComparisonWorkItems(run);
    let failure: { error: unknown } | undefined;
    const worker = async () => {
      while (!signal.aborted && !failure) {
        const item = queue.shift();
        if (!item) {
          return;
        }
        const leaseHeld = await this.renewLease(run.comparisonId, controller).catch((error: unknown) => {
          failure ??= { error };
          return false;
        });
        if (!leaseHeld) {
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
    // A terminal write that no longer applies (cancelled or finished elsewhere)
    // leaves the stored record untouched.
    if (aborted) {
      await this.writeTerminal(comparisonId, { status: "cancelled", updatedAt: now, completedAt: now, error: null });
      return;
    }
    const latest = await this.readRun(comparisonId);
    const failedCount = latest.results.filter(
      (result) => Boolean(result.error?.trim()) || !result.responseText?.trim(),
    ).length;
    await this.writeTerminal(comparisonId, {
      status: failedCount > 0 ? "failed" : "completed",
      updatedAt: now,
      completedAt: now,
      error: failedCount > 0 ? `${failedCount} of ${latest.results.length} results failed.` : null,
    });
  }

  /** Periodic renewal (at least every TTL/3) so a long work item never lets the lease lapse. */
  private startLeaseRenewal(comparisonId: string, controller: AbortController): () => void {
    const timer = setInterval(
      () => {
        void this.renewLease(comparisonId, controller).catch((error: unknown) =>
          this.reportBackgroundError(comparisonId, error),
        );
      },
      Math.max(1, Math.floor(this.leaseTtlMs() / 3)),
    );
    timer.unref?.();
    return () => clearInterval(timer);
  }

  /** Renews the lease; when the record stopped being `running` elsewhere, aborts local work. */
  private async renewLease(comparisonId: string, controller: AbortController): Promise<boolean> {
    if (controller.signal.aborted) {
      return false;
    }
    const renewed = await this.deps.repository.renewRunLease(comparisonId, this.nowIso());
    if (!renewed) {
      controller.abort();
    }
    return renewed;
  }

  private isLeaseExpired(run: ModelComparisonRun): boolean {
    const updatedAtMs = Date.parse(run.updatedAt);
    return !Number.isFinite(updatedAtMs) || this.now().getTime() - updatedAtMs > this.leaseTtlMs();
  }

  private leaseTtlMs(): number {
    const override = this.deps.leaseTtlMs;
    return typeof override === "number" && override > 0 ? override : COMPARISON_RUN_LEASE_TTL_MS;
  }

  private async readRun(comparisonId: string): Promise<ModelComparisonRun> {
    return await this.deps.repository.get(comparisonId);
  }

  private async writeTerminal(comparisonId: string, update: TerminalUpdate): Promise<ModelComparisonRun | undefined> {
    return await this.deps.repository.finishRun(comparisonId, update);
  }

  private async writeResult(comparisonId: string, result: ModelComparisonPromptResult): Promise<void> {
    await this.deps.repository.upsertResult(comparisonId, result, this.nowIso());
  }

  private now(): Date {
    return this.deps.clock?.() ?? new Date();
  }

  private nowIso(): string {
    return this.now().toISOString();
  }

  private reportBackgroundError(comparisonId: string, error: unknown): void {
    this.deps.onBackgroundError?.(comparisonId, error);
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
