// @vitest-environment happy-dom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { CitadelAccessSnapshot } from "@goatcitadel/contracts";
import { useCitadelAccessReview } from "./useCitadelAccessReview";
import { __resetCitadelAccessAttemptsForTests, accessAttempt } from "./citadel-access-state";
import { overviewStructure } from "./citadel-overview.test-support";
const api = vi.hoisted(() => ({ base: "http://one", getCitadelAccessSnapshot: vi.fn() }));
vi.mock("@goatcitadel/mission-control-shared/api/client", () => api);
vi.mock("@goatcitadel/mission-control-shared/api/client-core", () => ({ getGatewayApiBaseUrl: () => api.base }));
let root: Root, container: HTMLDivElement, scope: string, control: ReturnType<typeof useCitadelAccessReview>, owner: CitadelAccessSnapshot;
const fixture = (id = "one"): CitadelAccessSnapshot => ({ citadelId: id, revision: "a".repeat(64), structure: { ...overviewStructure(), citadelId: id }, council: [], wards: [], passages: [], members: [], integrations: [] });
function Harness() { control = useCitadelAccessReview(scope); return <p>{control.error}</p>; }
async function render(next = scope) { scope = next; await act(async () => root.render(<Harness />)); }
const deferred = <T,>() => { let resolve!: (value: T) => void; const promise = new Promise<T>(done => { resolve = done; }); return { promise, resolve }; };
const changed = () => ({ ...owner, revision: "b".repeat(64), wards: [{ wardId: "ward", citadelId: scope, name: "Deny", actionPattern: "shell.*", effect: "deny" as const, createdAt: "now" }] });
const change = { type: "add_ward" as const, ward: { name: "Deny", actionPattern: "shell.*", effect: "deny" as const } };
beforeEach(async () => { vi.resetAllMocks(); __resetCitadelAccessAttemptsForTests(); api.base = "http://one"; scope = "one"; owner = fixture(); api.getCitadelAccessSnapshot.mockImplementation(async () => structuredClone(owner)); container = document.createElement("div"); document.body.append(container); root = createRoot(container); await render(); });
afterEach(async () => { await act(async () => root.unmount()); container.remove(); });
describe("shared Citadel access admission", () => {
  it("admits once after exact preflight and confirms the actual receipt by independent read", async () => {
    const reply = deferred<CitadelAccessSnapshot>(), write = vi.fn(() => reply.promise); let pending!: Promise<CitadelAccessSnapshot | null>;
    await act(async () => { pending = control.run(owner.revision, write, { change }); }); expect(write).toHaveBeenCalledTimes(1);
    await act(async () => control.run(owner.revision, write, { change })); expect(write).toHaveBeenCalledTimes(1);
    owner = changed(); await act(async () => { reply.resolve(owner); expect(await pending).toEqual(owner); }); expect(control.ready).toBe(true); expect(api.getCitadelAccessSnapshot).toHaveBeenCalledTimes(3);
  });
  it("withholds a stale full owner even when the displayed opaque revision was retained", async () => {
    owner = { ...owner, members: [{ memberId: "peer-member", citadelId: "one", subjectId: "peer", role: "viewer", createdAt: "now", updatedAt: "now" }] };
    const write = vi.fn(); await act(async () => control.run(owner.revision, write, { change })); expect(write).not.toHaveBeenCalled(); expect(control.reviewRequired).toBe(true); expect(control.ready).toBe(false);
    await act(async () => control.acceptReview()); expect(control.ready).toBe(true);
  });
  it.each(["scope", "unmount", "draft", "gateway-round-trip"])("cancels %s changes during preflight with zero dispatch", async kind => {
    const reply = deferred<CitadelAccessSnapshot>(); api.getCitadelAccessSnapshot.mockReturnValueOnce(reply.promise); const before = owner, write = vi.fn(); let active = true, pending!: Promise<CitadelAccessSnapshot | null>;
    await act(async () => { pending = control.run(before.revision, write, { change, isReviewCurrent: () => active }); });
    if (kind === "scope") { owner = fixture("two"); await render("two"); }
    if (kind === "unmount") await act(async () => root.render(<p>Closed</p>));
    if (kind === "draft") active = false;
    if (kind === "gateway-round-trip") { api.base = "http://two"; owner = fixture(); await render(); api.base = "http://one"; await render(); }
    await act(async () => { reply.resolve(before); await pending; }); expect(write).not.toHaveBeenCalled(); expect(accessAttempt(JSON.stringify(["http://one", "one"])).phase).toBe("idle");
  });
  it.each(["lost-response", "wrong-effect", "different-readback", "postcommit-conflict"])("retains %s uncertainty across remount and withholds all access writes", async kind => {
    const write = vi.fn(async () => {
      if (kind === "lost-response") throw new Error("Response lost");
      if (kind === "postcommit-conflict") throw { status: 409, body: { code: "WRITE_CONFLICT", mutationCommitted: true, details: { reason: "CITADEL_ACCESS_REVISION_CONFLICT" } } };
      const saved = changed(); owner = kind === "different-readback" ? { ...saved, revision: "c".repeat(64) } : saved;
      return kind === "wrong-effect" ? { ...saved, wards: saved.wards.map(item => ({ ...item, effect: "allow" as const })) } : saved;
    });
    await act(async () => control.run(owner.revision, write, { change })); expect(control.attempt.phase).toBe("uncertain");
    await act(async () => root.render(<p>Closed</p>)); await render(); expect(control.ready).toBe(false); expect(control.error).toContain("unconfirmed");
    await act(async () => control.run(owner.revision, write, { change })); expect(write).toHaveBeenCalledTimes(1);
  });
  it("unlocks only an exact prewrite access conflict and requires a new owner review", async () => {
    const write = vi.fn(async () => { owner = { ...owner, revision: "b".repeat(64) }; throw { status: 409, body: { code: "WRITE_CONFLICT", details: { reason: "CITADEL_ACCESS_REVISION_CONFLICT" } } }; });
    await act(async () => control.run(owner.revision, write, { change })); expect(control.attempt.phase).toBe("idle"); expect(control.reviewRequired).toBe(true); expect(control.snapshot?.revision).toBe(owner.revision);
    await act(async () => control.run(owner.revision, write, { change })); expect(write).toHaveBeenCalledTimes(1);
  });
  it("locks only the origin installation if Gateway changes after dispatch", async () => {
    const reply = deferred<CitadelAccessSnapshot>(); let pending!: Promise<CitadelAccessSnapshot | null>; const before = owner;
    await act(async () => { pending = control.run(before.revision, () => reply.promise, { change }); });
    const saved = changed(); api.base = "http://two"; owner = fixture(); await render(); await act(async () => { reply.resolve(saved); await pending; });
    expect(accessAttempt(JSON.stringify(["http://one", "one"])).phase).toBe("uncertain"); expect(control.ready).toBe(true); expect(control.error).toBeNull();
  });
  it("never makes an old exposed scope callback current again after a Citadel round trip", async () => {
    const old = control.isCurrent; expect(old()).toBe(true); owner = fixture("two"); await render("two"); expect(old()).toBe(false);
    owner = fixture(); await render("one"); expect(old()).toBe(false); expect(control.isCurrent()).toBe(true);
  });
  it("cancels a reviewed preflight when an independent refresh begins", async () => {
    const reply = deferred<CitadelAccessSnapshot>(), write = vi.fn(); api.getCitadelAccessSnapshot.mockReturnValueOnce(reply.promise);
    let pending!: Promise<CitadelAccessSnapshot | null>; await act(async () => { pending = control.run(owner.revision, write, { change }); });
    await act(async () => control.reload()); await act(async () => { reply.resolve(owner); await pending; }); expect(write).not.toHaveBeenCalled(); expect(control.ready).toBe(true);
  });
});
