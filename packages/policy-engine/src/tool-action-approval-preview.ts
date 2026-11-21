import { redactSecretText, nativeGoogleAction } from "@goatcitadel/contracts";

const MAX_REVIEW_BYTES = 16_384;
const DEFAULT_WORKING_FOLDER = "GoatCitadel working folder";
const PACKAGE_SCRIPTS = new Map([
  ["tests.run", "test"],
  ["lint.run", "lint"],
  ["build.run", "build"],
]);

function trimmedText(value: unknown): string | undefined {
  return typeof value === "string" ? value.trim() || undefined : undefined;
}

function stringList(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((entry) => trimmedText(entry) ?? []);
}

function communicationsPreview(
  toolName: string,
  target: string,
  lines: string[],
  summary: string,
  maxBytes = MAX_REVIEW_BYTES,
) {
  const input = lines.join("\n");
  if (Buffer.byteLength(input, "utf8") > maxBytes) return undefined;
  const redacted = redactSecretText(input, { env: process.env });
  if (Buffer.byteLength(redacted.value, "utf8") > maxBytes) return undefined;
  return {
    reviewKind: "communications.operation",
    toolName,
    target,
    input: redacted.value,
    summary:
      redacted.redactionCount > 0
        ? `${summary} Sensitive text is hidden in this preview. Approval permits sending the original text.`
        : summary,
  };
}

function calendarCreateApprovalPreview(args: Record<string, unknown>) {
  const connectionId = trimmedText(args.connectionId);
  const title = trimmedText(args.title);
  const start = trimmedText(args.startIso) ?? trimmedText(args.startDate);
  const end = trimmedText(args.endIso) ?? trimmedText(args.endDate);
  if (
    !connectionId ||
    !title ||
    !start ||
    !end ||
    !Number.isFinite(Date.parse(start)) ||
    !Number.isFinite(Date.parse(end))
  ) {
    return undefined;
  }
  const attendees = stringList(args.attendees);
  const location = trimmedText(args.location);
  const description = trimmedText(args.description);
  return communicationsPreview(
    "calendar.create_event",
    "Google Calendar event",
    [
      `Google connection ${connectionId}`,
      `Calendar ${trimmedText(args.calendarId) ?? "primary"}`,
      `Event title ${title}`,
      `Starts ${start}`,
      `Ends ${end}`,
      `Time zone ${trimmedText(args.timeZone) ?? "UTC"}`,
      ...(args.startDate ? ["All-day event; the end date is exclusive."] : []),
      `Attendees ${attendees.join(", ") || "none"}`,
      ...calendarOptions(args),
      ...(location ? [`Location ${location}`] : []),
      ...(description ? [`Description ${description}`] : []),
    ],
    "Create this event in the selected Google Calendar.",
    196608,
  );
}

function calendarOptions(args: Record<string, unknown>): string[] {
  const reminders =
    args.reminders && typeof args.reminders === "object" ? (args.reminders as Record<string, unknown>) : undefined;
  return [
    `Attendee notifications ${trimmedText(args.sendUpdates) ?? "all"}${args.sendUpdates === "none" ? " (silent change)" : ""}`,
    ...(args.recurrenceScope ? [`Recurring selection ${args.recurrenceScope}`] : []),
    ...(Array.isArray(args.recurrence)
      ? [`Recurrence rules ${args.recurrence.join("; ") || "remove recurrence"}`]
      : []),
    ...(args.createMeet === true
      ? ["Create a Google Meet conference (the link may take time to become available)."]
      : []),
    ...(reminders
      ? [
          reminders.useDefault === true
            ? "Use default reminders."
            : `Custom reminders ${
                (Array.isArray(reminders.overrides) ? reminders.overrides : [])
                  .map((value) => {
                    const item = value as Record<string, unknown>;
                    return `${item.method}: ${item.minutes} minutes before`;
                  })
                  .join("; ") || "none"
              }`,
        ]
      : []),
  ];
}

