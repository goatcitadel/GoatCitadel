// @vitest-environment happy-dom
import type { ChatCapabilityUpgradeSuggestion } from "@goatcitadel/contracts";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { expect, it, vi } from "vitest";
import { DeferredChatCapabilitySuggestionLine } from "./DeferredChatCapabilitySuggestionLine";

const code = vi.hoisted(() => {
  let release!: () => void;
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  return { start: vi.fn(), held, release };
});
vi.mock("./ChatCapabilitySuggestionLine", async (importOriginal) => {
  code.start();
  await code.held;
  return importOriginal();
});

it("loads on the first suggestion and retains expanded state without stealing focus after an empty update", async () => {
  const suggestions = ["Read PDFs", "Check spelling"].map<ChatCapabilityUpgradeSuggestion>((title) => ({
    kind: "skill_import",
    title,
    summary: "Summary",
    reason: "Reason",
    recommendedAction: "install_skill_enable",
    requiresUserApproval: true,
  }));
  const host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host);
  const onAction = vi.fn();
  const onDismiss = vi.fn();
  const render = (list: ChatCapabilityUpgradeSuggestion[]) =>
    act(async () => {
      root.render(
        <>
          <button type="button">Keep focus here</button>
          <DeferredChatCapabilitySuggestionLine
            turnId="turn-a"
            suggestions={list}
            onAction={onAction}
            onDismiss={onDismiss}
          />
        </>,
      );
    });
  const button = (label: string) => [...host.querySelectorAll("button")].find((node) => node.textContent === label);
  const group = () => host.querySelector('[aria-label="Suggested capabilities"]');
  try {
    await render([]);
    expect(code.start).not.toHaveBeenCalled();
    expect(group()).toBeNull();

    await render(suggestions);
    await vi.waitFor(() => expect(code.start).toHaveBeenCalledOnce());
    expect(host.textContent).toContain("Loading capability suggestions");
    await render([]);
    await act(async () => {
      code.release();
      await vi.dynamicImportSettled();
    });
    expect(group()).toBeNull();
    expect(host.textContent).not.toContain("Loading capability suggestions");

    await render(suggestions);
    await vi.waitFor(() => expect(button("+1 more")).toBeDefined());
    await act(async () => {
      button("+1 more")!.focus();
      button("+1 more")!.click();
    });
    expect(document.activeElement).toBe(button("Check spelling"));
    await render([]);
    expect(group()).toBeNull();
    const outside = button("Keep focus here")!;
    outside.focus();
    await render(suggestions);
    expect(button("Check spelling")).toBeDefined();
    expect(button("+1 more")).toBeUndefined();
    expect(document.activeElement).toBe(outside);
    expect(onAction).not.toHaveBeenCalled();
    expect(onDismiss).not.toHaveBeenCalled();
  } finally {
    code.release();
    await act(async () => root.unmount());
    host.remove();
  }
});
