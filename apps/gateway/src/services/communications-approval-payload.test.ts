import { describe, expect, it } from "vitest";
import {
  COMMUNICATIONS_IDEMPOTENCY_PREFIX,
  communicationsIdempotencyKey,
  computeCommunicationsPayloadHash,
  readCalendarCreateApprovalInput,
  readMailSendApprovalInput,
  type MailSendApprovalInput,
} from "./communications-approval-payload.js";

const MAIL_INPUT: MailSendApprovalInput = {
  draftId: "mail_draft_1",
  accountId: "acct-1",
  to: ["to@example.test"],
  cc: [],
  bcc: ["bcc@example.test"],
  subject: "Status",
  bodyText: "Ready.",
};

describe("communications approval payload", () => {
  it("derives the idempotency key from the approval id", () => {
    expect(COMMUNICATIONS_IDEMPOTENCY_PREFIX).toBe("communications:");
    expect(communicationsIdempotencyKey("approval-1")).toBe("communications:approval-1");
  });

  it("hashes a stable sha256 hex digest that ignores key order and tracks content", () => {
    const hash = computeCommunicationsPayloadHash(MAIL_INPUT);
    const reordered = Object.fromEntries(Object.entries(MAIL_INPUT).reverse()) as unknown as MailSendApprovalInput;

    expect(hash).toMatch(/^[0-9a-f]{64}$/u);
    expect(computeCommunicationsPayloadHash(reordered)).toBe(hash);
    expect(computeCommunicationsPayloadHash({ ...MAIL_INPUT, subject: "Changed" })).not.toBe(hash);
  });

  it("hashes absent calendar optionals the same as omitted keys", () => {
    const base = {
      eventId: "calendar_event_1",
      accountId: "acct-1",
      title: "Planning",
      startIso: "2026-06-06T10:00:00.000Z",
      endIso: "2026-06-06T10:30:00.000Z",
      attendees: [],
    };
    expect(computeCommunicationsPayloadHash({ ...base, location: undefined, calendarId: undefined })).toBe(
      computeCommunicationsPayloadHash(base),
    );
  });

  it("reads only the hashed mail send fields from a stored payload", () => {
    const payload = { action: "mail_send", ...MAIL_INPUT, payloadHash: "x", idempotencyKeyPrefix: "communications:" };

    expect(readMailSendApprovalInput(payload)).toEqual(MAIL_INPUT);
    expect(readMailSendApprovalInput({ ...payload, action: "calendar_event_create" })).toBeUndefined();
    expect(readMailSendApprovalInput({ ...payload, to: ["ok@example.test", 7] })).toBeUndefined();
    expect(readMailSendApprovalInput({ ...payload, subject: undefined })).toBeUndefined();
  });

  it("reads calendar create fields, omitting absent optionals and rejecting malformed ones", () => {
    const payload = {
      action: "calendar_event_create",
      eventId: "calendar_event_1",
      accountId: "acct-1",
      calendarId: "primary",
      title: "Planning",
      startIso: "2026-06-06T10:00:00.000Z",
      endIso: "2026-06-06T10:30:00.000Z",
      attendees: ["a@example.test"],
      payloadHash: "x",
    };

    expect(readCalendarCreateApprovalInput(payload)).toEqual({
      eventId: "calendar_event_1",
      accountId: "acct-1",
      calendarId: "primary",
      title: "Planning",
      startIso: "2026-06-06T10:00:00.000Z",
      endIso: "2026-06-06T10:30:00.000Z",
      attendees: ["a@example.test"],
    });
    expect(readCalendarCreateApprovalInput({ ...payload, location: 4 })).toBeUndefined();
    expect(readCalendarCreateApprovalInput({ ...payload, action: "mail_send" })).toBeUndefined();
    expect(readCalendarCreateApprovalInput({ ...payload, attendees: "a@example.test" })).toBeUndefined();
  });
});
