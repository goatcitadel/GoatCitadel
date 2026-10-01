// @vitest-environment happy-dom
import { StrictMode } from "react";
import { act, create, type ReactTestRenderer } from "react-test-renderer";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { McpServerRecord, McpServerTemplateRecord } from "@goatcitadel/contracts";
import { ApiRequestError } from "@goatcitadel/mission-control-shared/api/http-internal";
import { createEmptyMcpCreateForm, createMcpFormFromTemplate } from "./sections/mcp-editor-drafts";
import { prepareMcpCreateInput } from "./mcp-create-binding";
import { __resetMcpCreationForTests, commitMcpCreation } from "./mcp-create-mutation";
import { __resetMcpServerMutationsForTests, commitMcpServerDelete, commitMcpServerUpdate } from "./mcp-server-mutation";
import { useMcpCreation } from "./use-mcp-creation";
import { useMcpDeletion } from "./use-mcp-deletion";
import { __resetSessionDraftsForTests, hasSessionDraft, useSessionDraft } from "../library/session-drafts";

const api = vi.hoisted(() => ({ createMcpServer: vi.fn(), fetchMcpServer: vi.fn(), fetchMcpServers: vi.fn(), deleteMcpServer: vi.fn(), updateMcpServer: vi.fn() }));
vi.mock("@goatcitadel/mission-control-shared/api/client", async (original) => ({ ...(await original<object>()), ...api }));
const form = () => ({ ...createEmptyMcpCreateForm(), label: " Fixture ", command: " node ", args: [" --version ", ""], enabled: false });
const server = (patch: Partial<McpServerRecord> = {}): McpServerRecord => ({
  serverId: "mcp-fixture", revision: "a".repeat(64), label: "Fixture", transport: "stdio", command: "node", args: ["--version"],
  authType: "none", enabled: false, category: "development", trustTier: "restricted", costTier: "unknown",
  policy: { requireFirstToolApproval: false, redactionMode: "basic", allowedToolPatterns: [], blockedToolPatterns: [], allowedEnvKeys: [] },
  status: "disconnected", createdAt: "2026-09-30T00:00:00.000Z", updatedAt: "2026-09-30T00:00:00.000Z", ...patch,
});
const error = (method: string, status: number, body: unknown, path = "/api/v1/mcp/servers/mcp-fixture") =>
  new ApiRequestError("Synthetic owner response", { kind: "http", method, status, body, path });
const absent = () => error("GET", 404, { code: "ENTITY_NOT_FOUND" });
const commit = () => commitMcpCreation(prepareMcpCreateInput(form()), () => true);
const remove = (isCurrent = () => true) => commitMcpServerDelete({ reviewed: server(), isCurrent });
const deferred = <T,>() => { let resolve!: (value: T) => void; const promise = new Promise<T>((yes) => { resolve = yes; }); return { promise, resolve }; };
let renderer: ReactTestRenderer | undefined, hook: ReturnType<typeof useMcpCreation>;
const onCreated = vi.fn(), onNotice = vi.fn();
const committedFailureBody = {
  error: "The MCP configuration change was committed, but follow-up failed. Inspect the saved owner before another change.",
  mutationCommitted: true,
}; // Exact public projection proved by Gateway mcp.server-revisions.test.ts.
let deletion: ReturnType<typeof useMcpDeletion>, editDraft: ReturnType<typeof useSessionDraft<{ label: string }>>;
const onDeleted = vi.fn();
function DeletionHarness() {
  editDraft = useSessionDraft("mcp:workspace-a:mcp-fixture:edit", { label: "Fixture" }, "a".repeat(64), { label: "MCP edit" });
  deletion = useMcpDeletion({ workspaceId: "workspace-a", server: server(), available: true, onDeleted, onNotice });
  return null;
}
function Harness({ workspaceId = "workspace-a", active = true }: { workspaceId?: string; active?: boolean }) {
  hook = useMcpCreation({ workspaceId, active, onCreated, onNotice, onSaveRequest: null }); return null;
}
async function mount(workspaceId = "workspace-a") {
  await act(async () => { renderer = create(<StrictMode><Harness workspaceId={workspaceId} /></StrictMode>); });
  await act(async () => hook.draft.setValue(form()));
}
beforeEach(() => {
  vi.resetAllMocks(); __resetMcpCreationForTests(); __resetMcpServerMutationsForTests(); __resetSessionDraftsForTests();
  api.fetchMcpServers.mockResolvedValue({ items: [] }); api.createMcpServer.mockResolvedValue(server()); api.fetchMcpServer.mockResolvedValue(server());
  api.deleteMcpServer.mockResolvedValue({ deleted: true });
  vi.stubGlobal("fetch", vi.fn(() => { throw new Error("Unexpected network"); }));
});
afterEach(async () => { await act(async () => renderer?.unmount()); renderer = undefined; expect(globalThis.fetch).not.toHaveBeenCalled(); vi.unstubAllGlobals(); });

