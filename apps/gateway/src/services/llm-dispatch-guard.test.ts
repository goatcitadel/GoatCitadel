import { describe, expect, it, vi } from "vitest";
import { LlmDispatchGuardScope, type LlmDispatchGuardInput } from "./llm-dispatch-guard.js";

const input: LlmDispatchGuardInput = {
  usageEventId: "usage-1",
  attribution: {},
  transportAttemptIndex: 0,
  route: {
    providerId: "fixture",
    modelId: "model",
    apiStyle: "openai-chat-completions",
    credential: { credentialType: "api_key", usagePool: "standard", credentialSource: "keychain" },
  },
};

describe("governed model workflow scope", () => {
  it("snapshots execution lineage and keeps concurrent workflows separate", async () => {
    const scope = new LlmDispatchGuardScope();
    const lineage = { workspaceId: "workspace-a", workerId: "worker-a", parentOperationId: "effect-a" };
    const first = scope.runWithLineage(lineage, async () => {}, async () => {
      await Promise.resolve();
      return scope.applyLineage({ operationId: "child-a" });
    });
    lineage.workerId = "changed";
    const second = scope.runWithLineage({ workspaceId: "workspace-b", workerId: "worker-b" }, async () => {}, async () => {
      await Promise.resolve();
      return scope.applyLineage({ operationId: "child-b" });
    });
    expect(await first).toEqual({ operationId: "child-a", workspaceId: "workspace-a", workerId: "worker-a", parentOperationId: "effect-a" });
    expect(await second).toEqual({ operationId: "child-b", workspaceId: "workspace-b", workerId: "worker-b" });
    expect(scope.applyLineage({ operationId: "outside" })).toEqual({ operationId: "outside" });
  });

  it.each(["workspaceId", "sessionId", "turnId", "durableRunId", "taskId", "workerId", "contextIntentHash", "parentOperationId"] as const)(
    "refuses a child or nested authority that changes %s", async (key) => {
      const scope = new LlmDispatchGuardScope();
      await scope.runWithLineage({ [key]: "parent" }, async () => {}, async () => {
        expect(() => scope.applyLineage({ [key]: "foreign" })).toThrow("governed execution lineage");
        expect(() => scope.runWithLineage({ [key]: "foreign" }, async () => {}, async () => {})).toThrow("governed execution lineage");
        expect(scope.applyLineage({ [key]: "parent" })[key]).toBe("parent");
      });
    },
  );

  it("keeps the captured lineage when a lazy stream is consumed in another workflow", async () => {
    const scope = new LlmDispatchGuardScope();
    const stream = await scope.runWithLineage({ workerId: "owner" }, async () => {}, async () =>
      scope.stream(async () => {}, async function* () {
        await Promise.resolve();
        yield scope.applyLineage({ operationId: "lazy-child" });
      }));
    await scope.runWithLineage({ workerId: "consumer" }, async () => {}, async () => {
      expect(await Array.fromAsync(stream)).toEqual([{ operationId: "lazy-child", workerId: "owner" }]);
      expect(scope.applyLineage({}).workerId).toBe("consumer");
    });
  });

  it("keeps parent authority on a lazy stream consumed outside its creation scope", async () => {
    const scope = new LlmDispatchGuardScope();
    const calls: string[] = [];
    const stream = await scope.run(
      async () => {
        calls.push("parent");
      },
      async () =>
        scope.stream(
          async () => {
            calls.push("child");
          },
          async function* () {
            await scope.get()!(input);
            yield "one";
            await Promise.resolve();
            await scope.get()!(input);
            yield "two";
          },
        ),
    );
    expect(scope.get()).toBeUndefined();
    expect(await Array.fromAsync(stream)).toEqual(["one", "two"]);
    expect(calls).toEqual(["parent", "child", "parent", "child"]);
    expect(scope.get()).toBeUndefined();
  });

  it("does not let nested or concurrent work replace another execution's guard", async () => {
    const scope = new LlmDispatchGuardScope();
    const child = vi.fn(async () => {});
    const denied = await scope.run(
      async () => {
        throw new Error("grant revoked");
      },
      async () =>
        scope.stream(child, async function* () {
          await scope.get()!(input);
          yield "never";
        }),
    );
    const allowed = scope.stream(
      async (value) => {
        expect(value.usageEventId).toBe("allowed");
      },
      async function* () {
        await Promise.resolve();
        await scope.get()!({ ...input, usageEventId: "allowed" });
        yield "allowed";
      },
    );
    const [failed, passed] = await Promise.allSettled([denied.next(), allowed.next()]);
    expect(failed).toMatchObject({ status: "rejected", reason: new Error("grant revoked") });
    expect(passed).toMatchObject({ status: "fulfilled", value: { value: "allowed", done: false } });
    expect(child).not.toHaveBeenCalled();
    expect(await denied.next()).toMatchObject({ done: true });
    await allowed.return();
  });

  it("keeps authority during return and throw cleanup without starting a cancelled stream", async () => {
    const scope = new LlmDispatchGuardScope();
    const guard = vi.fn(async () => {});
    const factory = vi.fn(async function* () {
      await scope.get()!(input);
      yield "unexpected";
    });
    const unstarted = scope.stream(guard, factory);
    await unstarted.return();
    expect(await unstarted.next()).toMatchObject({ done: true });
    expect(factory).not.toHaveBeenCalled();
    for (const operation of ["return", "throw"] as const) {
      const stream = scope.stream(guard, async function* () {
        try {
          yield "first";
        } finally {
          await scope.get()!(input);
        }
      });
      await stream.next();
      if (operation === "return") await stream.return();
      else await expect(stream.throw(new Error("stop"))).rejects.toThrow("stop");
      expect(scope.get()).toBeUndefined();
    }
    expect(guard).toHaveBeenCalledTimes(2);
  });

  it("does not repeat failed preparation when next is called again", async () => {
    const scope = new LlmDispatchGuardScope();
    const factory = vi.fn((): AsyncGenerator<string> => {
      throw new Error("preparation failed");
    });
    const stream = scope.stream(async () => {}, factory);
    await expect(stream.next()).rejects.toThrow("preparation failed");
    expect(await stream.next()).toMatchObject({ done: true });
    expect(factory).toHaveBeenCalledOnce();
  });
});
