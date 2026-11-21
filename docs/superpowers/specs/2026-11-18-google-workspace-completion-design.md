# Native Gmail and Calendar completion

## Intent and approved scope

The operator asked to close the native Gmail/Calendar gaps identified in this Chat so ordinary assistant requests do not unexpectedly hit missing actions. Extend the existing Google sign-in, Gateway tools, approvals and durable external-effect handling. Preserve existing unrelated changes and the installed RSVP/recovery repairs. Do not commit or push without a separate request.

## Approach

Extend the native integration. An external CLI or MCP replacement would introduce a second account/permission and execution path, undermine the existing approval/receipt flow, and conflict with the user's preference for native behavior. A description-only fix would expose limits but would not implement the requested tasks.

Keep transport and side-effect tracking owned by the existing comms executor. Put the expanded Google payload, MIME and validation logic in focused modules with an injected, allowlisted HTTP port, rather than growing the channel-provider monolith. Keep one source of truth for tool capability/scope mappings and native action schemas.

## Gmail behavior

- Preserve `gmail.read` as bounded metadata search; add an opaque next-page token instead of silently omitting additional matches.
- Add explicit message and thread reads returning bounded decoded text, headers, labels and attachment descriptors. Treat all received mail as untrusted external content. Never render received HTML as executable content.
- Add attachment download into Gateway-governed artifacts. Bind message/attachment identifiers to the selected account; enforce byte limits, safe filenames and the artifact/path jail. Never fetch an attachment URL supplied by the model or expose attachment bytes as ordinary model text.
- Extend outgoing composition with CC/BCC, governed artifact attachments and correct MIME/header encoding. Reject header injection. Show every recipient, body and attachment in approval review.
- Add replies tied to a fetched original message/thread and forwards preserving the source message. Show the source message and outgoing content in review. A reply uses the original's reply address, message IDs and thread ID; do not merely prepend `Re:` to a new message. Forward quoted decoded content and explicitly selected attachments by default, without forwarding raw transport headers implicitly.
- Add draft creation/update/read/list/delete and sending a saved draft. A send approves the exact draft content/version; changed drafts require fresh review. Freeze outgoing MIME before approval, bind its hash and the draft's message ID, and re-read to reject stale review. Send the frozen MIME in `drafts.send` together with the draft ID so a concurrent edit after the check cannot change the approved message. Saving a draft is a visible governed write.
- Add label discovery and management, archive/unarchive, mark read/unread and Trash/restore. Use message IDs and explicit label/action selectors. No permanent purge tool.

## Calendar behavior

- Add calendar discovery, event detail reads, explicit continuation tokens and dedicated free/busy queries. Bound each page and each query window; expose incomplete results and per-calendar errors.
- Extend creation with timed or all-day dates, bounded recurrence rules, reminders and optional Google Meet creation. Preserve time-zone semantics and validate end after start. Request attendee notifications explicitly by default when attendees are present; silent creation must be explicit and visible in approval.
- Add event update/reschedule and cancellation/deletion with exact calendar ID, event ID and reviewed etag. Send `If-Match`; reject stale review without changing the event. Show event identity, proposed field changes and notification behavior in approval.
- Distinguish one recurring occurrence from an entire series. Default to one occurrence; a series change requires an explicit series selection and review of the series record.
- Extend RSVP to secondary calendars only when the authenticated user's attendee identity can be verified through the native account/calendar owner APIs. Never infer the authenticated person from a secondary calendar's `self` attendee flag. Refuse an unverifiable identity.

## Consent, policy and operator truth

- Keep existing Gmail read/send and Calendar read/write switches and scopes compatible. Add separately selectable capabilities/scopes for Gmail management/drafts, calendar discovery and free/busy as required by Google's APIs. Broader granted scopes never automatically enable another capability switch.
- Model multi-capability actions centrally: replies/forwards need source-read plus send consent, draft sends need draft access plus the send switch, and secondary-calendar RSVP needs write plus authenticated calendar discovery. Check all applicable requirements cumulatively.
- Existing sign-ins keep working for existing actions. New actions explain the exact missing capability and how to reconnect. Never automatically reconnect, grant scopes, alter keychain contents or turn capabilities on.
- Bind all reads/writes to the current workspace and selected Google connection. Check enabled capability and current scope at execution. Reads keep the existing Google sign-in/approval/grant binding; a metadata-only allowance must not silently authorize full bodies or attachments.
- Every remote mutation remains approval-gated and ledgered. Read allowances cannot cover sends or changes. Unknown-after-send outcomes are never automatically retried. Draft and event version guards prevent changes after review from being sent silently.
- Bind outgoing content to the source connection/sign-in, exact recipients, MIME hash, attachment hashes and source/draft identity before approval. Free/busy is explicitly a read operation despite its POST method; transport classification must not falsely record it as a mutation. Attachment downloads create local artifacts and must not inherit a metadata-read allowance's ability to write.
- Update native tool descriptions, capability setup text, labels, guide material and approval previews together. Describe implemented actions specifically instead of treating a connected account as a complete Google client.

## Validation and rollout

- Add failing fake-provider tests before implementation for each action family, then verify exact wire requests, bounds, MIME/threading, pagination, denied scopes, cross-workspace refusal, stale versions, header injection, path escape, notifications and ambiguous sends.
- Run focused contracts/policy/Gateway/UI tests, lock-wrapped typechecks, the named provider/approval/durable verification lanes appropriate to the final diff, docs checks and `git diff --check`.
- Visually inspect and interact with setup and all new approval/read result states in the rendered app at desktop/mobile widths. Use a disposable fake Google provider and isolated runtime for send/change acceptance; do not alter the operator's real mailbox/calendar for testing.
- Prepare a reviewable backed-up installed patch/build only after source checks. Coordinate the installed runtime with other repo chats. Existing restart approval in this Chat covers loading this task's patch; re-check exact managed process ownership before restarting.
- The operator must complete any new Google consent themselves. Report which actions were tested with a fake provider, which were checked live without mutation, and any remaining limitations.

## Defaults and decisions left to implementation

Use existing TypeScript/Fastify/contracts/policy/storage boundaries and existing MIME/artifact libraries. Do not add dependencies without demonstrated need. Initial limits: 25 search results per page, 50 messages per thread, 128 KiB decoded message text, 1 MiB aggregate thread text, 10 MiB per attachment, 20 MiB per outgoing message, 20 calendars and 31 days per availability query. Expose truncation/continuation explicitly and bind continuation to account and original query/window. These are implementation defaults chosen for bounded runtime behavior, not user-stated limits.

Use Trash instead of permanent email deletion. Do not implement unrelated Google Drive/Docs/Sheets/Contacts or audit every other connector in this task. An independent builder review checked the design against the current owners and Google's draft-send/free-busy contracts; the cumulative scopes, frozen-draft send, read classification and attachment defaults above address its findings.
