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
// The create owner is covered by its own tests (it focuses its Title field); here it only offers Close.
vi.mock("./WorkTaskCreate", () => ({
  WorkTaskCreate: ({ onClose }: { onClose: () => void }) => (
    <button type="button" onClick={onClose}>
      Close new task
    </button>
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

describe("WK-06 Work board counts", () => {
  const countOf = (title: string) =>
    container.querySelector(`section[aria-label="${title}"]`)!.querySelector("h2 + span")!.textContent;

  it("counts what the filters leave and says when the Done list is capped", async () => {
    vi.mocked(fetchTasks).mockResolvedValue({
      items: [
        task("a", "Outline release"),
        task("b", "Draft notes"),
        ...Array.from({ length: 30 }, (_, index) => ({ ...task(`d${index}`, `Shipped ${index}`), status: "done" })),
      ],
    } as never);
    await act(async () =>
      root.render(
        <QueryClientProvider client={client}>
          <WorkBoard />
        </QueryClientProvider>,
      ),
    );
    await vi.waitFor(() => expect(countOf("Active")).toBe("2 tasks · 0 runs"));
    expect(countOf("Done")).toBe("25 of 30 tasks shown · 0 runs");

    await setValue("Search loaded work", "notes");
    expect(countOf("Active")).toBe("1 matching task · 0 matching runs");
    expect(countOf("Done")).toBe("0 matching tasks · 0 matching runs");
    expect(container.querySelector('section[aria-label="Done"]')!.textContent).toContain(
      "Nothing here matches the filter.",
    );

    await setValue("Search loaded work", "");
    await setValue("Record type", "run");
    expect(countOf("Active")).toBe("0 runs");
  });
});

describe("WK-12 New task focus", () => {
  it("returns focus to New task when the form closes", async () => {
    await act(async () =>
      root.render(
        <QueryClientProvider client={client}>
          <WorkBoard />
        </QueryClientProvider>,
      ),
    );
    const newTask = () =>
      [...container.querySelectorAll<HTMLButtonElement>("button")].find((button) => button.textContent === "New task")!;
    await vi.waitFor(() => expect(newTask().disabled).toBe(false));
    await act(async () => newTask().click());
    const close = [...container.querySelectorAll<HTMLButtonElement>("button")].find(
      (button) => button.textContent === "Close new task",
    )!;
    await act(async () => close.click());
    expect(document.activeElement).toBe(newTask());
  });
});

describe("WK-N05 empty board", () => {
  it("shows one board-level empty state with New task instead of empty columns", async () => {
    vi.mocked(fetchTasks).mockResolvedValue({ items: [] } as never);
    await act(async () =>
      root.render(
        <QueryClientProvider client={client}>
          <WorkBoard />
        </QueryClientProvider>,
      ),
    );
    await vi.waitFor(() => expect(container.textContent).toContain("No tasks or runs yet"));
    for (const title of ["Active", "Needs attention", "Failed runs", "Done"])
      expect(container.querySelector(`section[aria-label="${title}"]`)).toBeNull();
    expect(container.textContent).not.toContain("No recent work in this state.");
    expect(container.querySelector('input[type="search"]')).toBeNull();
    // Bulk selection hides until there are rows.
    expect(
      [...container.querySelectorAll("button")].some((button) => button.textContent?.trim() === "Select tasks"),
    ).toBe(false);
    const empty = [...container.querySelectorAll("section")].find((section) =>
      section.textContent?.startsWith("No tasks or runs yet"),
    )!;
    const action = [...empty.querySelectorAll<HTMLButtonElement>("button")].find(
      (button) => button.textContent === "New task",
    )!;
    await vi.waitFor(() => expect(action.disabled).toBe(false));
    await act(async () => action.click());
    expect(container.textContent).toContain("Close new task");
  });

  it("keeps the columns once any task is loaded", async () => {
    await act(async () =>
      root.render(
        <QueryClientProvider client={client}>
          <WorkBoard />
        </QueryClientProvider>,
      ),
    );
    await vi.waitFor(() => expect(container.textContent).toContain("Outline release"));
    expect(container.textContent).not.toContain("No tasks or runs yet");
    expect(container.querySelector('section[aria-label="Needs attention"]')).not.toBeNull();
    expect(
      [...container.querySelectorAll("button")].some((button) => button.textContent?.trim() === "Select tasks"),
    ).toBe(true);
  });
});
