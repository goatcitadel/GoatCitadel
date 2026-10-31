// @vitest-environment happy-dom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
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
// The approval reviews name workspaces from the workspace list.
vi.mock("@goatcitadel/mission-control-shared/api/workspaces", () => ({
  fetchWorkspaces: vi.fn(async () => ({ items: [] })),
}));
const specialist = vi.hoisted(() => ({ read: vi.fn() }));
vi.mock("../inbox/specialist-approval-evidence", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../inbox/specialist-approval-evidence")>()),
  readSpecialistEvidence: specialist.read,
  specialistEvidenceMatches: () => true,
}));
vi.mock("@goatcitadel/mission-control-shared/state/ui-preferences", () => ({
  useUiPreferences: () => ({ activeWorkspaceId: "default" }),
}));
// Every read goes through the api modules mocked above. A request that slips past them would reach the Gateway URL,
// the operator's own install on this computer, so fetch is refused for the whole file (a read a test left running
// can still call it after the test) and any call fails the test.
const network = vi.fn((input: unknown) => Promise.reject(new Error(`Unmocked request: ${String(input)}`)));
const takeRequests = () => {
  const requests = network.mock.calls.map(([input]) => String(input));
  network.mockClear();
  return requests;
};
beforeAll(() => vi.stubGlobal("fetch", network));
afterAll(() => {
  const requests = takeRequests();
  vi.unstubAllGlobals();
  expect(requests).toEqual([]);
});

let root: Root;
let container: HTMLDivElement;
let client: QueryClient;