describe("shared MCP registration", () => {
  it("preserves the advertised template arguments and policy instead of silently dropping them", () => {
    const template: McpServerTemplateRecord = { ...server(), templateId: "template", description: "Fixture template", enabledByDefault: false,
      args: ["worker.js", "--readonly"], category: "data", trustTier: "trusted", costTier: "free",
      policy: { requireFirstToolApproval: true, redactionMode: "strict", allowedToolPatterns: ["query.*"], blockedToolPatterns: ["query.write"], allowedEnvKeys: ["FIXTURE_API_KEY"] } };
    const draft = createMcpFormFromTemplate(template), input = prepareMcpCreateInput(draft);
    expect(input).toMatchObject({ args: template.args, category: "data", trustTier: "trusted", costTier: "free", policy: template.policy, enabled: false });
    draft.args.push("local edit"); draft.policy.allowedToolPatterns.push("other");
    expect(template.args).toEqual(["worker.js", "--readonly"]); expect(template.policy.allowedToolPatterns).toEqual(["query.*"]);
  });
  it("acknowledges only a new exact saved configuration and independent owner receipt", async () => {
    expect(await commit()).toEqual({ status: "created", server: server() });
    expect(api.createMcpServer).toHaveBeenCalledExactlyOnceWith(prepareMcpCreateInput(form()));
    expect(api.fetchMcpServer).toHaveBeenCalledExactlyOnceWith("mcp-fixture");
  });
  it.each([{ command: "other" }, { args: [] }, { enabled: true }, { revision: undefined }])("retains uncertainty on mismatched creation receipt %o", async (patch) => {
    api.createMcpServer.mockResolvedValue(server(patch)); expect((await commit()).status).toBe("uncertain");
    expect((await commit()).status).toBe("locked"); expect(api.createMcpServer).toHaveBeenCalledTimes(1);
  });
  it("rejects a receipt for a previously existing identity and a changed readback", async () => {
    api.fetchMcpServers.mockResolvedValue({ items: [server()] }); expect((await commit()).status).toBe("uncertain");
    __resetMcpCreationForTests(); api.fetchMcpServers.mockResolvedValue({ items: [] });
    api.fetchMcpServer.mockResolvedValue(server({ revision: "b".repeat(64) })); expect((await commit()).status).toBe("uncertain");
  });
  it("unlocks exact noncommitted validation but not committed or wrong-path errors", async () => {
    api.createMcpServer.mockRejectedValueOnce(error("POST", 400, { code: "VALIDATION_ERROR" }, "/api/v1/mcp/servers"));
    expect((await commit()).status).toBe("rejected"); expect((await commit()).status).toBe("created");
    for (const failure of [error("POST", 500, committedFailureBody, "/api/v1/mcp/servers"), error("POST", 400, { mutationCommitted: true }, "/api/v1/mcp/servers"), error("POST", 400, {}, "/foreign")]) {
      __resetMcpCreationForTests(); api.createMcpServer.mockRejectedValueOnce(failure); expect((await commit()).status).toBe("uncertain");
    }
  });
  it("cancels preflight after an away-and-back workspace transition", async () => {
    await mount(); const read = deferred<{ items: McpServerRecord[] }>(); api.fetchMcpServers.mockReturnValueOnce(read.promise);
    let saving!: Promise<boolean>; await act(async () => { saving = hook.save(); });
    await act(async () => renderer!.update(<StrictMode><Harness workspaceId="workspace-b" /></StrictMode>));
    await act(async () => renderer!.update(<StrictMode><Harness /></StrictMode>));
    await act(async () => { read.resolve({ items: [] }); await saving; });
    expect(api.createMcpServer).not.toHaveBeenCalled(); expect(onCreated).not.toHaveBeenCalled(); expect(onNotice).not.toHaveBeenCalled();
  });
  it("retains a lost response lock across workspace switch and remount", async () => {
    await mount(); api.createMcpServer.mockRejectedValueOnce(new Error("response lost"));
    await act(async () => { expect(await hook.save()).toBe(false); });
    await act(async () => renderer!.unmount()); renderer = undefined; await mount("workspace-b");
    expect(hook.mutation.locked).toBe(true); await act(async () => { expect(await hook.save()).toBe(false); });
    expect(api.createMcpServer).toHaveBeenCalledTimes(1);
  });
  it.each(["unmount", "workspace-away-and-back"])("acknowledges the origin draft after late confirmed creation across %s", async transition => {
    await mount(); const response = deferred<McpServerRecord>(); api.createMcpServer.mockReturnValueOnce(response.promise);
    let saving!: Promise<boolean>; await act(async () => { saving = hook.save(); });
    expect(api.createMcpServer).toHaveBeenCalledTimes(1);
    if (transition === "unmount") { await act(async () => renderer!.unmount()); renderer = undefined; }
    else {
      await act(async () => renderer!.update(<StrictMode><Harness workspaceId="workspace-b" /></StrictMode>));
      await act(async () => renderer!.update(<StrictMode><Harness /></StrictMode>));
    }
    await act(async () => { response.resolve(server()); expect(await saving).toBe(false); });
    expect(hasSessionDraft("mcp:workspace-a:new")).toBe(false);
    if (!renderer) await act(async () => { renderer = create(<StrictMode><Harness /></StrictMode>); });
    expect(hook.draft.isDirty).toBe(false); expect(hook.draft.value.label).toBe("");
    expect(onCreated).not.toHaveBeenCalled(); expect(onNotice).not.toHaveBeenCalled();
    await act(async () => { expect(await hook.save()).toBe(false); });
    expect(api.createMcpServer).toHaveBeenCalledTimes(1);
  });
  it("retains new origin typing after a late confirmed creation returns to a remounted editor", async () => {
    await mount(); const response = deferred<McpServerRecord>(); api.createMcpServer.mockReturnValueOnce(response.promise);
    let saving!: Promise<boolean>; await act(async () => { saving = hook.save(); });
    await act(async () => renderer!.unmount());
    await act(async () => { renderer = create(<StrictMode><Harness /></StrictMode>); });
    await act(async () => hook.draft.setValue({ ...hook.draft.value, label: "A separate newer draft" }));
    await act(async () => { response.resolve(server()); await saving; });
    expect(hook.draft.value.label).toBe("A separate newer draft"); expect(hook.draft.isDirty).toBe(true);
    expect(onCreated).not.toHaveBeenCalled(); expect(onNotice).not.toHaveBeenCalled(); expect(api.createMcpServer).toHaveBeenCalledTimes(1);
  });
  it("preserves newer typing and cancels a changed exact review before any write", async () => {
    await mount(); const reviewed = hook.reviewInput()!;
    await act(async () => hook.draft.setValue({ ...hook.draft.value, label: "Changed" }));
    await act(async () => { expect(await hook.save(reviewed)).toBe(false); }); expect(api.createMcpServer).not.toHaveBeenCalled();
    await act(async () => hook.draft.setValue(form())); const response = deferred<McpServerRecord>(); api.createMcpServer.mockReturnValueOnce(response.promise);
    let saving!: Promise<boolean>; await act(async () => { saving = hook.save(); });
    await act(async () => hook.draft.setValue({ ...hook.draft.value, label: "Newer" }));
    await act(async () => { response.resolve(server()); await saving; });
    expect(hook.draft.value.label).toBe("Newer"); expect(hook.draft.isDirty).toBe(true); expect(onCreated).toHaveBeenCalledWith(server(), false);
  });
});

