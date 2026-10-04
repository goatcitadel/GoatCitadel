// @vitest-environment happy-dom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { MissionThreadedActiveSessionSurfaceProps } from "@goatcitadel/threaded-surface-core";
import { ChatBlockers } from "./ChatBlockers";

const api = vi.hoisted(() => ({ fetchApprovals: vi.fn() }));
vi.mock("@goatcitadel/mission-control-shared/api/client", () => api);
vi.mock("@goatcitadel/mission-control-shared/state/ui-preferences", () => ({
  useUiPreferences: () => ({ activeWorkspaceId: "default" }),
}));

let root: Root;
let container: HTMLDivElement;
let client: QueryClient;

beforeEach(() => {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  api.fetchApprovals.mockResolvedValue({
    items: [
      {
        approvalId: "approval/1",
        kind: "tool_invoke",
        status: "pending",
        riskLevel: "danger",
        payload: {},
        preview: { commands: ["pnpm test"] },
        createdAt: "2026-10-01T00:00:00Z",
      },
    ],
  });
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  client.clear();
  api.fetchApprovals.mockReset();
});

describe("Chat blockers", () => {
  it("requires a second confirmation for danger risk and keeps canonical links", async () => {
    const onApprovePending = vi.fn();
    await act(async () =>
      root.render(
        <QueryClientProvider client={client}>
          <ChatBlockers
            props={
              {
                pendingApproval: { approvalId: "approval/1", kind: "tool_invoke", riskLevel: "danger" },
                pendingUserInput: {
                  promptId: "prompt-1",
                  turnId: "turn-1",
                  kind: "text",
                  title: "Choose a direction",
                  question: "Which path?",
                  required: true,
                },
                selectedSessionId: "session/1",
                approvalPending: false,
                userInputPending: false,
                onApprovePending,
                onDenyPending: vi.fn(),
                onSubmitUserInput: vi.fn(),
              } satisfies Pick<
                MissionThreadedActiveSessionSurfaceProps,
                | "pendingApproval"
                | "pendingUserInput"
                | "selectedSessionId"
                | "approvalPending"
                | "userInputPending"
                | "onApprovePending"
                | "onDenyPending"
                | "onSubmitUserInput"
              >
            }
          />
        </QueryClientProvider>,
      ),
    );
    expect(container.textContent).toContain("Tool invoke");
    expect(container.textContent).toContain("Which path?");
    const hrefs = [...container.querySelectorAll("a")].map((anchor) => anchor.getAttribute("href"));
    expect(hrefs).toEqual([
      "/ops/approvals?approvalId=approval%2F1&shell=classic&shellScope=visit",
      "/chat?sessionId=session%2F1&shell=classic&shellScope=visit",
    ]);
    const review = [...container.querySelectorAll("button")].find((button) => button.textContent === "Review approval");
    await act(async () => review?.click());
    expect(onApprovePending).not.toHaveBeenCalled();
    expect(document.body.textContent).toContain("Confirm danger risk action");
    expect(document.body.textContent).toContain("pnpm test");
  });

  it("loads persisted evidence for nuclear risk before its review", async () => {
    api.fetchApprovals.mockResolvedValue({
      items: [
        {
          approvalId: "approval/1",
          kind: "tool_invoke",
          status: "pending",
          riskLevel: "nuclear",
          payload: {},
          preview: { commands: ["rm -rf build"] },
          createdAt: "2026-10-01T00:00:00Z",
        },
      ],
    });
    await act(async () =>
      root.render(
        <QueryClientProvider client={client}>
          <ChatBlockers
            props={
              {
                pendingApproval: { approvalId: "approval/1", kind: "tool_invoke", riskLevel: "nuclear" },
                pendingUserInput: null,
                selectedSessionId: "session/1",
                approvalPending: false,
                userInputPending: false,
                onApprovePending: vi.fn(),
                onDenyPending: vi.fn(),
                onSubmitUserInput: vi.fn(),
              } as unknown as Parameters<typeof ChatBlockers>[0]["props"]
            }
          />
        </QueryClientProvider>,
      ),
    );
    await vi.waitFor(() => expect(api.fetchApprovals).toHaveBeenCalledOnce());
    const review = [...container.querySelectorAll("button")].find((button) => button.textContent === "Review approval");
    await act(async () => review?.click());
    await vi.waitFor(() => expect(document.body.textContent).toContain("rm -rf build"));
    expect(document.body.textContent).toContain("Confirm nuclear risk action");
  });

  it("loads persisted evidence for a risk level this build does not know", async () => {
    api.fetchApprovals.mockResolvedValue({
      items: [
        {
          approvalId: "approval/1",
          kind: "tool_invoke",
          status: "pending",
          riskLevel: "critical_infra",
          payload: {},
          preview: { commands: ["kubectl delete ns prod"] },
          createdAt: "2026-10-01T00:00:00Z",
        },
      ],
    });
    await act(async () =>
      root.render(
        <QueryClientProvider client={client}>
          <ChatBlockers
            props={
              {
                pendingApproval: { approvalId: "approval/1", kind: "tool_invoke", riskLevel: "critical_infra" },
                pendingUserInput: null,
                selectedSessionId: "session/1",
                approvalPending: false,
                userInputPending: false,
                onApprovePending: vi.fn(),
                onDenyPending: vi.fn(),
                onSubmitUserInput: vi.fn(),
              } as unknown as Parameters<typeof ChatBlockers>[0]["props"]
            }
          />
        </QueryClientProvider>,
      ),
    );
    await vi.waitFor(() => expect(api.fetchApprovals).toHaveBeenCalledOnce());
    expect(container.textContent).toContain("Critical infra");
    const review = [...container.querySelectorAll("button")].find((button) => button.textContent === "Review approval");
    await act(async () => review?.click());
    await vi.waitFor(() => expect(document.body.textContent).toContain("kubectl delete ns prod"));
  });
});
