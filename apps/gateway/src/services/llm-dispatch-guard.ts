import { AsyncLocalStorage } from "node:async_hooks";
import type { ModelUsageAttributionContext } from "@goatcitadel/contracts";
import type { ModelUsageCredentialLineage, ModelUsagePricingLineage } from "@goatcitadel/gateway-core";

export interface LlmDispatchRoute {
  readonly providerId: string;
  readonly modelId: string;
  readonly apiStyle: string;
  readonly configuredContextWindowTokens?: number;
  readonly credential: ModelUsageCredentialLineage;
  readonly pricing?: ModelUsagePricingLineage;
}

export interface LlmDispatchGuardInput {
  readonly usageEventId: string;
  readonly attribution: ModelUsageAttributionContext;
  readonly route: LlmDispatchRoute;
  readonly transportAttemptIndex: number;
  readonly effectiveOutputTokenCap?: number;
}

export type LlmDispatchGuard = (input: LlmDispatchGuardInput) => Promise<void>;

const LINEAGE_KEYS = ["workspaceId", "sessionId", "turnId", "durableRunId", "taskId", "workerId",
  "contextIntentHash", "parentOperationId"] as const;
export type LlmDispatchLineage = Readonly<Pick<ModelUsageAttributionContext, typeof LINEAGE_KEYS[number]>>;

/** Execution-authority failures are never provider retries or fallback signals. */
export class LlmDispatchGuardRejectedError extends Error {
  constructor(cause: unknown) {
    super(cause instanceof Error ? cause.message : "Model dispatch authority rejected the request.", { cause });
    this.name = "LlmDispatchGuardRejectedError";
  }
}

/** Server-only call scope. This is never accepted in request JSON or model context. */
export class LlmDispatchGuardScope {
  private readonly scope = new AsyncLocalStorage<LlmDispatchGuard>();
  private readonly lineageScope = new AsyncLocalStorage<LlmDispatchLineage>();

  public run<T>(guard: LlmDispatchGuard, operation: () => Promise<T>): Promise<T> {
    return this.scope.run(this.compose(guard), operation);
  }

  /** Server-owned execution lineage is inherited by every model attempt. Child
   * calls keep their own operation identities but cannot move charges elsewhere. */
  public runWithLineage<T>(lineage: LlmDispatchLineage, guard: LlmDispatchGuard, operation: () => Promise<T>): Promise<T> {
    if (Object.keys(lineage).some((key) => !LINEAGE_KEYS.some((allowed) => allowed === key)))
      throw new LlmDispatchGuardRejectedError(new Error("Unknown governed model lineage field."));
    for (const value of Object.values(lineage)) {
      if (value !== undefined && (typeof value !== "string" || !value.trim() || value.length > 512))
        throw new LlmDispatchGuardRejectedError(new Error("Invalid governed model lineage."));
    }
    const inherited = this.applyLineage(lineage);
    return this.lineageScope.run(Object.freeze({ ...inherited }), () => this.run(guard, operation));
  }

  public applyLineage(attribution: ModelUsageAttributionContext): ModelUsageAttributionContext {
    const lineage = this.lineageScope.getStore();
    if (!lineage) return attribution;
    const result = { ...attribution };
    for (const key of LINEAGE_KEYS) {
      const expected = lineage[key];
      if (expected === undefined) continue;
      if (attribution[key] !== undefined && attribution[key] !== expected)
        throw new LlmDispatchGuardRejectedError(new Error("Model usage conflicts with its governed execution lineage."));
      result[key] = expected;
    }
    return result;
  }

  /** Bind deferred iteration as well as stream creation. A caller may consume
   * the stream after leaving the asynchronous scope that prepared its context. */
  public stream<T, TReturn = void, TNext = unknown>(
    guard: LlmDispatchGuard,
    operation: () => AsyncGenerator<T, TReturn, TNext>,
  ): AsyncGenerator<T, TReturn, TNext> {
    const bound = this.compose(guard);
    const lineage = this.lineageScope.getStore();
    let iterator: AsyncGenerator<T, TReturn, TNext> | undefined;
    let closed = false;
    const invoke = <TResult>(work: () => Promise<TResult>) =>
      this.lineageScope.run(lineage ?? {}, () => this.scope.run(bound, async () => {
        try {
          return await work();
        } catch (error) {
          closed = true;
          throw error;
        }
      }));
    return {
      [Symbol.asyncIterator]() {
        return this;
      },
      next: (...args: [] | [TNext]) =>
        invoke(async () => {
          if (closed) return { done: true, value: undefined as TReturn };
          iterator ??= operation();
          const result = await iterator.next(...args);
          if (result.done) closed = true;
          return result;
        }),
      return: (value: TReturn | PromiseLike<TReturn>) =>
        invoke(async () => {
          // Cancelling an unstarted stream must not start its preparation or model calls.
          if (!iterator || closed) {
            closed = true;
            return { done: true, value: await value };
          }
          const result = await iterator.return(value);
          if (result.done) closed = true;
          return result;
        }),
      throw: (error?: unknown) =>
        invoke(async () => {
          if (!iterator || closed) {
            closed = true;
            throw error;
          }
          const result = await iterator.throw(error);
          if (result.done) closed = true;
          return result;
        }),
    };
  }

  public get(): LlmDispatchGuard | undefined {
    return this.scope.getStore();
  }

  private compose(guard: LlmDispatchGuard): LlmDispatchGuard {
    const parent = this.scope.getStore();
    return parent
      ? async (input) => {
          await parent(input);
          await guard(input);
        }
      : guard;
  }
}
