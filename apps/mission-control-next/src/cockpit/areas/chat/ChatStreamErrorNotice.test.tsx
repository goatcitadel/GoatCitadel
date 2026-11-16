// @vitest-environment happy-dom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ChatStreamErrorNotice } from "./ChatStreamErrorNotice";

vi.mock("@goatcitadel/mission-control-shared/state/ui-preferences", () => ({
  useUiPreferences: () => ({ showTechnicalDetails: true }),
}));

let root: Root;
let container: HTMLDivElement;
beforeEach(() => {
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});
afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

describe("Chat stream error notice", () => {
  it("shows plain-language copy for a recognized network failure", async () => {
    await act(async () => root.render(<ChatStreamErrorNotice error="Failed to fetch" source="send" />));
    expect(container.querySelector('[role="alert"]')?.textContent).toContain("Can't reach the GoatCitadel gateway");
    expect(container.querySelector("details")).toBeNull();
  });

  it("keeps the generic sentence and tucks an unrecognized raw error behind technical details", async () => {
    await act(async () => root.render(<ChatStreamErrorNotice error="E_WEIRD_42 internal" source="other" />));
    expect(container.textContent).toContain("The request failed.");
    const details = container.querySelector("details");
    expect(details?.querySelector("summary")?.textContent).toBe("Technical details");
    expect(details?.textContent).toContain("E_WEIRD_42 internal");
    expect(container.querySelector("button")).toBeNull();
  });

  it("offers Reload conversation, which re-reads the conversation without resending (CH-22)", async () => {
    const onReload = vi.fn();
    await act(async () =>
      root.render(<ChatStreamErrorNotice error="stream disconnected" source="send" onReload={onReload} />),
    );
    const reload = [...container.querySelectorAll("button")].find((b) => b.textContent === "Reload conversation");
    expect(reload).toBeDefined();
    await act(async () => reload!.click());
    expect(onReload).toHaveBeenCalledTimes(1);
  });

  it("links a missing-model failure to setup instead of offering a reload that cannot help", async () => {
    await act(async () =>
      root.render(<ChatStreamErrorNotice error="No model provider is configured." source="send" onReload={vi.fn()} />),
    );
    expect(container.textContent).toContain("The run cannot start because no provider is configured.");
    expect(container.querySelector('a[href^="/settings/first-run"]')?.textContent).toBe("Set up a model");
    expect([...container.querySelectorAll("button")].some((item) => item.textContent === "Reload conversation")).toBe(
      false,
    );
  });

  it("says when another message is still being sent (U-CH-022)", async () => {
    const raw =
      "A chat turn write is already in progress for session session-1. Wait for the current agent-send to finish and retry.";
    await act(async () => root.render(<ChatStreamErrorNotice error={raw} source="send" />));
    expect(container.textContent).toContain("Another message is still being sent in this conversation.");
    expect(container.textContent).not.toContain("The response was interrupted");
    expect(container.querySelector("details")).toBeNull();
  });
});