describe("shared MCP deletion", () => {
  it("clears only the deleted origin draft after a confirmed response arrives after unmount", async () => {
    await act(async () => { renderer = create(<StrictMode><DeletionHarness /></StrictMode>); });
    await act(async () => editDraft.setValue({ label: "Unsaved edit" }));
    await act(async () => deletion.requestReview());
    const response = deferred<{ deleted: boolean }>(); api.deleteMcpServer.mockReturnValueOnce(response.promise);
    api.fetchMcpServer.mockResolvedValueOnce(server()).mockRejectedValueOnce(absent());
    let saving!: Promise<void>; await act(async () => { saving = deletion.confirm(); });
    expect(api.deleteMcpServer).toHaveBeenCalledTimes(1);
    await act(async () => renderer!.unmount()); renderer = undefined;
    await act(async () => { response.resolve({ deleted: true }); await saving; });
    expect(hasSessionDraft("mcp:workspace-a:mcp-fixture:edit")).toBe(false);
    expect(onDeleted).not.toHaveBeenCalled(); expect(onNotice).not.toHaveBeenCalled();
    expect((await remove()).status).toBe("locked");
  });
  it("rereads exact identity and revision then verifies the DELETE receipt against canonical absence", async () => {
    api.fetchMcpServer.mockResolvedValueOnce(server()).mockRejectedValueOnce(absent());
    expect(await remove()).toEqual({ status: "deleted", serverId: "mcp-fixture" });
    expect(api.deleteMcpServer).toHaveBeenCalledExactlyOnceWith("mcp-fixture", "a".repeat(64));
    expect((await remove()).status).toBe("locked");
  });
  it.each([{ revision: "b".repeat(64) }, { serverId: "other" }, { createdAt: "new-identity" }])("withholds stale or mismatched deletion %o", async (patch) => {
    api.fetchMcpServer.mockResolvedValue(server(patch)); expect((await remove()).status).toBe("conflict"); expect(api.deleteMcpServer).not.toHaveBeenCalled();
  });
  it("cancels a closed review during preflight", async () => {
    let current = true; api.fetchMcpServer.mockImplementationOnce(async () => { current = false; return server(); });
    expect((await remove(() => current)).status).toBe("cancelled"); expect(api.deleteMcpServer).not.toHaveBeenCalled();
  });
  it("unlocks only the exact uncommitted DELETE conflict", async () => {
    api.deleteMcpServer.mockRejectedValueOnce(error("DELETE", 409, { code: "WRITE_CONFLICT", details: { reason: "MCP_SERVER_REVIEW_REQUIRED" } }));
    expect((await remove()).status).toBe("conflict");
    api.fetchMcpServer.mockResolvedValueOnce(server()).mockRejectedValueOnce(absent()); expect((await remove()).status).toBe("deleted");
  });
  it.each([new Error("response lost"), error("DELETE", 500, committedFailureBody), error("DELETE", 409, { code: "WRITE_CONFLICT", mutationCommitted: true, details: { reason: "MCP_SERVER_REVIEW_REQUIRED" } })])("retains delete uncertainty and blocks updates too", async (failure) => {
    api.deleteMcpServer.mockRejectedValueOnce(failure); expect((await remove()).status).toBe("uncertain");
    expect((await commitMcpServerUpdate({ reviewed: server(), input: { expectedRevision: "a".repeat(64), enabled: true }, isCurrent: () => true })).status).toBe("locked");
    expect(api.updateMcpServer).not.toHaveBeenCalled();
  });
  it("does not claim deletion from a false receipt or noncanonical missing/readback error", async () => {
    api.deleteMcpServer.mockResolvedValueOnce({ deleted: false }); expect((await remove()).status).toBe("uncertain");
    for (const failure of [error("GET", 404, { code: "ENTITY_NOT_FOUND" }, "/foreign"), error("GET", 503, {})]) {
      __resetMcpServerMutationsForTests(); api.fetchMcpServer.mockResolvedValueOnce(server()).mockRejectedValueOnce(failure);
      expect((await remove()).status).toBe("uncertain");
    }
  });
});
