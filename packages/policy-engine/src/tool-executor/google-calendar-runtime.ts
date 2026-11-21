import {
  CALENDAR_API,
  contentHash,
  cursorScope,
  id,
  integer,
  nextCursor,
  object,
  readCursor,
  required,
  strings,
  text,
  timestamp,
  untrusted,
  type GoogleRuntimePort,
} from "./google-workspace-common.js";

export async function executeGoogleCalendarAction(
  name: string,
  args: Record<string, unknown>,
  port: GoogleRuntimePort,
): Promise<Record<string, unknown>> {
  const calendarId = text(args.calendarId) ?? "primary";
  const events = `${CALENDAR_API}/calendars/${id(calendarId, "calendarId")}/events`;
  if (name === "calendar.list" || name === "calendar.list_calendars") {
    const scope = cursorScope(name, args, port.identity);
    const url = new URL(name === "calendar.list" ? events : `${CALENDAR_API}/users/me/calendarList`);
    url.searchParams.set(
      "maxResults",
      String(Math.min(100, Math.max(1, typeof args.maxResults === "number" ? Math.floor(args.maxResults) : 10))),
    );
    if (name === "calendar.list") {
      if (args.fromIso !== undefined) url.searchParams.set("timeMin", timestamp(args.fromIso, "fromIso"));
      if (args.toIso !== undefined) url.searchParams.set("timeMax", timestamp(args.toIso, "toIso"));
      if (args.fromIso && args.toIso && Date.parse(String(args.fromIso)) >= Date.parse(String(args.toIso)))
        throw new Error("blocked: Calendar end must be after its start.");
      url.searchParams.set("singleEvents", "true");
      url.searchParams.set("orderBy", "startTime");
    }
    const token = readCursor(args.pageToken, scope);
    if (token) url.searchParams.set("pageToken", token);
    const page = await port.http(url.toString(), { readOnly: true });
    return untrusted(
      { records: Array.isArray(page.items) ? page.items.slice(0, 100) : [], ...nextCursor(page.nextPageToken, scope) },
      name,
    );
  }
  if (name === "calendar.get_event") {
    const event = await port.http(`${events}/${id(args.eventId, "eventId")}`, { readOnly: true });
    return untrusted({ event }, `calendar:event:${calendarId}:${args.eventId}`);
  }
  if (name === "calendar.free_busy") {
    const calendars = strings(args.calendarIds, 20);
    if (!calendars.length) throw new Error("blocked: Choose at least one calendar.");
    const from = timestamp(args.fromIso, "fromIso");
    const to = timestamp(args.toIso, "toIso");
    const duration = Date.parse(to) - Date.parse(from);
    if (duration <= 0 || duration > 31 * 86400000)
      throw new Error("blocked: Availability queries must span at most 31 days.");
    const result = await port.http(`${CALENDAR_API}/freeBusy`, {
      method: "POST",
      readOnly: true,
      body: {
        timeMin: from,
        timeMax: to,
        ...(text(args.timeZone) ? { timeZone: zone(args.timeZone) } : {}),
        calendarExpansionMax: 20,
        groupExpansionMax: 20,
        items: calendars.map((calendar) => ({ id: calendar })),
      },
    });
    const observed = object(result.calendars);
    const records = calendars.map((calendar) => {
      const item = object(observed[calendar]);
      const errors = Array.isArray(item.errors) ? item.errors : [];
      const checked = Object.hasOwn(observed, calendar) && errors.length === 0 && Array.isArray(item.busy);
      return {
        calendarId: calendar,
        checked,
        ...(checked
          ? { busy: item.busy, free: (item.busy as unknown[]).length === 0 }
          : { errors: errors.length ? errors : [{ reason: "unavailable" }] }),
      };
    });
    return untrusted(
      { records, partial: records.some((item) => !item.checked), fromIso: from, toIso: to },
      "calendar:freeBusy",
    );
  }
  if (name === "calendar.create_event") {
    const payload = eventPayload(args, true, port.operationIdentity ?? port.identity);
    const url = mutationUrl(events, args, args.createMeet === true);
    const result = await port.http(url, { method: "POST", body: payload });
    return { providerMessageId: required(result.id, "event confirmation id"), event: result };
  }
  const eventId = required(args.eventId, "eventId");
  const etag = required(args.eventEtag, "eventEtag", 512);
  const current = await port.http(`${events}/${id(eventId, "eventId")}`, { readOnly: true });
  if (current.etag !== etag || current.status === "cancelled")
    throw new Error("blocked: This invitation changed. Read the calendar again and review a fresh approval.");
  if (name === "calendar.respond_event") {
    const responseStatus = required(args.responseStatus, "responseStatus");
    if (!["accepted", "declined", "tentative"].includes(responseStatus))
      throw new Error("blocked: RSVP must be accepted, declined or tentative.");
    const attendees = (Array.isArray(current.attendees) ? current.attendees : []).map(object);
    let own: Record<string, unknown>[];
    if (calendarId === "primary") own = attendees.filter((attendee) => attendee.self === true);
    else {
      if (!port.assertCapability)
        throw new Error("blocked: Calendar discovery is required to verify your RSVP identity.");
      await port.assertCapability("calendar.list_calendars");
      const primary = await port.http(`${CALENDAR_API}/users/me/calendarList/primary`, { readOnly: true });
      const email = required(primary.id, "primary calendar identity").toLowerCase();
      if (!email.includes("@") || primary.primary !== true)
        throw new Error("blocked: The signed-in account identity could not be verified.");
      own = attendees.filter((attendee) => text(attendee.email)?.toLowerCase() === email);
    }
    if (own.length !== 1 || !text(own[0]!.email))
      throw new Error("blocked: This invitation does not identify you as an attendee. No RSVP was submitted.");
    const updated = await port.http(mutationUrl(`${events}/${id(eventId, "eventId")}`, { sendUpdates: "all" }), {
      method: "PATCH",
      headers: { "If-Match": etag },
      body: { attendeesOmitted: true, attendees: [{ email: own[0]!.email, responseStatus }] },
    });
    if (
      updated.id !== eventId ||
      !(
        Array.isArray(updated.attendees) &&
        updated.attendees
          .map(object)
          .some((attendee) => attendee.email === own[0]!.email && attendee.responseStatus === responseStatus)
      )
    )
      throw new Error("calendar.respond_event returned no confirmed RSVP; check the calendar before trying again");
    return { providerMessageId: eventId, responseStatus };
  }
  assertRecurrenceScope(current, args);
  if (name === "calendar.delete_event") {
    await port.http(mutationUrl(`${events}/${id(eventId, "eventId")}`, args), {
      method: "DELETE",
      headers: { "If-Match": etag },
    });
    return { providerMessageId: eventId, deleted: true };
  }
  if (name === "calendar.update_event") {
    const payload = eventPayload(args, false, port.operationIdentity ?? port.identity);
    if (!Object.keys(payload).length) throw new Error("blocked: Choose at least one event field to change.");
    if (payload.start || payload.end) {
      const start = object(payload.start ?? current.start);
      const end = object(payload.end ?? current.end);
      if (
        Boolean(start.date) !== Boolean(end.date) ||
        Date.parse(String(end.date ?? end.dateTime)) <= Date.parse(String(start.date ?? start.dateTime))
      )
        throw new Error("blocked: Updated event end must be after its start, using matching date types.");
    }
    const result = await port.http(mutationUrl(`${events}/${id(eventId, "eventId")}`, args, args.createMeet === true), {
      method: "PATCH",
      headers: { "If-Match": etag },
      body: payload,
    });
    if (result.id !== eventId) throw new Error("Calendar update returned no matching event confirmation.");
    return { providerMessageId: eventId, event: result };
  }
  throw new Error(`Unsupported native Calendar action: ${name}`);
}
function mutationUrl(base: string, args: Record<string, unknown>, conference = false): string {
  const url = new URL(base);
  const notify = text(args.sendUpdates) ?? "all";
  if (!["all", "externalOnly", "none"].includes(notify))
    throw new Error("blocked: Invalid Calendar notification choice.");
  url.searchParams.set("sendUpdates", notify);
  if (conference) url.searchParams.set("conferenceDataVersion", "1");
  return url.toString();
}
function date(value: unknown, name: string): string {
  const result = required(value, name, 10);
  if (
    !/^\d{4}-\d{2}-\d{2}$/u.test(result) ||
    !Number.isFinite(Date.parse(result)) ||
    new Date(result).toISOString().slice(0, 10) !== result
  )
    throw new Error(`blocked: ${name} must be a valid date in YYYY-MM-DD form.`);
  return result;
}
function zone(value: unknown): string {
  const result = required(value, "timeZone", 100);
  try {
    new Intl.DateTimeFormat("en", { timeZone: result }).format();
  } catch {
    throw new Error("blocked: Use a valid IANA time zone.");
  }
  return result;
}
function eventPayload(args: Record<string, unknown>, creating: boolean, identity: string): Record<string, unknown> {
  const payload: Record<string, unknown> = {};
  if (creating || args.title !== undefined) payload.summary = required(args.title, "title", 1024);
  for (const key of ["description", "location"] as const)
    if (args[key] !== undefined) {
      if (typeof args[key] !== "string" || args[key].length > 32768) throw new Error(`blocked: Invalid ${key}.`);
      payload[key] = args[key];
    }
  const allDay = args.startDate !== undefined || args.endDate !== undefined;
  if (allDay && (args.startIso !== undefined || args.endIso !== undefined))
    throw new Error("blocked: Choose all-day dates or timed timestamps, not both.");
  if (allDay) {
    const start = date(args.startDate, "startDate");
    const end = date(args.endDate, "endDate");
    if (end <= start) throw new Error("blocked: All-day endDate is exclusive and must be after startDate.");
    payload.start = { date: start };
    payload.end = { date: end };
  } else if (creating || args.startIso !== undefined || args.endIso !== undefined) {
    const start = timestamp(args.startIso, "startIso");
    const end = timestamp(args.endIso, "endIso");
    if (Date.parse(end) <= Date.parse(start)) throw new Error("blocked: Event end must be after start.");
    const timeZone = args.timeZone === undefined ? "UTC" : zone(args.timeZone);
    payload.start = { dateTime: start, timeZone };
    payload.end = { dateTime: end, timeZone };
  } else if (args.timeZone !== undefined)
    throw new Error("blocked: Supply both timestamps when changing the event time zone.");
  if (args.attendees !== undefined)
    payload.attendees = strings(args.attendees).map((email) => {
      if (!email.includes("@")) throw new Error("blocked: Invalid attendee email.");
      return { email };
    });
  if (args.recurrence !== undefined) {
    const recurrence = strings(args.recurrence, 10);
    if (recurrence.some((rule) => !/^(RRULE|RDATE|EXDATE):[^\r\n]+$/u.test(rule) || rule.length > 1024))
      throw new Error("blocked: Invalid recurrence rule.");
    payload.recurrence = recurrence;
  }
  if (args.reminders !== undefined) {
    const reminders = object(args.reminders);
    if (
      typeof reminders.useDefault !== "boolean" ||
      (reminders.overrides !== undefined && !Array.isArray(reminders.overrides))
    )
      throw new Error("blocked: Invalid reminder settings.");
    const overrides = (Array.isArray(reminders.overrides) ? reminders.overrides : []).map((value) => {
      const item = object(value);
      if (item.method !== "email" && item.method !== "popup") throw new Error("blocked: Invalid reminder method.");
      return { method: item.method, minutes: integer(item.minutes, 0, 0, 40320) };
    });
    if (overrides.length > 5 || (reminders.useDefault && overrides.length))
      throw new Error("blocked: Choose default reminders or at most five custom reminders.");
    payload.reminders = { useDefault: reminders.useDefault, ...(overrides.length ? { overrides } : {}) };
  }
  if (args.createMeet === true)
    payload.conferenceData = {
      createRequest: { requestId: contentHash({ identity, args }), conferenceSolutionKey: { type: "hangoutsMeet" } },
    };
  return payload;
}
function assertRecurrenceScope(event: Record<string, unknown>, args: Record<string, unknown>): void {
  if (Array.isArray(event.recurrence) && event.recurrence.length && args.recurrenceScope !== "series")
    throw new Error("blocked: This event is a recurring series. Explicitly review a series change.");
  if (event.recurringEventId && args.recurrenceScope !== "occurrence")
    throw new Error(
      "blocked: Explicitly choose this occurrence; read the series record separately to change the series.",
    );
  if (event.recurringEventId && args.recurrence !== undefined)
    throw new Error("blocked: Recurrence rules can only change on the series record.");
}
