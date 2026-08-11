import type { ModelUsageAttributionContext } from "@goatcitadel/contracts";
import type { BeginModelUsageDispatchInput, ModelUsageCredentialLineage } from "@goatcitadel/gateway-core";
import { describe, expect, it, vi } from "vitest";
import {
  RemoteWorkerInferenceLlmAdapter,
  type RemoteWorkerInferenceAccountingHandle,
  type RemoteWorkerInferenceAccountingPort,
  type RemoteWorkerInferenceAccountingReservation,
  type RemoteWorkerInferenceDispatchRequest,
  type RemoteWorkerInferenceProviderResult,
  type RemoteWorkerInferenceProviderTransport,
} from "./remote-worker-inference-llm-adapter.js";

const credential: ModelUsageCredentialLineage = {
  credentialType: "api_key",
  usagePool: "standard",
  credentialSource: "keychain",
};

interface RecordedAttempt {
  input: BeginModelUsageDispatchInput;
  eventId: string;
  settled: "succeeded" | "failed" | "abandoned" | "unknown" | "pending";
}

function fakeAccounting(): { port: RemoteWorkerInferenceAccountingPort; attempts: RecordedAttempt[] } {
  const attempts: RecordedAttempt[] = [];
  let counter = 0;
  const port: RemoteWorkerInferenceAccountingPort = {
    prepareDispatch(input: BeginModelUsageDispatchInput): RemoteWorkerInferenceAccountingReservation {
      counter += 1;
      const eventId = `event-${counter}`;
      const record: RecordedAttempt = { input, eventId, settled: "pending" };
      attempts.push(record);
      return {
        eventId,
        accept() {
          return {
            observe() {
              /* consume-only */
            },
            succeed() {
              record.settled = "succeeded";
              return {};
            },
            fail() {
              record.settled = "failed";
              return {};
            },
            cancel() {
              record.settled = "unknown";
              return {};
            },
          };
        },
        abandon() {
          record.settled = "abandoned";
        },
        markDispatchUnknown() {
          record.settled = "unknown";
        },
      };
    },
  };
  return { port, attempts };
}

function transportOf(...results: RemoteWorkerInferenceProviderResult[]): {
  transport: RemoteWorkerInferenceProviderTransport;
  seen: number[];
} {
  const seen: number[] = [];
  let index = 0;
  return {
    seen,
    transport: {
      async dispatch(input): Promise<RemoteWorkerInferenceProviderResult> {
        seen.push(input.effectiveOutputTokenCap);
        const result = results[Math.min(index, results.length - 1)]!;
        index += 1;
        return result;
      },
    },
  };
}

function request(overrides: Partial<RemoteWorkerInferenceDispatchRequest> = {}): RemoteWorkerInferenceDispatchRequest {
  const attribution: ModelUsageAttributionContext = {
    callKind: "delegation_worker",
    operationId: "operation-1",
    dispatchGeneration: "dispatch-generation-1",
    workerId: "worker-1",
    workspaceId: "default",
    sessionId: "session-1",
    turnId: "turn-1",
  };
  return {
    attribution,
    resolution: { providerId: "anthropic", modelId: "claude-opus-4", apiStyle: "messages", credential },
    messages: [{ role: "user", text: "Hello." }],
    requestedOutputTokenCap: 5000,
    effectiveOutputTokenCap: 5000,
    reasoningTokenCeiling: 1024,
    temperatureMilli: 700,
    ...overrides,
  };
}

