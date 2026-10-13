import { describe, expect, it, vi } from "vitest";
import type { ChatCompletionRequest } from "@goatcitadel/contracts";
import {
  LlmDispatchGuardScope,
  LlmDispatchGuardRejectedError,
  type LlmDispatchGuardInput,
} from "./llm-dispatch-guard.js";
import {
  bindChatFeatureDispatchCheck,
  runWithAdmittedChatDispatch,
  streamWithAdmittedChatDispatch,
  dispatchAdmittedChatCompletion,
  streamAdmittedChatCompletion,
} from "./chat-feature-dispatch-authority.js";
import { bindChatExplicitContextValidator } from "./chat-explicit-context-authority.js";

const dispatch = {
  attribution: { sessionId: "session", turnId: "turn", durableRunId: "run" },
  route: { providerId: "provider", modelId: "model" },
  effectiveOutputTokenCap: 100,
} as LlmDispatchGuardInput;
function fixture() {
  const scope = new LlmDispatchGuardScope();
  const port = {
    runWithDispatchGuard: scope.run.bind(scope),
    streamWithDispatchGuard: scope.stream.bind(scope),
  } as Parameters<typeof runWithAdmittedChatDispatch>[0];
  const check = vi.fn(async () => {});
  const request = bindChatFeatureDispatchCheck(
    { messages: [], max_tokens: 100, memory: { sessionId: "session", turnId: "turn", runId: "run" } },
    { sessionId: "session", turnId: "turn", runId: "run", check },
  );
  return { scope, port, check, request };
}

