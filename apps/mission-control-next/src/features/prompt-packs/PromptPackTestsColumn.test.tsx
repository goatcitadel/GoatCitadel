// @vitest-environment happy-dom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { PromptPackTestRecord } from "@goatcitadel/contracts";
import { PromptPackTestsColumn, type PromptPackTestsColumnProps } from "./PromptPackTestsColumn";

const test = (testId: string, code: string): PromptPackTestRecord =>
  ({ testId, code, title: `Test ${code}`, prompt: "Say hello" }) as unknown as PromptPackTestRecord;

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

describe("prompt-pack tests column", () => {
  it("gives every test row list-item semantics inside the tests list", async () => {
    const props = {
      testsLength: 2,
      filteredTests: [test("t-1", "A1"), test("t-2", "A2")],
      testResultFilter: "all",
      testOutcomeSummary: {},
      latestRunByTest: new Map(),
      latestAssessmentByTest: new Map(),
      selectedTestId: "t-1",
      activeRun: null,
      running: false,
      onSetTestResultFilter: vi.fn(),
      onSelectTest: vi.fn(),
      onRunOne: vi.fn(),
    } as unknown as PromptPackTestsColumnProps;
    await act(async () => root.render(<PromptPackTestsColumn {...props} />));
    const list = container.querySelector('[role="list"][aria-label="Prompt pack tests"]')!;
    const rows = [...list.children];
    expect(rows).toHaveLength(2);
    expect(rows.every((row) => row.getAttribute("role") === "listitem")).toBe(true);
  });
  it("keeps the empty-filter message outside the list", async () => {
    const props = {
      testsLength: 0,
      filteredTests: [],
      testResultFilter: "all",
      testOutcomeSummary: {},
      latestRunByTest: new Map(),
      latestAssessmentByTest: new Map(),
      selectedTestId: null,
      activeRun: null,
      running: false,
      onSetTestResultFilter: vi.fn(),
      onSelectTest: vi.fn(),
      onRunOne: vi.fn(),
    } as unknown as PromptPackTestsColumnProps;
    await act(async () => root.render(<PromptPackTestsColumn {...props} />));
    const list = container.querySelector('[role="list"][aria-label="Prompt pack tests"]');
    expect(list?.children.length ?? 0).toBe(0);
    expect(container.textContent).toContain("No tests match this filter.");
  });
});
