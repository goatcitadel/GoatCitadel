// @vitest-environment happy-dom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { CompactModelControl } from "./ThreadConversationSurface";

const providers = [
  { providerId: "fixture", label: "Fixture", models: ["fixture-chat", "fixture-large"], disabled: false },
  { providerId: "other", label: "Other", models: ["other-a", "other-b"], defaultModel: "other-b", disabled: false },
];
let root: Root;
let container: HTMLDivElement;
beforeEach(() => {
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});
afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

async function toggle(open: boolean) {
  const details = container.querySelector("details")!;
  await act(async () => {
    details.open = open;
    details.dispatchEvent(new Event("toggle", { bubbles: true }));
  });
}

it("holds a provider pick until the control closes, then sends one change with the model it showed", async () => {
  const onChoose = vi.fn();
  const onChangeProvider = vi.fn();
  const onChangeModel = vi.fn();
  await act(async () =>
    root.render(
      <CompactModelControl
        providerModelSummary="Fixture / fixture-chat"
        providers={providers}
        providerId="fixture"
        model="fixture-chat"
        disabled={false}
        onChangeProvider={onChangeProvider}
        onChangeModel={onChangeModel}
        onChoose={onChoose}
      />,
    ),
  );
  await toggle(true);
  const select = container.querySelector<HTMLSelectElement>('select[aria-label="Provider"]')!;
  await act(async () => {
    select.value = "other";
    select.dispatchEvent(new Event("change", { bubbles: true }));
  });
  expect(onChoose).not.toHaveBeenCalled();
  expect(onChangeProvider).not.toHaveBeenCalled();
  await toggle(false);
  expect(onChoose).toHaveBeenCalledExactlyOnceWith({ providerId: "other", model: "other-b" });
  expect(onChangeProvider).not.toHaveBeenCalled();
});

it("sends nothing when it closes without a changed pick", async () => {
  const onChoose = vi.fn();
  await act(async () =>
    root.render(
      <CompactModelControl
        providerModelSummary="Fixture / fixture-chat"
        providers={providers}
        providerId="fixture"
        model="fixture-chat"
        disabled={false}
        onChangeProvider={vi.fn()}
        onChangeModel={vi.fn()}
        onChoose={onChoose}
      />,
    ),
  );
  await toggle(true);
  await toggle(false);
  expect(onChoose).not.toHaveBeenCalled();
});
