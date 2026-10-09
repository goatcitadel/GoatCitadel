import { __resetApprovalOperationAttemptsForTests } from "../inbox/approval-operation-attempts";
import { __resetSessionViewStateForTests } from "../../../hooks/use-session-view-state";
// @vitest-environment happy-dom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import type { BrowserSessionGrantRecord, BrowserSessionRecord } from "@goatcitadel/contracts";
import {
  createBrowserSessionGrant,
  fetchBrowserSession,
  revokeBrowserSessionGrant,
  rotateBrowserSessionGrant,
} from "@goatcitadel/mission-control-shared/api/browser-sessions";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { __resetSessionDraftsForTests } from "../../../features/native-routes/library/session-drafts";
import { BrowserSessionGrants } from "./BrowserSessionGrants";
import { NEVER_EXPIRES_TTL } from "./browser-sessions-model";

vi.mock("@goatcitadel/mission-control-shared/api/browser-sessions", () => ({
  createBrowserSessionGrant: vi.fn(),
  fetchBrowserSession: vi.fn(),
  revokeBrowserSessionGrant: vi.fn(),
  rotateBrowserSessionGrant: vi.fn(),
}));

const session: BrowserSessionRecord = {
  sessionId: "s-1",
  workspaceId: "one",
  label: "Research",
  status: "active",
  createdBy: "operator",
  createdAt: "2026-10-07T10:00:00.000Z",
  updatedAt: "2026-10-07T10:00:00.000Z",
};
const grant: BrowserSessionGrantRecord = {
  grantId: "g-1",
  sessionId: "s-1",
  actorId: "agent",
  scopes: ["read"],
  allowedHosts: ["example.com"],
  createdAt: "2026-10-07T10:00:00.000Z",
  expiresAt: "2099-01-01T00:00:00.000Z",
};
// A truthful create receipt: the Gateway's expiry is one hour after its creation time.
const oneHourReceipt: BrowserSessionGrantRecord = {
  ...grant,
  grantId: "g-2",
  createdAt: "2099-01-01T00:00:00.000Z",
  expiresAt: "2099-01-01T01:00:00.000Z",
};
const noHostReceipt: BrowserSessionGrantRecord = { ...oneHourReceipt, allowedHosts: [] };
let root: Root, container: HTMLDivElement;
const onChanged = vi.fn(async () => undefined);

beforeEach(() => {
  vi.resetAllMocks();
  __resetApprovalOperationAttemptsForTests();
  __resetSessionViewStateForTests();
  __resetSessionDraftsForTests();
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  vi.mocked(fetchBrowserSession).mockResolvedValue(session);
});
afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

async function render(grants = [grant], target = session) {
  await act(async () =>
    root.render(<BrowserSessionGrants session={target} workspaceId="one" grants={grants} onChanged={onChanged} />),
  );
}
const button = (name: string) =>
  [...document.body.querySelectorAll<HTMLButtonElement>("button")].find(
    (item) => item.textContent === name || item.getAttribute("aria-label") === name,
  );
async function click(name: string) {
  const target = button(name);
  expect(target, name).toBeDefined();
  await act(async () => target!.click());
}
async function type(label: string, value: string) {
  const id = [...container.querySelectorAll("label")].find((item) => item.textContent === label)!.htmlFor;
  const input = document.getElementById(id) as HTMLInputElement;
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(input, value);
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
}
const dialog = () => document.body.querySelector<HTMLElement>("[role=dialog]");

it("reviews the exact grant, Cancel requests nothing, and Confirm sends one request with a request ID", async () => {
  await render([]);
  await type("Actor", " agent ");
  await type("Allowed hosts", "https://Example.com/x");
  await click("Review grant");
  const text = dialog()!.textContent!;
  for (const fragment of ["agent", "read", "example.com", "does not open, bind or control a browser", "workspace one"])
    expect(text).toContain(fragment);
  await click("Cancel");
  expect(createBrowserSessionGrant).not.toHaveBeenCalled();
  expect(container.textContent).toContain("Cancelled. Nothing was changed.");

  vi.mocked(createBrowserSessionGrant).mockResolvedValue(oneHourReceipt);
  await click("Review grant");
  await click("Create grant");
  expect(createBrowserSessionGrant).toHaveBeenCalledOnce();
  const [sessionId, input] = vi.mocked(createBrowserSessionGrant).mock.calls[0]!;
  expect(sessionId).toBe("s-1");
  expect(input).toMatchObject({ actorId: "agent", scopes: ["read"], allowedHosts: ["example.com"], ttlSeconds: 3600 });
  expect(input.requestId).toMatch(/^[0-9a-f-]{36}$/);
  expect(container.textContent).toContain("Grant recorded for agent");
});

