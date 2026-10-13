// @vitest-environment happy-dom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { redactSecretText as redactOriginal } from "@goatcitadel/contracts";
let ChatLegacyInputNotice: typeof import("./ChatLegacyInputNotice").ChatLegacyInputNotice;
const validator = vi.hoisted(() => ({ load: vi.fn<() => Promise<void>>() }));
const identity = vi.hoisted(() => ({ caller: "caller-a", callerRevision: 1, access: 1, gateway: "http://gateway-a" }));
vi.mock("@goatcitadel/mission-control-shared/api/access-scope", () => ({ getGatewayCallerScope: () => identity.caller, getGatewayAccessRevision: () => identity.access, getGatewayCallerScopeRevision: () => identity.callerRevision, subscribeGatewayCallerScope: () => () => {}, subscribeGatewayAccessChange: () => () => {} }));
vi.mock("@goatcitadel/mission-control-shared/api/client-core", () => ({ getGatewayApiBaseUrl: () => identity.gateway }));
let root: Root; let container: HTMLDivElement;
const key = "goatcitadel.chat.draft.workspace-a.session-a";
const restore = vi.fn();
const render = (sessionId = "session-a", draft = "", workspaceId = "workspace-a", disabled = false) => root.render(<ChatLegacyInputNotice workspaceId={workspaceId} sessionId={sessionId} draft={draft} onRestore={restore} disabled={disabled} />);
const button = (label: string) => [...document.querySelectorAll<HTMLButtonElement>("button")].find((item) => item.textContent === label)!;
beforeEach(async () => { vi.resetModules(); validator.load.mockReset().mockResolvedValue(undefined); vi.doMock("@goatcitadel/contracts/secret-redaction", async () => { await validator.load(); return { redactSecretText: redactOriginal }; }); ChatLegacyInputNotice = (await import("./ChatLegacyInputNotice")).ChatLegacyInputNotice; Object.assign(identity, { caller: "caller-a", callerRevision: 1, access: 1, gateway: "http://gateway-a" }); restore.mockClear(); localStorage.clear(); localStorage.setItem(key, "Original reviewable text"); container = document.createElement("div"); document.body.append(container); root = createRoot(container); });
afterEach(() => { act(() => root.unmount()); container.remove(); localStorage.clear(); });
it("requires explicit review and recognition, Cancel writes nothing, and restores through the draft owner only", async () => {
  await act(async () => render());
  expect(restore).not.toHaveBeenCalled();
  await act(async () => button("Review older saved text").click());
  expect(button("Restore reviewed text").disabled).toBe(true);
  await act(async () => button("Cancel").click());
  expect(restore).not.toHaveBeenCalled(); expect(localStorage.getItem(key)).toBe("Original reviewable text");
  await act(async () => button("Review older saved text").click());
  await act(async () => document.querySelector<HTMLInputElement>('input[type="checkbox"]')!.click());
  await act(async () => button("Restore reviewed text").click());
  expect(restore).toHaveBeenCalledExactlyOnceWith("Original reviewable text");
  expect(localStorage.getItem(key)).toBe("Original reviewable text");
});
it.each(["caller", "caller-return", "access", "gateway", "conversation"])("invalidates recovery after %s changes, including retained callbacks", async (change) => {
  await act(async () => render()); await act(async () => button("Review older saved text").click());
  await act(async () => document.querySelector<HTMLInputElement>('input[type="checkbox"]')!.click());
  const oldButton = button("Restore reviewed text");
  if (change === "caller") identity.caller = "caller-b";
  if (change === "caller-return") identity.callerRevision += 2;
  if (change === "access") identity.access++;
  if (change === "gateway") identity.gateway = "http://gateway-b";
  await act(async () => render(change === "conversation" ? "session-b" : "session-a"));
  await act(async () => oldButton.click());
  expect(restore).not.toHaveBeenCalled(); expect(localStorage.getItem(key)).toBe("Original reviewable text");
});
it("does not overwrite a current draft or restore changed legacy bytes", async () => {
  await act(async () => render("session-a", "current draft")); await act(async () => button("Review older saved text").click());
  await act(async () => document.querySelector<HTMLInputElement>('input[type="checkbox"]')!.click());
  expect(button("Restore reviewed text").disabled).toBe(true);
  await act(async () => render()); localStorage.setItem(key, "Changed after review");
  await act(async () => button("Restore reviewed text").click());
  expect(restore).not.toHaveBeenCalled(); expect(document.body.textContent).toContain("changed");
});
it("withholds sensitive and structured text without importing attachments or queues", async () => {
  const sensitive = "api_key=sk-test-" + "a".repeat(40);
  localStorage.setItem(key, sensitive); localStorage.setItem("goatcitadel.chat.attachments.workspace-a.session-a", "retained attachment bytes");
  await act(async () => render()); await act(async () => button("Review older saved text").click());
  expect(document.body.textContent).not.toContain(sensitive);
  expect(document.body.textContent).toContain("cannot be recovered");
  expect(restore).not.toHaveBeenCalled(); expect(localStorage.getItem(key)).toBe(sensitive);
  expect(localStorage.getItem("goatcitadel.chat.attachments.workspace-a.session-a")).toBe("retained attachment bytes");
});

