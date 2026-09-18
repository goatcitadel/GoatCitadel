import { act, create, type ReactTestInstance, type ReactTestRenderer } from "react-test-renderer";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { McpServerRecord } from "@goatcitadel/contracts";
import { ConfirmModal } from "@goatcitadel/mission-control-shared/components/ConfirmModal";
import { ApiRequestError } from "@goatcitadel/mission-control-shared/api/http-internal";
import { McpSection } from "./McpSection";
import type { SettingsSectionProps } from "../SettingsShared";
import { __resetSessionDraftsForTests } from "../../library/session-drafts";
import { __resetFormDirtyRegistryForTests } from "../../library/use-form-dirty";
import { __resetSessionViewStateForTests } from "../../../../hooks/use-session-view-state";

const api = vi.hoisted(() => ({ fetchMcpServers: vi.fn(), fetchMcpServer: vi.fn(), fetchMcpElicitations: vi.fn(), updateMcpServer: vi.fn(), deleteMcpServer: vi.fn(), createMcpServer: vi.fn() }));
vi.mock("@goatcitadel/mission-control-shared/api/client", async importOriginal => ({ ...await importOriginal<object>(), ...api }));
const renderers: ReactTestRenderer[] = [];
const server = (revision = "a", patch: Partial<McpServerRecord> = {}): McpServerRecord => ({ serverId: "fixture-server", label: "Fixture MCP", transport: "stdio", command: "node", args: ["--password", "[REDACTED]"], authType: "none", enabled: false, status: "disconnected", category: "development", trustTier: "restricted", costTier: "free", policy: { requireFirstToolApproval: true, redactionMode: "strict", allowedToolPatterns: [], blockedToolPatterns: [], allowedEnvKeys: [] }, revision: revision.repeat(64), createdAt: "2026-09-13T00:00:00.000Z", updatedAt: "2026-09-13T00:00:00.001Z", ...patch });
const failure = (status = 409) => new ApiRequestError("Synthetic MCP failure", { kind: "http", method: "PATCH", path: "/fixture", status });
const textOf = (node: ReactTestInstance | string): string => typeof node === "string" ? node : node.children.map(textOf).join(" ");
const button = (page: ReactTestRenderer, label: string) => {
  const found = page.root.findAllByType("button").find(node => textOf(node).trim() === label) ?? page.root.findAllByType("button").find(node => textOf(node).includes(label));
  if (!found) throw new Error(`Button missing: ${label}`); return found;
};
const click = async (page: ReactTestRenderer, label: string) => { await act(async () => { void button(page, label).props.onClick(); }); };
const label = (page: ReactTestRenderer) => page.root.findByProps({ "aria-label": "MCP server label" });
const typeLabel = async (page: ReactTestRenderer, value: string) => { await act(async () => { label(page).props.onChange({ target: { value } }); }); };
const modal = (page: ReactTestRenderer) => page.root.findAllByType(ConfirmModal).find(node => node.props.title === "Delete MCP server?")!;
const props = (activeWorkspaceId = "fixture-workspace"): SettingsSectionProps => ({ activeWorkspaceId, activeWorkspaceName: "Fixture", section: "mcp", route: { area: "settings", section: "mcp" }, navigate: vi.fn(), setActiveWorkspaceId: vi.fn() });
async function mount() { let page!: ReactTestRenderer; await act(async () => { page = create(<McpSection {...props()} />); }); renderers.push(page); return page; }
async function edit(page: ReactTestRenderer) { await click(page, "Fixture MCP"); await click(page, "Edit server"); await typeLabel(page, "Local draft"); }
function deferred<T>() { let resolve!: (value: T) => void; const promise = new Promise<T>(yes => { resolve = yes; }); return { promise, resolve }; }
beforeEach(() => {
  vi.resetAllMocks(); __resetSessionDraftsForTests(); __resetFormDirtyRegistryForTests(); __resetSessionViewStateForTests();
  api.fetchMcpServers.mockResolvedValue({ items: [server()] }); api.fetchMcpElicitations.mockResolvedValue({ items: [] });
  api.fetchMcpServer.mockResolvedValue(server("b", { label: "Peer MCP", command: "peer-node" }));
  api.updateMcpServer.mockResolvedValue(server("c", { label: "Local draft" })); api.deleteMcpServer.mockResolvedValue({ deleted: true });
});
afterEach(async () => { await act(async () => { renderers.splice(0).forEach(page => page.unmount()); }); });

