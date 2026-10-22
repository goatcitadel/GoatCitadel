// @vitest-environment happy-dom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { LinkedApprovalDetail as LinkedApproval } from "./LinkedApproval";
const api = vi.hoisted(() => ({ read: vi.fn(), workspaceId: "active" }));
vi.mock("@goatcitadel/mission-control-shared/api/approvals", () => ({ fetchApproval: api.read }));
vi.mock("@goatcitadel/mission-control-shared/state/ui-preferences", () => ({
  useUiPreferences: () => ({ activeWorkspaceId: api.workspaceId }),
}));
vi.mock("../../app/ScopeSwitcher", () => ({
  ScopeSwitcher: ({ open, destination }: { open: boolean; destination: string }) =>
    open ? <p>Scope review: {destination}</p> : null,
}));
vi.mock("./InboxApprovalDetail", () => ({ InboxApprovalDetail: () => <p>Scoped approval details</p> }));
let root: Root, host: HTMLDivElement, client: QueryClient;
beforeEach(() => {
  window.history.replaceState({ retained: true }, "", "/inbox?approvalId=a%2F1&workspaceId=other&extra=keep#review");
  api.workspaceId = "active";
  api.read.mockReset();
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
  client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
});
afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
  client.clear();
});
async function render() {
  await act(async () =>
    root.render(
      <QueryClientProvider client={client}>
        <LinkedApproval approvalId="a/1" />
      </QueryClientProvider>,
    ),
  );
}
it("waits for the owner read and suppresses missing state during refresh", async () => {
  let finish!: (value: null) => void;
  api.read.mockImplementation(
    () =>
      new Promise((resolve) => {
        finish = resolve;
      }),
  );
  await render();
  expect(host.textContent).toContain("Loading");
  expect(host.textContent).not.toContain("not found");
  await act(async () => {
    finish(null);
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
  await vi.waitFor(() => expect(host.textContent).toContain("Approval not found"));
  await act(async () => {
    void client.invalidateQueries();
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
  expect(host.textContent).toContain("Loading");
  expect(host.textContent).not.toContain("not found");
});
it("requires visible scope review before revealing a cross-workspace record", async () => {
  api.read.mockResolvedValue({ approvalId: "a/1", status: "pending", linkage: { workspaceId: "other" } });
  await render();
  await vi.waitFor(() => expect(host.textContent).toContain("belongs to another workspace"));
  expect(host.textContent).not.toContain("Scoped approval details");
  expect(api.workspaceId).toBe("active");
  await act(async () => host.querySelector("button")!.click());
  expect(host.textContent).toContain("Scope review: /inbox?approvalId=a%2F1&workspaceId=other&extra=keep#review");
});
it("shows authorized same-workspace records and preserves permission errors", async () => {
  api.read.mockResolvedValue({ approvalId: "a/1", status: "pending", linkage: { workspaceId: "active" } });
  await render();
  await vi.waitFor(() => expect(host.textContent).toContain("Scoped approval details"));
  api.read.mockRejectedValue(new Error("Access denied"));
  await act(async () => {
    await client.invalidateQueries();
  });
  await vi.waitFor(() => expect(host.querySelector('[role="alert"]')).not.toBeNull());
  expect(host.textContent).not.toContain("Scoped approval details");
});
it("opens specialist decisions in the native owner without rewriting its source URL", async () => {
  api.read.mockResolvedValue({
    approvalId: "a/1",
    status: "pending",
    kind: "code_mode.run",
    linkage: { workspaceId: "active" },
  });
  await render();
  await vi.waitFor(() => expect(host.textContent).toContain("Scoped approval details"));
  expect(window.location.search).toContain("extra=keep");
  expect(window.location.hash).toBe("#review");
});

it("keeps the same detail node mounted while its linked owner refetches", async () => {
  api.read.mockResolvedValue({ approvalId: "a/1", status: "approved", linkage: { workspaceId: "active" } });
  await render();
  await vi.waitFor(() => expect(host.textContent).toContain("Scoped approval details"));
  const detail = host.querySelector("p");
  let finish!: (value: unknown) => void;
  api.read.mockImplementationOnce(
    () =>
      new Promise((resolve) => {
        finish = resolve;
      }),
  );
  await act(async () => {
    void client.invalidateQueries();
  });
  expect(host.querySelector("p")).toBe(detail);
  await act(async () => finish({ approvalId: "a/1", status: "approved", linkage: { workspaceId: "active" } }));
  expect(host.querySelector("p")).toBe(detail);
});

it.each(["run", "session"])(
  "withholds a selected approval outside the explicit %s history filter and offers only native record inspection",
  async (mismatch) => {
    window.history.replaceState(
      { retained: true },
      "",
      "/inbox?view=history&approvalId=a%2F1&workspaceId=active&runId=expected&sessionId=expected-session&keep=yes#review",
    );
    api.read.mockResolvedValue({
      approvalId: "a/1",
      status: "pending",
      linkage: {
        workspaceId: "active",
        runId: mismatch === "run" ? "other" : "expected",
        sessionId: mismatch === "session" ? "other" : "expected-session",
      },
    });
    await render();
    await vi.waitFor(() => expect(host.querySelector('[aria-label="Approval outside this run"]')).not.toBeNull());
    expect(host.textContent).not.toContain("Scoped approval details");
    expect(api.read).toHaveBeenCalledOnce();
    const link = host.querySelector<HTMLAnchorElement>("a")!;
    expect(link.textContent).toBe("Inspect approval record");
    const target = new URL(link.href);
    expect(target.pathname).toBe("/inbox");
    expect(target.searchParams.get("approvalId")).toBe("a/1");
    expect(target.searchParams.get("workspaceId")).toBe("active");
    expect(target.searchParams.get("view")).toBe("history");
    expect(target.searchParams.has("runId")).toBe(false);
    expect(target.searchParams.has("sessionId")).toBe(false);
    expect(target.searchParams.get("keep")).toBe("yes");
    expect(target.searchParams.get("shell")).toBe("cockpit");
    expect(target.hash).toBe("#review");
    expect(window.history.state).toEqual({ retained: true });
    expect(new URLSearchParams(window.location.search).get("runId")).toBe("expected");
  },
);
it.each(["runId", "durableRunId"])(
  "accepts exact canonical %s history linkage with a legacy unspecified session",
  async (field) => {
    window.history.replaceState(
      {},
      "",
      "/inbox?view=history&approvalId=a%2F1&runId=expected&sessionId=expected-session",
    );
    api.read.mockResolvedValue({
      approvalId: "a/1",
      status: "approved",
      linkage: { workspaceId: "active", [field]: "expected" },
    });
    await render();
    await vi.waitFor(() => expect(host.textContent).toContain("Scoped approval details"));
    expect(host.querySelector('[aria-label="Approval outside this run"]')).toBeNull();
    expect(api.read).toHaveBeenCalledOnce();
  },
);
it("withholds details when a canonical refetch changes the selected record's run linkage", async () => {
  window.history.replaceState({}, "", "/inbox?view=history&approvalId=a%2F1&runId=expected");
  api.read.mockResolvedValue({
    approvalId: "a/1",
    status: "pending",
    linkage: { workspaceId: "active", runId: "expected" },
  });
  await render();
  await vi.waitFor(() => expect(host.textContent).toContain("Scoped approval details"));
  let finish!: (value: unknown) => void;
  api.read.mockImplementationOnce(
    () =>
      new Promise((resolve) => {
        finish = resolve;
      }),
  );
  await act(async () => {
    void client.invalidateQueries();
  });
  expect(host.textContent).toContain("Scoped approval details");
  await act(async () =>
    finish({ approvalId: "a/1", status: "pending", linkage: { workspaceId: "active", runId: "other" } }),
  );
  await vi.waitFor(() => expect(host.querySelector('[aria-label="Approval outside this run"]')).not.toBeNull());
  expect(host.textContent).not.toContain("Scoped approval details");
});
