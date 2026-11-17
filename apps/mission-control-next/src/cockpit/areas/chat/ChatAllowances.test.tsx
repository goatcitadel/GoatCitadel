// @vitest-environment happy-dom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ToolGrantRecord } from "@goatcitadel/contracts";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { ChatAllowanceReceipt, ChatAllowances } from "./ChatAllowances";

const api = vi.hoisted(() => ({ fetchToolGrants: vi.fn(), revokeToolGrant: vi.fn() }));
vi.mock("@goatcitadel/mission-control-shared/api/approvals", () => api);

const scope = { workspaceId: "default", sessionId: "chat-1" };
const memoryGrant: ToolGrantRecord = {
  grantId: "memory-grant",
  toolPattern: "memory.search",
  decision: "allow",
  scope: "session",
  scopeRef: scope.sessionId,
  grantType: "ttl",
  createdBy: "operator",
  createdAt: "2026-11-16T18:00:00Z",
  expiresAt: "2099-11-16T18:15:00Z",
};
const docsGrant: ToolGrantRecord = { ...memoryGrant, grantId: "docs-grant", toolPattern: "docs.search" };

let root: Root;
let container: HTMLDivElement;
let client: QueryClient;
let records: ToolGrantRecord[];

beforeEach(() => {
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  records = [
    memoryGrant,
    docsGrant,
    { ...memoryGrant, grantId: "foreign", scopeRef: "chat-2" },
    { ...memoryGrant, grantId: "workspace", scope: "workspace" },
    { ...memoryGrant, grantId: "expired", expiresAt: "2000-01-01T00:00:00Z" },
    { ...memoryGrant, grantId: "denied", decision: "deny" },
    { ...memoryGrant, grantId: "spent", grantType: "one_time", usesRemaining: 0 },
  ];
  api.fetchToolGrants.mockReset().mockImplementation(async () => ({ items: structuredClone(records) }));
  api.revokeToolGrant.mockReset().mockImplementation(async (id: string) => {
    records = records.map((grant) => (grant.grantId === id ? { ...grant, revokedAt: "2026-11-16T18:01:00Z" } : grant));
    return { revoked: true, grantId: id };
  });
});

afterEach(() => {
  act(() => root.unmount());
  client.clear();
  container.remove();
});

const buttons = (parent: ParentNode = container) => [...parent.querySelectorAll("button")];
const rows = () => [...container.querySelectorAll("li")];

it("ends the exact inline allowance once and refreshes the individual rows in Chat details", async () => {
  await act(async () =>
    root.render(
      <QueryClientProvider client={client}>
        <ChatAllowanceReceipt {...scope} grant={memoryGrant} message="Approved. Search memory is allowed." />
        <ChatAllowances {...scope} />
      </QueryClientProvider>,
    ),
  );
  await vi.waitFor(() => expect(buttons()).toHaveLength(1));
  const details = container.querySelector("details")!;
  await act(async () => {
    details.open = true;
    details.dispatchEvent(new Event("toggle"));
  });
  await vi.waitFor(() => expect(rows()).toHaveLength(2));
  expect(api.fetchToolGrants).toHaveBeenCalledWith({ scope: "session", scopeRef: "chat-1", limit: 500 });

  const inline = buttons().find((button) => !button.closest("details"))!;
  await act(async () => {
    inline.click();
    inline.click();
  });
  await vi.waitFor(() => {
    expect(container.textContent).toContain("Allowance ended for");
    expect(rows()).toHaveLength(1);
  });
  expect(api.revokeToolGrant).toHaveBeenCalledExactlyOnceWith("memory-grant");

  await act(async () => buttons(rows()[0]!)[0]!.click());
  await vi.waitFor(() => expect(container.textContent).toContain("No active allowances for this Chat."));
  expect(api.revokeToolGrant).toHaveBeenNthCalledWith(2, "docs-grant");
});

it("keeps the allowance visible with an inline error when revocation fails", async () => {
  api.revokeToolGrant.mockRejectedValueOnce(new Error("offline"));
  await act(async () =>
    root.render(
      <QueryClientProvider client={client}>
        <ChatAllowanceReceipt {...scope} grant={memoryGrant} message="Approved. Search memory is allowed." />
      </QueryClientProvider>,
    ),
  );
  await vi.waitFor(() => expect(buttons()).toHaveLength(1));
  await act(async () => buttons()[0]!.click());
  await vi.waitFor(() => expect(container.querySelector('[role="alert"]')?.textContent).toContain("Could not confirm"));
  expect(container.textContent).toContain("Search memory is allowed");
  expect(buttons()[0]!.disabled).toBe(false);
});

it("keeps the confirmed end receipt when refreshing allowances fails after the revoke", async () => {
  await act(async () =>
    root.render(
      <QueryClientProvider client={client}>
        <ChatAllowanceReceipt {...scope} grant={memoryGrant} message="Approved. Search memory is allowed." />
      </QueryClientProvider>,
    ),
  );
  await vi.waitFor(() => expect(buttons()).toHaveLength(1));
  api.fetchToolGrants.mockRejectedValueOnce(new Error("offline after revocation"));
  await act(async () => buttons()[0]!.click());
  await vi.waitFor(() => expect(container.textContent).toContain("Allowance ended for"));
  expect(buttons()).toHaveLength(0);
  expect(container.textContent).not.toContain("Search memory is allowed");
  expect(api.revokeToolGrant).toHaveBeenCalledExactlyOnceWith(memoryGrant.grantId);
});

it("offers an inline retry when the receipt cannot check an allowance", async () => {
  api.fetchToolGrants.mockRejectedValueOnce(new Error("offline"));
  await act(async () =>
    root.render(
      <QueryClientProvider client={client}>
        <ChatAllowanceReceipt {...scope} grant={memoryGrant} message="Approved. Search memory is allowed." />
      </QueryClientProvider>,
    ),
  );
  await vi.waitFor(() => expect(buttons()[0]?.textContent).toBe("Try again"));
  expect(container.textContent).not.toContain("Search memory is allowed");
  await act(async () => buttons()[0]!.click());
  await vi.waitFor(() => expect(buttons()[0]?.textContent).toBe("End allowance"));
  expect(api.revokeToolGrant).not.toHaveBeenCalled();
});