describe("admitted feature transport guard", () => {
  it.each([false, true])("preserves every guard and exact transport arguments (stream=%s)", async (stream) => {
    const f = fixture();
    const fallback = vi.fn(async () => {});
    const context = vi.fn(async () => {});
    const authority = bindChatExplicitContextValidator(f.request, context);
    const effective = { ...authority, providerId: "provider", model: "model", timeoutMs: 321, stream };
    const attribution = { sessionId: "session", turnId: "turn", durableRunId: "run" };
    const received = vi.fn();
    const complete = async (request: ChatCompletionRequest, usage: typeof attribution) => {
      received(request, usage);
      await f.scope.get()!(dispatch);
      return { id: "native-receipt", model: "model", choices: [] };
    };
    const port = {
      ...f.port,
      chatCompletions: complete,
      chatCompletionsStream: async function* (request: ChatCompletionRequest, usage: typeof attribution) {
        yield await complete(request, usage);
      },
    } as Parameters<typeof dispatchAdmittedChatCompletion>[0];
    if (stream) {
      const output = [];
      for await (const chunk of streamAdmittedChatCompletion(port, authority, effective, attribution, fallback))
        output.push(chunk);
      expect(output).toHaveLength(1);
    } else
      expect((await dispatchAdmittedChatCompletion(port, authority, effective, attribution, fallback)).id).toBe(
        "native-receipt",
      );
    expect(received).toHaveBeenCalledExactlyOnceWith(effective, attribution);
    expect(fallback).toHaveBeenCalledOnce();
    expect(f.check).toHaveBeenCalledOnce();
    expect(context).toHaveBeenCalledTimes(2);
  });

  it.each([false, true])("refuses an unavailable outer fallback guard before dispatch (stream=%s)", async (stream) => {
    const sent = vi.fn();
    const port = { chatCompletions: sent, chatCompletionsStream: sent } as never;
    const request = { messages: [] };
    const guard = async () => {};
    const result = stream
      ? streamAdmittedChatCompletion(port, request, request, {}, guard).next()
      : dispatchAdmittedChatCompletion(port, request, request, {}, guard);
    await expect(result).rejects.toThrow("Fallback network dispatch guard is unavailable");
    expect(sent).not.toHaveBeenCalled();
  });

  it("rechecks revocation when a deferred provider stream begins and never emits output", async () => {
    const f = fixture();
    const sent = vi.fn();
    f.port.chatCompletionsStream = async function* () {
      await f.scope.get()!(dispatch);
      sent();
      yield { id: "output" };
    } as typeof f.port.chatCompletionsStream;
    const stream = streamAdmittedChatCompletion(f.port, f.request, f.request, {});
    f.check.mockRejectedValueOnce(new Error("grant revoked before iteration"));
    await expect(stream.next()).rejects.toThrow(LlmDispatchGuardRejectedError);
    expect(sent).not.toHaveBeenCalled();
  });

  it("rechecks each actual attempt after preparation, including internal spreads", async () => {
    const f = fixture();
    await runWithAdmittedChatDispatch(f.port, { ...f.request }, async () => {
      expect(f.check).not.toHaveBeenCalled();
      await f.scope.get()!(dispatch);
      f.check.mockRejectedValueOnce(new Error("grant revoked during hook"));
      await expect(f.scope.get()!(dispatch)).rejects.toThrow(LlmDispatchGuardRejectedError);
    });
    expect(f.check).toHaveBeenCalledTimes(2);
  });

  it("does not allow JSON to supply process-local authority", async () => {
    const f = fixture();
    await runWithAdmittedChatDispatch(f.port, JSON.parse(JSON.stringify(f.request)), async () => {
      expect(f.scope.get()).toBeUndefined();
    });
    expect(f.check).not.toHaveBeenCalled();
  });

  it("pins actual transport routes and copies allowed routes before deferred dispatch", async () => {
    const f = fixture();
    const routes = [{ providerId: "provider", model: "model" }];
    const request = bindChatFeatureDispatchCheck(f.request, {
      sessionId: "session",
      turnId: "turn",
      runId: "run",
      check: f.check,
      allowedRoutes: routes,
    });
    routes[0]!.providerId = "retargeted";
    await runWithAdmittedChatDispatch(f.port, request, async () => {
      await f.scope.get()!(dispatch);
      await expect(
        f.scope.get()!({ ...dispatch, route: { ...dispatch.route, providerId: "retargeted" } }),
      ).rejects.toThrow(/provider route changed/);
    });
    expect(f.check).toHaveBeenCalledOnce();
  });

  it.each(["request", "transport"])("rejects %s identity retargeting before the owner check", async (kind) => {
    const f = fixture();
    const request = kind === "request" ? { ...f.request, memory: { ...f.request.memory, turnId: "other" } } : f.request;
    await expect(
      runWithAdmittedChatDispatch(f.port, request, async () => {
        await f.scope.get()!(
          kind === "transport"
            ? { ...dispatch, attribution: { ...dispatch.attribution, durableRunId: "other" } }
            : dispatch,
        );
      }),
    ).rejects.toThrow(/identity changed/);
    expect(f.check).not.toHaveBeenCalled();
  });

  it("refuses cancellation and missing transport guard support", async () => {
    const f = fixture();
    const controller = new AbortController();
    controller.abort();
    await expect(
      runWithAdmittedChatDispatch(f.port, { ...f.request, signal: controller.signal }, async () => {
        await f.scope.get()!(dispatch);
      }),
    ).rejects.toThrow(/cancelled/);
    await expect(runWithAdmittedChatDispatch({} as never, f.request, async () => "sent")).rejects.toThrow(
      /unavailable/,
    );
    expect(f.check).not.toHaveBeenCalled();
  });

  it("preserves outer and explicit-context guards", async () => {
    const f = fixture();
    const outer = vi.fn(async () => {});
    const context = vi.fn(async (_request: ChatCompletionRequest) => {});
    await f.scope.run(outer, () =>
      runWithAdmittedChatDispatch(f.port, bindChatExplicitContextValidator(f.request, context), async () => {
        await f.scope.get()!(dispatch);
      }),
    );
    expect(outer).toHaveBeenCalledOnce();
    expect(f.check).toHaveBeenCalledOnce();
    expect(context).toHaveBeenCalledTimes(2);
  });

  it("binds deferred stream iteration and stops a revoked stream before output", async () => {
    const f = fixture();
    const sent = vi.fn();
    const stream = streamWithAdmittedChatDispatch(f.port, f.request, async function* () {
      await f.scope.get()!(dispatch);
      sent();
      yield "output";
    });
    f.check.mockRejectedValueOnce(new Error("revoked"));
    await expect(stream.next()).rejects.toThrow(LlmDispatchGuardRejectedError);
    expect(sent).not.toHaveBeenCalled();
  });
});
