// @vitest-environment happy-dom
import { StrictMode, type ReactNode } from "react";
import { act, create, type ReactTestInstance, type ReactTestRenderer } from "react-test-renderer";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { beforeEach, afterEach, describe, expect, it, vi } from "vitest";
import type { CitadelCreateInput, CitadelRecord, CitadelUpdateInput } from "@goatcitadel/contracts";
import { __resetSessionDraftsForTests } from "../../../features/native-routes/library/session-drafts";
import { __resetWorkspaceAttemptsForTests } from "../../../features/native-routes/settings/workspace-editor-state";
import { CitadelDirectory } from "./CitadelDirectory";

const api = vi.hoisted(() => ({ listCitadels: vi.fn(), createCitadel: vi.fn(), updateCitadel: vi.fn(), archiveCitadel: vi.fn(), restoreCitadel: vi.fn() }));
const selection = vi.hoisted(() => ({ setActiveCitadelId: vi.fn() }));
vi.mock("@goatcitadel/mission-control-shared/api/client", async original => ({ ...(await original<object>()), ...api }));
vi.mock("@goatcitadel/mission-control-shared/state/ui-preferences", () => ({ useUiPreferences: () => selection }));
vi.mock("../../ui/Dialog", () => ({ Dialog: ({ open, title, children }: { open: boolean; title: string; children: ReactNode }) => open ? <div role="dialog" aria-label={title}>{children}</div> : null }));
const record = (id = "one", patch: Partial<CitadelRecord> = {}): CitadelRecord => ({ citadelId: id, slug: id, name: `Citadel ${id}`, description: "Saved description", kind: "team",
  revision: "a".repeat(64), lifecycleStatus: "active", createdAt: "2026-09-30T00:00:00.000Z", updatedAt: "2026-09-30T00:00:00.000Z", ...patch });
let rows: CitadelRecord[], client: QueryClient, view: ReactTestRenderer | undefined, revision: number;
const text = (node: ReactTestInstance | string): string => typeof node === "string" ? node : node.children.map(text).join("");
const button = (label: string) => view!.root.findAllByType("button").find(node => node.props["aria-label"] === label || text(node) === label)!;
const field = (label: string) => view!.root.findByProps({ id: view!.root.findAllByType("label").find(node => text(node) === label)!.props.htmlFor });
const write = async (label: string, value: string) => { await act(async () => field(label).props.onChange({ target: { value } })); };
const settle = () => act(async () => { await new Promise(resolve => setTimeout(resolve, 0)); });
async function click(label: string) { expect(button(label), label).toBeTruthy(); expect(button(label).props.disabled).not.toBe(true); await act(async () => button(label).props.onClick()); await settle(); }
const deferred = <T,>() => { let resolve!: (value: T) => void; const promise = new Promise<T>(yes => { resolve = yes; }); return { promise, resolve }; };
const tree = (active = "one") => <StrictMode><QueryClientProvider client={client}><CitadelDirectory activeCitadelId={active} /></QueryClientProvider></StrictMode>;
async function render(active = "one") { await act(async () => { if (view) view.update(tree(active)); else view = create(tree(active)); }); await settle(); }
function change(id: string, patch: Partial<CitadelRecord>) {
  revision++;
  const saved = { ...rows.find(row => row.citadelId === id)!, ...patch, revision: revision.toString(16).padStart(64, "0"), updatedAt: new Date(Date.UTC(2026, 8, 30, 0, 0, revision)).toISOString() };
  rows = rows.map(row => row.citadelId === id ? saved : row); return structuredClone(saved);
}
beforeEach(() => {
  vi.resetAllMocks(); __resetSessionDraftsForTests(); __resetWorkspaceAttemptsForTests(); revision = 1;
  client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } });
  rows = [record(), record("two", { defaultWorkspaceId: "two-default" })];
  api.listCitadels.mockImplementation(async () => ({ items: structuredClone(rows) }));
  api.createCitadel.mockImplementation(async (input: CitadelCreateInput) => {
    const slug = input.slug || input.name.toLowerCase().replaceAll(" ", "-");
    const saved = record(slug, { name: input.name, description: input.description, kind: input.kind ?? "custom" }); rows.push(saved); return structuredClone(saved);
  });
  api.updateCitadel.mockImplementation(async (id: string, input: CitadelUpdateInput) => { const { expectedRevision: _, ...patch } = input; return change(id, patch); });
  api.archiveCitadel.mockImplementation(async (id: string) => { const saved = change(id, { lifecycleStatus: "archived" }); return changeArchiveTimestamp(saved); });
  api.restoreCitadel.mockImplementation(async (id: string) => change(id, { lifecycleStatus: "active", archivedAt: undefined }));
});
function changeArchiveTimestamp(saved: CitadelRecord) { saved.archivedAt = saved.updatedAt; rows = rows.map(row => row.citadelId === saved.citadelId ? saved : row); return structuredClone(saved); }
afterEach(async () => { await act(async () => view?.unmount()); view = undefined; client.clear(); __resetSessionDraftsForTests(); __resetWorkspaceAttemptsForTests(); });

