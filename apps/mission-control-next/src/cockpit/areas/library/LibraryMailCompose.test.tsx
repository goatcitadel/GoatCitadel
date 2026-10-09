import { __resetApprovalOperationAttemptsForTests } from "../inbox/approval-operation-attempts";
import { __resetSessionViewStateForTests } from "../../../hooks/use-session-view-state";
// @vitest-environment happy-dom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import type { MailAccountRecord, MailDraftRecord } from "@goatcitadel/contracts";
import { createMailDraft, sendMailDraft } from "@goatcitadel/mission-control-shared/api/personal-ops";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { __resetSessionDraftsForTests } from "../../../features/native-routes/library/session-drafts";
import { LibraryMailCompose } from "./LibraryMailCompose";

vi.mock("@goatcitadel/mission-control-shared/api/personal-ops", () => ({
  createMailDraft: vi.fn(),
  sendMailDraft: vi.fn(),
}));
vi.mock("./LibraryApproval", () => ({
  LibraryApproval: ({ approvalId, workspaceId }: { approvalId: string; workspaceId: string }) => (
    <p>
      Approval owner {approvalId} in {workspaceId}
    </p>
  ),
}));

const account: MailAccountRecord = {
  accountId: "acct-a",
  workspaceId: "one",
  provider: "gmail",
  label: "Fixture mail",
  address: "inbox@example.test",
  syncStatus: "not_configured",
  createdAt: "now",
  updatedAt: "now",
};
const draft: MailDraftRecord = {
  draftId: "draft-1",
  workspaceId: "one",
  accountId: "acct-a",
  to: ["a@example.test", "b@example.test"],
  cc: ["c@example.test"],
  bcc: [],
  subject: "Quarterly status",
  bodyText: "Hello,\n  exact body.",
  status: "draft",
  createdAt: "now",
  updatedAt: "now",
};
const pending: MailDraftRecord = { ...draft, status: "approval_required", approvalId: "approval-1" };
let root: Root, container: HTMLDivElement;

beforeEach(() => {
  vi.resetAllMocks();
  __resetApprovalOperationAttemptsForTests();
  __resetSessionViewStateForTests();
  __resetSessionDraftsForTests();
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});
afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

