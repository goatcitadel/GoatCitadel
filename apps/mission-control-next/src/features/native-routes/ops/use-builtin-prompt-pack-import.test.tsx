// @vitest-environment happy-dom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { PromptPackBuiltinImportResult, PromptPackSecurityEvalPackRecord } from "@goatcitadel/contracts";
import { __resetBuiltinPromptPackImportsForTests, useBuiltinPromptPackImport } from "./use-builtin-prompt-pack-import";

const api = vi.hoisted(() => ({ builtins: vi.fn(), import: vi.fn(), report: vi.fn() }));
vi.mock("@goatcitadel/mission-control-shared/api/prompt-packs", () => ({ fetchPromptPackBuiltins: api.builtins,
  importBuiltinPromptPackIfAbsent: api.import, fetchPromptPackReport: api.report }));
vi.mock("@goatcitadel/mission-control-shared/api/client", () => ({ isApiRequestError: (error: unknown) => Boolean(error && typeof error === "object" && "status" in error) }));

const revision = "a".repeat(64), hash = "b".repeat(64), stamp = "2026-09-30T15:00:00.000Z";
const definition: PromptPackSecurityEvalPackRecord = { packKey: "defensive", title: "Defensive fixture", sourceLabel: "builtin",
  status: "available", testCount: 1, modeCounts: { chat: 1 }, toolTierCounts: {}, capabilityTargets: [], likelyFailureClasses: [], blockers: [],
  safetyPosture: { definitionOnly: true, requiresOperatorRun: true, callsProviders: false, mutationPerformed: false, note: "Definitions only" },
  importCapability: { version: "prompt_pack.builtin_import.v1", operation: "create_only", packId: "defensive", definitionRevision: revision, contentSha256: hash, targetState: "absent" } };
const imported = (): PromptPackBuiltinImportResult => ({
  pack: { packId: "defensive", name: "Defensive fixture", testCount: 1, createdAt: stamp, updatedAt: stamp, contentSha256: hash },
  tests: [{ testId: "test-one", packId: "defensive", code: "DEF-1", title: "Definition fixture", prompt: "A stored fixture",
    mode: "chat", toolTier: "no-tools", orderIndex: 0, createdAt: stamp }],
  importReceipt: { version: "prompt_pack.builtin_import_receipt.v1", operation: "created", packKey: "defensive", definitionRevision: revision, contentSha256: hash },
});
function deferred<T>() { let resolve!: (value: T) => void; const promise = new Promise<T>((done) => { resolve = done; }); return { promise, resolve }; }
let root: Root, container: HTMLDivElement, state: ReturnType<typeof useBuiltinPromptPackImport>;
const reload = vi.fn();
function Harness() { state = useBuiltinPromptPackImport({ reload }); return null; }
beforeEach(() => {
  vi.resetAllMocks(); __resetBuiltinPromptPackImportsForTests();
  api.builtins.mockResolvedValue({ items: [structuredClone(definition)] });
  api.import.mockResolvedValue(imported()); api.report.mockResolvedValue(imported()); reload.mockResolvedValue(undefined);
  container = document.createElement("div"); document.body.appendChild(container); root = createRoot(container);
  act(() => root.render(<Harness />));
});
afterEach(() => { act(() => root.unmount()); container.remove(); __resetBuiltinPromptPackImportsForTests(); });
const review = async () => { await act(async () => state.requestReview(definition)); };
const confirm = async () => { await act(async () => state.confirm()); };

