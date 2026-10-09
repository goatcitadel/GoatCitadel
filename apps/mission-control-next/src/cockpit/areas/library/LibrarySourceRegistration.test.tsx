import { getDirtySectionKeys, __resetFormDirtyRegistryForTests } from "../../../features/native-routes/library/use-form-dirty";
import { useSessionDraft } from "../../../features/native-routes/library/session-drafts";
// @vitest-environment happy-dom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { beforeEach, afterEach, it, expect, vi } from "vitest";
import { LibrarySourceRegistration } from "./LibrarySourceRegistration";
import { __resetApprovalOperationAttemptsForTests } from "../inbox/approval-operation-attempts";
import { __resetSessionViewStateForTests } from "../../../hooks/use-session-view-state";
import { __resetSessionDraftsForTests } from "../../../features/native-routes/library/session-drafts";
import { setGatewayCallerScope } from "@goatcitadel/mission-control-shared/api/access-scope";
const mocks = vi.hoisted(() => ({ resolve: vi.fn(), inspect: vi.fn(), register: vi.fn(), workspaces: vi.fn(), registered: vi.fn() }));
vi.mock("@goatcitadel/mission-control-shared/api/external-sources", () => ({ resolveExternalSourcePath: mocks.resolve, inspectExternalSourcePath: mocks.inspect, registerExternalSource: mocks.register }));
vi.mock("@goatcitadel/mission-control-shared/api/workspaces", () => ({ fetchWorkspaces: mocks.workspaces }));
const bridge = { workspaceId: "one", status: "verified", canonicalHostPath: "C:/owned/source", inputFlavor: "windows_native", targetFlavor: "windows_native", gitIdentityRequired: false, snapshotId: "bridge-a", snapshotSha256: "hash-a", createdAt: "2026-10-01" };
let root: Root, container: HTMLDivElement;
beforeEach(() => { vi.resetAllMocks(); __resetApprovalOperationAttemptsForTests(); __resetSessionViewStateForTests(); __resetSessionDraftsForTests(); __resetFormDirtyRegistryForTests(); setGatewayCallerScope("a"); container=document.createElement("div"); document.body.append(container); root=createRoot(container); mocks.resolve.mockResolvedValue(bridge); mocks.inspect.mockResolvedValue(bridge); mocks.workspaces.mockResolvedValue({ items: [{ workspaceId: "one", lifecycleStatus: "active", revision: 4 }] }); mocks.register.mockResolvedValue({ source: { sourceId: "source-a", workspaceId: "one", canonicalRootPath: bridge.canonicalHostPath, pathBridgeSnapshotSha256: bridge.snapshotSha256, kind: "codex_sessions", label: "Source A" } }); });
afterEach(() => { act(() => root.unmount()); container.remove(); });
function UnrelatedDraft() { const draft = useSessionDraft("unrelated-fix1", { text: "" }, undefined, { label: "Unrelated draft" }); return <button type="button" onClick={() => draft.setValue({ text: "Unrelated retained text" })}>Edit unrelated draft</button>; }
async function render(unrelated = false) { await act(async () => root.render(<><LibrarySourceRegistration workspaceId="one" onRegistered={mocks.registered} />{unrelated ? <UnrelatedDraft /> : null}</>)); }
async function click(name: string) { const button=[...document.querySelectorAll<HTMLButtonElement>("button")].find(node => !node.closest('[aria-hidden="true"]') && node.textContent===name)!; expect(button).toBeTruthy(); await act(async () => button.click()); }
async function fill(label: string, value: string) { const l=[...container.querySelectorAll("label")].find(node=>node.textContent===label)!; const input=container.querySelector<HTMLInputElement>('#'+l.htmlFor)!; await act(async () => { Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,"value")!.set!.call(input,value); input.dispatchEvent(new Event("input",{bubbles:true})); }); }
async function prepare(unrelated = false) { await render(unrelated); if (unrelated) await click("Edit unrelated draft"); await fill("External source label", "Source A"); await fill("External source root", "C:/owned/source"); await fill("Accepted producer versions", "test-1"); await click("Verify external source path"); await click("Review source registration"); }
it("verifies the path before review and registers exactly the current workspace revision and snapshot", async () => {
 await prepare(); expect(mocks.register).not.toHaveBeenCalled(); expect(document.querySelector('[role="dialog"]')?.textContent).toContain("C:/owned/source"); await click("Confirm source registration"); expect(mocks.inspect).toHaveBeenCalledExactlyOnceWith("one", "bridge-a"); expect(mocks.register).toHaveBeenCalledExactlyOnceWith({ workspaceId: "one", expectedWorkspaceRevision: 4, kind: "codex_sessions", label: "Source A", canonicalRootPath: "C:/owned/source", pathBridgeSnapshotId: "bridge-a", pathBridgeSnapshotSha256: "hash-a", inputFlavor: "windows_native", targetFlavor: "windows_native", requireGitIdentity: false, acceptedProducerVersions: ["test-1"] }); expect(mocks.registered).toHaveBeenCalledWith("source-a");
});
it("withholds registration after the reviewed path snapshot changes", async () => { await prepare(); mocks.inspect.mockResolvedValue({ ...bridge, snapshotSha256: "changed" }); await click("Confirm source registration"); expect(mocks.register).not.toHaveBeenCalled(); expect(document.body.textContent).toContain("evidence changed"); });
it("withholds registration across an awaited caller switch and isolates the draft", async () => { await prepare(); let finish!: (value: unknown) => void; mocks.workspaces.mockReturnValueOnce(new Promise(resolve=>{finish=resolve})); await click("Confirm source registration"); await act(async () => setGatewayCallerScope("b")); await act(async () => finish({ items: [{ workspaceId: "one", revision: 4, lifecycleStatus: "active" }] })); expect(mocks.register).not.toHaveBeenCalled(); expect([...container.querySelectorAll("input")].some(input=>input.value==="Source A")).toBe(false); });
it("retains unknown registration outcomes across remount", async () => { await prepare(); mocks.register.mockRejectedValue(new Error("Lost response")); await click("Confirm source registration"); await act(async () => root.render(<div/>)); await render(); expect(document.body.textContent).toContain("uncertain"); await click("Review source registration"); expect(mocks.register).toHaveBeenCalledTimes(1); });