function nativeGooglePreview(
  toolName: string,
  args: Record<string, unknown>,
): Record<string, unknown> | null | undefined {
  const action = nativeGoogleAction(toolName);
  if (!action && toolName !== "gmail.send") return undefined;
  const connection = trimmedText(args.connectionId);
  if (!connection) return null;
  if (
    toolName.startsWith("gmail.") &&
    [
      "gmail.send",
      "gmail.reply",
      "gmail.forward",
      "gmail.save_draft",
      "gmail.send_draft",
      "gmail.delete_draft",
    ].includes(toolName)
  ) {
    const lines = [
      `Google connection ${connection}`,
      ...(trimmedText(args._googleSourceSummary) ? [`Reviewed source ${args._googleSourceSummary}`] : []),
      `To ${stringList(args.to).join(", ") || "none"}`,
      `Cc ${stringList(args.cc).join(", ") || "none"}`,
      `Bcc ${stringList(args.bcc).join(", ") || "none"}`,
      `Subject ${typeof args.subject === "string" ? args.subject : "(empty)"}`,
      ...(Array.isArray(args.attachments) ? args.attachments : []).map((value) => {
        const item = value as Record<string, unknown>;
        return `Attachment ${item.filename} · ${item.path} · SHA-256 ${item.sha256}`;
      }),
      ...(trimmedText(args._googleAttachmentSummary)
        ? [`Saved draft attachments ${args._googleAttachmentSummary}`]
        : []),
      ...(trimmedText(args._googleDraftHeaders) ? [`Saved draft sender headers\n${args._googleDraftHeaders}`] : []),
      ...(trimmedText(args._googleMimeSha256) ? [`Reviewed MIME SHA-256 ${args._googleMimeSha256}`] : []),
      "",
      typeof args.bodyText === "string" ? args.bodyText : "",
    ];
    const summary =
      toolName === "gmail.save_draft"
        ? "Save this draft without sending it."
        : toolName === "gmail.delete_draft"
          ? "Delete this reviewed draft and its unsent content."
          : "Send this exact reviewed message once, including all listed recipients and attachments.";
    return (
      communicationsPreview(
        toolName,
        toolName.includes("draft") ? "Gmail draft" : "Gmail message",
        lines,
        summary,
        196608,
      ) ?? null
    );
  }
  const fields = Object.keys((action?.argSchema.properties ?? {}) as Record<string, unknown>).filter(
    (key) => key !== "connectionId" && key !== "pageToken" && args[key] !== undefined,
  );
  const lines: string[] = [`Google connection ${connection}`];
  for (const key of fields) {
    const value = args[key];
    if (typeof value === "string" || typeof value === "number" || typeof value === "boolean")
      lines.push(`${key.replace(/([A-Z])/gu, " $1").toLowerCase()}: ${value}`);
    else if (Array.isArray(value) && value.every((item) => typeof item === "string"))
      lines.push(`${key}: ${value.join(", ")}`);
  }
  if (toolName.startsWith("calendar.") && action?.readOnly === false) lines.push(...calendarOptions(args));
  const summary =
    toolName === "gmail.download_attachment"
      ? "Download only the selected attachment into the governed workspace artifact folder."
      : (action?.description ?? "Review this Google operation.");
  const preview = communicationsPreview(
    toolName,
    toolName.startsWith("calendar.") ? "Google Calendar" : "Gmail",
    lines,
    summary,
    196608,
  );
  return preview
    ? { ...preview, reviewKind: action?.readOnly ? "knowledge.operation" : "communications.operation" }
    : null;
}

