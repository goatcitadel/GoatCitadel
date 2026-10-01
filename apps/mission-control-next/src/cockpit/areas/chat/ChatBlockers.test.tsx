// @vitest-environment happy-dom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { MissionThreadedActiveSessionSurfaceProps } from "@goatcitadel/threaded-surface-core";
import { ChatBlockers } from "./ChatBlockers";

let root: Root;
let container: HTMLDivElement;

beforeEach(() => {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => { act(() => root.unmount()); container.remove(); });

describe("Chat blockers", () => {
  it("requires a second confirmation for danger risk and keeps canonical links", async () => {
    const onApprovePending = vi.fn();
    await act(async () => root.render(<ChatBlockers props={{
      pendingApproval: { approvalId: "approval/1", kind: "tool_invoke", riskLevel: "danger" },
      pendingUserInput: {
        promptId: "prompt-1", turnId: "turn-1", kind: "text", title: "Choose a direction", question: "Which path?", required: true,
      },
      selectedSessionId: "session/1",
      approvalPending: false,
      userInputPending: false,
      onApprovePending,
      onDenyPending: vi.fn(),
      onSubmitUserInput: vi.fn(),
    } satisfies Pick<MissionThreadedActiveSessionSurfaceProps, "pendingApproval" | "pendingUserInput" | "selectedSessionId" | "approvalPending" | "userInputPending" | "onApprovePending" | "onDenyPending" | "onSubmitUserInput">} />));
    expect(container.textContent).toContain("Tool invoke");
    expect(container.textContent).toContain("Which path?");
    const hrefs = [...container.querySelectorAll("a")].map((anchor) => anchor.getAttribute("href"));
    expect(hrefs).toEqual([
      "/ops/approvals?approvalId=approval%2F1&shell=classic",
      "/chat?sessionId=session%2F1&shell=classic",
    ]);
    const review = [...container.querySelectorAll("button")].find((button) => button.textContent === "Review approval");
    await act(async () => review?.click());
    expect(onApprovePending).not.toHaveBeenCalled();
    expect(document.body.textContent).toContain("Confirm danger risk action");
  });
});