it("retains unsaved edits during a failed refresh, then requires explicit review and a separate save", async () => {
  const page = await mount(); await edit(page);
  api.updateMcpServer.mockRejectedValueOnce(failure()); api.fetchMcpServer.mockRejectedValueOnce(failure(503));
  await click(page, "Save changes");
  expect(label(page).props.value).toBe("Local draft");
  expect(button(page, "Save changes").props.disabled).toBe(true);
  expect(textOf(page.root)).toContain("Current settings could not be loaded");
  await typeLabel(page, "Newer typing");
  await click(page, "Reload server review");
  expect(textOf(page.root)).toContain("peer-node");
  expect(label(page).props.value).toBe("Newer typing");
  await click(page, "Use current server review");
  expect(api.updateMcpServer).toHaveBeenCalledTimes(1);
  await click(page, "Save changes");
  expect(api.updateMcpServer).toHaveBeenLastCalledWith("fixture-server", expect.objectContaining({ expectedRevision: "b".repeat(64), label: "Newer typing", command: "node" }));
  expect(api.fetchMcpServers).toHaveBeenCalledTimes(1);
});

it("retains typing that arrives during a successful save and advances its comparison revision", async () => {
  const page = await mount(); await edit(page);
  const saved = deferred<McpServerRecord>(); api.updateMcpServer.mockReturnValueOnce(saved.promise);
  await click(page, "Save changes"); await typeLabel(page, "Newer typing");
  await act(async () => { saved.resolve(server("b", { label: "Local draft" })); });
  expect(label(page).props.value).toBe("Newer typing");
  await click(page, "Save changes");
  expect(api.updateMcpServer).toHaveBeenLastCalledWith("fixture-server", expect.objectContaining({ expectedRevision: "b".repeat(64), label: "Newer typing" }));
});

it("retains a deleted server's draft without offering a save", async () => {
  const page = await mount(); await edit(page);
  api.updateMcpServer.mockRejectedValueOnce(failure(404)); api.fetchMcpServer.mockRejectedValueOnce(failure(404));
  await click(page, "Save changes");
  expect(textOf(page.root)).toContain("This server was deleted");
  expect(textOf(page.root)).toContain("Local draft");
  expect(page.root.findAllByType("button").some(node => textOf(node).includes("Save changes"))).toBe(false);
});

it("requires a fresh deletion confirmation after reviewing a peer change", async () => {
  const page = await mount(); await click(page, "Fixture MCP"); await click(page, "Delete");
  api.deleteMcpServer.mockRejectedValueOnce(failure());
  await act(async () => { void modal(page).props.onConfirm(); });
  expect(api.deleteMcpServer).toHaveBeenCalledExactlyOnceWith("fixture-server", "a".repeat(64));
  expect(modal(page).props.open).toBe(false);
  expect(button(page, "Delete").props.disabled).toBe(true);
  await click(page, "Use current server review");
  expect(api.deleteMcpServer).toHaveBeenCalledTimes(1);
  await click(page, "Delete"); expect(modal(page).props.open).toBe(true);
  await act(async () => { void modal(page).props.onConfirm(); });
  expect(api.deleteMcpServer).toHaveBeenLastCalledWith("fixture-server", "b".repeat(64));
  expect(api.fetchMcpServers).toHaveBeenCalledTimes(1);
});

it.each(["write", "review"] as const)("ignores a late %s after switching workspace and back", async stage => {
  const page = await mount(); await edit(page);
  const pending = deferred<McpServerRecord>();
  if (stage === "write") api.updateMcpServer.mockReturnValueOnce(pending.promise);
  else { api.updateMcpServer.mockRejectedValueOnce(failure()); api.fetchMcpServer.mockReturnValueOnce(pending.promise); }
  await click(page, "Save changes");
  await act(async () => { page.update(<McpSection {...props("other-workspace")} />); });
  await act(async () => { page.update(<McpSection {...props()} />); });
  await act(async () => { pending.resolve(server("f", { label: "Stale response" })); });
  expect(textOf(page.root)).not.toContain("Stale response");
  await click(page, "Fixture MCP"); await click(page, "Edit server");
  expect(button(page, "Save changes").props.disabled).toBe(false);
  expect(label(page).props.value).toBe("Local draft");
});
