// @vitest-environment happy-dom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { ChatLegacyInputNotice } from "./ChatLegacyInputNotice";
const identity = vi.hoisted(() => ({ caller: "caller-a", access: 1, gateway: "http://gateway-a" }));
vi.mock("@goatcitadel/mission-control-shared/api/access-scope", () => ({ getGatewayCallerScope: () => identity.caller, getGatewayAccessRevision: () => identity.access, subscribeGatewayCallerScope: () => () => {}, subscribeGatewayAccessChange: () => () => {} }));
vi.mock("@goatcitadel/mission-control-shared/api/client-core", () => ({ getGatewayApiBaseUrl: () => identity.gateway }));
let root: Root; let container: HTMLDivElement;
const key = "goatcitadel.chat.draft.workspace-a.session-a";
const restore = vi.fn();
const render = (sessionId = "session-a", draft = "") => root.render(<ChatLegacyInputNotice workspaceId="workspace-a" sessionId={sessionId} draft={draft} onRestore={restore} />);
const button = (label: string) => [...document.querySelectorAll<HTMLButtonElement>("button")].find((item) => item.textContent === label)!;
beforeEach(() => { Object.assign(identity, { caller: "caller-a", access: 1, gateway: "http://gateway-a" }); restore.mockClear(); localStorage.clear(); localStorage.setItem(key, "Original reviewable text"); container = document.createElement("div"); document.body.append(container); root = createRoot(container); });
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
it.each(["caller", "access", "gateway", "conversation"])("invalidates recovery after %s changes, including retained callbacks", async (change) => {
  await act(async () => render()); await act(async () => button("Review older saved text").click());
  await act(async () => document.querySelector<HTMLInputElement>('input[type="checkbox"]')!.click());
  const oldButton = button("Restore reviewed text");
  if (change === "caller") identity.caller = "caller-b";
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