beforeEach(() => {
  window.history.replaceState(
    { retained: true },
    "",
    "/chat?keep=yes&workspaceId=stale&sessionId=stale&approvalId=stale&runId=run%2Fcontext&shell=cockpit&shellScope=visit#receipt",
  );
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
  expect(takeRequests()).toEqual([]);
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
                onRefreshThread: vi.fn(),
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
    expect(container.textContent).toContain("Use a tool");
    expect(container.textContent).not.toContain("tool_invoke");
    expect(container.textContent).toContain("Which path?");
    const anchors = [...container.querySelectorAll("a")];
    // CH-N06: no "Open this conversation in Chat" link while already inside Chat.
    expect(anchors).toHaveLength(1);
    expect(container.textContent).not.toContain("Open this conversation in Chat");
    for (const [label, pathname, approvalId] of [["Inspect persisted approval", "/inbox", "approval/1"]] as const) {
      const anchor = anchors.find((link) => link.textContent === label)!;
      expect(anchor).toBeDefined();
      const target = new URL(anchor.href);
      expect(target.pathname).toBe(pathname);
      expect(target.searchParams.get("approvalId")).toBe(approvalId);
      expect(target.searchParams.get("workspaceId")).toBe("default");
      expect(target.searchParams.get("sessionId")).toBe("session/1");
      expect(target.searchParams.get("runId")).toBe("run/context");
      expect(target.searchParams.get("keep")).toBe("yes");
      expect(target.searchParams.get("shell")).toBe("cockpit");
      expect(target.searchParams.has("shellScope")).toBe(false);
      expect(target.hash).toBe("#receipt");
    }
    await vi.waitFor(() =>
      expect(
        [...container.querySelectorAll("button")].find((button) => button.textContent === "Review danger approval"),
      ).toBeDefined(),
    );
    const review = [...container.querySelectorAll("button")].find(
      (button) => button.textContent === "Review danger approval",
    );
    await act(async () => review?.click());
    expect(onApprovePending).not.toHaveBeenCalled();
    expect(document.body.textContent).toContain("Confirm danger-level action");
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
                onSubmitUserInput: vi.fn(),
                onRefreshThread: vi.fn(),
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
    const nativeRecord = [...container.querySelectorAll("a")].find(
      (link) => link.textContent === "Inspect persisted approval",
    )!;
    expect(nativeRecord).toBeDefined();
    const recordTarget = new URL(nativeRecord.href);
    expect(recordTarget.pathname).toBe("/inbox");
    expect(recordTarget.searchParams.get("approvalId")).toBe("approval/1");
    expect(recordTarget.searchParams.get("workspaceId")).toBe("default");
    expect(recordTarget.searchParams.get("sessionId")).toBe("session/1");
    expect(recordTarget.searchParams.get("runId")).toBe("run/context");
    expect(recordTarget.searchParams.get("keep")).toBe("yes");
    expect(recordTarget.hash).toBe("#receipt");
    expect(recordTarget.searchParams.get("shell")).toBe("cockpit");
    expect(recordTarget.searchParams.has("shellScope")).toBe(false);
    await vi.waitFor(() =>
      expect(
        [...container.querySelectorAll("button")].find((button) => button.textContent === "Review nuclear approval"),
      ).toBeDefined(),
    );
    const review = [...container.querySelectorAll("button")].find(
      (button) => button.textContent === "Review nuclear approval",
    );
    await act(async () => review?.click());
    await vi.waitFor(() => expect(document.body.textContent).toContain("rm -rf build"));
    expect(document.body.textContent).toContain("Confirm nuclear-level action");
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
                onSubmitUserInput: vi.fn(),
                onRefreshThread: vi.fn(),
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
    await vi.waitFor(() =>
      expect(
        [...container.querySelectorAll("button")].find((button) => button.textContent === "Review nuclear approval"),
      ).toBeDefined(),
    );
    const review = [...container.querySelectorAll("button")].find(
      (button) => button.textContent === "Review nuclear approval",
    );
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
  const oldAction = vi.fn();
  const refresh = vi.fn();
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
              onDenyPending: oldAction,
              onRefreshThread: refresh,
              onSubmitUserInput: vi.fn(),
            } as Parameters<typeof ChatBlockers>[0]["props"]
          }
        />
      </QueryClientProvider>,
    ),
  );
  await vi.waitFor(() =>
    expect(
      [...container.querySelectorAll("button")].find((button) => button.textContent === "Approve once")?.disabled,
    ).toBe(false),
  );
  const button = [...container.querySelectorAll("button")].find((entry) => entry.textContent === "Approve once")!;
  expect(button.disabled).toBe(false);
  await act(async () => button.click());
  expect(api.resolveApproval).toHaveBeenCalledExactlyOnceWith("safe-new", "approve");
  expect(api.fetchApproval).toHaveBeenCalledWith("safe-new", { workspaceId: "default" });
  expect(oldAction).not.toHaveBeenCalled();
  expect(refresh).toHaveBeenCalledTimes(1);
  await vi.waitFor(() => expect(container.textContent).toContain("Decision recorded"));
  expect(container.textContent).toContain("Decision recorded");
  expect(container.textContent).not.toContain("Work completed");
});

it("keeps a persisted settled decision visible while its canonical record is refetched", async () => {
  const record = {
    approvalId: "settled",
    kind: "tool_invoke",
    status: "approved",
    riskLevel: "safe",
    payload: {},
    createdAt: "2026-10-01T00:00:00Z",
  };
  api.fetchApproval.mockResolvedValue(record);
  api.fetchApprovalReplay.mockResolvedValue({ approval: record, effects: [] });
  const props = {
    pendingApproval: { approvalId: "settled", riskLevel: "safe" },
    selectedSessionId: "s",
    onRefreshThread: vi.fn(),
  } as unknown as Parameters<typeof ChatBlockers>[0]["props"];
  await act(async () =>
    root.render(
      <QueryClientProvider client={client}>
        <ChatBlockers props={props} />
      </QueryClientProvider>,
    ),
  );
  await vi.waitFor(() => expect(container.textContent).toContain("Decision recorded"));
  api.fetchApproval.mockImplementation(() => new Promise(() => {}));
  await act(async () => {
    void client.invalidateQueries({ queryKey: ["approvals", "record"] });
  });
  expect(container.textContent).toContain("Decision recorded");
  expect(container.textContent).not.toContain("Checking the current approval");
  expect(container.textContent).not.toContain("Approve once");
});

