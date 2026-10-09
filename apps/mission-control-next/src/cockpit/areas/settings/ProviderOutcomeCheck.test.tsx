// @vitest-environment happy-dom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { ProviderMutation } from "../../../features/native-routes/settings/sections/provider-mutation-state";
import { ProviderOutcomeCheck } from "./ProviderOutcomeCheck";

const state = vi.hoisted(() => ({ check: vi.fn(async () => undefined) }));
vi.mock("../../../features/native-routes/settings/sections/provider-mutation-state", () => ({
  checkProviderMutationOutcome: state.check,
}));

let root: Root, container: HTMLDivElement;
const reload = vi.fn(async () => undefined);
const render = (mutation: ProviderMutation) =>
  act(async () => {
    root.render(<ProviderOutcomeCheck mutation={mutation} reload={reload} />);
  });
const button = () => [...container.querySelectorAll("button")].find((item) => /outcome/i.test(item.textContent ?? ""));

beforeEach(() => {
  vi.clearAllMocks();
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
});
afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

it("checks an identified lost attempt with the owner's reload", async () => {
  await render({ pending: false, uncertain: "Outcome uncertain.", checkable: true });
  expect(container.querySelector('[role="alert"]')?.textContent).toBe("Outcome uncertain.");
  await act(async () => button()!.click());
  expect(state.check).toHaveBeenCalledWith(reload);
});

it("offers no check for an attempt it cannot identify, and none while checking", async () => {
  await render({ pending: false, uncertain: "Outcome uncertain.", checkable: false });
  expect(button()).toBeUndefined();
  await render({ pending: false, uncertain: "Outcome uncertain.", checkable: true, checking: true });
  expect(button()?.disabled).toBe(true);
  expect(button()?.textContent).toMatch(/checking/i);
});

it("shows what the last check found, including after the lock is released", async () => {
  await render({ pending: false, outcome: "The Gateway recorded the uncertain provider change as processed." });
  expect(container.querySelector('[role="status"]')?.textContent).toMatch(/recorded/);
  expect(container.querySelector('[role="alert"]')).toBeNull();
  expect(button()).toBeUndefined();
  await render({ pending: false });
  expect(container.textContent).toBe("");
});
