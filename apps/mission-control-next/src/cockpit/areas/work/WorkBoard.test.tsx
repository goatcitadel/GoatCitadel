// @vitest-environment happy-dom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fetchDurableRunHistory } from "@goatcitadel/mission-control-shared/api/durable";
import { fetchTasks } from "@goatcitadel/mission-control-shared/api/tasks";
import { WorkBoard } from "./WorkBoard";

vi.mock("./WorkWaitingDecisions", () => ({ WorkWaitingDecisions: () => null }));
// The bulk owner is covered by its own tests; here it only reports which tasks it would act on.
vi.mock("./WorkTaskBulkActions", () => ({
  WorkTaskBulkActions: ({ selected }: { selected: { taskId: string }[] }) => (
    <p data-testid="bulk-targets">{selected.map((task) => task.taskId).join(",") || "none"}</p>
  ),
}));
vi.mock("@goatcitadel/mission-control-shared/api/durable", () => ({ fetchDurableRunHistory: vi.fn() }));
vi.mock("@goatcitadel/mission-control-shared/api/tasks", () => ({ fetchTasks: vi.fn() }));
vi.mock("@goatcitadel/mission-control-shared/state/ui-preferences", () => ({
  useUiPreferences: () => ({ activeWorkspaceId: "workspace-a" }),
}));
vi.mock("../../app/use-cockpit-route", () => ({ useCockpitRoute: () => ({ rest: [], navigate: vi.fn() }) }));

let container: HTMLDivElement;
let root: Root;
let client: QueryClient;
const viewport = (stacked: boolean) =>
  vi.stubGlobal("matchMedia", (media: string) => ({
    media,
    matches: stacked && media.includes("width <"),
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
  }));

const task = (taskId: string, title: string) => ({
  taskId,
  revision: 1,
  workspaceId: "workspace-a",
  title,
  status: "planning",
  priority: "normal",
  createdAt: "2026-10-06",
  updatedAt: "2026-10-06",
});

beforeEach(() => {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  viewport(false);
  client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  vi.mocked(fetchDurableRunHistory).mockResolvedValue({ items: [] } as never);
  vi.mocked(fetchTasks).mockResolvedValue({
    items: [task("a", "Outline release"), task("b", "Draft notes"), task("c", "Draft summary")],
  } as never);
});

afterEach(() => {
  act(() => root.unmount());
  client.clear();
  container.remove();
  vi.clearAllMocks();
  vi.unstubAllGlobals();
});

const targets = () => container.querySelector('[data-testid="bulk-targets"]')?.textContent;
async function setValue(label: string, value: string) {
  const id = [...container.querySelectorAll("label")].find((item) => item.textContent === label)!.htmlFor;
  const field = document.getElementById(id) as HTMLInputElement | HTMLSelectElement;
  await act(async () => {
    if (field instanceof HTMLSelectElement) {
      field.value = value;
      field.dispatchEvent(new Event("change", { bubbles: true }));
    } else {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(field, value);
      field.dispatchEvent(new Event("input", { bubbles: true }));
    }
  });
}
async function check(title: string) {
  const box = [...container.querySelectorAll("label")]
    .find((item) => item.textContent?.includes(title))!
    .querySelector("input")!;
  await act(async () => box.click());
}

describe("Work board selection", () => {
  it("applies a bulk action only to selected tasks that are visible and names the hidden ones", async () => {
    await act(async () =>
      root.render(
        <QueryClientProvider client={client}>
          <WorkBoard />
        </QueryClientProvider>,
      ),
    );
    await vi.waitFor(() => expect(container.textContent).toContain("Outline release"));
    const select = [...container.querySelectorAll<HTMLButtonElement>("button")].find(
      (button) => button.textContent === "Select tasks",
    )!;
    await act(async () => select.click());
    await check("Outline release");
    await check("Draft notes");
    await check("Draft summary");
    expect(targets()).toBe("a,b,c");

    await setValue("Search loaded work", "notes");
    expect(targets()).toBe("b");
    expect(container.textContent).toContain("2 selected tasks are hidden by the filter and won't change.");

    await setValue("Search loaded work", "draft");
    expect(targets()).toBe("b,c");
    expect(container.textContent).toContain("1 selected task is hidden by the filter and won't change.");

    await setValue("Search loaded work", "");
    await setValue("Record type", "run");
    expect(targets()).toBe("none");
    expect(container.textContent).toContain("3 selected tasks are hidden by the filter and won't change.");

    await setValue("Record type", "all");
    expect(targets()).toBe("a,b,c");
    expect(container.textContent).not.toContain("hidden by the filter");
  });
});

describe("Work board on narrow widths", () => {
  it("shows one column at a time with a named, counted column picker", async () => {
    viewport(true);
    await act(async () =>
      root.render(
        <QueryClientProvider client={client}>
          <WorkBoard />
        </QueryClientProvider>,
      ),
    );
    const picker = () => container.querySelector('[role="group"][aria-label="Board column"]')!;
    await vi.waitFor(() => expect(picker()).not.toBeNull());
    const choice = (title: string) =>
      [...picker().querySelectorAll("button")].find((button) => button.textContent?.startsWith(title))!;
    expect(choice("Needs attention").getAttribute("aria-pressed")).toBe("true");
    expect(choice("Active").textContent).toBe("Active 3");
    expect(container.querySelectorAll("section[aria-label]").length).toBe(1);
    expect(container.querySelector('section[aria-label="Needs attention"]')).not.toBeNull();
    expect(container.textContent).not.toContain("Outline release");

    await act(async () => choice("Active").click());
    expect(choice("Active").getAttribute("aria-pressed")).toBe("true");
    expect(container.querySelector('section[aria-label="Active"]')).not.toBeNull();
    expect(container.querySelector('section[aria-label="Needs attention"]')).toBeNull();
    expect(container.textContent).toContain("Outline release");
  });

  it("keeps all four columns and no picker at desktop width", async () => {
    await act(async () =>
      root.render(
        <QueryClientProvider client={client}>
          <WorkBoard />
        </QueryClientProvider>,
      ),
    );
    await vi.waitFor(() => expect(container.textContent).toContain("Outline release"));
    expect(container.querySelector('[aria-label="Board column"]')).toBeNull();
    for (const title of ["Active", "Needs attention", "Failed runs", "Done"])
      expect(container.querySelector(`section[aria-label="${title}"]`)).not.toBeNull();
  });
});
