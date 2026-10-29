// @vitest-environment happy-dom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { useSetupState } from "./use-setup-state";

interface Sample {
  draftId: string | null;
  busy: boolean;
  error?: string;
}

const EMPTY: Sample = { draftId: null, busy: false, error: undefined };

let root: Root;
let container: HTMLDivElement;
let state: ReturnType<typeof useSetupState<Sample>>;
let renders: number;

function Probe() {
  state = useSetupState(EMPTY);
  renders += 1;
  return null;
}

beforeEach(async () => {
  renders = 0;
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  await act(async () => {
    root.render(createElement(Probe));
  });
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

describe("useSetupState", () => {
  it("starts at the empty state", () => {
    expect(state.view).toBe(EMPTY);
    expect(state.current()).toBe(EMPTY);
  });

  it("applies a patch to the view and keeps the rest of the state", () => {
    const set = state.begin();
    act(() => set({ draftId: "draft-1" }));
    act(() => set({ busy: true }));
    expect(state.view).toEqual({ draftId: "draft-1", busy: true, error: undefined });
    expect(state.current()).toEqual({ draftId: "draft-1", busy: true, error: undefined });
  });

  it("lets a handler read a patch before the next render", () => {
    const set = state.begin();
    const rendersBefore = renders;
    // Two writes in one batch: the second call still sees the first, though nothing has rendered in between.
    act(() => {
      set({ draftId: "draft-1" });
      expect(state.current().draftId).toBe("draft-1");
      set({ busy: true });
      expect(state.current()).toEqual({ draftId: "draft-1", busy: true, error: undefined });
    });
    expect(renders).toBeGreaterThan(rendersBefore);
    expect(state.view.draftId).toBe("draft-1");
  });

  it("does not change the state it was given or an earlier view", () => {
    const set = state.begin();
    const before = state.view;
    act(() => set({ busy: true }));
    expect(EMPTY.busy).toBe(false);
    expect(before.busy).toBe(false);
    expect(state.view).not.toBe(before);
  });

  it("drops what a setter made before reset writes after it", () => {
    const stale = state.begin();
    act(() => stale({ draftId: "old" }));
    act(() => state.reset());
    act(() => stale({ draftId: "late", busy: true }));
    expect(state.view).toEqual(EMPTY);
    expect(state.current()).toEqual(EMPTY);
  });

  it("returns to the empty state on reset", () => {
    const set = state.begin();
    act(() => set({ draftId: "draft-1", busy: true, error: "oops" }));
    act(() => state.reset());
    expect(state.view).toEqual(EMPTY);
    expect(state.current()).toEqual(EMPTY);
  });

  it("keeps a setter made after reset working", () => {
    act(() => state.reset());
    const fresh = state.begin();
    act(() => fresh({ draftId: "new" }));
    expect(state.view.draftId).toBe("new");
  });

  it("drops every pending setter on one reset", () => {
    const first = state.begin();
    const second = state.begin();
    act(() => state.reset());
    act(() => {
      first({ draftId: "a" });
      second({ draftId: "b" });
    });
    expect(state.view).toEqual(EMPTY);
  });

  it("gives the same functions on every render, so they are safe in dependency lists", () => {
    const { begin, current, reset } = state;
    const set = begin();
    act(() => set({ busy: true }));
    expect(state.begin).toBe(begin);
    expect(state.current).toBe(current);
    expect(state.reset).toBe(reset);
  });
});