it("keeps a lost grant response locked and replays only the same request ID", async () => {
  await render([]);
  await type("Actor", "agent");
  vi.mocked(createBrowserSessionGrant)
    .mockRejectedValueOnce(new Error("socket closed"))
    .mockResolvedValueOnce(oneHourReceipt);
  await click("Review grant");
  await click("Create grant");
  expect(button("Create grant")).toBeUndefined();
  await click("Replay exact request");
  const calls = vi.mocked(createBrowserSessionGrant).mock.calls;
  expect(calls).toHaveLength(2);
  expect(calls[1]![1].requestId).toBe(calls[0]![1].requestId);
});

it("keeps text typed after a lost response when the exact replay succeeds", async () => {
  await render([]);
  await type("Actor", "agent");
  vi.mocked(createBrowserSessionGrant)
    .mockRejectedValueOnce(new Error("socket closed"))
    .mockResolvedValueOnce(noHostReceipt);
  await click("Review grant");
  await click("Create grant");
  await click("Close");
  await type("Actor", "typed later");
  await click("Review pending grant change");
  await click("Replay exact request");
  expect(vi.mocked(createBrowserSessionGrant).mock.calls[1]![1].actorId).toBe("agent");
  expect(container.textContent).toContain("Grant recorded for agent");
  const actor = [...container.querySelectorAll("label")].find((item) => item.textContent === "Actor")!;
  expect((document.getElementById(actor.htmlFor) as HTMLInputElement).value).toBe("typed later");
});

it("reports a replayed grant that has since been revoked instead of calling it new", async () => {
  await render([]);
  await type("Actor", "agent");
  vi.mocked(createBrowserSessionGrant).mockResolvedValue({ ...noHostReceipt, revokedAt: "2099-01-01T00:30:00.000Z" });
  await click("Review grant");
  await click("Create grant");
  expect(container.textContent).toContain("That grant has since been revoked.");
});

it("explains that rotation keeps the actor's access and locks a receipt with a different expiry", async () => {
  await render();
  await click("Review rotating the grant for agent");
  expect(dialog()!.textContent).toContain("Access is checked by actor, so agent keeps the same access");
  vi.mocked(rotateBrowserSessionGrant).mockResolvedValue({
    ...grant,
    grantId: "g-3",
    expiresAt: "2099-02-01T00:00:00.000Z",
  });
  await click("Rotate grant");
  expect(rotateBrowserSessionGrant).toHaveBeenCalledExactlyOnceWith("s-1", "g-1");
  expect(dialog()!.textContent).toContain("does not match the reviewed grant");
  expect(button("Replay exact request")).toBeDefined();
});

it("states whether the actor keeps other access before revoking, and revokes once", async () => {
  await render([grant, { ...grant, grantId: "g-other" }]);
  await click("Review revoking the grant for agent");
  expect(dialog()!.textContent).toContain("1 other active grant for this actor remain");
  vi.mocked(revokeBrowserSessionGrant).mockResolvedValue({ ...grant, revokedAt: "2026-10-07T12:00:00.000Z" });
  await click("Revoke grant");
  expect(revokeBrowserSessionGrant).toHaveBeenCalledExactlyOnceWith("s-1", "g-1");
  expect(container.textContent).toContain("Grant revoked for agent.");
});

it("refuses a grant change when the session moved to another workspace, before any request", async () => {
  vi.mocked(fetchBrowserSession).mockResolvedValue({ ...session, workspaceId: "two" });
  await render();
  await click("Review revoking the grant for agent");
  await click("Revoke grant");
  expect(revokeBrowserSessionGrant).not.toHaveBeenCalled();
  expect(dialog()!.textContent).toContain("not in the current workspace");
});

it("offers no grant form or actions on a closed session", async () => {
  await render([grant], { ...session, status: "closed" });
  expect(container.textContent).toContain("Closed sessions cannot receive grants.");
  expect(button("Review rotating the grant for agent")).toBeUndefined();
});

it("creates a never-expiring grant only when chosen, with a warning in the review and no TTL sent", async () => {
  await render([]);
  await type("Actor", "agent");
  const expiry = [...container.querySelectorAll("select")].find((item) =>
    [...item.options].some((option) => option.textContent?.includes("Never expires")),
  )!;
  await act(async () => {
    expiry.value = String(NEVER_EXPIRES_TTL);
    expiry.dispatchEvent(new Event("change", { bubbles: true }));
  });
  await click("Review grant");
  const text = dialog()!.textContent!;
  expect(text).toContain("Expires: Never");
  expect(text).toContain("stays active until you revoke it");
  vi.mocked(createBrowserSessionGrant).mockResolvedValue({ ...noHostReceipt, expiresAt: undefined });
  await click("Create grant");
  const [, input] = vi.mocked(createBrowserSessionGrant).mock.calls[0]!;
  expect(input).not.toHaveProperty("ttlSeconds");
  expect(container.textContent).toContain("never expires");
});