function mailSendApprovalPreview(toolName: "gmail.send" | "smtp.send", args: Record<string, unknown>) {
  const gmail = toolName === "gmail.send";
  const connectionId = trimmedText(args.connectionId);
  const subject = trimmedText(args.subject);
  const bodyText = typeof args.bodyText === "string" ? args.bodyText : "";
  const recipients = stringList(args.to);
  if (!connectionId || !subject || !bodyText.trim() || recipients.length === 0) return undefined;
  const cc = gmail ? [] : stringList(args.cc);
  const bcc = gmail ? [] : stringList(args.bcc);
  return communicationsPreview(
    toolName,
    gmail ? "Gmail message" : "SMTP message",
    [
      `Sending connection ${connectionId}`,
      `To ${recipients.join(", ")}`,
      ...(cc.length ? [`Cc ${cc.join(", ")}`] : []),
      ...(bcc.length ? [`Bcc ${bcc.join(", ")}`] : []),
      `Subject ${subject}`,
      "",
      gmail ? bodyText.trim() : bodyText,
    ],
    "Send this email once from the selected account.",
  );
}

function workspacePreview(toolName: string, command: string, target: string, summary: string) {
  if (Buffer.byteLength(target, "utf8") + Buffer.byteLength(command, "utf8") > MAX_REVIEW_BYTES) return undefined;
  return {
    reviewKind: "workspace.operation",
    toolName,
    target: redactSecretText(target, { env: process.env }).value,
    command: redactSecretText(command, { env: process.env }).value,
    summary,
  };
}

/** A null result withholds review for a supported action. Undefined leaves an unrelated tool to its own preview. */
export function toolActionApprovalPreview(
  toolName: string,
  args: Record<string, unknown>,
): Record<string, unknown> | null | undefined {
  const native = nativeGooglePreview(toolName, args);
  if (native !== undefined) return native;
  if (toolName === "calendar.create_event") return calendarCreateApprovalPreview(args) ?? null;
  if (toolName === "calendar.respond_event") {
    const connectionId = trimmedText(args.connectionId);
    const eventId = trimmedText(args.eventId);
    const etag = trimmedText(args.eventEtag);
    const response = trimmedText(args.responseStatus);
    if (!connectionId || !eventId || !etag || !response || !["accepted", "declined", "tentative"].includes(response))
      return null;
    return (
      communicationsPreview(
        toolName,
        "Google Calendar RSVP",
        [
          `Google connection ${connectionId}`,
          `Calendar ${trimmedText(args.calendarId) ?? "primary"}`,
          ...(trimmedText(args.title) ? [`Event title ${trimmedText(args.title)}`] : []),
          `Event ${eventId}`,
          `Reviewed version ${etag}`,
          `Your response ${response}`,
        ],
        "Submit your RSVP for this invitation and notify the organizer. Other attendees are unchanged.",
      ) ?? null
    );
  }
  if (toolName === "gmail.send" || toolName === "smtp.send") return mailSendApprovalPreview(toolName, args) ?? null;
  if (toolName === "git.status") {
    return workspacePreview(
      toolName,
      "git status --porcelain=v1 --branch",
      DEFAULT_WORKING_FOLDER,
      "Read repository status.",
    );
  }
  if (toolName === "git.diff") {
    const staged = args.staged === true || (typeof args.staged === "string" && args.staged.toLowerCase() === "true");
    return workspacePreview(
      toolName,
      staged ? "git diff --cached" : "git diff",
      DEFAULT_WORKING_FOLDER,
      staged ? "Read staged changes in the repository." : "Read unstaged changes in the repository.",
    );
  }

  const script = PACKAGE_SCRIPTS.get(toolName);
  if (!script) return undefined;
  const manager = trimmedText(args.manager) ?? "pnpm";
  const filter = trimmedText(args.filter);
  if (
    args.command !== undefined ||
    (manager !== "pnpm" && manager !== "npm") ||
    (filter && !/^[a-zA-Z0-9@/_\-.]+$/.test(filter))
  ) {
    return null;
  }
  const command = manager === "pnpm" && filter ? `pnpm --filter ${filter} run ${script}` : `${manager} run ${script}`;
  return (
    workspacePreview(
      toolName,
      command,
      trimmedText(args.cwd) ?? DEFAULT_WORKING_FOLDER,
      `Run the selected project's ${script} package script once.`,
    ) ?? null
  );
}