function blockerProps(overrides: Record<string, unknown> = {}) {
  return {
    pendingApproval: { approvalId: "approval/1", riskLevel: "safe" },
    selectedSessionId: "session/1",
    approvalPending: false,
    userInputPending: false,
    pendingUserInput: null,
    onApprovePending: vi.fn(),
    onDenyPending: vi.fn(),
    onRefreshThread: vi.fn(),
    onSubmitUserInput: vi.fn(),
    ...overrides,
  } as unknown as Parameters<typeof ChatBlockers>[0]["props"];
}
const findButton = (label: string) =>
  [...container.querySelectorAll("button")].find((entry) => entry.textContent === label);

it("shows a failed record read as an error with Try again and Deny, not as checking (CH-02)", async () => {
  api.fetchApproval.mockRejectedValue(new Error("fixture outage"));
  const onDenyPending = vi.fn();
  await act(async () =>
    root.render(
      <QueryClientProvider client={client}>
        <ChatBlockers props={blockerProps({ onDenyPending })} />
      </QueryClientProvider>,
    ),
  );
  await vi.waitFor(() => expect(container.textContent).toContain("The approval record couldn’t load"));
  expect(container.textContent).not.toContain("Checking the current approval");
  expect(findButton("Approve once")).toBeUndefined();
  api.fetchApproval.mockClear();
  await act(async () => findButton("Try again")!.click());
  expect(api.fetchApproval).toHaveBeenCalledTimes(1);
  await vi.waitFor(() => expect(findButton("Deny")).toBeDefined());
  await act(async () => findButton("Deny")!.click());
  expect(onDenyPending).toHaveBeenCalledTimes(1);
});

it("offers Check again and Deny when the record is missing (CH-02)", async () => {
  const { ApiRequestError } = await import("@goatcitadel/mission-control-shared/api/http-internal");
  api.fetchApproval.mockRejectedValue(
    new ApiRequestError("gone", { kind: "http", method: "GET", path: "/api/approvals/approval-1", status: 404 }),
  );
  await act(async () =>
    root.render(
      <QueryClientProvider client={client}>
        <ChatBlockers props={blockerProps()} />
      </QueryClientProvider>,
    ),
  );
  await vi.waitFor(() => expect(container.textContent).toContain("The approval record wasn’t found"));
  expect(findButton("Check again")).toBeDefined();
  expect(findButton("Deny")).toBeDefined();
});

it("moves focus to the composer when a decision removes the card it was in (CH-18)", async () => {
  api.fetchApproval.mockRejectedValue(new Error("fixture outage"));
  const composer = document.createElement("textarea");
  document.body.append(composer);
  const composerRef = { current: composer };
  try {
    await act(async () =>
      root.render(
        <QueryClientProvider client={client}>
          <ChatBlockers props={blockerProps({ composerRef })} />
        </QueryClientProvider>,
      ),
    );
    await vi.waitFor(() => expect(findButton("Deny")).toBeDefined());
    act(() => findButton("Deny")!.focus());
    expect(document.activeElement?.textContent).toBe("Deny");
    await act(async () =>
      root.render(
        <QueryClientProvider client={client}>
          <ChatBlockers props={blockerProps({ composerRef, pendingApproval: null })} />
        </QueryClientProvider>,
      ),
    );
    expect(document.activeElement).toBe(composer);
  } finally {
    composer.remove();
  }
});

it("does not duplicate a code_mode.request approval", async () => {
  api.fetchApproval.mockResolvedValue({
    approvalId: "cm-1",
    kind: "code_mode.request",
    status: "pending",
    riskLevel: "caution",
    payload: { goal: "read a file", source: "return 1;" },
    preview: {},
    createdAt: "2026-10-01T00:00:00Z",
  });
  await act(async () =>
    root.render(
      <QueryClientProvider client={client}>
        <ChatBlockers
          props={blockerProps({
            pendingApproval: { approvalId: "cm-1", kind: "code_mode.request", riskLevel: "caution" },
          })}
        />
      </QueryClientProvider>,
    ),
  );
  expect(container.textContent).not.toContain("Approval needed");
  expect(container.querySelector("button")).toBeNull();
});

