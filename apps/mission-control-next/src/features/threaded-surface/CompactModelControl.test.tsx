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
type Choose = (choice: { providerId?: string; model?: string }) => void;
let onChoose: ReturnType<typeof vi.fn<Choose>>;
let onChangeProvider: ReturnType<typeof vi.fn<(providerId: string) => void>>;
beforeEach(() => {
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  onChoose = vi.fn<Choose>();
  onChangeProvider = vi.fn<(providerId: string) => void>();
});
afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

async function render(scope = "session-a") {
  await act(async () =>
    root.render(
      <>
        <button id="outside" type="button">
          Outside
        </button>
        <CompactModelControl
          providerModelSummary="Fixture / fixture-chat"
          providers={providers}
          providerId="fixture"
          model="fixture-chat"
          disabled={false}
          onChangeProvider={onChangeProvider}
          onChangeModel={vi.fn()}
          onChoose={onChoose}
          scope={scope}
        />
      </>,
    ),
  );
}
const select = () => container.querySelector<HTMLSelectElement>('select[aria-label="Provider"]')!;
const text = () => container.textContent ?? "";
const applyButton = () => [...container.querySelectorAll("button")].find((node) => node.textContent === "Apply");
async function toggle(open: boolean) {
  const details = container.querySelector("details")!;
  await act(async () => {
    details.open = open;
    details.dispatchEvent(new Event("toggle", { bubbles: true }));
  });
}
async function pick(value = "other") {
  await toggle(true);
  await act(async () => {
    select().value = value;
    select().dispatchEvent(new Event("change", { bubbles: true }));
  });
}

it("says a pick is not applied yet and sends nothing", async () => {
  await render();
  await pick();
  expect(text()).toContain("Not applied yet.");
  expect(select().value).toBe("other");
  expect(onChoose).not.toHaveBeenCalled();
  expect(onChangeProvider).not.toHaveBeenCalled();
  // Plain text, not a live region.
  expect(container.querySelector('[role="status"], [role="alert"], [aria-live]')).toBeNull();
});

it("sends one change, with the model it showed, when Apply is pressed", async () => {
  await render();
  await pick();
  await act(async () => applyButton()!.click());
  expect(onChoose).toHaveBeenCalledExactlyOnceWith({ providerId: "other", model: "other-b" });
  expect(text()).not.toContain("Not applied yet.");
});

it("sends one change when focus leaves the control", async () => {
  await render();
  await pick();
  const outside = document.getElementById("outside")!;
  await act(async () => {
    select().dispatchEvent(new FocusEvent("focusout", { bubbles: true, relatedTarget: outside }));
  });
  expect(onChoose).toHaveBeenCalledExactlyOnceWith({ providerId: "other", model: "other-b" });
});

it("keeps the pick while focus moves inside the control", async () => {
  await render();
  await pick();
  await act(async () => {
    select().dispatchEvent(
      new FocusEvent("focusout", { bubbles: true, relatedTarget: container.querySelector("summary") }),
    );
  });
  expect(onChoose).not.toHaveBeenCalled();
  expect(text()).toContain("Not applied yet.");
});

it("sends one change when the control is closed", async () => {
  await render();
  await pick();
  await toggle(false);
  expect(onChoose).toHaveBeenCalledExactlyOnceWith({ providerId: "other", model: "other-b" });
});

it("discards the pick on Escape and shows what the Chat uses again", async () => {
  await render();
  await pick();
  await act(async () => {
    select().dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true }));
  });
  expect(select().value).toBe("fixture");
  expect(text()).not.toContain("Not applied yet.");
  await toggle(false);
  expect(onChoose).not.toHaveBeenCalled();
});

it("drops a held pick when the conversation changes, and applies it to nothing", async () => {
  await render("session-a");
  await pick();
  await render("session-b");
  expect(text()).not.toContain("Not applied yet.");
  await toggle(false);
  expect(onChoose).not.toHaveBeenCalled();
});

it("drops a held pick when the control goes away", async () => {
  await render();
  await pick();
  act(() => root.render(null));
  expect(onChoose).not.toHaveBeenCalled();
});

it("sends nothing when it closes without a changed pick", async () => {
  await render();
  await toggle(true);
  await toggle(false);
  expect(onChoose).not.toHaveBeenCalled();
});