describe("RemoteWorkerInferenceLlmAdapter", () => {
  it("persists the async transport-acceptance fence before provider completion", async () => {
    let resolveProvider!: (result: RemoteWorkerInferenceProviderResult) => void;
    const providerResult = new Promise<RemoteWorkerInferenceProviderResult>((resolve) => {
      resolveProvider = resolve;
    });
    const accepted = vi.fn(
      async (): Promise<RemoteWorkerInferenceAccountingHandle> => ({
        observe: vi.fn(),
        succeed: vi.fn(async () => ({})),
        fail: vi.fn(async () => ({})),
        cancel: vi.fn(async () => ({})),
      }),
    );
    const accounting: RemoteWorkerInferenceAccountingPort = {
      prepareDispatch: vi.fn(async () => ({
        eventId: "async-event-1",
        accept: accepted,
        abandon: vi.fn(async () => undefined),
        markDispatchUnknown: vi.fn(async () => undefined),
      })),
    };
    const adapter = new RemoteWorkerInferenceLlmAdapter(accounting, {
      dispatch: vi.fn(() => providerResult),
    });

    const pending = adapter.dispatch(request());
    await vi.waitFor(() => expect(accepted).toHaveBeenCalledOnce());
    let settled = false;
    void pending.then(() => {
      settled = true;
    });
    await Promise.resolve();
    expect(settled).toBe(false);

    resolveProvider({ outcome: "success", chunks: [{ text: "accepted" }] });
    await expect(pending).resolves.toMatchObject({
      terminalState: "completed",
      chunks: ["accepted"],
      usageEventId: "async-event-1",
    });
  });

  it("returns dispatch_unknown when the async acceptance fence cannot be persisted", async () => {
    const markDispatchUnknown = vi.fn(async () => undefined);
    const accounting: RemoteWorkerInferenceAccountingPort = {
      prepareDispatch: vi.fn(async () => ({
        eventId: "uncertain-event-1",
        accept: vi.fn(async () => {
          throw new Error("canary persistence detail");
        }),
        abandon: vi.fn(async () => undefined),
        markDispatchUnknown,
      })),
    };
    const adapter = new RemoteWorkerInferenceLlmAdapter(accounting, {
      dispatch: vi.fn(async () => ({ outcome: "success", chunks: [{ text: "must-not-deliver" }] })),
    });

    await expect(adapter.dispatch(request())).resolves.toMatchObject({
      terminalState: "dispatch_unknown",
      chunks: [],
      usageEventId: "uncertain-event-1",
      errorCode: "transport_acceptance_persistence_failed",
    });
    expect(markDispatchUnknown).toHaveBeenCalledOnce();
  });

  it("delegates a successful dispatch to HX-306 and returns text chunks", async () => {
    const accounting = fakeAccounting();
    const { transport } = transportOf({
      outcome: "success",
      chunks: [{ text: "Hello " }, { text: "world" }],
      usage: { input_tokens: 10, output_tokens: 5 },
    });
    const adapter = new RemoteWorkerInferenceLlmAdapter(accounting.port, transport);
    const outcome = await adapter.dispatch(request());
    expect(outcome.terminalState).toBe("completed");
    expect(outcome.chunks).toEqual(["Hello ", "world"]);
    expect(outcome.usageEventId).toBe("event-1");
    expect(outcome.transportAttempts).toBe(1);
    expect(accounting.attempts[0]?.settled).toBe("succeeded");
    expect(accounting.attempts[0]?.input.attribution.callKind).toBe("delegation_worker");
    expect(accounting.attempts[0]?.input.effectiveProviderId).toBe("anthropic");
  });

  it("retains bounded output-cap recovery: one reduced-cap retry then success", async () => {
    const accounting = fakeAccounting();
    const capError: RemoteWorkerInferenceProviderResult = {
      outcome: "output_cap_error",
      providerErrorBody: "max_tokens: 5000 > context_window: 4096 - input_tokens: 200 = available_tokens: 3896",
    };
    const { transport, seen } = transportOf(capError, {
      outcome: "success",
      chunks: [{ text: "recovered" }],
      usage: { output_tokens: 3 },
    });
    const adapter = new RemoteWorkerInferenceLlmAdapter(accounting.port, transport);
    const outcome = await adapter.dispatch(
      request({
        resolution: {
          providerId: "anthropic",
          modelId: "claude-opus-4",
          apiStyle: "messages",
          credential,
          configuredContextWindowTokens: 8192,
        },
      }),
    );
    expect(outcome.terminalState).toBe("completed");
    expect(outcome.transportAttempts).toBe(2);
    expect(outcome.usageEventIds).toEqual(["event-1", "event-2"]);
    // The retry lowered the effective cap and linked to the parent event.
    expect(seen[1]).toBeLessThan(seen[0]!);
    expect(accounting.attempts[0]?.settled).toBe("failed");
    expect(accounting.attempts[1]?.settled).toBe("succeeded");
    expect(accounting.attempts[1]?.input.transportRetry).toEqual({
      parentEventId: "event-1",
      reason: "output_cap_recovery",
    });
    expect(accounting.attempts[1]?.input.outputCap?.disposition).toBe("reduced_retry");
  });

  it("does not retry when the provider error is not a recoverable output-cap error", async () => {
    const accounting = fakeAccounting();
    const { transport } = transportOf({ outcome: "output_cap_error", providerErrorBody: "invalid api key" });
    const adapter = new RemoteWorkerInferenceLlmAdapter(accounting.port, transport);
    const outcome = await adapter.dispatch(request());
    expect(outcome.terminalState).toBe("failed");
    expect(outcome.transportAttempts).toBe(1);
    expect(outcome.errorCode).toBe("output_cap");
  });

  it("classifies a generic provider failure without leaking the raw body", async () => {
    const accounting = fakeAccounting();
    const { transport } = transportOf({ outcome: "error", errorCode: "Provider 500: secret-header=abc" });
    const adapter = new RemoteWorkerInferenceLlmAdapter(accounting.port, transport);
    const outcome = await adapter.dispatch(request());
    expect(outcome.terminalState).toBe("failed");
    expect(outcome.chunks).toEqual([]);
    expect(outcome.errorCode).not.toContain("secret-header=abc");
    expect(outcome.errorCode).toMatch(/^[a-z0-9_.-]+$/u);
  });

  it("surfaces an uncertain dispatch as dispatch_unknown", async () => {
    const accounting = fakeAccounting();
    const { transport } = transportOf({ outcome: "dispatch_unknown", errorCode: "acceptance_persistence_failed" });
    const adapter = new RemoteWorkerInferenceLlmAdapter(accounting.port, transport);
    const outcome = await adapter.dispatch(request());
    expect(outcome.terminalState).toBe("dispatch_unknown");
    expect(accounting.attempts[0]?.settled).toBe("failed");
  });

  it("settles an accepted attempt and reports cancellation when the transport rejects on an aborted signal", async () => {
    const accounting = fakeAccounting();
    const controller = new AbortController();
    controller.abort();
    const transport: RemoteWorkerInferenceProviderTransport = {
      async dispatch() {
        throw new DOMException("Aborted", "AbortError");
      },
    };
    const adapter = new RemoteWorkerInferenceLlmAdapter(accounting.port, transport);
    const outcome = await adapter.dispatch(request({ signal: controller.signal }));
    expect(outcome.terminalState).toBe("failed");
    expect(outcome.errorCode).toBe("cancelled");
    expect(accounting.attempts[0]?.settled).toBe("failed");
  });

  it("rejects a non-delegation_worker call kind", async () => {
    const accounting = fakeAccounting();
    const { transport } = transportOf({ outcome: "success", chunks: [] });
    const adapter = new RemoteWorkerInferenceLlmAdapter(accounting.port, transport);
    await expect(adapter.dispatch(request({ attribution: { callKind: "utility", operationId: "x" } }))).rejects.toThrow(
      /delegation_worker/u,
    );
  });
});
