// @vitest-environment happy-dom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { MissionThreadedActiveSessionSurfaceProps } from "@goatcitadel/threaded-surface-core";
import { ChatBlockers } from "./ChatBlockers";

const api = vi.hoisted(() => ({
  fetchApproval: vi.fn(),
  fetchApprovals: vi.fn(),
  resolveApproval: vi.fn(),
  fetchApprovalReplay: vi.fn(),
}));
vi.mock("@goatcitadel/mission-control-shared/api/approvals", () => ({
  fetchApproval: api.fetchApproval,
  fetchApprovalReplay: api.fetchApprovalReplay,
}));
vi.mock("@goatcitadel/mission-control-shared/api/client", () => ({
  fetchApprovals: api.fetchApprovals,
  resolveApproval: api.resolveApproval,
}));
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
  api.fetchApproval.mockResolvedValue({
    approvalId: "approval/1",
    kind: "tool_invoke",
    status: "pending",
    riskLevel: "danger",
    payload: {},
    preview: { commands: ["pnpm test"] },
    createdAt: "2026-10-01T00:00:00Z",
  });
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  client.clear();
  api.fetchApproval.mockReset();
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
                onSubmitUserInput: vi.fn(), onRefreshThread: vi.fn(),
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
                | "onRefreshThread"
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
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 20));
    });
    const review = [...container.querySelectorAll("button")].find((button) => button.textContent === "Review approval");
    await act(async () => review?.click());
    expect(onApprovePending).not.toHaveBeenCalled();
    expect(document.body.textContent).toContain("Confirm high risk action");
    expect(document.body.textContent).toContain("pnpm test");
  });

  it("loads persisted evidence for nuclear risk before its review", async () => {
    api.fetchApproval.mockResolvedValue({
      approvalId: "approval/1",
      kind: "tool_invoke",
      status: "pending",
      riskLevel: "nuclear",
      payload: {},
      preview: { commands: ["rm -rf build"] },
      createdAt: "2026-10-01T00:00:00Z",
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
                onSubmitUserInput: vi.fn(), onRefreshThread: vi.fn(),
              } as unknown as Parameters<typeof ChatBlockers>[0]["props"]
            }
          />
        </QueryClientProvider>,
      ),
    );
    // One read of this approval by id, under the key the Inbox detail shares (IN-11); no queue read.
    await vi.waitFor(() =>
      expect(api.fetchApproval).toHaveBeenCalledExactlyOnceWith("approval/1", {
        workspaceId: "default",
        signal: expect.any(AbortSignal),
      }),
    );
    expect(api.fetchApprovals).not.toHaveBeenCalled();
    expect(client.getQueryData(["approvals", "record", "default", "approval/1"])).toBeTruthy();
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 20));
    });
    const review = [...container.querySelectorAll("button")].find((button) => button.textContent === "Review approval");
    await act(async () => review?.click());
    await vi.waitFor(() => expect(document.body.textContent).toContain("rm -rf build"));
    expect(document.body.textContent).toContain("Confirm critical risk action");
  });

  it("loads persisted evidence for a risk level this build does not know", async () => {
    api.fetchApproval.mockResolvedValue({
      approvalId: "approval/1",
      kind: "tool_invoke",
      status: "pending",
      riskLevel: "critical_infra",
      payload: {},
      preview: { commands: ["kubectl delete ns prod"] },
      createdAt: "2026-10-01T00:00:00Z",
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
                onSubmitUserInput: vi.fn(), onRefreshThread: vi.fn(),
              } as unknown as Parameters<typeof ChatBlockers>[0]["props"]
            }
          />
        </QueryClientProvider>,
      ),
    );
    // One read of this approval by id, under the key the Inbox detail shares (IN-11); no queue read.
    await vi.waitFor(() =>
      expect(api.fetchApproval).toHaveBeenCalledExactlyOnceWith("approval/1", {
        workspaceId: "default",
        signal: expect.any(AbortSignal),
      }),
    );
    expect(api.fetchApprovals).not.toHaveBeenCalled();
    expect(client.getQueryData(["approvals", "record", "default", "approval/1"])).toBeTruthy();
    expect(container.textContent).toContain("Critical infra");
    const review = [...container.querySelectorAll("button")].find((button) => button.textContent === "Review approval");
    await act(async () => review?.click());
    await vi.waitFor(() => expect(document.body.textContent).toContain("kubectl delete ns prod"));
  });
});

it("uses the Inbox decision owner for a low-risk Chat action and retains its receipt", async () => {
  const record = {
    approvalId: "safe-new",
    kind: "tool_invoke",
    status: "pending",
    riskLevel: "safe",
    payload: {},
    preview: { path: "test.txt" },
    createdAt: "2026-10-01T00:00:00Z",
    explanationStatus: "not_requested",
  };
  api.fetchApproval.mockResolvedValue(record);
  api.fetchApprovalReplay.mockResolvedValue({ approval: { ...record, status: "approved" }, effects: [] });
  api.resolveApproval.mockImplementation(async () => {
    api.fetchApproval.mockResolvedValue({ ...record, status: "approved" });
    return { approval: { ...record, status: "approved" }, effects: [] };
  });
  const oldAction = vi.fn(); const refresh = vi.fn();
  await act(async () =>
    root.render(
      <QueryClientProvider client={client}>
        <ChatBlockers
          props={
            {
              pendingApproval: { approvalId: record.approvalId, riskLevel: "safe" },
              selectedSessionId: "session/1",
              approvalPending: false,
              userInputPending: false,
              pendingUserInput: null,
              onApprovePending: oldAction,
              onDenyPending: oldAction, onRefreshThread: refresh,
              onSubmitUserInput: vi.fn(),
            } as Parameters<typeof ChatBlockers>[0]["props"]
          }
        />
      </QueryClientProvider>,
    ),
  );
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 25));
  });
  const button = [...container.querySelectorAll("button")].find((entry) => entry.textContent === "Approve once")!;
  expect(button.disabled).toBe(false);
  await act(async () => button.click());
  expect(api.resolveApproval).toHaveBeenCalledExactlyOnceWith("safe-new", "approve");
  expect(api.fetchApproval).toHaveBeenCalledWith("safe-new", { workspaceId: "default" });
  expect(oldAction).not.toHaveBeenCalled(); expect(refresh).toHaveBeenCalledTimes(1);
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 25));
  });
  expect(container.textContent).toContain("Decision recorded");
  expect(container.textContent).not.toContain("Work completed");
});

it("keeps a persisted settled decision visible while its canonical record is refetched", async () => {
  const record = { approvalId: "settled", kind: "tool_invoke", status: "approved", riskLevel: "safe", payload: {}, createdAt: "2026-10-01T00:00:00Z" };
  api.fetchApproval.mockResolvedValue(record);
  api.fetchApprovalReplay.mockResolvedValue({ approval: record, effects: [] });
  const props = { pendingApproval: { approvalId: "settled", riskLevel: "safe" }, selectedSessionId: "s", onRefreshThread: vi.fn() } as unknown as Parameters<typeof ChatBlockers>[0]["props"];
  await act(async () => root.render(<QueryClientProvider client={client}><ChatBlockers props={props} /></QueryClientProvider>));
  await vi.waitFor(() => expect(container.textContent).toContain("Decision recorded"));
  api.fetchApproval.mockImplementation(() => new Promise(() => {}));
  await act(async () => { void client.invalidateQueries({ queryKey: ["approvals", "record"] }); });
  expect(container.textContent).toContain("Decision recorded");
  expect(container.textContent).not.toContain("Checking the current approval");
  expect(container.textContent).not.toContain("Approve once");
});