function deferValidation() {
  let resolve!: () => void;
  let reject!: (cause: Error) => void;
  const promise = new Promise<void>((success, failure) => { resolve = success; reject = failure; });
  validator.load.mockImplementationOnce(() => promise);
  return { resolve, reject };
}
it("loads validation on explicit review, withholds bytes while loading, and excludes repeated clicks", async () => {
  const loading = deferValidation();
  await act(async () => render());
  expect(validator.load).not.toHaveBeenCalled();
  await act(async () => { button("Review older saved text").click(); button("Review older saved text").click(); });
  expect(validator.load).toHaveBeenCalledTimes(1);
  expect(document.body.textContent).toContain("Checking saved input");
  expect(document.querySelector("textarea")).toBeNull();
  expect(button("Review older saved text").disabled).toBe(true);
  await act(async () => loading.resolve());
  expect(document.querySelector<HTMLTextAreaElement>("textarea")?.value).toBe("Original reviewable text");
  expect(restore).not.toHaveBeenCalled();
  expect(localStorage.getItem(key)).toBe("Original reviewable text");
});
it.each(["caller", "caller-return", "access", "gateway", "workspace", "conversation", "disabled"])("rejects in-flight validation after %s changes", async (change) => {
  const loading = deferValidation();
  await act(async () => render()); await act(async () => button("Review older saved text").click());
  if (change === "caller") identity.caller = "caller-b";
  if (change === "caller-return") identity.callerRevision += 2;
  if (change === "access") identity.access++;
  if (change === "gateway") identity.gateway = "http://gateway-b";
  await act(async () => render(change === "conversation" ? "session-b" : "session-a", "", change === "workspace" ? "workspace-b" : "workspace-a", change === "disabled"));
  await act(async () => loading.resolve());
  expect(document.querySelector("textarea")).toBeNull();
  expect(restore).not.toHaveBeenCalled(); expect(localStorage.getItem(key)).toBe("Original reviewable text");
});
it("rereads retained bytes after loading and refuses a changed or newly sensitive record", async () => {
  const loading = deferValidation();
  await act(async () => render()); await act(async () => button("Review older saved text").click());
  const changed = "api_key=sk-test-" + "z".repeat(40);
  localStorage.setItem(key, changed);
  await act(async () => loading.resolve());
  expect(document.querySelector("textarea")).toBeNull();
  expect(document.body.textContent).toContain("saved input changed");
  expect(restore).not.toHaveBeenCalled(); expect(localStorage.getItem(key)).toBe(changed);
});
it("reports a validation-load failure without exposing text and permits another explicit review", async () => {
  validator.load.mockRejectedValueOnce(new Error("validator unavailable"));
  await act(async () => render()); await act(async () => button("Review older saved text").click());
  expect(document.querySelector("textarea")).toBeNull();
  expect(document.body.textContent).toContain("Try reviewing it again");
  expect(button("Review older saved text").disabled).toBe(false);
  vi.doMock("@goatcitadel/contracts/secret-redaction", () => ({ redactSecretText: redactOriginal }));
  await act(async () => button("Review older saved text").click());
  await vi.waitFor(() => expect(document.querySelector<HTMLTextAreaElement>("textarea")?.value).toBe("Original reviewable text"));
  expect(restore).not.toHaveBeenCalled(); expect(localStorage.getItem(key)).toBe("Original reviewable text");
  vi.doMock("@goatcitadel/contracts/secret-redaction", async () => { await validator.load(); return { redactSecretText: redactOriginal }; });
});
it("cancels a pending review and ignores its eventual success", async () => {
  const loading = deferValidation();
  await act(async () => render()); await act(async () => button("Review older saved text").click());
  await act(async () => button("Cancel review").click());
  await act(async () => loading.resolve());
  expect(document.querySelector("textarea")).toBeNull();
  expect(button("Review older saved text").disabled).toBe(false);
  expect(restore).not.toHaveBeenCalled(); expect(localStorage.getItem(key)).toBe("Original reviewable text");
});
it.each([{ label: "oversized", text: "x".repeat(64 * 1024 + 1) }, { label: "structured", text: "<workflow_evidence>structured content</workflow_evidence>" }])("rejects $label text before loading validation", async ({ text }) => {
  localStorage.setItem(key, text);
  await act(async () => render()); await act(async () => button("Review older saved text").click());
  expect(validator.load).not.toHaveBeenCalled();
  expect(document.querySelector("textarea")).toBeNull();
  expect(document.body.textContent).toContain("cannot be recovered");
  expect(localStorage.getItem(key)).toBe(text);
});

