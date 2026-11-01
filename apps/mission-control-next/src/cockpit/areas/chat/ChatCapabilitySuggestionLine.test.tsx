// @vitest-environment happy-dom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ChatCapabilityUpgradeSuggestion } from "@goatcitadel/contracts";
import { ChatCapabilitySuggestionLine, selectTurnCapabilitySuggestions } from "./ChatCapabilitySuggestionLine";

function suggestion(
  title: string,
  extra: Partial<ChatCapabilityUpgradeSuggestion> = {},
): ChatCapabilityUpgradeSuggestion {
  return {
    kind: "skill_import",
    title,
    summary: `${title} summary`,
    reason: `${title} reason`,
    recommendedAction: "install_skill_enable",
    requiresUserApproval: true,
    ...extra,
  };
}

const first = suggestion("Read PDFs");
const second = suggestion("Check spelling");
const third = suggestion("Fetch weather");

let root: Root;
let container: HTMLDivElement;
const onAction = vi.fn();
const onDismiss = vi.fn();

async function render(suggestions: ChatCapabilityUpgradeSuggestion[]) {
  await act(async () =>
    root.render(<ChatCapabilitySuggestionLine suggestions={suggestions} onAction={onAction} onDismiss={onDismiss} />),
  );
}
const button = (label: string) =>
  [...container.querySelectorAll("button")].find((b) =>
    (b.getAttribute("aria-label") ?? b.textContent)?.includes(label),
  );

beforeEach(() => {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
});
afterEach(() => {
  act(() => root.unmount());
  container.remove();
  vi.clearAllMocks();
});

describe("ChatCapabilitySuggestionLine", () => {
  it("renders nothing for an empty list", async () => {
    await render([]);
    expect(container.textContent).toBe("");
  });

  it("renders one quiet row for the first suggestion", async () => {
    await render([first, second]);
    expect(container.textContent).toContain("Read PDFs");
    expect(container.textContent).not.toContain("Check spelling");
    expect(button("Dismiss suggestion: Read PDFs")).toBeDefined();
    expect(container.querySelector("details")?.open).toBe(false);
  });

  it("keeps the summary and reason behind Why?", async () => {
    await render([first]);
    const details = container.querySelector("details");
    expect(details?.querySelector("summary")?.textContent).toBe("Why?");
    expect(details?.textContent).toContain("Read PDFs summary");
    expect(details?.textContent).toContain("Read PDFs reason");
  });

  it("+N more expands the rest", async () => {
    await render([first, second, third]);
    await act(async () => button("+2 more")!.click());
    expect(container.textContent).toContain("Check spelling");
    expect(container.textContent).toContain("Fetch weather");
    expect(button("+2 more")).toBeUndefined();
  });

  it("clicking the title calls onAction with that suggestion", async () => {
    await render([first, second]);
    await act(async () => button("Read PDFs")!.click());
    expect(onAction).toHaveBeenCalledWith(first);
  });

  it("dismiss calls onDismiss with that suggestion", async () => {
    await render([first]);
    await act(async () => button("Dismiss suggestion: Read PDFs")!.click());
    expect(onDismiss).toHaveBeenCalledWith(first);
  });

  it("is a named group for assistive technology", async () => {
    await render([first]);
    expect(container.querySelector('[role="group"][aria-label="Suggested capabilities"]')).not.toBeNull();
  });

  it("moves focus to the next suggestion when one is dismissed", async () => {
    await render([first, second, third]);
    await act(async () => button("+2 more")!.click());
    act(() => button("Dismiss suggestion: Read PDFs")!.focus());
    await act(async () => button("Dismiss suggestion: Read PDFs")!.click());
    // The parent drops the dismissed suggestion.
    await render([second, third]);
    expect(document.activeElement).toBe(button("Check spelling"));
  });

  it("moves focus to the first suggestion it shows when +N more expands", async () => {
    await render([first, second, third]);
    act(() => button("+2 more")!.focus());
    await act(async () => button("+2 more")!.click());
    expect(document.activeElement).toBe(button("Check spelling"));
  });
});

describe("selectTurnCapabilitySuggestions", () => {
  const actions = { capabilitySuggestions: [first], historicalReadOnly: false, selectedTurnId: "t1" };
  it("offers them on the selected turn", () => {
    expect(selectTurnCapabilitySuggestions(actions, "t1", false)).toEqual([first]);
  });
  it("offers them on the latest turn when none is selected", () => {
    expect(selectTurnCapabilitySuggestions({ ...actions, selectedTurnId: null }, "t2", true)).toEqual([first]);
  });
  it("offers nothing on another turn", () => {
    expect(selectTurnCapabilitySuggestions(actions, "t2", true)).toEqual([]);
  });
  it("offers nothing on a historical turn", () => {
    expect(selectTurnCapabilitySuggestions({ ...actions, historicalReadOnly: true }, "t1", true)).toEqual([]);
  });
});
