// @vitest-environment happy-dom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { beforeEach, afterEach, describe, expect, it, vi } from "vitest";
import { useCommandPaletteSearch } from "./use-command-palette-search";
import type { PaletteSearchGroup } from "./command-palette-search";
const api = vi.hoisted(() => ({ search: vi.fn() }));
vi.mock("./command-palette-search", () => ({ searchPaletteObjects: api.search }));
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((next) => {
    resolve = next;
  });
  return { promise, resolve };
}
const groups = (id: string): PaletteSearchGroup[] => [{ id, label: id, items: [], coverage: "Bounded window" }];
let root: Root, element: HTMLDivElement, owner: ReturnType<typeof useCommandPaletteSearch>;
function Probe({
  workspaceId = "a",
  query = "needle",
  open = true,
}: {
  workspaceId?: string;
  query?: string;
  open?: boolean;
}) {
  owner = useCommandPaletteSearch(open, { workspaceId, citadelId: "citadel" }, query);
  return null;
}
async function tick() {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(301);
  });
}
beforeEach(() => {
  vi.useFakeTimers();
  vi.clearAllMocks();
  element = document.createElement("div");
  root = createRoot(element);
});
afterEach(() => {
  act(() => {
    root.unmount();
  });
  vi.useRealTimers();
});

describe("scoped palette search lifecycle", () => {
  it("does no object enumeration while closed or before a meaningful typed query", async () => {
    act(() => {
      root.render(<Probe open={false} />);
    });
    await tick();
    act(() => {
      root.render(<Probe query="n" />);
    });
    await tick();
    expect(api.search).not.toHaveBeenCalled();
  });
  it("suppresses old workspace and query completions, including A→B→A", async () => {
    const old = deferred<PaletteSearchGroup[]>(),
      current = deferred<PaletteSearchGroup[]>();
    api.search.mockReturnValueOnce(old.promise).mockReturnValueOnce(current.promise);
    act(() => {
      root.render(<Probe />);
    });
    await tick();
    act(() => {
      root.render(<Probe workspaceId="b" query="other" />);
    });
    act(() => {
      root.render(<Probe />);
    });
    await tick();
    await act(async () => {
      old.resolve(groups("old"));
    });
    expect(owner.groups).toEqual([]);
    expect(owner.loading).toBe(true);
    await act(async () => {
      current.resolve(groups("current"));
    });
    expect(owner.groups[0]?.id).toBe("current");
  });
  it("withholds a previous opening's cached matches until the new read completes", async () => {
    api.search.mockResolvedValueOnce(groups("old"));
    act(() => {
      root.render(<Probe />);
    });
    await tick();
    expect(owner.groups[0]?.id).toBe("old");
    act(() => {
      root.render(<Probe open={false} />);
    });
    const next = deferred<PaletteSearchGroup[]>();
    api.search.mockReturnValue(next.promise);
    act(() => {
      root.render(<Probe />);
    });
    expect(owner.groups).toEqual([]);
    await tick();
    await act(async () => {
      next.resolve(groups("new"));
    });
    expect(owner.groups[0]?.id).toBe("new");
  });
});
