// @vitest-environment happy-dom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { useAsyncLoad, type LoadState } from "./native-helpers";

/*
 * MCNEXT-001: `useAsyncLoad` must drop stale/late responses. These tests pin
 * the two failure modes the guard fixes:
 *   1. A response that resolves AFTER the component unmounts must not setState.
 *   2. A slower earlier load must not overwrite a newer load (last-writer-wins).
 */

type Deferred<T> = {
  promise: Promise<T>;
  resolve: (value: T) => void;
  reject: (reason: unknown) => void;
};

function defer<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

// Harness exposes the hook's live state + reload through a sink callback so the
// test can drive reloads and observe what the hook commits to React state.
function Harness({
  loader,
  onState,
}: {
  loader: () => Promise<string>;
  onState: (snapshot: LoadState<string> & { reload: () => Promise<void> }) => void;
}) {
  const result = useAsyncLoad(loader, [loader]);
  onState(result);
  return null;
}

describe("useAsyncLoad (MCNEXT-001 stale-response guard)", () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(async () => {
    await act(async () => {
      root.unmount();
    });
    container.remove();
  });

  it("ignores a response that resolves after the component unmounts", async () => {
    const deferred = defer<string>();
    const loader = () => deferred.promise;
    let latest: (LoadState<string> & { reload: () => Promise<void> }) | null = null;

    await act(async () => {
      root.render(<Harness loader={loader} onState={(snapshot) => (latest = snapshot)} />);
    });

    // Initial mount triggers the load; it is still pending.
    expect(latest!.loading).toBe(true);
    expect(latest!.data).toBeNull();

    // Unmount BEFORE the in-flight load resolves.
    await act(async () => {
      root.unmount();
    });

    // The captured snapshot must not advance after unmount: resolving the
    // promise must be a no-op (no setState-after-unmount). If the guard were
    // missing, React would warn and `data` could flip.
    const snapshotAfterUnmount = latest!;
    await act(async () => {
      deferred.resolve("late-payload");
      await Promise.resolve();
    });

    expect(latest).toBe(snapshotAfterUnmount);
    expect(latest!.data).toBeNull();
    expect(latest!.loading).toBe(true);
  });

  it("drops a slow earlier load when a newer load supersedes it (last-writer-wins prevention)", async () => {
    const first = defer<string>();
    const second = defer<string>();
    const calls: Array<Deferred<string>> = [first, second];
    let callIndex = 0;
    const loader = () => calls[callIndex++]!.promise;

    let latest: (LoadState<string> & { reload: () => Promise<void> }) | null = null;
    await act(async () => {
      root.render(<Harness loader={loader} onState={(snapshot) => (latest = snapshot)} />);
    });

    // First load (from mount) is in flight. Kick a second reload before it
    // resolves — this becomes the current request.
    await act(async () => {
      void latest!.reload();
      await Promise.resolve();
    });

    // Resolve the NEWER load first, then the older one.
    await act(async () => {
      second.resolve("newer");
      await Promise.resolve();
    });
    expect(latest!.data).toBe("newer");
    expect(latest!.loading).toBe(false);

    // The stale earlier response must be dropped — it cannot clobber "newer".
    await act(async () => {
      first.resolve("older-stale");
      await Promise.resolve();
    });
    expect(latest!.data).toBe("newer");
  });

  it("commits the response for a normal (non-superseded, mounted) load", async () => {
    const deferred = defer<string>();
    const loader = () => deferred.promise;
    let latest: (LoadState<string> & { reload: () => Promise<void> }) | null = null;

    await act(async () => {
      root.render(<Harness loader={loader} onState={(snapshot) => (latest = snapshot)} />);
    });

    await act(async () => {
      deferred.resolve("payload");
      await Promise.resolve();
    });

    expect(latest!.loading).toBe(false);
    expect(latest!.error).toBeNull();
    expect(latest!.data).toBe("payload");
  });
});
