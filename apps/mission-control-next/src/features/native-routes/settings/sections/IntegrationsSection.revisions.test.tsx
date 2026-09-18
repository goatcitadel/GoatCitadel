import { act, create, type ReactTestInstance, type ReactTestRenderer } from "react-test-renderer";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { IntegrationConnection } from "@goatcitadel/contracts";
import { ConfirmModal } from "@goatcitadel/mission-control-shared/components/ConfirmModal";
import { ApiRequestError } from "@goatcitadel/mission-control-shared/api/http-internal";
import { IntegrationsSection } from "./IntegrationsSection";
import type { SettingsSectionProps } from "../SettingsShared";
import { __resetSessionDraftsForTests } from "../../library/session-drafts";
import { __resetFormDirtyRegistryForTests } from "../../library/use-form-dirty";
import { __resetSessionViewStateForTests } from "../../../../hooks/use-session-view-state";

const api = vi.hoisted(() => ({ fetchIntegrationCatalog: vi.fn(), fetchIntegrationConnections: vi.fn(), fetchIntegrationConnection: vi.fn(), fetchSettings: vi.fn(), fetchIntegrationFormSchema: vi.fn(), createIntegrationConnection: vi.fn(), updateIntegrationConnection: vi.fn(), deleteIntegrationConnection: vi.fn() }));
vi.mock("@goatcitadel/mission-control-shared/api/client", async importOriginal => ({ ...await importOriginal<object>(), ...api }));
const renderers: ReactTestRenderer[] = [];
const connection = (revision = "a", patch: Partial<IntegrationConnection> = {}): IntegrationConnection => ({ connectionId: "fixture-connection", catalogId: "productivity.github", kind: "productivity", key: "github", label: "Fixture GitHub", enabled: true, status: "connected", config: { owner: "original-owner", apiKey: "[REDACTED]" }, revision: revision.repeat(64), createdAt: "2026-09-13T00:00:00.000Z", updatedAt: "2026-09-13T00:00:00.001Z", ...patch });
const failure = (status = 409) => new ApiRequestError(status === 409 ? "Connection changed" : "Synthetic read unavailable", { kind: "http", method: "PATCH", path: "/fixture", status });
const textOf = (node: ReactTestInstance | string): string => typeof node === "string" ? node : node.children.map(textOf).join(" ");
const button = (page: ReactTestRenderer, label: string) => {
  const buttons = page.root.findAllByType("button");
  const found = buttons.find(node => textOf(node).trim() === label) ?? buttons.find(node => textOf(node).includes(label));
  if (!found) throw new Error(`Button missing: ${label}`);
  return found;
};
const click = async (page: ReactTestRenderer, label: string) => { await act(async () => { void button(page, label).props.onClick(); }); };
const labelInput = (page: ReactTestRenderer, value: string) => page.root.findAllByType("input").find(node => node.props.value === value)!;
const editLabel = async (page: ReactTestRenderer, old: string, value: string) => { await act(async () => { labelInput(page, old).props.onChange({ target: { value } }); }); };
const modal = (page: ReactTestRenderer) => page.root.findAllByType(ConfirmModal).find(node => node.props.title === "Delete integration connection?")!;
const props = (activeWorkspaceId = "fixture-workspace"): SettingsSectionProps => ({ activeWorkspaceId, activeWorkspaceName: "Fixture", section: "integrations", route: { area: "settings", section: "integrations" }, navigate: vi.fn(), setActiveWorkspaceId: vi.fn() });
async function mount() { let page!: ReactTestRenderer; await act(async () => { page = create(<IntegrationsSection {...props()} />); }); renderers.push(page); return page; }
async function edit(page: ReactTestRenderer) { await click(page, "Fixture GitHub"); await click(page, "Edit connection"); await editLabel(page, "Fixture GitHub", "Local draft"); }
function deferred<T>() { let resolve!: (value: T) => void; const promise = new Promise<T>(yes => { resolve = yes; }); return { promise, resolve }; }
beforeEach(() => {
  vi.resetAllMocks(); __resetSessionDraftsForTests(); __resetFormDirtyRegistryForTests(); __resetSessionViewStateForTests();
  api.fetchIntegrationCatalog.mockResolvedValue({ items: [{ catalogId: "productivity.github", key: "github", label: "GitHub", kind: "productivity", capabilities: [], authMethods: [] }] });
  api.fetchIntegrationConnections.mockResolvedValue({ items: [connection()] });
  api.fetchIntegrationConnection.mockResolvedValue(connection("b", { label: "Peer connection", config: { owner: "peer-owner", apiKey: "[REDACTED]" }, enabled: false, status: "paused" }));
  api.fetchIntegrationFormSchema.mockResolvedValue({ catalogId: "productivity.github", title: "GitHub", fields: [{ key: "owner", label: "Owner", type: "text" }] });
  api.fetchSettings.mockResolvedValue({ features: {} });
  api.updateIntegrationConnection.mockResolvedValue(connection("c", { label: "Local draft" }));
  api.deleteIntegrationConnection.mockResolvedValue({ deleted: true });
});
afterEach(async () => { await act(async () => { renderers.splice(0).forEach(page => page.unmount()); }); });

