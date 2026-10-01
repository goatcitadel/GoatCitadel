// @vitest-environment happy-dom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { OperatorInboxItem } from "@goatcitadel/contracts";
import { InboxSourceContext } from "./InboxSourceContext";
import type { InboxSourceMessage } from "./inbox-source-context";
const mocks = vi.hoisted(() => ({ workspace: "w", citadel: "a", read: vi.fn<typeof import("./inbox-source-context").readInboxSourceContext>() }));
vi.mock("./inbox-source-context", () => ({ readInboxSourceContext: mocks.read }));
vi.mock("@goatcitadel/mission-control-shared/state/ui-preferences", () => ({ useUiPreferences: () => ({ activeWorkspaceId: mocks.workspace, activeCitadelId: mocks.citadel }) }));
const item: OperatorInboxItem = { id: "approval:a", kind: "approval", group: "needs_decision", title: "Review", summary: "Review actual owner", createdAt: "2026-10-01T00:00:00Z", source: { sessionId: "s", workspaceId: "w", approvalId: "a" }, href: "/ops/approvals?shell=classic&approvalId=a" };
const message: InboxSourceMessage = { messageId: "m", role: "assistant", timestamp: item.createdAt, text: "Exact public context", truncated: false };
let root: Root, host: HTMLDivElement, client: QueryClient;
async function render(source = item) { await act(async () => root.render(<QueryClientProvider client={client}><InboxSourceContext item={source} workspaceId="w" /></QueryClientProvider>)); }
beforeEach(() => { mocks.workspace = "w"; mocks.citadel = "a"; mocks.read.mockReset().mockResolvedValue(message); client = new QueryClient({ defaultOptions: { queries: { retry: false } } }); host = document.createElement("div"); document.body.append(host); root = createRoot(host); });
afterEach(async () => { await act(async () => root.unmount()); client.clear(); host.remove(); });
it("shows current stored context distinctly from the approval review and never reads a foreign source", async () => {
  await render(); await vi.waitFor(() => expect(host.textContent).toContain("Exact public context"));
  expect(host.textContent).toContain("decision above still requires its own exact review");
  await render({ ...item, source: { ...item.source, workspaceId: "foreign" } });
  expect(host.textContent).toContain("context unavailable"); expect(host.textContent).not.toContain(message.text);
  expect(mocks.read).toHaveBeenCalledTimes(1);
});
it("aborts old selection and refuses its late content across Citadel ABA and unmount", async () => {
  let finish!: (value: InboxSourceMessage) => void;
  mocks.read.mockReturnValueOnce(new Promise((resolve) => { finish = resolve; })); await render();
  const old = mocks.read.mock.calls[0]!;
  mocks.citadel = "b"; await render(); mocks.citadel = "a"; await render();
  expect(old[2].aborted).toBe(true); expect(old[3]()).toBe(false);
  await act(async () => { finish({ ...message, text: "Stale content" }); });
  expect(host.textContent).not.toContain("Stale content");
  await act(async () => root.render(<QueryClientProvider client={client}><p>Closed</p></QueryClientProvider>));
  expect(mocks.read.mock.calls.at(-1)![3]()).toBe(false);
});
