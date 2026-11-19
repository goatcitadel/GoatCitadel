import { describe, expect, it, vi } from "vitest";
import { executeGoogleCalendarAction } from "./google-calendar-runtime.js";
describe("native Calendar actions", () => {
  it("classifies free/busy POST as read-only and retains partial calendar errors", async () => {
    const http = vi.fn(async () => ({
      calendars: { primary: { busy: [] }, other: { errors: [{ reason: "notFound" }] } },
    }));
    const result = await executeGoogleCalendarAction(
      "calendar.free_busy",
      { calendarIds: ["primary", "other"], fromIso: "2026-11-18T00:00:00Z", toIso: "2026-11-19T00:00:00Z" },
      { identity: "account", http },
    );
    expect(http).toHaveBeenCalledWith(
      expect.stringContaining("/freeBusy"),
      expect.objectContaining({ method: "POST", readOnly: true }),
    );
    expect(result.partial).toBe(true);
    expect(result.records).toEqual([
      { calendarId: "primary", checked: true, busy: [], free: true },
      { calendarId: "other", checked: false, errors: [{ reason: "notFound" }] },
    ]);
  });
  it("creates an all-day event with explicit notifications and an exclusive end date", async () => {
    const http = vi.fn(async () => ({ id: "event-1" }));
    await executeGoogleCalendarAction(
      "calendar.create_event",
      { title: "Away", startDate: "2026-11-18", endDate: "2026-11-20", attendees: ["guest@example.com"] },
      { identity: "account", http },
    );
    expect(http).toHaveBeenCalledWith(
      expect.stringContaining("sendUpdates=all"),
      expect.objectContaining({
        body: expect.objectContaining({ start: { date: "2026-11-18" }, end: { date: "2026-11-20" } }),
      }),
    );
  });
  it("rejects stale review without sending a mutation", async () => {
    const http = vi.fn(async () => ({ id: "e", etag: '"v2"' }));
    await expect(
      executeGoogleCalendarAction(
        "calendar.update_event",
        { eventId: "e", eventEtag: '"v1"', title: "New" },
        { identity: "account", http },
      ),
    ).rejects.toThrow(/changed/);
    expect(http).toHaveBeenCalledTimes(1);
  });
  it("requires explicit series selection and sends If-Match on changes", async () => {
    const http = vi.fn(async (_url: string, options?: { method?: string }) =>
      options?.method === "PATCH" ? { id: "e" } : { id: "e", etag: '"v1"', recurrence: ["RRULE:FREQ=WEEKLY"] },
    );
    await expect(
      executeGoogleCalendarAction(
        "calendar.update_event",
        { eventId: "e", eventEtag: '"v1"', title: "New" },
        { identity: "account", http },
      ),
    ).rejects.toThrow(/series/);
    await executeGoogleCalendarAction(
      "calendar.update_event",
      { eventId: "e", eventEtag: '"v1"', title: "New", recurrenceScope: "series" },
      { identity: "account", http },
    );
    expect(http).toHaveBeenLastCalledWith(
      expect.any(String),
      expect.objectContaining({ headers: { "If-Match": '"v1"' } }),
    );
  });
});