it("returns keyboard cancellation focus to the re-enabled review trigger after commit", async () => {
  const loading = deferValidation();
  await act(async () => render()); await act(async () => button("Review older saved text").click());
  const cancel = button("Cancel review"); cancel.focus();
  expect(document.activeElement).toBe(cancel);
  // Native button keyboard activation delivers a click with detail zero.
  await act(async () => { cancel.dispatchEvent(new MouseEvent("click", { bubbles: true, detail: 0 })); });
  const trigger = button("Review older saved text");
  expect(trigger.disabled).toBe(false); expect(document.activeElement).toBe(trigger);
  await act(async () => loading.resolve());
  expect(document.activeElement).toBe(trigger); expect(document.querySelector("textarea")).toBeNull();
  expect(restore).not.toHaveBeenCalled(); expect(localStorage.getItem(key)).toBe("Original reviewable text");
});
it.each(["caller-return", "workspace", "conversation", "disabled"])("does not restore cancellation focus after %s changes before commit", async (change) => {
  const loading = deferValidation();
  localStorage.setItem("goatcitadel.chat.draft.workspace-b.session-a", "New workspace saved input");
  localStorage.setItem("goatcitadel.chat.draft.workspace-a.session-b", "New conversation saved input");
  await act(async () => render()); await act(async () => button("Review older saved text").click());
  const cancel = button("Cancel review"); cancel.focus();
  await act(async () => {
    cancel.dispatchEvent(new MouseEvent("click", { bubbles: true, detail: 0 }));
    if (change === "caller-return") identity.callerRevision += 2;
    render(change === "conversation" ? "session-b" : "session-a", "", change === "workspace" ? "workspace-b" : "workspace-a", change === "disabled");
  });
  expect(document.activeElement).not.toBe(button("Review older saved text"));
  await act(async () => loading.resolve());
  expect(document.querySelector("textarea")).toBeNull(); expect(restore).not.toHaveBeenCalled();
  expect(localStorage.getItem(key)).toBe("Original reviewable text");
});
