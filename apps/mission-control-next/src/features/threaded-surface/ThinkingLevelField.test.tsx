// @vitest-environment happy-dom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { ThinkingLevelField } from "./ThinkingLevelField";

let root: Root;
let container: HTMLDivElement;
let onApply: ReturnType<typeof vi.fn<(level: string) => void>>;
beforeEach(() => {
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  onApply = vi.fn<(level: string) => void>();
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
        <ThinkingLevelField value="standard" supports={() => true} onApply={onApply} scope={scope} />
      </>,
    ),
  );
}
const select = () => container.querySelector<HTMLSelectElement>('select[aria-label="Thinking level"]')!;
async function arrowTo(...levels: string[]) {
  for (const level of levels)
    await act(async () => {
      select().value = level;
      select().dispatchEvent(new Event("change", { bubbles: true }));
    });
}

it("applies nothing while stepping through levels, says so, and Apply sends the last one once", async () => {
  await render();
  await arrowTo("extended", "deep", "minimal");
  expect(onApply).not.toHaveBeenCalled();
  expect(container.textContent).toContain("Not applied yet.");
  await act(async () =>
    [...container.querySelectorAll("button")].find((node) => node.textContent === "Apply")!.click(),
  );
  expect(onApply).toHaveBeenCalledExactlyOnceWith("minimal");
});

it("applies when focus leaves, discards on Escape and when the conversation changes", async () => {
  await render();
  await arrowTo("deep");
  await act(async () => {
    select().dispatchEvent(
      new FocusEvent("focusout", { bubbles: true, relatedTarget: document.getElementById("outside") }),
    );
  });
  expect(onApply).toHaveBeenCalledExactlyOnceWith("deep");

  onApply.mockClear();
  await arrowTo("extended");
  await act(async () => {
    select().dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true }));
  });
  expect(select().value).toBe("standard");
  expect(container.textContent).not.toContain("Not applied yet.");

  await arrowTo("max");
  await render("session-b");
  expect(container.textContent).not.toContain("Not applied yet.");
  expect(onApply).not.toHaveBeenCalled();
});

it("keeps the pick held when the whole window loses focus, and applies when focus moves within the page", async () => {
  await render();
  await arrowTo("deep");
  vi.spyOn(document, "hasFocus").mockReturnValue(false);
  await act(async () => {
    select().dispatchEvent(new FocusEvent("focusout", { bubbles: true, relatedTarget: null }));
  });
  expect(onApply).not.toHaveBeenCalled();
  expect(container.textContent).toContain("Not applied yet.");
  vi.spyOn(document, "hasFocus").mockReturnValue(true);
  await act(async () => {
    select().dispatchEvent(
      new FocusEvent("focusout", { bubbles: true, relatedTarget: document.getElementById("outside") }),
    );
  });
  expect(onApply).toHaveBeenCalledExactlyOnceWith("deep");
  vi.restoreAllMocks();
});

it("returns focus to the select after Apply", async () => {
  await render();
  await arrowTo("extended");
  await act(async () =>
    [...container.querySelectorAll("button")].find((node) => node.textContent === "Apply")!.click(),
  );
  expect(document.activeElement).toBe(select());
});
