import { __resetApprovalOperationAttemptsForTests } from "../inbox/approval-operation-attempts";
import { __resetSessionViewStateForTests } from "../../../hooks/use-session-view-state";
// @vitest-environment happy-dom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import type { MailAccountRecord, MailDraftRecord } from "@goatcitadel/contracts";
import {
  createMailDraft,
  getMailDraft,
  releaseMailDraft,
  sendMailDraft,
} from "@goatcitadel/mission-control-shared/api/personal-ops";
import { fetchApproval } from "@goatcitadel/mission-control-shared/api/approvals";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { __resetSessionDraftsForTests } from "../../../features/native-routes/library/session-drafts";
import { LibraryMailCompose } from "./LibraryMailCompose";

vi.mock("@goatcitadel/mission-control-shared/api/personal-ops", () => ({
  createMailDraft: vi.fn(),
  getMailDraft: vi.fn(),
  releaseMailDraft: vi.fn(),
  sendMailDraft: vi.fn(),
}));
const preferences = vi.hoisted(() => ({ showTechnicalDetails: false }));
vi.mock("@goatcitadel/mission-control-shared/state/ui-preferences", () => ({ useUiPreferences: () => preferences }));
vi.mock("@goatcitadel/mission-control-shared/api/approvals", () => ({
  fetchApproval: vi.fn(async (approvalId: string) => ({ approvalId, status: "pending" })),
}));
vi.mock("./LibraryApproval", () => ({
  LibraryApproval: ({
    approvalId,
    workspaceId,
    onRefresh,
  }: {
    approvalId: string;
    workspaceId: string;
    onRefresh: () => Promise<unknown>;
  }) => (
    <div>
      <p>
        Approval owner {approvalId} in {workspaceId}
      </p>
      <button type="button" onClick={() => void onRefresh()}>
        Simulate decision
      </button>
    </div>
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
  preferences.showTechnicalDetails = false;
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
    "This workspace",
    "No attachments",
    "Approving sends this exact message once through the connected account.",
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
  expect(sendMailDraft).toHaveBeenCalledExactlyOnceWith("draft-1", "one");
  expect(container.textContent).toContain(
    "Send approval requested. Nothing has been sent yet. Approving sends this exact message once.",
  );
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
  expect(vi.mocked(sendMailDraft).mock.calls).toEqual([
    ["draft-1", "one"],
    ["draft-1", "one"],
  ]);
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
  expect(container.textContent).toContain(
    "What you type stays in this browser session. Review saves the draft, including Bcc, on the Gateway. Only Request send approval asks for an approval; approving sends this exact message once.",
  );
  expect(container.textContent).not.toContain("does not send mail from here");
});

async function requestApproval() {
  vi.mocked(createMailDraft).mockResolvedValue(draft);
  vi.mocked(sendMailDraft).mockResolvedValue(pending);
  await render();
  await compose();
  await click("Review send request");
  await click("Request send approval");
}

it("re-reads the draft after the approval is decided and shows that it was sent", async () => {
  await requestApproval();
  vi.mocked(getMailDraft).mockResolvedValue({ ...pending, status: "sent", sentAt: "later" });
  await click("Simulate decision");
  expect(getMailDraft).toHaveBeenCalledExactlyOnceWith("draft-1", "one");
  expect(container.querySelector("[aria-label='Send approval receipt']")!.textContent).toContain("Sent.");
});

it.each([
  ["failed", "Send approval was rejected; nothing was sent.", "The send approval was rejected. Nothing was sent."],
  [
    "send_unavailable",
    "The account has no send transport.",
    "Nothing was sent. The Gateway recorded a reason this view does not recognize.",
  ],
] as const)("shows why a %s draft was not sent in operator words", async (status, failureReason, copy) => {
  await requestApproval();
  vi.mocked(getMailDraft).mockResolvedValue({ ...pending, status, failureReason });
  await click("Simulate decision");
  expect(container.textContent).toContain(copy);
});

it("keeps raw provider text behind technical details", async () => {
  const raw = "Mail send failed: 535 5.7.8 Username and Password not accepted";
  await requestApproval();
  vi.mocked(getMailDraft).mockResolvedValue({ ...pending, status: "failed", failureReason: raw });
  await click("Simulate decision");
  const receipt = () => container.querySelector("[aria-label='Send approval receipt']")!.textContent!;
  expect(receipt()).toContain("The mail provider refused the message. Nothing was sent.");
  expect(receipt()).not.toContain("535 5.7.8");

  preferences.showTechnicalDetails = true;
  await click("Simulate decision");
  expect(receipt()).toContain("Recorded failure reason");
  expect(receipt()).toContain(raw);
});

it("shows an unknown delivery outcome as possibly delivered, never as not sent", async () => {
  await requestApproval();
  vi.mocked(getMailDraft).mockResolvedValue({
    ...pending,
    status: "outcome_unknown",
    failureReason: "Delivery outcome is unknown; check the mailbox before retrying.",
  });
  await click("Simulate decision");
  const receipt = container.querySelector("[aria-label='Send approval receipt']")!;
  const text = receipt.textContent!;
  expect(text).toContain("Outcome unknown");
  expect(text).toContain("may have been delivered");
  expect(text).toContain("Check the sent mailbox before sending it again.");
  expect(text).not.toMatch(/not sent|nothing was sent|nothing has been sent/i);
  const regions = [...receipt.querySelectorAll("[role=alert], [role=status]")];
  expect(regions).toHaveLength(1);
});

it("shows a replayed send of an outcome_unknown draft as possibly delivered, never as not sent", async () => {
  vi.mocked(createMailDraft).mockResolvedValue(draft);
  vi.mocked(sendMailDraft).mockResolvedValue({ ...pending, status: "outcome_unknown" });
  await render();
  await compose();
  await click("Review send request");
  await click("Request send approval");
  const text = container.querySelector("[aria-label='Send approval receipt']")!.textContent!;
  expect(text).toContain("Outcome unknown");
  expect(text).toContain("Check the sent mailbox before sending it again.");
  expect(text).not.toMatch(/not sent|nothing was sent/i);
});

it("shows a decided send as in progress, not as not-sent-yet, while the draft still awaits its outcome", async () => {
  await requestApproval();
  vi.mocked(getMailDraft).mockResolvedValue(pending);
  vi.mocked(fetchApproval).mockResolvedValueOnce({ approvalId: "approval-1", status: "approved" } as never);
  await click("Simulate decision");
  const receipt = container.querySelector("[aria-label='Send approval receipt']")!.textContent!;
  expect(fetchApproval).toHaveBeenLastCalledWith("approval-1", { workspaceId: "one" });
  expect(receipt).toContain("The approval was decided; delivery is in progress. Refresh to see the outcome.");
  expect(receipt).not.toContain("Nothing has been sent yet");
});

it("keeps the not-sent-yet wording while the approval is still pending", async () => {
  await requestApproval();
  vi.mocked(getMailDraft).mockResolvedValue(pending);
  await click("Simulate decision");
  expect(container.querySelector("[aria-label='Send approval receipt']")!.textContent).toContain(
    "Nothing has been sent yet",
  );
});

it("announces the decided outcome through the decision callout, not a second live region", async () => {
  await requestApproval();
  vi.mocked(getMailDraft).mockResolvedValue({ ...pending, status: "failed", failureReason: "Rejected." });
  await click("Simulate decision");
  const receipt = container.querySelector("[aria-label='Send approval receipt']")!;
  const regions = [...receipt.querySelectorAll("[role=alert], [role=status]")];
  expect(regions).toHaveLength(1);
  expect(regions[0]!.textContent).toContain(
    "Nothing was sent. The Gateway recorded a reason this view does not recognize.",
  );
});

it("keeps the receipt readable when the draft re-read fails", async () => {
  await requestApproval();
  vi.mocked(getMailDraft).mockRejectedValue(new Error("offline"));
  await click("Simulate decision");
  expect(container.textContent).toContain("Approval owner approval-1 in one");
  expect(container.textContent).not.toContain("Sent.");
});

it("explains an interrupted send request exactly, without a lock, suffix or replay", async () => {
  vi.mocked(createMailDraft).mockResolvedValue(draft);
  vi.mocked(sendMailDraft).mockResolvedValueOnce({ ...pending, approvalId: undefined });
  await render();
  await compose();
  await click("Review send request");
  await click("Request send approval");
  const message =
    "This send request was interrupted before its approval was recorded. Nothing was sent. After a short safety wait, the Gateway can check for a recorded approval and release this draft so you can request one again.";
  const alert = [...container.querySelectorAll("[role=alert], [role=status]")].find((n) => n.textContent === message);
  expect(alert, "exact message").toBeDefined();
  expect(button("Check and release draft")?.disabled).toBe(false);
  expect(container.textContent).not.toContain("not confirmed");
  expect(container.textContent).not.toContain("remains locked");
  expect(container.textContent).not.toContain("does not match the reviewed draft");
  expect(button("Replay exact send request")).toBeUndefined();
  expect(button("Review pending send request")).toBeUndefined();
  expect(button("Review send request")?.disabled).toBe(false);
});

async function interruptSend() {
  vi.mocked(createMailDraft).mockResolvedValue(draft);
  vi.mocked(sendMailDraft).mockResolvedValueOnce({ ...pending, approvalId: undefined });
  await render();
  await compose();
  await click("Review send request");
  await click("Request send approval");
}

it("releases an interrupted draft back to review so one new approval can be requested", async () => {
  await interruptSend();
  vi.mocked(releaseMailDraft).mockResolvedValueOnce({ outcome: "released", draft });
  await click("Check and release draft");
  expect(releaseMailDraft).toHaveBeenCalledExactlyOnceWith("draft-1", "one");
  expect(dialog()?.textContent).toContain("it was released. Review it and request send approval again.");
  expect(container.querySelector("[aria-label='Interrupted send request']")).toBeNull();

  vi.mocked(sendMailDraft).mockResolvedValueOnce(pending);
  await click("Request send approval");
  expect(sendMailDraft).toHaveBeenLastCalledWith("draft-1", "one");
  expect(container.textContent).toContain("Approval owner approval-1 in one");
});

it("shows the approval that did persist instead of releasing the draft", async () => {
  await interruptSend();
  vi.mocked(releaseMailDraft).mockResolvedValueOnce({ outcome: "relinked", draft: pending });
  await click("Check and release draft");
  expect(dialog()).toBeNull();
  expect(container.textContent).toContain("Approval owner approval-1 in one");
  expect(container.querySelector("[aria-label='Interrupted send request']")).toBeNull();
});

it("reopens review for a draft an earlier, unconfirmed release already freed", async () => {
  await interruptSend();
  vi.mocked(releaseMailDraft).mockResolvedValueOnce({ outcome: "not_interrupted", draft });
  await click("Check and release draft");
  expect(dialog()?.textContent).toContain("Request send approval");
});

it("asks the operator to wait while the interrupted request may still finish", async () => {
  await interruptSend();
  vi.mocked(releaseMailDraft).mockResolvedValueOnce({
    outcome: "too_recent",
    draft: { ...pending, approvalId: undefined },
    retryAfterSeconds: 290,
  });
  await click("Check and release draft");
  expect(container.textContent).toContain("Try again in about 5 minutes.");
  expect(button("Check and release draft")?.disabled).toBe(false);
  expect(dialog()).toBeNull();
});

it("reports a failed release without claiming either outcome", async () => {
  await interruptSend();
  vi.mocked(releaseMailDraft).mockRejectedValueOnce(new Error("Gateway offline"));
  await click("Check and release draft");
  expect(container.textContent).toContain("The release was not confirmed.");
  expect(button("Check and release draft")).toBeDefined();
});

it("replaces the not-sent-yet callout once the re-read shows the decided outcome", async () => {
  await requestApproval();
  vi.mocked(getMailDraft).mockResolvedValue({ ...pending, status: "sent" });
  await click("Simulate decision");
  const text = container.querySelector("[aria-label='Send approval receipt']")!.textContent!;
  expect(text).not.toContain("Nothing has been sent yet");
  expect(text).toContain("Sent.");
  vi.mocked(getMailDraft).mockResolvedValue({ ...pending, status: "failed", failureReason: "Rejected." });
  await click("Simulate decision");
  const failed = container.querySelector("[aria-label='Send approval receipt']")!.textContent!;
  expect(failed).not.toContain("Nothing has been sent yet");
  expect(failed).toContain("but the message was not sent.");
});

it("ignores an older draft re-read that resolves after a newer one", async () => {
  await requestApproval();
  let older!: (v: MailDraftRecord) => void;
  vi.mocked(getMailDraft)
    .mockReturnValueOnce(new Promise((r) => (older = r)))
    .mockResolvedValueOnce({ ...pending, status: "sent" });
  await click("Simulate decision");
  await click("Simulate decision");
  await act(async () => older(pending));
  expect(container.querySelector("[aria-label='Send approval receipt']")!.textContent).toContain("Sent.");
});

it("still re-reads the draft when the record refresh fails", async () => {
  vi.mocked(createMailDraft).mockResolvedValue(draft);
  vi.mocked(sendMailDraft).mockResolvedValue(pending);
  let calls = 0;
  await act(async () =>
    root.render(
      <LibraryMailCompose
        workspaceId="one"
        accounts={[account]}
        available
        onRefresh={async () => {
          if (++calls > 1) throw new Error("refresh failed");
        }}
      />,
    ),
  );
  await compose();
  await click("Review send request");
  await click("Request send approval");
  vi.mocked(getMailDraft).mockResolvedValue({ ...pending, status: "sent" });
  await click("Simulate decision");
  expect(container.textContent).toContain("Sent.");
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
  expect(vi.mocked(sendMailDraft).mock.calls).toEqual([
    ["draft-1", "one"],
    ["draft-1", "one"],
  ]);
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
