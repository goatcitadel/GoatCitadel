// @vitest-environment happy-dom
import { act, StrictMode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { McpServerRecord } from "@goatcitadel/contracts";
import { McpServersSettings } from "./McpServersSettings";
import { __resetMcpCreationForTests } from "../../../features/native-routes/settings/mcp-create-mutation";
import { __resetMcpServerMutationsForTests } from "../../../features/native-routes/settings/mcp-server-mutation";
import { __resetSessionDraftsForTests } from "../../../features/native-routes/library/session-drafts";
import { __resetFormDirtyRegistryForTests } from "../../../features/native-routes/library/use-form-dirty";

const api = vi.hoisted(() => ({
  fetchMcpServers: vi.fn(), fetchMcpTemplates: vi.fn(), createMcpServer: vi.fn(), fetchMcpServer: vi.fn(),
}));
vi.mock("@goatcitadel/mission-control-shared/api/client", async original => ({ ...(await original<object>()), ...api }));
const saved: McpServerRecord = {
  serverId: "confirmed-server", revision: "a".repeat(64), label: "Read-only fixture", transport: "stdio",
  command: "node", args: ["--version"], authType: "none", enabled: false, status: "disconnected",
  category: "development", trustTier: "restricted", costTier: "unknown",
  policy: { requireFirstToolApproval: false, redactionMode: "basic", allowedToolPatterns: [], blockedToolPatterns: [], allowedEnvKeys: [] },
  createdAt: "2026-09-30T00:00:00Z", updatedAt: "2026-09-30T00:00:00Z",
};
let root: Root, container: HTMLDivElement, client: QueryClient;
function dialog(name: string) {
  return [...document.querySelectorAll<HTMLElement>('[role="dialog"]')].find(element => {
    const title = document.getElementById(element.getAttribute("aria-labelledby") ?? "");
    return title?.textContent === name;
  })!;
}
function button(scope: HTMLElement, name: string) {
  return [...scope.querySelectorAll<HTMLButtonElement>("button")].find(element => element.textContent === name)!;
}
async function click(scope: HTMLElement, name: string) {
  const target = button(scope, name);
  expect(target, name).toBeTruthy();
  await act(async () => target.click());
}
beforeEach(() => {
  vi.resetAllMocks(); __resetMcpCreationForTests(); __resetMcpServerMutationsForTests();
  __resetSessionDraftsForTests(); __resetFormDirtyRegistryForTests();
  api.fetchMcpServers.mockResolvedValue({ items: [] });
  api.fetchMcpTemplates.mockResolvedValue({ items: [{ ...saved, templateId: "fixture", description: "Disabled fixture", enabledByDefault: false }] });
  api.createMcpServer.mockResolvedValue(structuredClone(saved));
  client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  container = document.createElement("div"); document.body.append(container); root = createRoot(container);
});
afterEach(async () => {
  await act(async () => root.unmount()); client.clear(); container.remove();
});

it("retains one real registration dialog and the confirmed saved identity after asynchronous readback resets its draft", async () => {
  let confirm!: (value: McpServerRecord) => void;
  api.fetchMcpServer.mockReturnValue(new Promise<McpServerRecord>(resolve => { confirm = resolve; }));
  await act(async () => root.render(<StrictMode><QueryClientProvider client={client}>
    <McpServersSettings workspaceId="workspace-a" />
  </QueryClientProvider></StrictMode>));
  await vi.waitFor(() => expect(button(container, "Register MCP server")?.disabled).toBe(false));
  await click(container, "Register MCP server");
  const registration = dialog("Register MCP server"); expect(registration).toBeTruthy();
  await vi.waitFor(() => expect(button(registration, "Use Read-only fixture template")).toBeTruthy());
  await click(registration, "Use Read-only fixture template");
  await click(registration, "Review MCP registration");
  await click(registration, "Cancel registration review");
  await click(registration, "Close registration");
  expect(dialog("Unsaved changes")).toBeTruthy();
  await click(dialog("Unsaved changes"), "Cancel");
  expect([...document.querySelectorAll('[role="dialog"][data-state="open"]')]).toHaveLength(1);
  await click(registration, "Review MCP registration");
  await click(registration, "Register reviewed MCP server");
  expect(api.createMcpServer).toHaveBeenCalledTimes(1);
  expect(registration.textContent).not.toContain("saved configuration confirmed");
  // Release the separate canonical owner read only after the registration
  // event has completed, so the real query cache and portal update together.
  await act(async () => confirm(structuredClone(saved)));
  await vi.waitFor(() => expect(registration.textContent).toContain("Saved server ID: confirmed-server"));
  expect(dialog("Register MCP server")).toBe(registration);
  expect([...document.querySelectorAll<HTMLElement>('[role="dialog"]')].map(element => ({
    title: document.getElementById(element.getAttribute("aria-labelledby") ?? "")?.textContent,
    state: element.dataset.state, id: element.id, hidden: element.getAttribute("aria-hidden"),
    saved: element.textContent?.includes("Saved server ID"), notice: element.textContent?.includes("configuration confirmed"),
  }))).toEqual([{ title: "Register MCP server", state: "open", id: registration.id, hidden: null, saved: true, notice: true }]);
  expect(registration.textContent).toContain("registered and saved configuration confirmed");
  expect(api.createMcpServer).toHaveBeenCalledTimes(1);
  expect(api.fetchMcpServer).toHaveBeenCalledExactlyOnceWith(saved.serverId);
});