describe("shared create-only built-in definition import", () => {
  it("reviews the exact fresh advertisement and cancels with zero writes", async () => {
    await review(); expect(state.review?.definition.importCapability?.definitionRevision).toBe(revision);
    expect(api.builtins).toHaveBeenCalledOnce(); expect(api.import).not.toHaveBeenCalled();
    act(() => state.cancel()); expect(state.review).toBeNull(); expect(api.import).not.toHaveBeenCalled();
  });
  it("sends only the guarded route input and confirms independent owner tests without running evaluations", async () => {
    await review(); await confirm();
    expect(api.import).toHaveBeenCalledExactlyOnceWith("defensive", { expectedDefinitionRevision: revision });
    expect(api.report).toHaveBeenCalledExactlyOnceWith("defensive");
    expect(state.notice).toContain("imported and confirmed with 1 test."); expect(state.notice).toContain("No evaluations were run");
    expect(reload).toHaveBeenCalledOnce();
    await review(); expect(api.import).toHaveBeenCalledOnce(); expect(api.builtins).toHaveBeenCalledOnce();
  });
  it("blocks duplicate confirmation and keeps the in-flight lock across remount", async () => {
    const response = deferred<PromptPackBuiltinImportResult>(); api.import.mockReturnValue(response.promise);
    await review(); let completion!: Promise<void>;
    act(() => { completion = state.confirm(); void state.confirm(); });
    expect(api.import).toHaveBeenCalledOnce(); expect(state.pending).toBe(true);
    act(() => root.render(null)); act(() => root.render(<Harness />));
    expect(state.locked("defensive")).toBe(true); await review(); expect(api.builtins).toHaveBeenCalledOnce();
    await act(async () => { response.resolve(imported()); await completion; });
    expect(state.review).toBeNull(); expect(state.notice).toBeNull(); expect(state.stateFor("defensive")?.phase).toBe("confirmed");
  });
  it("withholds changed or occupied advertisements before dispatch", async () => {
    for (const change of [{ definitionRevision: "c".repeat(64) }, { contentSha256: "c".repeat(64) }, { targetState: "present" }]) {
      api.builtins.mockResolvedValueOnce({ items: [{ ...definition, importCapability: { ...definition.importCapability, ...change } }] });
      await review(); expect(state.review).toBeNull(); expect(state.notice).toContain("changed");
    }
    expect(api.import).not.toHaveBeenCalled();
  });
  it("does not enable this action for an older Gateway without the versioned capability", async () => {
    await act(async () => state.requestReview({ ...definition, importCapability: undefined }));
    expect(api.builtins).not.toHaveBeenCalled(); expect(api.import).not.toHaveBeenCalled();
  });
  it("releases only an explicit noncommitted owner conflict", async () => {
    api.import.mockRejectedValue({ status: 409, body: { code: "WRITE_CONFLICT", details: { reason: "PROMPT_PACK_ALREADY_EXISTS", mutationCommitted: false } } });
    await review(); await confirm();
    expect(state.locked("defensive")).toBe(false); expect(state.notice).toContain("not applied");
    expect(api.report).not.toHaveBeenCalled();
  });
  it("retains an unknown outcome after response loss and across remount", async () => {
    api.import.mockRejectedValue(new Error("Response lost")); await review(); await confirm();
    expect(state.locked("defensive")).toBe(true); expect(state.notice).toContain("Do not retry");
    act(() => root.render(null)); act(() => root.render(<Harness />)); await review();
    expect(state.stateFor("defensive")?.phase).toBe("uncertain"); expect(api.import).toHaveBeenCalledOnce();
  });
  it("does not unlock a conflict carrying committed truth", async () => {
    api.import.mockRejectedValue({ status: 409, body: { code: "WRITE_CONFLICT", mutationCommitted: true,
      details: { reason: "PROMPT_PACK_ALREADY_EXISTS", mutationCommitted: false } } });
    await review(); await confirm(); expect(state.stateFor("defensive")?.phase).toBe("uncertain");
  });
  it("rejects another receipt identity and never presents the import as confirmed", async () => {
    const response = imported(); response.importReceipt.packKey = "foreign"; api.import.mockResolvedValue(response);
    await review(); await confirm(); expect(state.stateFor("defensive")?.phase).toBe("uncertain");
    expect(api.report).not.toHaveBeenCalled(); expect(state.notice).not.toContain("imported and confirmed");
  });
  it("detects changed owner test content even when the reported pack hash remains equal", async () => {
    const owner = imported(); owner.tests[0]!.prompt = "Changed by another operator"; api.report.mockResolvedValue(owner);
    await review(); await confirm(); expect(state.stateFor("defensive")?.phase).toBe("uncertain");
    expect(state.notice).not.toContain("imported and confirmed");
  });
  it("rejects a duplicate owner row that substitutes for another imported test", async () => {
    const reviewed = { ...definition, testCount: 2 };
    const result = imported(); result.pack.testCount = 2;
    result.tests.push({ ...result.tests[0]!, testId: "test-two", orderIndex: 1 });
    api.builtins.mockResolvedValue({ items: [reviewed] }); api.import.mockResolvedValue(result);
    api.report.mockResolvedValue({ ...result, tests: [result.tests[0], result.tests[0]] });
    await act(async () => state.requestReview(reviewed)); await confirm();
    expect(state.stateFor("defensive")?.phase).toBe("uncertain");
    expect(state.notice).not.toContain("imported and confirmed");
  });
  it("keeps a confirmed write confirmed when the evidence refresh fails", async () => {
    reload.mockRejectedValue(new Error("Snapshot offline")); await review(); await confirm();
    expect(state.stateFor("defensive")?.phase).toBe("confirmed"); expect(api.import).toHaveBeenCalledOnce();
  });
});
