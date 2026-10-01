// @vitest-environment happy-dom
import { RUN_VARIABLE_SCHEMA_VERSION } from "@goatcitadel/contracts";
import type { MissionThreadedActiveSessionSurfaceProps } from "@goatcitadel/threaded-surface-core";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { ChatRunVariables } from "./ChatRunVariables";

type Panel = NonNullable<MissionThreadedActiveSessionSurfaceProps["runVariablePanel"]>;
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
function panel(overrides: Partial<Panel> = {}): Panel {
  return {
    open: true,
    title: "Launch brief",
    schema: {
      version: RUN_VARIABLE_SCHEMA_VERSION,
      fields: [
        { id: "topic", label: "Topic", type: "multiline", required: true, description: "Subject of the brief." },
        { id: "count", label: "Count", type: "number", minimum: 1, maximum: 5 },
        { id: "public", label: "Public", type: "boolean", description: "Include public sources." },
        { id: "format", label: "Format", type: "select", options: [{ value: "brief", label: "Brief" }] },
      ],
    },
    values: { topic: "lease recovery", count: 2, public: false, format: "brief" },
    preview: "Explain lease recovery in a brief format.",
    error: null,
    onValueChange: vi.fn(),
    onApply: vi.fn(),
    onClose: vi.fn(),
    ...overrides,
  };
}
function input(label: string): HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement {
  const control = container.querySelector(`[aria-label="${label}"]`);
  if (
    !(
      control instanceof HTMLInputElement ||
      control instanceof HTMLTextAreaElement ||
      control instanceof HTMLSelectElement
    )
  )
    throw new Error(`Missing ${label}`);
  return control;
}
async function change(label: string, value: string) {
  const control = input(label);
  await act(async () => {
    Object.getOwnPropertyDescriptor(Object.getPrototypeOf(control), "value")?.set?.call(control, value);
    control.dispatchEvent(new Event(control instanceof HTMLSelectElement ? "change" : "input", { bubbles: true }));
  });
}

it("preserves typed bindings and clear values through the controller callbacks", async () => {
  const props = panel();
  await act(async () => root.render(<ChatRunVariables panel={props} />));
  const count = input("Count") as HTMLInputElement;
  expect(count.type).toBe("number");
  expect(count.min).toBe("1");
  expect(count.max).toBe("5");
  await change("Count", "4");
  expect(props.onValueChange).toHaveBeenLastCalledWith("count", 4);
  await change("Count", "");
  expect(props.onValueChange).toHaveBeenLastCalledWith("count", undefined);
  await act(async () => (input("Public") as HTMLInputElement).click());
  expect(props.onValueChange).toHaveBeenLastCalledWith("public", true);
  await change("Format", "");
  expect(props.onValueChange).toHaveBeenLastCalledWith("format", undefined);
  await change("Topic", "new subject");
  expect(props.onValueChange).toHaveBeenLastCalledWith("topic", "new subject");
  expect(props.onApply).not.toHaveBeenCalled();
});

it("keeps help associations distinct between mounted forms and delegates review/apply/close", async () => {
  const props = panel({ error: "Topic is required." });
  await act(async () =>
    root.render(
      <>
        <ChatRunVariables panel={props} />
        <ChatRunVariables panel={panel()} />
      </>,
    ),
  );
  const controls = [...container.querySelectorAll<HTMLInputElement>('[aria-label="Public"]')];
  const ids = controls.map((control) => control.getAttribute("aria-describedby"));
  expect(new Set(ids).size).toBe(2);
  for (const id of ids) expect(document.getElementById(id!)?.textContent).toBe("Include public sources.");
  expect(container.querySelector('[role="alert"]')?.textContent).toBe("Topic is required.");
  expect(container.textContent).toContain(props.preview);
  const buttons = [...container.querySelectorAll<HTMLButtonElement>("button")];
  await act(async () => buttons.find((button) => button.textContent === "Apply variables")!.click());
  expect(props.onApply).toHaveBeenCalledOnce();
  await act(async () => buttons.find((button) => button.textContent === "Close")!.click());
  expect(props.onClose).toHaveBeenCalledOnce();
  await act(async () => root.render(<ChatRunVariables panel={panel({ open: false })} />));
  expect(container.textContent).toBe("");
});
