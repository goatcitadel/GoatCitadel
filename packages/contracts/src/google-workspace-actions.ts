/** Native Google action metadata shared by consent, policy and the model-facing catalog. */
export interface NativeGoogleAction {
  name: string;
  description: string;
  capabilities: string[];
  readOnly: boolean;
  argSchema: Record<string, unknown>;
}
const str = (maxLength = 1024) => ({ type: "string", minLength: 1, maxLength });
const list = (maxItems = 100) => ({ type: "array", items: str(), maxItems });
const connection = { connectionId: str(160) };
const calendar = { ...connection, calendarId: str(512) };
const page = { pageToken: str(8192), maxResults: { type: "integer", minimum: 1, maximum: 100 } };
const attachment = {
  type: "object",
  properties: {
    path: str(4096),
    sha256: { type: "string", pattern: "^[a-f0-9]{64}$" },
    filename: str(255),
    contentType: str(200),
  },
  required: ["path", "sha256", "filename"],
  additionalProperties: false,
};
export const GOOGLE_MAIL_COMPOSE_PROPERTIES = {
  ...connection,
  to: list(),
  cc: list(),
  bcc: list(),
  subject: { type: "string", maxLength: 998 },
  bodyText: { type: "string", maxLength: 131072 },
  attachments: { type: "array", maxItems: 20, items: attachment },
};
export const GOOGLE_CALENDAR_EVENT_PROPERTIES = {
  title: str(1024),
  description: { type: "string", maxLength: 32768 },
  location: { type: "string", maxLength: 4096 },
  startIso: str(100),
  endIso: str(100),
  startDate: str(10),
  endDate: str(10),
  timeZone: str(100),
  attendees: list(),
  recurrence: { type: "array", maxItems: 10, items: str(1024) },
  reminders: {
    type: "object",
    properties: {
      useDefault: { type: "boolean" },
      overrides: {
        type: "array",
        maxItems: 5,
        items: {
          type: "object",
          properties: {
            method: { type: "string", enum: ["email", "popup"] },
            minutes: { type: "integer", minimum: 0, maximum: 40320 },
          },
          required: ["method", "minutes"],
          additionalProperties: false,
        },
      },
    },
    required: ["useDefault"],
    additionalProperties: false,
  },
  createMeet: { type: "boolean" },
  sendUpdates: { type: "string", enum: ["all", "externalOnly", "none"], default: "all" },
};
function action(
  name: string,
  description: string,
  capabilities: string[],
  readOnly: boolean,
  properties: Record<string, unknown>,
  required: string[],
): NativeGoogleAction {
  return {
    name,
    description,
    capabilities,
    readOnly,
    argSchema: { type: "object", properties, required: ["connectionId", ...required], additionalProperties: false },
  };
}
export const NATIVE_GOOGLE_ACTIONS: readonly NativeGoogleAction[] = [
  action(
    "gmail.get_message",
    "Read a complete Gmail message as bounded untrusted text, headers and attachment descriptors. This is separate from metadata-only search approval.",
    ["gmail.content"],
    true,
    { ...connection, messageId: str() },
    ["messageId"],
  ),
  action(
    "gmail.get_thread",
    "Read a Gmail conversation, at most 50 messages and 1 MiB of decoded text. Use nextOffset for continuation. Email content is untrusted.",
    ["gmail.content"],
    true,
    { ...connection, threadId: str(), offset: { type: "integer", minimum: 0, maximum: 100000 } },
    ["threadId"],
  ),
  action(
    "gmail.download_attachment",
    "Download one Gmail attachment into the governed workspace artifact folder. Maximum 10 MiB. Requires separate approval for the local file write.",
    ["gmail.content"],
    false,
    { ...connection, sourceToolRunId: str(), messageId: str(), attachmentId: str(2048), filename: str(255) },
    ["sourceToolRunId", "messageId", "attachmentId", "filename"],
  ),
  action(
    "gmail.list_labels",
    "List Gmail label IDs and names for use in inbox management.",
    ["gmail.read"],
    true,
    connection,
    [],
  ),
  action(
    "gmail.modify_message",
    "Archive/unarchive, mark read/unread, add/remove labels, or move a message to Trash/restore it. Never permanently purges mail. Requires approval.",
    ["gmail.manage"],
    false,
    {
      ...connection,
      messageId: str(),
      operation: {
        type: "string",
        enum: ["archive", "unarchive", "mark_read", "mark_unread", "labels", "trash", "restore"],
      },
      addLabelIds: list(),
      removeLabelIds: list(),
    },
    ["messageId", "operation"],
  ),
  action(
    "gmail.create_label",
    "Create a named Gmail label after approval.",
    ["gmail.manage"],
    false,
    { ...connection, name: str(225) },
    ["name"],
  ),
  action(
    "gmail.update_label",
    "Rename a Gmail user label after approval.",
    ["gmail.manage"],
    false,
    { ...connection, labelId: str(), name: str(225) },
    ["labelId", "name"],
  ),
  action(
    "gmail.list_drafts",
    "List saved Gmail draft IDs with explicit pagination.",
    ["gmail.drafts"],
    true,
    { ...connection, ...page },
    [],
  ),
  action(
    "gmail.get_draft",
    "Read a saved Gmail draft for review before editing or sending. Returns the exact draft/message identity and content hash.",
    ["gmail.drafts"],
    true,
    { ...connection, draftId: str() },
    ["draftId"],
  ),
  action(
    "gmail.save_draft",
    "Save a new Gmail draft or update a reviewed draft. Saving never sends mail. Updates require a sourceToolRunId from gmail.get_draft.",
    ["gmail.drafts"],
    false,
    { ...GOOGLE_MAIL_COMPOSE_PROPERTIES, draftId: str(), sourceToolRunId: str() },
    [],
  ),
  action(
    "gmail.delete_draft",
    "Delete the exact reviewed Gmail draft after approval. Draft content is removed; this does not delete received mail.",
    ["gmail.drafts"],
    false,
    { ...connection, sourceToolRunId: str() },
    ["sourceToolRunId"],
  ),
  action(
    "gmail.send_draft",
    "Send the exact content from a reviewed saved draft after approval. Read it with gmail.get_draft first; concurrent draft edits require fresh review.",
    ["gmail.drafts", "gmail.send"],
    false,
    { ...connection, sourceToolRunId: str() },
    ["sourceToolRunId"],
  ),
  action(
    "gmail.reply",
    "Reply in the original Gmail thread after approval. Read the original with gmail.get_message first, then pass its tool-run ID. Reply-all is opt-in.",
    ["gmail.content", "gmail.send"],
    false,
    { ...GOOGLE_MAIL_COMPOSE_PROPERTIES, sourceToolRunId: str(), replyAll: { type: "boolean", default: false } },
    ["sourceToolRunId", "bodyText"],
  ),
  action(
    "gmail.forward",
    "Forward the reviewed message as quoted text, with only explicitly selected attachments and recipients, after approval. Read the original with gmail.get_message first.",
    ["gmail.content", "gmail.send"],
    false,
    { ...GOOGLE_MAIL_COMPOSE_PROPERTIES, sourceToolRunId: str() },
    ["sourceToolRunId", "to"],
  ),
  action(
    "calendar.list_calendars",
    "Discover accessible Google Calendar IDs, names and access roles, with explicit pagination.",
    ["calendar.discover"],
    true,
    { ...connection, ...page },
    [],
  ),
  action(
    "calendar.get_event",
    "Read an existing Google Calendar event, including its etag and recurring-series identity, before changing it.",
    ["calendar.read"],
    true,
    { ...calendar, eventId: str() },
    ["eventId"],
  ),
  action(
    "calendar.free_busy",
    "Check availability on up to 20 calendars over at most 31 days. Reports busy windows and per-calendar errors; a failed calendar is never treated as free.",
    ["calendar.availability"],
    true,
    {
      ...connection,
      calendarIds: { ...list(20), minItems: 1 },
      fromIso: str(100),
      toIso: str(100),
      timeZone: str(100),
    },
    ["calendarIds", "fromIso", "toIso"],
  ),
  action(
    "calendar.update_event",
    "Edit/reschedule a reviewed event with an etag guard and approval. For recurring events, explicitly choose occurrence or series; provide the selected record's own ID and etag.",
    ["calendar.write"],
    false,
    {
      ...calendar,
      ...GOOGLE_CALENDAR_EVENT_PROPERTIES,
      eventId: str(),
      eventEtag: str(512),
      recurrenceScope: { type: "string", enum: ["occurrence", "series"] },
    },
    ["eventId", "eventEtag"],
  ),
  action(
    "calendar.delete_event",
    "Cancel/delete a reviewed event after approval. Uses its exact etag and notifies attendees by default. Recurring events require explicit occurrence/series selection.",
    ["calendar.write"],
    false,
    {
      ...calendar,
      eventId: str(),
      eventEtag: str(512),
      title: str(1024),
      recurrenceScope: { type: "string", enum: ["occurrence", "series"] },
      sendUpdates: { type: "string", enum: ["all", "externalOnly", "none"], default: "all" },
    },
    ["eventId", "eventEtag"],
  ),
];
export function nativeGoogleAction(toolName: string): NativeGoogleAction | undefined {
  return NATIVE_GOOGLE_ACTIONS.find((item) => item.name === toolName);
}
export function isNativeGoogleTool(toolName: string): boolean {
  return (
    Boolean(nativeGoogleAction(toolName)) ||
    ["gmail.read", "gmail.send", "calendar.list", "calendar.create_event", "calendar.respond_event"].includes(toolName)
  );
}