describe("native Citadel directory", () => {
  it("creates and edits exact metadata without selecting the new Citadel", async () => {
    await render(); await click("New Citadel"); await write("New Citadel name", "New team"); await write("Citadel slug", "new-team"); await write("Citadel kind", "team"); await write("Citadel description", "Reviewed metadata");
    await click("Create Citadel");
    await vi.waitFor(() => expect(button("Save Citadel metadata")).toBeTruthy());
    expect(api.createCitadel).toHaveBeenCalledExactlyOnceWith({ name: "New team", slug: "new-team", kind: "team", description: "Reviewed metadata" });
    await write("Citadel name", "Renamed team"); await click("Save Citadel metadata");
    expect(api.updateCitadel).toHaveBeenCalledExactlyOnceWith("new-team", { expectedRevision: "a".repeat(64), name: "Renamed team", slug: "new-team", kind: "team", description: "Reviewed metadata" });
    expect(selection.setActiveCitadelId).not.toHaveBeenCalled(); expect(api.listCitadels).toHaveBeenCalledWith("all", 500);
  });
  it("requires explicit lifecycle confirmation and preserves saved metadata and default workspace", async () => {
    await render(); const original = structuredClone(rows[1]!);
    await click("Archive Citadel Citadel two"); await click("Cancel"); expect(api.archiveCitadel).not.toHaveBeenCalled();
    await click("Archive Citadel Citadel two"); await click("Confirm archive Citadel");
    expect(api.archiveCitadel).toHaveBeenCalledExactlyOnceWith("two", original.revision);
    await vi.waitFor(() => expect(button("Restore Citadel Citadel two")).toBeTruthy());
    const archived = structuredClone(rows[1]!); await click("Restore Citadel Citadel two"); await click("Confirm restore Citadel");
    expect(api.restoreCitadel).toHaveBeenCalledExactlyOnceWith("two", archived.revision);
    expect(rows[1]).toMatchObject({ ...original, revision: expect.any(String), updatedAt: expect.any(String), lifecycleStatus: "active" });
    expect(selection.setActiveCitadelId).not.toHaveBeenCalled();
  });
  it("withholds a stale metadata write and keeps the draft for explicit rebase", async () => {
    await render(); await click("Edit Citadel Citadel two"); await write("Citadel name", "Retained draft");
    const peer = change("two", { description: "Peer saved" }); await click("Save Citadel metadata");
    expect(api.updateCitadel).not.toHaveBeenCalled(); await vi.waitFor(() => expect(button("Apply draft to current Citadel")).toBeTruthy());
    expect(field("Citadel name").props.value).toBe("Retained draft"); await click("Apply draft to current Citadel"); await click("Save Citadel metadata");
    expect(api.updateCitadel).toHaveBeenCalledWith("two", expect.objectContaining({ expectedRevision: peer.revision, name: "Retained draft" }));
  });
  it("rejects a changed lifecycle record before dispatch and requires a fresh review", async () => {
    await render(); await click("Archive Citadel Citadel two"); const peer = change("two", { description: "Peer saved" });
    await click("Confirm archive Citadel"); expect(api.archiveCitadel).not.toHaveBeenCalled();
    expect(text(view!.root)).toContain("reviewed record changed"); await click("Refresh Citadels");
    await click("Archive Citadel Citadel two"); await click("Confirm archive Citadel"); expect(api.archiveCitadel).toHaveBeenCalledExactlyOnceWith("two", peer.revision);
  });
  it("retains lost creation uncertainty across remount and active scope changes", async () => {
    await render(); await click("New Citadel"); await write("New Citadel name", "Unknown team");
    api.createCitadel.mockRejectedValueOnce(new Error("Lost owner response")); await click("Create Citadel");
    await act(async () => view!.unmount()); view = undefined; await render("two"); await click("New Citadel");
    expect(button("Create Citadel").props.disabled).toBe(true); expect(text(view!.root)).toContain("save outcome is unconfirmed"); expect(api.createCitadel).toHaveBeenCalledTimes(1);
  });
  it("retains lost lifecycle uncertainty across remount and blocks both edit and retry", async () => {
    await render(); await click("Archive Citadel Citadel two"); api.archiveCitadel.mockRejectedValueOnce(new Error("Lost response")); await click("Confirm archive Citadel");
    await act(async () => view!.unmount()); view = undefined; await render("two");
    expect(button("Archive Citadel Citadel two").props.disabled).toBe(true); expect(button("Edit Citadel Citadel two").props.disabled).toBe(true);
    expect(text(view!.root)).toContain("lifecycle write outcome is unconfirmed"); expect(api.archiveCitadel).toHaveBeenCalledTimes(1);
  });
  it("cancels lifecycle preflight after away-and-back scope changes", async () => {
    await render(); await click("Archive Citadel Citadel two"); const read = deferred<{ items: CitadelRecord[] }>(); api.listCitadels.mockReturnValueOnce(read.promise);
    await click("Confirm archive Citadel"); await render("two"); await render("one");
    await act(async () => { read.resolve({ items: structuredClone(rows) }); }); await settle(); expect(api.archiveCitadel).not.toHaveBeenCalled();
  });
  it("keeps newer text in another selected editor when an earlier save settles", async () => {
    await render(); await click("Edit Citadel Citadel one"); await write("Citadel name", "Saved one");
    const response = deferred<CitadelRecord>(); api.updateCitadel.mockReturnValueOnce(response.promise); await click("Save Citadel metadata");
    await click("Edit Citadel Citadel two"); await write("Citadel name", "Newer two draft");
    await act(async () => { response.resolve(change("one", { name: "Saved one" })); }); await settle();
    expect(field("Citadel name").props.value).toBe("Newer two draft"); expect(text(view!.root)).toContain("Close Citadel editor and keep draft"); expect(api.updateCitadel).toHaveBeenCalledTimes(1);
    expect(selection.setActiveCitadelId).not.toHaveBeenCalled();
  });
});