describe("reviewed integration settings", () => {
  it("retains the draft on conflict and requires explicit current-value review before retry", async () => {
    const page = await mount(); await edit(page);
    api.updateIntegrationConnection.mockRejectedValueOnce(failure());
    await click(page, "Save changes");
    expect(labelInput(page, "Local draft")).toBeTruthy();
    expect(textOf(page.root)).toContain("peer-owner");
    expect(textOf(page.root)).toContain("Paused");
    expect(button(page, "Save changes").props.disabled).toBe(true);
    expect(api.updateIntegrationConnection).toHaveBeenCalledTimes(1);
    await click(page, "Use current connection review");
    expect(api.updateIntegrationConnection).toHaveBeenCalledTimes(1);
    await click(page, "Save changes");
    expect(api.updateIntegrationConnection).toHaveBeenLastCalledWith("fixture-connection", expect.objectContaining({ expectedRevision: "b".repeat(64), label: "Local draft", config: { owner: "original-owner", apiKey: "[REDACTED]" } }));
    expect(api.fetchIntegrationConnections).toHaveBeenCalledTimes(1);
  });
  it("preserves the mounted editor during a failed current-value read and read-only recovery", async () => {
    const page = await mount(); await edit(page);
    api.updateIntegrationConnection.mockRejectedValueOnce(failure());
    api.fetchIntegrationConnection.mockRejectedValueOnce(failure(503));
    await click(page, "Save changes");
    expect(labelInput(page, "Local draft")).toBeTruthy();
    expect(button(page, "Save changes").props.disabled).toBe(true);
    expect(textOf(page.root)).toContain("Current settings could not be loaded");
    await click(page, "Reload connection review");
    expect(api.updateIntegrationConnection).toHaveBeenCalledTimes(1);
    expect(button(page, "Save changes").props.disabled).toBe(true);
    await click(page, "Use current connection review");
    expect(button(page, "Save changes").props.disabled).toBe(false);
  });
  it("retains a draft for a deleted connection and keeps save unavailable", async () => {
    const page = await mount(); await edit(page);
    api.updateIntegrationConnection.mockRejectedValueOnce(failure(404)); api.fetchIntegrationConnection.mockRejectedValueOnce(failure(404));
    await click(page, "Save changes");
    expect(labelInput(page, "Local draft")).toBeTruthy();
    expect(button(page, "Save changes").props.disabled).toBe(true);
    expect(textOf(page.root)).toContain("This connection was deleted");
  });
  it("keeps newer typing when a successful save arrives and uses the acknowledged revision", async () => {
    const page = await mount(); await edit(page);
    const saved = deferred<IntegrationConnection>(); api.updateIntegrationConnection.mockReturnValueOnce(saved.promise);
    await click(page, "Save changes"); await editLabel(page, "Local draft", "Newer typing");
    await act(async () => { saved.resolve(connection("b", { label: "Local draft" })); });
    expect(labelInput(page, "Newer typing")).toBeTruthy();
    await click(page, "Save changes");
    expect(api.updateIntegrationConnection).toHaveBeenLastCalledWith("fixture-connection", expect.objectContaining({ expectedRevision: "b".repeat(64), label: "Newer typing" }));
    expect(api.fetchIntegrationConnections).toHaveBeenCalledTimes(1);
  });
  it("requires a new delete confirmation after a peer change", async () => {
    const page = await mount(); await click(page, "Fixture GitHub"); await click(page, "Delete");
    api.deleteIntegrationConnection.mockRejectedValueOnce(failure());
    await act(async () => { void modal(page).props.onConfirm(); });
    expect(api.deleteIntegrationConnection).toHaveBeenCalledExactlyOnceWith("fixture-connection", "a".repeat(64));
    expect(modal(page).props.open).toBe(false);
    expect(button(page, "Delete").props.disabled).toBe(true);
    await click(page, "Use current connection review");
    expect(api.deleteIntegrationConnection).toHaveBeenCalledTimes(1);
    await click(page, "Delete"); expect(modal(page).props.open).toBe(true);
    await act(async () => { void modal(page).props.onConfirm(); });
    expect(api.deleteIntegrationConnection).toHaveBeenLastCalledWith("fixture-connection", "b".repeat(64));
    expect(textOf(page.root)).toContain("No integration connections yet");
    expect(api.fetchIntegrationConnections).toHaveBeenCalledTimes(1);
  });
  it.each(["write", "review"] as const)("ignores a late %s after switching workspace and back", async stage => {
    const page = await mount(); await edit(page);
    const pending = deferred<IntegrationConnection>();
    if (stage === "write") api.updateIntegrationConnection.mockReturnValueOnce(pending.promise);
    else { api.updateIntegrationConnection.mockRejectedValueOnce(failure()); api.fetchIntegrationConnection.mockReturnValueOnce(pending.promise); }
    await click(page, "Save changes");
    await act(async () => { page.update(<IntegrationsSection {...props("other-workspace")} />); });
    await act(async () => { page.update(<IntegrationsSection {...props()} />); });
    await act(async () => { pending.resolve(connection("f", { label: "Stale response" })); });
    expect(textOf(page.root)).not.toContain("Stale response");
    expect(textOf(page.root)).not.toContain("Use current connection review");
  });
});
