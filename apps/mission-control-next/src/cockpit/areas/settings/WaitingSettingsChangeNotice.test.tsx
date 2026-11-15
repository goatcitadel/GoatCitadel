// @vitest-environment happy-dom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const dialog = vi.hoisted(() => ({ reopen: vi.fn() }));
vi.mock("./SettingsApprovalDialog", () => ({
  reopenSettingsApproval: dialog.reopen,
  SettingsApprovalDialog: ({
    approvalId,
    title,
    reviewLabel,
  }: {
    approvalId: string;
    title?: string;
    reviewLabel?: string;
  }) => (
    <button type="button" data-approval={approvalId} data-title={title}>
      {reviewLabel}
    </button>
  ),
}));
vi.mock("../../ui/NativeOwnerLink", () => ({
  NativeOwnerLink: ({ href, children }: { href: string; children: React.ReactNode }) => <a href={href}>{children}</a>,
}));

import type { WaitingSubject } from "../../../features/native-routes/settings/settings-save-outcome";
import { WaitingSettingsChangeNotice } from "./WaitingSettingsChangeNotice";

let root: Root;
let container: HTMLDivElement;

async function show(
  waiting: React.ComponentProps<typeof WaitingSettingsChangeNotice>["waiting"],
  subject?: WaitingSubject,
  showSentence?: boolean,
) {
  await act(async () =>
    root.render(
      <WaitingSettingsChangeNotice
        waiting={waiting}
        onResolved={() => undefined}
        {...(subject ? { subject } : {})}
        {...(showSentence === undefined ? {} : { showSentence })}
      />,
    ),
  );
}

beforeEach(() => {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
});
afterEach(() => {
  act(() => root.unmount());
  container.remove();
  vi.resetAllMocks();
});

describe("WaitingSettingsChangeNotice", () => {
  it("leads to the waiting approval and reopens its dialog once", async () => {
    await show({ planId: "plan-7", approvalId: "approval-7", title: "Turn off it", stage: "approval" });
    expect(container.textContent).toContain("One change to this setting is already waiting for your approval.");
    const button = container.querySelector("button")!;
    expect(button.textContent).toBe("Review the waiting change");
    expect(button.getAttribute("data-approval")).toBe("approval-7");
    expect(button.getAttribute("data-title")).toBe("Turn off it");
    expect(dialog.reopen).toHaveBeenCalledExactlyOnceWith("approval-7");
  });

  it("says a change is still being applied, with nothing to click", async () => {
    await show({ planId: "plan-7", stage: "applying" });
    expect(container.textContent).toContain(
      "One change to this setting is still being applied. Refresh in a moment to see it.",
    );
    expect(container.querySelector("a, button")).toBeNull();
    expect(dialog.reopen).not.toHaveBeenCalled();
  });

  it("says a change the operator must act on waits for review, and links to Inbox in the default workspace", async () => {
    await show({ planId: "plan-7", stage: "review" });
    expect(container.textContent).toContain("One change to this setting is waiting for your review.");
    expect(container.textContent).not.toContain("being applied");
    const link = container.querySelector("a")!;
    expect(link.textContent).toBe("Open Inbox to review it.");
    expect(link.getAttribute("href")).toContain("workspaceId=default");
  });

  it("points to Inbox when the waiting change cannot be read", async () => {
    await show({ planId: "plan-7", unreadable: true });
    expect(container.textContent).toContain("One change to this setting is already waiting.");
    expect(container.querySelector("a")?.textContent).toBe("Open Inbox to approve it.");
    expect(container.querySelector("a")?.getAttribute("href")).toContain("workspaceId=default");
    expect(dialog.reopen).not.toHaveBeenCalled();
  });

  it("names the approval rule when the change is to the rule", async () => {
    await show({ planId: "plan-7", approvalId: "approval-7", stage: "approval" }, "rule");
    expect(container.textContent).toContain("One change to this rule is already waiting for your approval.");
  });

  it("renders only the action when the control already announces the sentence", async () => {
    await show({ planId: "plan-7", approvalId: "approval-7", stage: "approval" }, "setting", false);
    expect(container.textContent).toBe("Review the waiting change");
    await show({ planId: "plan-7", stage: "applying" }, "setting", false);
    expect(container.textContent).toBe("");
  });

  it("has nothing to click for a change being prepared or waiting for a credential", async () => {
    await show({ planId: "plan-7", stage: "preparing" });
    expect(container.textContent).toContain(
      "One change to this setting is being prepared. Refresh in a moment to see it.",
    );
    expect(container.querySelector("a, button")).toBeNull();
    await show({ planId: "plan-7", stage: "credential" }, "provider");
    expect(container.textContent).toContain(
      "One change to this provider is waiting for its credential. Finish or cancel it where you started it.",
    );
    expect(container.querySelector("a, button")).toBeNull();
  });
});