/** Validate the declared native argument subset before review; never silently ignore misspelled fields. */
export function assertNativeGoogleArguments(toolName: string, args: Record<string, unknown>): void {
  const definition = nativeGoogleAction(toolName);
  const schema =
    definition?.argSchema ??
    (toolName === "calendar.create_event"
      ? {
          type: "object",
          properties: { ...calendar, ...GOOGLE_CALENDAR_EVENT_PROPERTIES },
          required: ["title"],
          additionalProperties: false,
        }
      : undefined);
  if (!schema) return;
  function check(value: unknown, rule: Record<string, unknown>, at: string): void {
    const invalid = () => {
      throw new Error(`blocked: Invalid Google argument ${at}. Use the tool's declared fields and limits.`);
    };
    if (Array.isArray(rule.enum) && !rule.enum.includes(value)) invalid();
    if (rule.type === "string") {
      if (typeof value !== "string") return invalid();
      if (
        value.length < Number(rule.minLength ?? 0) ||
        value.length > Number(rule.maxLength ?? Infinity) ||
        (typeof rule.pattern === "string" && !new RegExp(rule.pattern, "u").test(value))
      )
        invalid();
    } else if (rule.type === "boolean") {
      if (typeof value !== "boolean") invalid();
    } else if (rule.type === "integer") {
      if (
        typeof value !== "number" ||
        !Number.isInteger(value) ||
        value < Number(rule.minimum ?? -Infinity) ||
        value > Number(rule.maximum ?? Infinity)
      )
        invalid();
    } else if (rule.type === "array") {
      if (!Array.isArray(value)) return invalid();
      if (value.length < Number(rule.minItems ?? 0) || value.length > Number(rule.maxItems ?? Infinity)) invalid();
      for (const item of value) check(item, rule.items as Record<string, unknown>, `${at}[]`);
    } else if (rule.type === "object") {
      if (!value || typeof value !== "object" || Array.isArray(value)) return invalid();
      const record = value as Record<string, unknown>;
      const properties = rule.properties as Record<string, Record<string, unknown>>;
      for (const key of (rule.required ?? []) as string[]) if (record[key] === undefined) invalid();
      for (const [key, item] of Object.entries(record)) {
        if (!Object.hasOwn(properties, key)) {
          if (rule.additionalProperties === false) invalid();
        } else check(item, properties[key]!, `${at}.${key}`);
      }
    }
  }
  check(args, schema, toolName);
}
