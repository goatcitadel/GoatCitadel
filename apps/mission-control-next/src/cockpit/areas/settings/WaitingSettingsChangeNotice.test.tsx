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

import { WaitingSettingsChangeNotice } from "./WaitingSettingsChangeNotice";

let root: Root;
let container: HTMLDivElement;

async function show(waiting: React.ComponentProps<typeof WaitingSettingsChangeNotice>["waiting"]) {
  await act(async () => root.render(<WaitingSettingsChangeNotice waiting={waiting} onResolved={() => undefined} />));
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
    await show({ planId: "plan-7", approvalId: "approval-7", title: "Turn off it", applying: false });
    expect(container.textContent).toContain("One change to this setting is already waiting for your approval.");
    const button = container.querySelector("button")!;
    expect(button.textContent).toBe("Review the waiting change");
    expect(button.getAttribute("data-approval")).toBe("approval-7");
    expect(button.getAttribute("data-title")).toBe("Turn off it");
    expect(dialog.reopen).toHaveBeenCalledExactlyOnceWith("approval-7");
  });

  it("says a change is still being applied", async () => {
    await show({ planId: "plan-7", applying: true });
    expect(container.textContent).toContain(
      "One change to this setting is still being applied. Refresh in a moment to see it.",
    );
    expect(dialog.reopen).not.toHaveBeenCalled();
  });

  it("points to Inbox in the default workspace when the change cannot be read", async () => {
    await show({ planId: "plan-7", unreadable: true });
    expect(container.textContent).toContain("One change to this setting is already waiting. Open Inbox to approve it.");
    expect(container.querySelector("a")?.getAttribute("href")).toContain("workspaceId=default");
    expect(dialog.reopen).not.toHaveBeenCalled();
  });
});
