import { act, create, type ReactTestRenderer } from "react-test-renderer";
import { afterEach, describe, expect, it, vi } from "vitest";

import { useAction } from "./useAction";

type HookValue = ReturnType<typeof useAction>;

function Harness({ onValue }: { onValue: (value: HookValue) => void }) {
  const value = useAction();
  onValue(value);
  return null;
}

function createDeferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

describe("useAction", () => {
  let renderer: ReactTestRenderer | null = null;

  afterEach(() => {
    renderer?.unmount();
    renderer = null;
    vi.restoreAllMocks();
  });

  it("transitions pending -> success and returns the operation result", async () => {
    let latest!: HookValue;
    await act(async () => {
      renderer = create(<Harness onValue={(value) => (latest = value)} />);
    });
    expect(latest.actionState.state).toBe("idle");

    let result: string | undefined;
    await act(async () => {
      result = await latest.run(async () => "done");
    });
    expect(result).toBe("done");
    expect(latest.actionState.state).toBe("success");
    expect(latest.pending).toBe(false);
  });

  it("transitions pending -> error and rethrows", async () => {
    let latest!: HookValue;
    await act(async () => {
      renderer = create(<Harness onValue={(value) => (latest = value)} />);
    });

    await act(async () => {
      await expect(
        latest.run(async () => {
          throw new Error("boom");
        }),
      ).rejects.toThrow("boom");
    });
    expect(latest.actionState.state).toBe("error");
    expect(latest.actionState.error).toBe("boom");
  });

  it("does not setState after unmount when the action resolves late (MCSHARED-006)", async () => {
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => undefined);
    let latest!: HookValue;
    await act(async () => {
      renderer = create(<Harness onValue={(value) => (latest = value)} />);
    });

    const deferred = createDeferred<string>();
    let runPromise!: Promise<string>;
    act(() => {
      runPromise = latest.run(() => deferred.promise);
    });

    // Unmount before the operation resolves.
    act(() => {
      renderer?.unmount();
      renderer = null;
    });

    // Resolving after unmount must not throw and must not trigger a state-update warning.
    await act(async () => {
      deferred.resolve("late");
      await expect(runPromise).resolves.toBe("late");
    });

    // Ignore unrelated noise (e.g. the react-test-renderer deprecation notice);
    // assert specifically that no setState-after-unmount / act warning was logged.
    const stateUpdateWarnings = consoleError.mock.calls.filter((args) =>
      args.some(
        (arg) =>
          typeof arg === "string" &&
          (arg.includes("unmounted") || arg.includes("not wrapped in act") || arg.includes("state update")),
      ),
    );
    expect(stateUpdateWarnings).toEqual([]);
  });

  it("reset returns the action to idle", async () => {
    let latest!: HookValue;
    await act(async () => {
      renderer = create(<Harness onValue={(value) => (latest = value)} />);
    });
    await act(async () => {
      await latest.run(async () => "ok");
    });
    expect(latest.actionState.state).toBe("success");
    act(() => {
      latest.reset();
    });
    expect(latest.actionState.state).toBe("idle");
  });
});
