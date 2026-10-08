// @vitest-environment happy-dom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Dialog } from "./Dialog";

let root: Root;
let container: HTMLDivElement;

beforeEach(() => {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

describe("Dialog", () => {
  it("renders a named dialog and a close control", () => {
    act(() => {
      root.render(
        <Dialog open onOpenChange={vi.fn()} title="Command palette">
          <p>Body</p>
        </Dialog>,
      );
    });
    const dialog = document.body.querySelector('[role="dialog"]');
    expect(dialog).not.toBeNull();
    expect(dialog?.textContent).toContain("Command palette");
    expect(dialog?.querySelector('button[aria-label="Close dialog"]')).not.toBeNull();
  });
});

it("restores focus for a controlled dialog without a Radix trigger", async () => {
  const trigger = document.createElement("button");
  document.body.append(trigger);
  trigger.focus();
  try {
    await act(async () =>
      root.render(
        <Dialog open onOpenChange={vi.fn()} title="Review">
          <button type="button">Review action</button>
        </Dialog>,
      ),
    );
    await act(async () =>
      root.render(
        <Dialog open={false} onOpenChange={vi.fn()} title="Review">
          <button type="button">Review action</button>
        </Dialog>,
      ),
    );
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 5));
    });
    expect(document.activeElement).toBe(trigger);
  } finally {
    trigger.remove();
  }
});
it("keeps an explicit close-focus callback authoritative", async () => {
  const callback = vi.fn((event: Event) => event.preventDefault());
  await act(async () =>
    root.render(
      <Dialog open onOpenChange={vi.fn()} onCloseAutoFocus={callback} title="Review">
        <button type="button">Review action</button>
      </Dialog>,
    ),
  );
  await act(async () =>
    root.render(
      <Dialog open={false} onOpenChange={vi.fn()} onCloseAutoFocus={callback} title="Review">
        <button type="button">Review action</button>
      </Dialog>,
    ),
  );
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 5));
  });
  expect(callback).toHaveBeenCalledOnce();
});
