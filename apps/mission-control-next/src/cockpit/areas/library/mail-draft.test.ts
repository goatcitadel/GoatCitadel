import { describe, expect, it } from "vitest";
import type { MailDraftRecord } from "@goatcitadel/contracts";
import { draftMatchesRequest, EMPTY_MAIL_COMPOSE, parseRecipients, validateMailCompose } from "./mail-draft";

const accounts = [{ accountId: "acct-a" }, { accountId: "acct-b" }];
const compose = {
  ...EMPTY_MAIL_COMPOSE,
  accountId: "acct-a",
  to: " a@example.test; b@example.test ,",
  subject: " Status ",
  bodyText: "Line one\n  line two ",
};

describe("mail compose validation", () => {
  it("splits on commas, semicolons and newlines without inventing recipients", () => {
    expect(parseRecipients(" a@example.test;b@example.test,\n c@example.test ,, ")).toEqual([
      "a@example.test",
      "b@example.test",
      "c@example.test",
    ]);
    expect(parseRecipients("   ")).toEqual([]);
  });

  it("returns the exact request it will send, preserving body whitespace", () => {
    expect(validateMailCompose(compose, accounts)).toEqual({
      ok: true,
      request: {
        accountId: "acct-a",
        to: ["a@example.test", "b@example.test"],
        cc: [],
        bcc: [],
        subject: "Status",
        bodyText: "Line one\n  line two ",
      },
    });
  });

  it("names every missing or malformed field instead of submitting", () => {
    const result = validateMailCompose(
      { ...EMPTY_MAIL_COMPOSE, accountId: "gone", to: "not-an-address", cc: "ok@example.test, nope", bodyText: "   " },
      accounts,
    );
    expect(result).toEqual({
      ok: false,
      errors: {
        accountId: "Choose a connected mail account for this workspace.",
        to: "Check these addresses: not-an-address",
        cc: "Check these addresses: nope",
        subject: "Enter a subject.",
        bodyText: "Enter the message text.",
      },
    });
    expect(validateMailCompose({ ...compose, to: "" }, accounts)).toMatchObject({
      ok: false,
      errors: { to: "Enter at least one recipient." },
    });
  });
});

describe("draft receipt comparison", () => {
  const request = {
    accountId: "acct-a",
    to: ["a@example.test"],
    cc: ["c@example.test"],
    bcc: [],
    subject: "Status",
    bodyText: "Body",
  };
  const record: MailDraftRecord = {
    draftId: "d-1",
    workspaceId: "one",
    ...request,
    status: "draft",
    createdAt: "now",
    updatedAt: "now",
  };

  it("accepts only the same workspace, account, recipients, subject and body", () => {
    expect(draftMatchesRequest(record, request, "one")).toBe(true);
    expect(draftMatchesRequest({ ...record, workspaceId: undefined }, request, "one")).toBe(false);
    expect(draftMatchesRequest({ ...record, workspaceId: "two" }, request, "one")).toBe(false);
    expect(draftMatchesRequest({ ...record, accountId: "acct-b" }, request, "one")).toBe(false);
    expect(draftMatchesRequest({ ...record, to: ["a@example.test", "x@example.test"] }, request, "one")).toBe(false);
    expect(draftMatchesRequest({ ...record, cc: [] }, request, "one")).toBe(false);
    expect(draftMatchesRequest({ ...record, bcc: ["x@example.test"] }, request, "one")).toBe(false);
    expect(draftMatchesRequest({ ...record, subject: "Status!" }, request, "one")).toBe(false);
    expect(draftMatchesRequest({ ...record, bodyText: "Body " }, request, "one")).toBe(false);
  });
});
