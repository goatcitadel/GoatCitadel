// @vitest-environment happy-dom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { SetupSteps, type SetupStepView } from "./SetupSteps";

const STEPS: SetupStepView[] = [
  { id: "one", title: "Make it", state: "done", result: "Made it.", children: <p>Body one</p> },
  { id: "two", title: "Check it", state: "current", children: <p>Body two</p> },
  { id: "three", title: "Use it", state: "locked", result: "Used it.", children: <p>Body three</p> },
];

let root: Root;
let container: HTMLDivElement;

async function mount(steps: readonly SetupStepView[] = STEPS, status?: string) {
  await act(async () => {
    root.render(<SetupSteps steps={steps} status={status} />);
  });
}

const items = () => [...container.querySelectorAll<HTMLLIElement>("ol > li")];

beforeEach(() => {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

describe("SetupSteps", () => {
  it("numbers the steps from 1 in a list", async () => {
    await mount();
    expect(items()).toHaveLength(3);
    expect(items().map((item) => item.querySelector("h2")?.textContent)).toEqual([
      "1. Make it",
      "2. Check it",
      "3. Use it",
    ]);
  });

  it("marks only the current step", async () => {
    await mount();
    expect(items().map((item) => item.getAttribute("aria-current"))).toEqual([null, "step", null]);
    expect(container.querySelectorAll('[aria-current="step"]')).toHaveLength(1);
  });

  it("shows a current step's body and a done step's result, and a locked step only its title", async () => {
    await mount();
    const [done, current, locked] = items();
    expect(current!.textContent).toContain("Body two");
    expect(done!.textContent).toContain("Made it.");
    expect(done!.textContent).not.toContain("Body one");
    expect(locked!.textContent).toContain("Use it");
    expect(locked!.textContent).not.toContain("Body three");
    expect(locked!.textContent).not.toContain("Used it.");
  });

  it("shows a current step's result beside its body", async () => {
    await mount([{ id: "a", title: "Check", state: "current", result: "Key works.", children: <p>Fix it</p> }]);
    expect(items()[0]!.textContent).toContain("Key works.");
    expect(items()[0]!.textContent).toContain("Fix it");
  });

  it("says a step's state in words for those who cannot see the styling", async () => {
    await mount();
    const [done, , locked] = items();
    expect(done!.querySelector(".sr-only")?.textContent).toBe("Done");
    expect(locked!.querySelector(".sr-only")?.textContent).toBe("Locked");
  });

  it("has one status line, which carries the status", async () => {
    await mount(STEPS, "Key works. Your bot is @MyGoatBot.");
    const lines = container.querySelectorAll('[role="status"]');
    expect(lines).toHaveLength(1);
    expect(lines[0]!.textContent).toBe("Key works. Your bot is @MyGoatBot.");
  });

  it("keeps the status line in the page, empty, before there is anything to say", async () => {
    await mount();
    const lines = container.querySelectorAll('[role="status"]');
    expect(lines).toHaveLength(1);
    expect(lines[0]!.textContent).toBe("");
    expect(container.querySelector('[role="alert"], [aria-live]')).toBeNull();
  });

  it("does not render the same status twice when it changes", async () => {
    await mount(STEPS, "Working…");
    await mount(STEPS, "Done.");
    expect(container.querySelectorAll('[role="status"]')).toHaveLength(1);
    expect(container.querySelector('[role="status"]')!.textContent).toBe("Done.");
  });
});
