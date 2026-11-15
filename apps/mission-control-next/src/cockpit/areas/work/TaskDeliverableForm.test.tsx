// @vitest-environment happy-dom
import { act, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { TaskRecord } from "@goatcitadel/mission-control-shared/api/types";
import { addTaskDeliverable } from "@goatcitadel/mission-control-shared/api/tasks";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { TaskDeliverableForm } from "./TaskDeliverableForm";

vi.mock("@goatcitadel/mission-control-shared/api/tasks", () => ({ addTaskDeliverable: vi.fn() }));

const task = (): TaskRecord => ({
  taskId: "task-a",
  revision: 2,
  workspaceId: "workspace-a",
  title: "Scoped task",
  status: "review",
  priority: "normal",
  createdAt: "2026-09-29T00:00:00.000Z",
  updatedAt: "2026-09-29T01:00:00.000Z",
});

let container: HTMLDivElement;
let root: Root;
let client: QueryClient;

beforeEach(() => {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
});

afterEach(() => {
  act(() => root.unmount());
  client.clear();
  container.remove();
  vi.clearAllMocks();
});

async function render(node: ReactNode) {
  await act(async () => root.render(<QueryClientProvider client={client}>{node}</QueryClientProvider>));
}

function field(label: string): HTMLInputElement | HTMLSelectElement {
  const match = [...container.querySelectorAll("label")].find((entry) => entry.textContent?.startsWith(label));
  const control = match?.htmlFor ? document.getElementById(match.htmlFor) : null;
  if (!control) throw new Error(`Missing field ${label}`);
  return control as HTMLInputElement | HTMLSelectElement;
}

async function type(control: HTMLInputElement | HTMLSelectElement, value: string) {
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set;
  await act(async () => {
    setter?.call(control, value);
    control.dispatchEvent(new Event("input", { bubbles: true }));
  });
}

async function choose(control: HTMLInputElement | HTMLSelectElement, value: string) {
  await act(async () => {
    control.value = value;
    control.dispatchEvent(new Event("change", { bubbles: true }));
  });
}

function buttonNamed(name: string): HTMLButtonElement {
  const match = [...container.querySelectorAll("button")].find((entry) => entry.textContent === name);
  if (!match) throw new Error(`Missing button ${name}`);
  return match;
}

async function click(name: string) {
  await act(async () => buttonNamed(name).click());
}

describe("TaskDeliverableForm", () => {
  it("records a deliverable for the task in its workspace and says Done is now available", async () => {
    vi.mocked(addTaskDeliverable).mockResolvedValue({
      deliverableId: "d-1",
      taskId: "task-a",
      deliverableType: "url",
      title: "Report",
      createdAt: "2026-11-15T00:00:00Z",
    });
    await render(<TaskDeliverableForm task={task()} workspaceId="workspace-a" />);
    await type(field("Title"), "  Report  ");
    await choose(field("Kind"), "url");
    await type(field("File path or link (optional)"), "https://example.com/report");
    await click("Record deliverable");
    expect(addTaskDeliverable).toHaveBeenCalledWith("task-a", {
      workspaceId: "workspace-a",
      title: "Report",
      deliverableType: "url",
      path: "https://example.com/report",
    });
    await vi.waitFor(() =>
      expect(container.textContent).toContain("Deliverable recorded. You can now mark the task Done."),
    );
    expect((field("Title") as HTMLInputElement).value).toBe("");
  });

  it("keeps Record deliverable off until the title has text", async () => {
    await render(<TaskDeliverableForm task={task()} workspaceId="workspace-a" />);
    expect(buttonNamed("Record deliverable").disabled).toBe(true);
    await type(field("Title"), "   ");
    expect(buttonNamed("Record deliverable").disabled).toBe(true);
  });

  it("says what went wrong and keeps the draft when the Gateway refuses", async () => {
    vi.mocked(addTaskDeliverable).mockRejectedValue(new Error("The task was archived."));
    await render(<TaskDeliverableForm task={task()} workspaceId="workspace-a" />);
    await type(field("Title"), "Report");
    await click("Record deliverable");
    await vi.waitFor(() => expect(container.textContent).toContain("Couldn't record the deliverable."));
    expect((field("Title") as HTMLInputElement).value).toBe("Report");
  });
});
