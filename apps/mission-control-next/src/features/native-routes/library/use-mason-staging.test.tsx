// @vitest-environment happy-dom
import { act, StrictMode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { CitadelStructureSnapshot, MasonSession } from "@goatcitadel/contracts";
import { useMasonStaging } from "./use-mason-staging";
import type { MasonReview } from "./use-citadel-mason";
import { __resetCitadelStructureAttemptsForTests, citadelStructureAttempt, setCitadelStructureAttempt } from "./citadel-structure-state";
import { deferredMason, masonBlueprint, masonSession, masonStructure, masonSummary, stagedMasonStructure } from "./mason.test-support";
const api = vi.hoisted(() => ({ base: "http://one", getMasonSession: vi.fn(), getCitadelStructureSnapshot: vi.fn(), stageMasonBlueprint: vi.fn() }));
vi.mock("@goatcitadel/mission-control-shared/api/client", () => api);
vi.mock("@goatcitadel/mission-control-shared/api/client-core", () => ({ getGatewayApiBaseUrl: () => api.base }));
let root: Root, container: HTMLDivElement, scope: string, identity: string, owner: CitadelStructureSnapshot, session: MasonSession, candidate: MasonReview, control: ReturnType<typeof useMasonStaging>;
function Harness() { control = useMasonStaging(scope, candidate, identity); return <p>{control.attempt.message}</p>; }
async function render(next = scope) { scope = next; await act(async () => root.render(<StrictMode><Harness /></StrictMode>)); }
async function prepare() { await act(async () => control.prepare()); }
async function confirm() { let result!: boolean; await act(async () => { result = await control.confirm(); }); return result; }
beforeEach(async () => {
  vi.resetAllMocks(); api.base = "http://one"; __resetCitadelStructureAttemptsForTests(); scope = "one"; identity = "editor"; owner = masonStructure(); session = { ...masonSession(), status: "drafted", answers: { kind: "team", purpose: "Run the team" } };
  candidate = { blueprint: masonBlueprint, summary: masonSummary, session };
  api.getMasonSession.mockImplementation(async () => structuredClone(session)); api.getCitadelStructureSnapshot.mockImplementation(async () => structuredClone(owner));
  api.stageMasonBlueprint.mockImplementation(async () => { owner = stagedMasonStructure(owner); return { citadel: structuredClone(owner), review: masonSummary }; });
  container = document.createElement("div"); document.body.append(container); root = createRoot(container); await render();
});
afterEach(async () => { await act(async () => root.unmount()); container.remove(); __resetCitadelStructureAttemptsForTests(); });
describe("Mason structure staging", () => {
  it("requires review and explicit confirmation, uses exact CAS, then independently reads the structure", async () => {
    expect(await confirm()).toBe(false); await prepare(); expect(api.stageMasonBlueprint).not.toHaveBeenCalled(); expect(await confirm()).toBe(true);
    expect(api.stageMasonBlueprint).toHaveBeenCalledExactlyOnceWith("one", masonBlueprint, "a".repeat(64)); expect(api.getCitadelStructureSnapshot).toHaveBeenCalledTimes(3); expect(control.notice).toContain("confirmed");
  });
  it("cancel dispatches no write", async () => { await prepare(); await act(async () => control.cancel()); expect(await confirm()).toBe(false); expect(api.stageMasonBlueprint).not.toHaveBeenCalled(); });
  it.each(["scope", "draft", "cancel", "unmount"])("cancels %s during preflight", async mode => {
    await prepare(); const read = deferredMason<MasonSession>(); api.getMasonSession.mockReturnValueOnce(read.promise);
    let pending!: Promise<boolean>; await act(async () => { pending = control.confirm(); });
    if (mode === "scope") { await render("two"); await render("one"); }
    if (mode === "draft") { identity = "changed"; await render(); identity = "editor"; await render(); }
    if (mode === "cancel") await act(async () => control.cancel());
    if (mode === "unmount") { await act(async () => root.unmount()); root = createRoot(container); await render(); }
    await act(async () => { read.resolve(session); await pending; }); expect(api.stageMasonBlueprint).not.toHaveBeenCalled(); expect(control.locked).toBe(false);
  });
  it.each(["structure", "session"])("withholds changed %s before dispatch", async kind => {
    await prepare(); if (kind === "structure") owner = { ...owner, revision: "d".repeat(64) }; else session = { ...session, answers: { ...session.answers, purpose: "New purpose" } };
    expect(await confirm()).toBe(false); expect(api.stageMasonBlueprint).not.toHaveBeenCalled(); expect(control.notice).toContain("changed");
  });
  it("shares unknown structure admission with Blueprint and Charter callers", async () => {
    await act(async () => setCitadelStructureAttempt("one", { phase: "uncertain", message: "Prior import unknown" })); await prepare(); expect(control.review).toBeNull(); expect(await confirm()).toBe(false); expect(api.getCitadelStructureSnapshot).not.toHaveBeenCalled();
  });
  it("retains post-dispatch uncertainty across remount and blocks all structure callers", async () => {
    await prepare(); api.stageMasonBlueprint.mockRejectedValueOnce(new Error("lost receipt")); expect(await confirm()).toBe(false);
    await act(async () => root.unmount()); root = createRoot(container); await render(); expect(control.attempt.phase).toBe("uncertain"); expect(citadelStructureAttempt("one").phase).toBe("uncertain"); await prepare(); expect(control.review).toBeNull();
  });
  it.each(["receipt", "summary", "readback"])("withholds conflicting %s evidence", async mode => {
    await prepare(); api.stageMasonBlueprint.mockImplementationOnce(async () => {
      const saved = stagedMasonStructure(owner); if (mode !== "readback") owner = saved;
      return { citadel: mode === "receipt" ? { ...saved, citadelId: "foreign" } : saved, review: mode === "summary" ? { ...masonSummary, name: "Foreign" } : masonSummary };
    }); expect(await confirm()).toBe(false); expect(control.attempt.phase).toBe("uncertain");
  });
  it("allows an exact uncommitted structure conflict to be reviewed again", async () => {
    await prepare(); api.stageMasonBlueprint.mockRejectedValueOnce({ status: 409, body: { code: "WRITE_CONFLICT", details: { reason: "CITADEL_STRUCTURE_REVISION_CONFLICT" } } });
    expect(await confirm()).toBe(false); expect(control.locked).toBe(false); expect(control.review).toBeNull();
  });
  it("keeps typed postcommit conflicts unknown", async () => {
    await prepare(); api.stageMasonBlueprint.mockRejectedValueOnce({ status: 409, body: { code: "WRITE_CONFLICT", mutationCommitted: true, details: { reason: "CITADEL_STRUCTURE_REVISION_CONFLICT" } } }); expect(await confirm()).toBe(false); expect(control.attempt.phase).toBe("uncertain");
  });
  it("settles a valid late origin without updating the new view", async () => {
    await prepare(); const response = deferredMason<{ citadel: CitadelStructureSnapshot; review: typeof masonSummary }>(); api.stageMasonBlueprint.mockReturnValueOnce(response.promise);
    let pending!: Promise<boolean>; await act(async () => { pending = control.confirm(); }); await render("two"); owner = stagedMasonStructure(owner);
    await act(async () => { response.resolve({ citadel: owner, review: masonSummary }); await pending; }); expect(citadelStructureAttempt("one").phase).toBe("idle"); expect(control.notice).toBeNull();
  });
});
