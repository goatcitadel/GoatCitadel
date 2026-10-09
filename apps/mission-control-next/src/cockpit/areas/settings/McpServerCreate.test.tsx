// @vitest-environment happy-dom
import { act, StrictMode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { McpServerRecord, McpServerTemplateRecord } from "@goatcitadel/contracts";
import { McpServersSettings } from "./McpServersSettings";
import { __resetMcpCreationForTests } from "../../../features/native-routes/settings/mcp-create-mutation";
import { __resetMcpServerMutationsForTests } from "../../../features/native-routes/settings/mcp-server-mutation";
import { __resetSessionDraftsForTests, useSessionDraft } from "../../../features/native-routes/library/session-drafts";
import { createEmptyMcpCreateForm, createMcpFormFromTemplate } from "../../../features/native-routes/settings/sections/mcp-editor-drafts";
import { McpServerCreate } from "./McpServerCreate";
import { setGatewayCallerScope, notifyGatewayAccessChanged } from "@goatcitadel/mission-control-shared/api/access-scope";
import { __resetFormDirtyRegistryForTests } from "../../../features/native-routes/library/use-form-dirty";

const api = vi.hoisted(() => ({
  fetchMcpServers: vi.fn(), fetchMcpTemplates: vi.fn(), createMcpServer: vi.fn(), fetchMcpServer: vi.fn(), getGatewayApiBaseUrl: vi.fn(),
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
  return [...scope.querySelectorAll<HTMLButtonElement>("button")].find(element => (element.getAttribute("aria-label") ?? element.textContent) === name)!;
}
async function click(scope: HTMLElement, name: string) {
  const target = button(scope, name);
  expect(target, name).toBeTruthy();
  await act(async () => target.click());
}
beforeEach(() => {
  vi.resetAllMocks(); __resetMcpCreationForTests(); __resetMcpServerMutationsForTests();
  setGatewayCallerScope("");
  api.getGatewayApiBaseUrl.mockReturnValue("http://gateway-a.invalid");
  __resetSessionDraftsForTests(); __resetFormDirtyRegistryForTests();
  api.fetchMcpServers.mockResolvedValue({ items: [] });
  api.fetchMcpTemplates.mockResolvedValue({ items: [{ ...saved, templateId: "fixture", description: "Disabled fixture", enabledByDefault: false }] });
  api.createMcpServer.mockResolvedValue(structuredClone(saved));
  client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  container = document.createElement("div"); document.body.append(container); root = createRoot(container);
});

let observedDraft: ReturnType<typeof useSessionDraft<ReturnType<typeof createEmptyMcpCreateForm>>>;
function DraftProbe({ workspaceId }: { workspaceId: string }) {
  observedDraft = useSessionDraft(`mcp:${workspaceId}:new`, createEmptyMcpCreateForm(), undefined, { label: "Probe", active: false });
  return null;
}
async function mountDraft(workspaceId = "workspace-a") {
  await act(async () => root.render(<QueryClientProvider client={client}>
    <McpServerCreate workspaceId={workspaceId} onClose={() => undefined} /><DraftProbe workspaceId={workspaceId} />
  </QueryClientProvider>));
  await vi.waitFor(() => expect(button(dialog("Register MCP server"), "Use Read-only fixture template")).toBeTruthy());
}
const originalDraft = {
  ...createEmptyMcpCreateForm(), label: "Original draft", command: "original-command", args: ["one", "two"],
  url: "https://original.invalid/mcp", enabled: false,
  policy: { requireFirstToolApproval: true, redactionMode: "basic" as const, allowedToolPatterns: ["read_*"], blockedToolPatterns: ["write_*"], allowedEnvKeys: ["PUBLIC_REFERENCE"] },
};
it("preserves every dirty field on Keep or cancel, and applies the entire template only on explicit replacement", async () => {
  const template: McpServerTemplateRecord = { ...saved, templateId: "fixture", description: "Full template copy", enabledByDefault: true,
    transport: "http", url: "https://advertised.invalid/mcp", authType: "oauth2",
    oauth: { authorizationUrl: "https://advertised.invalid/authorize", tokenUrl: "https://advertised.invalid/token", clientIdEnv: "FIXTURE_CLIENT_ID", clientSecretEnv: "FIXTURE_CLIENT_SECRET", scopes: ["read"], redirectUri: "https://callback.invalid/return", tokenRefreshSkewSeconds: 40 },
    policy: { ...saved.policy, requireFirstToolApproval: true, allowedToolPatterns: ["inspect_*"], blockedToolPatterns: ["delete_*"], allowedEnvKeys: ["FIXTURE_CLIENT_ID"] },
  };
  api.fetchMcpTemplates.mockResolvedValue({ items: [template] });
  await mountDraft();
  await act(async () => observedDraft.setValue(structuredClone(originalDraft)));
  await click(dialog("Register MCP server"), "Use Read-only fixture template");
  expect(dialog("Replace MCP registration draft?")).toBeTruthy();
  await click(dialog("Replace MCP registration draft?"), "Keep current draft");
  expect(observedDraft.value).toEqual(originalDraft);
  await click(dialog("Register MCP server"), "Use Read-only fixture template");
  await click(dialog("Replace MCP registration draft?"), "Close dialog");
  expect(observedDraft.value).toEqual(originalDraft);
  await click(dialog("Register MCP server"), "Use Read-only fixture template");
  await act(async () => document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true })));
  expect(observedDraft.value).toEqual(originalDraft);
  expect(dialog("Replace MCP registration draft?")).toBeFalsy();
  await click(dialog("Register MCP server"), "Use Read-only fixture template");
  await click(dialog("Replace MCP registration draft?"), "Replace draft with template");
  expect(observedDraft.value).toEqual(createMcpFormFromTemplate(template));
  expect(observedDraft.value.oauth).toEqual(template.oauth);
  expect(observedDraft.value.policy).toEqual(template.policy);
  expect(api.createMcpServer).not.toHaveBeenCalled();
});
it.each(["draft", "caller", "access", "gateway", "workspace", "template"])("invalidates template replacement after %s changes", async change => {
  await mountDraft();
  await act(async () => observedDraft.setValue(structuredClone(originalDraft)));
  await click(dialog("Register MCP server"), "Use Read-only fixture template");
  expect(dialog("Replace MCP registration draft?")).toBeTruthy();
  const staleConfirm = button(dialog("Replace MCP registration draft?"), "Replace draft with template");
  if (change === "draft") await act(async () => observedDraft.setValue({ ...originalDraft, label: "Newer input" }));
  if (change === "caller") await act(async () => { setGatewayCallerScope("other-caller"); setGatewayCallerScope(""); });
  if (change === "access") await act(async () => notifyGatewayAccessChanged());
  if (change === "gateway") api.getGatewayApiBaseUrl.mockReturnValue("http://gateway-b.invalid");
  if (change === "workspace") { await mountDraft("workspace-b"); await mountDraft(); }
  if (change === "template") await act(async () => client.setQueryData(["settings", "mcp-templates"], { items: [] }));
  await act(async () => staleConfirm.click());
  expect(observedDraft.value).toEqual(change === "draft" ? { ...originalDraft, label: "Newer input" } : originalDraft);
  expect(dialog("Replace MCP registration draft?")).toBeFalsy();
  expect(api.createMcpServer).not.toHaveBeenCalled();
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
