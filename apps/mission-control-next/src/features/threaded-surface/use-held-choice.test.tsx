// @vitest-environment happy-dom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { useHeldChoice } from "./use-held-choice";

let root: Root;
let container: HTMLDivElement;
let api: ReturnType<typeof useHeldChoice<{ value?: string }, string>>;
const send = vi.fn<(change: string) => void>();
beforeEach(() => {
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  send.mockReset();
});
afterEach(() => {
  act(() => root.unmount());
  container.remove();
});
function Probe({ scope }: { scope: string }) {
  api = useHeldChoice<{ value?: string }, string>({
    resolve: (draft) => draft.value ?? null,
    send,
    scope,
  });
  return null;
}
const render = (scope: string) => act(async () => root.render(<Probe scope={scope} />));

it("sends a held pick in the scope it was made in", async () => {
  await render("a");
  await act(async () => api.hold(() => ({ value: "x" })));
  await act(async () => api.apply());
  expect(send).toHaveBeenCalledExactlyOnceWith("x");
});

it("never sends a pick against another scope, using an apply captured before the scope changed", async () => {
  await render("a");
  await act(async () => api.hold(() => ({ value: "x" })));
  const staleApply = api.apply;
  await render("b");
  await act(async () => staleApply());
  expect(send).not.toHaveBeenCalled();
  expect(api.dirty).toBe(false);
});