async function render(workspaceId = "one", accounts = [account]) {
  await act(async () =>
    root.render(
      <LibraryMailCompose workspaceId={workspaceId} accounts={accounts} available onRefresh={async () => undefined} />,
    ),
  );
}
const buttons = () => [...document.body.querySelectorAll<HTMLButtonElement>("button")];
const button = (name: string) => buttons().find((item) => item.textContent === name);
async function click(name: string) {
  const target = button(name);
  expect(target, name).toBeDefined();
  await act(async () => target!.click());
}
async function type(label: string, value: string) {
  const id = [...container.querySelectorAll("label")].find((item) => item.textContent === label)!.htmlFor;
  const input = document.getElementById(id) as HTMLInputElement | HTMLTextAreaElement;
  const proto = input instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
  await act(async () => {
    Object.getOwnPropertyDescriptor(proto, "value")!.set!.call(input, value);
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
}
async function compose() {
  await type("To", "a@example.test; b@example.test");
  await type("Cc", "c@example.test");
  await type("Subject", "Quarterly status");
  await type("Message", "Hello,\n  exact body.");
}
const dialog = () => document.body.querySelector<HTMLElement>("[role=dialog]");

it("shows the exact Gateway draft, its scope and consequences, and Cancel requests nothing", async () => {
  vi.mocked(createMailDraft).mockResolvedValue(draft);
  await render();
  await compose();
  await click("Review send request");
  expect(createMailDraft).toHaveBeenCalledExactlyOnceWith({
    workspaceId: "one",
    accountId: "acct-a",
    to: ["a@example.test", "b@example.test"],
    cc: ["c@example.test"],
    bcc: [],
    subject: "Quarterly status",
    bodyText: "Hello,\n  exact body.",
  });
  const review = dialog()!.textContent!;
  for (const text of [
    "Fixture mail",
    "inbox@example.test",
    "a@example.test",
    "b@example.test",
    "c@example.test",
    "Quarterly status",
    "Workspace one",
    "No attachments",
    "does not send this message",
    "Delivery is never confirmed",
  ])
    expect(review).toContain(text);
  expect(dialog()!.querySelector("[role=region][aria-label='Exact message text']")!.textContent).toBe(
    "Hello,\n  exact body.",
  );
  await click("Cancel");
  expect(sendMailDraft).not.toHaveBeenCalled();
  expect(dialog()).toBeNull();
  expect(container.textContent).toContain("No send approval was requested.");
});

it("requests exactly one approval, links the approval owner and clears the sent compose draft", async () => {
  vi.mocked(createMailDraft).mockResolvedValue(draft);
  vi.mocked(sendMailDraft).mockResolvedValue(pending);
  await render();
  await compose();
  await click("Review send request");
  await click("Request send approval");
  expect(sendMailDraft).toHaveBeenCalledExactlyOnceWith("draft-1");
  expect(container.textContent).toContain("Send approval requested. Nothing has been sent.");
  expect(container.textContent).toContain("Approval owner approval-1 in one");
  expect((container.querySelector("textarea") as HTMLTextAreaElement).value).toBe("");
  expect(button("Request send approval")).toBeUndefined();
});

it("keeps a lost send response locked and offers only the exact replay of the same draft", async () => {
  vi.mocked(createMailDraft).mockResolvedValue(draft);
  vi.mocked(sendMailDraft).mockRejectedValueOnce(new Error("socket closed")).mockResolvedValueOnce(pending);
  await render();
  await compose();
  await click("Review send request");
  await click("Request send approval");
  expect(dialog()!.textContent).toContain("The original attempt remains locked.");
  // A lost response never re-offers a fresh request; only the exact original can be replayed.
  expect(button("Request send approval")).toBeUndefined();
  expect(button("Replay exact send request")).toBeDefined();
  await act(async () => {
    dialog()!.querySelector<HTMLButtonElement>("button[aria-label='Close dialog']")?.click();
  });
  expect(button("Review send request")?.disabled).toBe(true);
  await click("Review pending send request");
  await click("Replay exact send request");
  expect(createMailDraft).toHaveBeenCalledOnce();
  expect(vi.mocked(sendMailDraft).mock.calls).toEqual([["draft-1"], ["draft-1"]]);
  expect(container.textContent).toContain("Approval owner approval-1 in one");
});

it("rejects a draft receipt from another workspace before any send request", async () => {
  vi.mocked(createMailDraft).mockResolvedValue({ ...draft, workspaceId: "two" });
  await render();
  await compose();
  await click("Review send request");
  expect(dialog()).toBeNull();
  expect(sendMailDraft).not.toHaveBeenCalled();
  expect(container.textContent).toContain("does not match what you entered");
});

it("reports a failed draft without promising that no approval exists, and keeps the compose", async () => {
  vi.mocked(createMailDraft).mockResolvedValue(draft);
  vi.mocked(sendMailDraft).mockResolvedValue({
    ...draft,
    workspaceId: undefined,
    accountId: "unknown",
    to: [],
    cc: [],
    subject: "",
    bodyText: "",
    status: "failed",
  });
  await render();
  await compose();
  await click("Review send request");
  await click("Request send approval");
  expect(container.textContent).toContain("no longer holds it");
  expect(container.textContent).toContain("ended without a confirmed outcome. Nothing was sent. Check Inbox");
  // A failed draft can follow an uncertain approval request, so the UI must not promise none exists.
  expect(container.textContent).not.toContain("no approval was requested");
  expect((container.querySelector("textarea") as HTMLTextAreaElement).value).toBe("Hello,\n  exact body.");
});

it("names invalid fields without contacting the Gateway", async () => {
  await render("one", [account, { ...account, accountId: "acct-b", label: "Second" }]);
  await type("To", "nope");
  await click("Review send request");
  expect(createMailDraft).not.toHaveBeenCalled();
  for (const text of [
    "Choose a connected mail account for this workspace.",
    "Check these addresses: nope",
    "Enter a subject.",
    "Enter the message text.",
  ])
    expect(container.textContent).toContain(text);
});

it("drops a draft receipt that arrives after the workspace changed", async () => {
  let resolve!: (value: MailDraftRecord) => void;
  vi.mocked(createMailDraft).mockReturnValue(
    new Promise((done) => {
      resolve = done;
    }),
  );
  await render();
  await compose();
  await click("Review send request");
  await render("two", [{ ...account, workspaceId: "two" }]);
  await act(async () => resolve(draft));
  expect(dialog()).toBeNull();
  expect(sendMailDraft).not.toHaveBeenCalled();
});

it("states plainly when no mail account is connected", async () => {
  await render("one", []);
  expect(container.textContent).toContain("No mail account is connected to this workspace.");
  expect(button("Review send request")?.disabled).toBe(true);
});

it("does not claim an empty account list while accounts are still unknown", async () => {
  await act(async () =>
    root.render(
      <LibraryMailCompose workspaceId="one" accounts={undefined} available onRefresh={async () => undefined} />,
    ),
  );
  expect(container.textContent).toContain("Reading mail accounts…");
  expect(container.textContent).not.toContain("No mail account is connected");
  expect(button("Review send request")?.disabled).toBe(true);
});

it("says the Gateway holds the reviewed draft, not only this browser", async () => {
  await render();
  expect(container.textContent).toContain("Review stores the draft, including Bcc, in Gateway memory");
});

async function loseFirstSend() {
  vi.mocked(createMailDraft).mockResolvedValue(draft);
  vi.mocked(sendMailDraft).mockRejectedValueOnce(new Error("socket closed"));
  await render();
  await compose();
  await click("Review send request");
  await click("Request send approval");
  expect(button("Replay exact send request")).toBeDefined();
}

it("never says no approval was requested when a replay finds the draft gone", async () => {
  await loseFirstSend();
  vi.mocked(sendMailDraft).mockResolvedValueOnce({
    ...draft,
    workspaceId: undefined,
    accountId: "unknown",
    to: [],
    cc: [],
    subject: "",
    bodyText: "",
    status: "failed",
  });
  await click("Replay exact send request");
  expect(container.textContent).toContain("The earlier send request's outcome is unknown");
  expect(container.textContent).toContain("Check Inbox");
  expect(container.textContent).not.toContain("no approval was requested");
  // The same receipt follows an approval-creation failure, where the Gateway still holds the draft.
  expect(container.textContent).not.toContain("no longer holds");
});

it("keeps the exact replay available when the replay is also lost", async () => {
  await loseFirstSend();
  vi.mocked(sendMailDraft).mockRejectedValueOnce(new Error("socket closed again"));
  await click("Replay exact send request");
  expect(button("Replay exact send request")).toBeDefined();
  expect(button("Request send approval")).toBeUndefined();
  expect(vi.mocked(sendMailDraft).mock.calls).toEqual([["draft-1"], ["draft-1"]]);
});

it("locks a mismatched send receipt as uncertain instead of accepting it", async () => {
  vi.mocked(createMailDraft).mockResolvedValue(draft);
  vi.mocked(sendMailDraft).mockResolvedValueOnce({ ...pending, subject: "Something else" });
  await render();
  await compose();
  await click("Review send request");
  await click("Request send approval");
  expect(dialog()!.textContent).toContain("does not match the reviewed draft");
  expect(button("Replay exact send request")).toBeDefined();
  expect(container.textContent).not.toContain("Approval owner");
});

it("drops a send receipt that arrives after the workspace changed", async () => {
  let resolve!: (value: MailDraftRecord) => void;
  vi.mocked(createMailDraft).mockResolvedValue(draft);
  vi.mocked(sendMailDraft).mockReturnValue(
    new Promise((done) => {
      resolve = done;
    }),
  );
  await render();
  await compose();
  await click("Review send request");
  await click("Request send approval");
  await render("two", [{ ...account, workspaceId: "two" }]);
  await act(async () => resolve(pending));
  expect(container.textContent).not.toContain("Approval owner");
  expect(container.textContent).not.toContain("Send approval requested");
});
