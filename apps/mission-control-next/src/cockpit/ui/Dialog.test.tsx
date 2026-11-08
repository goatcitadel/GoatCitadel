// @vitest-environment happy-dom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Dialog } from "./Dialog";

const runtime = vi.hoisted(() => {
  let release!: () => void;
  const ready = new Promise<void>((resolve) => {
    release = resolve;
  });
  return { called: vi.fn(), ready, release };
});

vi.mock("./DialogRuntime", async (importOriginal) => {
  runtime.called();
  await runtime.ready;
  return importOriginal();
});

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
  it("loads only when opened and exposes only dismissal while the real controls load", async () => {
    const onOpenChange = vi.fn();
    const render = (open: boolean) =>
      root.render(
        <Dialog open={open} onOpenChange={onOpenChange} title="Command palette">
          <button type="button">Run action</button>
        </Dialog>,
      );
    await act(async () => render(false));
    expect(runtime.called).not.toHaveBeenCalled();
    await act(async () => render(true));
    await vi.waitFor(() => expect(runtime.called).toHaveBeenCalledOnce());
    const pending = document.body.querySelector<HTMLDialogElement>('dialog[role="dialog"]');
    expect(pending?.open).toBe(true);
    expect(pending?.getAttribute("aria-modal")).toBe("true");
    expect(pending?.textContent).toContain("Loading dialog controls");
    expect(pending?.textContent).not.toContain("Run action");
    act(() => {
      pending?.querySelector<HTMLButtonElement>('button[aria-label="Close dialog"]')?.click();
    });
    expect(onOpenChange).toHaveBeenCalledWith(false);
    await act(async () => render(false));
    await act(async () => runtime.release());
    expect(document.body.querySelector('[role="dialog"]')).toBeNull();
    await act(async () => render(true));
    await vi.waitFor(() => expect(document.body.querySelector('[role="dialog"]')?.textContent).toContain("Run action"));
    const dialog = document.body.querySelector('[role="dialog"]');
    expect(dialog).not.toBeNull();
    expect(dialog?.getAttribute("aria-modal")).toBe("true");
    expect(dialog?.textContent).toContain("Command palette");
    expect(dialog?.querySelector('button[aria-label="Close dialog"]')).not.toBeNull();
    // SH-07: a side gutter and a short top offset on phones instead of edge-to-edge at top-24.
    const classes = dialog?.className.split(/\s+/) ?? [];
    expect(classes).toEqual(expect.arrayContaining(["inset-x-4", "mx-auto", "top-4", "sm:top-24", "max-w-xl"]));
    expect(classes).not.toContain("w-full");
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