it("enables Approve for a code_mode.run once specialist evidence matches", async () => {
  const record = {
    approvalId: "run-1",
    kind: "code_mode.run",
    status: "pending",
    riskLevel: "danger",
    payload: { runId: "r1" },
    preview: {},
    createdAt: "2026-10-01T00:00:00Z",
  };
  api.fetchApproval.mockResolvedValue(record);
  let release!: (value: unknown) => void;
  specialist.read.mockReturnValue(new Promise((resolve) => (release = resolve)));
  await act(async () =>
    root.render(
      <QueryClientProvider client={client}>
        <ChatBlockers
          props={blockerProps({ pendingApproval: { approvalId: "run-1", kind: "code_mode.run", riskLevel: "danger" } })}
        />
      </QueryClientProvider>,
    ),
  );
  await vi.waitFor(() => expect(findButton("Review danger approval")).toBeDefined());
  expect(findButton("Review danger approval")!.disabled).toBe(true);
  await act(async () => release({ replay: { approval: record, events: [], effects: [] } }));
  await vi.waitFor(() => expect(findButton("Review danger approval")!.disabled).toBe(false));
});

it("says why a code_mode.run approval can't be approved yet, and checks the code again on request", async () => {
  const record = {
    approvalId: "run-1",
    kind: "code_mode.run",
    status: "pending",
    riskLevel: "danger",
    payload: { runId: "r1" },
    preview: {},
    createdAt: "2026-10-01T00:00:00Z",
  };
  api.fetchApproval.mockResolvedValue(record);
  specialist.read.mockRejectedValueOnce(new Error("Gateway unavailable"));
  await act(async () =>
    root.render(
      <QueryClientProvider client={client}>
        <ChatBlockers
          props={blockerProps({ pendingApproval: { approvalId: "run-1", kind: "code_mode.run", riskLevel: "danger" } })}
        />
      </QueryClientProvider>,
    ),
  );
  await vi.waitFor(() => expect(findButton("Check again")).toBeDefined());
  expect(container.querySelector('[role="alert"]')?.textContent).toContain("Gateway unavailable");
  expect(findButton("Review danger approval")!.disabled).toBe(true);
  specialist.read.mockResolvedValue({ replay: { approval: record, events: [], effects: [] } });
  await act(async () => findButton("Check again")!.click());
  await vi.waitFor(() => expect(findButton("Review danger approval")!.disabled).toBe(false));
  expect(findButton("Check again")).toBeUndefined();
});

it("does not send a second specialist read while Check again is still reading", async () => {
  const record = {
    approvalId: "run-1",
    kind: "code_mode.run",
    status: "pending",
    riskLevel: "danger",
    payload: { runId: "r1" },
    preview: {},
    createdAt: "2026-10-01T00:00:00Z",
  };
  const evidence = { replay: { approval: record, events: [], effects: [] } };
  api.fetchApproval.mockResolvedValue(record);
  specialist.read.mockResolvedValueOnce(evidence);
  await act(async () =>
    root.render(
      <QueryClientProvider client={client}>
        <ChatBlockers
          props={blockerProps({ pendingApproval: { approvalId: "run-1", kind: "code_mode.run", riskLevel: "danger" } })}
        />
      </QueryClientProvider>,
    ),
  );
  await vi.waitFor(() => expect(findButton("Review danger approval")?.disabled).toBe(false));
  // A later read fails, so the earlier answer no longer counts; the failure stays recorded while it is read again.
  specialist.read.mockRejectedValueOnce(new Error("Gateway unavailable"));
  await act(async () => client.refetchQueries({ queryKey: ["approvals", "specialist"] }));
  await vi.waitFor(() => expect(findButton("Check again")).toBeDefined());
  let release!: (value: unknown) => void;
  specialist.read.mockReturnValue(new Promise((resolve) => (release = resolve)));
  await act(async () => findButton("Check again")!.click());
  const reads = specialist.read.mock.calls.length;
  await vi.waitFor(() => expect(findButton("Check again")?.disabled ?? true).toBe(true));
  await act(async () => findButton("Check again")?.click());
  expect(specialist.read).toHaveBeenCalledTimes(reads);
  await act(async () => release(evidence));
  await vi.waitFor(() => expect(findButton("Check again")).toBeUndefined());
});