it("acknowledges only the committed draft before selecting the registered record", async () => {
 await prepare(); expect(getDirtySectionKeys()).toHaveLength(1); let dirtyAtNavigation: readonly string[] = ["not called"]; mocks.registered.mockImplementation(() => { dirtyAtNavigation = [...getDirtySectionKeys()]; });
 await click("Confirm source registration"); expect(dirtyAtNavigation).toEqual([]); expect(getDirtySectionKeys()).toEqual([]); expect(mocks.registered).toHaveBeenCalledExactlyOnceWith("source-a");
 await click("Review source registration"); expect(document.querySelector('[role="dialog"]')).toBeNull(); await act(async () => root.render(<div />)); await render(); await click("Inspect registered source"); expect(mocks.register).toHaveBeenCalledTimes(1); expect(mocks.registered).toHaveBeenLastCalledWith("source-a");
});
it("preserves newer registration edits and unrelated dirty drafts through the saved receipt", async () => {
 await prepare(true); let finish!: (value: unknown) => void; mocks.register.mockReturnValueOnce(new Promise(resolve => { finish = resolve; })); await click("Confirm source registration"); await fill("External source label", "Later draft text");
 let dirtyAtNavigation: readonly string[] = []; mocks.registered.mockImplementation(() => { dirtyAtNavigation = [...getDirtySectionKeys()]; });
 await act(async () => finish({ source: { sourceId: "source-a", workspaceId: "one", canonicalRootPath: bridge.canonicalHostPath, pathBridgeSnapshotSha256: bridge.snapshotSha256, kind: "codex_sessions", label: "Source A" } }));
 expect(dirtyAtNavigation).toHaveLength(2); expect(dirtyAtNavigation.some(key => key.includes("unrelated-fix1"))).toBe(true); expect([...container.querySelectorAll("input")].some(input => input.value === "Later draft text")).toBe(true); await click("Inspect registered source"); expect(mocks.register).toHaveBeenCalledTimes(1); expect(mocks.registered).toHaveBeenLastCalledWith("source-a"); expect(getDirtySectionKeys()).toHaveLength(2);
});
it("keeps canonical save separate from failed navigation and retries only inspection", async () => {
 await prepare(); mocks.registered.mockImplementationOnce(() => { throw new Error("Navigation blocked"); }); await click("Confirm source registration"); expect(document.body.textContent).toContain("Registration is saved. Inspection did not open"); expect(getDirtySectionKeys()).toEqual([]); await click("Inspect registered source"); expect(mocks.register).toHaveBeenCalledTimes(1); expect(mocks.registered).toHaveBeenCalledTimes(2); expect(mocks.registered).toHaveBeenLastCalledWith("source-a");
});
it.each(["foreign receipt", "late caller"])("does not select a destination from %s", async mode => {
 await prepare(); let finish!: (value: unknown) => void; mocks.register.mockReturnValueOnce(new Promise(resolve => { finish = resolve; })); await click("Confirm source registration");
 if (mode === "late caller") await act(async () => setGatewayCallerScope("b"));
 await act(async () => finish({ source: { sourceId: "other", workspaceId: mode === "foreign receipt" ? "other" : "one", canonicalRootPath: bridge.canonicalHostPath, pathBridgeSnapshotSha256: bridge.snapshotSha256, kind: "codex_sessions", label: "Source A" } }));
 expect(mocks.registered).not.toHaveBeenCalled(); expect(document.body.textContent).not.toContain("Saved source:");
 if (mode === "late caller") { await act(async () => setGatewayCallerScope("a")); expect(document.body.textContent).toContain("Saved source: Source A"); expect(getDirtySectionKeys()).toEqual([]); await click("Inspect registered source"); expect(mocks.registered).toHaveBeenCalledExactlyOnceWith("other"); expect(mocks.register).toHaveBeenCalledTimes(1); }
});
