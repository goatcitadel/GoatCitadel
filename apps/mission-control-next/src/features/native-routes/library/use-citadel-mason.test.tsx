// @vitest-environment happy-dom
import { act, StrictMode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { MasonSession } from "@goatcitadel/contracts";
import { useMasonEditor } from "./use-mason-editor";
import { masonAttempt, masonAttemptKey, resetMasonAttemptsForTests } from "./mason-session-state";
import { __resetSessionDraftsForTests } from "./session-drafts";
import { __resetSessionViewStateForTests } from "../../../hooks/use-session-view-state";
import { deferredMason, masonBlueprint, masonSession, masonSummary } from "./mason.test-support";
const api = vi.hoisted(() => ({ base: "http://one", createMasonSession: vi.fn(), getMasonSession: vi.fn(), getMasonSetupQuestions: vi.fn(), sendMasonMessage: vi.fn(), updateMasonSessionAnswers: vi.fn(), draftMasonBlueprint: vi.fn(), draftBlueprintFromMasonSession: vi.fn(), reviewMasonBlueprint: vi.fn() }));
vi.mock("@goatcitadel/mission-control-shared/api/client", () => api);
vi.mock("@goatcitadel/mission-control-shared/api/client-core", () => ({ getGatewayApiBaseUrl: () => api.base }));
let root: Root, container: HTMLDivElement, scope: string, owner: MasonSession, control: ReturnType<typeof useMasonEditor>;
function Harness() { control = useMasonEditor(scope); return <p>{control.attempt.message}</p>; }
async function render(next = scope) { scope = next; await act(async () => root.render(<StrictMode><Harness /></StrictMode>)); }
async function start() { await act(async () => { await control.startSession(); }); }
async function input() { await act(async () => { control.changeAnswer("kind", "team"); control.changeAnswer("purpose", "Run the team"); }); }
beforeEach(async () => {
  vi.resetAllMocks(); api.base = "http://one"; resetMasonAttemptsForTests(); __resetSessionDraftsForTests(); __resetSessionViewStateForTests(); scope = "one"; owner = masonSession();
  api.getMasonSetupQuestions.mockResolvedValue(["Purpose?", "Goals?"]); api.createMasonSession.mockImplementation(async () => structuredClone(owner));
  api.getMasonSession.mockImplementation(async () => structuredClone(owner));
  api.updateMasonSessionAnswers.mockImplementation(async (_id, patch) => { owner = { ...owner, answers: { ...owner.answers, ...patch } }; return structuredClone(owner); });
  api.sendMasonMessage.mockImplementation(async () => { owner = { ...owner, answers: { kind: "team", purpose: "Run the team" } }; return structuredClone(owner); });
  api.draftMasonBlueprint.mockResolvedValue(masonBlueprint); api.draftBlueprintFromMasonSession.mockImplementation(async () => { owner = { ...owner, status: "drafted" }; return masonBlueprint; }); api.reviewMasonBlueprint.mockResolvedValue(masonSummary);
  container = document.createElement("div"); document.body.append(container); root = createRoot(container); await render();
});
afterEach(async () => { await act(async () => root.unmount()); container.remove(); resetMasonAttemptsForTests(); __resetSessionDraftsForTests(); __resetSessionViewStateForTests(); });
describe("shared Mason session owner", () => {
  it("creates and independently reads the global session without inventing a Citadel binding", async () => {
    await start(); expect(control.session).toEqual(owner); expect(api.createMasonSession).toHaveBeenCalledExactlyOnceWith(); expect(control.locked).toBe(false);
  });
  it("saves exact structured answers and drafts/reviews against the deterministic owner without a model", async () => {
    await start(); await input(); await act(async () => { expect(await control.saveAnswers()).toBe(true); });
    expect(api.updateMasonSessionAnswers).toHaveBeenCalledExactlyOnceWith(owner.sessionId, { kind: "team", purpose: "Run the team" }); expect(control.answersDraft.isDirty).toBe(false);
    await act(async () => { await control.draftAndReview(); }); expect(control.review?.blueprint).toEqual(masonBlueprint); expect(control.review?.session.status).toBe("drafted"); expect(api.sendMasonMessage).not.toHaveBeenCalled();
  });
  it("sends only the reviewed message and acknowledges the original draft", async () => {
    await start(); await act(async () => control.changeMessage("Run my team")); await act(async () => { expect(await control.sendMessage()).toBe(true); });
    expect(api.sendMasonMessage).toHaveBeenCalledExactlyOnceWith(owner.sessionId, "Run my team"); expect(control.messageDraft.value).toBe(""); expect(control.questionIndex).toBe(1);
  });
  it("preserves answer drafts through question navigation and allows an explicit discard", async () => {
    await start(); await act(async () => control.changeMessage("Retained question answer"));
    await act(async () => control.changeQuestion(1)); expect(control.leave.dialogProps.open).toBe(true);
    await act(async () => control.leave.dialogProps.onContinue()); expect(control.questionIndex).toBe(1);
    await act(async () => control.changeQuestion(0)); expect(control.messageDraft.value).toBe("Retained question answer");
    await act(async () => control.changeQuestion(1)); await act(async () => control.leave.dialogProps.onDiscard?.());
    expect(control.questionIndex).toBe(1); await act(async () => control.changeQuestion(0)); expect(control.messageDraft.value).toBe(""); expect(api.sendMasonMessage).not.toHaveBeenCalled();
  });
  it("normalizes blank optional lines without sending invalid answer entries", async () => {
    await start(); await input(); await act(async () => { control.changeAnswer("name", ""); control.changeAnswer("goals", [" Goal ", ""]); });
    await act(async () => { expect(await control.saveAnswers()).toBe(true); });
    expect(api.updateMasonSessionAnswers).toHaveBeenCalledWith(owner.sessionId, { kind: "team", purpose: "Run the team", goals: ["Goal"] }); expect(control.answersDraft.isDirty).toBe(false);
  });
  it.each(["scope", "draft", "refresh", "unmount"])("cancels %s changes during fresh preflight with zero writes", async mode => {
    await start(); await input(); const read = deferredMason<MasonSession>(); api.getMasonSession.mockReturnValueOnce(read.promise);
    let pending!: Promise<boolean>; await act(async () => { pending = control.saveAnswers(); });
    if (mode === "scope") { await render("two"); await render("one"); }
    if (mode === "draft") { await act(async () => { control.changeAnswer("purpose", "New"); control.changeAnswer("purpose", "Run the team"); }); }
    if (mode === "refresh") await act(async () => control.refresh());
    if (mode === "unmount") { await act(async () => root.unmount()); root = createRoot(container); await render(); }
    await act(async () => { read.resolve(owner); await pending; }); expect(api.updateMasonSessionAnswers).not.toHaveBeenCalled();
  });
  it("withholds a stale canonical session before dispatch", async () => {
    await start(); await input(); owner = { ...owner, answers: { name: "Other operator" } };
    await act(async () => { expect(await control.saveAnswers()).toBe(false); }); expect(api.updateMasonSessionAnswers).not.toHaveBeenCalled(); expect(control.error).toContain("changed");
  });
  it("retains one unknown write across remount and classic/native consumer replacement", async () => {
    await start(); await input(); const response = deferredMason<MasonSession>(); api.updateMasonSessionAnswers.mockReturnValueOnce(response.promise);
    let pending!: Promise<boolean>; await act(async () => { pending = control.saveAnswers(); }); await act(async () => { expect(await control.saveAnswers()).toBe(false); });
    await act(async () => root.unmount()); root = createRoot(container); await render();
    await act(async () => { response.reject(new Error("lost response")); await pending; }); expect(control.attempt.phase).toBe("uncertain"); expect(control.answersDraft.isDirty).toBe(true); expect(api.updateMasonSessionAnswers).toHaveBeenCalledOnce();
  });
  it("keeps installation-wide creation uncertainty after moving to another Citadel", async () => {
    api.createMasonSession.mockRejectedValueOnce(new Error("lost response")); await start(); await render("two"); await start(); expect(api.createMasonSession).toHaveBeenCalledOnce(); expect(control.locked).toBe(true);
  });
  it("retains known created identity and its lock when its independent read fails", async () => {
    api.getMasonSession.mockRejectedValueOnce(new Error("read unavailable")); await start(); expect(control.sessionId).toBe(owner.sessionId); expect(control.attempt.phase).toBe("uncertain");
  });
  it.each(["foreign", "mismatched-answers", "readback"])("retains uncertainty for a %s receipt", async mode => {
    await start(); await input(); api.updateMasonSessionAnswers.mockImplementationOnce(async (_id, patch) => {
      const receipt = { ...owner, answers: { ...patch } }; if (mode === "foreign") receipt.sessionId = "other";
      if (mode === "mismatched-answers") receipt.answers.purpose = "Wrong"; if (mode !== "readback") owner = receipt; return receipt;
    }); await act(async () => { expect(await control.saveAnswers()).toBe(false); }); expect(control.attempt.phase).toBe("uncertain");
  });
  it("acknowledges a late successful origin without clearing a newer draft", async () => {
    await start(); await input(); const response = deferredMason<MasonSession>(); api.updateMasonSessionAnswers.mockReturnValueOnce(response.promise);
    let pending!: Promise<boolean>; await act(async () => { pending = control.saveAnswers(); }); await render("two"); await render("one");
    await act(async () => control.changeAnswer("purpose", "Newer text")); owner = { ...owner, answers: { kind: "team", purpose: "Run the team" } };
    await act(async () => { response.resolve(owner); await pending; }); expect(control.answersDraft.value.purpose).toBe("Newer text"); expect(control.answersDraft.isDirty).toBe(true); expect(control.locked).toBe(false);
  });
  it("binds draft result to the reviewed answers and withholds a conflicting draft", async () => {
    await start(); await input(); await act(async () => { await control.saveAnswers(); }); api.draftBlueprintFromMasonSession.mockResolvedValueOnce({ ...masonBlueprint, metadata: { name: "Foreign" } });
    await act(async () => { await control.draftAndReview(); }); expect(control.review).toBeNull(); expect(control.attempt.phase).toBe("uncertain");
  });
  it("retains origin session lock if the installation changes after dispatch", async () => {
    await start(); await input(); const response = deferredMason<MasonSession>(); api.updateMasonSessionAnswers.mockReturnValueOnce(response.promise);
    let pending!: Promise<boolean>; await act(async () => { pending = control.saveAnswers(); }); api.base = "http://two"; await render();
    await act(async () => { response.resolve({ ...owner, answers: { kind: "team", purpose: "Run the team" } }); await pending; });
    expect(masonAttempt(masonAttemptKey("http://one", owner.sessionId)).phase).toBe("uncertain");
  });
});
