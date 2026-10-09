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
import { __resetIntegrationConnectionMutationsForTests } from "../integration-connection-mutation";

const api = vi.hoisted(() => ({ fetchIntegrationCatalog: vi.fn(), fetchIntegrationConnections: vi.fn(), fetchIntegrationConnection: vi.fn(), fetchSettings: vi.fn(), fetchIntegrationFormSchema: vi.fn(), createIntegrationConnection: vi.fn(), updateIntegrationConnection: vi.fn(), deleteIntegrationConnection: vi.fn() }));
vi.mock("@goatcitadel/mission-control-shared/api/client", async importOriginal => ({ ...await importOriginal<object>(), ...api }));
// Each owner write reports the attempt it dispatched, as the real capture would for its Gateway route.
const attempts = vi.hoisted(() => ({ paths: [] as string[], read: vi.fn() }));
vi.mock("@goatcitadel/mission-control-shared/api/client-core", async importOriginal => ({ ...await importOriginal<object>(), captureMutationAttempt: (dispatch: () => Promise<unknown>, onAttempt: (attempt: unknown) => void) => { const path = attempts.paths.shift(); if (path) onAttempt({ attemptKey: "6f1c2b3a-4d5e-4f60-8a7b-9c0d1e2f3a4b", method: "PATCH", path }); return dispatch(); } }));
vi.mock("@goatcitadel/mission-control-shared/api/mutation-attempts", async importOriginal => ({ ...await importOriginal<object>(), fetchMutationAttempt: attempts.read }));
const renderers: ReactTestRenderer[] = [];
const connection = (revision = "a", patch: Partial<IntegrationConnection> = {}): IntegrationConnection => ({ connectionId: "fixture-connection", catalogId: "productivity.github", kind: "productivity", key: "github", label: "Fixture GitHub", enabled: true, status: "connected", config: { owner: "original-owner", apiKey: "[REDACTED]" }, revision: revision.repeat(64), createdAt: "2026-09-13T00:00:00.000Z", updatedAt: "2026-09-13T00:00:00.001Z", ...patch });
const failure = (status = 409) => new ApiRequestError(status === 409 ? "Connection changed" : "Synthetic read unavailable", { kind: "http", method: "PATCH", path: "/api/v1/integrations/connections/fixture-connection", status, body: status === 409 ? {code:"WRITE_CONFLICT",details:{reason:"INTEGRATION_CONNECTION_REVISION_CONFLICT"}} : status === 404 ? {code:"ENTITY_NOT_FOUND"} : undefined });
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
  __resetIntegrationConnectionMutationsForTests();
  vi.resetAllMocks(); __resetSessionDraftsForTests(); __resetFormDirtyRegistryForTests(); __resetSessionViewStateForTests();
  api.fetchIntegrationCatalog.mockResolvedValue({ items: [{ catalogId: "productivity.github", key: "github", label: "GitHub", kind: "productivity", capabilities: [], authMethods: [] }] });
  api.fetchIntegrationConnections.mockResolvedValue({ items: [connection()] });
  api.fetchIntegrationConnection.mockImplementation(async () => {
    if (api.deleteIntegrationConnection.mock.calls.length) {
      try { if ((await api.deleteIntegrationConnection.mock.results.at(-1)?.value)?.deleted) throw new ApiRequestError("Connection deleted", {kind:"http",method:"GET",path:"/api/v1/integrations/connections/fixture-connection",status:404,body:{code:"ENTITY_NOT_FOUND"}}); }
      catch (error) { if (error instanceof ApiRequestError && error.method === "GET") throw error; }
    }
    if (api.updateIntegrationConnection.mock.calls.length) {
      try { return await api.updateIntegrationConnection.mock.results.at(-1)?.value; }
      catch (error) {
        // The simulated API/transport rejection leaves the peer owner unchanged.
        expect(error).toBeInstanceOf(Error);
      }
    }
    return connection("b", { label: "Peer connection", config: { owner: "peer-owner", apiKey: "[REDACTED]" }, enabled: false, status: "paused" });
  });
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
    api.deleteIntegrationConnection.mockRejectedValueOnce(new ApiRequestError("Connection changed", {kind:"http",method:"DELETE",path:"/api/v1/integrations/connections/fixture-connection",status:409,body:{code:"WRITE_CONFLICT",details:{reason:"INTEGRATION_CONNECTION_REVISION_CONFLICT"}}}));
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
  it("settles a lost connection save through Check outcome after a canonical directory read", async () => {
    attempts.paths.length = 0;
    const page = await mount(); await edit(page);
    attempts.paths.push("/api/v1/integrations/connections/fixture-connection");
    api.updateIntegrationConnection.mockRejectedValueOnce(new Error("Response lost after dispatch"));
    await click(page, "Save changes");
    expect(textOf(page.root)).toContain("outcome is unconfirmed");
    attempts.read.mockResolvedValue({ status: "completed", claimExpired: false });
    const reads = api.fetchIntegrationConnections.mock.calls.length;
    await click(page, "Check outcome");
    await act(async () => { await new Promise(resolve => setTimeout(resolve, 10)); });
    expect(api.fetchIntegrationConnections.mock.calls.length).toBeGreaterThan(reads);
    expect(textOf(page.root)).not.toContain("outcome is unconfirmed");
    expect(textOf(page.root)).toContain("recorded this integration change as processed");
    expect(api.updateIntegrationConnection).toHaveBeenCalledTimes(1);
  });
  it("retains an unknown save lock after review acceptance and remount", async () => {
    const page = await mount(); await edit(page);
    api.updateIntegrationConnection.mockRejectedValueOnce(new Error("Response lost after dispatch"));
    await click(page, "Save changes");
    expect(textOf(page.root)).toContain("outcome is unconfirmed");
    await click(page, "Use current connection review");
    expect(button(page, "Save changes").props.disabled).toBe(true);
    await act(async () => page.unmount());
    const reopened = await mount(); await click(reopened, "Fixture GitHub"); await click(reopened, "Edit connection");
    expect(button(reopened, "Save changes").props.disabled).toBe(true);
    await click(reopened, "Save changes");
    expect(api.updateIntegrationConnection).toHaveBeenCalledTimes(1);
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
