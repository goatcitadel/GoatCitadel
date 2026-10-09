// @vitest-environment happy-dom
import { renderToStaticMarkup } from "react-dom/server";
import { expect, it } from "vitest";
import type { ApprovalRequest } from "@goatcitadel/contracts";
import { ApprovalReviewSummary } from "./ApprovalReviewSummary";

it("keeps complete long scope, targets, commands and consequences in the bounded ordinary review", () => {
  const token = "scope_" + "a".repeat(200);
  const command = `return "${token}";`;
  const record: ApprovalRequest = {
    approvalId: "a",
    kind: "tool_invoke",
    status: "pending",
    riskLevel: "danger",
    explanationStatus: "not_requested",
    payload: {},
    createdAt: "2026-01-01",
    linkage: { workspaceId: token, sessionId: `session_${token}` },
    preview: { targets: [`folder/${token}`], commands: [command], url: `https://example.invalid/${token}` },
    rollbackNote: `Recover ${token}`,
  };
  const host = document.createElement("div");
  host.innerHTML = renderToStaticMarkup(<ApprovalReviewSummary approval={record} workspaceId="fallback" />);
  const review = host.querySelector('section[aria-label="Approval scope and consequences"]')!;
  expect(review.classList.contains("wrap-anywhere")).toBe(true);
  expect(review.classList.contains("min-w-0")).toBe(true);
  expect(review.textContent).toContain(`workspace ${token} · conversation session_${token}`);
  expect(review.textContent).toContain(`folder/${token}`);
  expect(review.textContent).toContain(`https://example.invalid/${token}`);
  expect(review.textContent).toContain(`Recover ${token}`);
  expect(review.textContent).toContain("The decision alone does not prove work resumed or completed.");
  expect(review.querySelector("pre")?.textContent).toBe(`Commands: ${command}`);
  expect(review.querySelector("pre")?.classList.contains("max-w-full")).toBe(true);
});

it("shows a mail send approval's exact recipients, open message text and intent-only consequence", () => {
  const draft = {
    draftId: "d-1",
    accountId: "acct-a",
    to: ["a@example.test"],
    cc: [],
    bcc: ["hidden@example.test"],
    subject: "Status",
  };
  const record: ApprovalRequest = {
    approvalId: "a",
    kind: "communications.mail.send",
    status: "pending",
    riskLevel: "danger",
    explanationStatus: "not_requested",
    payload: { action: "mail_send", ...draft, bodyText: "Exact\n  body." },
    preview: {
      title: "Send mail draft",
      ...draft,
      execution: "Approval records operator intent; this route does not send the message.",
    },
    linkage: { actionType: "communications.mail.send", connectorId: "acct-a", workspaceId: "workspace-mail" },
    createdAt: "2026-01-01",
  };
  const host = document.createElement("div");
  host.innerHTML = renderToStaticMarkup(<ApprovalReviewSummary approval={record} workspaceId="fallback" />);
  const review = host.querySelector('section[aria-label="Approval scope and consequences"]')!;
  expect(review.textContent).toContain("To: a@example.test");
  expect(review.textContent).toContain("Bcc: hidden@example.test");
  expect(review.textContent).toContain("Workspace workspace-mail.");
  expect(review.textContent).toContain("GoatCitadel does not send this message, and delivery is never confirmed.");
  const message = review.querySelector("details")!;
  expect(message.hasAttribute("open")).toBe(true);
  expect(message.querySelector("pre")?.textContent).toBe("Exact\n  body.");
});

it("labels a memory review target once, keeps the exact title, and shows Gateway-written summaries without generated labels", () => {
  const record: ApprovalRequest = {
    approvalId: "m",
    kind: "memory.lifecycle.patch",
    status: "pending",
    riskLevel: "caution",
    explanationStatus: "not_requested",
    payload: {},
    createdAt: "2026-01-01",
    linkage: { workspaceId: "ws-1" },
    preview: {
      reviewKind: "memory.lifecycle.patch",
      target: "Owned memory A",
      scopeSummary: "Workspace: ws-1; namespace: notes",
      ttlSummary: "Requested TTL: 600 seconds",
      pinnedSummary: "Requested pinned state: unpinned",
    },
  };
  const host = document.createElement("div");
  host.innerHTML = renderToStaticMarkup(<ApprovalReviewSummary approval={record} workspaceId="fallback" />);
  const text = host.textContent ?? "";
  expect(text).toContain("Target: Owned memory A");
  expect(text).not.toContain("Target: Target:");
  expect(text).toContain("Requested TTL: 600 seconds");
  expect(text).not.toMatch(/(Ttl|Scope|Pinned) Summary/);

  const titled = { ...record, preview: { ...record.preview, target: "Target: launch plan" } } as ApprovalRequest;
  host.innerHTML = renderToStaticMarkup(<ApprovalReviewSummary approval={titled} workspaceId="fallback" />);
  // A user title that itself starts with "Target:" is shown exactly, after the one generated label.
  expect(host.textContent).toContain("Target: Target: launch plan");
  expect(host.textContent).not.toContain("Target: Target: Target:");
});
