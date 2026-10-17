import { afterEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import type { MailDraftRecord } from "@goatcitadel/contracts";
import { MailDraftRepository } from "./mail-draft-repo.js";
import { TempSqliteFiles } from "./temp-sqlite.test-support.js";

const tempDbs = new TempSqliteFiles();

afterEach(() => tempDbs.cleanup());

function draft(overrides: Partial<MailDraftRecord> = {}): MailDraftRecord {
  return {
    draftId: "draft-1",
    workspaceId: "default",
    accountId: "account-1",
    to: ["ana@example.test", "bo@example.test"],
    cc: [],
    bcc: [],
    subject: "Quarterly notes",
    bodyText: "Hello,\nnotes attached.",
    status: "draft",
    createdAt: "2026-10-16T09:00:00.000Z",
    updatedAt: "2026-10-16T09:00:00.000Z",
    ...overrides,
  };
}

describe("MailDraftRepository", () => {
  it("round-trips every field, including empty cc and bcc", () => {
    const dbPath = tempDbs.path("goatcitadel-mail-drafts");
    const repo = new MailDraftRepository(tempDbs.open({ dbPath }));
    const created = repo.create(draft());
    assert.deepEqual(created, draft());
    assert.deepEqual(repo.find("draft-1"), draft());
    assert.deepEqual(repo.get("draft-1"), draft());

    const { workspaceId: _omitted, ...full } = draft({
      draftId: "draft-2",
      cc: ["cc@example.test"],
      bcc: ["bcc@example.test"],
      approvalId: "ap-9",
      status: "failed",
      failureReason: "provider rejected",
      sentAt: "2026-10-16T09:05:00.000Z",
    });
    repo.create(full);
    assert.deepEqual(repo.find("draft-2"), full);
    assert.equal(repo.find("absent"), undefined);
    assert.throws(() => repo.get("absent"), /not found/i);
  });

  it("rejects a duplicate draft id", () => {
    const repo = new MailDraftRepository(tempDbs.open({ dbPath: tempDbs.path("goatcitadel-mail-drafts") }));
    repo.create(draft());
    assert.throws(() => repo.create(draft({ subject: "Other" })));
    assert.equal(repo.get("draft-1").subject, "Quarterly notes");
  });

  it("transitions only while the current status is allowed", () => {
    const repo = new MailDraftRepository(tempDbs.open({ dbPath: tempDbs.path("goatcitadel-mail-drafts") }));
    repo.create(draft());
    const patch = {
      status: "approval_required" as const,
      approvalId: "ap-1",
      updatedAt: "2026-10-16T09:01:00.000Z",
    };
    const updated = repo.transition("draft-1", ["draft"], patch);
    assert.deepEqual(updated, draft({ status: "approval_required", approvalId: "ap-1", updatedAt: patch.updatedAt }));

    const before = repo.get("draft-1");
    assert.equal(repo.transition("draft-1", ["draft"], patch), undefined);
    assert.equal(
      repo.transition("draft-1", ["draft"], { status: "failed", failureReason: "x", updatedAt: "later" }),
      undefined,
    );
    assert.deepEqual(repo.get("draft-1"), before);
    assert.equal(repo.transition("absent", ["draft"], patch), undefined);

    const sent = repo.transition("draft-1", ["approval_required"], {
      status: "sent",
      sentAt: "2026-10-16T09:02:00.000Z",
      updatedAt: "2026-10-16T09:02:00.000Z",
    });
    assert.equal(sent?.status, "sent");
    assert.equal(sent?.approvalId, "ap-1", "an omitted approvalId keeps the stored one");
    assert.equal(sent?.sentAt, "2026-10-16T09:02:00.000Z");
  });

  it("clears a stale failure reason only when the transition asks to", () => {
    const repo = new MailDraftRepository(tempDbs.open({ dbPath: tempDbs.path("goatcitadel-mail-drafts") }));
    repo.create(draft({ status: "approval_required", approvalId: "ap-1" }));
    const failed = repo.transition("draft-1", ["approval_required"], {
      status: "failed",
      failureReason: "Delivery outcome is unknown; check the mailbox before retrying.",
      updatedAt: "2026-10-16T09:01:00.000Z",
    });
    assert.equal(failed?.failureReason, "Delivery outcome is unknown; check the mailbox before retrying.");
    const kept = repo.transition("draft-1", ["failed"], { status: "failed", updatedAt: "2026-10-16T09:01:30.000Z" });
    assert.equal(kept?.failureReason, failed?.failureReason, "an omitted failureReason keeps the stored one");

    const sent = repo.transition("draft-1", ["approval_required", "failed"], {
      status: "sent",
      clearFailureReason: true,
      sentAt: "2026-10-16T09:02:00.000Z",
      updatedAt: "2026-10-16T09:02:00.000Z",
    });
    assert.equal(sent?.status, "sent");
    assert.equal(sent?.failureReason, undefined);
    assert.equal(repo.get("draft-1").failureReason, undefined);
    assert.equal(sent?.approvalId, "ap-1");
    assert.throws(
      () =>
        repo.transition("draft-1", ["sent"], {
          status: "sent",
          failureReason: "x",
          clearFailureReason: true,
          updatedAt: "later",
        }),
      /cannot both set and clear/,
    );
  });

  it("round-trips an outcome_unknown draft and keeps it out of a resend transition", () => {
    const dbPath = tempDbs.path("goatcitadel-mail-drafts");
    const repo = new MailDraftRepository(tempDbs.open({ dbPath }));
    repo.create(draft({ status: "approval_required", approvalId: "ap-1" }));
    const reason = "Delivery outcome is unknown; check the mailbox before retrying.";
    const unknown = repo.transition("draft-1", ["approval_required", "failed"], {
      status: "outcome_unknown",
      failureReason: reason,
      updatedAt: "2026-10-16T09:01:00.000Z",
    });
    assert.deepEqual(
      unknown,
      draft({
        status: "outcome_unknown",
        approvalId: "ap-1",
        failureReason: reason,
        updatedAt: "2026-10-16T09:01:00.000Z",
      }),
    );
    assert.deepEqual(repo.get("draft-1"), unknown);
    assert.equal(
      repo.transition("draft-1", ["approval_required", "failed"], { status: "sent", updatedAt: "later" }),
      undefined,
      "the executor's sent transition never applies to an outcome_unknown draft",
    );
    assert.equal(repo.get("draft-1").status, "outcome_unknown");
  });

  it("finds a draft after reopening the same database file", () => {
    const dbPath = tempDbs.path("goatcitadel-mail-drafts");
    const first = tempDbs.open({ dbPath });
    new MailDraftRepository(first).create(draft());
    first.close();
    const reopened = new MailDraftRepository(tempDbs.open({ dbPath }));
    assert.deepEqual(reopened.find("draft-1"), draft());
  });
});
